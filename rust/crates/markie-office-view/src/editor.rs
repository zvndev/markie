//! The editing model behind the Word page view. No GPUI: every rule here is
//! unit tested. Ported from `word-document-editor.tsx`, `word-input.ts` and
//! `word-selection.ts`.
//!
//! The engine is the truth. Typing inside one paragraph becomes run text edits
//! (`replace_rich_text`), so untouched runs keep their XML. Paragraph breaks,
//! joins and cross-paragraph edits go through the engine's source-preserving
//! range edit, which only DOCX has. RTF and ODT split paragraphs with
//! replace-paragraph and insert-paragraph, as the Electron editor does.
//!
//! Every offset here is a UTF-8 byte offset into `Paragraph::text`, on a
//! grapheme boundary. The view converts to UTF-16 only at the platform edge.

use std::collections::HashSet;

use markie_office::docx::inspect_docx_bitmap;
use markie_office::model::*;
use markie_office::rich_document::{
    Capabilities, OfficeDocument, apply_rich_operations, export_rich_document, replace_rich_range, replace_rich_text,
    rich_capabilities,
};

use crate::text::{next_boundary, prev_boundary, snap_back};

const UNDO_LIMIT: usize = 100;

/// Pictures larger than this are refused before decoding, as in Electron.
pub const MAX_PICTURE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
struct Snapshot {
    doc: OfficeDocument,
    anchor: TextPosition,
    focus: TextPosition,
    generation: u64,
}

/// A value shared by every selected run, or a mix.
#[derive(Clone, Debug, PartialEq)]
pub enum Common<T> {
    Nothing,
    Mixed,
    Value(T),
}

impl<T: PartialEq + Clone> Common<T> {
    fn of(values: impl IntoIterator<Item = T>) -> Self {
        let mut out = Common::Nothing;
        for value in values {
            out = match out {
                Common::Nothing => Common::Value(value),
                Common::Value(v) if v == value => Common::Value(v),
                _ => return Common::Mixed,
            };
        }
        out
    }
    pub fn value(&self) -> Option<&T> {
        match self {
            Common::Value(v) => Some(v),
            _ => None,
        }
    }
}

/// What the Format menu and the font tool show for the selection.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectionFormat {
    pub bold: Common<bool>,
    pub italic: Common<bool>,
    pub underline: Common<bool>,
    pub font_family: Common<Option<String>>,
    pub font_size_points: Common<Option<f64>>,
    pub color: Common<Option<String>>,
}

/// The dialogs opened from the menus. The view shows them as a side panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Font,
    Picture,
    Table,
    Link,
    Page,
    Spacing,
    Review,
}

impl Tool {
    pub fn title(self) -> &'static str {
        match self {
            Tool::Font => "Font",
            Tool::Picture => "Picture",
            Tool::Table => "Table",
            Tool::Link => "Link and Page Breaks",
            Tool::Page => "Page Setup",
            Tool::Spacing => "Paragraph Spacing",
            Tool::Review => "Document Review",
        }
    }
}

/// What a menu command asks the view to do after the model has run it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Ignored,
    Open(Tool),
}

pub struct WordEditor {
    doc: OfficeDocument,
    generation: u64,
    next_generation: u64,
    saved_generation: u64,
    pub anchor: TextPosition,
    pub focus: TextPosition,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    /// Review: edits inside a paragraph become tracked text changes.
    pub tracking: bool,
    pub review_author: String,
    /// Review: show text with tracked insertions rejected. Read-only.
    pub original_view: bool,
    /// The last refused change, shown in a banner until the next good edit.
    pub error: Option<String>,
    /// The host forces read-only (a DOC text view, for example).
    pub host_read_only: bool,
}

fn message(error: markie_office::OfficeError) -> String {
    error.message
}

fn splice(text: &str, start: usize, end: usize, insert: &str) -> String {
    format!("{}{}{}", &text[..start], insert, &text[end..])
}

/// Private input adapter, ported from `word-input.ts`: the run text edits that
/// replace `start..end` of a paragraph with `text`, and the caret after.
/// Source-owned runs stay authoritative; a run that is protected, linked or
/// holds a page break is refused rather than rewritten.
pub fn paragraph_input(paragraph: &Paragraph, start: usize, end: usize, text: &str) -> Result<(Vec<TextEdit>, usize), String> {
    let refuse = || Err("This input cannot safely edit the selected text. Select editable text within one paragraph.".to_string());
    let value = &paragraph.text;
    if start > end || end > value.len() || text.contains(['\r', '\n', '\t']) || !paragraph.revision_ids.is_empty() {
        return refuse();
    }
    if snap_back(value, start) != start || snap_back(value, end) != end {
        return refuse();
    }
    if &value[start..end] == text {
        return Ok((Vec::new(), start + text.len()));
    }
    let mut edits = Vec::new();
    let mut offset = 0;
    let mut inserted = false;
    for run in &paragraph.runs {
        let from = offset;
        let to = offset + run.text.len();
        offset = to;
        let overlap = from < end && to > start;
        let insertion = !inserted && ((start >= from && start < to) || (start == value.len() && to == start));
        if !overlap && !insertion {
            continue;
        }
        if !run.can_edit || run.hyperlink_id.is_some() || !run.page_breaks.is_empty() {
            return refuse();
        }
        let head_end = start.saturating_sub(from).min(run.text.len());
        let tail_start = end.saturating_sub(from).min(run.text.len());
        let next = format!("{}{}{}", &run.text[..head_end], if inserted { "" } else { text }, &run.text[tail_start..]);
        inserted = true;
        if next != run.text {
            edits.push(TextEdit { run_id: run.id.clone(), text: next });
        }
    }
    if !inserted {
        return refuse();
    }
    Ok((edits, start + text.len()))
}

/// The selected text, paragraphs joined with newlines (`wordRangeText`).
pub fn range_text(doc: &RichDocument, start: &TextPosition, end: &TextPosition) -> String {
    let index = |id: &str| doc.paragraphs.iter().position(|p| p.id == id);
    let (Some(first), Some(last)) = (index(&start.paragraph_id), index(&end.paragraph_id)) else { return String::new() };
    let count = last + 1 - first;
    doc.paragraphs[first..=last]
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let a = if i == 0 { start.offset.min(p.text.len()) } else { 0 };
            let b = if i == count - 1 { end.offset.min(p.text.len()) } else { p.text.len() };
            &p.text[a..b.max(a)]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl WordEditor {
    pub fn new(doc: OfficeDocument) -> Self {
        let start = TextPosition { paragraph_id: doc.paragraphs.first().map(|p| p.id.clone()).unwrap_or_default(), offset: 0 };
        WordEditor {
            doc,
            generation: 0,
            next_generation: 1,
            saved_generation: 0,
            anchor: start.clone(),
            focus: start,
            undo: Vec::new(),
            redo: Vec::new(),
            tracking: false,
            review_author: "You".into(),
            original_view: false,
            error: None,
            host_read_only: false,
        }
    }

    pub fn doc(&self) -> &OfficeDocument {
        &self.doc
    }

    pub fn rich(&self) -> &RichDocument {
        &self.doc
    }

    pub fn capabilities(&self) -> Capabilities {
        rich_capabilities(&self.doc)
    }

    pub fn is_docx(&self) -> bool {
        self.doc.format == Format::Docx
    }

    /// Unsaved changes since open or the last save.
    pub fn is_dirty(&self) -> bool {
        self.generation != self.saved_generation
    }

    pub fn mark_saved(&mut self) {
        self.saved_generation = self.generation;
    }

    /// The bytes to save. An untouched or reverted document is its original file.
    pub fn export(&self) -> Result<Vec<u8>, String> {
        export_rich_document(&self.doc).map_err(message)
    }

    pub fn can_undo(&self) -> bool {
        self.can_mutate() && !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        self.can_mutate() && !self.redo.is_empty()
    }

    /// Whether edits may reach the engine right now.
    pub fn can_mutate(&self) -> bool {
        self.doc.can_edit && !self.original_view && !self.host_read_only
    }

    // ----- selection ------------------------------------------------------

    pub fn paragraph_index(&self, id: &str) -> Option<usize> {
        self.doc.paragraphs.iter().position(|p| p.id == id)
    }

    pub fn paragraph(&self, id: &str) -> Option<&Paragraph> {
        self.doc.paragraph(id)
    }

    /// The text and runs as shown: the original text in the Original view.
    pub fn shown(&self, paragraph: &Paragraph) -> (String, Vec<Run>) {
        if self.original_view
            && let Some(runs) = &paragraph.original_runs
        {
            return (paragraph.original_text.clone().unwrap_or_else(|| paragraph.text.clone()), runs.clone());
        }
        (paragraph.text.clone(), paragraph.runs.clone())
    }

    fn shown_text(&self, id: &str) -> String {
        self.paragraph(id).map(|p| self.shown(p).0).unwrap_or_default()
    }

    pub fn is_collapsed(&self) -> bool {
        self.anchor == self.focus
    }

    pub fn is_cross(&self) -> bool {
        self.anchor.paragraph_id != self.focus.paragraph_id
    }

    /// The selection in document order.
    pub fn ordered(&self) -> (TextPosition, TextPosition) {
        let a = self.paragraph_index(&self.anchor.paragraph_id).unwrap_or(0);
        let b = self.paragraph_index(&self.focus.paragraph_id).unwrap_or(0);
        if a < b || (a == b && self.anchor.offset <= self.focus.offset) {
            (self.anchor.clone(), self.focus.clone())
        } else {
            (self.focus.clone(), self.anchor.clone())
        }
    }

    /// The selected byte range inside one paragraph, if the selection touches it.
    pub fn selection_in(&self, paragraph_id: &str) -> Option<(usize, usize)> {
        if self.is_collapsed() {
            return None;
        }
        let (start, end) = self.ordered();
        let index = self.paragraph_index(paragraph_id)?;
        let first = self.paragraph_index(&start.paragraph_id)?;
        let last = self.paragraph_index(&end.paragraph_id)?;
        if index < first || index > last {
            return None;
        }
        let len = self.shown_text(paragraph_id).len();
        let a = if index == first { start.offset.min(len) } else { 0 };
        let b = if index == last { end.offset.min(len) } else { len };
        Some((a, b))
    }

    fn clamp(&self, position: &TextPosition) -> TextPosition {
        match self.paragraph(&position.paragraph_id) {
            Some(p) => {
                let text = self.shown(p).0;
                TextPosition { paragraph_id: p.id.clone(), offset: snap_back(&text, position.offset) }
            }
            None => TextPosition { paragraph_id: self.doc.paragraphs.first().map(|p| p.id.clone()).unwrap_or_default(), offset: 0 },
        }
    }

    /// Put the caret (and the anchor too, unless extending).
    pub fn set_caret(&mut self, position: TextPosition, extend: bool) {
        let position = self.clamp(&position);
        if !extend {
            self.anchor = position.clone();
        }
        self.focus = position;
    }

    pub fn select(&mut self, anchor: TextPosition, focus: TextPosition) {
        self.anchor = self.clamp(&anchor);
        self.focus = self.clamp(&focus);
    }

    pub fn select_all(&mut self) {
        let (Some(first), Some(last)) = (self.doc.paragraphs.first(), self.doc.paragraphs.last()) else { return };
        let end = self.shown(last).0.len();
        self.anchor = TextPosition { paragraph_id: first.id.clone(), offset: 0 };
        self.focus = TextPosition { paragraph_id: last.id.clone(), offset: end };
    }

    /// Left or Right by one grapheme, crossing paragraph ends. Without Shift a
    /// selection collapses to its edge first, as text fields do.
    pub fn move_horizontal(&mut self, forward: bool, extend: bool) {
        if !extend && !self.is_collapsed() {
            let (start, end) = self.ordered();
            let edge = if forward { end } else { start };
            self.set_caret(edge, false);
            return;
        }
        let target = self.step(&self.focus, forward);
        self.set_caret(target, extend);
    }

    fn step(&self, from: &TextPosition, forward: bool) -> TextPosition {
        let text = self.shown_text(&from.paragraph_id);
        let index = self.paragraph_index(&from.paragraph_id).unwrap_or(0);
        if forward {
            if from.offset < text.len() {
                return TextPosition { paragraph_id: from.paragraph_id.clone(), offset: next_boundary(&text, from.offset) };
            }
            if let Some(next) = self.doc.paragraphs.get(index + 1) {
                return TextPosition { paragraph_id: next.id.clone(), offset: 0 };
            }
        } else {
            if from.offset > 0 {
                return TextPosition { paragraph_id: from.paragraph_id.clone(), offset: prev_boundary(&text, from.offset) };
            }
            if index > 0 {
                let prev = &self.doc.paragraphs[index - 1];
                return TextPosition { paragraph_id: prev.id.clone(), offset: self.shown(prev).0.len() };
            }
        }
        from.clone()
    }

    /// Option-Left and Option-Right.
    pub fn move_word(&mut self, forward: bool, extend: bool) {
        let text = self.shown_text(&self.focus.paragraph_id);
        let offset = self.focus.offset;
        let at_edge = if forward { offset >= text.len() } else { offset == 0 };
        if at_edge {
            let target = self.step(&self.focus, forward);
            self.set_caret(target, extend);
            return;
        }
        let next = if forward { crate::text::next_word(&text, offset) } else { crate::text::prev_word(&text, offset) };
        self.set_caret(TextPosition { paragraph_id: self.focus.paragraph_id.clone(), offset: next }, extend);
    }

    /// Cmd-Up and Cmd-Down.
    pub fn move_to_document_edge(&mut self, end: bool, extend: bool) {
        let paragraph = if end { self.doc.paragraphs.last() } else { self.doc.paragraphs.first() };
        let Some(paragraph) = paragraph else { return };
        let offset = if end { self.shown(paragraph).0.len() } else { 0 };
        let target = TextPosition { paragraph_id: paragraph.id.clone(), offset };
        self.set_caret(target, extend);
    }

    // ----- history ----------------------------------------------------------

    fn perform(&mut self, next: OfficeDocument, after: Option<TextRange>) {
        let prior = std::mem::replace(&mut self.doc, next);
        self.undo.push(Snapshot { doc: prior, anchor: self.anchor.clone(), focus: self.focus.clone(), generation: self.generation });
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.generation = self.next_generation;
        self.next_generation += 1;
        if let Some(range) = after {
            self.anchor = range.anchor;
            self.focus = range.focus;
        }
        self.anchor = self.clamp(&self.anchor);
        self.focus = self.clamp(&self.focus);
        self.error = None;
    }

    fn reject(&mut self, reason: impl Into<String>) {
        let reason = reason.into();
        let reason = reason.trim_end();
        self.error = Some(if reason.ends_with('.') { format!("{reason} The change was not applied.") } else { format!("{reason}. The change was not applied.") });
    }

    fn restore(&mut self, from_undo: bool) {
        if !self.can_mutate() {
            return;
        }
        let Some(snapshot) = (if from_undo { self.undo.pop() } else { self.redo.pop() }) else { return };
        let current = Snapshot {
            doc: std::mem::replace(&mut self.doc, snapshot.doc),
            anchor: self.anchor.clone(),
            focus: self.focus.clone(),
            generation: self.generation,
        };
        if from_undo { self.redo.push(current) } else { self.undo.push(current) }
        self.generation = snapshot.generation;
        self.anchor = self.clamp(&snapshot.anchor);
        self.focus = self.clamp(&snapshot.focus);
        self.error = None;
    }

    pub fn undo(&mut self) {
        self.restore(true);
    }

    pub fn redo(&mut self) {
        self.restore(false);
    }

    /// Run engine operations as one undo step.
    pub fn apply(&mut self, operations: Vec<Operation>) -> bool {
        self.apply_then(operations, None)
    }

    fn apply_then(&mut self, operations: Vec<Operation>, after: Option<TextRange>) -> bool {
        if !self.can_mutate() || operations.is_empty() {
            return false;
        }
        match apply_rich_operations(&self.doc, &operations) {
            Ok(next) => {
                self.perform(next, after);
                true
            }
            Err(error) => {
                self.reject(error.message);
                false
            }
        }
    }

    // ----- typing ---------------------------------------------------------

    /// Replace the selection with `text` (typing, paste, IME commit, Enter).
    pub fn replace_selection(&mut self, text: &str) -> bool {
        let (start, end) = self.ordered();
        self.replace_range(start, end, text)
    }

    pub fn replace_range(&mut self, start: TextPosition, end: TextPosition, text: &str) -> bool {
        if !self.can_mutate() {
            return false;
        }
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        if start.paragraph_id == end.paragraph_id && !text.contains('\n') {
            return self.replace_in_paragraph(&start.paragraph_id, start.offset, end.offset, &text);
        }
        if self.tracking {
            self.reject("Turn off paragraph text tracking before structural or cross-paragraph editing.");
            return false;
        }
        if self.is_docx() {
            return self.replace_structural(start, end, &text);
        }
        if start.paragraph_id != end.paragraph_id {
            self.reject("Editing across paragraphs is supported for Word documents only.");
            return false;
        }
        self.paste_paragraphs(&start.paragraph_id, start.offset, end.offset, &text)
    }

    fn replace_in_paragraph(&mut self, paragraph_id: &str, start: usize, end: usize, text: &str) -> bool {
        let Some(paragraph) = self.paragraph(paragraph_id).cloned() else { return false };
        let caret = |offset: usize| {
            let p = TextPosition { paragraph_id: paragraph_id.to_string(), offset };
            TextRange { anchor: p.clone(), focus: p }
        };
        if self.tracking {
            let images = self.doc.images.iter().any(|i| i.paragraph_id == paragraph_id);
            if paragraph.runs.len() != 1
                || paragraph.original_runs.as_ref().is_some_and(|r| r.len() > 1)
                || paragraph.runs.iter().any(|r| r.hyperlink_id.is_some() || !r.page_breaks.is_empty())
                || images
            {
                self.reject("Text tracking cannot safely replace mixed formatting or inline-owned content.");
                return false;
            }
            if start > end || end > paragraph.text.len() || text.contains('\t') {
                self.reject("This input cannot safely edit the selected text.");
                return false;
            }
            let next = splice(&paragraph.text, start, end, text);
            if next == paragraph.text {
                self.select(caret(start + text.len()).anchor, caret(start + text.len()).focus);
                return true;
            }
            let author = self.review_author.trim().to_string();
            if author.is_empty() {
                self.reject("Enter a revision author before tracking text.");
                return false;
            }
            return self.apply_then(vec![Operation::TrackParagraphText { paragraph_id: paragraph_id.into(), text: next, author }], Some(caret(start + text.len())));
        }
        if !paragraph.revision_ids.is_empty() {
            self.reject("This paragraph has tracked changes. Accept or reject them, or turn on paragraph text tracking, before editing it.");
            return false;
        }
        match paragraph_input(&paragraph, start, end, text) {
            Ok((edits, after)) if edits.is_empty() => {
                let range = caret(after);
                self.select(range.anchor, range.focus);
                true
            }
            Ok((edits, after)) => match replace_rich_text(&self.doc, &edits) {
                Ok(next) => {
                    self.perform(next, Some(caret(after)));
                    true
                }
                Err(error) => {
                    self.reject(error.message);
                    false
                }
            },
            // A Word paragraph with no runs, or a run the adapter refuses,
            // still has the engine's source-preserving range edit.
            Err(_) if self.is_docx() && !text.contains('\t') => self.replace_structural(
                TextPosition { paragraph_id: paragraph_id.into(), offset: start },
                TextPosition { paragraph_id: paragraph_id.into(), offset: end },
                text,
            ),
            Err(reason) => {
                self.reject(reason);
                false
            }
        }
    }

    fn replace_structural(&mut self, start: TextPosition, end: TextPosition, text: &str) -> bool {
        let range = TextRange { anchor: start, focus: end };
        match replace_rich_range(&self.doc, &range, text) {
            Ok((next, selection)) => {
                if next.revision == self.doc.revision {
                    self.select(selection.anchor, selection.focus);
                    self.error = None;
                } else {
                    self.perform(next, Some(selection));
                }
                true
            }
            Err(error) => {
                self.reject(error.message);
                false
            }
        }
    }

    /// RTF and ODT paragraph breaks and multi-line paste (`pasteParagraphs`).
    fn paste_paragraphs(&mut self, paragraph_id: &str, start: usize, end: usize, text: &str) -> bool {
        let doc = self.doc.clone();
        let Some(paragraph) = doc.paragraph(paragraph_id).cloned() else { return false };
        let plain = paragraph.runs.len() == 1
            && paragraph.runs.iter().all(|r| {
                r.can_edit && r.hyperlink_id.is_none() && r.page_breaks.is_empty() && r.resolved_style.as_ref().is_none_or(|s| *s == r.style)
            })
            && paragraph.revision_ids.is_empty()
            && paragraph.style_id.is_none()
            && paragraph.list_kind.is_none()
            && paragraph.alignment.as_deref().is_none_or(|a| a == "left")
            && paragraph.spacing_before_points.is_none_or(|v| v == 0.0)
            && paragraph.spacing_after_points.is_none_or(|v| v == 0.0)
            && paragraph.line_spacing_multiple.is_none_or(|v| v == 1.0)
            && !doc.images.iter().any(|i| i.paragraph_id == paragraph_id)
            && !doc.comments.iter().any(|c| c.paragraph_id == paragraph_id);
        if !plain {
            self.reject("Rich paragraph breaks and multiline paste need source-safe structural editing. The existing formatting and content were preserved.");
            return false;
        }
        if start > end || end > paragraph.text.len() || snap_back(&paragraph.text, start) != start || snap_back(&paragraph.text, end) != end {
            return false;
        }
        let lines: Vec<&str> = text.split('\n').collect();
        let result = (|| -> markie_office::Result<(OfficeDocument, String)> {
            let mut next = apply_rich_operations(&doc, &[Operation::ReplaceParagraph { paragraph_id: paragraph_id.into(), text: format!("{}{}", &paragraph.text[..start], lines[0]) }])?;
            let mut after = paragraph_id.to_string();
            for (index, line) in lines.iter().enumerate().skip(1) {
                let before: HashSet<String> = next.paragraphs.iter().map(|p| p.id.clone()).collect();
                let tail = if index == lines.len() - 1 { &paragraph.text[end..] } else { "" };
                next = apply_rich_operations(&next, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After(after.clone()), text: format!("{line}{tail}") }])?;
                let inserted = next.paragraphs.iter().find(|p| !before.contains(&p.id)).map(|p| p.id.clone()).unwrap_or_default();
                after = inserted;
                let style = paragraph.runs[0].style.clone();
                if let Some(run) = next.paragraph(&after).and_then(|p| p.runs.first()).map(|r| r.id.clone()) {
                    let format = RunFormat {
                        bold: style.bold.map(Some),
                        italic: style.italic.map(Some),
                        underline: style.underline.clone().map(Some),
                        color: style.color.clone().map(Some),
                        font_family: style.font_family.clone().map(Some),
                        font_size_points: style.font_size_points.map(Some),
                    };
                    if format != RunFormat::default() {
                        next = apply_rich_operations(&next, &[Operation::FormatRun { run_id: run, style: format }])?;
                    }
                }
            }
            Ok((next, after))
        })();
        match result {
            Ok((next, after)) => {
                let caret = TextPosition { paragraph_id: after, offset: lines.last().map_or(0, |l| l.len()) };
                self.perform(next, Some(TextRange { anchor: caret.clone(), focus: caret }));
                true
            }
            Err(error) => {
                self.reject(error.message);
                false
            }
        }
    }

    /// Backspace: the selection, else one grapheme back, else a join (Word).
    pub fn backspace(&mut self) -> bool {
        if !self.is_collapsed() {
            return self.replace_selection("");
        }
        let focus = self.focus.clone();
        if focus.offset == 0 {
            let index = self.paragraph_index(&focus.paragraph_id).unwrap_or(0);
            if !self.is_docx() || index == 0 || self.tracking {
                return false;
            }
            let prev = &self.doc.paragraphs[index - 1];
            let start = TextPosition { paragraph_id: prev.id.clone(), offset: prev.text.len() };
            return self.replace_range(start, focus, "");
        }
        let text = self.shown_text(&focus.paragraph_id);
        let start = TextPosition { paragraph_id: focus.paragraph_id.clone(), offset: prev_boundary(&text, focus.offset) };
        self.replace_range(start, focus, "")
    }

    /// Forward Delete: the selection, else one grapheme on, else a join (Word).
    pub fn delete_forward(&mut self) -> bool {
        if !self.is_collapsed() {
            return self.replace_selection("");
        }
        let focus = self.focus.clone();
        let text = self.shown_text(&focus.paragraph_id);
        if focus.offset >= text.len() {
            let index = self.paragraph_index(&focus.paragraph_id).unwrap_or(0);
            let Some(next) = self.doc.paragraphs.get(index + 1) else { return false };
            if !self.is_docx() || self.tracking {
                return false;
            }
            let end = TextPosition { paragraph_id: next.id.clone(), offset: 0 };
            return self.replace_range(focus, end, "");
        }
        let end = TextPosition { paragraph_id: focus.paragraph_id.clone(), offset: next_boundary(&text, focus.offset) };
        self.replace_range(focus, end, "")
    }

    /// Enter splits the paragraph at the caret.
    pub fn split(&mut self) -> bool {
        self.replace_selection("\n")
    }

    // ----- clipboard ------------------------------------------------------

    /// Copy is allowed in every view, read-only included.
    pub fn copy_text(&self) -> Option<String> {
        if self.is_collapsed() {
            return None;
        }
        let (start, end) = self.ordered();
        if self.original_view && start.paragraph_id == end.paragraph_id {
            let text = self.shown_text(&start.paragraph_id);
            return Some(text[start.offset.min(text.len())..end.offset.min(text.len())].to_string());
        }
        Some(range_text(&self.doc, &start, &end))
    }

    pub fn cut(&mut self) -> Option<String> {
        let text = self.copy_text()?;
        if self.replace_selection("") { Some(text) } else { None }
    }

    pub fn paste(&mut self, text: &str) -> bool {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        if text.is_empty() {
            return false;
        }
        self.replace_selection(&text)
    }

    // ----- formatting -----------------------------------------------------

    /// The run the caret is in (`syncSelection`): the first run whose end is
    /// past the caret, else the last run.
    pub fn caret_run(&self) -> Option<&Run> {
        let paragraph = self.paragraph(&self.focus.paragraph_id)?;
        let mut offset = 0;
        paragraph
            .runs
            .iter()
            .find(|run| {
                offset += run.text.len();
                offset > self.focus.offset
            })
            .or(paragraph.runs.last())
    }

    /// The runs a format command would change.
    pub fn selected_runs(&self) -> Vec<&Run> {
        if self.is_collapsed() {
            return self.caret_run().into_iter().collect();
        }
        let (start, end) = self.ordered();
        let first = self.paragraph_index(&start.paragraph_id).unwrap_or(0);
        let last = self.paragraph_index(&end.paragraph_id).unwrap_or(first);
        let mut out = Vec::new();
        for (index, paragraph) in self.doc.paragraphs.iter().enumerate().take(last + 1).skip(first) {
            let a = if index == first { start.offset } else { 0 };
            let b = if index == last { end.offset } else { paragraph.text.len() };
            let mut offset = 0;
            for run in &paragraph.runs {
                let from = offset;
                offset += run.text.len();
                if offset > a && from < b {
                    out.push(run);
                }
            }
        }
        out
    }

    pub fn selection_format(&self) -> SelectionFormat {
        let styles: Vec<RunStyle> = self.selected_runs().into_iter().map(|r| r.resolved_style.clone().unwrap_or_else(|| r.style.clone())).collect();
        SelectionFormat {
            bold: Common::of(styles.iter().map(|s| s.bold == Some(true))),
            italic: Common::of(styles.iter().map(|s| s.italic == Some(true))),
            underline: Common::of(styles.iter().map(|s| s.underline.as_deref().is_some_and(|u| u != "none"))),
            font_family: Common::of(styles.iter().map(|s| s.font_family.clone())),
            font_size_points: Common::of(styles.iter().map(|s| s.font_size_points)),
            color: Common::of(styles.iter().map(|s| s.color.as_ref().map(|c| c.to_ascii_lowercase()))),
        }
    }

    fn body_paragraph_ids(&self) -> HashSet<&str> {
        self.doc
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(id) => Some(id.as_str()),
                Block::Table(_) => None,
            })
            .collect()
    }

    /// Whether the selection can take run formatting (`editableSelection`).
    pub fn can_format_runs(&self) -> bool {
        let runs = self.selected_runs();
        self.can_mutate() && self.capabilities().run_formatting && !runs.is_empty() && runs.iter().all(|r| r.can_edit)
    }

    /// Format the selected text, or the caret's run (`formatRun`).
    pub fn format_selection(&mut self, style: RunFormat) -> bool {
        if !self.can_format_runs() {
            return false;
        }
        let range = TextRange { anchor: self.anchor.clone(), focus: self.focus.clone() };
        if self.is_cross() {
            let (start, end) = self.ordered();
            let first = self.paragraph_index(&start.paragraph_id).unwrap_or(0);
            let last = self.paragraph_index(&end.paragraph_id).unwrap_or(first);
            let body = self.body_paragraph_ids();
            if self.doc.paragraphs[first..=last].iter().any(|p| !body.contains(p.id.as_str())) {
                self.reject("Cross-table formatting is not supported.");
                return false;
            }
            let operations = self.doc.paragraphs[first..=last]
                .iter()
                .enumerate()
                .filter_map(|(i, p)| {
                    let a = if i == 0 { start.offset } else { 0 };
                    let b = if first + i == last { end.offset } else { p.text.len() };
                    (a != b).then(|| Operation::FormatRange { paragraph_id: p.id.clone(), start: a, end: b, style: style.clone() })
                })
                .collect();
            return self.apply_then(operations, Some(range));
        }
        if !self.is_collapsed() {
            let (start, end) = self.ordered();
            return self.apply_then(vec![Operation::FormatRange { paragraph_id: start.paragraph_id, start: start.offset, end: end.offset, style }], Some(range));
        }
        let Some(run) = self.caret_run().filter(|r| r.can_edit).map(|r| r.id.clone()) else { return false };
        self.apply_then(vec![Operation::FormatRun { run_id: run, style }], Some(range))
    }

    pub fn toggle_bold(&mut self) -> bool {
        let on = self.selection_format().bold != Common::Value(true);
        self.format_selection(RunFormat { bold: Some(Some(on)), ..Default::default() })
    }

    pub fn toggle_italic(&mut self) -> bool {
        let on = self.selection_format().italic != Common::Value(true);
        self.format_selection(RunFormat { italic: Some(Some(on)), ..Default::default() })
    }

    pub fn toggle_underline(&mut self) -> bool {
        let value = if self.selection_format().underline == Common::Value(true) { "none" } else { "single" };
        self.format_selection(RunFormat { underline: Some(Some(value.into())), ..Default::default() })
    }

    pub fn clear_formatting(&mut self) -> bool {
        self.format_selection(RunFormat {
            bold: Some(None),
            italic: Some(None),
            underline: Some(None),
            color: Some(None),
            font_family: Some(None),
            font_size_points: Some(None),
        })
    }

    /// The paragraphs a paragraph command changes: every selected paragraph.
    pub fn selected_paragraph_ids(&self) -> Vec<String> {
        let (start, end) = self.ordered();
        let first = self.paragraph_index(&start.paragraph_id).unwrap_or(0);
        let last = self.paragraph_index(&end.paragraph_id).unwrap_or(first);
        self.doc.paragraphs.iter().take(last + 1).skip(first).map(|p| p.id.clone()).collect()
    }

    fn focus_paragraph(&self) -> Option<&Paragraph> {
        self.paragraph(&self.focus.paragraph_id)
    }

    /// Paragraph commands need a paragraph without pending revisions.
    pub fn can_format_paragraph(&self) -> bool {
        self.can_mutate() && self.focus_paragraph().is_some_and(|p| p.revision_ids.is_empty())
    }

    fn paragraph_operations(&mut self, make: impl Fn(&str) -> Operation) -> bool {
        if !self.can_format_paragraph() {
            return false;
        }
        let range = TextRange { anchor: self.anchor.clone(), focus: self.focus.clone() };
        let operations = self
            .selected_paragraph_ids()
            .iter()
            .filter(|id| self.paragraph(id).is_some_and(|p| p.revision_ids.is_empty()))
            .map(|id| make(id))
            .collect();
        self.apply_then(operations, Some(range))
    }

    pub fn set_paragraph_style(&mut self, style_id: Option<&str>) -> bool {
        if !self.capabilities().named_styles {
            return false;
        }
        let style = style_id.map(str::to_string);
        self.paragraph_operations(|id| Operation::FormatParagraph {
            paragraph_id: id.into(),
            format: ParagraphFormat { style_id: Some(style.clone()), ..Default::default() },
        })
    }

    /// Toggles the list kind of the focus paragraph across the selection.
    pub fn toggle_list(&mut self, kind: ListKind) -> bool {
        if !self.capabilities().lists {
            return false;
        }
        let next = if self.focus_paragraph().and_then(|p| p.list_kind) == Some(kind) { None } else { Some(kind) };
        self.paragraph_operations(|id| Operation::SetList { paragraph_id: id.into(), kind: next })
    }

    /// `left`, `center`, `right` or `both` (justify).
    pub fn align(&mut self, alignment: &str) -> bool {
        if !self.capabilities().paragraph_formatting {
            return false;
        }
        let value = alignment.to_string();
        self.paragraph_operations(|id| Operation::FormatParagraph {
            paragraph_id: id.into(),
            format: ParagraphFormat { alignment: Some(Some(value.clone())), ..Default::default() },
        })
    }

    pub fn set_spacing(&mut self, format: ParagraphFormat) -> bool {
        if !self.capabilities().paragraph_formatting {
            return false;
        }
        self.paragraph_operations(|id| Operation::FormatParagraph { paragraph_id: id.into(), format: format.clone() })
    }

    pub fn set_page_layout(&mut self, layout: PageLayoutChange) -> bool {
        if !self.capabilities().page_layout {
            return false;
        }
        let range = TextRange { anchor: self.anchor.clone(), focus: self.focus.clone() };
        self.apply_then(vec![Operation::SetPageLayout { layout }], Some(range))
    }

    // ----- insert ---------------------------------------------------------

    fn apply_and_focus_new(&mut self, operations: Vec<Operation>) -> bool {
        let before: HashSet<String> = self.doc.paragraphs.iter().map(|p| p.id.clone()).collect();
        if !self.apply(operations) {
            return false;
        }
        if let Some(inserted) = self.doc.paragraphs.iter().find(|p| !before.contains(&p.id)).map(|p| p.id.clone()) {
            self.set_caret(TextPosition { paragraph_id: inserted, offset: 0 }, false);
        }
        true
    }

    /// Insert > Paragraph: an empty paragraph after the caret's paragraph.
    pub fn insert_paragraph(&mut self) -> bool {
        let after = match self.focus_paragraph() {
            Some(p) => InsertAt::After(p.id.clone()),
            None => InsertAt::End,
        };
        self.apply_and_focus_new(vec![Operation::InsertParagraph { after_paragraph_id: after, text: String::new() }])
    }

    /// Insert > Page Break at the caret (`insertBreak`).
    pub fn insert_page_break(&mut self) -> bool {
        if !self.can_mutate() || !self.capabilities().page_breaks {
            return false;
        }
        if !self.is_collapsed() {
            self.reject("Use a cursor position, not a text selection, to insert a page break.");
            return false;
        }
        let Some(paragraph) = self.focus_paragraph().cloned() else {
            self.reject("Place the cursor in a paragraph before inserting a page break.");
            return false;
        };
        let offset = self.focus.offset.min(paragraph.text.len());
        let mut operations = vec![Operation::InsertPageBreak { paragraph_id: paragraph.id.clone(), offset }];
        if offset == paragraph.text.len() {
            operations.push(Operation::InsertParagraph { after_paragraph_id: InsertAt::After(paragraph.id.clone()), text: String::new() });
        }
        self.apply_and_focus_new(operations)
    }

    pub fn remove_page_break(&mut self, page_break_id: &str) -> bool {
        self.apply(vec![Operation::RemovePageBreak { page_break_id: page_break_id.into() }])
    }

    /// The table that holds the caret, if any.
    pub fn caret_table(&self) -> Option<&Table> {
        let id = &self.focus.paragraph_id;
        self.doc.tables.iter().find(|t| t.rows.iter().any(|r| r.cells.iter().any(|c| c.paragraph_ids.contains(id))))
    }

    pub fn insert_table(&mut self, rows: usize, columns: usize) -> bool {
        if !self.capabilities().tables || self.caret_table().is_some() {
            return false;
        }
        if !(1..=20).contains(&rows) || !(1..=10).contains(&columns) {
            self.reject("Tables take 1 to 20 rows and 1 to 10 columns.");
            return false;
        }
        let after = self.focus_paragraph().map_or(InsertAt::End, |p| InsertAt::After(p.id.clone()));
        self.apply_and_focus_new(vec![Operation::InsertTable { after_paragraph_id: after, rows, columns, cells: None }])
    }

    pub fn delete_table(&mut self, table_id: &str) -> bool {
        let id = table_id.to_string();
        if !self.apply(vec![Operation::DeleteTable { table_id: id }]) {
            return false;
        }
        let focus = self.clamp(&self.focus);
        self.set_caret(focus, false);
        true
    }

    /// The content box a picture must fit, in points.
    pub fn content_box_points(&self) -> (f64, f64) {
        let l = self.doc.page_layout;
        (l.width_points - l.margin_left_points - l.margin_right_points, l.height_points - l.margin_top_points - l.margin_bottom_points)
    }

    /// Insert > Picture from local PNG or JPEG bytes (`decodeWordImage`).
    pub fn insert_picture(&mut self, bytes: Vec<u8>, name: &str) -> bool {
        if !self.can_mutate() || !self.capabilities().images {
            return false;
        }
        if self.caret_table().is_some() {
            self.reject("Select a body paragraph to insert a picture.");
            return false;
        }
        match picture_operation(bytes, name, self.content_box_points(), self.focus_paragraph().map(|p| p.id.clone())) {
            Ok(operation) => self.apply(vec![operation]),
            Err(reason) => {
                self.reject(reason);
                false
            }
        }
    }

    pub fn delete_picture(&mut self, image_id: &str) -> bool {
        self.apply(vec![Operation::DeleteImage { image_id: image_id.into() }])
    }

    /// The hyperlink under the caret's run.
    pub fn caret_link(&self) -> Option<&Hyperlink> {
        let run = self.caret_run()?;
        self.doc.hyperlinks.iter().find(|l| l.paragraph_id == self.focus.paragraph_id && l.run_ids.contains(&run.id))
    }

    /// Link the selected text, or retarget the link under the caret.
    pub fn set_link(&mut self, target: &str) -> bool {
        if !self.can_mutate() || !self.capabilities().hyperlinks {
            return false;
        }
        if self.tracking {
            self.reject("Turn off paragraph text tracking before changing links.");
            return false;
        }
        let range = TextRange { anchor: self.anchor.clone(), focus: self.focus.clone() };
        if self.is_collapsed() {
            if let Some(link) = self.caret_link().map(|l| l.id.clone()) {
                return self.apply_then(vec![Operation::UpdateHyperlink { hyperlink_id: link, target: target.into() }], Some(range));
            }
            self.reject("Select text within a paragraph before adding a link.");
            return false;
        }
        if self.is_cross() {
            self.reject("Select text within a paragraph before adding a link.");
            return false;
        }
        let (start, end) = self.ordered();
        self.apply_then(
            vec![Operation::SetHyperlink { paragraph_id: start.paragraph_id, start: start.offset, end: end.offset, target: target.into() }],
            Some(range),
        )
    }

    pub fn remove_link(&mut self, hyperlink_id: &str) -> bool {
        let range = TextRange { anchor: self.anchor.clone(), focus: self.focus.clone() };
        self.apply_then(vec![Operation::RemoveHyperlink { hyperlink_id: hyperlink_id.into() }], Some(range))
    }

    // ----- review ---------------------------------------------------------

    pub fn set_tracking(&mut self, on: bool) {
        if self.can_mutate() && self.capabilities().review {
            self.tracking = on;
        }
    }

    pub fn set_original_view(&mut self, on: bool) {
        if on && self.doc.original_text.is_none() {
            return;
        }
        self.original_view = on;
        self.anchor = self.clamp(&self.anchor);
        self.focus = self.clamp(&self.focus);
    }

    pub fn accept_revision(&mut self, id: &str) -> bool {
        self.apply(vec![Operation::AcceptRevision { revision_id: id.into() }])
    }

    pub fn reject_revision(&mut self, id: &str) -> bool {
        self.apply(vec![Operation::RejectRevision { revision_id: id.into() }])
    }

    pub fn accept_all(&mut self) -> bool {
        self.apply(vec![Operation::AcceptAllRevisions])
    }

    pub fn reject_all(&mut self) -> bool {
        self.apply(vec![Operation::RejectAllRevisions])
    }

    /// Comments attach to the caret's whole paragraph.
    pub fn add_comment(&mut self, text: &str, author: &str) -> bool {
        let (text, author) = (text.trim(), author.trim());
        if text.is_empty() || author.is_empty() {
            self.reject("A comment needs text and an author.");
            return false;
        }
        let Some(paragraph) = self.focus_paragraph().map(|p| p.id.clone()) else { return false };
        self.apply(vec![Operation::AddComment { paragraph_id: paragraph, text: text.into(), author: author.into() }])
    }

    pub fn delete_comment(&mut self, id: &str) -> bool {
        self.apply(vec![Operation::DeleteComment { comment_id: id.into() }])
    }

    pub fn word_count(&self) -> usize {
        self.doc.text.split_whitespace().count()
    }
}

/// An insert-image operation for local PNG or JPEG bytes, scaled to fit the
/// content box the way the Electron picture picker does.
pub fn picture_operation(bytes: Vec<u8>, name: &str, (max_w, max_h): (f64, f64), after: Option<String>) -> Result<Operation, String> {
    if bytes.len() > MAX_PICTURE_BYTES {
        return Err("Choose a PNG or JPEG smaller than 8 MB.".into());
    }
    let png = bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]);
    let kind = if png {
        ImageType::Png
    } else if bytes.starts_with(&[255, 216]) {
        ImageType::Jpeg
    } else {
        return Err("Only local PNG and JPEG images are supported. SVG and remote images are not inserted.".into());
    };
    let bitmap = inspect_docx_bitmap(&bytes, kind).map_err(message)?;
    let (w, h) = (bitmap.width as f64 * 72.0 / 96.0, bitmap.height as f64 * 72.0 / 96.0);
    let scale = (1.0 / w).max(1.0 / h).max((max_w.max(1.0) / w).min(max_h.max(1.0) / h).min(1.0));
    if w * scale > max_w || h * scale > max_h {
        return Err("This image's aspect ratio cannot fit the current page margins.".into());
    }
    Ok(Operation::InsertImage(ImageInput {
        after_paragraph_id: after.map_or(InsertAt::End, InsertAt::After),
        bytes,
        content_type: kind,
        width_points: w * scale,
        height_points: h * scale,
        alt_text: Some(name.to_string()),
    }))
}
