//! The document model the UI renders. Ported from `docx-types.ts`,
//! `rich-text-types.ts` and `rich-range-types.ts`. One shape serves DOCX, RTF
//! and ODT; each codec owns its source bytes separately.
//!
//! Text offsets (`format-range`, hyperlinks, page breaks, selections) are UTF-8
//! byte offsets into `Paragraph::text`. An offset inside a character is rejected.

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Docx,
    Rtf,
    Odt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub severity: Severity,
    pub part: Option<String>,
}

impl Diagnostic {
    pub fn warning(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), severity: Severity::Warning, part: None }
    }
    pub fn info(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), severity: Severity::Info, part: None }
    }
    pub fn with_part(mut self, part: impl Into<String>) -> Self {
        self.part = Some(part.into());
        self
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunStyle {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<String>,
    pub color: Option<String>,
    pub font_family: Option<String>,
    pub font_size_points: Option<f64>,
}

/// A formatting change. `None` leaves a property alone; `Some(None)` removes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunFormat {
    pub bold: Option<Option<bool>>,
    pub italic: Option<Option<bool>>,
    pub underline: Option<Option<String>>,
    pub color: Option<Option<String>>,
    pub font_family: Option<Option<String>>,
    pub font_size_points: Option<Option<f64>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunPageBreak {
    pub id: String,
    /// Byte offset in the run's text.
    pub offset: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    /// Session identity, preserved across edits; reopening starts a new session.
    pub id: String,
    pub text: String,
    /// Direct formatting.
    pub style: RunStyle,
    /// Display formatting resolved from defaults, styles and theme (DOCX only).
    pub resolved_style: Option<RunStyle>,
    pub can_edit: bool,
    pub hyperlink_id: Option<String>,
    pub target: Option<String>,
    pub page_breaks: Vec<RunPageBreak>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListKind {
    Bullet,
    Numbered,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Paragraph {
    pub id: String,
    pub text: String,
    pub style_id: Option<String>,
    pub alignment: Option<String>,
    pub spacing_before_points: Option<f64>,
    pub spacing_after_points: Option<f64>,
    pub line_spacing_multiple: Option<f64>,
    pub list_kind: Option<ListKind>,
    pub list_level: Option<u32>,
    pub list_number: Option<u32>,
    pub runs: Vec<Run>,
    /// Text with tracked insertions rejected (DOCX review view).
    pub original_text: Option<String>,
    pub original_runs: Option<Vec<Run>>,
    pub revision_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageLayout {
    pub width_points: f64,
    pub height_points: f64,
    pub orientation: Orientation,
    pub margin_top_points: f64,
    pub margin_right_points: f64,
    pub margin_bottom_points: f64,
    pub margin_left_points: f64,
}

pub const DEFAULT_PAGE_LAYOUT: PageLayout = PageLayout {
    width_points: 612.0,
    height_points: 792.0,
    orientation: Orientation::Portrait,
    margin_top_points: 72.0,
    margin_right_points: 72.0,
    margin_bottom_points: 72.0,
    margin_left_points: 72.0,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableCell {
    /// Ids into `RichDocument::paragraphs`.
    pub paragraph_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableRow {
    pub cells: Vec<TableCell>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Table {
    pub id: String,
    pub rows: Vec<TableRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    Paragraph(String),
    Table(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comment {
    pub id: String,
    pub paragraph_id: String,
    pub text: String,
    pub author: String,
    pub date: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamedStyle {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageType {
    Png,
    Jpeg,
}

impl ImageType {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }
    pub fn from_mime(mime: &str) -> Option<Self> {
        match mime {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Picture {
    pub id: String,
    pub paragraph_id: String,
    pub width_points: f64,
    pub height_points: f64,
    pub alt_text: String,
    pub content_type: ImageType,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hyperlink {
    pub id: String,
    pub paragraph_id: String,
    pub text: String,
    pub target: String,
    pub run_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageBreak {
    pub id: String,
    pub paragraph_id: String,
    pub run_id: String,
    /// Byte offset in the paragraph's visible text.
    pub offset: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevisionKind {
    Insertion,
    Deletion,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revision {
    pub id: String,
    pub paragraph_id: String,
    pub kind: RevisionKind,
    pub author: String,
    pub date: String,
    pub text: String,
}

/// The shared editor projection: what a UI renders for any rich format.
#[derive(Clone, Debug, PartialEq)]
pub struct RichDocument {
    pub format: Format,
    pub text: String,
    pub original_text: Option<String>,
    pub revisions: Vec<Revision>,
    pub paragraphs: Vec<Paragraph>,
    pub tables: Vec<Table>,
    pub blocks: Vec<Block>,
    pub page_layout: PageLayout,
    pub comments: Vec<Comment>,
    pub styles: Vec<NamedStyle>,
    pub images: Vec<Picture>,
    pub hyperlinks: Vec<Hyperlink>,
    pub page_breaks: Vec<PageBreak>,
    pub metadata: BTreeMap<String, String>,
    pub diagnostics: Vec<Diagnostic>,
    pub can_edit: bool,
    pub revision: u64,
    pub modified: bool,
}

impl RichDocument {
    pub fn paragraph(&self, id: &str) -> Option<&Paragraph> {
        self.paragraphs.iter().find(|p| p.id == id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub run_id: String,
    pub text: String,
}

/// A paragraph format change; `None` leaves a property, `Some(None)` clears it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParagraphFormat {
    pub style_id: Option<Option<String>>,
    pub alignment: Option<Option<String>>,
    pub spacing_before_points: Option<Option<f64>>,
    pub spacing_after_points: Option<Option<f64>>,
    pub line_spacing_multiple: Option<Option<f64>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Paper {
    Letter,
    A4,
    Legal,
}

impl Paper {
    pub fn size(self) -> (f64, f64) {
        match self {
            Self::Letter => (612.0, 792.0),
            Self::A4 => (595.3, 841.9),
            Self::Legal => (612.0, 1008.0),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PageLayoutChange {
    pub paper: Option<Paper>,
    pub orientation: Option<Orientation>,
    pub margin_top_points: Option<f64>,
    pub margin_right_points: Option<f64>,
    pub margin_bottom_points: Option<f64>,
    pub margin_left_points: Option<f64>,
}

/// Where a new block goes. TypeScript spells these `undefined`, `null` and an id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InsertAt {
    /// Before the final section properties (the end of the body).
    End,
    /// At the very start of the body.
    Start,
    After(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageInput {
    pub after_paragraph_id: InsertAt,
    pub bytes: Vec<u8>,
    pub content_type: ImageType,
    pub width_points: f64,
    pub height_points: f64,
    pub alt_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Operation {
    FormatRun { run_id: String, style: RunFormat },
    FormatRange { paragraph_id: String, start: usize, end: usize, style: RunFormat },
    ReplaceParagraph { paragraph_id: String, text: String },
    InsertParagraph { after_paragraph_id: InsertAt, text: String },
    DeleteParagraph { paragraph_id: String },
    FormatParagraph { paragraph_id: String, format: ParagraphFormat },
    SetPageLayout { layout: PageLayoutChange },
    InsertTable { after_paragraph_id: InsertAt, rows: usize, columns: usize, cells: Option<Vec<Vec<String>>> },
    DeleteTable { table_id: String },
    SetList { paragraph_id: String, kind: Option<ListKind> },
    InsertImage(ImageInput),
    DeleteImage { image_id: String },
    SetHyperlink { paragraph_id: String, start: usize, end: usize, target: String },
    UpdateHyperlink { hyperlink_id: String, target: String },
    RemoveHyperlink { hyperlink_id: String },
    InsertPageBreak { paragraph_id: String, offset: usize },
    RemovePageBreak { page_break_id: String },
    TrackParagraphText { paragraph_id: String, text: String, author: String },
    AcceptRevision { revision_id: String },
    RejectRevision { revision_id: String },
    AcceptAllRevisions,
    RejectAllRevisions,
    AddComment { paragraph_id: String, text: String, author: String },
    DeleteComment { comment_id: String },
}

impl Operation {
    pub fn name(&self) -> &'static str {
        match self {
            Self::FormatRun { .. } => "format-run",
            Self::FormatRange { .. } => "format-range",
            Self::ReplaceParagraph { .. } => "replace-paragraph",
            Self::InsertParagraph { .. } => "insert-paragraph",
            Self::DeleteParagraph { .. } => "delete-paragraph",
            Self::FormatParagraph { .. } => "format-paragraph",
            Self::SetPageLayout { .. } => "set-page-layout",
            Self::InsertTable { .. } => "insert-table",
            Self::DeleteTable { .. } => "delete-table",
            Self::SetList { .. } => "set-list",
            Self::InsertImage(_) => "insert-image",
            Self::DeleteImage { .. } => "delete-image",
            Self::SetHyperlink { .. } => "set-hyperlink",
            Self::UpdateHyperlink { .. } => "update-hyperlink",
            Self::RemoveHyperlink { .. } => "remove-hyperlink",
            Self::InsertPageBreak { .. } => "insert-page-break",
            Self::RemovePageBreak { .. } => "remove-page-break",
            Self::TrackParagraphText { .. } => "track-paragraph-text",
            Self::AcceptRevision { .. } => "accept-revision",
            Self::RejectRevision { .. } => "reject-revision",
            Self::AcceptAllRevisions => "accept-all-revisions",
            Self::RejectAllRevisions => "reject-all-revisions",
            Self::AddComment { .. } => "add-comment",
            Self::DeleteComment { .. } => "delete-comment",
        }
    }
}

/// A session-local caret position: byte offset on a grapheme boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextPosition {
    pub paragraph_id: String,
    pub offset: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextRange {
    pub anchor: TextPosition,
    pub focus: TextPosition,
}

/// JavaScript `Math.round`: halves round toward positive infinity.
pub(crate) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// JavaScript `String(number)` for the finite values this crate writes.
pub(crate) fn js_number(value: f64) -> String {
    if value == value.trunc() && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}
