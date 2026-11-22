//! Clipboard, find and the outline.

use super::tree::{self, LeafKind};
use super::{EditKind, Editor, Pos};
use crate::document::{Block, BlockContent, Document};
use crate::edit::{Unit, flatten, unflatten};
use crate::model::*;
use crate::serialize::nodes_to_markdown;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FindMatch {
    pub start: Pos,
    pub end: Pos,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutlineEntry {
    pub block: usize,
    pub leaf: usize,
    pub level: u8,
    pub text: String,
}

impl Editor {
    /// A leaf's selected part as a node of its own kind.
    fn partial_node(&self, p: Pos, a: usize, b: usize) -> Option<Node> {
        let units = self.units(p.block, p.leaf);
        let part = &units[a.min(units.len())..b.min(units.len())];
        Some(match self.leaf_node(p)? {
            Node::Paragraph { align, .. } => Node::Paragraph { content: unflatten(part), align: align.clone() },
            Node::Heading { level, align, .. } => Node::Heading { level: *level, content: unflatten(part), align: align.clone() },
            Node::CodeBlock { language, .. } => Node::CodeBlock { language: language.clone(), code: tree::units_text(part) },
            Node::MathBlock { .. } => Node::MathBlock { source: format!("$$\n{}\n$$", tree::units_text(part)) },
            other => other.clone(),
        })
    }

    /// The selection as Markdown. Whole blocks are copied as their own
    /// bytes; the partial leaves at either end as the editor writes them.
    pub fn selection_markdown(&self) -> String {
        if !self.has_selection() {
            return String::new();
        }
        let (from, to) = self.range();
        if (from.block, from.leaf) == (to.block, to.leaf) {
            return match self.kind(from) {
                Some(k) if k.is_rich() => {
                    let u = self.units(from.block, from.leaf);
                    nodes_to_markdown(&[Node::para(unflatten(&u[from.offset..to.offset.min(u.len())]))])
                }
                Some(LeafKind::Atom) => self.leaf_node(from).map(|n| nodes_to_markdown(std::slice::from_ref(n))).unwrap_or_default(),
                Some(_) => tree::units_text(&self.units(from.block, from.leaf)[from.offset..to.offset]),
                None => String::new(),
            };
        }
        let mut parts: Vec<String> = Vec::new();
        let mut pending: Vec<Node> = Vec::new();
        let flush = |pending: &mut Vec<Node>, parts: &mut Vec<String>| {
            if !pending.is_empty() {
                parts.push(nodes_to_markdown(pending));
                pending.clear();
            }
        };
        for b in from.block..=to.block {
            let n = self.leaves_of(b).len();
            let whole_start = b > from.block || (from.leaf == 0 && from.offset == 0);
            let whole_end = b < to.block || (to.leaf + 1 == n && to.offset >= self.leaf_len(b, to.leaf));
            if whole_start && whole_end {
                flush(&mut pending, &mut parts);
                parts.push(self.doc.block_markdown(b));
                continue;
            }
            let l0 = if b == from.block { from.leaf } else { 0 };
            let l1 = if b == to.block { to.leaf } else { n.saturating_sub(1) };
            for l in l0..=l1 {
                let p = Pos::new(b, l, 0);
                let len = self.leaf_len(b, l);
                let a = if (b, l) == (from.block, from.leaf) { from.offset } else { 0 };
                let e = if (b, l) == (to.block, to.leaf) { to.offset } else { len };
                if self.doc.blocks[b].is_opaque() {
                    flush(&mut pending, &mut parts);
                    parts.push(tree::units_text(&self.units(b, l)[a..e.min(len)]));
                } else if let Some(node) = self.partial_node(p, a, e) {
                    // In its list or quote, so a copied item is still an item.
                    let frames = self.leaf(p).map(|l| l.frames.clone()).unwrap_or_default();
                    let node = wrap_frames(node, &frames);
                    match (pending.last_mut(), node) {
                        (Some(last), node) if same_kind_list(last, &node) => {
                            let mut node = node;
                            let more = super::format::take_items(&mut node);
                            let kind = tree::list_kind(last).unwrap();
                            let mut items = super::format::take_items(last);
                            items.extend(more);
                            *last = super::format::make_list(kind, true, 1, items);
                        }
                        (_, node) => pending.push(node),
                    }
                }
            }
        }
        flush(&mut pending, &mut parts);
        parts.join("\n\n")
    }

    /// The selection as plain text, one leaf per line.
    pub fn selection_text(&self) -> String {
        let mut out: Vec<String> = Vec::new();
        for (p, a, b) in self.selected_spans() {
            if self.kind(p) == Some(LeafKind::Atom) {
                if let Some(Node::Image { alt, .. }) = self.leaf_node(p) {
                    out.push(alt.clone().unwrap_or_default());
                }
                continue;
            }
            let u = self.units(p.block, p.leaf);
            out.push(tree::units_text(&u[a.min(u.len())..b.min(u.len())]));
        }
        out.join("\n")
    }

    pub fn cut(&mut self) -> String {
        let md = self.selection_markdown();
        if self.has_selection() {
            self.delete_forward();
        }
        md
    }

    /// Paste text as Markdown (TipTap's `transformPastedText`). In code,
    /// TeX or source it goes in as typed.
    pub fn paste_markdown(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n");
        if text.is_empty() {
            return;
        }
        let kind = self.kind(self.head);
        if kind.is_some_and(|k| k.is_plain()) {
            self.insert_plain(&text);
            return;
        }
        // Link's `linkOnPaste`: an address pasted over a selection links it.
        if self.has_selection() && kind.is_some_and(|k| k.is_rich()) {
            if let Some((0, len, href)) = crate::linkify::find(&text) {
                if len == text.len() {
                    self.set_link(&href);
                    return;
                }
            }
        }
        let pasted = Document::parse_body(&text);
        let nodes = pasted.nodes();
        let single_inline = pasted.blocks.len() == 1 && matches!(nodes.as_slice(), [Node::Paragraph { .. }]);
        let in_cell = self.leaf(self.head).is_some_and(|l| l.in_cell());
        if single_inline || in_cell {
            let mut inlines = match nodes.as_slice() {
                [Node::Paragraph { content, .. }] => content.clone(),
                _ => vec![Inline::text(text.trim().replace('\n', " "))],
            };
            // Spaces at the ends of a pasted phrase are part of it, though
            // Markdown would trim them from a paragraph.
            let line = text.trim_matches('\n');
            let lead = &line[..line.len() - line.trim_start_matches([' ', '\t']).len()];
            let trail = &line[line.trim_end_matches([' ', '\t']).len()..];
            if !lead.is_empty() && !line.trim().is_empty() {
                inlines.insert(0, Inline::text(lead));
            }
            if !trail.is_empty() && !line.trim().is_empty() {
                inlines.push(Inline::text(trail));
            }
            self.insert_inlines(normalize_inlines(inlines));
            return;
        }
        let top = self.leaf(self.head).is_some_and(|l| l.frames.is_empty());
        if top && pasted.blocks.iter().any(|b| b.is_opaque()) {
            self.insert_source_blocks(pasted.blocks);
            return;
        }
        self.insert_pasted_nodes(nodes);
    }

    pub(super) fn insert_plain(&mut self, text: &str) {
        let (from, to) = self.range();
        let text = text.to_string();
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            let at = if from != to { ed.delete_range_inner(from, to) } else { from };
            let mut u = ed.units(at.block, at.leaf);
            let off = at.offset.min(u.len());
            let n = text.chars().count();
            for (i, c) in text.chars().enumerate() {
                u.insert(off + i, Unit::Char(c, Marks::default()));
            }
            ed.set_units(at.block, at.leaf, &u);
            let path = ed.leaf(at).unwrap().path.clone();
            ed.put_caret(at.block, path, off + n);
        });
    }

    /// Inline content at the caret, keeping its marks.
    pub fn insert_inlines(&mut self, inlines: Vec<Inline>) {
        let (from, to) = self.range();
        self.break_undo();
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            let at = if from != to { ed.delete_range_inner(from, to) } else { from };
            ed.refresh_now();
            let at = ed.clamp(Pos { offset: at.offset, ..ed.head });
            if !ed.kind(at).is_some_and(|k| k.is_rich()) {
                return;
            }
            let mut u = ed.units(at.block, at.leaf);
            let off = at.offset.min(u.len());
            let add = flatten(&inlines);
            let n = add.len();
            u.splice(off..off, add);
            ed.set_units(at.block, at.leaf, &u);
            let path = ed.leaf(at).unwrap().path.clone();
            ed.put_caret(at.block, path, off + n);
        });
    }

    /// Several pasted blocks: the first paragraph joins the text before the
    /// caret, the last the text after it, the rest go between.
    fn insert_pasted_nodes(&mut self, mut nodes: Vec<Node>) {
        if nodes.is_empty() {
            return;
        }
        let (from, to) = self.range();
        self.break_undo();
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            let at = if from != to { ed.delete_range_inner(from, to) } else { from };
            ed.refresh_now();
            let at = ed.clamp(Pos { offset: at.offset, ..ed.head });
            let Some(leaf) = ed.leaf(at).cloned() else { return };
            if !leaf.kind.is_rich() {
                return;
            }
            let units = ed.units(at.block, at.leaf);
            let off = at.offset.min(units.len());
            let mut head = units[..off].to_vec();
            let tail = units[off..].to_vec();
            let first_para = matches!(nodes.first(), Some(Node::Paragraph { .. }));
            if first_para {
                if let Node::Paragraph { content, .. } = nodes.remove(0) {
                    head.extend(flatten(&content));
                }
            }
            let (c, i) = tree::split_path(&leaf.path);
            let c = c.to_vec();
            let Some(all) = ed.nodes_mut(at.block) else { return };
            let Some(cont) = tree::container_mut(all, &c) else { return };
            let current = cont[i].clone();
            cont[i] = match current {
                Node::Heading { level, align, .. } => Node::Heading { level, content: unflatten(&head), align },
                Node::Paragraph { align, .. } => Node::Paragraph { content: unflatten(&head), align },
                other => other,
            };
            let mut k = i + 1;
            let mut caret = (k - 1, head.len());
            let last_para = matches!(nodes.last(), Some(Node::Paragraph { .. }));
            let count = nodes.len();
            for (j, n) in nodes.into_iter().enumerate() {
                let n = if j + 1 == count && last_para {
                    if let Node::Paragraph { content, align } = n {
                        let mut u = flatten(&content);
                        caret = (k, u.len());
                        u.extend(tail.iter().cloned());
                        Node::Paragraph { content: unflatten(&u), align }
                    } else {
                        n
                    }
                } else {
                    caret = (k, usize::MAX / 2);
                    n
                };
                cont.insert(k, n);
                k += 1;
            }
            if !last_para && (!tail.is_empty() || count == 0) {
                cont.insert(k, Node::para(unflatten(&tail)));
                caret = (k, 0);
            }
            let mut p = c.clone();
            p.push(caret.0);
            ed.put_caret(at.block, p, caret.1);
        });
        let h = self.clamp(self.head);
        self.anchor = h;
        self.head = h;
    }

    /// Pasted Markdown with raw HTML in it, at the top level: whole blocks,
    /// the HTML kept as its source.
    fn insert_source_blocks(&mut self, blocks: Vec<Block>) {
        let (from, to) = self.range();
        self.break_undo();
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            let at = if from != to { ed.delete_range_inner(from, to) } else { from };
            ed.refresh_now();
            let at = ed.clamp(Pos { offset: at.offset, ..ed.head });
            let units = ed.units(at.block, at.leaf);
            let off = at.offset.min(units.len());
            let path = ed.leaf(at).map(|l| l.path.clone()).unwrap_or_default();
            // Split the caret's paragraph into two blocks.
            let mut insert_at = at.block + 1;
            if ed.kind(at).is_some_and(|k| k.is_rich()) && !units.is_empty() && off < units.len() {
                let tail = unflatten(&units[off..]);
                ed.set_units_path(at.block, &path, &units[..off]);
                ed.doc.blocks.insert(at.block + 1, super::new_block(vec![Node::para(tail)]));
            } else if units.is_empty() && ed.kind(at).is_some_and(|k| k.is_rich()) {
                ed.doc.blocks.remove(at.block);
                insert_at = at.block;
            }
            let n = blocks.len();
            for (k, b) in blocks.into_iter().enumerate() {
                let nb = match b.content {
                    BlockContent::Opaque(o) => Block { source: b.source, trailing: "\n\n".into(), content: BlockContent::Opaque(o), edited: false, origin: None },
                    BlockContent::Nodes(nodes) => super::new_block(nodes),
                };
                ed.doc.blocks.insert(insert_at + k, nb);
            }
            ed.put_caret(insert_at + n - 1, vec![0], usize::MAX / 2);
        });
        let h = self.clamp(self.head);
        self.anchor = h;
        self.head = h;
    }

    // ---- find ----

    /// Every match of `query` in the document's text, in order.
    pub fn find(&self, query: &str, case_sensitive: bool) -> Vec<FindMatch> {
        let q: Vec<char> = if case_sensitive { query.chars().collect() } else { query.chars().map(fold).collect() };
        let mut out = Vec::new();
        if q.is_empty() {
            return out;
        }
        for b in 0..self.block_count() {
            for l in 0..self.leaves_of(b).len() {
                if !self.leaves_of(b)[l].kind.has_text() {
                    continue;
                }
                let units = self.units(b, l);
                let chars: Vec<char> = units
                    .iter()
                    .map(|u| match u {
                        Unit::Char(c, _) => if case_sensitive { *c } else { fold(*c) },
                        Unit::Atom(_) => '\u{fffc}',
                    })
                    .collect();
                let mut i = 0;
                while i + q.len() <= chars.len() {
                    if chars[i..i + q.len()] == q[..] {
                        out.push(FindMatch { start: Pos::new(b, l, i), end: Pos::new(b, l, i + q.len()) });
                        i += q.len();
                    } else {
                        i += 1;
                    }
                }
            }
        }
        out
    }

    /// Replace one match with plain text (keeping the marks it had).
    pub fn replace_match(&mut self, m: FindMatch, with: &str) {
        self.set_selection(m.start, m.end);
        if with.is_empty() {
            self.delete_forward();
        } else {
            let marks = match self.units(m.start.block, m.start.leaf).get(m.start.offset) {
                Some(Unit::Char(_, mk)) => Some(mk.clone()),
                _ => None,
            };
            self.typing = marks;
            let typing = self.typing.clone();
            let (from, to) = self.range();
            let with = with.to_string();
            self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
                let at = ed.delete_range_inner(from, to);
                let mut u = ed.units(at.block, at.leaf);
                let m = typing.unwrap_or_default();
                for (i, c) in with.chars().enumerate() {
                    u.insert(at.offset + i, Unit::Char(c, m.clone()));
                }
                ed.set_units(at.block, at.leaf, &u);
                let path = ed.leaf(at).unwrap().path.clone();
                ed.put_caret(at.block, path, at.offset + with.chars().count());
            });
        }
    }

    /// Replace every match, as one undo step per leaf; returns the count.
    pub fn replace_all(&mut self, query: &str, with: &str, case_sensitive: bool) -> usize {
        let matches = self.find(query, case_sensitive);
        for m in matches.iter().rev() {
            self.replace_match(*m, with);
        }
        matches.len()
    }

    // ---- outline ----

    pub fn outline(&self) -> Vec<OutlineEntry> {
        let mut out = Vec::new();
        for b in 0..self.block_count() {
            for (l, leaf) in self.leaves_of(b).iter().enumerate() {
                if let LeafKind::Heading(level) = leaf.kind {
                    let text = tree::units_text(&self.units(b, l));
                    out.push(OutlineEntry { block: b, leaf: l, level, text: text.trim().to_string() });
                }
            }
        }
        out
    }
}

fn wrap_frames(mut n: Node, frames: &[super::Frame]) -> Node {
    for f in frames.iter().rev() {
        n = match f {
            super::Frame::Quote => Node::Blockquote(vec![n]),
            super::Frame::Item { list, .. } => super::format::make_list(*list, true, 1, vec![(None, vec![n])]),
            super::Frame::Cell { .. } => n,
        };
    }
    n
}

fn same_kind_list(a: &Node, b: &Node) -> bool {
    tree::list_kind(a).is_some() && tree::list_kind(a) == tree::list_kind(b)
}

/// Case folding that keeps one char per char, so offsets line up.
fn fold(c: char) -> char {
    let mut l = c.to_lowercase();
    match (l.next(), l.next()) {
        (Some(x), None) => x,
        _ => c,
    }
}
