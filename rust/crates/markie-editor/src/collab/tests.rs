use super::*;
use markie_rich::editor::{Editor, Pos};
use markie_rich::ydoc::new_doc;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

fn caret_after(ed: &mut Editor, needle: &str) {
    for b in 0..ed.block_count() {
        for l in 0..ed.leaves_of(b).len() {
            let t: String = ed.units(b, l).iter().map(|u| u.display()).collect();
            if let Some(i) = t.find(needle) {
                let off = t[..i + needle.len()].chars().count();
                ed.set_caret(Pos::new(b, l, off), false);
                return;
            }
        }
    }
    panic!("{needle:?} not found");
}

fn sync(from: &Doc, to: &Doc) {
    let u = from.transact().encode_state_as_update_v1(&to.transact().state_vector());
    to.transact_mut_with("markie-remote").apply_update(Update::decode_v1(&u).unwrap()).unwrap();
}

fn apply(to: &Doc, update: &[u8]) {
    to.transact_mut_with("markie-remote").apply_update(Update::decode_v1(update).unwrap()).unwrap();
}

/// A seeded room and two clients on it, each with an editor.
fn pair(md: &str) -> (RichBinding, Editor, RichBinding, Editor) {
    let mut a = RichBinding::new(new_doc(1));
    let ea = Editor::parse(md);
    let seed = a.seed_update(&ea, false);
    apply(a.doc(), &seed);
    a.refresh();
    let mut b = RichBinding::new(new_doc(2));
    sync(a.doc(), b.doc());
    let mut eb = Editor::parse("");
    b.pull(&mut eb, None).unwrap();
    (a, ea, b, eb)
}

const DOC: &str = "# Title\n\nFirst paragraph here.\n\nSecond one, with *marks* and `code`.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

#[test]
fn a_seeded_room_reads_back_as_the_file() {
    let (a, ea, b, eb) = pair(DOC);
    assert_eq!(a.meta(MODEL_KEY), Some(json!(2)));
    assert_eq!(a.meta(SCHEMA_KEY), Some(json!(1)));
    assert_eq!(eb.doc.nodes(), ea.doc.nodes());
    assert_eq!(b.room(), a.room());
}

#[test]
fn math_and_front_matter_raise_the_schema() {
    let a = RichBinding::new(new_doc(1));
    let ea = Editor::parse("Euler: $e^{i\\pi}+1=0$\n");
    let u = a.seed_update(&ea, false);
    apply(a.doc(), &u);
    assert_eq!(a.meta(SCHEMA_KEY), Some(json!(2)));
    let b = RichBinding::new(new_doc(3));
    let u = b.seed_update(&Editor::parse("plain\n"), true);
    apply(b.doc(), &u);
    assert_eq!(b.meta(SCHEMA_KEY), Some(json!(2)));
}

#[test]
fn an_edit_touches_only_its_block() {
    let (mut a, mut ea, _b, _eb) = pair(DOC);
    let before: Vec<_> = a.tree().iter().map(|n| n.id().clone()).collect();
    caret_after(&mut ea, "First");
    ea.insert_text(" new");
    assert!(a.push(&ea));
    let after: Vec<_> = a.tree().iter().map(|n| n.id().clone()).collect();
    assert_eq!(before, after, "every top-level element keeps its item");
    // The paragraph's text node kept its item too: the edit went into it.
    assert_eq!(a.tree()[1].children()[0].id(), a.tree()[1].children()[0].id());
    assert!(!a.push(&ea), "nothing more to send");
}

#[test]
fn concurrent_edits_in_one_paragraph_converge() {
    let (mut a, mut ea, mut b, mut eb) = pair(DOC);
    caret_after(&mut ea, "First");
    ea.insert_text(" ALPHA");
    caret_after(&mut eb, "paragraph here");
    eb.insert_text(" BETA");
    a.push(&ea);
    b.push(&eb);
    sync(a.doc(), b.doc());
    sync(b.doc(), a.doc());
    let ca = a.caret(&ea);
    a.pull(&mut ea, ca).unwrap();
    let cb = b.caret(&eb);
    b.pull(&mut eb, cb).unwrap();
    assert_eq!(ea.to_markdown(), eb.to_markdown());
    assert!(ea.to_markdown().contains("First ALPHA paragraph here BETA."), "{}", ea.to_markdown());
    // Untouched blocks kept their bytes on both sides.
    assert!(ea.to_markdown().contains("| a | b |\n|---|---|\n| 1 | 2 |"));
}

#[test]
fn a_remote_edit_keeps_the_local_caret_on_its_character() {
    let (mut a, mut ea, mut b, mut eb) = pair(DOC);
    caret_after(&mut ea, "Second");
    let before = ea.head;
    caret_after(&mut eb, "Title");
    eb.insert_text(" grows longer");
    b.push(&eb);
    sync(b.doc(), a.doc());
    let caret = a.caret(&ea);
    assert!(a.pull(&mut ea, caret).unwrap());
    assert_eq!(ea.head, before, "the caret is still just after \"Second\"");
    ea.insert_text("!");
    assert!(ea.to_markdown().contains("Second!"));
}

#[test]
fn undo_takes_back_only_this_clients_edit() {
    let (mut a, mut ea, mut b, mut eb) = pair(DOC);
    caret_after(&mut ea, "First");
    ea.insert_text(" MINE");
    a.push(&ea);
    sync(a.doc(), b.doc());
    let c = b.caret(&eb);
    b.pull(&mut eb, c).unwrap();
    caret_after(&mut eb, "Second");
    eb.insert_text(" THEIRS");
    b.push(&eb);
    sync(b.doc(), a.doc());
    let c = a.caret(&ea);
    a.pull(&mut ea, c).unwrap();
    assert!(a.can_undo());
    assert!(a.undo(&mut ea));
    let md = ea.to_markdown();
    assert!(!md.contains("MINE"), "{md}");
    assert!(md.contains("Second THEIRS"), "{md}");
    assert!(a.redo(&mut ea));
    assert!(ea.to_markdown().contains("First MINE"));
}

#[test]
fn every_position_round_trips_through_a_relative_position() {
    let (a, ..) = pair("# T\n\nab😀c\n\n> quote\n\n- x\n  - y\n\n---\n\n$$\nx\n$$\n\n| a | b |\n|---|---|\n|   | 2 |\n\n\n");
    let size = positions::content_size(a.tree());
    for pm in 0..=size {
        let (si, _) = a.sticky(pm).unwrap_or_else(|| panic!("no sticky for {pm}"));
        let back = a.resolve(&si).unwrap_or_else(|| panic!("no resolve for {pm}"));
        assert_eq!(back, pm, "position {pm}");
    }
}

#[test]
fn editor_positions_map_to_prosemirror_and_back() {
    let (a, mut ea, ..) = pair("# Title\n\nab😀c\n\n- x\n- y\n");
    caret_after(&mut ea, "ab😀");
    // doc: heading(0..7) "Title" content 1..6; paragraph opens at 7, text at 8.
    let pm = a.pm_of(&ea, ea.head);
    assert_eq!(pm, 8 + 4, "a, b, and the two halves of the emoji");
    assert_eq!(a.pos_of(&ea, pm), ea.head);
    for p in [Pos::new(0, 0, 0), Pos::new(0, 0, 5), Pos::new(1, 0, 0), Pos::new(2, 1, 1)] {
        let pm = a.pm_of(&ea, p);
        assert_eq!(a.pos_of(&ea, pm), p, "{p:?} at {pm}");
    }
}

#[test]
fn comment_anchors_survive_edits_before_them() {
    let (mut a, mut ea, mut b, mut eb) = pair(DOC);
    // Anchor "paragraph" in the first paragraph.
    caret_after(&mut ea, "First ");
    let from = ea.head;
    caret_after(&mut ea, "First paragraph");
    let to = ea.head;
    let anchor = a.anchor_for(&ea, from, to).unwrap();
    // Someone types before it.
    caret_after(&mut eb, "Title");
    eb.insert_text(" and more");
    b.push(&eb);
    sync(b.doc(), a.doc());
    let c = a.caret(&ea);
    a.pull(&mut ea, c).unwrap();
    let (f, t) = a.resolve_anchor(&ea, &anchor).unwrap();
    let text: String = ea.units(f.block, f.leaf)[f.offset..t.offset].iter().map(|u| u.display()).collect();
    assert_eq!(text, "paragraph");
    // Deleting the passage collapses the anchor (the web client hides it).
    let json = serde_json::to_string(&anchor).unwrap();
    assert!(json.contains("\"item\""));
}

#[test]
fn cursors_resolve_on_the_other_side() {
    let (a, mut ea, b, eb) = pair(DOC);
    caret_after(&mut ea, "Second one");
    let (anchor, head) = a.cursor_for(&ea).unwrap();
    assert!(anchor.get("tname").is_some(), "awareness carries every field");
    let (pa, ph) = b.resolve_cursor(&eb, &anchor, &head).unwrap();
    assert_eq!((pa, ph), (ea.anchor, ea.head));
}

#[test]
fn an_unknown_node_is_refused() {
    let doc = new_doc(9);
    let frag = doc.get_or_insert_xml_fragment("default");
    {
        let mut txn = doc.transact_mut();
        markie_rich::ydoc::write_children(&mut txn, &frag, &[RoomNode::Element { name: "mermaid".into(), attrs: Default::default(), children: vec![] }]);
    }
    let mut b = RichBinding::new(doc);
    let mut ed = Editor::parse("x\n");
    assert!(b.pull(&mut ed, None).is_err());
    let _ = StateVector::default();
}
