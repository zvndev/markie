//! The room's XML read out of yrs with each node's identity kept, so the
//! binding can diff against it and map positions the way y-prosemirror does.
use std::collections::HashMap;

use markie_rich::room::{Attrs, RoomNode};
use markie_rich::ydoc::any_to_json;
use yrs::branch::BranchID;
use yrs::types::text::YChange;
use yrs::{Any, Out, ReadTxn, Text, Xml, XmlFragment, XmlOut};

/// ProseMirror leaf nodes in Markie's TipTap schema: `nodeSize` 1.
pub const LEAF_NODES: [&str; 6] = ["horizontalRule", "image", "mathBlock", "embed", "mathInline", "hardBreak"];
/// Nodes whose content is inline text.
pub const TEXT_BLOCKS: [&str; 3] = ["paragraph", "heading", "codeBlock"];

pub fn is_leaf(name: &str) -> bool {
    LEAF_NODES.contains(&name)
}

pub fn is_textblock(name: &str) -> bool {
    TEXT_BLOCKS.contains(&name)
}

pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// One live node of the room, with the id of the item that holds it.
#[derive(Debug, Clone, PartialEq)]
pub enum YNode {
    Element { id: BranchID, name: String, attrs: Attrs, children: Vec<YNode> },
    Text { id: BranchID, runs: Vec<(String, Attrs)> },
}

impl YNode {
    pub fn id(&self) -> &BranchID {
        match self {
            YNode::Element { id, .. } | YNode::Text { id, .. } => id,
        }
    }

    pub fn is_text(&self) -> bool {
        matches!(self, YNode::Text { .. })
    }

    pub fn children(&self) -> &[YNode] {
        match self {
            YNode::Element { children, .. } => children,
            YNode::Text { .. } => &[],
        }
    }

    /// The text's length in UTF-16 units (Yjs `_length`), or the element's child count.
    pub fn len(&self) -> u32 {
        match self {
            YNode::Text { runs, .. } => runs.iter().map(|(s, _)| utf16_len(s)).sum(),
            YNode::Element { children, .. } => children.len() as u32,
        }
    }

    /// ProseMirror's `nodeSize` for the node this item holds.
    pub fn pm_size(&self) -> u32 {
        match self {
            YNode::Text { .. } => self.len(),
            YNode::Element { name, children, .. } => {
                if is_leaf(name) {
                    1
                } else {
                    2 + children.iter().map(YNode::pm_size).sum::<u32>()
                }
            }
        }
    }

    pub fn to_room(&self) -> RoomNode {
        match self {
            YNode::Element { name, attrs, children, .. } => RoomNode::Element {
                name: name.clone(),
                attrs: attrs.clone(),
                children: children.iter().map(YNode::to_room).collect(),
            },
            YNode::Text { runs, .. } => RoomNode::Text(runs.clone()),
        }
    }

    /// Structural equality with a desired node (y-prosemirror's
    /// `equalYTypePNode`), ignoring identities.
    pub fn same_as(&self, r: &RoomNode) -> bool {
        match (self, r) {
            (YNode::Text { runs, .. }, RoomNode::Text(want)) => runs == want,
            (YNode::Element { name, attrs, children, .. }, RoomNode::Element { name: n2, attrs: a2, children: c2 }) => {
                name == n2 && attrs == a2 && children.len() == c2.len() && children.iter().zip(c2).all(|(a, b)| a.same_as(b))
            }
            _ => false,
        }
    }
}

/// ProseMirror `nodeSize` of a desired node.
pub fn room_size(r: &RoomNode) -> u32 {
    match r {
        RoomNode::Text(runs) => runs.iter().map(|(s, _)| utf16_len(s)).sum(),
        RoomNode::Element { name, children, .. } => {
            if is_leaf(name) {
                1
            } else {
                2 + children.iter().map(room_size).sum::<u32>()
            }
        }
    }
}

fn branch_id<B: AsRef<yrs::branch::Branch>>(b: &B) -> BranchID {
    b.as_ref().id()
}

pub fn read_children<T: ReadTxn, F: XmlFragment>(txn: &T, parent: &F) -> Vec<YNode> {
    parent.children(txn).filter_map(|c| read_node(txn, c)).collect()
}

fn read_node<T: ReadTxn>(txn: &T, n: XmlOut) -> Option<YNode> {
    Some(match n {
        XmlOut::Element(e) => {
            let mut attrs = Attrs::new();
            for (k, v) in e.attributes(txn) {
                if let Out::Any(a) = v {
                    let j = any_to_json(&a);
                    if !j.is_null() {
                        attrs.insert(k.to_string(), j);
                    }
                }
            }
            YNode::Element { id: branch_id(&e), name: e.tag().to_string(), attrs, children: read_children(txn, &e) }
        }
        XmlOut::Text(t) => {
            let mut runs: Vec<(String, Attrs)> = Vec::new();
            for d in t.diff(txn, YChange::identity) {
                let s = match d.insert {
                    Out::Any(Any::String(s)) => s.to_string(),
                    _ => continue,
                };
                let a: Attrs = d
                    .attributes
                    .map(|m| m.iter().filter(|(_, v)| !matches!(v, Any::Null)).map(|(k, v)| (k.to_string(), any_to_json(v))).collect())
                    .unwrap_or_default();
                match runs.last_mut() {
                    Some((ps, pa)) if *pa == a => ps.push_str(&s),
                    _ => runs.push((s, a)),
                }
            }
            YNode::Text { id: branch_id(&t), runs }
        }
        XmlOut::Fragment(_) => return None,
    })
}

/// Where each live node is, by the id of its item: a path of child indices
/// from the fragment.
pub fn index(tree: &[YNode]) -> HashMap<BranchID, Vec<usize>> {
    fn walk(nodes: &[YNode], path: &mut Vec<usize>, out: &mut HashMap<BranchID, Vec<usize>>) {
        for (i, n) in nodes.iter().enumerate() {
            path.push(i);
            out.insert(n.id().clone(), path.clone());
            walk(n.children(), path, out);
            path.pop();
        }
    }
    let mut out = HashMap::new();
    walk(tree, &mut Vec::new(), &mut out);
    out
}

/// The node at `path`, or None for the fragment itself (an empty path).
pub fn at<'a>(tree: &'a [YNode], path: &[usize]) -> Option<&'a YNode> {
    let (first, rest) = path.split_first()?;
    let mut n = tree.get(*first)?;
    for i in rest {
        n = n.children().get(*i)?;
    }
    Some(n)
}

/// The children at `path` (the fragment's for an empty path).
pub fn children_at<'a>(tree: &'a [YNode], path: &[usize]) -> Option<&'a [YNode]> {
    if path.is_empty() {
        return Some(tree);
    }
    at(tree, path).map(YNode::children)
}
