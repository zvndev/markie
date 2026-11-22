//! The rich editor bound to a live room: no rendering here.
//!
//! The room is TipTap's `XmlFragment("default")` (see markie-rich `room`).
//! [`RichBinding`] keeps the editor and the room in step the way TipTap's
//! Collaboration extension keeps ProseMirror and the room in step:
//!
//! * After a local edit, [`RichBinding::push`] writes the editor's nodes into
//!   the room as the smallest change (`ydiff`, y-prosemirror's
//!   `updateYFragment`), in one transaction with [`LOCAL_ORIGIN`].
//! * After room updates are applied, [`RichBinding::pull`] folds the room
//!   back onto the editor's document. Blocks the room did not change keep
//!   their Markdown bytes (`Document::with_room_nodes`), and the caret stays
//!   on the same character through a relative position.
//! * Positions go both ways between the editor and Yjs relative positions
//!   with y-prosemirror's own algorithm (`positions`), so cursors and comment
//!   anchors written by TipTap land on the same character here.
//! * Undo is a yrs `UndoManager` over the fragment that tracks only this
//!   client's edits, with TipTap's 500 ms grouping: undo never takes back a
//!   peer's work.
pub mod editor_pos;
pub mod legacy;
pub mod positions;
pub mod relpos;
pub mod ydiff;
pub mod ytree;

use std::collections::HashSet;

use markie_rich::editor::{Editor, Pos};
use markie_rich::model::Node;
use markie_rich::room::{RoomError, RoomNode, from_room, to_room};
use serde_json::{Value, json};
use yrs::branch::BranchID;
use yrs::undo::{Options as UndoOptions, UndoManager};
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, Map, Origin, Out, ReadTxn, StateVector, StickyIndex, Transact, Update, XmlFragmentRef};

use editor_pos::{pm_of, pos_of, spans};
use positions::{absolute_of, content_size, sticky_for, target_for};
use ytree::{YNode, read_children};

/// The origin of every transaction this binding writes. The undo manager
/// tracks it; the live session sends it.
pub const LOCAL_ORIGIN: &str = "markie-local";
pub const META_MAP: &str = "meta";
pub const SCHEMA_KEY: &str = "schemaVersion";
pub const MODEL_KEY: &str = "editorModel";
pub const EDITOR_MODEL: i64 = 2;
/// The newest room schema this build reads and writes.
pub const COLLAB_SCHEMA_VERSION: i64 = 2;
pub const RICH_SCHEMA_PLAIN: i64 = 1;
pub const RICH_SCHEMA_MATH: i64 = 2;

/// `roomSchemaOf`: the recorded schema, or 0 for none or one this build does not know.
pub fn room_schema_of(v: Option<&Value>) -> i64 {
    match v.and_then(Value::as_f64) {
        Some(f) if f.fract() == 0.0 && f > 0.0 && f <= COLLAB_SCHEMA_VERSION as f64 => f as i64,
        _ => 0,
    }
}

fn has_math(nodes: &[RoomNode]) -> bool {
    nodes.iter().any(|n| match n {
        RoomNode::Element { name, children, .. } => name == "mathInline" || name == "mathBlock" || has_math(children),
        RoomNode::Text(_) => false,
    })
}

fn random_client_id() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    // yjs client ids are random 32-bit numbers.
    h.finish() & 0xffff_ffff
}

/// The caret as two relative positions, to carry it across a room change.
pub type StickyCaret = (StickyIndex, StickyIndex);

pub struct RichBinding {
    doc: Doc,
    frag: XmlFragmentRef,
    tree: Vec<YNode>,
    undo: UndoManager<()>,
}

impl RichBinding {
    /// Bind to a room document (made with `markie_rich::ydoc::new_doc`, so
    /// text offsets are UTF-16 like every other client's).
    pub fn new(doc: Doc) -> RichBinding {
        let frag = doc.get_or_insert_xml_fragment("default");
        doc.get_or_insert_map(META_MAP);
        let mut tracked = HashSet::new();
        tracked.insert(Origin::from(LOCAL_ORIGIN));
        let mut undo = UndoManager::with_options(UndoOptions { tracked_origins: tracked, capture_timeout_millis: 500, ..UndoOptions::default() });
        undo.expand_scope(&doc, &frag);
        let mut b = RichBinding { doc, frag, tree: Vec::new(), undo };
        b.refresh();
        b
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    /// Read the room again (after updates were applied to the document).
    pub fn refresh(&mut self) {
        let txn = self.doc.transact();
        self.tree = read_children(&txn, &self.frag);
    }

    pub fn tree(&self) -> &[YNode] {
        &self.tree
    }

    pub fn is_empty(&self) -> bool {
        self.tree.is_empty()
    }

    /// The room as y-prosemirror holds it.
    pub fn room(&self) -> Vec<RoomNode> {
        self.tree.iter().map(YNode::to_room).collect()
    }

    /// The room as editor nodes, or why this build cannot draw it.
    pub fn nodes(&self) -> Result<Vec<Node>, RoomError> {
        from_room(&self.room())
    }

    /// A value in the room's meta map.
    pub fn meta(&self, key: &str) -> Option<Value> {
        let meta = self.doc.get_or_insert_map(META_MAP);
        let txn = self.doc.transact();
        match meta.get(&txn, key)? {
            Out::Any(a) => Some(markie_rich::ydoc::any_to_json(&a)),
            _ => None,
        }
    }

    /// The room was seeded or brought up to date by a build of this model.
    pub fn has_model(&self) -> bool {
        self.meta(MODEL_KEY).is_some()
    }

    /// Write the editor's document into the room. True when the room changed.
    pub fn push(&mut self, ed: &Editor) -> bool {
        let want = to_room(&ed.doc.nodes());
        if self.tree.len() == want.len() && self.tree.iter().zip(&want).all(|(a, b)| a.same_as(b)) {
            return false;
        }
        {
            let mut txn = self.doc.transact_mut_with(LOCAL_ORIGIN);
            ydiff::update_children(&mut txn, &self.frag, &self.tree, &want);
        }
        self.refresh();
        true
    }

    /// The caret (anchor, head) as relative positions, before a room change.
    pub fn caret(&self, ed: &Editor) -> Option<StickyCaret> {
        let sp = spans(ed);
        let a = self.sticky(pm_of(ed, &sp, ed.anchor))?.0;
        let h = self.sticky(pm_of(ed, &sp, ed.head))?.0;
        Some((a, h))
    }

    /// Fold the room into the editor after updates were applied (and
    /// [`RichBinding::refresh`] read them). The caret follows `caret`.
    /// Ok(false) when the editor already shows the room.
    pub fn pull(&mut self, ed: &mut Editor, caret: Option<StickyCaret>) -> Result<bool, RoomError> {
        self.refresh();
        let nodes = self.nodes()?;
        if nodes == ed.doc.nodes() {
            return Ok(false);
        }
        let doc = ed.doc.with_room_nodes(&nodes);
        let version = ed.version;
        *ed = Editor::new(doc);
        ed.version = version + 1;
        ed.sel_version += 1;
        if let Some((a, h)) = caret {
            let sp = spans(ed);
            let ap = self.resolve(&a).map(|pm| pos_of(ed, &sp, pm));
            let hp = self.resolve(&h).map(|pm| pos_of(ed, &sp, pm));
            if let (Some(ap), Some(hp)) = (ap, hp) {
                ed.set_selection(ed.clamp(ap), ed.clamp(hp));
            }
        }
        Ok(true)
    }

    /// Undo this client's last change (never a peer's). The editor follows.
    pub fn undo(&mut self, ed: &mut Editor) -> bool {
        let caret = self.caret(ed);
        let did = self.undo.undo_blocking();
        if did {
            let _ = self.pull(ed, caret);
        }
        did
    }

    pub fn redo(&mut self, ed: &mut Editor) -> bool {
        let caret = self.caret(ed);
        let did = self.undo.redo_blocking();
        if did {
            let _ = self.pull(ed, caret);
        }
        did
    }

    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.undo.can_redo()
    }

    /// End the current undo group (a caret move between edits does this in TipTap).
    pub fn break_undo(&mut self) {
        self.undo.reset();
    }

    // ---- positions ----

    /// The relative position y-prosemirror makes for ProseMirror position `pm`.
    pub fn sticky(&self, pm: u32) -> Option<(StickyIndex, Option<BranchID>)> {
        let pm = pm.min(content_size(&self.tree));
        let target = target_for(&self.tree, pm);
        let txn = self.doc.transact();
        sticky_for(&txn, &self.frag, &self.tree, &target)
    }

    /// Where a relative position is now, as a ProseMirror position.
    pub fn resolve(&self, si: &StickyIndex) -> Option<u32> {
        let txn = self.doc.transact();
        absolute_of(&txn, &self.tree, si)
    }

    pub fn pm_of(&self, ed: &Editor, p: Pos) -> u32 {
        pm_of(ed, &spans(ed), p)
    }

    pub fn pos_of(&self, ed: &Editor, pm: u32) -> Pos {
        pos_of(ed, &spans(ed), pm)
    }

    /// A comment anchor for an editor range: `{from, to}` as
    /// `Y.relativePositionToJSON` writes them (comment-anchors.ts).
    pub fn anchor_for(&self, ed: &Editor, from: Pos, to: Pos) -> Option<Value> {
        let sp = spans(ed);
        let (a, ap) = self.sticky(pm_of(ed, &sp, from))?;
        let (b, bp) = self.sticky(pm_of(ed, &sp, to))?;
        Some(json!({ "from": relpos::to_json(&a, ap.as_ref()), "to": relpos::to_json(&b, bp.as_ref()) }))
    }

    /// A comment anchor's ProseMirror range now, or None when its text was deleted.
    pub fn resolve_anchor_pm(&self, anchor: &Value) -> Option<(u32, u32)> {
        let from = relpos::from_json(anchor.get("from")?)?;
        let to = relpos::from_json(anchor.get("to")?)?;
        Some((self.resolve(&from)?, self.resolve(&to)?))
    }

    /// A comment anchor as an editor range.
    pub fn resolve_anchor(&self, ed: &Editor, anchor: &Value) -> Option<(Pos, Pos)> {
        let (f, t) = self.resolve_anchor_pm(anchor)?;
        let sp = spans(ed);
        Some((pos_of(ed, &sp, f), pos_of(ed, &sp, t)))
    }

    /// Our cursor for awareness, as y-prosemirror's cursor plugin publishes it.
    pub fn cursor_for(&self, ed: &Editor) -> Option<(Value, Value)> {
        let sp = spans(ed);
        let (a, ap) = self.sticky(pm_of(ed, &sp, ed.anchor))?;
        let (h, hp) = self.sticky(pm_of(ed, &sp, ed.head))?;
        Some((relpos::to_json_full(&a, ap.as_ref()), relpos::to_json_full(&h, hp.as_ref())))
    }

    /// A peer's cursor as an editor range, clamped like `createDecorations`.
    pub fn resolve_cursor(&self, ed: &Editor, anchor: &Value, head: &Value) -> Option<(Pos, Pos)> {
        let a = self.resolve(&relpos::from_json(anchor)?)?;
        let h = self.resolve(&relpos::from_json(head)?)?;
        let max = content_size(&self.tree).saturating_sub(1);
        let sp = spans(ed);
        Some((pos_of(ed, &sp, a.min(max)), pos_of(ed, &sp, h.min(max))))
    }

    // ---- seeding and claiming ----

    /// The schema a claim records: never lower than the room's, 2 when the
    /// content holds a formula or the copy has front matter.
    pub fn claim_schema(&self, want: &[RoomNode], front_matter: bool) -> i64 {
        let need = if has_math(want) || front_matter { RICH_SCHEMA_MATH } else { RICH_SCHEMA_PLAIN };
        room_schema_of(self.meta(SCHEMA_KEY).as_ref()).max(need)
    }

    /// `migrationUpdate`: the update that turns the room into `want` and
    /// stamps the meta map, built on a copy so the room itself is untouched.
    /// The server takes exactly one claim per room; this client's room
    /// changes when the server sends the winning update back.
    pub fn claim_update(&self, want: &[RoomNode], meta: &[(&str, Any)]) -> Vec<u8> {
        let copy = markie_rich::ydoc::new_doc(random_client_id());
        let state = self.doc.transact().encode_state_as_update_v1(&StateVector::default());
        if let Ok(u) = Update::decode_v1(&state) {
            let _ = copy.transact_mut().apply_update(u);
        }
        let frag = copy.get_or_insert_xml_fragment("default");
        let map = copy.get_or_insert_map(META_MAP);
        {
            let mut txn = copy.transact_mut();
            let have = read_children(&txn, &frag);
            ydiff::update_children(&mut txn, &frag, &have, want);
            for (k, v) in meta {
                map.insert(&mut txn, *k, v.clone());
            }
        }
        let sv = self.doc.transact().state_vector();
        copy.transact().encode_state_as_update_v1(&sv)
    }

    /// The claim for an empty room: the editor's content and this model's stamps.
    pub fn seed_update(&self, ed: &Editor, front_matter: bool) -> Vec<u8> {
        let want = to_room(&ed.doc.nodes());
        let schema = self.claim_schema(&want, front_matter);
        self.claim_update(&want, &[(MODEL_KEY, Any::from(EDITOR_MODEL)), (SCHEMA_KEY, Any::from(schema))])
    }
}

#[cfg(test)]
mod tests;
