//! Converted copies: Word, RTF, OpenDocument, plain text and Markdown. A port
//! of `src/lib/export-formats.ts`, writing through Markie's own codecs
//! (markie-office), which re-read their output before it is returned.
//!
//! What survives, by format, is what the TypeScript says: Word keeps headings,
//! bold, italic, code font, nested lists, links and tables; RTF and ODT keep
//! text and formatting, with tables as tab-separated rows and link addresses in
//! brackets; plain text keeps the words, list markers and link addresses.

use markie_office::model::{Format, Operation, ParagraphFormat, RunFormat};
use markie_office::rich_document::{apply_rich_operations, create_rich_document, export_rich_document};
use markie_office::zip::{DEFAULT_ZIP_LIMITS, ZipEntry, write_zip};

use crate::mdast::{self, Md};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ExportFormat {
    Docx,
    Rtf,
    Odt,
    Txt,
    Md,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Markdown,
    Text,
}

pub struct FormatInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub extension: &'static str,
    pub mime: &'static str,
    pub filter_name: &'static str,
}

impl ExportFormat {
    pub const ALL: [ExportFormat; 5] = [ExportFormat::Docx, ExportFormat::Rtf, ExportFormat::Odt, ExportFormat::Txt, ExportFormat::Md];

    pub fn info(self) -> FormatInfo {
        match self {
            Self::Docx => FormatInfo { id: "docx", label: "Word (.docx)", extension: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filter_name: "Word Document" },
            Self::Rtf => FormatInfo { id: "rtf", label: "RTF (.rtf)", extension: "rtf", mime: "application/rtf", filter_name: "Rich Text Format" },
            Self::Odt => FormatInfo { id: "odt", label: "OpenDocument (.odt)", extension: "odt", mime: "application/vnd.oasis.opendocument.text", filter_name: "OpenDocument Text" },
            Self::Txt => FormatInfo { id: "txt", label: "Plain text (.txt)", extension: "txt", mime: "text/plain", filter_name: "Plain Text" },
            Self::Md => FormatInfo { id: "md", label: "Markdown (.md)", extension: "md", mime: "text/markdown", filter_name: "Markdown" },
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.info().id == id)
    }
}

/// One line of honest disclosure for the menu.
pub const EXPORT_FORMAT_NOTE: &str = "RTF and ODT keep text and formatting. Tables there become tab-separated rows.";

/// The formats offered for a document. A format is not offered as an export of itself.
pub fn formats_for(source: SourceKind) -> Vec<ExportFormat> {
    ExportFormat::ALL
        .into_iter()
        .filter(|f| match source {
            SourceKind::Markdown => *f != ExportFormat::Md,
            SourceKind::Text => *f != ExportFormat::Txt,
        })
        .collect()
}

/// "Notes.md" becomes "Notes.docx"; no name becomes "document.docx".
pub fn export_file_name(file_name: Option<&str>, format: ExportFormat) -> String {
    let name = file_name.unwrap_or("");
    let base = match name.rfind('.') {
        Some(dot) if !name[dot + 1..].is_empty() && !name[dot + 1..].contains(['.', '/', '\\']) => &name[..dot],
        _ => name,
    };
    let base = base.trim();
    let base = if base.is_empty() { "document" } else { base };
    format!("{base}.{}", format.info().extension)
}

/// Produce the bytes of `text` (a document of kind `source`) in `format`.
pub fn convert_for_export(text: &str, source: SourceKind, format: ExportFormat) -> Result<Vec<u8>, String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if format == ExportFormat::Md {
        return Ok(match source {
            SourceKind::Markdown => normalized.into_bytes(),
            SourceKind::Text => text_to_markdown(&normalized).into_bytes(),
        });
    }
    if format == ExportFormat::Txt && source == SourceKind::Text {
        return Ok(normalized.into_bytes());
    }
    let blocks = match source {
        SourceKind::Markdown => markdown_blocks(&normalized),
        SourceKind::Text => text_blocks(&normalized),
    };
    match format {
        ExportFormat::Txt => Ok(blocks_to_text(&blocks).into_bytes()),
        ExportFormat::Docx => blocks_to_docx(&blocks),
        ExportFormat::Rtf => blocks_to_flat_rich(Format::Rtf, &blocks),
        ExportFormat::Odt => blocks_to_flat_rich(Format::Odt, &blocks),
        ExportFormat::Md => unreachable!(),
    }
}

// ── The document model every writer reads ────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct ExportInline {
    pub text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub code: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExportBlock {
    Heading { level: u8, content: Vec<ExportInline> },
    Paragraph { content: Vec<ExportInline>, quote: bool },
    Item { content: Vec<ExportInline>, list: usize, ordered: bool, number: u64, depth: usize, checked: Option<bool>, quote: bool },
    Code { text: String, quote: bool },
    Table { rows: Vec<Vec<Vec<ExportInline>>> },
    Rule,
}

fn text_blocks(text: &str) -> Vec<ExportBlock> {
    text.split('\n')
        .map(|line| ExportBlock::Paragraph { content: if line.is_empty() { vec![] } else { vec![ExportInline { text: line.into(), ..Default::default() }] }, quote: false })
        .collect()
}

/// `splitFrontMatter`'s rule: `---` line, anything, then `---` or `...`.
pub fn split_front_matter(md: &str) -> (&str, &str) {
    let first_end = md.find('\n');
    let Some(first_end) = first_end else { return ("", md) };
    let first = md[..first_end].trim_end_matches('\r');
    if first != "---" {
        return ("", md);
    }
    let mut at = first_end + 1;
    while at <= md.len() {
        let end = md[at..].find('\n').map(|e| at + e).unwrap_or(md.len());
        let line = md[at..end].trim_end_matches('\r');
        if (line == "---" || line == "...") && at > first_end + 1 {
            let stop = if end < md.len() { end + 1 } else { end };
            return (&md[..stop], &md[stop..]);
        }
        if end >= md.len() {
            break;
        }
        at = end + 1;
    }
    ("", md)
}

struct Ctx<'a> {
    quote: bool,
    depth: usize,
    lists: &'a mut usize,
    root_list: Option<usize>,
}

/// Markdown parsed the way the renderer parses it, front matter set aside.
pub fn markdown_blocks(markdown: &str) -> Vec<ExportBlock> {
    let (_, body) = split_front_matter(markdown);
    let tree = mdast::parse(body);
    let mut blocks = Vec::new();
    let mut lists = 0usize;
    for node in &tree {
        let mut ctx = Ctx { quote: false, depth: 0, lists: &mut lists, root_list: None };
        flow(node, &mut blocks, &mut ctx);
    }
    blocks
}

fn flow(node: &Md, out: &mut Vec<ExportBlock>, ctx: &mut Ctx) {
    match node {
        Md::Heading(level, children) => out.push(ExportBlock::Heading { level: (*level).clamp(1, 6), content: phrasing(children, Marks::default()) }),
        Md::Paragraph(children) => {
            for content in split_on_breaks(phrasing(children, Marks::default())) {
                out.push(ExportBlock::Paragraph { content, quote: ctx.quote });
            }
        }
        Md::Quote(children) => {
            for child in children {
                let mut inner = Ctx { quote: true, depth: ctx.depth, lists: ctx.lists, root_list: ctx.root_list };
                flow(child, out, &mut inner);
            }
        }
        Md::List { ordered, start, items } => {
            let mut number = *start;
            let list = match ctx.root_list {
                Some(l) => l,
                None => {
                    *ctx.lists += 1;
                    *ctx.lists
                }
            };
            for item in items {
                let Md::Item { checked, children } = item else { continue };
                let (content, rest): (Vec<ExportInline>, &[Md]) = match children.first() {
                    Some(Md::Paragraph(p)) => (phrasing(p, Marks::default()), &children[1..]),
                    _ => (vec![], &children[..]),
                };
                out.push(ExportBlock::Item { content, list, ordered: *ordered, number, depth: ctx.depth, checked: *checked, quote: ctx.quote });
                for child in rest {
                    let mut inner = Ctx { quote: ctx.quote, depth: ctx.depth + 1, lists: ctx.lists, root_list: Some(list) };
                    flow(child, out, &mut inner);
                }
                number += 1;
            }
        }
        Md::Code(text) | Md::Math(text) => out.push(ExportBlock::Code { text: text.clone(), quote: ctx.quote }),
        Md::Table(rows) => out.push(ExportBlock::Table { rows: rows.iter().map(|row| row.iter().map(|cell| phrasing(cell, Marks::default())).collect()).collect() }),
        Md::Rule => out.push(ExportBlock::Rule),
        Md::Html(value) => {
            let text = strip_tags(value);
            if !text.trim().is_empty() {
                out.push(ExportBlock::Paragraph { content: vec![ExportInline { text, ..Default::default() }], quote: ctx.quote });
            }
        }
        Md::FootnoteDefinition { label, children } => {
            let mut inner = Vec::new();
            for child in children {
                let mut c = Ctx { quote: ctx.quote, depth: ctx.depth, lists: ctx.lists, root_list: ctx.root_list };
                flow(child, &mut inner, &mut c);
            }
            if let Some(ExportBlock::Paragraph { content, .. } | ExportBlock::Item { content, .. }) = inner.first_mut() {
                content.insert(0, ExportInline { text: format!("[{label}] "), ..Default::default() });
            }
            out.extend(inner);
        }
        _ => {}
    }
}

#[derive(Clone, Default)]
struct Marks {
    bold: bool,
    italic: bool,
    href: Option<String>,
}

fn phrasing(children: &[Md], marks: Marks) -> Vec<ExportInline> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<ExportInline>, text: String, code: bool, marks: &Marks| {
        if !text.is_empty() {
            out.push(ExportInline { text, bold: marks.bold, italic: marks.italic, code, href: marks.href.clone() });
        }
    };
    for node in children {
        match node {
            Md::Text(t) => push(&mut out, t.replace('\n', " "), false, &marks),
            Md::Strong(c) => out.extend(phrasing(c, Marks { bold: true, ..marks.clone() })),
            Md::Emphasis(c) => out.extend(phrasing(c, Marks { italic: true, ..marks.clone() })),
            Md::Delete(c) => out.extend(phrasing(c, marks.clone())),
            Md::InlineCode(v) | Md::InlineMath(v) => push(&mut out, v.clone(), true, &marks),
            Md::Break => out.push(ExportInline { text: "\n".into(), ..Default::default() }),
            Md::Link { url, children } => out.extend(phrasing(children, Marks { href: Some(url.clone()), ..marks.clone() })),
            Md::Image { alt } => push(&mut out, if alt.is_empty() { "[image]".into() } else { format!("[{alt}]") }, false, &marks),
            Md::FootnoteReference(label) => push(&mut out, format!("[{label}]"), false, &marks),
            Md::InlineHtml(_) => {}
            other => push(&mut out, mdast::plain(other), false, &marks),
        }
    }
    out
}

fn split_on_breaks(content: Vec<ExportInline>) -> Vec<Vec<ExportInline>> {
    let mut lines: Vec<Vec<ExportInline>> = vec![vec![]];
    for inline in content {
        if inline.text == "\n" && !inline.code {
            lines.push(vec![]);
        } else {
            lines.last_mut().unwrap().push(inline);
        }
    }
    lines.into_iter().enumerate().filter(|(i, l)| !l.is_empty() || *i == 0).map(|(_, l)| l).collect()
}

fn strip_tags(html: &str) -> String {
    let mut s = String::new();
    let mut rest = html;
    while let Some(a) = rest.find("<!--") {
        s.push_str(&rest[..a]);
        rest = match rest[a..].find("-->") {
            Some(e) => &rest[a + e + 3..],
            None => {
                s.push_str(&rest[a..]);
                ""
            }
        };
    }
    s.push_str(rest);
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(a) = rest.find('<') {
        out.push_str(&rest[..a]);
        match rest[a..].find('>') {
            Some(e) => rest = &rest[a + e + 1..],
            None => {
                out.push_str(&rest[a..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&").trim().to_string()
}

// ── Plain text ───────────────────────────────────────────────────────────

fn link_label(content: &[ExportInline], i: usize, href: &str) -> String {
    let mut label = String::new();
    let mut j = i as isize;
    while j >= 0 && content[j as usize].href.as_deref() == Some(href) {
        label = format!("{}{label}", content[j as usize].text);
        j -= 1;
    }
    label
}

fn inline_text(content: &[ExportInline]) -> String {
    let mut result = String::new();
    for (i, inline) in content.iter().enumerate() {
        result.push_str(&inline.text);
        if let Some(href) = &inline.href
            && content.get(i + 1).and_then(|n| n.href.as_ref()) != Some(href)
        {
            let label = link_label(content, i, href);
            if label.trim() != href && format!("mailto:{}", label.trim()) != *href {
                result.push_str(&format!(" ({href})"));
            }
        }
    }
    result
}

fn item_marker(ordered: bool, number: u64, checked: Option<bool>) -> String {
    format!(
        "{} {}",
        if ordered { format!("{number}.") } else { "-".into() },
        match checked {
            Some(true) => "[x] ",
            Some(false) => "[ ] ",
            None => "",
        }
    )
}

pub fn blocks_to_text(blocks: &[ExportBlock]) -> String {
    let mut out = String::new();
    let mut previous: Option<&ExportBlock> = None;
    for block in blocks {
        let q = |quote: bool| if quote { "> " } else { "" };
        let text = match block {
            ExportBlock::Heading { content, .. } => inline_text(content),
            ExportBlock::Paragraph { content, quote } => format!("{}{}", q(*quote), inline_text(content)),
            ExportBlock::Item { content, ordered, number, depth, checked, quote, .. } => {
                format!("{}{}{}{}", q(*quote), "  ".repeat(*depth), item_marker(*ordered, *number, *checked), inline_text(content))
            }
            ExportBlock::Code { text, quote } => text.split('\n').map(|l| format!("{}{l}", q(*quote))).collect::<Vec<_>>().join("\n"),
            ExportBlock::Table { rows } => rows.iter().map(|r| r.iter().map(|c| inline_text(c)).collect::<Vec<_>>().join("\t")).collect::<Vec<_>>().join("\n"),
            ExportBlock::Rule => "* * *".into(),
        };
        let joiner = match previous {
            None => "",
            Some(ExportBlock::Item { .. }) if matches!(block, ExportBlock::Item { .. }) => "\n",
            Some(_) => "\n\n",
        };
        out.push_str(joiner);
        out.push_str(&text);
        previous = Some(block);
    }
    if out.is_empty() { out } else { out + "\n" }
}

// ── Markdown from plain text ─────────────────────────────────────────────

pub fn text_to_markdown(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        let mut escaped = String::new();
        for c in line.chars() {
            if "\\`*_[]<>|~$&".contains(c) {
                escaped.push('\\');
            }
            escaped.push(c);
        }
        // ^(\s*)([#+=-]) and ^(\s*)(\d+)([.)])
        let lead = escaped.len() - escaped.trim_start().len();
        let (ws, body) = escaped.split_at(lead);
        let body = if body.starts_with(['#', '+', '=', '-']) {
            format!("\\{body}")
        } else {
            let digits = body.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 && body[digits..].starts_with(['.', ')']) { format!("{}\\{}", &body[..digits], &body[digits..]) } else { body.to_string() }
        };
        // Leading indentation becomes non-breaking spaces.
        let ws_lead = ws.len() - ws.trim_start_matches([' ', '\t']).len();
        let nbsp: String = ws[..ws_lead].replace('\t', "    ").replace(' ', "\u{a0}");
        let escaped = format!("{nbsp}{}{body}", &ws[ws_lead..]);
        let hard = !line.trim().is_empty() && lines.get(i + 1).is_some_and(|n| !n.trim().is_empty());
        out.push(if hard { format!("{escaped}\\") } else { escaped });
    }
    out.join("\n")
}

// ── Rich lines shared by the Word, RTF and ODT writers ───────────────────

#[derive(Clone, Debug, Default)]
struct RichSpan {
    start: usize,
    end: usize,
    bold: bool,
    italic: bool,
    code: bool,
    href: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Body,
    Heading,
    Item,
    Code,
    Rule,
}

#[derive(Clone, Debug)]
struct RichLine {
    text: String,
    spans: Vec<RichSpan>,
    role: Role,
    level: u8,
    quote: bool,
    bold: bool,
    group: String,
}

impl RichLine {
    fn new(text: String, spans: Vec<RichSpan>, role: Role) -> Self {
        Self { text, spans, role, level: 0, quote: false, bold: false, group: String::new() }
    }
}

const CODE_FONT: &str = "Courier New";
const LINK_COLOR: &str = "1155CC";

fn clean(text: &str) -> String {
    text.chars().filter(|&c| !matches!(c as u32, 0..=8 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f)).collect()
}

fn line_from(content: &[ExportInline], tabs: &str, keep: &dyn Fn(&str) -> bool, address: &dyn Fn(&str) -> bool) -> (String, Vec<RichSpan>) {
    let mut text = String::new();
    let mut spans = Vec::new();
    for (i, inline) in content.iter().enumerate() {
        let value = clean(&inline.text).replace('\n', " ").replace('\t', tabs);
        let start = text.len();
        text.push_str(&value);
        let href = inline.href.as_ref().filter(|h| keep(h)).cloned();
        if !value.is_empty() && (inline.bold || inline.italic || inline.code || href.is_some()) {
            spans.push(RichSpan { start, end: text.len(), bold: inline.bold, italic: inline.italic, code: inline.code, href });
        }
        if let Some(href) = &inline.href
            && content.get(i + 1).and_then(|n| n.href.as_ref()) != Some(href)
            && address(href)
        {
            let label = link_label(content, i, href);
            if label.trim() != href && format!("mailto:{}", label.trim()) != *href {
                text.push_str(&format!(" ({})", clean(href)));
            }
        }
    }
    (text, spans)
}

fn code_lines(text: &str, quote: bool, tabs: &str) -> Vec<RichLine> {
    clean(text)
        .replace('\t', tabs)
        .split('\n')
        .map(|line| {
            let spans = if line.is_empty() { vec![] } else { vec![RichSpan { start: 0, end: line.len(), code: true, ..Default::default() }] };
            RichLine { quote, ..RichLine::new(line.to_string(), spans, Role::Code) }
        })
        .collect()
}

// ── Word ─────────────────────────────────────────────────────────────────

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn xml_text(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
fn xml_attr(t: &str) -> String {
    xml_text(t).replace('"', "&quot;")
}

fn linkable(href: &str) -> bool {
    markie_office::docx::safe_docx_hyperlink_target(href).is_ok()
}

fn runs_xml(line: &RichLine, link_id: &mut dyn FnMut(&str) -> String) -> String {
    if line.text.is_empty() {
        return String::new();
    }
    let mut cuts = std::collections::BTreeSet::from([0, line.text.len()]);
    for s in &line.spans {
        cuts.insert(s.start);
        cuts.insert(s.end);
    }
    let points: Vec<usize> = cuts.into_iter().collect();
    let mut out = String::new();
    let mut open_link: Option<String> = None;
    for w in points.windows(2) {
        let (start, end) = (w[0], w[1]);
        let covering: Vec<&RichSpan> = line.spans.iter().filter(|s| s.start <= start && s.end >= end).collect();
        let bold = line.bold || covering.iter().any(|s| s.bold);
        let italic = line.quote || covering.iter().any(|s| s.italic);
        let code = line.role == Role::Code || covering.iter().any(|s| s.code);
        let href = covering.iter().find_map(|s| s.href.clone());
        if href != open_link {
            if open_link.is_some() {
                out.push_str("</w:hyperlink>");
            }
            if let Some(h) = &href {
                out.push_str(&format!("<w:hyperlink r:id=\"{}\">", link_id(h)));
            }
            open_link = href.clone();
        }
        let mut props = String::new();
        if code {
            props.push_str(&format!("<w:rFonts w:ascii=\"{CODE_FONT}\" w:hAnsi=\"{CODE_FONT}\" w:eastAsia=\"{CODE_FONT}\" w:cs=\"{CODE_FONT}\"/>"));
        }
        if bold {
            props.push_str("<w:b w:val=\"1\"/>");
        }
        if italic {
            props.push_str("<w:i w:val=\"1\"/>");
        }
        if href.is_some() {
            props.push_str(&format!("<w:color w:val=\"{LINK_COLOR}\"/><w:u w:val=\"single\"/>"));
        }
        let rpr = if props.is_empty() { String::new() } else { format!("<w:rPr>{props}</w:rPr>") };
        out.push_str(&format!("<w:r>{rpr}<w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_text(&line.text[start..end])));
    }
    if open_link.is_some() {
        out.push_str("</w:hyperlink>");
    }
    out
}

fn table_xml(rows: &[Vec<RichLine>], link_id: &mut dyn FnMut(&str) -> String) -> String {
    let columns = rows[0].len();
    let cell_width = (9360 / columns).max(360);
    let border = "w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"";
    let grid: String = (0..columns).map(|_| format!("<w:gridCol w:w=\"{cell_width}\"/>")).collect();
    let mut body = String::new();
    for row in rows {
        body.push_str("<w:tr>");
        for cell in row {
            body.push_str(&format!("<w:tc><w:tcPr><w:tcW w:w=\"{cell_width}\" w:type=\"dxa\"/></w:tcPr><w:p>{}</w:p></w:tc>", runs_xml(cell, link_id)));
        }
        body.push_str("</w:tr>");
    }
    format!(
        "<w:tbl><w:tblPr><w:tblW w:w=\"{}\" w:type=\"dxa\"/><w:tblBorders><w:top {border}/><w:left {border}/><w:bottom {border}/><w:right {border}/><w:insideH {border}/><w:insideV {border}/></w:tblBorders></w:tblPr><w:tblGrid>{grid}</w:tblGrid>{body}</w:tbl>",
        cell_width * columns
    )
}

#[derive(Default)]
struct ListDef {
    kinds: Vec<Option<bool>>,
    starts: Vec<Option<u64>>,
}

fn blocks_to_docx(blocks: &[ExportBlock]) -> Result<Vec<u8>, String> {
    let keep = |h: &str| linkable(h);
    let address = |h: &str| !linkable(h);
    let docx_line = |content: &[ExportInline]| line_from(content, "    ", &keep, &address);
    let mut links: Vec<String> = Vec::new();
    let mut lists: Vec<ListDef> = Vec::new();
    let mut current: Option<(usize, usize)> = None;
    let mut body: Vec<String> = Vec::new();
    let mut last_was_table = false;
    let link_id = |links: &mut Vec<String>, href: &str| {
        let index = match links.iter().position(|l| l == href) {
            Some(i) => i,
            None => {
                links.push(href.to_string());
                links.len() - 1
            }
        };
        format!("rIdLink{}", index + 1)
    };
    let paragraph = |body: &mut Vec<String>, links: &mut Vec<String>, line: &RichLine, list: Option<(usize, usize)>| {
        let mut props = String::new();
        if line.role == Role::Heading {
            props.push_str(&format!("<w:pStyle w:val=\"Heading{}\"/>", line.level.min(3)));
        }
        if let Some((num_id, level)) = list {
            props.push_str(&format!("<w:numPr><w:ilvl w:val=\"{level}\"/><w:numId w:val=\"{num_id}\"/></w:numPr>"));
        }
        if line.role == Role::Rule {
            props.push_str("<w:jc w:val=\"center\"/>");
        }
        let ppr = if props.is_empty() { String::new() } else { format!("<w:pPr>{props}</w:pPr>") };
        let runs = runs_xml(line, &mut |h| link_id(links, h));
        body.push(format!("<w:p>{ppr}{runs}</w:p>"));
    };
    for block in blocks {
        if !matches!(block, ExportBlock::Item { .. }) {
            current = None;
        }
        match block {
            ExportBlock::Heading { level, content } => {
                let (text, spans) = docx_line(content);
                paragraph(&mut body, &mut links, &RichLine { level: *level, ..RichLine::new(text, spans, Role::Heading) }, None);
                last_was_table = false;
            }
            ExportBlock::Paragraph { content, quote } => {
                let (text, spans) = docx_line(content);
                paragraph(&mut body, &mut links, &RichLine { quote: *quote, ..RichLine::new(text, spans, Role::Body) }, None);
                last_was_table = false;
            }
            ExportBlock::Item { content, list, ordered, number, depth, checked, quote } => {
                let (text, spans) = docx_line(content);
                let boxed = match checked {
                    Some(true) => "☑ ",
                    Some(false) => "☐ ",
                    None => "",
                };
                if current.map(|(id, _)| id) != Some(*list) {
                    lists.push(ListDef::default());
                    current = Some((*list, lists.len()));
                }
                let (_, num_id) = current.unwrap();
                let level = (*depth).min(8);
                let def = &mut lists[num_id - 1];
                if def.kinds.len() <= level {
                    def.kinds.resize(level + 1, None);
                    def.starts.resize(level + 1, None);
                }
                def.kinds[level].get_or_insert(*ordered);
                def.starts[level].get_or_insert(*number);
                let offset = boxed.len();
                let spans = spans.into_iter().map(|s| RichSpan { start: s.start + offset, end: s.end + offset, ..s }).collect();
                paragraph(&mut body, &mut links, &RichLine { quote: *quote, ..RichLine::new(format!("{boxed}{text}"), spans, Role::Item) }, Some((num_id, level)));
                last_was_table = false;
            }
            ExportBlock::Code { text, quote } => {
                for line in code_lines(text, *quote, "    ") {
                    paragraph(&mut body, &mut links, &line, None);
                }
                last_was_table = false;
            }
            ExportBlock::Rule => {
                paragraph(&mut body, &mut links, &RichLine::new("* * *".into(), vec![], Role::Rule), None);
                last_was_table = false;
            }
            ExportBlock::Table { rows } if !rows.is_empty() => {
                let columns = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
                let lines: Vec<Vec<RichLine>> = rows
                    .iter()
                    .enumerate()
                    .map(|(r, row)| {
                        (0..columns)
                            .map(|c| {
                                let (text, spans) = docx_line(row.get(c).map(Vec::as_slice).unwrap_or(&[]));
                                RichLine { bold: r == 0, ..RichLine::new(text, spans, Role::Body) }
                            })
                            .collect()
                    })
                    .collect();
                body.push(table_xml(&lines, &mut |h| link_id(&mut links, h)));
                last_was_table = true;
            }
            ExportBlock::Table { .. } => {}
        }
    }
    if last_was_table || body.is_empty() {
        body.push("<w:p/>".into());
    }
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"{W_NS}\" xmlns:r=\"{R_NS}\"><w:body>{}<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>",
        body.join("")
    );
    let headings: String = [("Heading1", "Heading 1", 40, 0), ("Heading2", "Heading 2", 32, 1), ("Heading3", "Heading 3", 28, 2)]
        .iter()
        .map(|(id, name, size, level)| format!("<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"120\"/><w:outlineLvl w:val=\"{level}\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"{size}\"/></w:rPr></w:style>"))
        .collect();
    let styles = format!("<w:styles xmlns:w=\"{W_NS}\"><w:style w:type=\"paragraph\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"120\"/></w:pPr><w:rPr></w:rPr></w:style>{headings}</w:styles>");
    const BULLETS: [&str; 3] = ["•", "◦", "▪"];
    let level_xml = |ordered: bool, start: u64, level: usize| {
        format!(
            "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"{}\"/><w:numFmt w:val=\"{}\"/><w:suff w:val=\"tab\"/><w:lvlText w:val=\"{}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
            start.min(32767),
            if ordered { "decimal" } else { "bullet" },
            if ordered { format!("%{}.", level + 1) } else { BULLETS[level % 3].to_string() },
            720 * (level + 1)
        )
    };
    let numbering = if lists.is_empty() {
        String::new()
    } else {
        let abstracts: String = lists
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let levels: String = (0..9).map(|lv| level_xml(l.kinds.get(lv).copied().flatten().unwrap_or(false), l.starts.get(lv).copied().flatten().unwrap_or(1), lv)).collect();
                format!("<w:abstractNum w:abstractNumId=\"{i}\"><w:multiLevelType w:val=\"multilevel\"/>{levels}</w:abstractNum>")
            })
            .collect();
        let nums: String = (0..lists.len()).map(|i| format!("<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"{i}\"/></w:num>", i + 1)).collect();
        format!("<w:numbering xmlns:w=\"{W_NS}\">{abstracts}{nums}</w:numbering>")
    };
    let link_rels: String = links.iter().enumerate().map(|(i, h)| format!("<Relationship Id=\"rIdLink{}\" Type=\"{OFFICE_REL}/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>", i + 1, xml_attr(h))).collect();
    let numbering_rel = if numbering.is_empty() { String::new() } else { format!("<Relationship Id=\"rIdNumbering\" Type=\"{OFFICE_REL}/numbering\" Target=\"numbering.xml\"/>") };
    let relationships = format!("<Relationships xmlns=\"{PKG_REL}\"><Relationship Id=\"rIdStyles\" Type=\"{OFFICE_REL}/styles\" Target=\"styles.xml\"/>{numbering_rel}{link_rels}</Relationships>");
    let numbering_type = if numbering.is_empty() { String::new() } else { "<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>".into() };
    let types = format!("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>{numbering_type}</Types>");
    let mut parts = vec![
        ("[Content_Types].xml", types),
        ("_rels/.rels", format!("<Relationships xmlns=\"{PKG_REL}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_REL}/officeDocument\" Target=\"word/document.xml\"/></Relationships>")),
        ("word/document.xml", document),
        ("word/_rels/document.xml.rels", relationships),
        ("word/styles.xml", styles),
    ];
    if !numbering.is_empty() {
        parts.push(("word/numbering.xml", numbering));
    }
    let entries: Vec<ZipEntry> = parts.into_iter().map(|(name, data)| ZipEntry::new(name, data.into_bytes())).collect();
    let bytes = write_zip(&entries, DEFAULT_ZIP_LIMITS).map_err(|e| e.to_string())?;
    let reopened = markie_office::docx::open_docx(&bytes, DEFAULT_ZIP_LIMITS).map_err(|e| e.to_string())?;
    if !reopened.can_edit {
        return Err("The Word file came out outside what Markie can open. Nothing was saved.".into());
    }
    Ok(bytes)
}

// ── RTF and OpenDocument ─────────────────────────────────────────────────

const HEADING_POINTS: [f64; 6] = [24.0, 18.0, 15.0, 13.0, 12.0, 12.0];

fn tabbed_row(cells: Vec<(String, Vec<RichSpan>)>, header: bool) -> RichLine {
    let mut text = String::new();
    let mut spans = Vec::new();
    for (c, (cell_text, cell_spans)) in cells.into_iter().enumerate() {
        if c > 0 {
            text.push('\t');
        }
        let offset = text.len();
        text.push_str(&cell_text);
        spans.extend(cell_spans.into_iter().map(|s| RichSpan { start: s.start + offset, end: s.end + offset, ..s }));
    }
    RichLine { bold: header, ..RichLine::new(text, spans, Role::Body) }
}

fn style_of(bold: bool, italic: bool, code: bool, link: bool, size: Option<f64>) -> RunFormat {
    RunFormat {
        bold: bold.then_some(Some(true)),
        italic: italic.then_some(Some(true)),
        underline: link.then(|| Some("single".to_string())),
        color: link.then(|| Some(LINK_COLOR.to_string())),
        font_family: code.then(|| Some(CODE_FONT.to_string())),
        font_size_points: size.map(Some),
    }
}

fn is_empty_style(s: &RunFormat) -> bool {
    s.bold.is_none() && s.italic.is_none() && s.underline.is_none() && s.color.is_none() && s.font_family.is_none() && s.font_size_points.is_none()
}

fn blocks_to_flat_rich(format: Format, blocks: &[ExportBlock]) -> Result<Vec<u8>, String> {
    let all = |_: &str| true;
    let flat = |content: &[ExportInline]| line_from(content, "\t", &all, &all);
    let mut lines: Vec<RichLine> = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let start = lines.len();
        match block {
            ExportBlock::Heading { level, content } => {
                let (t, s) = flat(content);
                lines.push(RichLine { level: *level, ..RichLine::new(t, s, Role::Heading) });
            }
            ExportBlock::Paragraph { content, quote } => {
                let (t, s) = flat(content);
                lines.push(RichLine { quote: *quote, ..RichLine::new(t, s, Role::Body) });
            }
            ExportBlock::Item { content, ordered, number, depth, checked, quote, .. } => {
                let (t, s) = flat(content);
                let marker = format!(
                    "{}{}{}",
                    "    ".repeat(*depth),
                    if *ordered { format!("{number}. ") } else { "• ".into() },
                    match checked {
                        Some(true) => "☑ ",
                        Some(false) => "☐ ",
                        None => "",
                    }
                );
                let off = marker.len();
                let s = s.into_iter().map(|x| RichSpan { start: x.start + off, end: x.end + off, ..x }).collect();
                lines.push(RichLine { quote: *quote, ..RichLine::new(format!("{marker}{t}"), s, Role::Item) });
            }
            ExportBlock::Code { text, quote } => lines.extend(code_lines(text, *quote, "\t")),
            ExportBlock::Rule => lines.push(RichLine::new("* * *".into(), vec![], Role::Rule)),
            ExportBlock::Table { rows } => {
                for (r, row) in rows.iter().enumerate() {
                    lines.push(tabbed_row(row.iter().map(|c| flat(c)).collect(), r == 0));
                }
            }
        }
        let group = match block {
            ExportBlock::Item { list, .. } => format!("list{list}"),
            _ => format!("block{index}"),
        };
        for line in &mut lines[start..] {
            line.group = group.clone();
        }
    }
    if lines.is_empty() {
        lines.push(RichLine::new(String::new(), vec![], Role::Body));
    }
    let joined = lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
    let doc = create_rich_document(format, &joined).map_err(|e| e.to_string())?;
    if doc.paragraphs.len() != lines.len() {
        return Err("The writer did not keep one paragraph per line.".into());
    }
    let mut ops = Vec::new();
    for (i, paragraph) in doc.paragraphs.iter().enumerate() {
        let line = &lines[i];
        let id = paragraph.id.clone();
        let whole = |ops: &mut Vec<Operation>, style: RunFormat| {
            if !line.text.is_empty() {
                ops.push(Operation::FormatRange { paragraph_id: id.clone(), start: 0, end: line.text.len(), style });
            }
        };
        let para = |ops: &mut Vec<Operation>, format: ParagraphFormat| ops.push(Operation::FormatParagraph { paragraph_id: id.clone(), format });
        if line.role == Role::Heading {
            whole(&mut ops, style_of(true, false, false, false, Some(HEADING_POINTS[(line.level.max(1) - 1) as usize])));
            para(&mut ops, ParagraphFormat { spacing_before_points: Some(Some(12.0)), spacing_after_points: Some(Some(6.0)), ..Default::default() });
        }
        if line.role == Role::Rule {
            para(&mut ops, ParagraphFormat { alignment: Some(Some("center".into())), ..Default::default() });
        }
        if line.role != Role::Heading && lines.get(i + 1).map(|n| n.group.as_str()) != Some(line.group.as_str()) {
            para(&mut ops, ParagraphFormat { spacing_after_points: Some(Some(6.0)), ..Default::default() });
        }
        if line.bold {
            whole(&mut ops, style_of(true, false, false, false, None));
        }
        if line.quote {
            whole(&mut ops, style_of(false, true, false, false, None));
        }
        for span in &line.spans {
            let style = style_of(span.bold, span.italic, span.code, span.href.is_some(), None);
            if !is_empty_style(&style) {
                ops.push(Operation::FormatRange { paragraph_id: id.clone(), start: span.start, end: span.end, style });
            }
        }
    }
    let doc = apply_rich_operations(&doc, &ops).map_err(|e| e.to_string())?;
    export_rich_document(&doc).map_err(|e| e.to_string())
}
