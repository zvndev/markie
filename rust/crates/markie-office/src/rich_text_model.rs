//! The simple paragraph/run editor shared by the RTF and ODT codecs.
//! Ported from `rich-text-model.ts`. DOCX uses its own source-splicing engine.

use crate::error::{OfficeError, Result};
use crate::model::*;
use std::collections::{BTreeMap, HashMap};

fn invalid(message: &str) -> OfficeError {
    OfficeError::docx("invalid-edit", message)
}

/// A shared projection plus the identity counter that makes it "owned".
#[derive(Clone, Debug, PartialEq)]
pub struct NativeDocument {
    pub doc: RichDocument,
    pub(crate) next_id: u64,
}

impl std::ops::Deref for NativeDocument {
    type Target = RichDocument;
    fn deref(&self) -> &RichDocument {
        &self.doc
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunInput {
    pub text: String,
    pub style: RunStyle,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParagraphInput {
    pub runs: Vec<RunInput>,
    pub alignment: Option<String>,
    pub spacing_before_points: Option<f64>,
    pub spacing_after_points: Option<f64>,
    pub line_spacing_multiple: Option<f64>,
    /// Display-only list markers; a codec that sets them must open read-only.
    pub list_kind: Option<ListKind>,
    pub list_level: Option<u32>,
    pub list_number: Option<u32>,
}

/// Document order of top-level paragraphs and tables, by input paragraph index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockInput {
    Paragraph(usize),
    Table(Vec<Vec<Vec<usize>>>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SnapshotOptions {
    /// Tables are display-only in the shared model: any table means read-only.
    pub blocks: Option<Vec<BlockInput>>,
    pub page_layout: Option<PageLayout>,
    pub diagnostics: Vec<Diagnostic>,
    pub metadata: BTreeMap<String, String>,
    pub can_edit: Option<bool>,
    pub revision: u64,
    pub modified: bool,
    pub original_text: Option<String>,
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `encodeTextDocument` validation: no C0 controls except tab, LF, FF and CR.
fn text(value: &str) -> Result<String> {
    if utf16_len(value) > 1_000_000 {
        return Err(invalid("Document text exceeds the supported limit."));
    }
    if value.chars().any(|c| (c as u32) < 32 && !matches!(c, '\t' | '\n' | '\u{c}' | '\r')) {
        return Err(OfficeError::docx(
            "binary-content",
            "This file contains binary control characters and cannot be edited as text.",
        ));
    }
    Ok(value.to_string())
}

fn number(value: f64, min: f64, max: f64) -> Result<f64> {
    if !value.is_finite() || value < min || value > max {
        return Err(invalid("Formatting value is out of range."));
    }
    Ok(value)
}

pub(crate) const UNDERLINES: &[&str] = &["none", "single", "double", "dotted", "dash", "wave"];

pub(crate) fn style_patch(source: &RunStyle, patch: &RunFormat) -> Result<RunStyle> {
    let mut result = source.clone();
    if let Some(v) = &patch.bold {
        result.bold = *v;
    }
    if let Some(v) = &patch.italic {
        result.italic = *v;
    }
    if let Some(v) = &patch.underline {
        if let Some(u) = v
            && !UNDERLINES.contains(&u.as_str())
        {
            return Err(invalid("Unsupported underline style."));
        }
        result.underline = v.clone();
    }
    if let Some(v) = &patch.color {
        if let Some(c) = v
            && !(c == "auto" || (c.len() == 6 && c.bytes().all(|b| b.is_ascii_hexdigit())))
        {
            return Err(invalid("Invalid text color."));
        }
        result.color = v.clone();
    }
    if let Some(v) = &patch.font_family {
        if let Some(f) = v
            && (f.trim().is_empty() || utf16_len(f) > 200 || f.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}'))
        {
            return Err(invalid("Invalid font family."));
        }
        result.font_family = v.clone();
    }
    if let Some(v) = &patch.font_size_points {
        if let Some(size) = v {
            number(*size, 1.0, 400.0)?;
        }
        result.font_size_points = *v;
    }
    Ok(result)
}

fn style_as_format(style: &RunStyle) -> RunFormat {
    RunFormat {
        bold: style.bold.map(Some),
        italic: style.italic.map(Some),
        underline: style.underline.clone().map(Some),
        color: style.color.clone().map(Some),
        font_family: style.font_family.clone().map(Some),
        font_size_points: style.font_size_points.map(Some),
    }
}

fn run(id: String, value: &str, style: &RunStyle, can_edit: bool) -> Result<Run> {
    Ok(Run {
        id,
        text: text(value)?,
        style: style_patch(&RunStyle::default(), &style_as_format(style))?,
        resolved_style: None,
        can_edit,
        hyperlink_id: None,
        target: None,
        page_breaks: vec![],
    })
}

fn with_text(mut p: Paragraph) -> Paragraph {
    p.text = p.runs.iter().map(|r| r.text.as_str()).collect();
    p
}

fn finish(base: &NativeDocument, paragraphs: Vec<Paragraph>, next_id: u64, layout: PageLayout) -> Result<NativeDocument> {
    let total: usize = paragraphs.iter().map(|p| utf16_len(&p.text)).sum::<usize>() + paragraphs.len().saturating_sub(1);
    if paragraphs.is_empty() || paragraphs.len() > 10000 || total > 1_000_000 {
        return Err(invalid("Unsupported document size."));
    }
    let mut doc = base.doc.clone();
    doc.text = paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n");
    doc.blocks = paragraphs.iter().map(|p| Block::Paragraph(p.id.clone())).collect();
    doc.paragraphs = paragraphs;
    doc.page_layout = layout;
    doc.revision += 1;
    doc.modified = true;
    Ok(NativeDocument { doc, next_id })
}

/// Edits rebuild blocks from paragraphs alone, so a table can only ever be shown.
fn layout_blocks(paragraphs: &[Paragraph], input: Option<&Vec<BlockInput>>, can_edit: bool) -> Result<(Vec<Block>, Vec<Table>)> {
    let Some(input) = input else {
        return Ok((paragraphs.iter().map(|p| Block::Paragraph(p.id.clone())).collect(), vec![]));
    };
    let order = || invalid("Rich document blocks must list every paragraph once, in order.");
    let mut next = 0usize;
    let mut take = |index: usize| -> Result<String> {
        if index != next || index >= paragraphs.len() {
            return Err(order());
        }
        next += 1;
        Ok(paragraphs[index].id.clone())
    };
    let mut tables = Vec::new();
    let mut blocks = Vec::new();
    for block in input {
        match block {
            BlockInput::Paragraph(index) => blocks.push(Block::Paragraph(take(*index)?)),
            BlockInput::Table(rows) => {
                if can_edit {
                    return Err(invalid("Tables in this format are read-only."));
                }
                if rows.is_empty() || rows.iter().any(|row| row.is_empty() || row.iter().any(|cell| cell.is_empty())) {
                    return Err(invalid("Rich document tables need rows and cells with paragraphs."));
                }
                let id = format!("t{}", tables.len());
                let mut table_rows = Vec::new();
                for row in rows {
                    let mut cells = Vec::new();
                    for cell in row {
                        let mut ids = Vec::new();
                        for index in cell {
                            ids.push(take(*index)?);
                        }
                        cells.push(TableCell { paragraph_ids: ids });
                    }
                    table_rows.push(TableRow { cells });
                }
                tables.push(Table { id: id.clone(), rows: table_rows });
                blocks.push(Block::Table(id));
            }
        }
    }
    if next != paragraphs.len() {
        return Err(order());
    }
    Ok((blocks, tables))
}

pub fn create_rich_snapshot(format: Format, inputs: &[ParagraphInput], options: SnapshotOptions) -> Result<NativeDocument> {
    if inputs.is_empty() || inputs.len() > 10000 {
        return Err(invalid("A rich document requires supported paragraphs."));
    }
    let can_edit = options.can_edit.unwrap_or(true);
    for p in inputs {
        if p.list_kind.is_none() && p.list_level.is_none() && p.list_number.is_none() {
            continue;
        }
        if can_edit {
            return Err(invalid("List markers in this format are read-only."));
        }
        if p.list_kind.is_none() || p.list_level.unwrap_or(0) > 8 || p.list_number.is_some_and(|n| n > 1_000_000) {
            return Err(invalid("Invalid list marker."));
        }
    }
    let mut paragraphs = Vec::with_capacity(inputs.len());
    for (i, p) in inputs.iter().enumerate() {
        let empty = [RunInput::default()];
        let runs_in: &[RunInput] = if p.runs.is_empty() { &empty } else { &p.runs };
        let mut runs = Vec::with_capacity(runs_in.len());
        for (j, r) in runs_in.iter().enumerate() {
            runs.push(run(format!("p{i}:r{j}"), &r.text, &r.style, can_edit)?);
        }
        paragraphs.push(with_text(Paragraph {
            id: format!("p{i}"),
            alignment: p.alignment.clone(),
            spacing_before_points: p.spacing_before_points,
            spacing_after_points: p.spacing_after_points,
            line_spacing_multiple: p.line_spacing_multiple,
            list_kind: p.list_kind,
            list_level: p.list_level,
            list_number: p.list_number,
            runs,
            ..Default::default()
        }));
    }
    let (blocks, tables) = layout_blocks(&paragraphs, options.blocks.as_ref(), can_edit)?;
    let text = paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n");
    if utf16_len(&text) > 1_000_000 {
        return Err(invalid("Unsupported document size."));
    }
    Ok(NativeDocument {
        doc: RichDocument {
            format,
            text,
            original_text: options.original_text,
            revisions: vec![],
            paragraphs,
            tables,
            blocks,
            page_layout: options.page_layout.unwrap_or(DEFAULT_PAGE_LAYOUT),
            comments: vec![],
            styles: vec![],
            images: vec![],
            hyperlinks: vec![],
            page_breaks: vec![],
            metadata: options.metadata,
            diagnostics: options.diagnostics,
            can_edit,
            revision: options.revision,
            modified: options.modified,
        },
        next_id: 0,
    })
}

const SIMPLE_OPERATIONS: &[&str] =
    &["format-run", "format-range", "replace-paragraph", "insert-paragraph", "delete-paragraph", "format-paragraph", "set-page-layout"];

pub fn apply_simple_rich_operations(document: &NativeDocument, operations: &[Operation]) -> Result<NativeDocument> {
    if !document.can_edit {
        return Err(OfficeError::docx("read-only", "Unsupported document content is read-only; export preserves the original."));
    }
    if operations.is_empty() {
        return Ok(document.clone());
    }
    let mut next_id = document.next_id;
    let mut paragraphs = document.paragraphs.clone();
    let mut layout = document.page_layout;
    let mut identity = |prefix: &str| {
        let id = format!("{prefix}~{next_id}");
        next_id += 1;
        id
    };
    for op in operations {
        if !SIMPLE_OPERATIONS.contains(&op.name()) {
            return Err(OfficeError::docx("unsupported-operation", "This format does not support that editing command."));
        }
        match op {
            Operation::FormatRun { run_id, style } => {
                let mut found = false;
                for p in paragraphs.iter_mut() {
                    for r in p.runs.iter_mut() {
                        if &r.id == run_id {
                            found = true;
                            *r = run(r.id.clone(), &r.text.clone(), &style_patch(&r.style, style)?, true)?;
                        }
                    }
                    *p = with_text(p.clone());
                }
                if !found {
                    return Err(invalid("Unknown run identity."));
                }
            }
            Operation::SetPageLayout { layout: change } => {
                let (mut width, mut height) = (layout.width_points, layout.height_points);
                if let Some(paper) = change.paper {
                    (width, height) = paper.size();
                }
                let orientation = change.orientation.unwrap_or(layout.orientation);
                (width, height) = if orientation == Orientation::Portrait {
                    (width.min(height), width.max(height))
                } else {
                    (width.max(height), width.min(height))
                };
                let mut candidate = PageLayout { width_points: width, height_points: height, orientation, ..layout };
                if let Some(v) = change.margin_top_points {
                    candidate.margin_top_points = number(v, 0.0, 1440.0)?;
                }
                if let Some(v) = change.margin_right_points {
                    candidate.margin_right_points = number(v, 0.0, 1440.0)?;
                }
                if let Some(v) = change.margin_bottom_points {
                    candidate.margin_bottom_points = number(v, 0.0, 1440.0)?;
                }
                if let Some(v) = change.margin_left_points {
                    candidate.margin_left_points = number(v, 0.0, 1440.0)?;
                }
                if candidate.margin_left_points + candidate.margin_right_points >= width
                    || candidate.margin_top_points + candidate.margin_bottom_points >= height
                {
                    return Err(invalid("Margins leave no document area."));
                }
                layout = candidate;
            }
            Operation::InsertParagraph { after_paragraph_id, text } => {
                let index = match after_paragraph_id {
                    InsertAt::After(id) => match paragraphs.iter().position(|p| &p.id == id) {
                        Some(i) => i as isize,
                        None => return Err(invalid("Unknown paragraph identity.")),
                    },
                    _ => -1,
                };
                let id = identity("p");
                let run_id = identity("r");
                let paragraph = with_text(Paragraph { id, runs: vec![run(run_id, text, &RunStyle::default(), true)?], ..Default::default() });
                paragraphs.insert((index + 1) as usize, paragraph);
            }
            Operation::DeleteParagraph { paragraph_id }
            | Operation::ReplaceParagraph { paragraph_id, .. }
            | Operation::FormatParagraph { paragraph_id, .. }
            | Operation::FormatRange { paragraph_id, .. } => {
                let Some(index) = paragraphs.iter().position(|p| &p.id == paragraph_id) else {
                    return Err(invalid("Unknown paragraph identity."));
                };
                let p = paragraphs[index].clone();
                match op {
                    Operation::DeleteParagraph { .. } => {
                        if paragraphs.len() == 1 {
                            return Err(invalid("Keep at least one paragraph."));
                        }
                        paragraphs.remove(index);
                    }
                    Operation::ReplaceParagraph { text, .. } => {
                        let id = p.runs.first().map(|r| r.id.clone()).unwrap_or_else(|| identity("r"));
                        let style = p.runs.first().map(|r| r.style.clone()).unwrap_or_default();
                        paragraphs[index] = with_text(Paragraph { runs: vec![run(id, text, &style, true)?], ..p });
                    }
                    Operation::FormatParagraph { format, .. } => {
                        if format.style_id.is_some() {
                            return Err(invalid("Named styles are not supported for this format."));
                        }
                        let mut next = p.clone();
                        if let Some(alignment) = &format.alignment {
                            if let Some(a) = alignment
                                && !["left", "center", "right", "both"].contains(&a.as_str())
                            {
                                return Err(invalid("Invalid paragraph alignment."));
                            }
                            next.alignment = alignment.clone();
                        }
                        for (value, slot, min, max) in [
                            (format.spacing_before_points, &mut next.spacing_before_points, 0.0, 1000.0),
                            (format.spacing_after_points, &mut next.spacing_after_points, 0.0, 1000.0),
                            (format.line_spacing_multiple, &mut next.line_spacing_multiple, 0.5, 5.0),
                        ] {
                            match value {
                                None => {}
                                Some(None) => *slot = None,
                                Some(Some(v)) => *slot = Some(number(v, min, max)?),
                            }
                        }
                        paragraphs[index] = with_text(next);
                    }
                    Operation::FormatRange { start, end, style, .. } => {
                        let (start, end) = (*start, *end);
                        if end <= start || end > p.text.len() {
                            return Err(invalid("Invalid formatting range."));
                        }
                        if !p.text.is_char_boundary(start) || !p.text.is_char_boundary(end) {
                            return Err(invalid("Formatting range splits a Unicode character."));
                        }
                        let mut offset = 0usize;
                        let mut runs = Vec::new();
                        for r in &p.runs {
                            let from = start.saturating_sub(offset);
                            let to = r.text.len().min(end.saturating_sub(offset));
                            offset += r.text.len();
                            if from >= to {
                                runs.push(r.clone());
                                continue;
                            }
                            if from > 0 {
                                runs.push(run(r.id.clone(), &r.text[..from], &r.style, true)?);
                            }
                            let id = if from == 0 { r.id.clone() } else { identity("r") };
                            runs.push(run(id, &r.text[from..to], &style_patch(&r.style, style)?, true)?);
                            if to < r.text.len() {
                                runs.push(run(identity("r"), &r.text[to..], &r.style, true)?);
                            }
                        }
                        paragraphs[index] = with_text(Paragraph { runs, ..p });
                    }
                    _ => unreachable!(),
                }
            }
            _ => unreachable!(),
        }
    }
    if layout == document.page_layout && paragraphs == document.paragraphs {
        return Ok(document.clone());
    }
    finish(document, paragraphs, next_id, layout)
}

pub fn replace_simple_rich_text(document: &NativeDocument, edits: &[TextEdit]) -> Result<NativeDocument> {
    if !document.can_edit {
        return Err(OfficeError::docx("read-only", "This document is read-only."));
    }
    let mut pending: HashMap<&str, String> = HashMap::new();
    for edit in edits {
        if pending.insert(edit.run_id.as_str(), text(&edit.text)?).is_some() {
            return Err(invalid("Duplicate text edit."));
        }
    }
    let mut paragraphs = document.paragraphs.clone();
    for p in paragraphs.iter_mut() {
        for r in p.runs.iter_mut() {
            if let Some(value) = pending.remove(r.id.as_str())
                && value != r.text
            {
                *r = run(r.id.clone(), &value, &r.style, true)?;
            }
        }
        *p = with_text(p.clone());
    }
    if !pending.is_empty() {
        return Err(invalid("Unknown run identity."));
    }
    if paragraphs == document.paragraphs {
        return Ok(document.clone());
    }
    finish(document, paragraphs, document.next_id, document.page_layout)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParagraphDefaults {
    pub alignment: Option<String>,
    pub spacing_before_points: Option<f64>,
    pub spacing_after_points: Option<f64>,
    pub line_spacing_multiple: Option<f64>,
}

/// Re-resolve a codec's inherited defaults in one pass without introducing another edit.
pub fn rebase_simple_rich_defaults(document: &NativeDocument, run_defaults: &RunStyle, paragraph_defaults: &ParagraphDefaults) -> Result<NativeDocument> {
    let run_defaults = style_patch(&RunStyle::default(), &style_as_format(run_defaults))?;
    if let Some(a) = &paragraph_defaults.alignment
        && !["left", "center", "right", "both"].contains(&a.as_str())
    {
        return Err(invalid("Invalid default alignment."));
    }
    for (value, min, max) in [
        (paragraph_defaults.spacing_before_points, 0.0, 1000.0),
        (paragraph_defaults.spacing_after_points, 0.0, 1000.0),
        (paragraph_defaults.line_spacing_multiple, 0.5, 5.0),
    ] {
        if let Some(v) = value {
            number(v, min, max)?;
        }
    }
    let mut changed = false;
    let mut paragraphs = Vec::with_capacity(document.paragraphs.len());
    for p in &document.paragraphs {
        let mut paragraph_changed = false;
        let mut runs = Vec::with_capacity(p.runs.len());
        for r in &p.runs {
            let mut patch = RunFormat::default();
            let mut missing = false;
            macro_rules! fill {
                ($field:ident) => {
                    if r.style.$field.is_none() && run_defaults.$field.is_some() {
                        patch.$field = Some(run_defaults.$field.clone());
                        missing = true;
                    }
                };
            }
            fill!(bold);
            fill!(italic);
            fill!(underline);
            fill!(color);
            fill!(font_family);
            fill!(font_size_points);
            if !missing {
                runs.push(r.clone());
                continue;
            }
            paragraph_changed = true;
            runs.push(run(r.id.clone(), &r.text, &style_patch(&r.style, &patch)?, r.can_edit)?);
        }
        let mut next = p.clone();
        let mut properties = false;
        macro_rules! inherit {
            ($field:ident) => {
                if next.$field.is_none() && paragraph_defaults.$field.is_some() {
                    next.$field = paragraph_defaults.$field.clone();
                    properties = true;
                }
            };
        }
        inherit!(alignment);
        inherit!(spacing_before_points);
        inherit!(spacing_after_points);
        inherit!(line_spacing_multiple);
        if !paragraph_changed && !properties {
            paragraphs.push(p.clone());
            continue;
        }
        changed = true;
        next.runs = runs;
        paragraphs.push(with_text(next));
    }
    if !changed {
        return Ok(document.clone());
    }
    let mut result = document.clone();
    result.doc.paragraphs = paragraphs;
    Ok(result)
}
