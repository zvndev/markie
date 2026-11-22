//! PDF export through Typst: every fixture in both themes compiles, pictures
//! load from the document's folder, and a missing picture stops the export
//! with Electron's message. Outputs land in .autoloop/runs/web-export/pdf for
//! the side-by-side comparison with Electron's PDFs.

use std::path::PathBuf;

use markie_export::pdf::{IMAGE_ERROR, PdfOptions, export_pdf};
use markie_export::Theme;

fn dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name)
}

fn out_dir() -> PathBuf {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.autoloop/runs/web-export/pdf");
    std::fs::create_dir_all(&out).unwrap();
    out
}

/// A stand-in for the network: the YouTube thumbnail is a local picture.
fn fetch(_url: &str) -> Option<Vec<u8>> {
    std::fs::read(dir("fixtures").join("pic.png")).ok()
}

#[test]
fn fixtures_export_in_both_themes() {
    let fixtures = dir("fixtures");
    for name in ["everything.md", "long.md", "prices.md", "prices-edge.md", "plain.txt"] {
        let text = std::fs::read_to_string(fixtures.join(name)).unwrap();
        for theme in [Theme::Light, Theme::Dark] {
            let opts = PdfOptions { theme, doc_dir: Some(&fixtures), fetch: Some(&fetch), ..Default::default() };
            let pdf = export_pdf(&text, &opts).unwrap_or_else(|e| panic!("{name} {theme:?}: {e}"));
            assert!(pdf.starts_with(b"%PDF-"), "{name}");
            std::fs::write(out_dir().join(format!("{name}.{}.rs.pdf", theme.name())), pdf).unwrap();
        }
    }
}

#[test]
fn a_missing_picture_stops_the_export() {
    let fixtures = dir("fixtures");
    let opts = PdfOptions { doc_dir: Some(&fixtures), ..Default::default() };
    assert_eq!(export_pdf("![x](nope.png)\n", &opts).unwrap_err(), IMAGE_ERROR);
    // Without a network fetcher a remote picture cannot load either.
    assert_eq!(export_pdf("![x](https://example.com/a.png)\n", &opts).unwrap_err(), IMAGE_ERROR);
}

#[test]
fn bad_math_is_red_text_not_a_failure() {
    let pdf = export_pdf("Bad $\\frac{$ math.\n\n$$\n\\begin{matrix}\n$$\n", &PdfOptions::default()).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
}

#[test]
fn system_font_is_loaded() {
    let families = markie_export::pdf_world::families();
    eprintln!("{families:?}");
    assert!(families.iter().any(|f| f.contains("SF") || f.contains("System")), "{families:?}");
}
