//! Word, RTF and ODT documents to PDF and print: `src/lib/office/docx-print.ts`
//! moved onto the Typst path (OFFICE.md said printing would land here).
//!
//! The gate is the TypeScript's `canPrintDocx`, rule for rule. The page is
//! the document's own size and margins, white paper, Georgia 12pt as the
//! default face, each paragraph's alignment, spacing and line multiple
//! (1.4 when unset), list markers, tables with 0.5pt grey rules, pictures at
//! their own size, and page breaks where the runs hold them.

use markie_office::model::{ImageType, ListKind, Paragraph, RichDocument, Run, RunStyle};
use markie_office::rich_document::{OfficeDocument, rich_image_bytes};

pub const UNSUPPORTED: &str = "This document contains content or page geometry outside the supported print view.";

fn bounded(v: f64, min: f64, max: f64) -> bool {
    v.is_finite() && v >= min && v <= max
}

fn valid_style(s: &RunStyle) -> bool {
    s.font_family.as_ref().is_none_or(|f| f.chars().count() <= 200 && !f.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}'))
        && s.font_size_points.is_none_or(|v| bounded(v, 1.0, 400.0))
        && s.color.as_ref().is_none_or(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_hexdigit()))
        && s.underline.as_ref().is_none_or(|u| {
            [
                "none", "single", "double", "words", "dotted", "dash", "dotDash", "dotDotDash", "wave", "thick", "dottedHeavy", "dashedHeavy", "dashLong",
                "dashLongHeavy", "dashDotHeavy", "dashDotDotHeavy", "wavyHeavy", "wavyDouble",
            ]
            .contains(&u.as_str())
        })
}

fn style(run: &Run) -> &RunStyle {
    run.resolved_style.as_ref().unwrap_or(&run.style)
}

fn valid_paragraph(p: &Paragraph) -> bool {
    if !p.revision_ids.is_empty()
        || !p.spacing_before_points.is_none_or(|v| bounded(v, 0.0, 1000.0))
        || !p.spacing_after_points.is_none_or(|v| bounded(v, 0.0, 1000.0))
        || !p.line_spacing_multiple.is_none_or(|v| bounded(v, 0.5, 10.0))
        || p.alignment.as_ref().is_some_and(|a| !["left", "right", "center", "both"].contains(&a.as_str()))
        || (p.list_kind == Some(ListKind::Numbered) && !p.list_number.is_some_and(|n| (1..=1_000_000).contains(&n)))
    {
        return false;
    }
    p.runs.iter().map(|r| r.text.as_str()).collect::<String>() == p.text
        && p.runs.iter().all(|r| {
            if !valid_style(style(r)) {
                return false;
            }
            let mut prev = 0;
            for b in &r.page_breaks {
                if b.offset < prev || b.offset > r.text.len() {
                    return false;
                }
                prev = b.offset;
            }
            r.target.as_ref().is_none_or(|t| markie_office::docx::safe_docx_hyperlink_target(t).is_ok())
        })
}

/// `canPrintDocx`: the cheap capability gate.
pub fn can_print(doc: &RichDocument) -> bool {
    use markie_office::model::{Block, Format, Severity};
    if !doc.can_edit || !doc.revisions.is_empty() || doc.diagnostics.iter().any(|d| d.severity == Severity::Warning) {
        return false;
    }
    if doc.format != Format::Docx && (!doc.images.is_empty() || !doc.tables.is_empty() || !doc.hyperlinks.is_empty() || !doc.page_breaks.is_empty()) {
        return false;
    }
    let l = doc.page_layout;
    if ![l.width_points, l.height_points].iter().all(|v| bounded(*v, 72.0, 2000.0))
        || ![l.margin_top_points, l.margin_right_points, l.margin_bottom_points, l.margin_left_points].iter().all(|v| bounded(*v, 0.0, 1000.0))
        || l.width_points - l.margin_left_points - l.margin_right_points < 36.0
        || l.height_points - l.margin_top_points - l.margin_bottom_points < 36.0
    {
        return false;
    }
    if doc.paragraphs.len() > 20_000 || doc.images.len() > 100 || doc.text.len() > 4 * 1024 * 1024 || !doc.paragraphs.iter().all(valid_paragraph) {
        return false;
    }
    let mut used = std::collections::HashSet::new();
    let mut used_tables = std::collections::HashSet::new();
    for block in &doc.blocks {
        match block {
            Block::Paragraph(id) => {
                if doc.paragraph(id).is_none() || !used.insert(id.clone()) {
                    return false;
                }
            }
            Block::Table(id) => {
                let Some(t) = doc.tables.iter().find(|t| &t.id == id) else { return false };
                if !used_tables.insert(id.clone()) || t.rows.is_empty() || t.rows[0].cells.is_empty() {
                    return false;
                }
                let width = t.rows[0].cells.len();
                for row in &t.rows {
                    if row.cells.len() != width {
                        return false;
                    }
                    for cell in &row.cells {
                        if cell.paragraph_ids.is_empty() {
                            return false;
                        }
                        for pid in &cell.paragraph_ids {
                            let Some(p) = doc.paragraph(pid) else { return false };
                            if !used.insert(pid.clone()) || p.runs.iter().any(|r| !r.page_breaks.is_empty()) {
                                return false;
                            }
                        }
                    }
                }
            }
        }
    }
    if used.len() != doc.paragraphs.len() || used_tables.len() != doc.tables.len() {
        return false;
    }
    let mut image_paragraphs = std::collections::HashSet::new();
    let (cw, ch) = (l.width_points - l.margin_left_points - l.margin_right_points, l.height_points - l.margin_top_points - l.margin_bottom_points);
    for image in &doc.images {
        let Some(p) = doc.paragraph(&image.paragraph_id) else { return false };
        if !p.text.is_empty()
            || p.runs.iter().any(|r| !r.page_breaks.is_empty())
            || p.list_kind.is_some()
            || !image_paragraphs.insert(p.id.clone())
            || !matches!(image.content_type, ImageType::Png | ImageType::Jpeg)
            || !bounded(image.width_points, 1.0, cw)
            || !bounded(image.height_points, 1.0, ch)
        {
            return false;
        }
    }
    true
}

fn lit(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn run_code(run: &Run, text: &str) -> String {
    let s = style(run);
    let mut args = vec![format!("weight: {}", if s.bold == Some(true) { 700 } else { 400 }), format!("style: {}", if s.italic == Some(true) { "\"italic\"" } else { "\"normal\"" })];
    if let Some(f) = &s.font_family {
        args.push(format!("font: ({}, \"Georgia\", \"Times New Roman\")", lit(f)));
    }
    if let Some(size) = s.font_size_points {
        args.push(format!("size: {size}pt"));
    }
    if let Some(c) = &s.color {
        args.push(format!("fill: rgb(\"#{c}\")"));
    }
    let mut body = format!("text({}, {})", args.join(", "), lit(text));
    let underline = s.underline.as_deref().is_some_and(|u| u != "none") || (run.hyperlink_id.is_some() && s.underline.as_deref() != Some("none"));
    if underline {
        body = format!("underline({body})");
    }
    if let Some(t) = &run.target
        && let Ok(t) = markie_office::docx::safe_docx_hyperlink_target(t)
    {
        body = format!("link({}, {body})", lit(&t));
    }
    body
}

fn paragraph_code(p: &Paragraph, image: Option<&str>) -> String {
    let mut fragments: Vec<Vec<String>> = vec![vec![]];
    for run in &p.runs {
        let mut offset = 0;
        for b in &run.page_breaks {
            if b.offset > offset {
                fragments.last_mut().unwrap().push(run_code(run, &run.text[offset..b.offset]));
            }
            fragments.push(vec![]);
            offset = b.offset;
        }
        if run.text.len() > offset {
            fragments.last_mut().unwrap().push(run_code(run, &run.text[offset..]));
        }
    }
    if let Some(img) = image {
        fragments[0].push(img.to_string());
    }
    let align = match p.alignment.as_deref() {
        Some("center") => "center",
        Some("right") => "right",
        _ => "left",
    };
    let justify = p.alignment.as_deref() == Some("both");
    let line = p.line_spacing_multiple.unwrap_or(1.4);
    let count = fragments.len();
    let mut out = Vec::new();
    let mut marker_done = false;
    for (i, content) in fragments.into_iter().enumerate() {
        if i > 0 {
            out.push("pagebreak()".to_string());
        }
        if content.is_empty() && count > 1 {
            continue;
        }
        let before = if i > 0 { 0.0 } else { p.spacing_before_points.unwrap_or(0.0) };
        let after = if i == count - 1 { p.spacing_after_points.unwrap_or(8.0) } else { 0.0 };
        let body = if content.is_empty() { "[]".to_string() } else { format!("{{ {} }}", content.join("; ")) };
        // CSS line-height on 12pt Georgia: the line box is the multiple of the size.
        let par = format!("block(above: {before}pt, below: {after}pt, width: 100%, height: auto, {{ set par(leading: {line}em - 1.13em, justify: {justify}); set align({align}); box(height: {line}em, width: 0pt); {body} }})");
        let par = match p.list_kind {
            Some(kind) if !marker_done => {
                marker_done = true;
                let marker = match kind {
                    ListKind::Numbered => lit(&format!("{}.", p.list_number.unwrap_or(1))),
                    ListKind::Bullet => lit("•"),
                };
                format!("grid(columns: (18pt, 1fr), align(right, {marker} + h(6pt)), {par})")
            }
            Some(_) => format!("pad(left: 18pt, {par})"),
            None => par,
        };
        out.push(par);
    }
    out.join("\n")
}

/// The Typst source and pictures for a printable document.
pub fn office_source(doc: &OfficeDocument) -> Result<(String, Vec<(String, Vec<u8>)>), String> {
    use markie_office::model::Block;
    if !can_print(doc) {
        return Err(UNSUPPORTED.into());
    }
    let mut files = Vec::new();
    let mut images = std::collections::HashMap::new();
    for image in &doc.images {
        let bytes = rich_image_bytes(doc, &image.id).map_err(|_| UNSUPPORTED.to_string())?;
        let path = format!("/images/{}.img", files.len());
        files.push((path.clone(), bytes));
        images.insert(image.paragraph_id.clone(), format!("image({}, width: {}pt, height: {}pt, fit: \"contain\")", lit(&path), image.width_points, image.height_points));
    }
    let render = |p: &Paragraph| paragraph_code(p, images.get(&p.id).map(String::as_str));
    let mut body = Vec::new();
    for block in &doc.blocks {
        match block {
            Block::Paragraph(id) => body.push(render(doc.paragraph(id).unwrap())),
            Block::Table(id) => {
                let t = doc.tables.iter().find(|t| &t.id == id).unwrap();
                let cols = t.rows[0].cells.len();
                let cells: Vec<String> = t
                    .rows
                    .iter()
                    .flat_map(|row| row.cells.iter())
                    .map(|c| format!("{{ {} }}", c.paragraph_ids.iter().map(|pid| render(doc.paragraph(pid).unwrap())).collect::<Vec<_>>().join("\n")))
                    .collect();
                body.push(format!("block(below: 8pt, table(columns: (1fr,) * {cols}, stroke: 0.5pt + rgb(\"#888888\"), inset: 6pt, align: top, {}))", cells.join(", ")));
            }
        }
    }
    let l = doc.page_layout;
    let source = format!(
        "#set page(width: {}pt, height: {}pt, margin: (top: {}pt, right: {}pt, bottom: {}pt, left: {}pt), fill: white)\n#set text(font: (\"Georgia\", \"Times New Roman\", \"New Computer Modern\"), size: 12pt, fill: black, top-edge: \"ascender\", bottom-edge: \"descender\", hyphenate: false)\n#set par(spacing: 0pt)\n#show link: it => it\n#{{\n{}\n}}\n",
        l.width_points,
        l.height_points,
        l.margin_top_points,
        l.margin_right_points,
        l.margin_bottom_points,
        l.margin_left_points,
        body.join("\n")
    );
    Ok((source, files))
}

/// A Word, RTF or ODT document to PDF bytes.
pub fn office_pdf(doc: &OfficeDocument) -> Result<Vec<u8>, String> {
    let (source, files) = office_source(doc)?;
    crate::pdf::compile(source, files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use markie_office::model::Format;
    use markie_office::rich_document::create_rich_document;

    #[test]
    fn plain_documents_print() {
        for format in [Format::Docx, Format::Rtf, Format::Odt] {
            let doc = create_rich_document(format, "Title\nA paragraph of text.\n\nLast line.").unwrap();
            assert!(can_print(&doc), "{format:?}");
            let pdf = office_pdf(&doc).unwrap();
            assert!(pdf.starts_with(b"%PDF-"));
        }
    }

    #[test]
    fn converted_markdown_prints_with_lists_tables_and_links() {
        let md = "# Head\n\n- one\n- two\n\n1. a\n2. b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n[link](https://markiedocs.com)\n";
        let bytes = crate::convert::convert_for_export(md, crate::convert::SourceKind::Markdown, crate::convert::ExportFormat::Docx).unwrap();
        let doc = markie_office::rich_document::open_rich_document(Format::Docx, &bytes).unwrap();
        assert!(can_print(&doc));
        assert!(office_pdf(&doc).unwrap().starts_with(b"%PDF-"));
    }
}
