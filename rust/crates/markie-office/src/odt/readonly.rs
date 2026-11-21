//! Read-only display reader for OpenDocument text the editable codec refuses
//! (ODF 1.0/1.1/1.4, TextEdit and LibreOffice output, lists, tables, headings).
//! Ported from `odt-readonly.ts`. Nothing here is ever written back.

use super::{OFFICE, STYLE, SVG, TABLE, TEXT, FO, is};
use crate::error::{OfficeError, Result};
use crate::model::{ListKind, RunStyle, js_round};
use crate::rich_text_model::{BlockInput, ParagraphInput, RunInput};
use crate::xml::{XmlElement, parse_xml, xml_attribute};
use std::collections::HashMap;

const MAX_TEXT: usize = 1_000_000;
const MAX_PARAGRAPHS: usize = 10_000;
const MAX_REPEAT: usize = 64;
const MAX_CELLS: usize = 1024;
/// Every row and cell visit, counted across the whole read (nested repeats multiply).
const MAX_TABLE_WORK: usize = 200_000;
const SECTIONS: &[&str] = &[
    "section", "index-body", "table-of-content", "illustration-index", "table-index", "object-index", "user-index", "alphabetical-index",
    "bibliography", "index-title",
];
const OMITTED_INLINE: &[&str] = &["note", "hidden-text", "hidden-paragraph", "conditional-text", "script", "tracked-changes", "changed-region", "deletion"];

fn fail(message: &str) -> OfficeError {
    OfficeError::docx("unsupported-odt", message)
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Paragraph {
    alignment: Option<String>,
    spacing_before_points: Option<f64>,
    spacing_after_points: Option<f64>,
    line_spacing_multiple: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Resolved {
    run: RunStyle,
    paragraph: Paragraph,
}

fn points(value: Option<&str>, base: Option<f64>) -> Option<f64> {
    let value = value?.trim();
    let unit_at = value.find(|c: char| c.is_ascii_alphabetic() || c == '%')?;
    let (number, unit) = value.split_at(unit_at);
    let body = number.strip_prefix('-').unwrap_or(number);
    let valid = !body.is_empty()
        && body.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && body.matches('.').count() <= 1
        && !body.ends_with('.');
    if !valid {
        return None;
    }
    let factor = match unit {
        "pt" => 1.0,
        "in" => 72.0,
        "cm" => 72.0 / 2.54,
        "mm" => 72.0 / 25.4,
        "pc" => 12.0,
        "px" => 0.75,
        "%" => base? / 100.0,
        _ => return None,
    };
    let result: f64 = number.parse::<f64>().ok()? * factor;
    result.is_finite().then_some(result)
}

fn family(value: Option<&str>) -> Option<String> {
    let first = value?.split(',').next()?.trim();
    let unquoted = if first.len() >= 2 && ((first.starts_with('\'') && first.ends_with('\'')) || (first.starts_with('"') && first.ends_with('"'))) {
        &first[1..first.len() - 1]
    } else {
        first
    };
    let name = unquoted.trim();
    (!name.is_empty() && name.chars().map(char::len_utf16).sum::<usize>() <= 200 && !name.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}'))
        .then(|| name.to_string())
}

struct Styles<'a> {
    fonts: HashMap<String, String>,
    styles: HashMap<String, &'a XmlElement>,
    defaults: HashMap<String, &'a XmlElement>,
    lists: HashMap<String, &'a XmlElement>,
}

impl<'a> Styles<'a> {
    fn new(roots: &[&'a XmlElement]) -> Self {
        let mut s = Styles { fonts: HashMap::new(), styles: HashMap::new(), defaults: HashMap::new(), lists: HashMap::new() };
        for root in roots {
            for container in &root.children {
                if is(container, OFFICE, "font-face-decls") {
                    for face in &container.children {
                        if let (true, Some(name), Some(value)) = (is(face, STYLE, "font-face"), xml_attribute(face, "name", STYLE), family(xml_attribute(face, "font-family", SVG))) {
                            s.fonts.insert(name.to_string(), value);
                        }
                    }
                } else if is(container, OFFICE, "styles") || is(container, OFFICE, "automatic-styles") {
                    for node in &container.children {
                        let name = xml_attribute(node, "name", STYLE);
                        let kind = xml_attribute(node, "family", STYLE);
                        if let (true, Some(name), Some(kind)) = (is(node, STYLE, "style"), name, kind) {
                            s.styles.insert(format!("{kind}|{name}"), node);
                        } else if let (true, Some(kind)) = (is(node, STYLE, "default-style"), kind) {
                            s.defaults.insert(kind.to_string(), node);
                        } else if let (true, Some(name)) = (is(node, TEXT, "list-style"), name) {
                            s.lists.insert(name.to_string(), node);
                        }
                    }
                }
            }
        }
        s
    }

    fn apply(&self, node: &XmlElement, base: &Resolved) -> Resolved {
        let mut run = base.run.clone();
        let mut paragraph = base.paragraph.clone();
        for properties in &node.children {
            if is(properties, STYLE, "text-properties") {
                let weight = xml_attribute(properties, "font-weight", FO);
                let numeric = weight.filter(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit()));
                if weight == Some("bold") || weight == Some("bolder") || numeric.is_some_and(|w| w.parse::<u64>().unwrap_or(0) >= 600) {
                    run.bold = Some(true);
                } else if weight == Some("normal") || weight == Some("lighter") || numeric.is_some() {
                    run.bold = Some(false);
                }
                match xml_attribute(properties, "font-style", FO) {
                    Some("italic" | "oblique") => run.italic = Some(true),
                    Some("normal") => run.italic = Some(false),
                    _ => {}
                }
                if let Some(size) = points(xml_attribute(properties, "font-size", FO), Some(base.run.font_size_points.unwrap_or(12.0)))
                    && (1.0..=400.0).contains(&size)
                {
                    run.font_size_points = Some(js_round(size * 100.0) / 100.0);
                }
                let font = self
                    .fonts
                    .get(xml_attribute(properties, "font-name", STYLE).unwrap_or(""))
                    .cloned()
                    .or_else(|| family(xml_attribute(properties, "font-family", FO)));
                if font.is_some() {
                    run.font_family = font;
                }
                if let Some(color) = xml_attribute(properties, "color", FO)
                    && color.len() == 7
                    && color.starts_with('#')
                    && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
                {
                    run.color = Some(color[1..].to_string());
                }
                if let Some(u) = xml_attribute(properties, "text-underline-style", STYLE) {
                    run.underline = Some(if u == "none" { "none" } else { "single" }.into());
                }
            } else if is(properties, STYLE, "paragraph-properties") {
                let alignment = match xml_attribute(properties, "text-align", FO).unwrap_or("") {
                    "start" | "left" => Some("left"),
                    "end" | "right" => Some("right"),
                    "center" => Some("center"),
                    "justify" => Some("both"),
                    _ => None,
                };
                if let Some(a) = alignment {
                    paragraph.alignment = Some(a.into());
                }
                for (attribute, before) in [("margin-top", true), ("margin-bottom", false)] {
                    if let Some(v) = points(xml_attribute(properties, attribute, FO), None)
                        && (0.0..=1000.0).contains(&v)
                    {
                        let v = Some(js_round(v * 100.0) / 100.0);
                        if before {
                            paragraph.spacing_before_points = v;
                        } else {
                            paragraph.spacing_after_points = v;
                        }
                    }
                }
                if let Some(line) = xml_attribute(properties, "line-height", FO)
                    && let Some(number) = line.strip_suffix('%')
                    && super::is_decimal(number)
                {
                    let multiple = number.parse::<f64>().unwrap_or(0.0) / 100.0;
                    if (0.5..=5.0).contains(&multiple) {
                        paragraph.line_spacing_multiple = Some(multiple);
                    }
                }
            }
        }
        Resolved { run, paragraph }
    }

    fn resolve(&self, kind: &str, name: Option<&str>, base: &Resolved) -> Resolved {
        let mut chain: Vec<&XmlElement> = Vec::new();
        let mut seen: Vec<&str> = Vec::new();
        let mut current = name;
        while let Some(c) = current {
            if seen.contains(&c) || seen.len() >= 128 {
                break;
            }
            seen.push(c);
            let Some(node) = self.styles.get(&format!("{kind}|{c}")) else { break };
            chain.insert(0, node);
            current = xml_attribute(node, "parent-style-name", STYLE);
        }
        let mut result = base.clone();
        if let Some(fallback) = self.defaults.get(kind) {
            let resolved = self.apply(fallback, &Resolved::default());
            result = Resolved { run: merge_run(&resolved.run, &base.run), paragraph: merge_paragraph(&resolved.paragraph, &base.paragraph) };
        }
        for node in chain {
            result = self.apply(node, &result);
        }
        result
    }

    fn list_level(&self, name: Option<&str>, level: usize) -> (ListKind, u32) {
        let style = name.and_then(|n| self.lists.get(n));
        let wanted = (level + 1).to_string();
        let node = style.and_then(|s| s.children.iter().find(|c| c.namespace == TEXT && xml_attribute(c, "level", TEXT) == Some(wanted.as_str())));
        match node {
            Some(n) if n.local_name == "list-level-style-number" && xml_attribute(n, "num-format", STYLE).is_some() => {
                let start = xml_attribute(n, "start-value", TEXT).unwrap_or("1").parse::<u32>().ok().filter(|s| *s <= 1_000_000).unwrap_or(1);
                (ListKind::Numbered, start)
            }
            _ => (ListKind::Bullet, 1),
        }
    }
}

/// `{ ...under, ...over }` for run styles (defined fields of `over` win).
pub(crate) fn merge_run(under: &RunStyle, over: &RunStyle) -> RunStyle {
    RunStyle {
        bold: over.bold.or(under.bold),
        italic: over.italic.or(under.italic),
        underline: over.underline.clone().or_else(|| under.underline.clone()),
        color: over.color.clone().or_else(|| under.color.clone()),
        font_family: over.font_family.clone().or_else(|| under.font_family.clone()),
        font_size_points: over.font_size_points.or(under.font_size_points),
    }
}
fn merge_paragraph(under: &Paragraph, over: &Paragraph) -> Paragraph {
    Paragraph {
        alignment: over.alignment.clone().or_else(|| under.alignment.clone()),
        spacing_before_points: over.spacing_before_points.or(under.spacing_before_points),
        spacing_after_points: over.spacing_after_points.or(under.spacing_after_points),
        line_spacing_multiple: over.line_spacing_multiple.or(under.line_spacing_multiple),
    }
}

pub(crate) struct OdtDisplayBody {
    pub paragraphs: Vec<ParagraphInput>,
    pub blocks: Option<Vec<BlockInput>>,
    pub omitted: bool,
}

struct Reader<'a> {
    source: &'a str,
    styles: Styles<'a>,
    paragraphs: Vec<ParagraphInput>,
    layout: Vec<BlockInput>,
    characters: usize,
    omitted: bool,
    table_work: usize,
}

enum Sink<'s> {
    Top,
    Cell(&'s mut Vec<usize>),
}

impl Sink<'_> {
    fn push(&mut self, layout: &mut Vec<BlockInput>, index: usize) {
        match self {
            Sink::Top => layout.push(BlockInput::Paragraph(index)),
            Sink::Cell(cell) => cell.push(index),
        }
    }
}

fn hidden(node: &XmlElement) -> bool {
    matches!(xml_attribute(node, "display", TEXT), Some("none" | "condition")) || xml_attribute(node, "condition", TEXT).is_some()
}

fn repeat(node: &XmlElement, attribute: &str) -> usize {
    match xml_attribute(node, attribute, TABLE).unwrap_or("1").parse::<f64>() {
        Ok(v) if v.fract() == 0.0 && v >= 1.0 => (v as usize).min(MAX_REPEAT),
        _ => 1,
    }
}

struct Marker {
    kind: ListKind,
    level: usize,
    number: Option<u32>,
}

impl<'a> Reader<'a> {
    fn spend(&mut self) -> Result<()> {
        self.table_work += 1;
        if self.table_work > MAX_TABLE_WORK {
            return Err(fail("This OpenDocument file has tables larger than Markie can show."));
        }
        Ok(())
    }

    fn paragraph(&mut self, node: &XmlElement, marker: Option<Marker>) -> Result<usize> {
        if self.paragraphs.len() >= MAX_PARAGRAPHS {
            return Err(fail("This OpenDocument file has more paragraphs than Markie can show."));
        }
        let mut base = self.styles.resolve("paragraph", xml_attribute(node, "style-name", TEXT), &Resolved::default());
        if node.local_name == "h" {
            // Headings whose styles say nothing about emphasis still read as headings.
            let level = xml_attribute(node, "outline-level", TEXT).and_then(|v| v.parse::<f64>().ok()).filter(|v| *v != 0.0).unwrap_or(1.0);
            let level = level.clamp(1.0, 6.0) as usize;
            let size = [20.0, 16.0, 14.0, 13.0, 12.0, 12.0][level - 1];
            base.run = merge_run(&RunStyle { bold: Some(true), font_size_points: Some(size), ..Default::default() }, &base.run);
        }
        let mut runs: Vec<RunInput> = Vec::new();
        let mut pending: Option<RunStyle> = None;
        self.inline(node, &base.run, &mut runs, &mut pending)?;
        let index = self.paragraphs.len();
        let runs = if runs.is_empty() { vec![RunInput { text: String::new(), style: base.run.clone() }] } else { runs };
        self.paragraphs.push(ParagraphInput {
            runs,
            alignment: base.paragraph.alignment,
            spacing_before_points: base.paragraph.spacing_before_points,
            spacing_after_points: base.paragraph.spacing_after_points,
            line_spacing_multiple: base.paragraph.line_spacing_multiple,
            list_kind: marker.as_ref().map(|m| m.kind),
            list_level: marker.as_ref().map(|m| m.level.min(8) as u32),
            list_number: marker.and_then(|m| m.number),
        });
        Ok(index)
    }

    fn emit(&mut self, runs: &mut Vec<RunInput>, value: &str, style: &RunStyle) -> Result<()> {
        if value.is_empty() {
            return Ok(());
        }
        self.characters += value.chars().map(char::len_utf16).sum::<usize>();
        if self.characters > MAX_TEXT {
            return Err(fail("This OpenDocument file has more text than Markie can show."));
        }
        match runs.last_mut() {
            Some(previous) if previous.style == *style => previous.text.push_str(value),
            _ => runs.push(RunInput { text: value.to_string(), style: style.clone() }),
        }
        Ok(())
    }

    /// ODF section 6.1.2: literal white space collapses to one space; leading space drops.
    fn literal(&mut self, runs: &mut Vec<RunInput>, pending: &mut Option<RunStyle>, value: &str, style: &RunStyle) -> Result<()> {
        for (is_space, token) in super::split_whitespace_tokens(value) {
            if is_space {
                if pending.is_none() {
                    *pending = Some(style.clone());
                }
            } else {
                if let Some(p) = pending.take()
                    && !runs.is_empty()
                {
                    self.emit(runs, " ", &p)?;
                }
                self.emit(runs, token, style)?;
            }
        }
        Ok(())
    }

    fn explicit(&mut self, runs: &mut Vec<RunInput>, pending: &mut Option<RunStyle>, value: &str, style: &RunStyle) -> Result<()> {
        if let Some(p) = pending.take()
            && !runs.is_empty()
        {
            self.emit(runs, " ", &p)?;
        }
        self.emit(runs, value, style)
    }

    fn inline(&mut self, element: &XmlElement, style: &RunStyle, runs: &mut Vec<RunInput>, pending: &mut Option<RunStyle>) -> Result<()> {
        let mut cursor = element.start_tag_end;
        let source = self.source;
        let between = |this: &mut Self, runs: &mut Vec<RunInput>, pending: &mut Option<RunStyle>, from: usize, to: usize| -> Result<()> {
            if to > from {
                let text = parse_xml(&format!("<x>{}</x>", &source[from..to]))?.text;
                this.literal(runs, pending, &text, style)?;
            }
            Ok(())
        };
        for child in &element.children {
            between(self, runs, pending, cursor, child.start)?;
            cursor = child.end;
            if child.namespace != TEXT || OMITTED_INLINE.contains(&child.local_name.as_str()) || hidden(child) {
                self.omitted = true;
                continue;
            }
            match child.local_name.as_str() {
                "s" => {
                    let count = xml_attribute(child, "c", TEXT).unwrap_or("1").parse::<f64>().ok().filter(|c| c.fract() == 0.0 && *c >= 1.0);
                    let Some(count) = count else { continue };
                    if self.characters + count as usize > MAX_TEXT {
                        return Err(fail("This OpenDocument file has more text than Markie can show."));
                    }
                    self.explicit(runs, pending, &" ".repeat(count as usize), style)?;
                }
                "tab" => self.explicit(runs, pending, "\t", style)?,
                "line-break" => self.explicit(runs, pending, "\n", style)?,
                "span" => {
                    let resolved = self.styles.resolve("text", xml_attribute(child, "style-name", TEXT), &Resolved { run: style.clone(), paragraph: Paragraph::default() });
                    self.inline(child, &resolved.run, runs, pending)?;
                }
                // Links, fields, bookmarks, ruby and other text marks show their displayed text.
                _ => self.inline(child, style, runs, pending)?,
            }
        }
        if !element.self_closing() && element.end_tag_start > cursor {
            between(self, runs, pending, cursor, element.end_tag_start)?;
        }
        Ok(())
    }

    fn empty_paragraph(&mut self) -> Result<usize> {
        if self.paragraphs.len() >= MAX_PARAGRAPHS {
            return Err(fail("This OpenDocument file has more paragraphs than Markie can show."));
        }
        self.paragraphs.push(ParagraphInput { runs: vec![RunInput::default()], ..Default::default() });
        Ok(self.paragraphs.len() - 1)
    }

    fn blocks(&mut self, children: &[XmlElement], sink: &mut Sink, list: Option<(Option<String>, usize)>) -> Result<()> {
        for node in children {
            if node.namespace == TEXT && (node.local_name == "p" || node.local_name == "h") {
                let index = self.paragraph(node, None)?;
                sink.push(&mut self.layout, index);
            } else if is(node, TEXT, "list") {
                let style = xml_attribute(node, "style-name", TEXT).map(str::to_string).or_else(|| list.as_ref().and_then(|l| l.0.clone()));
                let level = list.as_ref().map_or(0, |l| l.1 + 1);
                self.items(node, sink, (style, level))?;
            } else if node.namespace == TEXT && SECTIONS.contains(&node.local_name.as_str()) {
                if hidden(node) {
                    self.omitted = true;
                } else {
                    self.blocks(&node.children, sink, list.clone())?;
                }
            } else if is(node, TABLE, "table") {
                self.table(node, sink)?;
            } else if node.namespace == TEXT
                && (node.local_name.ends_with("-decls") || node.local_name == "soft-page-break" || node.local_name.ends_with("-source"))
            {
                continue;
            } else {
                self.omitted = true;
            }
        }
        Ok(())
    }

    fn items(&mut self, node: &XmlElement, sink: &mut Sink, list: (Option<String>, usize)) -> Result<()> {
        let (kind, start) = self.styles.list_level(list.0.as_deref(), list.1);
        let mut number = start;
        for item in &node.children {
            let header = is(item, TEXT, "list-header");
            if !header && !is(item, TEXT, "list-item") {
                self.omitted = true;
                continue;
            }
            if !header
                && let Some(o) = xml_attribute(item, "start-value", TEXT).and_then(|v| v.parse::<u32>().ok()).filter(|v| *v <= 1_000_000)
            {
                number = o;
            }
            let mut first = !header;
            for child in &item.children {
                if first && child.namespace == TEXT && (child.local_name == "p" || child.local_name == "h") {
                    let marker = Marker { kind, level: list.1, number: (kind == ListKind::Numbered).then_some(number) };
                    let index = self.paragraph(child, Some(marker))?;
                    sink.push(&mut self.layout, index);
                    first = false;
                } else {
                    self.blocks(std::slice::from_ref(child), sink, Some(list.clone()))?;
                }
            }
            if !header {
                number += 1;
            }
        }
        Ok(())
    }

    fn table(&mut self, node: &XmlElement, sink: &mut Sink) -> Result<()> {
        let nested = !matches!(sink, Sink::Top);
        let mut rows: Vec<Vec<Vec<usize>>> = Vec::new();
        self.row_group(&node.children, sink, nested, &mut rows)?;
        if !rows.is_empty() {
            self.layout.push(BlockInput::Table(rows));
        }
        Ok(())
    }

    fn row_group(&mut self, children: &[XmlElement], sink: &mut Sink, nested: bool, rows: &mut Vec<Vec<Vec<usize>>>) -> Result<()> {
        for child in children {
            if is(child, TABLE, "table-row") {
                for _ in 0..repeat(child, "number-rows-repeated") {
                    self.spend()?;
                    let mut cells: Vec<Vec<usize>> = Vec::new();
                    for cell_node in &child.children {
                        // Covered cells sit under a spanning cell.
                        if !is(cell_node, TABLE, "table-cell") {
                            continue;
                        }
                        let mut copies = repeat(cell_node, "number-columns-repeated");
                        while copies > 0 && cells.len() < MAX_CELLS {
                            copies -= 1;
                            self.spend()?;
                            if nested {
                                // A table inside a cell is shown flattened in the outer cell.
                                self.blocks(&cell_node.children, sink, None)?;
                            } else {
                                let mut cell: Vec<usize> = Vec::new();
                                self.blocks(&cell_node.children, &mut Sink::Cell(&mut cell), None)?;
                                if cell.is_empty() {
                                    cell.push(self.empty_paragraph()?);
                                }
                                cells.push(cell);
                            }
                        }
                    }
                    if !cells.is_empty() {
                        rows.push(cells);
                    }
                }
            } else if child.namespace == TABLE && ["table-header-rows", "table-rows", "table-row-group"].contains(&child.local_name.as_str()) {
                self.row_group(&child.children, sink, nested, rows)?;
            }
        }
        Ok(())
    }
}

/// Reads office:text into display paragraphs and, where present, table blocks.
pub(crate) fn read_odt_display_body(source: &str, text: &XmlElement, roots: &[&XmlElement]) -> Result<OdtDisplayBody> {
    let mut reader = Reader {
        source,
        styles: Styles::new(roots),
        paragraphs: vec![],
        layout: vec![],
        characters: 0,
        omitted: false,
        table_work: 0,
    };
    reader.blocks(&text.children, &mut Sink::Top, None)?;
    if reader.paragraphs.is_empty() {
        reader.paragraphs.push(ParagraphInput { runs: vec![RunInput::default()], ..Default::default() });
    }
    let has_table = reader.layout.iter().any(|b| matches!(b, BlockInput::Table(_)));
    Ok(OdtDisplayBody { paragraphs: reader.paragraphs, blocks: has_table.then_some(reader.layout), omitted: reader.omitted })
}
