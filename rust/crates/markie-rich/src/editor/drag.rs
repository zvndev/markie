//! Dragging the selection to another place (ProseMirror's drag and drop of
//! a slice): the selected content moves there, or is copied with ⌥, and
//! lands selected. One undo step takes the whole move back.

use super::{EditKind, Editor, Pos, Step};
use crate::edit::unflatten;
use crate::model::Inline;

/// What is being moved. Within one leaf it is the units themselves, so
/// spaces at its ends and its marks travel exactly; across leaves it is
/// Markdown, as a cut and paste would carry it.
enum Slice {
    Inlines(Vec<Inline>),
    Plain(String),
    Markdown(String),
}

impl Editor {
    /// A position as one number across the whole document: every unit of
    /// every leaf, and one between leaves. Deleting a range from `a` to `b`
    /// shifts everything after it by `linear(b) - linear(a)`, joins
    /// included, which is what lets a drop point survive the delete.
    fn linear(&self, p: Pos) -> usize {
        let mut n = 0;
        for b in 0..self.block_count() {
            for l in 0..self.leaves_of(b).len() {
                if (b, l) == (p.block, p.leaf) {
                    return n + p.offset.min(self.leaf_len(b, l));
                }
                n += self.leaf_len(b, l) + 1;
            }
        }
        n
    }

    fn from_linear(&self, mut n: usize) -> Pos {
        let mut last = Pos::default();
        for b in 0..self.block_count() {
            for l in 0..self.leaves_of(b).len() {
                let len = self.leaf_len(b, l);
                if n <= len {
                    return Pos::new(b, l, n);
                }
                n -= len + 1;
                last = Pos::new(b, l, len);
            }
        }
        last
    }

    /// Move the selection to `target` (copy it when `copy`), and select what
    /// landed. Returns false, changing nothing, when there is no selection
    /// or the drop is inside it.
    pub fn move_selection_to(&mut self, target: Pos, copy: bool) -> bool {
        if !self.has_selection() {
            return false;
        }
        let target = self.clamp(target);
        let (from, to) = self.range();
        if from <= target && target <= to {
            return false;
        }
        let slice = if (from.block, from.leaf) == (to.block, to.leaf) {
            let units = self.units(from.block, from.leaf);
            let part = &units[from.offset.min(units.len())..to.offset.min(units.len())];
            match self.kind(from) {
                Some(k) if k.is_rich() => Slice::Inlines(unflatten(part)),
                Some(k) if k.is_plain() => Slice::Plain(part.iter().map(|u| u.display()).collect()),
                _ => Slice::Markdown(self.selection_markdown()),
            }
        } else {
            Slice::Markdown(self.selection_markdown())
        };
        if matches!(&slice, Slice::Markdown(m) | Slice::Plain(m) if m.is_empty()) {
            return false;
        }
        let blocks_before = self.doc.blocks.clone();
        let undo_before = self.undo.len();
        let sel_before = (self.anchor, self.head);

        let (lf, lt) = (self.linear(from), self.linear(to));
        let mut at = self.linear(target);
        if !copy {
            self.delete_forward();
            if at > lt {
                at -= lt - lf;
            }
        }
        let start = self.from_linear(at);
        self.set_caret(start, false);
        let into_plain = self.kind(start).is_some_and(|k| k.is_plain());
        match slice {
            Slice::Inlines(inlines) if into_plain => {
                let text: String = crate::edit::flatten(&inlines).iter().map(|u| u.display()).collect();
                self.insert_plain(&text);
            }
            Slice::Inlines(inlines) => self.insert_inlines(inlines),
            Slice::Plain(text) if into_plain => self.insert_plain(&text),
            Slice::Plain(text) | Slice::Markdown(text) => self.paste_markdown(&text),
        }
        let end = self.head;
        // The pasted slice may have split the block it landed in; its start
        // is still `at` units in, which nothing before it changed.
        let start = self.from_linear(at);
        self.set_selection(start, end);
        self.group_undo(undo_before, blocks_before, sel_before);
        true
    }

    /// Fold the steps recorded since `undo_before` into one, from the blocks
    /// as they were to the blocks as they are, trimmed to what differs.
    fn group_undo(&mut self, undo_before: usize, blocks_before: Vec<crate::document::Block>, sel_before: (Pos, Pos)) {
        if self.undo.len() <= undo_before + 1 {
            return;
        }
        self.undo.truncate(undo_before);
        let same = |a: &crate::document::Block, b: &crate::document::Block| a.source == b.source && a.content == b.content && a.edited == b.edited;
        let now = &self.doc.blocks;
        let mut prefix = 0;
        while prefix < now.len() && prefix < blocks_before.len() && same(&now[prefix], &blocks_before[prefix]) {
            prefix += 1;
        }
        let mut suffix = 0;
        while suffix < now.len() - prefix
            && suffix < blocks_before.len() - prefix
            && same(&now[now.len() - 1 - suffix], &blocks_before[blocks_before.len() - 1 - suffix])
        {
            suffix += 1;
        }
        let before = blocks_before[prefix..blocks_before.len() - suffix].to_vec();
        let after_len = now.len() - prefix - suffix;
        self.undo.push(Step { start: prefix, before, after_len, sel_before, sel_after: (self.anchor, self.head), kind: EditKind::Other });
        self.coalesce = false;
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Editor, Pos};

    fn select(ed: &mut Editor, a: Pos, b: Pos) {
        ed.set_selection(a, b);
    }

    #[test]
    fn a_word_dragged_later_in_its_paragraph_moves_there() {
        let mut ed = Editor::parse("one two three\n");
        select(&mut ed, Pos::new(0, 0, 0), Pos::new(0, 0, 4));
        assert!(ed.move_selection_to(Pos::new(0, 0, 8), false));
        assert_eq!(ed.to_markdown(), "two one three\n");
        assert_eq!(ed.selection_text(), "one ");
        assert!(ed.undo());
        assert_eq!(ed.to_markdown(), "one two three\n");
    }

    #[test]
    fn a_word_dragged_earlier_moves_there_and_keeps_its_marks() {
        let mut ed = Editor::parse("Start here.\n\nSome **bold** words.\n");
        // "bold " in the second paragraph: units 5..10.
        select(&mut ed, Pos::new(1, 0, 5), Pos::new(1, 0, 10));
        assert!(ed.move_selection_to(Pos::new(0, 0, 0), false));
        assert_eq!(ed.to_markdown(), "**bold** Start here.\n\nSome words.\n");
        assert!(ed.undo());
        assert_eq!(ed.to_markdown(), "Start here.\n\nSome **bold** words.\n");
    }

    #[test]
    fn a_drop_into_a_later_paragraph_lands_at_the_drop_point() {
        let mut ed = Editor::parse("alpha beta\n\ngamma delta\n");
        select(&mut ed, Pos::new(0, 0, 6), Pos::new(0, 0, 10));
        assert!(ed.move_selection_to(Pos::new(1, 0, 6), false));
        // A paragraph's trailing space is not written, as in TipTap.
        assert_eq!(ed.to_markdown(), "alpha\n\ngamma betadelta\n");
        assert_eq!(ed.selection_text(), "beta");
    }

    #[test]
    fn option_drag_copies() {
        let mut ed = Editor::parse("copy me\n");
        select(&mut ed, Pos::new(0, 0, 0), Pos::new(0, 0, 4));
        assert!(ed.move_selection_to(Pos::new(0, 0, 7), true));
        assert_eq!(ed.to_markdown(), "copy mecopy\n");
    }

    #[test]
    fn a_drop_inside_the_selection_does_nothing() {
        let mut ed = Editor::parse("stay put\n");
        select(&mut ed, Pos::new(0, 0, 0), Pos::new(0, 0, 4));
        assert!(!ed.move_selection_to(Pos::new(0, 0, 2), false));
        assert_eq!(ed.to_markdown(), "stay put\n");
        assert!(!ed.can_undo());
    }

    #[test]
    fn whole_paragraphs_move_across_blocks_with_one_undo() {
        let src = "First.\n\nSecond.\n\nThird.\n";
        let mut ed = Editor::parse(src);
        select(&mut ed, Pos::new(0, 0, 0), Pos::new(1, 0, 7));
        assert!(ed.move_selection_to(Pos::new(2, 0, 6), false));
        let moved = ed.to_markdown();
        // ProseMirror's semantics: deleting from the start of one paragraph
        // to the end of the next leaves one empty paragraph, and the open
        // slice joins the paragraph it lands at the end of.
        assert_eq!(moved, "\n\nThird.First.\n\nSecond.\n");
        assert!(ed.undo());
        assert_eq!(ed.to_markdown(), src);
        assert!(!ed.can_undo());
    }
}
