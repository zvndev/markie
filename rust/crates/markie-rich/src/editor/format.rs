//! Marks, block styles, lists, alignment and inserts: what the formatting
//! toolbar (`formatting-toolbar.tsx`) and `rich-keymap.ts` reach.

use super::tree::{self, Frame, ListKind};
use super::{EditKind, Editor, LeafKind, Pos};
use crate::edit::Unit;
use crate::model::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkKind {
    Bold,
    Italic,
    Strike,
    Underline,
    Code,
}

fn get(m: &Marks, k: MarkKind) -> bool {
    match k {
        MarkKind::Bold => m.bold,
        MarkKind::Italic => m.italic,
        MarkKind::Strike => m.strike,
        MarkKind::Underline => m.underline,
        MarkKind::Code => m.code,
    }
}

fn set(m: &mut Marks, k: MarkKind, on: bool) {
    match k {
        MarkKind::Bold => m.bold = on,
        MarkKind::Italic => m.italic = on,
        MarkKind::Strike => m.strike = on,
        MarkKind::Underline => m.underline = on,
        MarkKind::Code => {
            m.code = on;
            if on {
                // Code excludes every other mark (TipTap's `excludes: "_"`).
                *m = Marks { code: true, ..Marks::default() };
            }
        }
    }
}

/// The block styles of the toolbar's style menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockStyle {
    Paragraph,
    Heading(u8),
    Quote,
    Code,
}

/// What the toolbar shows for the caret or selection.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Toolbar {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub underline: bool,
    pub code: bool,
    pub link: Option<String>,
    pub highlight: Option<Option<String>>,
    pub color: Option<String>,
    pub font_family: Option<String>,
    pub font_size: Option<String>,
    pub style: Option<BlockStyle>,
    pub list: Option<ListKind>,
    pub align: Option<String>,
    pub in_table: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}

impl Editor {
    /// Every text leaf the selection touches, with its unit range.
    pub fn selected_spans(&self) -> Vec<(Pos, usize, usize)> {
        let (from, to) = self.range();
        let mut out = Vec::new();
        let mut p = Some(Pos { offset: 0, ..from });
        while let Some(x) = p {
            if (x.block, x.leaf) > (to.block, to.leaf) {
                break;
            }
            let len = self.leaf_len(x.block, x.leaf);
            let a = if (x.block, x.leaf) == (from.block, from.leaf) { from.offset } else { 0 };
            let b = if (x.block, x.leaf) == (to.block, to.leaf) { to.offset } else { len };
            out.push((x, a.min(len), b.min(len)));
            p = self.next_leaf(x);
        }
        out
    }

    /// Change the marks of every selected character with `f`; with nothing
    /// selected, change the marks typing will use.
    fn map_marks(&mut self, f: impl Fn(&mut Marks)) {
        if !self.has_selection() {
            let p = self.head;
            let units = self.units(p.block, p.leaf);
            let mut m = self.typing.clone().unwrap_or_else(|| super::ops::marks_before(&units, p.offset));
            f(&mut m);
            self.typing = Some(m);
            self.sel_version += 1;
            return;
        }
        let spans = self.selected_spans();
        let (from, to) = self.range();
        let (anchor, head) = (self.anchor, self.head);
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            for (p, a, b) in &spans {
                if !ed.kind(*p).is_some_and(|k| k.is_rich()) || a == b {
                    continue;
                }
                let mut u = ed.units(p.block, p.leaf);
                for x in &mut u[*a..*b] {
                    if let Unit::Char(_, m) = x {
                        f(m);
                    }
                }
                ed.set_units(p.block, p.leaf, &u);
            }
            let path = |p: Pos| (p.block, ed.leaf(p).map(|l| l.path.clone()).unwrap_or_default(), p.offset);
            let (a, h) = (path(anchor), path(head));
            ed.put_selection(a, h);
        });
    }

    fn selected_chars_all(&self, pred: impl Fn(&Marks) -> bool) -> bool {
        let mut any = false;
        for (p, a, b) in self.selected_spans() {
            if !self.kind(p).is_some_and(|k| k.is_rich()) {
                continue;
            }
            for u in &self.units(p.block, p.leaf)[a..b] {
                if let Unit::Char(_, m) = u {
                    any = true;
                    if !pred(m) {
                        return false;
                    }
                }
            }
        }
        any
    }

    pub fn toggle_mark(&mut self, k: MarkKind) {
        let on = if self.has_selection() {
            !self.selected_chars_all(|m| get(m, k))
        } else {
            !get(&self.marks_at_caret(), k)
        };
        self.map_marks(|m| {
            if m.code && k != MarkKind::Code && on {
                return; // code text takes no other mark
            }
            set(m, k, on)
        });
    }

    /// The marks the caret would type with.
    pub fn marks_at_caret(&self) -> Marks {
        if let Some(t) = &self.typing {
            return t.clone();
        }
        let p = self.head;
        let units = self.units(p.block, p.leaf);
        match p.offset.checked_sub(1).and_then(|i| units.get(i)) {
            Some(Unit::Char(_, m)) => m.clone(),
            _ => match units.get(p.offset) {
                Some(Unit::Char(_, m)) => m.clone(),
                _ => Marks::default(),
            },
        }
    }

    /// ⌘⇧H: highlight on or off (no colour).
    pub fn toggle_highlight(&mut self) {
        let on = if self.has_selection() {
            !self.selected_chars_all(|m| m.highlight.is_some())
        } else {
            self.marks_at_caret().highlight.is_none()
        };
        self.set_highlight(on.then(|| None));
    }

    /// Set (Some(colour or None)) or remove (None) the highlight.
    pub fn set_highlight(&mut self, h: Option<Option<String>>) {
        self.map_marks(|m| {
            if m.code {
                return;
            }
            // No colour is the empty string, as `<mark>` reads back.
            m.highlight = h.clone().map(|color| Highlight { color: Some(color.unwrap_or_default()) });
        });
    }

    /// Set one attribute of the text style; None removes it. The mark goes
    /// when nothing is left in it (TipTap's removeEmptyTextStyle).
    pub fn set_text_style(&mut self, color: Option<Option<String>>, family: Option<Option<String>>, size: Option<Option<String>>) {
        self.map_marks(|m| {
            if m.code {
                return;
            }
            // Unset attributes are the empty string, as a reload reads the
            // span back (TipTap's own toolbar leaves them null until then).
            let mut t = m.text_style.clone().unwrap_or(TextStyle {
                color: Some(String::new()),
                font_family: Some(String::new()),
                font_size: Some(String::new()),
            });
            if let Some(c) = &color {
                t.color = Some(c.clone().unwrap_or_default());
            }
            if let Some(f) = &family {
                t.font_family = Some(f.clone().unwrap_or_default());
            }
            if let Some(s) = &size {
                t.font_size = Some(s.clone().unwrap_or_default());
            }
            m.text_style = if t.is_empty() { None } else { Some(t) };
        });
    }

    /// The range of the link around the caret, if any.
    pub fn link_range(&self, p: Pos) -> Option<(usize, usize, Link)> {
        let units = self.units(p.block, p.leaf);
        let link_at = |i: usize| match units.get(i) {
            Some(Unit::Char(_, m)) => m.link.clone(),
            _ => None,
        };
        let l = link_at(p.offset).or_else(|| p.offset.checked_sub(1).and_then(link_at))?;
        let mut a = p.offset.min(units.len());
        while a > 0 && link_at(a - 1).as_ref() == Some(&l) {
            a -= 1;
        }
        let mut b = p.offset;
        while b < units.len() && link_at(b).as_ref() == Some(&l) {
            b += 1;
        }
        Some((a, b, l))
    }

    /// ⌘⇧K's result: an address links the selection (or the link around
    /// the caret); the empty string removes the link. With nothing selected
    /// and no link here, the address goes in as linked text.
    pub fn set_link(&mut self, href: &str) {
        let href = href.trim().to_string();
        if !self.has_selection() {
            if let Some((a, b, _)) = self.link_range(self.head) {
                let p = self.head;
                self.set_selection(Pos { offset: a, ..p }, Pos { offset: b, ..p });
            } else if href.is_empty() {
                return;
            } else {
                let p = self.head;
                if !self.kind(p).is_some_and(|k| k.is_rich()) {
                    return;
                }
                let link = Link { href: href.clone(), title: None, style: LinkStyle::Inline };
                self.typing = Some(Marks { link: Some(link), ..super::ops::marks_before(&self.units(p.block, p.leaf), p.offset) });
                let typing = self.typing.clone();
                self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
                    let mut u = ed.units(p.block, p.leaf);
                    let m = typing.unwrap();
                    for (i, c) in href.chars().enumerate() {
                        u.insert(p.offset + i, Unit::Char(c, m.clone()));
                    }
                    ed.set_units(p.block, p.leaf, &u);
                    let path = ed.leaf(p).unwrap().path.clone();
                    ed.put_caret(p.block, path, p.offset + href.chars().count());
                });
                return;
            }
        }
        let link = (!href.is_empty()).then(|| Link { href, title: None, style: LinkStyle::Inline });
        self.map_marks(|m| {
            if !m.code {
                m.link = link.clone();
            }
        });
    }

    /// ⌘\: unsetAllMarks, then clearNodes (headings and code become
    /// paragraphs, lists and quotes are lifted).
    pub fn clear_formatting(&mut self) {
        if self.has_selection() {
            self.map_marks(|m| *m = Marks::default());
        } else {
            self.typing = Some(Marks::default());
        }
        if self.leaf(self.head).is_some_and(|l| l.frames.iter().any(|f| matches!(f, Frame::Item { .. }))) {
            if let Some(k) = self.toolbar().list {
                self.toggle_list(k);
            }
        }
        if self.leaf(self.head).is_some_and(|l| matches!(l.frames.last(), Some(Frame::Quote))) {
            self.set_block_style(BlockStyle::Quote);
        }
        self.set_block_style(BlockStyle::Paragraph);
    }

    /// The caret's or selection's state, for the toolbar.
    pub fn toolbar(&self) -> Toolbar {
        let m = if self.has_selection() {
            // A mark is on when every selected character has it.
            let all = |f: &dyn Fn(&Marks) -> bool| self.selected_chars_all(|m| f(m));
            let mut first = Marks::default();
            if let Some((p, a, b)) = self.selected_spans().into_iter().find(|(p, a, b)| a < b && self.kind(*p).is_some_and(|k| k.is_rich())) {
                if let Some(Unit::Char(_, m)) = self.units(p.block, p.leaf).get(a.min(b)) {
                    first = m.clone();
                }
            }
            Marks {
                bold: all(&|m| m.bold),
                italic: all(&|m| m.italic),
                strike: all(&|m| m.strike),
                underline: all(&|m| m.underline),
                code: all(&|m| m.code),
                link: first.link.clone().filter(|l| all(&|m| m.link.as_ref() == Some(l))),
                highlight: first.highlight.clone().filter(|h| all(&|m| m.highlight.as_ref() == Some(h))),
                text_style: first.text_style.clone(),
            }
        } else {
            self.marks_at_caret()
        };
        let leaf = self.leaf(self.head);
        let style = match self.kind(self.head) {
            _ if leaf.is_some_and(|l| matches!(l.frames.last(), Some(Frame::Quote))) => Some(BlockStyle::Quote),
            Some(LeafKind::Paragraph) => Some(BlockStyle::Paragraph),
            Some(LeafKind::Heading(n)) => Some(BlockStyle::Heading(n)),
            Some(LeafKind::Code) => Some(BlockStyle::Code),
            _ => None,
        };
        let list = leaf.and_then(|l| {
            l.frames.iter().rev().find_map(|f| match f {
                Frame::Item { list, .. } => Some(*list),
                _ => None,
            })
        });
        let align = match self.leaf_node(self.head) {
            Some(Node::Paragraph { align, .. }) | Some(Node::Heading { align, .. }) => align.clone(),
            _ => None,
        };
        let ts = m.text_style.clone().unwrap_or_default();
        Toolbar {
            bold: m.bold,
            italic: m.italic,
            strike: m.strike,
            underline: m.underline,
            code: m.code,
            link: m.link.map(|l| l.href),
            highlight: m.highlight.map(|h| h.color.filter(|c| !c.is_empty())),
            color: ts.color.filter(|c| !c.is_empty()),
            font_family: ts.font_family.filter(|c| !c.is_empty()),
            font_size: ts.font_size.filter(|c| !c.is_empty()),
            style,
            list,
            align,
            in_table: leaf.is_some_and(|l| l.in_cell()),
            can_undo: self.can_undo(),
            can_redo: self.can_redo(),
        }
    }

    /// Leaves the selection covers, by (block, path), first to last.
    fn selected_leaf_paths(&self) -> Vec<(usize, Vec<usize>, LeafKind)> {
        self.selected_spans()
            .into_iter()
            .filter_map(|(p, _, _)| self.leaf(p).map(|l| (p.block, l.path.clone(), l.kind)))
            .collect()
    }

    fn keep_selection_paths(&self) -> ((usize, Vec<usize>, usize), (usize, Vec<usize>, usize)) {
        let path = |p: Pos| (p.block, self.leaf(p).map(|l| l.path.clone()).unwrap_or_default(), p.offset);
        (path(self.anchor), path(self.head))
    }

    /// A leaf that Markdown can only hold as a paragraph: a table cell's,
    /// or the first block of a list item (`paragraph block*` in TipTap's
    /// schema; `- # x` and `- [ ] ```` do not read back).
    pub fn must_stay_paragraph(&self, block: usize, path: &[usize]) -> bool {
        let Some(leaf) = self.leaves_of(block).iter().find(|l| l.path == path) else { return false };
        leaf.in_cell() || (matches!(leaf.frames.last(), Some(Frame::Item { .. })) && path.last() == Some(&0))
    }

    /// textAlign on every selected paragraph and heading.
    pub fn set_align(&mut self, align: Option<&str>) {
        let (from, to) = self.range();
        let leaves = self.selected_leaf_paths();
        let sel = self.keep_selection_paths();
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            for (b, path, kind) in &leaves {
                // Cells and list items cannot carry the HTML an alignment needs.
                if !kind.is_rich() || ed.leaf_frames(*b, path).iter().any(|f| !matches!(f, Frame::Quote)) {
                    continue;
                }
                if let Some(n) = ed.nodes_mut(*b).and_then(|n| tree::node_at_mut(n, path)) {
                    if let Node::Paragraph { align: a, .. } | Node::Heading { align: a, .. } = n {
                        *a = align.map(|s| s.to_string());
                    }
                }
            }
            ed.put_selection(sel.0.clone(), sel.1.clone());
        });
    }

    /// The style menu and ⌘⌥ shortcuts: paragraph, heading, quote, code.
    pub fn set_block_style(&mut self, style: BlockStyle) {
        let (from, to) = self.range();
        let leaves = self.selected_leaf_paths();
        let sel = self.keep_selection_paths();
        if style == BlockStyle::Quote {
            self.toggle_quote();
            return;
        }
        // Toggling a heading level that is already set goes back to text.
        let current = self.toolbar().style;
        let style = if current == Some(style) && matches!(style, BlockStyle::Heading(_) | BlockStyle::Code) {
            BlockStyle::Paragraph
        } else {
            style
        };
        let blocked: Vec<bool> = leaves.iter().map(|(b, path, _)| self.must_stay_paragraph(*b, path)).collect();
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            for ((b, path, kind), blocked) in leaves.iter().zip(&blocked) {
                if !matches!(kind, LeafKind::Paragraph | LeafKind::Heading(_) | LeafKind::Code) {
                    continue;
                }
                if *blocked && style != BlockStyle::Paragraph {
                    continue;
                }
                let Some(nodes) = ed.nodes_mut(*b) else { continue };
                let Some(n) = tree::node_at_mut(nodes, path) else { continue };
                *n = convert_text_block(n.clone(), style);
            }
            ed.put_selection(sel.0.clone(), sel.1.clone());
        });
    }

    pub(crate) fn leaf_frames(&self, block: usize, path: &[usize]) -> Vec<Frame> {
        self.leaves_of(block).iter().find(|l| l.path == path).map(|l| l.frames.clone()).unwrap_or_default()
    }

    /// Wrap the caret's block in a quote, or lift it out of one.
    pub fn toggle_quote(&mut self) {
        let p = self.head;
        let Some(leaf) = self.leaf(p).cloned() else { return };
        if leaf.in_cell() {
            return;
        }
        if !matches!(leaf.frames.last(), Some(Frame::Quote)) && self.must_stay_paragraph(p.block, &leaf.path) {
            return;
        }
        let (from, to) = self.range();
        if matches!(leaf.frames.last(), Some(Frame::Quote)) {
            self.transact(p.block..p.block + 1, EditKind::Other, |ed| ed.unwrap_quote_at(p.block, &leaf.path));
            return;
        }
        // The top-level nodes the selection covers, wrapped together when
        // they share the block; otherwise the caret's own node.
        if from.block == to.block {
            let fl = self.leaf(from).unwrap().path.clone();
            let tl = self.leaf(to).unwrap().path.clone();
            let (c, i) = tree::split_path(&leaf.path);
            let c = c.to_vec();
            let same_container = fl.len() == leaf.path.len() && tl.len() == leaf.path.len() && fl[..c.len()] == c[..] && tl[..c.len()] == c[..];
            let (i0, i1) = if same_container { (fl[c.len()], tl[c.len()]) } else { (i, i) };
            let offset = p.offset;
            self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
                let Some(nodes) = ed.nodes_mut(p.block) else { return };
                let Some(cont) = tree::container_mut(nodes, &c) else { return };
                let wrapped: Vec<Node> = cont.drain(i0..=i1).collect();
                cont.insert(i0, Node::Blockquote(wrapped));
                let mut path = c.clone();
                path.push(i0);
                path.push(i - i0);
                path.extend_from_slice(&leaf.path[c.len() + 1..]);
                ed.put_caret(p.block, path, offset);
            });
        }
    }

    /// Replace the quote holding the node at `path` with its children.
    pub(crate) fn unwrap_quote_at(&mut self, block: usize, path: &[usize]) {
        let (qc, qi) = tree::split_path(path);
        let (outer, quote_i) = tree::split_path(qc);
        let outer = outer.to_vec();
        let offset_in = qi;
        let rest = path[qc.len() + 1..].to_vec();
        let caret_off = self.head.offset;
        let Some(nodes) = self.nodes_mut(block) else { return };
        let Some(cont) = tree::container_mut(nodes, &outer) else { return };
        let Node::Blockquote(children) = cont.remove(quote_i) else { return };
        let n = children.len();
        for (k, c) in children.into_iter().enumerate() {
            cont.insert(quote_i + k, c);
        }
        let _ = n;
        let mut p = outer;
        p.push(quote_i + offset_in);
        p.extend(rest);
        self.put_caret(block, p, caret_off);
    }

    /// Enter on an empty last paragraph of a quote: move it out after it.
    pub(crate) fn lift_out_of_quote(&mut self, block: usize, path: &[usize]) {
        let (qc, qi) = tree::split_path(path);
        let (outer, quote_i) = tree::split_path(qc);
        let outer = outer.to_vec();
        let Some(nodes) = self.nodes_mut(block) else { return };
        let Some(cont) = tree::container_mut(nodes, &outer) else { return };
        let Node::Blockquote(children) = &mut cont[quote_i] else { return };
        let node = children.remove(qi);
        let empty = children.is_empty();
        let at = if empty {
            cont[quote_i] = node;
            quote_i
        } else {
            cont.insert(quote_i + 1, node);
            quote_i + 1
        };
        let mut p = outer;
        p.push(at);
        self.put_caret(block, p, 0);
    }

    // ---- lists ----

    /// ⌘⇧8 / ⌘⇧7 / ⌘⇧9: wrap in a list of that kind, change the list's
    /// kind, or lift the items out when it is already that kind.
    pub fn toggle_list(&mut self, kind: ListKind) {
        let p = self.head;
        let Some(leaf) = self.leaf(p).cloned() else { return };
        if leaf.in_cell() || !matches!(leaf.kind, LeafKind::Paragraph | LeafKind::Heading(_) | LeafKind::Code) {
            return;
        }
        let offset = p.offset;
        // In a list: the innermost list holding the caret.
        if let Some(depth) = leaf.frames.iter().rposition(|f| matches!(f, Frame::Item { .. })) {
            let Frame::Item { list, .. } = leaf.frames[depth] else { unreachable!() };
            let anc = {
                let nodes = self.doc.blocks[p.block].nodes().to_vec();
                tree::ancestors(&nodes, &leaf.path)
            };
            // The ancestor entry for that list: frames and ancestors line up
            // one to one (a table adds one frame per cell, one ancestor).
            let Some((lc, li)) = anc.get(depth).cloned() else { return };
            if list == kind {
                // Lift every item of this list out of it.
                self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
                    let Some(nodes) = ed.nodes_mut(p.block) else { return };
                    let Some(cont) = tree::container_mut(nodes, &lc) else { return };
                    let items = take_items(&mut cont[li]);
                    cont.remove(li);
                    let item_i = leaf.path[lc.len() + 1];
                    let node_i = leaf.path[lc.len() + 2];
                    let mut at = li;
                    let mut caret_at = li;
                    for (k, (_, content)) in items.into_iter().enumerate() {
                        if k == item_i {
                            caret_at = at + node_i;
                        }
                        let content = if content.is_empty() { vec![Node::para(vec![])] } else { content };
                        for n in content {
                            cont.insert(at, n);
                            at += 1;
                        }
                    }
                    let mut path = lc.clone();
                    path.push(caret_at);
                    path.extend_from_slice(&leaf.path[lc.len() + 3..]);
                    ed.put_caret(p.block, path, offset);
                });
            } else {
                self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
                    let Some(nodes) = ed.nodes_mut(p.block) else { return };
                    let Some(cont) = tree::container_mut(nodes, &lc) else { return };
                    let tight = list_tight(&cont[li]);
                    let items = take_items(&mut cont[li]);
                    cont[li] = make_list(kind, tight, 1, items);
                    ed.put_caret(p.block, leaf.path.clone(), offset);
                });
            }
            return;
        }
        // Not in a list: wrap the caret's node (or the selected siblings).
        let (from, to) = self.range();
        let (c, i) = tree::split_path(&leaf.path);
        let c = c.to_vec();
        let (i0, i1) = if from.block == to.block {
            let fl = self.leaf(from).map(|l| l.path.clone()).unwrap_or_default();
            let tl = self.leaf(to).map(|l| l.path.clone()).unwrap_or_default();
            if fl.len() == leaf.path.len() && tl.len() == leaf.path.len() && fl[..c.len()] == c[..] && tl[..c.len()] == c[..] {
                (fl[c.len()], tl[c.len()])
            } else {
                (i, i)
            }
        } else {
            (i, i)
        };
        let top = c.is_empty();
        let range = if top { p.block.saturating_sub(1)..(p.block + 2).min(self.block_count()) } else { p.block..p.block + 1 };
        let block = p.block;
        self.transact(range, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(block) else { return };
            let Some(cont) = tree::container_mut(nodes, &c) else { return };
            let wrapped: Vec<(Option<bool>, Vec<Node>)> = cont.drain(i0..=i1).map(|n| (None, vec![to_list_text(n)])).collect();
            cont.insert(i0, make_list(kind, true, 1, wrapped));
            let mut caret_path = c.clone();
            caret_path.extend([i0, i - i0, 0]);
            // Join a list of the same kind right before or after it.
            let mut list_i = i0;
            if list_i + 1 < cont.len() && tree::list_kind(&cont[list_i + 1]) == Some(kind) {
                let mut next = take_items(&mut cont[list_i + 1]);
                cont.remove(list_i + 1);
                let mut mine = take_items(&mut cont[list_i]);
                mine.append(&mut next);
                let tight = list_tight(&cont[list_i]);
                let start = list_start(&cont[list_i]);
                cont[list_i] = make_list(kind, tight, start, mine);
            }
            if list_i > 0 && tree::list_kind(&cont[list_i - 1]) == Some(kind) {
                let mine = take_items(&mut cont[list_i]);
                cont.remove(list_i);
                list_i -= 1;
                let prev_len = list_len(&cont[list_i]);
                let mut items = take_items(&mut cont[list_i]);
                items.extend(mine);
                let tight = list_tight(&cont[list_i]);
                let start = list_start(&cont[list_i]);
                cont[list_i] = make_list(kind, tight, start, items);
                caret_path = c.clone();
                caret_path.extend([list_i, prev_len + (i - i0), 0]);
            }
            ed.put_caret(block, caret_path.clone(), offset);
            if top {
                ed.join_neighbour_lists(block, &mut caret_path, offset);
            }
        });
    }

    /// A top-level list next to a block that ends or starts with a list of
    /// the same kind: join them, as TipTap's toggleList does.
    fn join_neighbour_lists(&mut self, block: usize, caret: &mut Vec<usize>, offset: usize) {
        let list_i = caret[0];
        let kind = tree::list_kind(&self.doc.blocks[block].nodes()[list_i]);
        // With the block after.
        if list_i + 1 == self.doc.blocks[block].nodes().len() && block + 1 < self.block_count() {
            let next_first = self.doc.blocks[block + 1].nodes().first().and_then(tree::list_kind);
            if next_first.is_some() && next_first == kind {
                let mut next_nodes = self.doc.blocks[block + 1].nodes().to_vec();
                let first = next_nodes.remove(0);
                let mut first = first;
                let extra = take_items(&mut first);
                let nodes = self.nodes_mut(block).unwrap();
                let tight = list_tight(&nodes[list_i]);
                let start = list_start(&nodes[list_i]);
                let mut items = take_items(&mut nodes[list_i]);
                items.extend(extra);
                nodes[list_i] = make_list(kind.unwrap(), tight, start, items);
                if next_nodes.is_empty() {
                    self.doc.blocks.remove(block + 1);
                } else {
                    self.doc.set_nodes(block + 1, next_nodes);
                }
            }
        }
        // With the block before.
        if list_i == 0 && block > 0 {
            let prev_last = self.doc.blocks[block - 1].nodes().last().and_then(tree::list_kind);
            if prev_last.is_some() && prev_last == kind {
                let mut mine_nodes = self.doc.blocks[block].nodes().to_vec();
                let mut mine = mine_nodes.remove(0);
                let items_mine = take_items(&mut mine);
                let prev = self.nodes_mut(block - 1).unwrap();
                let last = prev.len() - 1;
                let prev_len = list_len(&prev[last]);
                let tight = list_tight(&prev[last]);
                let start = list_start(&prev[last]);
                let mut items = take_items(&mut prev[last]);
                items.extend(items_mine);
                prev[last] = make_list(kind.unwrap(), tight, start, items);
                // The rest of this block moves to the previous one.
                prev.extend(mine_nodes);
                self.doc.blocks.remove(block);
                let mut path = vec![last, prev_len + caret[1]];
                path.extend_from_slice(&caret[2..]);
                self.put_caret(block - 1, path, offset);
            }
        }
    }

    /// Tab in a list item: make it a child of the item before it.
    pub fn indent(&mut self) {
        let p = self.head;
        let Some(leaf) = self.leaf(p).cloned() else { return };
        if leaf.in_cell() {
            self.move_cell(true);
            return;
        }
        let Some(depth) = leaf.frames.iter().rposition(|f| matches!(f, Frame::Item { .. })) else {
            if leaf.kind == LeafKind::Code {
                self.insert_text("  ");
            }
            return;
        };
        let anc = tree::ancestors(&self.doc.blocks[p.block].nodes().to_vec(), &leaf.path);
        let Some((lc, li)) = anc.get(depth).cloned() else { return };
        let item_i = leaf.path[lc.len() + 1];
        if item_i == 0 {
            return;
        }
        let offset = p.offset;
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(p.block) else { return };
            let Some(cont) = tree::container_mut(nodes, &lc) else { return };
            let kind = tree::list_kind(&cont[li]).unwrap();
            let tight = list_tight(&cont[li]);
            let mut items = take_items(&mut cont[li]);
            let (checked, item) = items.remove(item_i);
            let prev = &mut items[item_i - 1].1;
            let sub_i;
            let sub_item_i;
            match prev.last_mut() {
                Some(last) if tree::list_kind(last) == Some(kind) => {
                    let mut sub = take_items(last);
                    sub_item_i = sub.len();
                    sub.push((checked, item));
                    let st = list_start(last);
                    let tt = list_tight(last);
                    *last = make_list(kind, tt, st, sub);
                    sub_i = prev.len() - 1;
                }
                _ => {
                    prev.push(make_list(kind, tight, 1, vec![(checked, item)]));
                    sub_i = prev.len() - 1;
                    sub_item_i = 0;
                }
            }
            let start = 1;
            let orig_start = match &cont[li] {
                Node::OrderedList { start, .. } => *start,
                _ => start,
            };
            cont[li] = make_list(kind, tight, orig_start, items);
            let mut path = lc.clone();
            path.extend([li, item_i - 1, sub_i, sub_item_i]);
            path.extend_from_slice(&leaf.path[lc.len() + 2..]);
            ed.put_caret(p.block, path, offset);
        });
    }

    /// Shift-Tab in a list item: lift it one level.
    pub fn outdent(&mut self) {
        let p = self.head;
        let Some(leaf) = self.leaf(p).cloned() else { return };
        if leaf.in_cell() {
            self.move_cell(false);
            return;
        }
        if !leaf.frames.iter().any(|f| matches!(f, Frame::Item { .. })) {
            return;
        }
        // The caret's own leaf path, at the item's first node.
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| ed.lift_item_at(p.block, &leaf.path));
    }

    /// Lift the list item holding `path` one level: into the parent list,
    /// or out of the list altogether when it is not nested.
    pub(crate) fn lift_item_at(&mut self, block: usize, path: &[usize]) {
        let offset = self.head.offset;
        let nodes_now = self.doc.blocks[block].nodes().to_vec();
        let anc = tree::ancestors(&nodes_now, path);
        // The innermost list on the way.
        let Some(k) = anc.iter().rposition(|(c, i)| {
            tree::container_of(&nodes_now, c).and_then(|c| c.get(*i)).and_then(tree::list_kind).is_some()
        }) else {
            return;
        };
        let (lc, li) = anc[k].clone();
        let item_i = path[lc.len() + 1];
        let rest_path = path[lc.len() + 2..].to_vec();
        // Is this list itself inside a list item?
        let parent = (0..k).rev().find(|j| {
            let (c, i) = &anc[*j];
            tree::container_of(&nodes_now, c).and_then(|c| c.get(*i)).and_then(tree::list_kind).is_some()
        });
        let nested = parent.is_some_and(|j| j + 1 == k || anc[j + 1..k].is_empty());
        let Some(nodes) = self.nodes_mut(block) else { return };
        if nested && lc.len() >= 2 {
            let j = parent.unwrap();
            let (pc, pi) = anc[j].clone();
            let parent_item = lc[pc.len() + 1];
            let Some(pcont) = tree::container_mut(nodes, &pc) else { return };
            let pkind = tree::list_kind(&pcont[pi]).unwrap();
            let ptight = list_tight(&pcont[pi]);
            let pstart = list_start(&pcont[pi]);
            let mut pitems = take_items(&mut pcont[pi]);
            // The sub-list inside the parent item.
            let sub_index = li;
            let sub = &mut pitems[parent_item].1[sub_index];
            let skind = tree::list_kind(sub).unwrap();
            let stight = list_tight(sub);
            let sstart = list_start(sub);
            let mut sitems = take_items(sub);
            let after: Vec<_> = sitems.split_off(item_i + 1);
            let (checked, mut lifted) = sitems.pop().unwrap();
            if !after.is_empty() {
                lifted.push(make_list(skind, stight, 1, after));
            }
            if sitems.is_empty() {
                pitems[parent_item].1.remove(sub_index);
            } else {
                pitems[parent_item].1[sub_index] = make_list(skind, stight, sstart, sitems);
            }
            let checked = if pkind == ListKind::Task { Some(checked.unwrap_or(false)) } else { None };
            pitems.insert(parent_item + 1, (checked, lifted));
            pcont[pi] = make_list(pkind, ptight, pstart, pitems);
            let mut p = pc.clone();
            p.extend([pi, parent_item + 1]);
            p.extend(rest_path);
            self.put_caret(block, p, offset);
        } else {
            let Some(cont) = tree::container_mut(nodes, &lc) else { return };
            let kind = tree::list_kind(&cont[li]).unwrap();
            let tight = list_tight(&cont[li]);
            let start = list_start(&cont[li]);
            let mut items = take_items(&mut cont[li]);
            let after: Vec<_> = items.split_off(item_i + 1);
            let (_, content) = items.pop().unwrap();
            let content = if content.is_empty() { vec![Node::para(vec![])] } else { content };
            cont.remove(li);
            let mut at = li;
            if !items.is_empty() {
                let n = items.len() as u64;
                cont.insert(at, make_list(kind, tight, start, items));
                at += 1;
                let _ = n;
            }
            let first = at;
            let count = content.len();
            for (k, n) in content.into_iter().enumerate() {
                cont.insert(first + k, n);
            }
            if !after.is_empty() {
                let next_start = start + item_i as u64 + 1;
                cont.insert(first + count, make_list(kind, tight, next_start, after));
            }
            let mut p = lc.clone();
            p.push(first + rest_path.first().copied().unwrap_or(0));
            p.extend_from_slice(rest_path.get(1..).unwrap_or(&[]));
            self.put_caret(block, p, offset);
        }
    }

    /// Check or uncheck the task item holding `path` (a click on its box).
    pub fn toggle_task(&mut self, block: usize, item_path: &[usize]) {
        let (lc, item_i) = tree::split_path(item_path);
        let (c, li) = tree::split_path(lc);
        let c = c.to_vec();
        let sel = self.keep_selection_paths();
        self.transact(block..block + 1, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(block) else { return };
            if let Some(Node::TaskList { items }) = tree::container_mut(nodes, &c).and_then(|c| c.get_mut(li)) {
                if let Some(it) = items.get_mut(item_i) {
                    it.checked = !it.checked;
                }
            }
            ed.put_selection(sel.0.clone(), sel.1.clone());
        });
    }

    // ---- tables ----

    /// Tab and Shift-Tab in a table: the next or previous cell; Tab in the
    /// last cell adds a row.
    pub fn move_cell(&mut self, forward: bool) {
        let p = self.head;
        let Some(leaf) = self.leaf(p).cloned() else { return };
        let cells: Vec<usize> = (0..self.leaves_of(p.block).len())
            .filter(|i| {
                let l = &self.leaves_of(p.block)[*i];
                l.in_cell() && l.path[..leaf.path.len().min(l.path.len()).saturating_sub(3)] == leaf.path[..leaf.path.len().saturating_sub(3)]
            })
            .collect();
        let Some(k) = cells.iter().position(|i| *i == p.leaf) else { return };
        if forward && k + 1 == cells.len() {
            self.add_table_row();
            return;
        }
        let next = if forward { cells.get(k + 1) } else { k.checked_sub(1).and_then(|k| cells.get(k)) };
        if let Some(n) = next {
            let len = self.leaf_len(p.block, *n);
            self.set_selection(Pos::new(p.block, *n, 0), Pos::new(p.block, *n, len));
        }
    }

    /// A row after the caret's row.
    pub fn add_table_row(&mut self) {
        let p = self.head;
        let Some(leaf) = self.leaf(p).cloned() else { return };
        let Some(pos) = leaf.frames.iter().rposition(|f| matches!(f, Frame::Cell { .. })) else { return };
        let anc = tree::ancestors(&self.doc.blocks[p.block].nodes().to_vec(), &leaf.path);
        let Some((tc, ti)) = anc.get(pos).cloned() else { return };
        let Frame::Cell { row, .. } = leaf.frames[pos] else { return };
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(p.block) else { return };
            let Some(Node::Table { rows }) = tree::container_mut(nodes, &tc).and_then(|c| c.get_mut(ti)) else { return };
            let template = &rows[row];
            let new_row: Vec<Cell> = template.iter().map(|c| Cell { header: false, align: c.align, content: vec![Node::para(vec![])] }).collect();
            rows.insert(row + 1, new_row);
            let mut path = tc.clone();
            path.extend([ti, row + 1, 0, 0]);
            ed.put_caret(p.block, path, 0);
        });
    }

    /// Change one column's alignment (the cells of every row).
    pub fn set_column_align(&mut self, align: Option<Align>) {
        let p = self.head;
        let Some(leaf) = self.leaf(p).cloned() else { return };
        let Some(pos) = leaf.frames.iter().rposition(|f| matches!(f, Frame::Cell { .. })) else { return };
        let anc = tree::ancestors(&self.doc.blocks[p.block].nodes().to_vec(), &leaf.path);
        let Some((tc, ti)) = anc.get(pos).cloned() else { return };
        let Frame::Cell { col, .. } = leaf.frames[pos] else { return };
        let sel = self.keep_selection_paths();
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(p.block) else { return };
            let Some(Node::Table { rows }) = tree::container_mut(nodes, &tc).and_then(|c| c.get_mut(ti)) else { return };
            for r in rows.iter_mut() {
                if let Some(c) = r.get_mut(col) {
                    c.align = align;
                }
            }
            ed.put_selection(sel.0.clone(), sel.1.clone());
        });
    }

    // ---- inserts ----

    /// Insert block nodes after the caret's leaf (splitting a paragraph at
    /// the caret when it has text on both sides).
    pub fn insert_blocks(&mut self, new_nodes: Vec<Node>) {
        if new_nodes.is_empty() {
            return;
        }
        let (from, to) = self.range();
        self.break_undo();
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            let at = if from != to { ed.delete_range_inner(from, to) } else { from };
            ed.refresh_now();
            let at = ed.clamp(Pos { offset: at.offset, ..ed.head });
            let Some(leaf) = ed.leaf(at).cloned() else { return };
            let in_cell = leaf.in_cell();
            if in_cell || ed.doc.blocks[at.block].is_opaque() {
                // Cells and source blocks: insert after the whole block.
                let b = at.block + 1;
                for (k, n) in new_nodes.iter().enumerate() {
                    ed.doc.blocks.insert(b + k, super::new_block(vec![n.clone()]));
                }
                ed.put_caret(b + new_nodes.len() - 1, vec![0], 0);
                return;
            }
            let units = ed.units(at.block, at.leaf);
            let (c, i) = tree::split_path(&leaf.path);
            let c = c.to_vec();
            let Some(nodes) = ed.nodes_mut(at.block) else { return };
            let Some(cont) = tree::container_mut(nodes, &c) else { return };
            let mut insert_at = i + 1;
            if leaf.kind.is_rich() {
                let off = at.offset.min(units.len());
                if units.is_empty() {
                    // An empty paragraph is replaced.
                    cont.remove(i);
                    insert_at = i;
                } else if off == 0 {
                    insert_at = i;
                } else if off < units.len() {
                    let head = crate::edit::unflatten(&units[..off]);
                    let tail = crate::edit::unflatten(&units[off..]);
                    if let Node::Paragraph { content, .. } | Node::Heading { content, .. } = &mut cont[i] {
                        *content = head;
                    }
                    cont.insert(i + 1, Node::para(tail));
                }
            }
            let count = new_nodes.len();
            for (k, n) in new_nodes.into_iter().enumerate() {
                cont.insert(insert_at + k, n);
            }
            let mut p = c.clone();
            p.push(insert_at + count - 1);
            // The caret goes after what was inserted: at its end if it holds
            // text, else on the next line.
            let last = &cont[insert_at + count - 1];
            if matches!(last, Node::Image { .. } | Node::HorizontalRule | Node::Embed { .. }) {
                if insert_at + count >= cont.len() {
                    cont.push(Node::para(vec![]));
                }
                let mut q = c.clone();
                q.push(insert_at + count);
                ed.put_caret(at.block, q, 0);
            } else {
                ed.put_caret(at.block, p, usize::MAX / 2);
            }
        });
        // The caret's offset was a placeholder for "the end".
        let h = self.clamp(self.head);
        self.anchor = h;
        self.head = h;
    }

    pub fn insert_image(&mut self, src: &str, alt: Option<&str>) {
        self.insert_blocks(vec![Node::Image { src: src.into(), alt: alt.map(|a| a.to_string()), title: None, width: None }]);
    }

    pub fn insert_rule(&mut self) {
        self.insert_blocks(vec![Node::HorizontalRule]);
    }

    pub fn insert_table(&mut self, rows: usize, cols: usize) {
        let rows = rows.max(2);
        let cols = cols.max(1);
        let table = Node::Table {
            rows: (0..rows)
                .map(|r| (0..cols).map(|_| Cell { header: r == 0, align: None, content: vec![Node::para(vec![])] }).collect())
                .collect(),
        };
        self.insert_blocks(vec![table]);
    }

    pub fn insert_math_block(&mut self, tex: &str) {
        self.insert_blocks(vec![Node::MathBlock { source: format!("$$\n{tex}\n$$") }]);
    }

    /// A formula at the caret, `$tex$`.
    pub fn insert_inline_math(&mut self, tex: &str) {
        let p = self.head;
        if !self.kind(p).is_some_and(|k| k.is_rich()) || tex.trim().is_empty() {
            return;
        }
        let (from, to) = self.range();
        let source = format!("${}$", tex.trim());
        self.transact(from.block..to.block + 1, EditKind::Other, |ed| {
            let at = if from != to { ed.delete_range_inner(from, to) } else { from };
            let mut u = ed.units(at.block, at.leaf);
            let off = at.offset.min(u.len());
            u.insert(off, Unit::Atom(Inline::Math { source }));
            ed.set_units(at.block, at.leaf, &u);
            let path = ed.leaf(at).unwrap().path.clone();
            ed.put_caret(at.block, path, off + 1);
        });
    }

    /// Replace the source of the inline formula at unit `index` of a leaf.
    pub fn set_inline_math(&mut self, p: Pos, index: usize, source: &str) {
        let mut u = self.units(p.block, p.leaf);
        if !matches!(u.get(index), Some(Unit::Atom(Inline::Math { .. }))) {
            return;
        }
        let path = self.leaf(p).map(|l| l.path.clone()).unwrap_or_default();
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
            if source.trim().is_empty() {
                u.remove(index);
            } else {
                u[index] = Unit::Atom(Inline::Math { source: source.to_string() });
            }
            ed.set_units(p.block, p.leaf, &u);
            ed.put_caret(p.block, path, index + 1);
        });
    }

    /// A picture's width (None for its natural size).
    pub fn set_image_width(&mut self, p: Pos, width: Option<u32>) {
        let Some(leaf) = self.leaf(p).cloned() else { return };
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
            if let Some(Node::Image { width: w, .. }) = ed.nodes_mut(p.block).and_then(|n| tree::node_at_mut(n, &leaf.path)) {
                *w = width;
            }
            ed.put_selection((p.block, leaf.path.clone(), 0), (p.block, leaf.path.clone(), 1));
        });
    }

    pub fn set_code_language(&mut self, p: Pos, language: Option<String>) {
        let Some(leaf) = self.leaf(p).cloned() else { return };
        let sel = self.keep_selection_paths();
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
            if let Some(Node::CodeBlock { language: l, .. }) = ed.nodes_mut(p.block).and_then(|n| tree::node_at_mut(n, &leaf.path)) {
                *l = language.filter(|s| !s.trim().is_empty());
            }
            ed.put_selection(sel.0.clone(), sel.1.clone());
        });
    }
}

/// A text block as another style. Code keeps line breaks; inline atoms
/// become their text in code.
fn convert_text_block(n: Node, style: BlockStyle) -> Node {
    let (content, align) = match n {
        Node::Paragraph { content, align } | Node::Heading { content, align, .. } => (content, align),
        Node::CodeBlock { code, .. } => {
            let mut c = Vec::new();
            for (k, line) in code.split('\n').enumerate() {
                if k > 0 {
                    c.push(Inline::HardBreak);
                }
                if !line.is_empty() {
                    c.push(Inline::text(line));
                }
            }
            (normalize_inlines(c), None)
        }
        other => return other,
    };
    match style {
        BlockStyle::Paragraph => Node::Paragraph { content, align },
        BlockStyle::Heading(level) => Node::Heading { level, content, align },
        BlockStyle::Code => Node::CodeBlock { language: None, code: inline_text(&content) },
        BlockStyle::Quote => Node::Blockquote(vec![Node::Paragraph { content, align }]),
    }
}

/// A node as the first block of a new list item: a paragraph.
fn to_list_text(n: Node) -> Node {
    match n {
        Node::Heading { content, .. } | Node::Paragraph { content, .. } => Node::para(content),
        Node::CodeBlock { .. } => convert_text_block(n, BlockStyle::Paragraph),
        other => other,
    }
}

pub(crate) fn take_items(list: &mut Node) -> Vec<(Option<bool>, Vec<Node>)> {
    match list {
        Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
            std::mem::take(items).into_iter().map(|i| (None, i)).collect()
        }
        Node::TaskList { items } => std::mem::take(items).into_iter().map(|i| (Some(i.checked), i.content)).collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn make_list(kind: ListKind, tight: bool, start: u64, items: Vec<(Option<bool>, Vec<Node>)>) -> Node {
    match kind {
        ListKind::Bullet => Node::BulletList { tight, items: items.into_iter().map(|(_, c)| c).collect() },
        ListKind::Ordered => Node::OrderedList { tight, start, items: items.into_iter().map(|(_, c)| c).collect() },
        ListKind::Task => Node::TaskList {
            items: items.into_iter().map(|(c, content)| TaskItem { checked: c.unwrap_or(false), content }).collect(),
        },
    }
}

fn list_tight(n: &Node) -> bool {
    match n {
        Node::BulletList { tight, .. } | Node::OrderedList { tight, .. } => *tight,
        _ => true,
    }
}

fn list_start(n: &Node) -> u64 {
    match n {
        Node::OrderedList { start, .. } => *start,
        _ => 1,
    }
}

fn list_len(n: &Node) -> usize {
    match n {
        Node::BulletList { items, .. } | Node::OrderedList { items, .. } => items.len(),
        Node::TaskList { items } => items.len(),
        _ => 0,
    }
}
