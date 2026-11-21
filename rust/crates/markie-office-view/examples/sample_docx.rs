//! Writes a DOCX that uses every feature the page view draws, built through
//! the engine's own edit API, for checks in the running app:
//!
//!   cargo run -p markie-office-view --example sample_docx -- out.docx

use markie_office::model::*;
use markie_office::rich_document::{OfficeDocument, apply_rich_operations, create_rich_document, export_rich_document};

fn png(width: u32, height: u32) -> Vec<u8> {
    let chunk = |name: &[u8], data: &[u8]| {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend(name);
        out.extend(data);
        let crc = markie_office::zip::zip_crc32(&out[4..]);
        out.extend(crc.to_be_bytes());
        out
    };
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8u8, 2, 0, 0, 0]);
    let mut raw = Vec::new();
    for y in 0..height {
        raw.push(0);
        for x in 0..width {
            raw.extend([(x * 255 / width) as u8, (y * 255 / height) as u8, 180]);
        }
    }
    let idat = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
    let mut out = vec![137u8, 80, 78, 71, 13, 10, 26, 10];
    out.extend(chunk(b"IHDR", &ihdr));
    out.extend(chunk(b"IDAT", &idat));
    out.extend(chunk(b"IEND", &[]));
    out
}

fn id(doc: &OfficeDocument, index: usize) -> String {
    doc.paragraphs[index].id.clone()
}

fn main() {
    let out = std::env::args().nth(1).expect("output path");
    let body = [
        "Markie page view sample",
        "This paragraph has bold, italic and underlined words, a colored phrase and a link to Markie.",
        "First bullet",
        "Second bullet",
        "First step",
        "Second step",
        "A centered closing line.",
        "Text after the table, on the second page.",
    ]
    .join("\n");
    let mut doc = create_rich_document(Format::Docx, &body).unwrap();
    let apply = |doc: &OfficeDocument, ops: Vec<Operation>| apply_rich_operations(doc, &ops).unwrap_or_else(|e| panic!("{}", e.message));
    let style = |f: fn(&mut RunFormat)| {
        let mut r = RunFormat::default();
        f(&mut r);
        r
    };
    let p1 = id(&doc, 1);
    let text = doc.paragraphs[1].text.clone();
    let range = |word: &str| {
        let start = text.find(word).unwrap();
        (start, start + word.len())
    };
    let (b0, b1) = range("bold");
    let (i0, i1) = range("italic");
    let (u0, u1) = range("underlined");
    let (c0, c1) = range("a colored phrase");
    let (l0, l1) = range("Markie");
    doc = apply(&doc, vec![Operation::FormatParagraph { paragraph_id: id(&doc, 0), format: ParagraphFormat { style_id: Some(Some("Heading1".into())), ..Default::default() } }]);
    doc = apply(&doc, vec![
        Operation::FormatRange { paragraph_id: p1.clone(), start: b0, end: b1, style: style(|r| r.bold = Some(Some(true))) },
        Operation::FormatRange { paragraph_id: p1.clone(), start: i0, end: i1, style: style(|r| r.italic = Some(Some(true))) },
        Operation::FormatRange { paragraph_id: p1.clone(), start: u0, end: u1, style: style(|r| r.underline = Some(Some("single".into()))) },
        Operation::FormatRange { paragraph_id: p1.clone(), start: c0, end: c1, style: style(|r| r.color = Some(Some("C00000".into()))) },
    ]);
    doc = apply(&doc, vec![Operation::SetHyperlink { paragraph_id: p1.clone(), start: l0, end: l1, target: "https://markiedocs.com/".into() }]);
    doc = apply(&doc, vec![Operation::SetList { paragraph_id: id(&doc, 2), kind: Some(ListKind::Bullet) }, Operation::SetList { paragraph_id: id(&doc, 3), kind: Some(ListKind::Bullet) }]);
    doc = apply(&doc, vec![Operation::SetList { paragraph_id: id(&doc, 4), kind: Some(ListKind::Numbered) }, Operation::SetList { paragraph_id: id(&doc, 5), kind: Some(ListKind::Numbered) }]);
    doc = apply(&doc, vec![Operation::FormatParagraph { paragraph_id: id(&doc, 6), format: ParagraphFormat { alignment: Some(Some("center".into())), ..Default::default() } }]);
    doc = apply(&doc, vec![Operation::AddComment { paragraph_id: p1.clone(), text: "Check the link before sending.".into(), author: "Kirby".into() }]);
    doc = apply(&doc, vec![Operation::InsertImage(ImageInput {
        after_paragraph_id: InsertAt::After(id(&doc, 1)),
        bytes: png(240, 120),
        content_type: ImageType::Png,
        width_points: 180.0,
        height_points: 90.0,
        alt_text: Some("Gradient".into()),
    })]);
    let closing = doc.paragraphs.iter().position(|p| p.text == "A centered closing line.").unwrap();
    doc = apply(&doc, vec![Operation::InsertTable {
        after_paragraph_id: InsertAt::After(id(&doc, closing)),
        rows: 2,
        columns: 3,
        cells: Some(vec![vec!["Name".into(), "Size".into(), "Notes".into()], vec!["A4".into(), "210 × 297 mm".into(), "International".into()]]),
    }]);
    let after = doc.paragraphs.iter().position(|p| p.text.starts_with("Text after the table")).unwrap();
    doc = apply(&doc, vec![Operation::InsertPageBreak { paragraph_id: id(&doc, after), offset: 0 }]);
    std::fs::write(&out, export_rich_document(&doc).unwrap()).unwrap();
    println!("wrote {out}");
}
