//! Word print pagination against Electron's. The fixtures are built by
//! Electron Markie's own TypeScript (`scripts/word-print-fixtures.mjs`), and
//! the goldens are the line baselines of Electron's printToPDF of
//! `buildDocxPrintHTML` for each (`scripts/pdf-lines.py --golden`). Every line
//! has to land on the same page as Electron's, within 2pt, so page breaks fall
//! on the same paragraphs and table rows. PDFs land in
//! .autoloop/runs/native-print/word for side-by-side checks.

use std::path::PathBuf;

use markie_office::model::Format;
use markie_office::rich_document::open_rich_document;

fn dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name)
}

#[derive(serde::Deserialize)]
struct Golden {
    page: usize,
    y: f64,
    key: String,
}

fn key(text: &str) -> String {
    text.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

const FIXTURES: &[&str] = &["print", "break-leading", "break-trailing", "break-consecutive", "break-middle", "pagination", "min-height"];

#[test]
fn word_pagination_matches_electron() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.autoloop/runs/native-print/word");
    std::fs::create_dir_all(&out).unwrap();
    let mut failures = Vec::new();
    for name in FIXTURES {
        let bytes = std::fs::read(dir("fixtures/word").join(format!("{name}.docx"))).unwrap();
        let doc = open_rich_document(Format::Docx, &bytes).unwrap();
        assert!(markie_export::office_pdf::can_print(&doc), "{name}");
        let (source, files) = markie_export::office_pdf::office_source(&doc).unwrap();
        std::fs::write(out.join(format!("{name}.rs.pdf")), markie_export::pdf::compile(source.clone(), files.clone()).unwrap()).unwrap();
        let laid = markie_export::pdf::layout(source, files).unwrap();
        if let Err(e) = compare(name, &laid) {
            failures.push(e);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The first way a fixture's layout differs from Electron's, if any.
fn compare(name: &str, laid: &typst_layout::PagedDocument) -> Result<(), String> {
    let golden: Vec<Golden> = serde_json::from_str(&std::fs::read_to_string(dir("goldens/word").join(format!("{name}.chromium-lines.json"))).unwrap()).unwrap();
    let golden: Vec<Golden> = golden.into_iter().filter(|g| g.key.len() >= 2).collect();
    let pages = golden_pages(name);
    if laid.pages().len() != pages {
        return Err(format!("{name}: {} pages, Electron prints {pages}", laid.pages().len()));
    }
    let ours: Vec<(usize, f64, String)> = markie_export::pdf::text_lines(laid).into_iter().map(|l| (l.page, l.y, key(&l.text))).filter(|l| l.2.len() >= 2).collect();
    let mut worst = 0f64;
    for (g, o) in golden.iter().zip(&ours) {
        if g.key != o.2 {
            return Err(format!("{name}: lines wrap differently: {:?} here, {:?} in Electron", o.2, g.key));
        }
        if g.page != o.0 {
            return Err(format!("{name}: {:?} is on page {} in Electron, {} here", g.key, g.page, o.0));
        }
        let dy = o.1 - g.y;
        if dy.abs() > 2.0 {
            return Err(format!("{name}: {:?} is {dy:.2}pt from Electron's baseline", g.key));
        }
        worst = worst.max(dy.abs());
    }
    if ours.len() != golden.len() {
        return Err(format!("{name}: {} lines, Electron prints {}", ours.len(), golden.len()));
    }
    eprintln!("{name}: {pages} pages, {} lines, worst {worst:.2}pt", golden.len());
    Ok(())
}

/// Electron's page count for each fixture, blank pages included.
fn golden_pages(name: &str) -> usize {
    let text = std::fs::read_to_string(dir("goldens/word").join("pages.json")).unwrap();
    let pages: std::collections::HashMap<String, usize> = serde_json::from_str(&text).unwrap();
    pages[name]
}

#[test]
#[ignore]
fn dump_word_source() {
    let name = std::env::var("WORD_FIXTURE").unwrap_or_else(|_| "pagination".into());
    let bytes = std::fs::read(dir("fixtures/word").join(format!("{name}.docx"))).unwrap();
    let doc = open_rich_document(Format::Docx, &bytes).unwrap();
    let (source, _) = markie_export::office_pdf::office_source(&doc).unwrap();
    println!("{source}");
}
