//! The rich editor's model: a caret and selection over the document's
//! leaves, every edit as an undoable step, and Markdown that keeps the bytes
//! of every block the edits did not change. No UI: the GPUI view
//! (`view.rs`, feature `gui`) draws this and feeds it keys; the tests drive
//! it directly.
//!
//! Byte preservation works at two levels. A block nobody touched is written
//! from its source. And after every edit the touched blocks are cut back
//! into one block per top-level node, and any node that is equal to a block
//! as it was opened gets that block back, bytes and all. So pressing Enter
//! at the end of a paragraph adds an empty paragraph and leaves the first
//! one's bytes alone, and typing a letter and deleting it again restores
//! the original block exactly.
//!
//! Collaboration (phase 3) binds to the same model: `doc.nodes()` is what a
//! room holds, and each step names the blocks it replaced, which is what a
//! minimal Yjs update needs.

pub mod tree;
mod ops;
mod format;
mod clip;
mod rules;
mod keys;
mod table;
mod drag;

use std::ops::Range;

use crate::document::{Block, BlockContent, Document};
use crate::edit::Unit;
use crate::model::*;
pub use tree::{Frame, Leaf, LeafKind, ListKind};
pub use format::{BlockStyle, MarkKind, Toolbar};
pub use clip::{FindMatch, OutlineEntry};
pub use ops::word_at;

/// A place in the document: a block, one of its leaves, and a unit offset
/// in that leaf (a character, or one math formula or line break). An atom
/// leaf has length 1: offset 0 is before it and 1 after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Pos {
    pub block: usize,
    pub leaf: usize,
    pub offset: usize,
}

impl Pos {
    pub fn new(block: usize, leaf: usize, offset: usize) -> Pos {
        Pos { block, leaf, offset }
    }
}

/// What kind of change a step was, for merging keystrokes into one undo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditKind {
    Typing,
    Deleting,
    Other,
}

#[derive(Debug, Clone)]
struct Step {
    start: usize,
    before: Vec<Block>,
    after_len: usize,
    sel_before: (Pos, Pos),
    sel_after: (Pos, Pos),
    kind: EditKind,
}

pub struct Editor {
    pub doc: Document,
    /// The document as it was opened, by block origin: what a node that is
    /// equal again gets its bytes back from.
    base: Vec<Block>,
    leaves: Vec<Vec<Leaf>>,
    pub anchor: Pos,
    pub head: Pos,
    /// Marks the next typed text gets (a toggle with nothing selected).
    pub typing: Option<Marks>,
    undo: Vec<Step>,
    redo: Vec<Step>,
    /// False once the caret moved, so the next keystroke starts a new step.
    coalesce: bool,
    /// Bumped on every change to the document.
    pub version: u64,
    /// Bumped on every change to the selection or document.
    pub sel_version: u64,
    /// The x the caret keeps while moving up and down (set by the view).
    pub goal_x: Option<f32>,
    /// Where an edit put the caret, by (block, path, offset) in the
    /// document as the edit left it. Leaf indices go stale as soon as an
    /// edit changes structure; paths do not.
    pending: Option<[(usize, Vec<usize>, usize); 2]>,
    /// Set when an edit re-derived leaves part way through.
    leaves_dirty: bool,
    /// The selection version right after an input rule ran, so Backspace
    /// straight after it can take the rule back (`rules.rs`).
    rule_undo: Option<u64>,
}

const MAX_UNDO: usize = 500;

impl Editor {
    pub fn new(mut doc: Document) -> Editor {
        if doc.blocks.is_empty() {
            // An empty file still needs a line to type on. Its source is
            // empty, so a zero-edit save writes the file as it was.
            doc.blocks.push(Block {
                source: String::new(),
                trailing: String::new(),
                content: BlockContent::Nodes(vec![Node::para(vec![])]),
                edited: false,
                origin: Some(0),
            });
            doc.end_origin = Some(0);
            doc.ending = String::new();
        }
        let base = doc.blocks.clone();
        let leaves = doc.blocks.iter().map(block_leaves).collect();
        let mut ed = Editor {
            doc,
            base,
            leaves,
            anchor: Pos::default(),
            head: Pos::default(),
            typing: None,
            undo: Vec::new(),
            redo: Vec::new(),
            coalesce: false,
            version: 0,
            sel_version: 0,
            goal_x: None,
            pending: None,
            leaves_dirty: false,
            rule_undo: None,
        };
        let first = ed.first_text_pos().unwrap_or_default();
        ed.anchor = first;
        ed.head = first;
        ed
    }

    pub fn parse(markdown: &str) -> Editor {
        Editor::new(Document::parse(markdown))
    }

    pub fn to_markdown(&self) -> String {
        self.doc.to_markdown()
    }

    /// (blocks rewritten, blocks kept byte for byte).
    pub fn edit_counts(&self) -> (usize, usize) {
        let edited = self.doc.blocks.iter().filter(|b| b.edited).count();
        (edited, self.doc.blocks.len() - edited)
    }

    // ---- leaves and units ----

    pub fn block_count(&self) -> usize {
        self.doc.blocks.len()
    }

    pub fn leaves_of(&self, block: usize) -> &[Leaf] {
        self.leaves.get(block).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn leaf(&self, p: Pos) -> Option<&Leaf> {
        self.leaves.get(p.block)?.get(p.leaf)
    }

    pub fn kind(&self, p: Pos) -> Option<LeafKind> {
        self.leaf(p).map(|l| l.kind)
    }

    pub fn units(&self, block: usize, leaf: usize) -> Vec<Unit> {
        let Some(b) = self.doc.blocks.get(block) else { return vec![] };
        let Some(l) = self.leaves.get(block).and_then(|v| v.get(leaf)) else { return vec![] };
        match (&b.content, l.kind) {
            (BlockContent::Opaque(_), _) => b.source.chars().map(|c| Unit::Char(c, Marks::default())).collect(),
            (BlockContent::Nodes(n), _) => tree::leaf_units(n, l),
        }
    }

    pub fn leaf_len(&self, block: usize, leaf: usize) -> usize {
        match self.kind(Pos::new(block, leaf, 0)) {
            Some(LeafKind::Atom) => 1,
            Some(_) => self.units(block, leaf).len(),
            None => 0,
        }
    }

    pub fn node_at(&self, block: usize, path: &[usize]) -> Option<&Node> {
        match &self.doc.blocks.get(block)?.content {
            BlockContent::Nodes(n) => tree::node_at(n, path),
            BlockContent::Opaque(_) => None,
        }
    }

    pub fn leaf_node(&self, p: Pos) -> Option<&Node> {
        let l = self.leaf(p)?;
        self.node_at(p.block, &l.path)
    }

    /// Write units into a leaf. Marks the block edited (a source block keeps
    /// its new bytes as its source instead).
    fn set_units(&mut self, block: usize, leaf: usize, units: &[Unit]) {
        let Some(l) = self.leaves.get(block).and_then(|v| v.get(leaf)).cloned() else { return };
        let b = &mut self.doc.blocks[block];
        if b.is_opaque() {
            b.source = tree::units_text(units);
            return;
        }
        if let Some(nodes) = self.doc.nodes_mut(block) {
            tree::set_leaf_units(nodes, &l, units);
        }
    }

    fn nodes_mut(&mut self, block: usize) -> Option<&mut Vec<Node>> {
        self.doc.nodes_mut(block)
    }

    /// Recompute the leaves of every block (after a structural change).
    fn refresh_leaves(&mut self) {
        self.leaves = self.doc.blocks.iter().map(block_leaves).collect();
        self.leaves_dirty = true;
    }

    /// The position of the leaf at `path` in `block`, after a refresh.
    pub fn pos_of_path(&self, block: usize, path: &[usize], offset: usize) -> Option<Pos> {
        let leaf = self.leaves.get(block)?.iter().position(|l| l.path == path)?;
        Some(Pos::new(block, leaf, offset.min(self.leaf_len(block, leaf))))
    }

    /// The first leaf at or after `path` in reading order (a leaf whose path
    /// starts with it, or comes after it).
    pub fn pos_at_or_after(&self, block: usize, path: &[usize]) -> Option<Pos> {
        let block = block.min(self.block_count().saturating_sub(1));
        let leaf = self.leaves.get(block)?.iter().position(|l| l.path.as_slice() >= path)?;
        Some(Pos::new(block, leaf, 0))
    }

    pub fn first_text_pos(&self) -> Option<Pos> {
        for b in 0..self.block_count() {
            for (i, l) in self.leaves_of(b).iter().enumerate() {
                if l.kind.has_text() {
                    return Some(Pos::new(b, i, 0));
                }
            }
        }
        if self.block_count() > 0 && !self.leaves_of(0).is_empty() { Some(Pos::new(0, 0, 0)) } else { None }
    }

    pub fn end_pos(&self) -> Pos {
        let b = self.block_count().saturating_sub(1);
        let l = self.leaves_of(b).len().saturating_sub(1);
        Pos::new(b, l, self.leaf_len(b, l))
    }

    /// The leaf after (b, l) in reading order, across blocks.
    pub fn next_leaf(&self, p: Pos) -> Option<Pos> {
        if p.leaf + 1 < self.leaves_of(p.block).len() {
            return Some(Pos::new(p.block, p.leaf + 1, 0));
        }
        let mut b = p.block + 1;
        while b < self.block_count() {
            if !self.leaves_of(b).is_empty() {
                return Some(Pos::new(b, 0, 0));
            }
            b += 1;
        }
        None
    }

    pub fn prev_leaf(&self, p: Pos) -> Option<Pos> {
        if p.leaf > 0 {
            let l = p.leaf - 1;
            return Some(Pos::new(p.block, l, self.leaf_len(p.block, l)));
        }
        let mut b = p.block;
        while b > 0 {
            b -= 1;
            let n = self.leaves_of(b).len();
            if n > 0 {
                return Some(Pos::new(b, n - 1, self.leaf_len(b, n - 1)));
            }
        }
        None
    }

    // ---- selection ----

    /// The selection, start first.
    pub fn range(&self) -> (Pos, Pos) {
        if self.anchor <= self.head { (self.anchor, self.head) } else { (self.head, self.anchor) }
    }

    pub fn has_selection(&self) -> bool {
        self.anchor != self.head
    }

    /// Is the selection exactly one atom (a picture, rule or embed)?
    pub fn selected_atom(&self) -> Option<Pos> {
        let (a, b) = self.range();
        (a.block == b.block && a.leaf == b.leaf && a.offset == 0 && b.offset == 1 && self.kind(a) == Some(LeafKind::Atom))
            .then_some(a)
    }

    pub fn set_selection(&mut self, anchor: Pos, head: Pos) {
        self.anchor = self.clamp(anchor);
        self.head = self.clamp(head);
        self.typing = None;
        self.coalesce = false;
        self.sel_version += 1;
    }

    /// Put the caret at `p`; with `extend`, move only the head.
    pub fn set_caret(&mut self, p: Pos, extend: bool) {
        let p = self.clamp(p);
        if extend {
            self.set_selection(self.anchor, p);
        } else if self.kind(p) == Some(LeafKind::Atom) {
            self.set_selection(Pos { offset: 0, ..p }, Pos { offset: 1, ..p });
        } else {
            self.set_selection(p, p);
        }
        self.goal_x = None;
    }

    pub fn clamp(&self, p: Pos) -> Pos {
        if self.block_count() == 0 {
            return Pos::default();
        }
        let block = p.block.min(self.block_count() - 1);
        let n = self.leaves_of(block).len();
        if n == 0 {
            return Pos::new(block, 0, 0);
        }
        let leaf = p.leaf.min(n - 1);
        Pos::new(block, leaf, p.offset.min(self.leaf_len(block, leaf)))
    }

    pub fn select_all(&mut self) {
        let start = Pos::new(0, 0, 0);
        let end = self.end_pos();
        self.set_selection(start, end);
    }

    // ---- transactions ----

    /// Run an edit on the blocks in `range` (it may insert or remove blocks
    /// inside that range only), then cut the touched blocks back into one
    /// block per node, restore the bytes of nodes that are unchanged, and
    /// record one undo step.
    pub(crate) fn transact(&mut self, range: Range<usize>, kind: EditKind, f: impl FnOnce(&mut Editor)) {
        // One block of margin on each side: joins and list merges reach the
        // neighbours, and the undo step must hold whatever an edit touched.
        let range = range.start.saturating_sub(1).min(self.block_count())..(range.end + 1).min(self.block_count());
        self.leaves_dirty = false;
        self.pending = None;
        let before: Vec<Block> = self.doc.blocks[range.clone()].to_vec();
        let sel_before = (self.anchor, self.head);
        let len0 = self.block_count();
        let typing = self.typing.clone();
        f(self);
        let after_len = (range.len() as isize + self.block_count() as isize - len0 as isize).max(0) as usize;
        // The caret by path, so it survives the re-cut.
        let caret = self.pending.take().unwrap_or_else(|| self.caret_paths());
        let (new_len, map) = self.normalize(range.start, after_len, &before);
        if std::mem::take(&mut self.leaves_dirty) {
            self.refresh_leaves();
        } else {
            let fresh: Vec<Vec<Leaf>> =
                self.doc.blocks[range.start..range.start + new_len].iter().map(block_leaves).collect();
            let old_end = (range.start + range.len()).min(self.leaves.len());
            self.leaves.splice(range.start..old_end, fresh);
        }
        self.restore_caret(caret, range.start, after_len, new_len, &map);
        let after_len = new_len;
        if self.block_count() == 0 {
            self.doc.blocks.push(new_block(vec![Node::para(vec![])]));
            self.refresh_leaves();
            self.anchor = Pos::default();
            self.head = Pos::default();
        }
        let after_blocks = &self.doc.blocks[range.start..range.start + after_len];
        if after_blocks.len() == before.len()
            && after_blocks.iter().zip(&before).all(|(a, b)| a.source == b.source && a.content == b.content && a.edited == b.edited)
        {
            // Nothing changed (a no-op command). Keep the stored marks.
            self.typing = typing;
            return;
        }
        self.version += 1;
        self.sel_version += 1;
        self.redo.clear();
        let step = Step { start: range.start, before, after_len, sel_before, sel_after: (self.anchor, self.head), kind };
        if self.coalesce && kind != EditKind::Other {
            if let Some(last) = self.undo.last_mut() {
                if last.kind == kind && last.start == step.start && last.after_len == step.before.len() {
                    last.after_len = step.after_len;
                    last.sel_after = step.sel_after;
                    return;
                }
            }
        }
        self.undo.push(step);
        if self.undo.len() > MAX_UNDO {
            self.undo.remove(0);
        }
        self.coalesce = kind != EditKind::Other;
    }

    /// End the current run of typing, so the next keystroke is its own undo.
    pub fn break_undo(&mut self) {
        self.coalesce = false;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn undo(&mut self) -> bool {
        let Some(step) = self.undo.pop() else { return false };
        let inverse = self.apply_step(&step, step.sel_before);
        self.redo.push(Step { sel_before: step.sel_before, sel_after: step.sel_after, ..inverse });
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(step) = self.redo.pop() else { return false };
        let inverse = self.apply_step(&step, step.sel_after);
        self.undo.push(Step { sel_before: step.sel_before, sel_after: step.sel_after, ..inverse });
        true
    }

    /// Put `step.before` back in place of what it produced; returns the step
    /// that would reverse that.
    fn apply_step(&mut self, step: &Step, sel: (Pos, Pos)) -> Step {
        let end = (step.start + step.after_len).min(self.block_count());
        let removed: Vec<Block> = self.doc.blocks.splice(step.start..end, step.before.iter().cloned()).collect();
        self.refresh_leaves();
        self.leaves_dirty = false;
        self.anchor = self.clamp(sel.0);
        self.head = self.clamp(sel.1);
        self.typing = None;
        self.coalesce = false;
        self.version += 1;
        self.sel_version += 1;
        Step {
            start: step.start,
            before: removed,
            after_len: step.before.len(),
            sel_before: sel,
            sel_after: sel,
            kind: EditKind::Other,
        }
    }

    /// Set the caret (collapsed) by path, for an edit that changed structure.
    pub(crate) fn put_caret(&mut self, block: usize, path: Vec<usize>, offset: usize) {
        self.pending = Some([(block, path.clone(), offset), (block, path, offset)]);
    }

    pub(crate) fn put_selection(&mut self, a: (usize, Vec<usize>, usize), h: (usize, Vec<usize>, usize)) {
        self.pending = Some([a, h]);
    }

    fn caret_paths(&self) -> [(usize, Vec<usize>, usize); 2] {
        let path = |p: Pos| {
            let path = self.leaves.get(p.block).and_then(|v| v.get(p.leaf)).map(|l| l.path.clone()).unwrap_or_default();
            (p.block, path, p.offset)
        };
        [path(self.anchor), path(self.head)]
    }

    /// Cut the edited blocks in `start..start + len` into one block per
    /// top-level node (adjacent lists of one kind stay together, or they
    /// would read back as one list), and give every node or run of nodes
    /// that equals a block as opened that block back, bytes and all.
    /// Returns the new length and where each (old block, node) went.
    fn normalize(&mut self, start: usize, len: usize, before: &[Block]) -> (usize, CutMap) {
        let old: Vec<Block> = self.doc.blocks.drain(start..start + len).collect();
        let mut candidates: Vec<usize> = before.iter().chain(old.iter()).filter_map(|b| b.origin).collect();
        candidates.sort_unstable();
        candidates.dedup();
        candidates.retain(|c| *c < self.base.len());
        let mut used: Vec<usize> = Vec::new();
        let mut out: Vec<Block> = Vec::new();
        let mut map = CutMap::new();
        let mut heirs: Vec<(usize, usize, String)> = Vec::new();
        for (ob, blk) in old.into_iter().enumerate() {
            let old_index = start + ob;
            if !blk.edited || blk.is_opaque() {
                let n = blk.nodes().len().max(1);
                for i in 0..n {
                    map.insert((old_index, i), (start + out.len(), i));
                }
                if let Some(o) = blk.origin {
                    used.push(o);
                }
                out.push(blk);
                continue;
            }
            let mut nodes = blk.nodes().to_vec();
            tree::fix_schema(&mut nodes);
            let mut j = 0;
            let mut first_new: Option<usize> = None;
            while j < nodes.len() {
                let found = candidates.iter().copied().find(|c| {
                    !used.contains(c) && {
                        let bn = self.base[*c].nodes();
                        !bn.is_empty() && !self.base[*c].is_opaque() && nodes[j..].starts_with(bn)
                    }
                });
                if let Some(c) = found {
                    used.push(c);
                    let l = self.base[c].nodes().len();
                    for k in 0..l {
                        map.insert((old_index, j + k), (start + out.len(), k));
                    }
                    out.push(self.base[c].clone());
                    j += l;
                    continue;
                }
                let mut k = j + 1;
                while k < nodes.len() && same_list(&nodes[k - 1], &nodes[k]) {
                    k += 1;
                }
                for m in j..k {
                    map.insert((old_index, m), (start + out.len(), m - j));
                }
                first_new.get_or_insert(start + out.len());
                out.push(new_block(nodes[j..k].to_vec()));
                j = k;
            }
            if let (Some(o), Some(at)) = (blk.origin, first_new) {
                heirs.push((at, o, blk.trailing.clone()));
            }
        }
        // A rewritten block keeps its place in the file (its origin and the
        // bytes after it) unless the original came back elsewhere.
        for (at, o, trailing) in heirs {
            if !used.contains(&o) {
                let b = &mut out[at - start];
                b.origin = Some(o);
                b.trailing = trailing;
                used.push(o);
            }
        }
        let new_len = out.len();
        self.doc.blocks.splice(start..start, out);
        (new_len, map)
    }

    fn restore_caret(&mut self, caret: [(usize, Vec<usize>, usize); 2], start: usize, old_len: usize, new_len: usize, map: &CutMap) {
        let mut out = [Pos::default(); 2];
        for (k, (block, path, offset)) in caret.into_iter().enumerate() {
            out[k] = if block < start || path.is_empty() {
                self.pos_of_path(block, &path, offset).unwrap_or_else(|| self.clamp(Pos::new(block, 0, offset)))
            } else if block < start + old_len {
                match map.get(&(block, path[0])) {
                    Some(&(nb, ni)) => {
                        let mut p = path.clone();
                        p[0] = ni;
                        self.pos_of_path(nb, &p, offset)
                            .or_else(|| self.pos_at_or_after(nb, &p))
                            .unwrap_or_else(|| self.clamp(Pos::new(nb, 0, offset)))
                    }
                    None => self.clamp(Pos::new(start + new_len.saturating_sub(1).min(new_len), 0, 0)),
                }
            } else {
                let nb = block + new_len - old_len;
                self.pos_of_path(nb, &path, offset).unwrap_or_else(|| self.clamp(Pos::new(nb, 0, offset)))
            };
        }
        self.anchor = out[0];
        self.head = out[1];
    }
}

type CutMap = std::collections::HashMap<(usize, usize), (usize, usize)>;

/// A new block holding `nodes`, not from the file.
pub(crate) fn new_block(nodes: Vec<Node>) -> Block {
    Block { source: String::new(), trailing: "\n\n".into(), content: BlockContent::Nodes(nodes), edited: true, origin: None }
}

pub(crate) fn block_leaves(b: &Block) -> Vec<Leaf> {
    match &b.content {
        BlockContent::Opaque(_) => vec![Leaf { path: vec![0], kind: LeafKind::Source, frames: vec![] }],
        BlockContent::Nodes(n) => tree::leaves(n),
    }
}

fn same_list(a: &Node, b: &Node) -> bool {
    tree::list_kind(a).is_some() && tree::list_kind(a) == tree::list_kind(b)
}
