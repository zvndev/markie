//! Write the editor's content into the room as the smallest change, the way
//! y-prosemirror's `updateYFragment` does: keep every child that is equal
//! from the left and from the right, recurse into same-named elements in the
//! middle, diff text in place, and replace only what is left. Untouched
//! blocks keep their Yjs items, so a peer's concurrent edit in another block
//! (or another word of the same paragraph) survives, and so does every
//! comment anchored there.
use std::sync::Arc;

use markie_rich::room::{Attrs, RoomNode};
use markie_rich::ydoc::{insert_node, json_to_any};
use yrs::types::Attrs as YAttrs;
use yrs::{Any, Out, Text, TransactionMut, Xml, XmlElementRef, XmlFragment, XmlOut, XmlTextRef};

use super::ytree::{YNode, utf16_len};

/// Update `parent`'s children (`have`, as last read) to `want`.
pub fn update_children<F: XmlFragment>(txn: &mut TransactionMut, parent: &F, have: &[YNode], want: &[RoomNode]) {
    let (yc, pc) = (have.len(), want.len());
    let min = yc.min(pc);
    let mut left = 0;
    while left < min && have[left].same_as(&want[left]) {
        left += 1;
    }
    let mut right = 0;
    while right + left < min && have[yc - right - 1].same_as(&want[pc - right - 1]) {
        right += 1;
    }
    while yc - left - right > 0 && pc - left - right > 0 {
        let (ly, lp) = (&have[left], &want[left]);
        let (ry, rp) = (&have[yc - right - 1], &want[pc - right - 1]);
        if let (YNode::Text { .. }, RoomNode::Text(runs)) = (ly, lp) {
            if !ly.same_as(lp) {
                if let Some(XmlOut::Text(t)) = parent.get(txn, left as u32) {
                    update_text(txn, &t, ly, runs);
                }
            }
            left += 1;
            continue;
        }
        let mut update_left = same_name(ly, lp);
        let mut update_right = same_name(ry, rp);
        if update_left && update_right {
            // Which side is more alike decides; y-prosemirror also prefers a
            // child it has mapped before, which a fresh read cannot know.
            if equality_factor(ly, lp) < equality_factor(ry, rp) {
                update_left = false;
            } else {
                update_right = false;
            }
        }
        if update_left {
            update_element(txn, parent, left, ly, lp);
            left += 1;
        } else if update_right {
            update_element(txn, parent, yc - right - 1, ry, rp);
            right += 1;
        } else {
            parent.remove_range(txn, left as u32, 1);
            insert_node(txn, parent, left as u32, lp);
            left += 1;
        }
    }
    let del = yc - left - right;
    if yc == 1 && pc == 0 && have[0].is_text() {
        // y-prosemirror #108: empty the text rather than delete it, so a
        // peer's concurrent insert into it survives.
        if let Some(XmlOut::Text(t)) = parent.get(txn, 0) {
            let len = t.len(txn);
            if len > 0 {
                t.remove_range(txn, 0, len);
            }
        }
    } else if del > 0 {
        parent.remove_range(txn, left as u32, del as u32);
    }
    for (k, node) in want[left..pc - right].iter().enumerate() {
        insert_node(txn, parent, (left + k) as u32, node);
    }
}

fn same_name(y: &YNode, p: &RoomNode) -> bool {
    matches!((y, p), (YNode::Element { name, .. }, RoomNode::Element { name: n2, .. }) if name == n2)
}

/// `computeChildEqualityFactor`: equal children from the left plus from the right.
fn equality_factor(y: &YNode, p: &RoomNode) -> usize {
    let (yk, pk) = match (y, p) {
        (YNode::Element { children, .. }, RoomNode::Element { children: c2, .. }) => (children.as_slice(), c2.as_slice()),
        _ => return 0,
    };
    let min = yk.len().min(pk.len());
    let mut left = 0;
    while left < min && yk[left].same_as(&pk[left]) {
        left += 1;
    }
    let mut right = 0;
    while left + right < min && yk[yk.len() - right - 1].same_as(&pk[pk.len() - right - 1]) {
        right += 1;
    }
    left + right
}

fn update_element<F: XmlFragment>(txn: &mut TransactionMut, parent: &F, index: usize, have: &YNode, want: &RoomNode) {
    let Some(XmlOut::Element(e)) = parent.get(txn, index as u32) else { return };
    let (YNode::Element { attrs: ha, children: hc, .. }, RoomNode::Element { attrs: wa, children: wc, .. }) = (have, want) else { return };
    update_attrs(txn, &e, ha, wa);
    update_children(txn, &e, hc, wc);
}

fn update_attrs(txn: &mut TransactionMut, e: &XmlElementRef, have: &Attrs, want: &Attrs) {
    for (k, v) in want {
        if v.is_null() {
            if have.contains_key(k) {
                e.remove_attribute(txn, k);
            }
        } else if have.get(k) != Some(v) {
            e.insert_attribute(txn, k.as_str(), json_to_any(v));
        }
    }
    for k in have.keys() {
        if !want.contains_key(k) {
            e.remove_attribute(txn, k);
        }
    }
}

/// The single changed span between two UTF-16 strings (lib0's `simpleDiff`).
pub fn simple_diff(a: &[u16], b: &[u16]) -> (usize, usize, Vec<u16>) {
    let mut left = 0;
    while left < a.len() && left < b.len() && a[left] == b[left] {
        left += 1;
    }
    let mut right = 0;
    while right + left < a.len() && right + left < b.len() && a[a.len() - right - 1] == b[b.len() - right - 1] {
        right += 1;
    }
    (left, a.len() - left - right, b[left..b.len() - right].to_vec())
}

/// `updateYText`: insert and delete the changed span, then format every run
/// with its marks, clearing any mark the text had that the run does not.
fn update_text(txn: &mut TransactionMut, t: &XmlTextRef, have: &YNode, want: &[(String, Attrs)]) {
    let YNode::Text { runs, .. } = have else { return };
    let old: Vec<u16> = runs.iter().flat_map(|(s, _)| s.encode_utf16()).collect::<Vec<_>>();
    let new: Vec<u16> = want.iter().flat_map(|(s, _)| s.encode_utf16()).collect::<Vec<_>>();
    let (index, remove, insert) = simple_diff(&old, &new);
    if remove > 0 {
        t.remove_range(txn, index as u32, remove as u32);
    }
    if !insert.is_empty() {
        t.insert(txn, index as u32, &String::from_utf16_lossy(&insert));
    }
    let mut known: Vec<&str> = runs.iter().flat_map(|(_, a)| a.keys().map(String::as_str)).collect();
    known.sort();
    known.dedup();
    let mut at = 0u32;
    for (s, a) in want {
        let len = utf16_len(s);
        let mut attrs: YAttrs = known.iter().map(|k| (Arc::<str>::from(*k), Any::Null)).collect();
        for (k, v) in a {
            attrs.insert(Arc::from(k.as_str()), json_to_any(v));
        }
        if len > 0 && !attrs.is_empty() {
            t.format(txn, at, len, attrs);
        }
        at += len;
    }
}

/// The value an attribute holds now, as JSON (for tests).
pub fn attr_json(o: Out) -> serde_json::Value {
    match o {
        Out::Any(a) => markie_rich::ydoc::any_to_json(&a),
        _ => serde_json::Value::Null,
    }
}
