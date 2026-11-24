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

/// Chromium's line boxes and margins, measured from Electron's layout of the
/// export HTML (AUDIT-AGENTS-WEB.md row 23.1): the 14px body line is 24.5px
/// with its baseline 17.54px down, margins collapse, and a `<pre>` keeps the
/// 24.5px pitch of its own strut.
#[test]
fn layout_rules_measured_from_chromium() {
    let md = "## Head\n\n- one\n\n> quote\n\n---\n\nH<sub>2</sub>O x<sup>2</sup>\n\n```\ncode\n```\n";
    let (source, _) = markie_export::pdf::typst_source(md, &PdfOptions::default()).unwrap();
    for rule in [
        // Body strut: 17.54px above the baseline, 6.96px below (in pt).
        "top-edge: 13.156pt, bottom-edge: -5.219pt",
        // h2 margins 1.3em and 0.45em of 21px; padding 0.25em plus a 1px rule.
        "block(width: 100%, above: 20.475pt, below: 7.088pt, sticky: true, align(left, mk-heading(15.750pt, 600, 4.688pt, true",
        // ul margin 0.6em, collapsed with the li's 0.25em.
        "block(width: 100%, above: 6.300pt, below: 6.300pt, { block(width: 100%, above: 2.625pt, below: 2.625pt",
        // Blockquote padding 0.5em plus its paragraph's 0.25em margin.
        "mk-quote(7.875pt, 7.875pt,",
        "block(width: 100%, above: 18.900pt, below: 18.900pt, block(width: 100%, height: 0.75pt",
        // sub lowers by 14/5 + 1px, sup raises by 14/3 + 1px.
        "text(size: 7.875pt, baseline: 2.850pt,",
        "text(size: 7.875pt, baseline: -4.250pt,",
        "#let mk-disc = align(right, \"\\u{200b}\" + box(move(dy: -1.56pt, circle(radius: 1.86pt",
        "mk-pre(raw(block: true, \"code\"), top-edge: 12.823pt, bottom-edge: -5.552pt)",
    ] {
        assert!(source.contains(rule), "missing {rule}\n{source}");
    }
}

#[derive(serde::Deserialize)]
struct Golden {
    page: usize,
    y: f64,
    key: String,
}

/// Letters and digits only, math italic folded to plain (NFKC), as
/// `scripts/pdf-lines.py` keys a line.
fn key(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfkc().collect::<String>().to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

/// Line baselines against Electron's own PDFs of the fixtures (printToPDF
/// with Markie's options, read by `scripts/pdf-lines.py --golden`): every
/// line lands on the same page and within 2pt of Chromium's, in both themes.
#[test]
fn line_baselines_match_chromium() {
    let fixtures = dir("fixtures");
    for name in ["everything.md", "long.md", "prices.md", "prices-edge.md", "plain.txt"] {
        let golden: Vec<Golden> = serde_json::from_str(&std::fs::read_to_string(dir("goldens").join(format!("{name}.chromium-lines.json"))).unwrap()).unwrap();
        let golden: Vec<Golden> = golden.into_iter().filter(|g| g.key.len() >= 2).collect();
        let text = std::fs::read_to_string(fixtures.join(name)).unwrap();
        for theme in [Theme::Light, Theme::Dark] {
            let opts = PdfOptions { theme, doc_dir: Some(&fixtures), fetch: Some(&fetch), ..Default::default() };
            let (source, files) = markie_export::pdf::typst_source(&text, &opts).unwrap();
            let doc = markie_export::pdf::layout(source, files).unwrap();
            let ours: Vec<(usize, f64, String)> =
                markie_export::pdf::text_lines(&doc).into_iter().map(|l| (l.page, l.y, key(&l.text))).filter(|l| l.2.len() >= 2).collect();
            // Longest common subsequence of line keys, then the offsets.
            let (n, m) = (golden.len(), ours.len());
            let mut t = vec![vec![0u32; m + 1]; n + 1];
            for i in (0..n).rev() {
                for j in (0..m).rev() {
                    t[i][j] = if golden[i].key == ours[j].2 { t[i + 1][j + 1] + 1 } else { t[i + 1][j].max(t[i][j + 1]) };
                }
            }
            let (mut i, mut j, mut matched, mut worst) = (0, 0, 0, 0f64);
            while i < n && j < m {
                if golden[i].key == ours[j].2 {
                    let g = &golden[i];
                    assert_eq!(g.page, ours[j].0, "{name} {theme:?}: {:?} is on page {} in Electron, {} here", g.key, g.page, ours[j].0);
                    let dy = ours[j].1 - g.y;
                    assert!(dy.abs() <= 2.0, "{name} {theme:?}: {:?} is {dy:.2}pt from Electron's baseline", g.key);
                    worst = worst.max(dy.abs());
                    matched += 1;
                    i += 1;
                    j += 1;
                } else if t[i + 1][j] >= t[i][j + 1] {
                    i += 1;
                } else {
                    j += 1;
                }
            }
            // Only player chrome (the video's "0:00") has no counterpart.
            assert!(matched + 1 >= n, "{name} {theme:?}: matched {matched} of {n} lines");
            eprintln!("{name} {theme:?}: {matched} of {n} lines, worst {worst:.2}pt");
        }
    }
}

/// The bundled library reaches Typst: every family unpacks from woff2 and
/// is found under the name its files carry.
#[test]
fn bundled_fonts_reach_the_pdf_engine() {
    let families = markie_export::pdf_world::families();
    let mut missing = Vec::new();
    for family in markie_core::fonts::bundled_families() {
        match markie_export::pdf_world::typst_family(&family.id) {
            Some(name) if families.iter().any(|f| f.eq_ignore_ascii_case(&name)) => {}
            other => missing.push(format!("{} -> {other:?}", family.id)),
        }
    }
    assert!(missing.is_empty(), "{missing:?}");
    assert_eq!(markie_export::pdf_world::typst_family("inter").as_deref(), Some("Inter"));
}

/// Every preset lays out as a PDF, in its own faces, and Spacious is the
/// source the export always wrote.
#[test]
fn every_markdown_style_exports_to_pdf() {
    use markie_core::markdown_style::{MarkdownStyle, font_tokens};
    use markie_export::ExportLook;
    let md = "# Title\n\nFirst paragraph with a [link](https://example.com) and `code`.\n\nSecond paragraph.\n\n## Section\n\n### Part\n\n- one\n  - two\n    - three\n\n1. a\n   1. b\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n> Quote\n\n---\n\n```sh\nls\n```\n\n#### Minor\n";
    let (plain, _) = markie_export::pdf::typst_source(md, &PdfOptions::default()).unwrap();
    let spacious = PdfOptions { look: ExportLook { style: Some(MarkdownStyle::preset("spacious")), body_font: "system".into(), heading_font: "body".into(), code_font: String::new() }, ..Default::default() };
    assert_eq!(markie_export::pdf::typst_source(md, &spacious).unwrap().0, plain, "Spacious adds nothing");
    for preset in markie_core::markdown_style::presets().iter().skip(1) {
        let style = MarkdownStyle::preset(&preset.id);
        let faces = font_tokens(&style);
        let look = ExportLook { style: Some(style), body_font: faces.body_font.unwrap_or_default(), heading_font: faces.heading_font.unwrap_or_default(), code_font: faces.code_font.unwrap_or_default() };
        for theme in [Theme::Light, Theme::Dark] {
            let opts = PdfOptions { theme, look: look.clone(), ..Default::default() };
            let (source, _) = markie_export::pdf::typst_source(md, &opts).unwrap();
            assert_ne!(source, plain, "{}", preset.id);
            let family = markie_export::pdf_world::typst_family(&look.body_font).unwrap();
            assert!(source.contains(&format!("#let sans = (\"{family}\", ")), "{}: set in {family}", preset.id);
            let pdf = export_pdf(md, &opts).unwrap_or_else(|e| panic!("{} {theme:?}: {e}", preset.id));
            assert!(pdf.starts_with(b"%PDF-"), "{}", preset.id);
        }
    }
    // What each style asks for reaches the page.
    let source = |id: &str| markie_export::pdf::typst_source(md, &PdfOptions { look: ExportLook { style: Some(MarkdownStyle::preset(id)), ..Default::default() }, ..Default::default() }).unwrap().0;
    let technical = source("technical");
    assert!(technical.contains("\"1\u{2002}\"") && technical.contains("\"1.1\u{2002}\""), "sections are numbered");
    assert!(technical.contains("mk-mark(\"1.1.\", fill: c-fg)"), "legal numbering in the text colour");
    assert!(technical.contains("grid: true") && technical.contains("head-style: \"filled\"") && technical.contains("mk-quote-card("));
    let classic = source("classic");
    assert!(classic.contains("first-line-indent") && classic.contains("align(center, mk-heading(") && classic.contains("\u{2022}\u{2003}\u{2022}"));
    let editorial = source("editorial");
    assert!(editorial.contains("rect(width:") && editorial.contains("mk-quote-plain(none, true, true,") && editorial.contains("mk-shape(\"square\", fill: c-link)") && editorial.contains("upper("));
    let minimal = source("minimal");
    assert!(minimal.contains("mk-mark(\"\u{2013}\")") && minimal.contains("mk-mark") && minimal.contains("frame: \"bar\"") && minimal.contains("dotted: true"));
}
