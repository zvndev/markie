//! The TipTap round-trip suite (`src/lib/rich-roundtrip.test.tsx`) ported
//! to the Rust model, plus edit tests the TipTap pipeline cannot state as
//! directly.

mod fixtures;

use fixtures::*;
use markie_rich::model::{Inline, Marks, Node};
use markie_rich::parse::parse_nodes;
use markie_rich::serialize::{format_markdown_tables, nodes_to_markdown};
use markie_rich::Document;

/// A trailing-newline difference is not damage (as `norm` in the TS suite).
fn norm(s: &str) -> String {
    format!("{}\n", s.trim_end_matches('\n'))
}

/// The raw probe: parse to the model and serialize every block. The TS
/// `probeRoundTrip`, with the same table re-alignment accepted.
fn raw_round_trip(md: &str) -> (bool, String) {
    let doc = Document::parse(md);
    let body = &md[doc.front_matter.len()..];
    let out = nodes_to_markdown(&parse_nodes(body));
    let clean = norm(&format_markdown_tables(&out)) == norm(&format_markdown_tables(body));
    (clean, out)
}

#[test]
fn raw_round_trip_safe_fixtures() {
    let mut failed = Vec::new();
    for (name, md) in SAFE {
        let (clean, out) = raw_round_trip(md);
        if !clean {
            failed.push(format!("{name}: {out:?}"));
        }
    }
    println!("SAFE raw round trip: {}/{} pass", SAFE.len() - failed.len(), SAFE.len());
    assert!(failed.is_empty(), "raw round trip changed: {failed:#?}");
}

#[test]
fn raw_round_trip_lossy_fixtures_are_reported() {
    // TipTap's raw serializer changes all six. The Rust raw serializer is
    // informational here: what matters is that the document path below
    // keeps every one of them byte for byte.
    let mut kept = 0;
    for (name, md) in LOSSY {
        let (clean, out) = raw_round_trip(md);
        println!("LOSSY {name}: raw {}", if clean { "kept".to_string() } else { format!("changed to {out:?}") });
        if clean {
            kept += 1;
        }
        assert_eq!(Document::parse(md).to_markdown(), *md, "zero-edit must be exact: {name}");
    }
    println!("LOSSY raw round trip: {kept}/{} kept, {}/{} zero-edit exact", LOSSY.len(), LOSSY.len(), LOSSY.len());
}

fn zero_edit_suite(label: &str, cases: &[(&str, &str)]) {
    let mut failed = Vec::new();
    for (name, md) in cases {
        let out = Document::parse(md).to_markdown();
        if out != *md {
            failed.push(format!("{name}: {out:?}"));
        }
    }
    println!("{label} zero-edit: {}/{} byte-identical", cases.len() - failed.len(), cases.len());
    assert!(failed.is_empty(), "{failed:#?}");
}

#[test]
fn zero_edit_preserved() {
    zero_edit_suite("PRESERVED", PRESERVED);
}

#[test]
fn zero_edit_corpus_shaped() {
    zero_edit_suite("CORPUS_SHAPED", CORPUS_SHAPED);
}

#[test]
fn zero_edit_clean() {
    zero_edit_suite("CLEAN", CLEAN);
}

#[test]
fn zero_edit_gated_documents_are_editable_here() {
    // TipTap must open this read-only. The block model keeps it exact.
    zero_edit_suite("GATED", GATED);
}

#[test]
fn empty_documents() {
    for md in ["", "   \n", "\n\n"] {
        assert_eq!(Document::parse(md).to_markdown(), md);
    }
}

fn first_paragraph_index(doc: &Document) -> usize {
    doc.blocks.iter().position(|b| matches!(b.nodes().first(), Some(Node::Paragraph(_)))).unwrap()
}

#[test]
fn editing_one_paragraph_of_a_400_line_document_leaves_every_other_line_identical() {
    // The TS suite's release criterion, stated on the model.
    const PARAGRAPHS: usize = 120;
    const EDITED: usize = 42;
    let md = (0..PARAGRAPHS)
        .map(|i| format!("Paragraph {i} opens here and\nis wrapped by hand across\nthree separate source lines."))
        .collect::<Vec<_>>()
        .join("\n\n")
        + "\n";
    assert!(md.split('\n').count() > 400);
    let mut doc = Document::parse(&md);
    assert_eq!(doc.blocks.len(), PARAGRAPHS);
    doc.set_nodes(EDITED, vec![Node::Paragraph(vec![Inline::text("Paragraph 42 was rewritten by hand.")])]);
    let out = doc.to_markdown();
    let before: Vec<&str> = md.split('\n').collect();
    let after: Vec<&str> = out.split('\n').collect();
    let first = EDITED * 4;
    assert_eq!(after[..first], before[..first]);
    assert_eq!(after[first], "Paragraph 42 was rewritten by hand.");
    assert_eq!(after[first + 1..], before[first + 3..]);
}

#[test]
fn bolding_a_word_rewrites_only_that_block() {
    let md = CORPUS_SHAPED.iter().find(|(n, _)| *n == "mixed document").unwrap().1;
    let mut doc = Document::parse(md);
    let i = first_paragraph_index(&doc);
    let nodes = doc.nodes_mut(i).unwrap();
    let Node::Paragraph(inl) = &mut nodes[0] else { panic!() };
    // "Prose wrapped by hand across lines." -> "**Prose** wrapped by hand across lines."
    let Inline::Text { text, .. } = &inl[0] else { panic!() };
    let rest = text["Prose".len()..].to_string();
    *inl = vec![
        Inline::marked("Prose", Marks { bold: true, ..Default::default() }),
        Inline::text(rest),
    ];
    let out = doc.to_markdown();
    let expected = md.replace("Prose wrapped\nby hand across lines.", "**Prose** wrapped by hand across lines.");
    assert_eq!(out, expected);
}

#[test]
fn inserting_and_deleting_blocks_keeps_separators_valid() {
    let md = "# A\n\nfirst\n\nsecond\n";
    let mut doc = Document::parse(md);
    doc.insert_block(2, vec![Node::Paragraph(vec![Inline::text("new")])]);
    assert_eq!(doc.to_markdown(), "# A\n\nfirst\n\nnew\n\nsecond\n");
    doc.remove_block(3);
    assert_eq!(doc.to_markdown(), "# A\n\nfirst\n\nnew\n");
    let mut doc = Document::parse("one\n\ntwo");
    doc.insert_block(2, vec![Node::Heading { level: 2, content: vec![Inline::text("end")] }]);
    assert_eq!(doc.to_markdown(), "one\n\ntwo\n\n## end");
}

#[test]
fn crlf_and_odd_blank_runs_survive() {
    for md in ["a\r\n\r\nb\r\n", "a\n\n\n\nb\n", "\n\n# lead\n", "x  \n\n\n"] {
        assert_eq!(Document::parse(md).to_markdown(), md);
    }
}

#[test]
fn reference_links_keep_their_style_when_edited() {
    let md = GATED[0].1;
    let mut doc = Document::parse(md);
    let nodes = doc.nodes_mut(0).unwrap().clone();
    doc.set_nodes(0, nodes);
    assert_eq!(doc.to_markdown(), md);
}

#[test]
fn every_fixture_block_serializes_stably() {
    // An edited block must read back as the nodes it was written from.
    let mut total = 0;
    let mut unstable = Vec::new();
    for (name, md) in SAFE.iter().chain(LOSSY).chain(PRESERVED).chain(CORPUS_SHAPED).chain(CLEAN).chain(GATED) {
        let doc = Document::parse(md);
        let defs = doc.definitions();
        for b in &doc.blocks {
            if b.is_opaque() {
                continue;
            }
            total += 1;
            if !markie_rich::serialize::is_stable(b.nodes(), &defs) {
                unstable.push(format!("{name}: {:?}", b.source));
            }
        }
    }
    println!("stable edited-block serialization: {}/{total}", total - unstable.len());
    assert!(unstable.is_empty(), "{unstable:#?}");
}
