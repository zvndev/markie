//! The editor in the accessibility tree. In Electron, View mode is
//! ProseMirror's contenteditable, which Chromium exposes as an editable
//! text area whose lines VoiceOver reads and whose caret it follows. Here
//! the editor is a multiline text input with one text run per leaf on
//! screen, and the selection as a text selection over those runs. Each run
//! sits in the containers Chromium gives the same HTML: a heading with its
//! level, a paragraph, a code group, and lists, list items and quotes
//! around them, so VoiceOver's heading and list navigation works.
//!
//! Only built while assistive technology is connected
//! (`Window::is_a11y_active`), so typing costs nothing otherwise.

use gpui_kit::accesskit::{Node, NodeId, Rect, Role, TextPosition, TextSelection};
use gpui_kit::*;

use super::RichView;
use super::element::LeafKey;
use markie_rich::edit::Unit;
use markie_rich::editor::{Frame, LeafKind};

/// One leaf as the tree sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub key: LeafKey,
    pub text: String,
    pub bounds: (f32, f32, f32, f32),
    /// What holds it, outermost first, and what kind of leaf it is.
    pub frames: Vec<Frame>,
    pub kind: LeafKind,
}

/// A container's identity: its block, the frames down to it, and a tag.
/// Frames carry item indices, so two items, or two lists under different
/// items, never share one.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Key {
    Run(LeafKey),
    Leaf(LeafKey),
    Frame { block: usize, frames: Vec<(u8, usize, usize)>, list: bool },
}

fn frame_key(f: &Frame) -> (u8, usize, usize) {
    match f {
        Frame::Quote => (0, 0, 0),
        Frame::Item { list, index } => (1, *list as usize, *index),
        Frame::Cell { row, col } => (2, *row, *col),
    }
}

/// The containers around a run, outermost first, each with its role and
/// heading level: what Chromium builds for `blockquote`, `ul`/`ol`, `li`,
/// `h1`-`h6`, `p` and `pre`.
pub fn containers(run: &Run) -> Vec<(Key, Role, Option<usize>)> {
    let block = run.key.0;
    let mut out = Vec::new();
    for (d, f) in run.frames.iter().enumerate() {
        let upto = |n: usize| run.frames[..n].iter().map(frame_key).collect::<Vec<_>>();
        match f {
            Frame::Quote => out.push((Key::Frame { block, frames: upto(d + 1), list: false }, Role::Blockquote, None)),
            Frame::Item { list, .. } => {
                let mut list_frames = upto(d);
                list_frames.push((1, *list as usize, usize::MAX));
                out.push((Key::Frame { block, frames: list_frames, list: true }, Role::List, None));
                out.push((Key::Frame { block, frames: upto(d + 1), list: false }, Role::ListItem, None));
            }
            Frame::Cell { .. } => {}
        }
    }
    match run.kind {
        LeafKind::Heading(level) => out.push((Key::Leaf(run.key), Role::Heading, Some(level as usize))),
        LeafKind::Paragraph if !run.frames.iter().any(|f| matches!(f, Frame::Cell { .. })) => out.push((Key::Leaf(run.key), Role::Paragraph, None)),
        LeafKind::Code => out.push((Key::Leaf(run.key), Role::Code, None)),
        _ => {}
    }
    out
}

/// The whole subtree: every node with its children set, and the ids that
/// hang straight off the editor, in reading order.
pub fn tree(runs: &[Run], id: impl Fn(&Key) -> NodeId) -> (Vec<NodeId>, Vec<(NodeId, Node)>) {
    let mut top: Vec<NodeId> = Vec::new();
    let mut order: Vec<NodeId> = Vec::new();
    let mut nodes: std::collections::HashMap<NodeId, (Node, Vec<NodeId>)> = std::collections::HashMap::new();
    let run_nodes = run_nodes(runs);
    for (run, (key, run_node)) in runs.iter().zip(run_nodes) {
        let mut parent: Option<NodeId> = None;
        for (k, role, level) in containers(run) {
            let cid = id(&k);
            if !nodes.contains_key(&cid) {
                let mut n = Node::new(role);
                if let Some(l) = level {
                    n.set_level(l);
                }
                nodes.insert(cid, (n, Vec::new()));
                order.push(cid);
                match parent {
                    Some(p) => nodes.get_mut(&p).unwrap().1.push(cid),
                    None => top.push(cid),
                }
            }
            parent = Some(cid);
        }
        let rid = id(&Key::Run(key));
        if nodes.contains_key(&rid) {
            continue;
        }
        nodes.insert(rid, (run_node, Vec::new()));
        order.push(rid);
        match parent {
            Some(p) => nodes.get_mut(&p).unwrap().1.push(rid),
            None => top.push(rid),
        }
    }
    let all = order
        .into_iter()
        .map(|i| {
            let (mut n, children) = nodes.remove(&i).unwrap();
            if !children.is_empty() {
                n.set_children(children);
            }
            (i, n)
        })
        .collect();
    (top, all)
}

/// The run nodes for `runs`, keyed for stable ids, and where the selection's
/// two ends fall: (run index, character index).
pub fn run_nodes(runs: &[Run]) -> Vec<(LeafKey, Node)> {
    runs.iter()
        .map(|r| {
            let mut n = Node::new(Role::TextRun);
            n.set_value(r.text.clone());
            n.set_character_lengths(r.text.chars().map(|c| c.len_utf8() as u8).collect::<Vec<u8>>());
            let (x0, y0, x1, y1) = r.bounds;
            n.set_bounds(Rect { x0: x0 as f64, y0: y0 as f64, x1: x1 as f64, y1: y1 as f64 });
            (r.key, n)
        })
        .collect()
}

impl RichView {
    /// What the tree reads for one leaf: atoms as their text, as
    /// Chromium reads a formula's source.
    fn a11y_text(&self, key: LeafKey) -> String {
        self.editor
            .units(key.0, key.1)
            .iter()
            .map(|u| match u {
                Unit::Char(c, _) => c.to_string(),
                Unit::Atom(_) => u.display(),
            })
            .collect()
    }

    pub(crate) fn accessibility(&self, d: Stateful<Div>, window: &Window) -> Stateful<Div> {
        let d = d.role(Role::MultilineTextInput).aria_label("Document");
        // A check without VoiceOver: with MARKIE_RS_A11Y_DUMP set, a debug
        // build writes the last frame's tree there while a reader (any
        // accessibility client) is connected.
        if let Ok(path) = std::env::var("MARKIE_RS_A11Y_DUMP") {
            eprintln!("a11y active: {}", window.is_a11y_active());
            if let Some(json) = window.debug_a11y_tree_json() {
                let _ = std::fs::write(path, json);
            }
        }
        if !window.is_a11y_active() {
            return d;
        }
        let mut keys: Vec<LeafKey> = self.store.borrow().leaves.keys().copied().collect();
        keys.sort_unstable();
        let runs: Vec<Run> = keys
            .iter()
            .filter_map(|k| {
                let pl = self.store.borrow().leaves.get(k).cloned()?;
                let b = pl.bounds;
                let leaf = self.editor.leaves_of(k.0).get(k.1)?;
                Some(Run {
                    key: *k,
                    text: self.a11y_text(*k),
                    bounds: (f32::from(b.left()), f32::from(b.top()), f32::from(b.right()), f32::from(b.bottom())),
                    frames: leaf.frames.clone(),
                    kind: leaf.kind,
                })
            })
            .collect();
        let (anchor, head) = (self.editor.anchor, self.editor.head);
        let read_only = self.read_only;
        d.a11y_synthetic_children(move |builder| {
            // The builder only hangs nodes off the editor; push every node,
            // each already holding its own children, then give the editor
            // back only the top of the tree.
            let (top, all) = tree(&runs, |k| builder.synthetic_node_id(k));
            let mut pushed = std::collections::HashSet::new();
            for (id, node) in all {
                if builder.push_child(id, node) {
                    pushed.insert(id);
                }
            }
            let ids: Vec<(LeafKey, NodeId)> = runs.iter().map(|r| (r.key, builder.synthetic_node_id(Key::Run(r.key)))).filter(|(_, id)| pushed.contains(id)).collect();
            let at = |p: markie_rich::editor::Pos| {
                ids.iter().find(|(k, _)| *k == (p.block, p.leaf)).map(|(_, id)| TextPosition { node: *id, character_index: p.offset })
            };
            let parent = builder.parent_node();
            let keep: Vec<NodeId> = parent.children().iter().copied().filter(|c| !pushed.contains(c) || top.contains(c)).collect();
            parent.set_children(keep);
            if read_only {
                parent.set_read_only();
            }
            if let (Some(a), Some(f)) = (at(anchor), at(head)) {
                parent.set_text_selection(TextSelection { anchor: a, focus: f });
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Key, Run, run_nodes, tree};
    use gpui_kit::accesskit::{NodeId, Role};
    use markie_rich::editor::Editor;
    use std::hash::{Hash, Hasher};

    fn run(key: (usize, usize), text: &str) -> Run {
        Run { key, text: text.into(), bounds: (0., 0., 100., 20.), frames: vec![], kind: markie_rich::editor::LeafKind::Paragraph }
    }

    /// Every leaf of a document as a run, as the view would build them.
    fn runs_of(md: &str) -> Vec<Run> {
        let ed = Editor::parse(md);
        let mut out = Vec::new();
        for b in 0..ed.block_count() {
            for (l, leaf) in ed.leaves_of(b).iter().enumerate() {
                let text: String = ed.units(b, l).iter().map(|u| u.display()).collect();
                out.push(Run { key: (b, l), text, bounds: (0., 0., 1., 1.), frames: leaf.frames.clone(), kind: leaf.kind });
            }
        }
        out
    }

    fn id(k: &Key) -> NodeId {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        k.hash(&mut h);
        NodeId(h.finish())
    }

    #[test]
    fn headings_paragraphs_and_lists_get_their_roles() {
        let runs = runs_of("# Title\n\nIntro.\n\n- one\n- two\n  1. inner\n\n> quoted\n\n```\ncode\n```\n");
        let (top, all) = tree(&runs, id);
        let node = |i: NodeId| &all.iter().find(|(n, _)| *n == i).unwrap().1;
        let roles: Vec<Role> = top.iter().map(|i| node(*i).role()).collect();
        assert_eq!(roles, vec![Role::Heading, Role::Paragraph, Role::List, Role::Blockquote, Role::Code]);
        assert_eq!(node(top[0]).level(), Some(1));
        // The heading holds its text run.
        assert_eq!(node(node(top[0]).children()[0]).value(), Some("Title"));
        // The list holds two items; the second holds its paragraph and a
        // nested list of one item.
        let list = node(top[2]);
        assert_eq!(list.children().len(), 2);
        let second = node(list.children()[1]);
        assert_eq!(second.role(), Role::ListItem);
        let kids: Vec<Role> = second.children().iter().map(|c| node(*c).role()).collect();
        assert_eq!(kids, vec![Role::Paragraph, Role::List]);
        assert_eq!(node(second.children()[1]).children().len(), 1);
        // Every node has one parent: no id is listed twice.
        let mut seen = std::collections::HashSet::new();
        for (_, n) in &all {
            for c in n.children() {
                assert!(seen.insert(*c), "{c:?} has two parents");
            }
        }
        for t in &top {
            assert!(!seen.contains(t));
        }
    }

    #[test]
    fn runs_carry_text_and_lengths() {
        let runs = vec![run((0, 0), "Title"), run((1, 0), "café")];
        let nodes = run_nodes(&runs);
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[1].1.value(), Some("café"));
        assert_eq!(nodes[1].1.character_lengths(), &[1, 1, 1, 2]);
        assert_eq!(nodes[0].1.role(), Role::TextRun);
    }
}
