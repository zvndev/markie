//! Folding a room's content back onto the document the pane opened on.
//!
//! The room holds nodes only. To write a file, each source block that a run
//! of room nodes still equals keeps its bytes, and only the rest is
//! serialized. This is the structural form of TipTap's block preservation
//! (`rich-block-preserve.ts`): it compares models, not re-serialized text,
//! so it needs no normalizer and cannot be fooled by formatting.

use crate::document::{Block, BlockContent, Document};
use crate::model::Node;

/// Larger alignments fall back to a linear pass.
const MAX_CELLS: usize = 20_000_000;

impl Document {
    /// The document after the room's nodes replace its editable content.
    /// Opaque blocks (HTML, definitions) stay where they were.
    pub fn with_room_nodes(&self, incoming: &[Node]) -> Document {
        // TipTap's TrailingNode keeps an empty paragraph at the end of the
        // document. It belongs to the editor, not to the file.
        let mut incoming = incoming;
        while let Some((Node::Paragraph { content: c, .. }, rest)) = incoming.split_last() {
            if !c.is_empty() {
                break;
            }
            incoming = rest;
        }
        let base = &self.blocks;
        let n = base.len();
        let m = incoming.len();
        let matches_at = |i: usize, j: usize| -> bool {
            let nodes = base[i].nodes();
            !nodes.is_empty() && j + nodes.len() <= m && incoming[j..j + nodes.len()] == *nodes
        };

        // best[i][j]: most source blocks kept using base[i..] and incoming[j..].
        let mut plan: Vec<Step> = Vec::new();
        if (n + 1) * (m + 1) <= MAX_CELLS {
            let w = m + 1;
            let mut best = vec![0u32; (n + 1) * w];
            for i in (0..n).rev() {
                for j in (0..=m).rev() {
                    let v = if base[i].is_opaque() {
                        1 + best[(i + 1) * w + j]
                    } else {
                        let mut v = best[(i + 1) * w + j];
                        if j < m {
                            v = v.max(best[i * w + j + 1]);
                        }
                        if matches_at(i, j) {
                            v = v.max(1 + best[(i + 1) * w + j + base[i].nodes().len()]);
                        }
                        v
                    };
                    best[i * w + j] = v;
                }
            }
            let (mut i, mut j) = (0, 0);
            while i < n || j < m {
                if i < n && base[i].is_opaque() {
                    plan.push(Step::Keep(i));
                    i += 1;
                } else if i < n && matches_at(i, j) && best[i * w + j] == 1 + best[(i + 1) * w + j + base[i].nodes().len()] {
                    plan.push(Step::Keep(i));
                    j += base[i].nodes().len();
                    i += 1;
                } else if i < n && best[i * w + j] == best[(i + 1) * w + j] {
                    i += 1; // deleted in the room
                } else {
                    plan.push(Step::Insert(j));
                    j += 1;
                }
            }
        } else {
            let (mut i, mut j) = (0, 0);
            while i < n || j < m {
                if i < n && (base[i].is_opaque() || matches_at(i, j)) {
                    j += base[i].nodes().len();
                    plan.push(Step::Keep(i));
                    i += 1;
                } else if j < m {
                    plan.push(Step::Insert(j));
                    j += 1;
                } else {
                    i += 1;
                }
            }
        }

        let mut out = Document {
            front_matter: self.front_matter.clone(),
            leading: self.leading.clone(),
            blocks: vec![],
            ending: self.ending.clone(),
            end_origin: self.end_origin,
        };
        for step in plan {
            match step {
                Step::Keep(i) => out.blocks.push(base[i].clone()),
                Step::Insert(j) => out.blocks.push(Block {
                    source: String::new(),
                    trailing: "\n\n".into(),
                    content: BlockContent::Nodes(vec![incoming[j].clone()]),
                    edited: true,
                    origin: None,
                }),
            }
        }
        out
    }
}

enum Step {
    Keep(usize),
    Insert(usize),
}
