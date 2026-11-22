//! Addressing inside one top-level block's nodes.
//!
//! A *container* is a list of nodes: the block itself, a blockquote's
//! children, a list item, a task item, or a table cell. A *path* names a
//! node by the indices that lead to it, read by the node types on the way:
//!
//! * a blockquote takes one index, its child;
//! * a list or task list takes two, the item and the node in it;
//! * a table takes three, the row, the cell and the node in the cell.
//!
//! A *leaf* is a node the caret goes into: a paragraph, heading, code block
//! or display math block holds text; a picture, rule or embed is an atom the
//! caret selects whole.

use crate::model::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeafKind {
    Paragraph,
    Heading(u8),
    Code,
    /// Display math: the TeX between the delimiters is the leaf's text.
    Math,
    /// Image, rule, embed: no text, selected whole.
    Atom,
    /// A block kept as source (raw HTML, definitions): its bytes are the
    /// leaf's text, edited as written.
    Source,
}

impl LeafKind {
    pub fn has_text(self) -> bool {
        !matches!(self, LeafKind::Atom)
    }
    /// Inline content with marks (as opposed to plain code or TeX).
    /// Plain text with real line breaks (code, TeX, source).
    pub fn is_plain(self) -> bool {
        matches!(self, LeafKind::Code | LeafKind::Math | LeafKind::Source)
    }
    pub fn is_rich(self) -> bool {
        matches!(self, LeafKind::Paragraph | LeafKind::Heading(_))
    }
}

/// What holds a leaf, innermost first, for rendering and structural edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frame {
    Quote,
    /// A list item: the list's kind, the item's index, and for an ordered
    /// list its number.
    Item { list: ListKind, index: usize },
    Cell { row: usize, col: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    Bullet,
    Ordered,
    Task,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Leaf {
    pub path: Vec<usize>,
    pub kind: LeafKind,
    /// Containers from the block down to the leaf.
    pub frames: Vec<Frame>,
}

impl Leaf {
    pub fn in_cell(&self) -> bool {
        self.frames.iter().any(|f| matches!(f, Frame::Cell { .. }))
    }
}

pub fn list_kind(n: &Node) -> Option<ListKind> {
    match n {
        Node::BulletList { .. } => Some(ListKind::Bullet),
        Node::OrderedList { .. } => Some(ListKind::Ordered),
        Node::TaskList { .. } => Some(ListKind::Task),
        _ => None,
    }
}

/// Every leaf of `nodes`, in reading order.
pub fn leaves(nodes: &[Node]) -> Vec<Leaf> {
    let mut out = Vec::new();
    walk(nodes, &mut Vec::new(), &mut Vec::new(), &mut out);
    out
}

fn walk(nodes: &[Node], path: &mut Vec<usize>, frames: &mut Vec<Frame>, out: &mut Vec<Leaf>) {
    for (i, n) in nodes.iter().enumerate() {
        path.push(i);
        let leaf = |kind| Leaf { path: path.clone(), kind, frames: frames.clone() };
        match n {
            Node::Paragraph { .. } => out.push(leaf(LeafKind::Paragraph)),
            Node::Heading { level, .. } => out.push(leaf(LeafKind::Heading(*level))),
            Node::CodeBlock { .. } => out.push(leaf(LeafKind::Code)),
            Node::MathBlock { .. } => out.push(leaf(LeafKind::Math)),
            Node::Image { .. } | Node::HorizontalRule | Node::Embed { .. } => out.push(leaf(LeafKind::Atom)),
            Node::Blockquote(c) => {
                frames.push(Frame::Quote);
                walk(c, path, frames, out);
                frames.pop();
            }
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                let list = list_kind(n).unwrap();
                for (k, item) in items.iter().enumerate() {
                    path.push(k);
                    frames.push(Frame::Item { list, index: k });
                    walk_item(item, path, frames, out);
                    frames.pop();
                    path.pop();
                }
            }
            Node::TaskList { items } => {
                for (k, item) in items.iter().enumerate() {
                    path.push(k);
                    frames.push(Frame::Item { list: ListKind::Task, index: k });
                    walk_item(&item.content, path, frames, out);
                    frames.pop();
                    path.pop();
                }
            }
            Node::Table { rows } => {
                for (r, row) in rows.iter().enumerate() {
                    for (c, cell) in row.iter().enumerate() {
                        path.push(r);
                        path.push(c);
                        frames.push(Frame::Cell { row: r, col: c });
                        walk(&cell.content, path, frames, out);
                        frames.pop();
                        path.pop();
                        path.pop();
                    }
                }
            }
        }
        path.pop();
    }
}

/// An empty item still needs a place for the caret: it gets a virtual leaf
/// at node 0, which `ensure_leaf` makes real on the first edit.
fn walk_item(item: &[Node], path: &mut Vec<usize>, frames: &mut Vec<Frame>, out: &mut Vec<Leaf>) {
    if item.is_empty() {
        path.push(0);
        out.push(Leaf { path: path.clone(), kind: LeafKind::Paragraph, frames: frames.clone() });
        path.pop();
    } else {
        walk(item, path, frames, out);
    }
}

/// How many indices of `path` a node at its start consumes.
fn step_len(n: &Node) -> usize {
    match n {
        Node::Blockquote(_) => 1,
        Node::BulletList { .. } | Node::OrderedList { .. } | Node::TaskList { .. } => 2,
        Node::Table { .. } => 3,
        _ => 0,
    }
}

/// The container a container-path names.
pub fn container_of<'a>(nodes: &'a Vec<Node>, cpath: &[usize]) -> Option<&'a Vec<Node>> {
    let mut cur = nodes;
    let mut p = cpath;
    while !p.is_empty() {
        let n = cur.get(p[0])?;
        cur = match n {
            Node::Blockquote(c) => {
                p = &p[1..];
                c
            }
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                let item = items.get(*p.get(1)?)?;
                p = &p[2..];
                item
            }
            Node::TaskList { items } => {
                let item = items.get(*p.get(1)?)?;
                p = &p[2..];
                &item.content
            }
            Node::Table { rows } => {
                let cell = rows.get(*p.get(1)?)?.get(*p.get(2)?)?;
                p = &p[3..];
                &cell.content
            }
            _ => return None,
        };
    }
    Some(cur)
}

pub fn container_mut<'a>(nodes: &'a mut Vec<Node>, cpath: &[usize]) -> Option<&'a mut Vec<Node>> {
    let mut cur = nodes;
    let mut p = cpath;
    while !p.is_empty() {
        let n = cur.get_mut(p[0])?;
        cur = match n {
            Node::Blockquote(c) => {
                p = &p[1..];
                c
            }
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                let item = items.get_mut(*p.get(1)?)?;
                p = &p[2..];
                item
            }
            Node::TaskList { items } => {
                let item = items.get_mut(*p.get(1)?)?;
                p = &p[2..];
                &mut item.content
            }
            Node::Table { rows } => {
                let cell = rows.get_mut(*p.get(1)?)?.get_mut(*p.get(2)?)?;
                p = &p[3..];
                &mut cell.content
            }
            _ => return None,
        };
    }
    Some(cur)
}

/// Split a node path into (container path, index in that container).
pub fn split_path(path: &[usize]) -> (&[usize], usize) {
    let (last, rest) = path.split_last().expect("a node path is never empty");
    (rest, *last)
}

pub fn node_at<'a>(nodes: &'a Vec<Node>, path: &[usize]) -> Option<&'a Node> {
    let (c, i) = split_path(path);
    container_of(nodes, c)?.get(i)
}

pub fn node_at_mut<'a>(nodes: &'a mut Vec<Node>, path: &[usize]) -> Option<&'a mut Node> {
    let (c, i) = split_path(path);
    container_mut(nodes, c)?.get_mut(i)
}

/// The container paths from the block down to the leaf's own container,
/// outermost first, each with the node that opens it. For a path
/// `[2, 0, 1, 0]` through a list at 2: `([], 2)` is the list in the block,
/// `[2, 0]` is item 0's content.
pub fn ancestors(nodes: &Vec<Node>, path: &[usize]) -> Vec<(Vec<usize>, usize)> {
    // (container path, index of the opening node in that container)
    let mut out = Vec::new();
    let mut cpath: Vec<usize> = Vec::new();
    let mut p = path;
    let mut cur = nodes;
    while p.len() > 1 {
        let Some(n) = cur.get(p[0]) else { break };
        let k = step_len(n);
        if k == 0 || p.len() <= k {
            break;
        }
        out.push((cpath.clone(), p[0]));
        cpath.extend_from_slice(&p[..k]);
        match container_of(cur, &p[..k]) {
            Some(c) => cur = c,
            None => break,
        }
        p = &p[k..];
    }
    out
}

/// The leaf's text as units (see `edit::Unit`), or None for an atom.
pub fn leaf_units(nodes: &Vec<Node>, leaf: &Leaf) -> Vec<crate::edit::Unit> {
    use crate::edit::{Unit, flatten};
    match node_at(nodes, &leaf.path) {
        Some(Node::Paragraph { content, .. }) | Some(Node::Heading { content, .. }) => flatten(content),
        Some(Node::CodeBlock { code, .. }) => code.chars().map(|c| Unit::Char(c, Marks::default())).collect(),
        Some(Node::MathBlock { source }) => {
            math_body(source).1.chars().map(|c| Unit::Char(c, Marks::default())).collect()
        }
        _ => Vec::new(),
    }
}

/// `$$ body $$` as (opening with its spacing, body, closing with its spacing).
pub fn math_body(source: &str) -> (&str, &str, &str) {
    let inner_start = if source.starts_with("$$") { 2 } else { 0 };
    let inner_end = if source.len() >= inner_start + 2 && source.ends_with("$$") { source.len() - 2 } else { source.len() };
    let inner = &source[inner_start..inner_end.max(inner_start)];
    let lead = inner.len() - inner.trim_start().len();
    let trail = inner.len() - inner.trim_end().len();
    let body_start = inner_start + lead;
    let body_end = (inner_start + inner.len() - trail).max(body_start);
    (&source[..body_start], &source[body_start..body_end], &source[body_end..])
}

/// Store units back into the leaf (which must exist and hold text).
pub fn set_leaf_units(nodes: &mut Vec<Node>, leaf: &Leaf, units: &[crate::edit::Unit]) {
    use crate::edit::unflatten;
    ensure_leaf(nodes, &leaf.path);
    let Some(n) = node_at_mut(nodes, &leaf.path) else { return };
    match n {
        Node::Paragraph { content, .. } | Node::Heading { content, .. } => *content = unflatten(units),
        Node::CodeBlock { code, .. } => *code = units_text(units),
        Node::MathBlock { source } => {
            let (open, _, close) = math_body(source);
            let (open, close) = (open.to_string(), close.to_string());
            *source = format!("{open}{}{close}", units_text(units));
        }
        _ => {}
    }
}

pub fn units_text(units: &[crate::edit::Unit]) -> String {
    units.iter().map(|u| u.display()).collect()
}

/// Make the virtual leaf of an empty list item real.
pub fn ensure_leaf(nodes: &mut Vec<Node>, path: &[usize]) {
    let (c, i) = split_path(path);
    if let Some(cont) = container_mut(nodes, c) {
        if cont.is_empty() && i == 0 {
            cont.push(Node::para(vec![]));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_nodes;

    #[test]
    fn leaves_through_containers() {
        let nodes = parse_nodes("# T\n\n> q\n>\n> - a\n>   - b\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\n- [ ] t\n\n---\n");
        let all: Vec<(Vec<usize>, LeafKind)> =
            nodes.iter().enumerate().flat_map(|(i, n)| {
                leaves(std::slice::from_ref(n)).into_iter().map(move |mut l| {
                    l.path[0] = i;
                    (l.path, l.kind)
                })
            }).collect();
        assert_eq!(all[0], (vec![0], LeafKind::Heading(1)));
        assert_eq!(all[1], (vec![1, 0], LeafKind::Paragraph));
        assert_eq!(all[2], (vec![1, 1, 0, 0], LeafKind::Paragraph));
        assert_eq!(all[3], (vec![1, 1, 0, 1, 0, 0], LeafKind::Paragraph));
        assert_eq!(all[4].0, vec![2, 0, 0, 0]);
        assert_eq!(all[7].0, vec![2, 1, 1, 0]);
        assert_eq!(all[8].0, vec![3, 0, 0]);
        assert_eq!(all[9], (vec![4], LeafKind::Atom));
        let v = nodes.clone();
        assert!(matches!(node_at(&v, &[1, 1, 0, 1, 0, 0]), Some(Node::Paragraph { .. })));
        let anc = ancestors(&v, &[1, 1, 0, 1, 0, 0]);
        assert_eq!(anc, vec![(vec![], 1), (vec![1], 1), (vec![1, 1, 0], 1)]);
    }

    #[test]
    fn math_body_keeps_delimiters() {
        assert_eq!(math_body("$$\nx^2\n$$"), ("$$\n", "x^2", "\n$$"));
        assert_eq!(math_body("$$x$$"), ("$$", "x", "$$"));
    }
}

/// Make edited nodes fit what Markdown (and TipTap's schema) can hold, the
/// way ProseMirror fixes content up: a table cell holds one paragraph, a
/// list item starts with an unaligned paragraph, display math has no blank
/// line in it (one would end the block).
pub fn fix_schema(nodes: &mut Vec<Node>) {
    for n in nodes.iter_mut() {
        fix_node(n);
    }
}

fn fix_node(n: &mut Node) {
    match n {
        Node::Blockquote(c) => {
            fix_schema(c);
            if c.is_empty() {
                c.push(Node::para(vec![]));
            }
        }
        Node::BulletList { items, .. } | Node::OrderedList { items, .. } => items.iter_mut().for_each(fix_item),
        Node::TaskList { items } => items.iter_mut().for_each(|i| fix_item(&mut i.content)),
        Node::Table { rows } => {
            for row in rows.iter_mut() {
                for cell in row.iter_mut() {
                    fix_cell(&mut cell.content);
                }
            }
        }
        Node::MathBlock { source } => {
            let (open, body, close) = math_body(source);
            if body.contains("\n\n") || body.contains("\n\r\n") {
                let mut b = body.replace("\r\n", "\n");
                while b.contains("\n\n") {
                    b = b.replace("\n\n", "\n");
                }
                *source = format!("{open}{b}{close}");
            }
        }
        _ => {}
    }
}

fn fix_item(c: &mut Vec<Node>) {
    fix_schema(c);
    match c.first_mut() {
        None => {}
        Some(Node::Paragraph { align, .. }) => *align = None,
        Some(first @ Node::Heading { .. }) => {
            if let Node::Heading { content, .. } = std::mem::replace(first, Node::para(vec![])) {
                *first = Node::para(content);
            }
        }
        Some(_) => c.insert(0, Node::para(vec![])),
    }
}

fn fix_cell(c: &mut Vec<Node>) {
    if let [Node::Paragraph { align, .. }] = c.as_mut_slice() {
        *align = None;
        return;
    }
    // Several blocks in a cell: one paragraph, their lines as line breaks.
    let mut merged: Vec<Inline> = Vec::new();
    collect_text(c, &mut merged);
    *c = vec![Node::para(normalize_inlines(merged))];
}

fn collect_text(nodes: &[Node], out: &mut Vec<Inline>) {
    for n in nodes {
        let mut line: Vec<Inline> = match n {
            Node::Paragraph { content, .. } | Node::Heading { content, .. } => content.clone(),
            Node::CodeBlock { code, .. } => vec![Inline::text(code.replace('\n', " "))],
            Node::MathBlock { source } => vec![Inline::Math { source: format!("${}$", math_body(source).1.replace('\n', " ")) }],
            Node::Image { alt, .. } => alt.clone().map(Inline::text).into_iter().collect(),
            Node::Blockquote(c) => {
                collect_text(c, out);
                continue;
            }
            Node::BulletList { items, .. } | Node::OrderedList { items, .. } => {
                for i in items {
                    collect_text(i, out);
                }
                continue;
            }
            Node::TaskList { items } => {
                for i in items {
                    collect_text(&i.content, out);
                }
                continue;
            }
            _ => continue,
        };
        line.retain(|i| !matches!(i, Inline::Text { text, .. } if text.is_empty()));
        if line.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(Inline::HardBreak);
        }
        out.append(&mut line);
    }
}
