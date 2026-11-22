//! Editor positions (`Pos`: block, leaf, unit offset) to ProseMirror
//! positions and back. The editor's document is the room's content
//! (`doc.nodes()`), so the arithmetic runs on the editor alone: a block's
//! nodes in order, element tokens counted as ProseMirror counts them, text
//! in UTF-16 units, inline formulas and line breaks one unit each.
//!
//! Blocks kept as source (raw HTML, definitions) are not in a room; a
//! position in one maps to where the room continues.
use markie_rich::edit::Unit;
use markie_rich::editor::{Editor, LeafKind, Pos};
use markie_rich::room::{RoomNode, to_room};

use super::ytree::{is_leaf, is_textblock, room_size};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub block: usize,
    pub path: Vec<usize>,
    /// For a text block, the position of its first character; for a leaf,
    /// the position just before it.
    pub start: u32,
    /// UTF-16 length of a text block's content, or 1 for a leaf node.
    pub len: u32,
    pub text: bool,
}

/// Every leaf the caret can be in, in reading order, with where it is in
/// ProseMirror terms. Opaque blocks get a zero-length marker at the
/// position the room continues from.
pub fn spans(ed: &Editor) -> Vec<Span> {
    let mut out = Vec::new();
    let mut pos = 0u32;
    for (b, block) in ed.doc.blocks.iter().enumerate() {
        if block.is_opaque() {
            out.push(Span { block: b, path: vec![], start: pos, len: 0, text: false });
            continue;
        }
        for (i, node) in to_room(block.nodes()).iter().enumerate() {
            walk(node, b, &mut vec![i], pos, &mut out);
            pos += room_size(node);
        }
    }
    out
}

fn walk(n: &RoomNode, block: usize, path: &mut Vec<usize>, start: u32, out: &mut Vec<Span>) {
    let RoomNode::Element { name, children, .. } = n else { return };
    if is_leaf(name) {
        out.push(Span { block, path: path.clone(), start, len: 1, text: false });
        return;
    }
    if is_textblock(name) {
        out.push(Span { block, path: path.clone(), start: start + 1, len: room_size(n) - 2, text: true });
        return;
    }
    let mut q = start + 1;
    for (i, c) in children.iter().enumerate() {
        path.push(i);
        walk(c, block, path, q, out);
        path.pop();
        q += room_size(c);
    }
}

fn unit_width(u: &Unit) -> u32 {
    match u {
        Unit::Char(c, _) => c.len_utf16() as u32,
        Unit::Atom(_) => 1,
    }
}

fn find<'a>(spans: &'a [Span], ed: &Editor, p: Pos) -> Option<&'a Span> {
    let leaf = ed.leaf(p)?;
    if ed.doc.blocks.get(p.block)?.is_opaque() {
        return spans.iter().find(|s| s.block == p.block);
    }
    spans.iter().find(|s| s.block == p.block && s.path == leaf.path)
}

/// The ProseMirror position of an editor position.
pub fn pm_of(ed: &Editor, spans: &[Span], p: Pos) -> u32 {
    let Some(s) = find(spans, ed, p) else { return 0 };
    if !s.text {
        if s.len == 0 {
            return s.start;
        }
        // A picture, rule or embed; or display math, which the editor opens
        // as text but ProseMirror holds as one leaf.
        let end = ed.leaf_len(p.block, p.leaf).max(1);
        return s.start + u32::from(p.offset >= end);
    }
    let units = ed.units(p.block, p.leaf);
    s.start + units.iter().take(p.offset).map(unit_width).sum::<u32>()
}

/// The editor position of a ProseMirror position: inside the text block or
/// beside the leaf that holds it, else the nearest place after it.
pub fn pos_of(ed: &Editor, spans: &[Span], pm: u32) -> Pos {
    let leaf_of = |s: &Span| -> Option<usize> { ed.leaves_of(s.block).iter().position(|l| l.path == s.path) };
    for s in spans.iter().filter(|s| s.len > 0) {
        let Some(leaf) = leaf_of(s) else { continue };
        if s.text && pm >= s.start && pm <= s.start + s.len {
            let units = ed.units(s.block, leaf);
            let mut w = s.start;
            let mut k = 0;
            while k < units.len() && w + unit_width(&units[k]) <= pm {
                w += unit_width(&units[k]);
                k += 1;
            }
            return Pos::new(s.block, leaf, k);
        }
        if !s.text && (pm == s.start || pm == s.start + 1) {
            let off = if pm == s.start { 0 } else { ed.leaf_len(s.block, leaf).max(1) };
            let off = if ed.kind(Pos::new(s.block, leaf, 0)) == Some(LeafKind::Atom) { off.min(1) } else { off };
            return Pos::new(s.block, leaf, off);
        }
        if s.start > pm {
            return Pos::new(s.block, leaf, 0);
        }
    }
    ed.end_pos()
}
