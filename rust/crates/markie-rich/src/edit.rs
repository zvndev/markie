//! Editing on the model, with no UI: a caret, a selection, typing, bold and
//! italic, headings, splitting and joining paragraphs. The GPUI example
//! (`examples/rich_editor.rs`) is a view over this; the tests drive it
//! directly.
//!
//! Spike scope: paragraphs and headings are editable. Other blocks are shown
//! and kept byte for byte, but not edited here.

use crate::document::Document;
use crate::model::{normalize_inlines, Inline, Marks, Node};

/// One position's worth of content in an editable block.
#[derive(Debug, Clone, PartialEq)]
pub enum Unit {
    Char(char, Marks),
    /// Math or a hard break: one unit the caret steps over.
    Atom(Inline),
}

impl Unit {
    pub fn display(&self) -> String {
        match self {
            Unit::Char(c, _) => c.to_string(),
            Unit::Atom(Inline::Math { source }) => source.clone(),
            Unit::Atom(Inline::HardBreak) => "\n".into(),
            Unit::Atom(Inline::Text { text, .. }) => text.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkKind {
    Bold,
    Italic,
}

fn get(m: &Marks, k: MarkKind) -> bool {
    match k {
        MarkKind::Bold => m.bold,
        MarkKind::Italic => m.italic,
    }
}

fn set(m: &mut Marks, k: MarkKind, on: bool) {
    match k {
        MarkKind::Bold => m.bold = on,
        MarkKind::Italic => m.italic = on,
    }
}

/// The text block kinds this editor edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextKind {
    Paragraph,
    Heading(u8),
}

pub fn text_block(nodes: &[Node]) -> Option<(TextKind, &[Inline])> {
    match nodes {
        [Node::Paragraph { content: c, .. }] => Some((TextKind::Paragraph, c)),
        [Node::Heading { level, content, .. }] => Some((TextKind::Heading(*level), content)),
        _ => None,
    }
}

pub fn flatten(inlines: &[Inline]) -> Vec<Unit> {
    let mut out = Vec::new();
    for i in inlines {
        match i {
            Inline::Text { text, marks } => out.extend(text.chars().map(|c| Unit::Char(c, marks.clone()))),
            other => out.push(Unit::Atom(other.clone())),
        }
    }
    out
}

pub fn unflatten(units: &[Unit]) -> Vec<Inline> {
    let mut out = Vec::new();
    for u in units {
        match u {
            Unit::Char(c, m) => out.push(Inline::Text { text: c.to_string(), marks: m.clone() }),
            Unit::Atom(a) => out.push(a.clone()),
        }
    }
    normalize_inlines(out)
}

pub struct RichEditor {
    pub doc: Document,
    /// Block index of the caret.
    pub active: usize,
    /// Caret, in units of the active block.
    pub caret: usize,
    /// Selection anchor in the active block, when a selection is open.
    pub anchor: Option<usize>,
    /// Marks the next typed text gets when there is no selection.
    pub typing: Option<Marks>,
}

impl RichEditor {
    pub fn new(doc: Document) -> RichEditor {
        let active = doc.blocks.iter().position(|b| text_block(b.nodes()).is_some()).unwrap_or(0);
        let mut ed = RichEditor { doc, active, caret: 0, anchor: None, typing: None };
        ed.caret = ed.units().len();
        ed
    }

    pub fn is_editable(&self, block: usize) -> bool {
        self.doc.blocks.get(block).is_some_and(|b| text_block(b.nodes()).is_some())
    }

    pub fn kind(&self) -> Option<TextKind> {
        self.doc.blocks.get(self.active).and_then(|b| text_block(b.nodes())).map(|(k, _)| k)
    }

    pub fn units(&self) -> Vec<Unit> {
        self.units_of(self.active)
    }

    pub fn units_of(&self, block: usize) -> Vec<Unit> {
        self.doc.blocks.get(block).and_then(|b| text_block(b.nodes())).map(|(_, c)| flatten(c)).unwrap_or_default()
    }

    fn store(&mut self, block: usize, kind: TextKind, units: &[Unit]) {
        let content = unflatten(units);
        let node = match kind {
            TextKind::Paragraph => Node::para(content),
            TextKind::Heading(level) => Node::heading(level, content),
        };
        self.doc.set_nodes(block, vec![node]);
    }

    pub fn selection(&self) -> Option<std::ops::Range<usize>> {
        let a = self.anchor?;
        if a == self.caret {
            return None;
        }
        Some(a.min(self.caret)..a.max(self.caret))
    }

    /// Activate a block (a click), caret at `caret` or its end.
    pub fn activate(&mut self, block: usize, caret: Option<usize>) {
        if !self.is_editable(block) {
            return;
        }
        self.active = block;
        let len = self.units().len();
        self.caret = caret.unwrap_or(len).min(len);
        self.anchor = None;
        self.typing = None;
    }

    fn delete_selection(&mut self, units: &mut Vec<Unit>) -> bool {
        if let Some(r) = self.selection() {
            units.drain(r.clone());
            self.caret = r.start;
            self.anchor = None;
            return true;
        }
        self.anchor = None;
        false
    }

    pub fn insert_text(&mut self, s: &str) {
        let Some(kind) = self.kind() else { return };
        let mut units = self.units();
        self.delete_selection(&mut units);
        let marks = self.typing.clone().unwrap_or_else(|| {
            // Typed text continues the marks before it, links aside.
            let mut m = match self.caret.checked_sub(1).and_then(|i| units.get(i)) {
                Some(Unit::Char(_, m)) => m.clone(),
                _ => Marks::default(),
            };
            m.link = None;
            m.code = false;
            m
        });
        for (k, c) in s.chars().enumerate() {
            units.insert(self.caret + k, Unit::Char(c, marks.clone()));
        }
        self.caret += s.chars().count();
        self.store(self.active, kind, &units);
    }

    pub fn backspace(&mut self) {
        let Some(kind) = self.kind() else { return };
        let mut units = self.units();
        if self.delete_selection(&mut units) {
            self.store(self.active, kind, &units);
            return;
        }
        if self.caret > 0 {
            units.remove(self.caret - 1);
            self.caret -= 1;
            self.store(self.active, kind, &units);
            return;
        }
        // At the start: join onto the previous editable block, if adjacent.
        if self.active > 0 && self.is_editable(self.active - 1) {
            let prev = self.active - 1;
            let (pkind, _) = text_block(self.doc.blocks[prev].nodes()).unwrap();
            let mut merged = self.units_of(prev);
            let at = merged.len();
            merged.extend(units);
            self.store(prev, pkind, &merged);
            self.doc.remove_block(self.active);
            self.active = prev;
            self.caret = at;
        }
    }

    /// Enter: split the block at the caret; the second half is a paragraph.
    pub fn split(&mut self) {
        let Some(kind) = self.kind() else { return };
        let mut units = self.units();
        self.delete_selection(&mut units);
        let tail = units.split_off(self.caret);
        self.store(self.active, kind, &units);
        self.doc.insert_block(self.active + 1, vec![Node::para(unflatten(&tail))]);
        self.active += 1;
        self.caret = 0;
        self.typing = None;
    }

    pub fn toggle_mark(&mut self, k: MarkKind) {
        let Some(kind) = self.kind() else { return };
        let mut units = self.units();
        match self.selection() {
            Some(r) => {
                let all = units[r.clone()].iter().all(|u| matches!(u, Unit::Char(_, m) if get(m, k)));
                for u in &mut units[r] {
                    if let Unit::Char(_, m) = u {
                        set(m, k, !all);
                    }
                }
                self.store(self.active, kind, &units);
            }
            None => {
                let mut m = self.typing.clone().unwrap_or_else(|| match self.caret.checked_sub(1).and_then(|i| units.get(i)) {
                    Some(Unit::Char(_, m)) => {
                        let mut m = m.clone();
                        m.link = None;
                        m
                    }
                    _ => Marks::default(),
                });
                let on = !get(&m, k);
                set(&mut m, k, on);
                self.typing = Some(m);
            }
        }
    }

    /// 0 makes a paragraph; 1 to 6 a heading.
    pub fn set_heading(&mut self, level: u8) {
        if self.kind().is_none() {
            return;
        }
        let units = self.units();
        let kind = if level == 0 { TextKind::Paragraph } else { TextKind::Heading(level.min(6)) };
        if Some(kind) != self.kind() {
            self.store(self.active, kind, &units);
        }
    }

    pub fn move_horizontal(&mut self, delta: isize, extend: bool) {
        if extend {
            self.anchor.get_or_insert(self.caret);
        } else if let Some(r) = self.selection() {
            self.caret = if delta < 0 { r.start } else { r.end };
            self.anchor = None;
            return;
        } else {
            self.anchor = None;
        }
        let len = self.units().len() as isize;
        let next = self.caret as isize + delta;
        if !extend && next < 0 {
            self.move_vertical(-1);
            self.caret = self.units().len();
            return;
        }
        if !extend && next > len {
            if self.move_vertical(1) {
                self.caret = 0;
            }
            return;
        }
        self.caret = next.clamp(0, len) as usize;
        self.typing = None;
    }

    /// To the previous or next editable block; false at the ends.
    pub fn move_vertical(&mut self, dir: isize) -> bool {
        let mut i = self.active as isize + dir;
        while i >= 0 && (i as usize) < self.doc.blocks.len() {
            if self.is_editable(i as usize) {
                self.active = i as usize;
                self.caret = self.caret.min(self.units().len());
                self.anchor = None;
                self.typing = None;
                return true;
            }
            i += dir;
        }
        false
    }

    pub fn to_markdown(&self) -> String {
        self.doc.to_markdown()
    }

    /// (blocks rewritten, blocks kept byte for byte).
    pub fn edit_counts(&self) -> (usize, usize) {
        let edited = self.doc.blocks.iter().filter(|b| b.edited).count();
        (edited, self.doc.blocks.len() - edited)
    }
}
