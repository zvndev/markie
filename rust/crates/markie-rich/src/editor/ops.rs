//! Typing, deleting, Enter and the structure they change, plus caret
//! movement by character and word.

use unicode_segmentation::UnicodeSegmentation;

use super::tree;
use super::{EditKind, Editor, LeafKind, Pos};
use crate::document::BlockContent;
use crate::edit::Unit;
use crate::model::*;

/// Unit offsets where a grapheme starts, plus the end.
pub(crate) fn boundaries(units: &[Unit]) -> Vec<usize> {
    let s: String = units
        .iter()
        .map(|u| match u {
            Unit::Char(c, _) => *c,
            Unit::Atom(_) => '\u{fffc}',
        })
        .collect();
    let mut out = Vec::with_capacity(units.len() + 1);
    let mut chars = 0usize;
    for g in s.graphemes(true) {
        out.push(chars);
        chars += g.chars().count();
    }
    out.push(chars);
    out
}

fn is_word(u: &Unit) -> bool {
    matches!(u, Unit::Char(c, _) if c.is_alphanumeric() || *c == '_')
}

pub(crate) fn word_left(units: &[Unit], mut i: usize) -> usize {
    while i > 0 && !is_word(&units[i - 1]) {
        i -= 1;
    }
    while i > 0 && is_word(&units[i - 1]) {
        i -= 1;
    }
    i
}

pub(crate) fn word_right(units: &[Unit], mut i: usize) -> usize {
    let n = units.len();
    while i < n && !is_word(&units[i]) {
        i += 1;
    }
    while i < n && is_word(&units[i]) {
        i += 1;
    }
    i
}

/// The word around `i` (for a double click).
pub fn word_at(units: &[Unit], i: usize) -> (usize, usize) {
    let i = i.min(units.len());
    if units.get(i).is_some_and(is_word) || (i > 0 && is_word(&units[i - 1])) {
        let mut a = i;
        while a > 0 && is_word(&units[a - 1]) {
            a -= 1;
        }
        let mut b = i;
        while b < units.len() && is_word(&units[b]) {
            b += 1;
        }
        (a, b)
    } else {
        (i, (i + 1).min(units.len()))
    }
}

/// Marks typed text gets at `at`: those of the character before it, links
/// and code aside (TipTap's Link is not inclusive; code ends at its edge).
pub(crate) fn marks_before(units: &[Unit], at: usize) -> Marks {
    let mut m = match at.checked_sub(1).and_then(|i| units.get(i)) {
        Some(Unit::Char(_, m)) => m.clone(),
        _ => match units.get(at) {
            // At the very start, the first character's marks (minus links).
            Some(Unit::Char(_, m)) if at == 0 => m.clone(),
            _ => Marks::default(),
        },
    };
    m.link = None;
    m.code = false;
    m
}

impl Editor {
    fn caret_path(&self, p: Pos) -> Vec<usize> {
        self.leaf(p).map(|l| l.path.clone()).unwrap_or_default()
    }

    // ---- typing ----

    pub fn insert_text(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        if s.contains('\n') && !self.kind(self.head).is_some_and(|k| k.is_plain()) {
            // Several lines typed or dropped as text: paste them as Markdown.
            self.paste_markdown(s);
            return;
        }
        let (from, to) = self.range();
        let blocks = from.block..to.block + 1;
        let typing = self.typing.clone();
        let held = self.transact_held(blocks, EditKind::Typing, |ed| {
            let mut at = from;
            if from != to {
                at = ed.delete_range_inner(from, to);
            }
            ed.insert_at(at, s, typing);
        });
        let ran = self.run_input_rules(s) && self.rule_undo == Some(self.sel_version);
        if let Some(joins) = held {
            self.settle_held(joins, ran);
            if ran {
                self.rule_typed = Some(s.to_string());
            }
        }
    }

    /// Insert text at `at` (inside a transaction, leaves current).
    pub(crate) fn insert_at(&mut self, at: Pos, s: &str, typing: Option<Marks>) {
        match self.kind(at) {
            Some(LeafKind::Atom) => {
                // Typing over a selected picture replaces it with a paragraph.
                let path = self.caret_path(at);
                let Some(nodes) = self.nodes_mut(at.block) else { return };
                if let Some(n) = tree::node_at_mut(nodes, &path) {
                    *n = Node::para(vec![Inline::text(s)]);
                }
                self.put_caret(at.block, path, s.chars().count());
            }
            Some(k) if k.is_plain() => {
                let mut units = self.units(at.block, at.leaf);
                let off = at.offset.min(units.len());
                for (i, c) in s.chars().enumerate() {
                    units.insert(off + i, Unit::Char(c, Marks::default()));
                }
                self.set_units(at.block, at.leaf, &units);
                let path = self.caret_path(at);
                self.put_caret(at.block, path, off + s.chars().count());
            }
            Some(_) => {
                let mut units = self.units(at.block, at.leaf);
                let off = at.offset.min(units.len());
                let marks = typing.unwrap_or_else(|| marks_before(&units, off));
                for (i, c) in s.chars().enumerate() {
                    units.insert(off + i, Unit::Char(c, marks.clone()));
                }
                let caret = off + s.chars().count();
                self.set_units(at.block, at.leaf, &units);
                let path = self.caret_path(at);
                self.put_caret(at.block, path.clone(), caret);
                if s == " " {
                    autolink_before(&mut units, caret - 1);
                    self.set_units(at.block, at.leaf, &units);
                }
            }
            None => {}
        }
    }

    // ---- deleting ----

    pub fn backspace(&mut self) {
        if self.undo_input_rule() {
            return;
        }
        if self.code_backspace() {
            return;
        }
        self.delete_dir(false, false);
    }

    pub fn delete_forward(&mut self) {
        self.delete_dir(true, false);
    }

    pub fn delete_word_backward(&mut self) {
        self.delete_dir(false, true);
    }

    pub fn delete_word_forward(&mut self) {
        self.delete_dir(true, true);
    }

    /// Delete to the start of the line the view says the caret is on.
    pub fn delete_to(&mut self, target: Pos) {
        let target = self.clamp(target);
        if target == self.head {
            return;
        }
        self.anchor = self.head;
        self.head = target;
        self.delete_dir(false, false);
    }

    fn delete_dir(&mut self, forward: bool, word: bool) {
        let (from, to) = self.range();
        if from != to {
            self.transact(from.block..to.block + 1, EditKind::Deleting, |ed| {
                ed.delete_range_inner(from, to);
            });
            return;
        }
        let p = self.head;
        let Some(kind) = self.kind(p) else { return };
        let units = self.units(p.block, p.leaf);
        if kind == LeafKind::Atom {
            // A picture is selected before it is deleted; here it is.
            let (a, b) = if forward { (p, Pos { offset: 1, ..p }) } else { (Pos { offset: 0, ..p }, p) };
            if a != b {
                self.transact(p.block..p.block + 1, EditKind::Deleting, |ed| {
                    ed.delete_range_inner(a, b);
                });
            }
            return;
        }
        let len = units.len();
        let inside = if forward { p.offset < len } else { p.offset > 0 };
        if inside {
            let other = if word {
                if forward { word_right(&units, p.offset) } else { word_left(&units, p.offset) }
            } else {
                let bs = boundaries(&units);
                if forward {
                    *bs.iter().find(|b| **b > p.offset).unwrap_or(&len)
                } else {
                    *bs.iter().rev().find(|b| **b < p.offset).unwrap_or(&0)
                }
            };
            let (a, b) = if forward { (p.offset, other) } else { (other, p.offset) };
            let path = self.caret_path(p);
            self.transact(p.block..p.block + 1, EditKind::Deleting, |ed| {
                let mut u = units.clone();
                u.drain(a..b);
                ed.set_units(p.block, p.leaf, &u);
                ed.put_caret(p.block, path, a);
            });
            return;
        }
        if forward { self.join_forward(p) } else { self.join_backward(p) }
    }

    /// Backspace at the start of a leaf.
    fn join_backward(&mut self, p: Pos) {
        let Some(leaf) = self.leaf(p).cloned() else { return };
        let nodes = self.doc.blocks[p.block].nodes().to_vec();
        // First block of a list item: lift the item out of its list.
        if leaf.path.len() >= 3 && *leaf.path.last().unwrap() == 0 {
            if let Some(super::Frame::Item { .. }) = leaf.frames.last() {
                self.transact(p.block..p.block + 1, EditKind::Deleting, |ed| ed.lift_item_at(p.block, &leaf.path));
                return;
            }
        }
        // First block of a quote: lift it out.
        if leaf.path.len() >= 2 && *leaf.path.last().unwrap() == 0 && matches!(leaf.frames.last(), Some(super::Frame::Quote)) {
            self.transact(p.block..p.block + 1, EditKind::Deleting, |ed| ed.unwrap_quote_at(p.block, &leaf.path));
            return;
        }
        // A heading or code block at the very start of the document turns
        // into a paragraph rather than doing nothing.
        let Some(prev) = self.prev_leaf(p) else {
            // TipTap's clearNodes runs only on an empty heading there (core
            // keymap); CodeBlock's own Backspace handled the code case.
            if matches!(leaf.kind, LeafKind::Heading(_)) && self.leaf_len(p.block, p.leaf) == 0 {
                self.set_block_style(super::BlockStyle::Paragraph);
            }
            return;
        };
        let pkind = self.kind(prev).unwrap();
        let pleaf = self.leaf(prev).cloned().unwrap();
        let _ = nodes;
        if pkind == LeafKind::Atom {
            self.set_selection(Pos { offset: 0, ..prev }, Pos { offset: 1, ..prev });
            return;
        }
        if leaf.in_cell() || pleaf.in_cell() || pkind == LeafKind::Source || leaf.kind == LeafKind::Source {
            // Cells and source blocks do not merge; step into the previous one.
            if self.leaf_len(p.block, p.leaf) == 0 && !leaf.in_cell() && leaf.kind != LeafKind::Source {
                self.transact(prev.block..p.block + 1, EditKind::Deleting, |ed| {
                    ed.remove_leaf(p.block, &leaf.path);
                    ed.put_caret(prev.block, pleaf.path.clone(), prev.offset);
                });
            } else {
                self.set_caret(prev, false);
            }
            return;
        }
        self.merge_leaves(prev, p);
    }

    fn join_forward(&mut self, p: Pos) {
        let Some(next) = self.next_leaf(p) else { return };
        let leaf = self.leaf(p).cloned().unwrap();
        let nleaf = self.leaf(next).cloned().unwrap();
        if nleaf.kind == LeafKind::Atom {
            self.set_selection(next, Pos { offset: 1, ..next });
            return;
        }
        if leaf.in_cell() || nleaf.in_cell() || leaf.kind == LeafKind::Source || nleaf.kind == LeafKind::Source {
            return;
        }
        let at = Pos { offset: self.leaf_len(p.block, p.leaf), ..p };
        self.merge_leaves(at, next);
    }

    /// Append leaf `b` to leaf `a` (a before b), then remove `b`.
    fn merge_leaves(&mut self, a: Pos, b: Pos) {
        let a_units = self.units(a.block, a.leaf);
        let b_units = self.units(b.block, b.leaf);
        let a_kind = self.kind(a).unwrap();
        let a_path = self.caret_path(a);
        let b_path = self.caret_path(b);
        let at = a_units.len();
        self.transact(a.block..b.block + 1, EditKind::Deleting, |ed| {
            let mut merged = a_units.clone();
            if a_kind.is_plain() {
                // Atoms (math, breaks) as their text.
                for u in &b_units {
                    for c in u.display().chars() {
                        merged.push(Unit::Char(c, Marks::default()));
                    }
                }
            } else {
                merged.extend(b_units.iter().cloned());
            }
            if a.block == b.block {
                ed.remove_leaf(b.block, &b_path);
                ed.set_units_path(a.block, &a_path, &merged);
            } else {
                ed.set_units_path(a.block, &a_path, &merged);
                ed.remove_leaf(b.block, &b_path);
            }
            ed.put_caret(a.block, a_path.clone(), at);
        });
    }

    /// Store units at a leaf path (paths stay valid across structure edits
    /// that only remove later nodes).
    pub(crate) fn set_units_path(&mut self, block: usize, path: &[usize], units: &[Unit]) {
        if self.doc.blocks[block].is_opaque() {
            self.doc.blocks[block].source = tree::units_text(units);
            return;
        }
        let kind = match self.node_at(block, path) {
            Some(Node::Heading { level, .. }) => LeafKind::Heading(*level),
            Some(Node::CodeBlock { .. }) => LeafKind::Code,
            Some(Node::MathBlock { .. }) => LeafKind::Math,
            _ => LeafKind::Paragraph,
        };
        let leaf = super::Leaf { path: path.to_vec(), kind, frames: vec![] };
        if let Some(nodes) = self.nodes_mut(block) {
            tree::set_leaf_units(nodes, &leaf, units);
        }
    }

    /// Remove the node at `path`, then any container it leaves empty. A
    /// table cell is never left empty; a block left empty is dropped.
    pub(crate) fn remove_leaf(&mut self, block: usize, path: &[usize]) {
        if self.doc.blocks[block].is_opaque() {
            self.doc.blocks[block].content = BlockContent::Nodes(vec![]);
            self.doc.blocks[block].edited = true;
            return;
        }
        let Some(nodes) = self.nodes_mut(block) else { return };
        remove_node(nodes, path);
    }

    /// Delete `from..to` (inside a transaction); returns where the caret goes.
    pub(crate) fn delete_range_inner(&mut self, from: Pos, to: Pos) -> Pos {
        let from_path = self.caret_path(from);
        if from.block == to.block && from.leaf == to.leaf {
            match self.kind(from) {
                Some(LeafKind::Atom) => {
                    self.remove_leaf(from.block, &from_path);
                    self.put_caret_after_removal(from);
                    return from;
                }
                _ => {
                    let mut u = self.units(from.block, from.leaf);
                    u.drain(from.offset.min(u.len())..to.offset.min(u.len()));
                    self.set_units(from.block, from.leaf, &u);
                    self.put_caret(from.block, from_path, from.offset);
                    return from;
                }
            }
        }
        // Several leaves. Work from the end so earlier paths stay valid.
        let from_kind = self.kind(from).unwrap();
        let to_kind = self.kind(to).unwrap();
        let to_leaf = self.leaf(to).cloned().unwrap();
        let from_leaf = self.leaf(from).cloned().unwrap();
        // Between: every leaf strictly after `from` and before `to`.
        let mut between: Vec<(usize, Vec<usize>, bool)> = Vec::new();
        let mut q = self.next_leaf(from);
        while let Some(x) = q {
            if (x.block, x.leaf) >= (to.block, to.leaf) {
                break;
            }
            let l = self.leaf(x).unwrap();
            between.push((x.block, l.path.clone(), l.in_cell()));
            q = self.next_leaf(x);
        }
        let to_units = self.units(to.block, to.leaf);
        let tail: Vec<Unit> = if to_kind == LeafKind::Atom {
            Vec::new()
        } else {
            to_units[to.offset.min(to_units.len())..].to_vec()
        };
        let to_covered = to_kind == LeafKind::Atom && to.offset == 1;
        let from_covered = from_kind == LeafKind::Atom && from.offset == 0;
        let can_merge = from_kind.has_text()
            && to_kind.has_text()
            && from_kind != LeafKind::Source
            && to_kind != LeafKind::Source
            && !from_leaf.in_cell()
            && !to_leaf.in_cell();
        // 1. The end leaf: removed when merged or covered, else trimmed.
        if can_merge || to_covered {
            self.remove_leaf(to.block, &to_leaf.path);
        } else if to_kind.has_text() {
            let mut u = to_units.clone();
            u.drain(..to.offset.min(u.len()));
            self.set_units_path(to.block, &to_leaf.path, &u);
        }
        // 2. Everything between, last first. Cells are cleared, not removed.
        for (b, path, in_cell) in between.iter().rev() {
            if *in_cell {
                self.set_units_path(*b, path, &[]);
            } else {
                self.remove_leaf(*b, path);
            }
        }
        // 3. The start leaf.
        if from_covered {
            self.remove_leaf(from.block, &from_path);
            self.put_caret_after_removal(from);
            return from;
        }
        if from_kind.has_text() {
            let mut u = self.units_path(from.block, &from_path);
            u.truncate(from.offset);
            if can_merge {
                if from_kind.is_plain() {
                    for t in &tail {
                        for c in t.display().chars() {
                            u.push(Unit::Char(c, Marks::default()));
                        }
                    }
                } else {
                    u.extend(tail);
                }
            }
            self.set_units_path(from.block, &from_path, &u);
        }
        self.put_caret(from.block, from_path, from.offset);
        from
    }

    fn put_caret_after_removal(&mut self, at: Pos) {
        // The caret goes to the node that took the removed one's place, or
        // the end of the one before it.
        let path = self.caret_path(at);
        if let Some(BlockContent::Nodes(nodes)) = self.doc.blocks.get(at.block).map(|b| &b.content) {
            if tree::node_at(nodes, &path).is_some() {
                self.put_caret(at.block, path, 0);
                return;
            }
        }
        if let Some(prev) = self.prev_leaf(at) {
            let pp = self.caret_path(prev);
            self.put_caret(prev.block, pp, prev.offset);
        } else {
            self.put_caret(at.block, path, 0);
        }
    }

    /// Units of the leaf at `path` in the document as it is now.
    pub(crate) fn units_path(&self, block: usize, path: &[usize]) -> Vec<Unit> {
        let b = &self.doc.blocks[block];
        match &b.content {
            BlockContent::Opaque(_) => b.source.chars().map(|c| Unit::Char(c, Marks::default())).collect(),
            BlockContent::Nodes(n) => {
                let kind = match tree::node_at(n, path) {
                    Some(Node::Heading { level, .. }) => LeafKind::Heading(*level),
                    Some(Node::CodeBlock { .. }) => LeafKind::Code,
                    Some(Node::MathBlock { .. }) => LeafKind::Math,
                    Some(Node::Paragraph { .. }) => LeafKind::Paragraph,
                    _ => return vec![],
                };
                tree::leaf_units(n, &super::Leaf { path: path.to_vec(), kind, frames: vec![] })
            }
        }
    }

    // ---- Enter ----

    pub fn enter(&mut self) {
        let (from, to) = self.range();
        if from == to && self.run_input_rules("\n") {
            return;
        }
        if let Some(atom) = self.selected_atom() {
            // Enter on a selected picture: a new line after it.
            let at = Pos { offset: 1, ..atom };
            self.transact(at.block..at.block + 1, EditKind::Replacing, |ed| ed.split_at(at));
            return;
        }
        // splitBlock does not close the history: Enter joins the typing
        // before it, as in TipTap.
        self.transact(from.block..to.block + 1, EditKind::Replacing, |ed| {
            let at = if from != to { ed.delete_range_inner(from, to) } else { from };
            ed.refresh_now();
            let at = ed.clamp_after_delete(at);
            ed.split_at(at);
        });
    }

    /// Re-derive leaves mid-transaction, after a structural step.
    pub(crate) fn refresh_now(&mut self) {
        if let Some([a, _]) = self.pending.clone() {
            self.refresh_leaves();
            if let Some(p) = self.pos_of_path(a.0, &a.1, a.2) {
                self.anchor = p;
                self.head = p;
            }
        } else {
            self.refresh_leaves();
        }
    }

    fn clamp_after_delete(&self, at: Pos) -> Pos {
        let _ = at;
        self.head
    }

    fn split_at(&mut self, at: Pos) {
        let Some(leaf) = self.leaf(at).cloned() else { return };
        let block = at.block;
        let path = leaf.path.clone();
        match leaf.kind {
            LeafKind::Atom => {
                // A new paragraph after the picture.
                let (c, i) = tree::split_path(&path);
                let c = c.to_vec();
                let Some(nodes) = self.nodes_mut(block) else { return };
                let Some(cont) = tree::container_mut(nodes, &c) else { return };
                let at_i = if at.offset == 0 { i } else { i + 1 };
                cont.insert(at_i, Node::para(vec![]));
                let mut p = c;
                p.push(at_i);
                self.put_caret(block, p, 0);
            }
            LeafKind::Code => {
                let mut u = self.units(block, at.leaf);
                let off = at.offset.min(u.len());
                // Enter twice on an empty last line leaves the block.
                let ends_blank = off == u.len() && u.len() >= 2 && u[u.len() - 1].display() == "\n" && u[u.len() - 2].display() == "\n";
                if ends_blank {
                    u.truncate(u.len() - 2);
                    self.set_units(block, at.leaf, &u);
                    let (c, i) = tree::split_path(&path);
                    let c = c.to_vec();
                    let Some(nodes) = self.nodes_mut(block) else { return };
                    tree::container_mut(nodes, &c).unwrap().insert(i + 1, Node::para(vec![]));
                    let mut p = c;
                    p.push(i + 1);
                    self.put_caret(block, p, 0);
                } else {
                    u.insert(off, Unit::Char('\n', Marks::default()));
                    self.set_units(block, at.leaf, &u);
                    self.put_caret(block, path, off + 1);
                }
            }
            LeafKind::Math | LeafKind::Source => {
                let mut u = self.units(block, at.leaf);
                let off = at.offset.min(u.len());
                u.insert(off, Unit::Char('\n', Marks::default()));
                self.set_units(block, at.leaf, &u);
                self.put_caret(block, path, off + 1);
            }
            LeafKind::Paragraph | LeafKind::Heading(_) => {
                if leaf.in_cell() {
                    let mut u = self.units(block, at.leaf);
                    let off = at.offset.min(u.len());
                    u.insert(off, Unit::Atom(Inline::HardBreak));
                    self.set_units(block, at.leaf, &u);
                    self.put_caret(block, path, off + 1);
                    return;
                }
                let units = self.units(block, at.leaf);
                let off = at.offset.min(units.len());
                let empty = units.is_empty();
                match leaf.frames.last() {
                    Some(super::Frame::Item { .. }) => {
                        let item_len = {
                            let nodes = self.doc.blocks[block].nodes().to_vec();
                            tree::container_of(&nodes, tree::split_path(&path).0).map(|c| c.len()).unwrap_or(0)
                        };
                        if empty && item_len <= 1 {
                            self.lift_item_at(block, &path);
                        } else {
                            self.split_item(block, &path, &units, off);
                        }
                    }
                    Some(super::Frame::Quote) if empty => {
                        let (c, i) = tree::split_path(&path);
                        let last = {
                            let nodes = self.doc.blocks[block].nodes().to_vec();
                            tree::container_of(&nodes, c).map(|c| c.len()).unwrap_or(0) == i + 1
                        };
                        if last {
                            self.lift_out_of_quote(block, &path);
                        } else {
                            self.split_paragraph(block, &path, &units, off);
                        }
                    }
                    _ => self.split_paragraph(block, &path, &units, off),
                }
            }
        }
    }

    /// Split a paragraph or heading in its container.
    fn split_paragraph(&mut self, block: usize, path: &[usize], units: &[Unit], off: usize) {
        let (c, i) = tree::split_path(path);
        let c = c.to_vec();
        let Some(nodes) = self.nodes_mut(block) else { return };
        let node = tree::node_at(nodes, path).cloned().unwrap();
        let head = crate::edit::unflatten(&units[..off]);
        let tail = crate::edit::unflatten(&units[off..]);
        let cont = tree::container_mut(nodes, &c).unwrap();
        match node {
            Node::Heading { level, align, .. } => {
                if off == 0 && !units.is_empty() {
                    // Enter at the start of a heading: a paragraph above it.
                    cont.insert(i, Node::para(vec![]));
                    let mut p = c;
                    p.push(i + 1);
                    self.put_caret(block, p, 0);
                    return;
                }
                cont[i] = Node::Heading { level, content: head, align };
                cont.insert(i + 1, Node::para(tail));
            }
            Node::Paragraph { align, .. } => {
                cont[i] = Node::Paragraph { content: head, align: align.clone() };
                cont.insert(i + 1, Node::Paragraph { content: tail, align });
            }
            _ => return,
        }
        let mut p = c;
        p.push(i + 1);
        self.put_caret(block, p, 0);
    }

    /// Enter in a list item: the rest of the item becomes a new item.
    fn split_item(&mut self, block: usize, path: &[usize], units: &[Unit], off: usize) {
        let (item_path, node_i) = tree::split_path(path);
        let (list_cpath, item_i) = tree::split_path(item_path);
        let (list_container, list_i) = tree::split_path(list_cpath);
        let list_container = list_container.to_vec();
        let Some(nodes) = self.nodes_mut(block) else { return };
        let Some(cont) = tree::container_mut(nodes, &list_container) else { return };
        let list = &mut cont[list_i];
        let mut item: Vec<Node> = match list {
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => std::mem::take(&mut items[item_i]),
            Node::TaskList { items } => std::mem::take(&mut items[item_i].content),
            _ => return,
        };
        let rest: Vec<Node> = item.split_off(node_i + 1);
        let current = item.pop().unwrap_or(Node::para(vec![]));
        let (head, tail) = match current {
            Node::Paragraph { align, .. } => (
                Node::Paragraph { content: crate::edit::unflatten(&units[..off]), align: align.clone() },
                Node::Paragraph { content: crate::edit::unflatten(&units[off..]), align },
            ),
            Node::Heading { level, align, .. } => (
                Node::Heading { level, content: crate::edit::unflatten(&units[..off]), align },
                Node::para(crate::edit::unflatten(&units[off..])),
            ),
            other => (other, Node::para(vec![])),
        };
        item.push(head);
        let mut new_item = vec![tail];
        new_item.extend(rest);
        match list {
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                items[item_i] = item;
                items.insert(item_i + 1, new_item);
            }
            Node::TaskList { items } => {
                items[item_i].content = item;
                items.insert(item_i + 1, TaskItem { checked: false, content: new_item });
            }
            _ => {}
        }
        let mut p = list_cpath.to_vec();
        p.push(item_i + 1);
        p.push(0);
        self.put_caret(block, p, 0);
    }

    pub fn hard_break(&mut self) {
        // setHardBreak tries exitCode first: Shift-Enter leaves a code block.
        if self.exit_code() {
            return;
        }
        let (from, to) = self.range();
        self.transact(from.block..to.block + 1, EditKind::Replacing, |ed| {
            if from != to {
                ed.delete_range_inner(from, to);
            }
            ed.refresh_now();
            let p = ed.head;
            match ed.kind(p) {
                // A heading is one line; Markdown has no break inside one.
                Some(LeafKind::Heading(_)) => {}
                Some(k) if k.is_rich() => {
                    let mut u = ed.units(p.block, p.leaf);
                    let off = p.offset.min(u.len());
                    u.insert(off, Unit::Atom(Inline::HardBreak));
                    ed.set_units(p.block, p.leaf, &u);
                    let path = ed.caret_path(p);
                    ed.put_caret(p.block, path, off + 1);
                }
                Some(k) if k.is_plain() => ed.insert_at(p, "\n", None),
                _ => ed.split_at(p),
            }
        });
    }

    // ---- caret movement ----

    pub fn move_left(&mut self, extend: bool, word: bool) {
        self.move_h(false, extend, word);
    }

    pub fn move_right(&mut self, extend: bool, word: bool) {
        self.move_h(true, extend, word);
    }

    fn move_h(&mut self, forward: bool, extend: bool, word: bool) {
        if !extend && self.has_selection() {
            let (a, b) = self.range();
            if self.selected_atom().is_some() {
                // Off the picture to the neighbouring leaf.
                let next = if forward { self.next_leaf(a) } else { self.prev_leaf(a) };
                match next {
                    Some(n) => self.set_caret(n, false),
                    None => self.set_caret(if forward { b } else { a }, false),
                }
                return;
            }
            self.set_caret(if forward { b } else { a }, false);
            return;
        }
        let p = self.head;
        let units = self.units(p.block, p.leaf);
        let len = self.leaf_len(p.block, p.leaf);
        let is_atom = self.kind(p) == Some(LeafKind::Atom);
        let target = if !is_atom && forward && p.offset < len {
            let o = if word { word_right(&units, p.offset) } else { *boundaries(&units).iter().find(|b| **b > p.offset).unwrap_or(&len) };
            Pos { offset: o, ..p }
        } else if !is_atom && !forward && p.offset > 0 {
            let o = if word { word_left(&units, p.offset) } else { *boundaries(&units).iter().rev().find(|b| **b < p.offset).unwrap_or(&0) };
            Pos { offset: o, ..p }
        } else if is_atom && extend && ((forward && p.offset == 0) || (!forward && p.offset == 1)) {
            Pos { offset: if forward { 1 } else { 0 }, ..p }
        } else {
            let n = if forward { self.next_leaf(p) } else { self.prev_leaf(p) };
            match n {
                Some(n) => n,
                None => return,
            }
        };
        if extend {
            let anchor = self.anchor;
            self.set_selection(anchor, target);
        } else {
            self.set_caret(target, false);
        }
    }

    /// Start or end of the current leaf (the view handles visual lines).
    pub fn move_leaf_edge(&mut self, end: bool, extend: bool) {
        let p = self.head;
        let o = if end { self.leaf_len(p.block, p.leaf) } else { 0 };
        self.set_caret(Pos { offset: o, ..p }, extend);
    }

    pub fn move_doc_edge(&mut self, end: bool, extend: bool) {
        let p = if end { self.end_pos() } else { Pos::new(0, 0, 0) };
        self.set_caret(p, extend);
    }

    /// The previous or next leaf, keeping the offset as best it can (the
    /// view moves by visual line first and only falls back to this).
    pub fn move_leaf_vertical(&mut self, down: bool, extend: bool) -> bool {
        let p = self.head;
        let n = if down { self.next_leaf(p) } else { self.prev_leaf(p) };
        match n {
            Some(n) => {
                let o = if down { 0 } else { self.leaf_len(n.block, n.leaf) };
                self.set_caret(Pos { offset: o, ..n }, extend);
                true
            }
            None => {
                if down && !extend {
                    // TipTap's trailing node: past a last block that is not a
                    // paragraph, there is always one more line.
                    if self.kind(p) != Some(LeafKind::Paragraph) || self.leaf(p).is_some_and(|l| !l.frames.is_empty()) {
                        self.append_paragraph();
                        return true;
                    }
                }
                let o = if down { self.leaf_len(p.block, p.leaf) } else { 0 };
                self.set_caret(Pos { offset: o, ..p }, extend);
                false
            }
        }
    }

    /// An empty paragraph at the end of the document, caret in it.
    pub fn append_paragraph(&mut self) {
        let n = self.block_count();
        self.transact(n..n, EditKind::Other, |ed| {
            ed.doc.blocks.push(super::new_block(vec![Node::para(vec![])]));
            ed.put_caret(n, vec![0], 0);
        });
    }
}

/// TipTap's Link `autolink`: the word before a typed space becomes a link
/// when linkify reads it as an address.
fn autolink_before(units: &mut [Unit], end: usize) {
    let mut start = end;
    while start > 0 && matches!(&units[start - 1], Unit::Char(c, m) if !c.is_whitespace() && m.link.is_none() && !m.code) {
        start -= 1;
    }
    if start == end {
        return;
    }
    let word: String = units[start..end].iter().map(|u| u.display()).collect();
    if let Some((0, len, href)) = crate::linkify::find(&word) {
        let n = word[..len].chars().count();
        let link = Link { href, title: None, style: LinkStyle::Autolink };
        for u in &mut units[start..start + n] {
            if let Unit::Char(_, m) = u {
                m.link = Some(link.clone());
            }
        }
    }
}

/// Remove the node at `path` and prune containers it leaves empty.
pub(crate) fn remove_node(nodes: &mut Vec<Node>, path: &[usize]) {
    let (c, i) = tree::split_path(path);
    let c = c.to_vec();
    let Some(cont) = tree::container_mut(nodes, &c) else { return };
    if i < cont.len() {
        cont.remove(i);
    }
    prune(nodes, &c);
}

/// If the container at `cpath` is empty, remove what holds it.
fn prune(nodes: &mut Vec<Node>, cpath: &[usize]) {
    if cpath.is_empty() {
        return;
    }
    if !tree::container_of(nodes, cpath).is_some_and(|c| c.is_empty()) {
        return;
    }
    let mut probe = cpath.to_vec();
    probe.push(0);
    let Some((owner_c, owner_i)) = tree::ancestors(nodes, &probe).last().cloned() else { return };
    let Some(owner_cont) = tree::container_mut(nodes, &owner_c) else { return };
    let owner = &mut owner_cont[owner_i];
    let item_i = cpath.get(owner_c.len() + 1).copied().unwrap_or(0);
    let remove_owner = match owner {
        Node::Blockquote(_) => true,
        Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
            if item_i < items.len() {
                items.remove(item_i);
            }
            items.is_empty()
        }
        Node::TaskList { items } => {
            if item_i < items.len() {
                items.remove(item_i);
            }
            items.is_empty()
        }
        Node::Table { rows } => {
            // A cell keeps an empty paragraph.
            let r = cpath[owner_c.len() + 1];
            let col = cpath[owner_c.len() + 2];
            if let Some(cell) = rows.get_mut(r).and_then(|row| row.get_mut(col)) {
                cell.content.push(Node::para(vec![]));
            }
            false
        }
        _ => false,
    };
    if remove_owner {
        owner_cont.remove(owner_i);
        prune(nodes, &owner_c);
    }
}
