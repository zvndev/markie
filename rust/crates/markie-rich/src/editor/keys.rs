//! Keys TipTap's extensions bind that are not plain typing or Enter:
//! CodeBlock's Backspace, ArrowDown and exit (`exitCode`, which both
//! Shift-Enter and ⌘Enter run in a code block).

use super::tree;
use super::{EditKind, Editor, LeafKind, Pos};
use crate::model::*;

impl Editor {
    fn code_leaf(&self) -> Option<(Pos, Vec<usize>)> {
        let p = self.head;
        if self.has_selection() || self.kind(p) != Some(LeafKind::Code) {
            return None;
        }
        Some((p, self.leaf(p)?.path.clone()))
    }

    /// CodeBlock's Backspace: in an empty code block, or at the very start
    /// of a document that opens with one, the block becomes a paragraph.
    pub(crate) fn code_backspace(&mut self) -> bool {
        let Some((p, path)) = self.code_leaf() else { return false };
        let empty = self.leaf_len(p.block, p.leaf) == 0;
        let at_doc_start = p.offset == 0 && self.prev_leaf(Pos { offset: 0, ..p }).is_none();
        if !empty && !at_doc_start {
            return false;
        }
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(p.block) else { return };
            if let Some(n) = tree::node_at_mut(nodes, &path) {
                if let Node::CodeBlock { code, .. } = n {
                    let text = std::mem::take(code);
                    *n = Node::para(if text.is_empty() { vec![] } else { vec![Inline::text(text)] });
                }
            }
            ed.put_caret(p.block, path.clone(), 0);
        });
        true
    }

    /// ProseMirror's `exitCode`: a paragraph after the code block, caret in
    /// it. Returns false outside a code block.
    pub fn exit_code(&mut self) -> bool {
        let Some((p, path)) = self.code_leaf() else { return false };
        self.break_undo();
        self.transact(p.block..p.block + 1, EditKind::Other, |ed| {
            let Some(nodes) = ed.nodes_mut(p.block) else { return };
            let (c, i) = tree::split_path(&path);
            let c = c.to_vec();
            if let Some(cont) = tree::container_mut(nodes, &c) {
                cont.insert(i + 1, Node::para(vec![]));
            }
            let mut np = c;
            np.push(i + 1);
            ed.put_caret(p.block, np, 0);
        });
        true
    }

    /// CodeBlock's ArrowDown (`exitOnArrowDown`): at the very end of a code
    /// block, go to the node after it, or make a paragraph if there is none.
    /// Returns false when the key should move the caret as usual.
    pub fn code_arrow_down(&mut self) -> bool {
        let Some((p, path)) = self.code_leaf() else { return false };
        if p.offset < self.leaf_len(p.block, p.leaf) {
            return false;
        }
        let (c, i) = tree::split_path(&path);
        let has_sibling = match path.len() {
            1 => i + 1 < self.doc.blocks[p.block].nodes().len() || p.block + 1 < self.block_count(),
            _ => self
                .doc
                .blocks
                .get(p.block)
                .and_then(|b| tree::container_of(&b.nodes().to_vec(), c).map(|cont| i + 1 < cont.len()))
                .unwrap_or(false),
        };
        if has_sibling {
            if let Some(next) = self.next_leaf(p) {
                self.set_caret(next, false);
                return true;
            }
            return false;
        }
        self.exit_code()
    }
}
