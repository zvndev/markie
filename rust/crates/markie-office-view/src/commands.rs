//! The Format, Insert, Layout, Review and View commands from
//! `electron/document-menu-commands.json`, which of them a selection allows
//! (`availableCommands` in `word-document-editor.tsx`), and running them.

use markie_office::model::{ListKind, Orientation, PageLayoutChange, Paper};

use crate::editor::{Outcome, Tool, WordEditor};

/// `(group, id, label)` in menu order. The File and Darkmown entries of the
/// JSON belong to the app, not the Word view.
pub const COMMANDS: &[(&str, &str, &str)] = &[
    ("Format", "format-bold", "Bold"),
    ("Format", "format-italic", "Italic"),
    ("Format", "format-underline", "Underline"),
    ("Format", "format-strike", "Strikethrough"),
    ("Format", "format-clear", "Clear Formatting"),
    ("Format", "format-font", "Font…"),
    ("Format", "format-normal", "Normal Text"),
    ("Format", "format-heading-1", "Heading 1"),
    ("Format", "format-heading-2", "Heading 2"),
    ("Format", "format-heading-3", "Heading 3"),
    ("Format", "format-bullets", "Bullet List"),
    ("Format", "format-numbering", "Numbered List"),
    ("Format", "format-align-left", "Align Left"),
    ("Format", "format-align-center", "Align Center"),
    ("Format", "format-align-right", "Align Right"),
    ("Format", "format-align-justify", "Justify"),
    ("Insert", "insert-paragraph", "Paragraph"),
    ("Insert", "insert-picture", "Picture…"),
    ("Insert", "insert-table", "Table…"),
    ("Insert", "insert-link", "Link…"),
    ("Insert", "insert-page-break", "Page Break"),
    ("Layout", "layout-page-setup", "Page Setup…"),
    ("Layout", "layout-letter", "Letter"),
    ("Layout", "layout-a4", "A4"),
    ("Layout", "layout-legal", "Legal"),
    ("Layout", "layout-portrait", "Portrait"),
    ("Layout", "layout-landscape", "Landscape"),
    ("Layout", "layout-paragraph-spacing", "Paragraph Spacing…"),
    ("Review", "review-comments", "Comments…"),
    ("Review", "review-tracking", "Track Paragraph Text…"),
    ("Review", "review-changes", "Text Changes…"),
    ("Review", "review-original", "Show Original Text"),
    ("Review", "review-final", "Show Final Text"),
    ("View", "view-page", "Page Layout"),
    ("View", "view-continuous", "Continuous Layout"),
    ("View", "view-outline", "Document Outline"),
    ("View", "view-zoom-reset", "Actual Size"),
];

pub fn label(id: &str) -> &'static str {
    COMMANDS.iter().find(|(_, i, _)| *i == id).map_or("", |(_, _, l)| l)
}

/// The commands the current document and selection allow.
pub fn available_commands(editor: &WordEditor) -> Vec<&'static str> {
    let caps = editor.capabilities();
    let doc = editor.rich();
    let docx = editor.is_docx();
    let editable = editor.can_mutate();
    let mut out: Vec<&'static str> = vec!["view-page", "view-continuous", "view-outline", "view-zoom-reset"];
    if docx {
        out.extend(["review-comments", "review-tracking", "review-changes", "review-final"]);
        if doc.original_text.is_some() {
            out.push("review-original");
        }
    }
    if editable && caps.page_layout {
        out.extend(["layout-page-setup", "layout-letter", "layout-a4", "layout-legal", "layout-portrait", "layout-landscape"]);
    }
    if editor.can_format_paragraph() {
        if caps.named_styles {
            out.extend(["format-normal", "format-heading-1", "format-heading-2", "format-heading-3"]);
        }
        if caps.lists {
            out.extend(["format-bullets", "format-numbering"]);
        }
        if caps.paragraph_formatting {
            out.extend(["format-align-left", "format-align-center", "format-align-right", "format-align-justify", "layout-paragraph-spacing"]);
        }
        out.push("insert-paragraph");
        if caps.tables {
            out.push("insert-table");
        }
        if caps.images && editor.caret_table().is_none() {
            out.push("insert-picture");
        }
        if caps.page_breaks && !editor.tracking && editor.is_collapsed() {
            out.push("insert-page-break");
        }
        if caps.hyperlinks && !editor.tracking && (editor.caret_link().is_some() || (!editor.is_collapsed() && !editor.is_cross())) {
            out.push("insert-link");
        }
    }
    if editor.can_format_runs() {
        out.extend(["format-bold", "format-italic", "format-underline", "format-clear", "format-font"]);
    }
    out
}

pub fn is_available(editor: &WordEditor, id: &str) -> bool {
    available_commands(editor).contains(&id)
}

/// Run a document command on the model. View commands (`view-*`) are the
/// view's own and come back `Ignored`.
pub fn run_command(editor: &mut WordEditor, id: &str) -> Outcome {
    if !is_available(editor, id) {
        return Outcome::Ignored;
    }
    let tool = match id {
        "format-font" => Some(Tool::Font),
        "insert-picture" => Some(Tool::Picture),
        "insert-table" => Some(Tool::Table),
        "insert-link" => Some(Tool::Link),
        "layout-page-setup" => Some(Tool::Page),
        "layout-paragraph-spacing" => Some(Tool::Spacing),
        "review-comments" | "review-tracking" | "review-changes" => Some(Tool::Review),
        _ => None,
    };
    if let Some(tool) = tool {
        return Outcome::Open(tool);
    }
    let paper = |paper| PageLayoutChange { paper: Some(paper), ..Default::default() };
    let orientation = |orientation| PageLayoutChange { orientation: Some(orientation), ..Default::default() };
    let done = match id {
        "format-bold" => editor.toggle_bold(),
        "format-italic" => editor.toggle_italic(),
        "format-underline" => editor.toggle_underline(),
        "format-clear" => editor.clear_formatting(),
        "format-normal" => editor.set_paragraph_style(Some("Normal")),
        "format-heading-1" => editor.set_paragraph_style(Some("Heading1")),
        "format-heading-2" => editor.set_paragraph_style(Some("Heading2")),
        "format-heading-3" => editor.set_paragraph_style(Some("Heading3")),
        "format-bullets" => editor.toggle_list(ListKind::Bullet),
        "format-numbering" => editor.toggle_list(ListKind::Numbered),
        "format-align-left" => editor.align("left"),
        "format-align-center" => editor.align("center"),
        "format-align-right" => editor.align("right"),
        "format-align-justify" => editor.align("both"),
        "insert-paragraph" => editor.insert_paragraph(),
        "insert-page-break" => editor.insert_page_break(),
        "layout-letter" => editor.set_page_layout(paper(Paper::Letter)),
        "layout-a4" => editor.set_page_layout(paper(Paper::A4)),
        "layout-legal" => editor.set_page_layout(paper(Paper::Legal)),
        "layout-portrait" => editor.set_page_layout(orientation(Orientation::Portrait)),
        "layout-landscape" => editor.set_page_layout(orientation(Orientation::Landscape)),
        "review-original" => {
            editor.set_original_view(true);
            true
        }
        "review-final" => {
            editor.set_original_view(false);
            true
        }
        _ => return Outcome::Ignored,
    };
    if done { Outcome::Done } else { Outcome::Ignored }
}

/// The named paper a page is, in either orientation, or `None` for a custom size.
pub fn paper_of(width: f64, height: f64) -> Option<Paper> {
    let (short, long) = (width.min(height), width.max(height));
    [Paper::Letter, Paper::A4, Paper::Legal].into_iter().find(|p| {
        let (w, h) = p.size();
        (w - short).abs() < 2.0 && (h - long).abs() < 2.0
    })
}
