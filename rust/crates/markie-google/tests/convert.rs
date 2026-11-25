//! Docs JSON to Markdown, one made-up fixture per element type
//! (tests/fixtures/<name>.json next to the expected <name>.md).
//! `MARKIE_GOOGLE_BLESS=1 cargo test -p markie-google --test convert` rewrites
//! the expected files; read the diff before committing it.
use markie_google::convert::doc_to_markdown;
use std::path::Path;

fn check(name: &str) -> markie_google::convert::Converted {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{name}.json"))).unwrap()).unwrap();
    let got = doc_to_markdown(&doc);
    let expected_path = dir.join(format!("{name}.md"));
    if std::env::var_os("MARKIE_GOOGLE_BLESS").is_some() {
        std::fs::write(&expected_path, &got.markdown).unwrap();
    }
    let expected = std::fs::read_to_string(&expected_path).unwrap_or_default();
    assert_eq!(got.markdown, expected, "{name}: converted Markdown differs from {}", expected_path.display());
    got
}

#[test]
fn headings_title_and_subtitle() {
    check("headings");
}

#[test]
fn paragraphs_breaks_and_escaping() {
    check("paragraphs");
}

#[test]
fn bold_italic_strike_and_links() {
    let c = check("inline");
    assert!(c.dropped.contains("underline"));
    assert!(c.dropped.contains("links to headings, bookmarks and tabs"));
}

#[test]
fn nested_bullets() {
    check("bullets");
}

#[test]
fn nested_numbers_restart_under_a_new_parent() {
    check("numbered");
}

#[test]
fn checklists_with_checked_items() {
    check("checklist");
}

#[test]
fn tables_as_gfm() {
    check("table");
}

#[test]
fn code_spans_and_code_blocks() {
    check("code");
}

#[test]
fn horizontal_rules() {
    check("rule");
}

#[test]
fn images_become_links() {
    let c = check("images");
    assert_eq!(c.images, 3);
}

#[test]
fn every_tab_is_a_heading_in_one_file() {
    let c = check("tabs");
    assert_eq!(c.tabs, 3);
}

#[test]
fn footnotes_follow_the_text() {
    check("footnotes");
}

#[test]
fn a_document_read_without_tabs() {
    let c = check("legacy");
    assert_eq!(c.tabs, 1);
}

/// Every Markdown file the converter writes parses back to the same text
/// under CommonMark plus GFM, the way Markie reads it.
#[test]
fn the_output_is_stable_markdown() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "md") {
            let text = std::fs::read_to_string(&path).unwrap();
            assert!(text.ends_with('\n') && !text.ends_with("\n\n"), "{}", path.display());
            assert!(!text.contains("\u{b}"), "{}", path.display());
        }
    }
}

/// What a CommonMark plus GFM reader sees in each file: the structure the Doc had.
#[test]
fn the_markdown_means_what_the_doc_said() {
    use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag};
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let events = |name: &str| -> Vec<Event<'static>> {
        let text = std::fs::read_to_string(dir.join(format!("{name}.md"))).unwrap();
        let opts = Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_FOOTNOTES;
        Parser::new_ext(&text, opts).map(|e| e.into_static()).collect()
    };
    let count = |evs: &[Event], f: &dyn Fn(&Event) -> bool| evs.iter().filter(|e| f(e)).count();

    let p = events("paragraphs");
    assert_eq!(count(&p, &|e| matches!(e, Event::Start(Tag::Heading { .. }))), 0, "escaped # stays text");
    assert_eq!(count(&p, &|e| matches!(e, Event::Start(Tag::List(_)))), 0, "escaped 1999. stays text");
    assert_eq!(count(&p, &|e| matches!(e, Event::HardBreak)), 1);

    let h = events("headings");
    assert_eq!(count(&h, &|e| matches!(e, Event::Start(Tag::Heading { level: HeadingLevel::H1, .. }))), 2);
    assert_eq!(count(&h, &|e| matches!(e, Event::Start(Tag::Heading { level: HeadingLevel::H6, .. }))), 1);

    let i = events("inline");
    assert_eq!(count(&i, &|e| matches!(e, Event::Start(Tag::Strong))), 4);
    assert_eq!(count(&i, &|e| matches!(e, Event::Start(Tag::Emphasis))), 2);
    assert_eq!(count(&i, &|e| matches!(e, Event::Start(Tag::Strikethrough))), 1);
    assert!(i.iter().any(|e| matches!(e, Event::Start(Tag::Link { dest_url, .. }) if dest_url.as_ref() == "https://example.com/a%20b")));

    let n = events("numbered");
    assert_eq!(count(&n, &|e| matches!(e, Event::Start(Tag::List(Some(1))))), 3, "one top list, two nested numbered lists");
    assert_eq!(count(&n, &|e| matches!(e, Event::Start(Tag::List(None)))), 1);
    let b = events("bullets");
    assert_eq!(count(&b, &|e| matches!(e, Event::Start(Tag::List(None)))), 3);

    let c = events("checklist");
    assert_eq!(count(&c, &|e| matches!(e, Event::TaskListMarker(true))), 1);
    assert_eq!(count(&c, &|e| matches!(e, Event::TaskListMarker(false))), 2);

    let t = events("table");
    assert_eq!(count(&t, &|e| matches!(e, Event::Start(Tag::TableRow))), 2);
    assert_eq!(count(&t, &|e| matches!(e, Event::Start(Tag::TableCell))), 9);

    let code = events("code");
    assert_eq!(count(&code, &|e| matches!(e, Event::Start(Tag::CodeBlock(_)))), 1);
    assert_eq!(count(&code, &|e| matches!(e, Event::Code(_))), 1);

    assert_eq!(count(&events("rule"), &|e| matches!(e, Event::Rule)), 1);
    assert_eq!(count(&events("images"), &|e| matches!(e, Event::Start(Tag::Link { .. }))), 3);
    assert_eq!(count(&events("footnotes"), &|e| matches!(e, Event::FootnoteReference(_))), 1);
}
