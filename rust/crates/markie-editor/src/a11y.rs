//! The editor in the accessibility tree. In Electron, View mode is
//! ProseMirror's contenteditable, which Chromium exposes as an editable
//! text area whose lines VoiceOver reads and whose caret it follows. Here
//! the editor is a multiline text input with one text run per leaf on
//! screen, and the selection as a text selection over those runs.
//!
//! Only built while assistive technology is connected
//! (`Window::is_a11y_active`), so typing costs nothing otherwise.

use gpui_kit::accesskit::{Node, NodeId, Rect, Role, TextPosition, TextSelection};
use gpui_kit::*;

use super::RichView;
use super::element::LeafKey;
use markie_rich::edit::Unit;

/// One leaf as the tree sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub key: LeafKey,
    pub text: String,
    pub bounds: (f32, f32, f32, f32),
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
                Some(Run {
                    key: *k,
                    text: self.a11y_text(*k),
                    bounds: (f32::from(b.left()), f32::from(b.top()), f32::from(b.right()), f32::from(b.bottom())),
                })
            })
            .collect();
        let (anchor, head) = (self.editor.anchor, self.editor.head);
        let read_only = self.read_only;
        d.a11y_synthetic_children(move |builder| {
            let mut ids: Vec<(LeafKey, NodeId)> = Vec::new();
            for (key, node) in run_nodes(&runs) {
                let id = builder.synthetic_node_id(key);
                if builder.push_child(id, node) {
                    ids.push((key, id));
                }
            }
            let at = |p: markie_rich::editor::Pos| {
                ids.iter().find(|(k, _)| *k == (p.block, p.leaf)).map(|(_, id)| TextPosition { node: *id, character_index: p.offset })
            };
            let parent = builder.parent_node();
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
    use super::{Run, run_nodes};
    use gpui_kit::accesskit::Role;

    #[test]
    fn runs_carry_text_and_lengths() {
        let runs = vec![
            Run { key: (0, 0), text: "Title".into(), bounds: (0., 0., 100., 20.) },
            Run { key: (1, 0), text: "café".into(), bounds: (0., 30., 100., 50.) },
        ];
        let nodes = run_nodes(&runs);
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[1].1.value(), Some("café"));
        assert_eq!(nodes[1].1.character_lengths(), &[1, 1, 1, 2]);
        assert_eq!(nodes[0].1.role(), Role::TextRun);
    }
}
