//! ProseMirror positions and Yjs relative positions, as y-prosemirror maps
//! them (`absolutePositionToRelativePosition` and
//! `relativePositionToAbsolutePosition` in @tiptap/y-tiptap 3.0.10), so a
//! comment anchored or a cursor placed by TipTap lands on the same character
//! here, and the other way round.
use yrs::branch::BranchID;
use yrs::{Assoc, IndexScope, IndexedSequence, ReadTxn, StickyIndex, XmlFragment, XmlFragmentRef, XmlOut};

use super::ytree::{YNode, at, children_at, index};

/// Where a ProseMirror position lands in the room, before it is a
/// relative position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// `createRelativePositionFromTypeIndex(type, index, -1)` on the type at
    /// `path` (the fragment for an empty path).
    TypeIndex { path: Vec<usize>, index: u32 },
    /// `new RelativePosition(type, null, null)`: the end of the type at `path`.
    TypeEnd { path: Vec<usize> },
    /// `createRelativePosition(parent, item)`: just before the node at `path`.
    BeforeNode { path: Vec<usize> },
}

fn parent(path: &[usize]) -> Vec<usize> {
    path[..path.len().saturating_sub(1)].to_vec()
}

fn next_sibling(tree: &[YNode], path: &[usize]) -> Option<Vec<usize>> {
    let (last, _) = path.split_last()?;
    let siblings = children_at(tree, &parent(path))?;
    (*last + 1 < siblings.len()).then(|| {
        let mut p = parent(path);
        p.push(last + 1);
        p
    })
}

/// y-prosemirror's `absolutePositionToRelativePosition`, on the room's tree.
pub fn target_for(tree: &[YNode], pos: u32) -> Target {
    let mut pos = pos as i64;
    if pos == 0 {
        return Target::TypeIndex { path: vec![], index: 0 };
    }
    let mut n: Option<Vec<usize>> = (!tree.is_empty()).then(|| vec![0]);
    while let Some(np) = n.clone() {
        if np.is_empty() {
            break;
        }
        let node = at(tree, &np).expect("a path from the tree");
        if node.is_text() {
            let len = node.len() as i64;
            if len >= pos {
                return Target::TypeIndex { path: np, index: pos as u32 };
            }
            pos -= len;
            if let Some(next) = next_sibling(tree, &np) {
                n = Some(next);
            } else {
                let mut cur = np;
                loop {
                    cur = parent(&cur);
                    pos -= 1;
                    if cur.is_empty() || next_sibling(tree, &cur).is_some() {
                        break;
                    }
                }
                n = if cur.is_empty() { Some(cur) } else { next_sibling(tree, &cur) };
            }
        } else {
            let size = node.pm_size() as i64;
            let has_children = !node.children().is_empty();
            if has_children && pos < size {
                let mut c = np.clone();
                c.push(0);
                n = Some(c);
                pos -= 1;
            } else {
                if pos == 1 && !has_children && size > 1 {
                    return Target::TypeEnd { path: np };
                }
                pos -= size;
                if let Some(next) = next_sibling(tree, &np) {
                    n = Some(next);
                } else {
                    if pos == 0 {
                        return Target::TypeEnd { path: parent(&np) };
                    }
                    let mut cur = np;
                    loop {
                        cur = parent(&cur);
                        pos -= 1;
                        if cur.is_empty() || next_sibling(tree, &cur).is_some() {
                            break;
                        }
                    }
                    n = if cur.is_empty() { Some(cur) } else { next_sibling(tree, &cur) };
                }
            }
        }
        if let Some(cur) = &n {
            if pos == 0 && !cur.is_empty() && !at(tree, cur).is_some_and(YNode::is_text) {
                return Target::BeforeNode { path: cur.clone() };
            }
        }
    }
    Target::TypeIndex { path: vec![], index: tree.len() as u32 }
}

/// The sticky index for a target, and the type yjs records with it.
pub fn sticky_for<T: ReadTxn>(txn: &T, frag: &XmlFragmentRef, tree: &[YNode], target: &Target) -> Option<(StickyIndex, Option<BranchID>)> {
    let root_id = BranchID::Root("default".into());
    let id_at = |p: &[usize]| -> Option<BranchID> { if p.is_empty() { Some(root_id.clone()) } else { at(tree, p).map(|n| n.id().clone()) } };
    match target {
        Target::TypeIndex { path, index } => {
            let si = if path.is_empty() {
                frag.sticky_index(txn, *index, Assoc::Before)?
            } else {
                match get_out(txn, frag, path)? {
                    XmlOut::Element(e) => e.sticky_index(txn, *index, Assoc::Before)?,
                    XmlOut::Text(t) => t.sticky_index(txn, *index, Assoc::Before)?,
                    XmlOut::Fragment(_) => return None,
                }
            };
            Some((si, id_at(path)))
        }
        Target::TypeEnd { path } => {
            let scope = match id_at(path)? {
                BranchID::Nested(id) => IndexScope::Nested(id),
                BranchID::Root(name) => IndexScope::Root(name),
            };
            Some((StickyIndex::new(scope, Assoc::After), None))
        }
        Target::BeforeNode { path } => {
            let BranchID::Nested(item) = id_at(path)? else { return None };
            Some((StickyIndex::new(IndexScope::Relative(item), Assoc::After), id_at(&parent(path))))
        }
    }
}

fn get_out<T: ReadTxn>(txn: &T, frag: &XmlFragmentRef, path: &[usize]) -> Option<XmlOut> {
    let (first, rest) = path.split_first()?;
    let mut cur = frag.get(txn, *first as u32)?;
    for i in rest {
        cur = match cur {
            XmlOut::Element(e) => e.get(txn, *i as u32)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// y-prosemirror's `relativePositionToAbsolutePosition`. None when the
/// position's type is gone or outside the fragment, as the web client says.
pub fn absolute_of<T: ReadTxn>(txn: &T, tree: &[YNode], si: &StickyIndex) -> Option<u32> {
    let off = si.get_offset(txn)?;
    let id = off.branch.id();
    let path = match &id {
        BranchID::Root(name) if name.as_ref() == "default" => vec![],
        BranchID::Root(_) => return None,
        BranchID::Nested(_) => index(tree).get(&id)?.clone(),
    };
    let mut pos: i64 = match at(tree, &path) {
        Some(n) if n.is_text() => off.index as i64,
        _ => {
            let kids = children_at(tree, &path)?;
            kids.iter().take(off.index as usize).map(|c| c.pm_size() as i64).sum::<i64>() + 1
        }
    };
    let mut cur = path;
    while !cur.is_empty() {
        let p = parent(&cur);
        let i = *cur.last().unwrap();
        let siblings = children_at(tree, &p)?;
        pos += siblings.iter().take(i).map(|c| c.pm_size() as i64).sum::<i64>() + 1;
        cur = p;
    }
    let abs = pos - 1;
    (abs >= 0).then_some(abs as u32)
}

/// The document's content size (`doc.content.size`).
pub fn content_size(tree: &[YNode]) -> u32 {
    tree.iter().map(YNode::pm_size).sum()
}
