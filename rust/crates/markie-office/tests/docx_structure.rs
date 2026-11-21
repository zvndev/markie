//! Port of docx-derived.test.ts, docx-structure.test.ts and docx-styles.test.ts.
#[path = "common/docx_fixture.rs"]
mod docx_fixture;
use docx_fixture::*;

fn create(text: &str) -> DocxDocument { create_docx(text).unwrap() }
fn s(v: &str) -> String { v.into() }
fn replace_first_paragraph(x: &str, with: &str) -> String {
    let a = x.find("<w:p>").unwrap(); let b = a + x[a..].find("</w:p>").unwrap() + 6;
    format!("{}{with}{}", &x[..a], &x[b..])
}

// ---- docx-derived.test.ts ----
const DEFAULT_DERIVED: &str = r#"<w:proofErr w:type="spellStart"/><w:r><w:t>Hello</w:t><w:lastRenderedPageBreak/></w:r><w:proofErr w:type="spellEnd"/>"#;
fn derived(contents: &str) -> Vec<u8> {
    let mut entries = read_zip(&export(&create("Hello\nWorld")), DEFAULT_ZIP_LIMITS).unwrap();
    change_xml(&mut entries, "word/document.xml", |x| replace_first_paragraph(x, &format!("<w:p>{contents}</w:p>")));
    change_xml(&mut entries, "[Content_Types].xml", |x| x.replace("</Types>", r#"<Default Extension="bin" ContentType="application/octet-stream"/></Types>"#));
    entries.push(ZipEntry::new("custom/preserved.bin", vec![0u8, 255, 18]));
    write_zip(&entries, DEFAULT_ZIP_LIMITS).unwrap()
}
#[test]
fn opens_proofing_and_cache_markers_without_warnings_and_keeps_bytes() {
    let bytes = derived(DEFAULT_DERIVED); let d = open(&bytes);
    assert!(d.can_edit); assert!(d.diagnostics.iter().all(|x| x.severity != Severity::Warning));
    assert_eq!(d.text, "Hello\nWorld"); assert!(d.page_breaks.is_empty());
    assert_eq!(export(&d), bytes);
    assert_eq!(export(&replace(&d, &d.paragraphs[0].runs[0].id, "Hello")), bytes);
    assert_eq!(export(&apply(&d, &[])), bytes);
    assert_eq!(export(&apply(&d, &[Operation::AcceptAllRevisions])), bytes);
}
#[test]
fn invalidates_derived_analysis_on_real_text_changes() {
    let bytes = derived(DEFAULT_DERIVED); let d = open(&bytes);
    let output = export(&replace(&d, &d.paragraphs[0].runs[0].id, "Corrected"));
    let xml = document_xml(&output);
    assert!(!xml.contains("proofErr") && !xml.contains("lastRenderedPageBreak"));
    let r = open(&output); assert!(r.can_edit); assert_eq!(r.text, "Corrected\nWorld");
    let (a, b) = (read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap(), read_zip(&output, DEFAULT_ZIP_LIMITS).unwrap());
    for p in a.iter().filter(|p| p.name != "word/document.xml") { assert_eq!(b.iter().find(|x| x.name == p.name).unwrap().data, p.data); }
    assert_eq!(export(&d), bytes);
}
#[test]
fn preserves_proofing_on_formatting_and_clears_calculated_pagination() {
    let d = open(&derived(r#"<w:proofErr w:type="gramStart"/><w:r><w:t>Hello</w:t><w:lastRenderedPageBreak/><w:br w:type="page"/></w:r><w:proofErr w:type="gramEnd"/>"#));
    assert!(d.can_edit);
    let changed = apply(&d, &[Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style: fmt(|f| f.bold = Some(Some(true))) }]);
    let xml = document_xml(&export(&changed));
    assert!(xml.contains(r#"w:type="gramStart""#) && xml.contains(r#"w:type="gramEnd""#));
    assert!(!xml.contains("lastRenderedPageBreak")); assert!(xml.contains(r#"<w:br w:type="page"/>"#));
    assert_eq!(reopen(&changed).page_breaks.len(), 1);
}
#[test]
fn edits_and_range_formats_cache_split_runs() {
    let bytes = derived(&format!(r#"<w:r><w:rPr><w:i/></w:rPr><q:t xmlns:q="{W}">Hello</q:t><w:lastRenderedPageBreak/><w:t xml:space="preserve"> world</w:t></w:r>"#));
    let d = open(&bytes);
    assert!(d.can_edit); assert_eq!(d.paragraphs[0].runs[0].text, "Hello world");
    assert_eq!(export(&d), bytes);
    assert_eq!(reopen(&replace(&d, &d.paragraphs[0].runs[0].id, "New whole run")).text, "New whole run\nWorld");
    let formatted = apply(&d, &[Operation::FormatRange { paragraph_id: d.paragraphs[0].id.clone(), start: 6, end: 11, style: fmt(|f| f.bold = Some(Some(true))) }]);
    let r = reopen(&formatted);
    assert_eq!(r.text, "Hello world\nWorld");
    let st = &r.paragraphs[0].runs.iter().find(|x| x.text == "world").unwrap().style;
    assert_eq!((st.bold, st.italic), (Some(true), Some(true)));
}
#[test]
fn supports_paragraph_operations_around_cached_annotations() {
    for kind in ["replace", "delete", "insert", "format"] {
        let bytes = derived(DEFAULT_DERIVED); let d = open(&bytes); let pid = d.paragraphs[0].id.clone();
        let op = match kind {
            "replace" => Operation::ReplaceParagraph { paragraph_id: pid, text: "Replacement".into() },
            "insert" => Operation::InsertParagraph { after_paragraph_id: InsertAt::After(pid), text: "Inserted".into() },
            "format" => Operation::FormatParagraph { paragraph_id: pid, format: ParagraphFormat { alignment: Some(Some("center".into())), ..Default::default() } },
            _ => Operation::DeleteParagraph { paragraph_id: pid },
        };
        let output = export(&apply(&d, &[op]));
        assert!(open(&output).can_edit, "{kind}"); assert!(!document_xml(&output).contains("lastRenderedPageBreak"));
        assert_eq!(export(&d), bytes);
    }
}
#[test]
fn keeps_source_and_cache_bytes_intact_when_a_batch_fails() {
    let bytes = derived(DEFAULT_DERIVED); let d = open(&bytes);
    assert!(apply_docx_operations(&d, &[Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style: fmt(|f| f.bold = Some(Some(true))) }, Operation::ReplaceParagraph { paragraph_id: "missing".into(), text: "No".into() }]).is_err());
    assert!(!d.modified); assert_eq!(export(&d), bytes);
}
#[test]
fn keeps_adjacent_non_cache_text_nodes_read_only() {
    let bytes = derived("<w:r><w:t>Hello</w:t><w:t>world</w:t><w:lastRenderedPageBreak/></w:r>");
    let d = open(&bytes);
    assert!(d.can_edit);
    assert_eq!((d.paragraphs[0].runs[0].text.as_str(), d.paragraphs[0].runs[0].can_edit), ("Helloworld", false));
    assert!(replace_docx_text(&d, &edit(&d.paragraphs[0].runs[0].id, "Blocked")).unwrap_err().message.contains("Unknown"));
    assert_eq!(export(&d), bytes);
}
#[test]
fn confines_invalidation_of_an_in_run_edit_to_the_edited_paragraph() {
    let bytes = derived(r#"<w:proofErr w:type="spellStart"/><w:r><w:t>Hello</w:t><w:lastRenderedPageBreak/></w:r><w:proofErr w:type="spellEnd"/></w:p><w:p><w:proofErr w:type="gramStart"/><w:r><w:t>Next</w:t><w:lastRenderedPageBreak/></w:r><w:proofErr w:type="gramEnd"/>"#);
    let d = open(&bytes);
    let before = document_xml(&bytes);
    let after = document_xml(&export(&replace(&d, &d.paragraphs[0].runs[0].id, "Corrected")));
    let second = |x: &str| x[x.find("gramStart").unwrap() - 30..].to_string();
    assert_eq!(second(&after), second(&before));
    let head = &after[..after.find("gramStart").unwrap()];
    assert!(!head.contains("spellStart") && !head.contains("spellEnd") && !head.contains("lastRenderedPageBreak"));
}
#[test]
fn treats_unmatched_proofing_anchors_as_ignorable() {
    for kind in ["spellStart", "spellEnd", "gramStart", "gramEnd"] {
        assert!(open(&derived(&format!(r#"<w:proofErr w:type="{kind}"/><w:r><w:t>Hello</w:t></w:r>"#))).can_edit, "{kind}");
    }
}
#[test]
fn continues_protecting_malformed_or_unrelated_markup() {
    for markup in ["<w:proofErr/>", r#"<w:proofErr w:type="other"/>"#, r#"<w:proofErr w:type="spellStart" w:unknown="1"/>"#,
        r#"<w:proofErr w:type="gramStart">hidden</w:proofErr>"#, r#"<w:proofErr w:type="gramStart"><w:r/></w:proofErr>"#,
        r#"<w:r><w:t>Hello</w:t><w:lastRenderedPageBreak w:type="page"/></w:r>"#, "<w:r><w:t>Hello</w:t><w:lastRenderedPageBreak>hidden</w:lastRenderedPageBreak></w:r>",
        "<w:r><w:t>Hello</w:t><w:lastRenderedPageBreak><w:t>hidden</w:t></w:lastRenderedPageBreak></w:r>", r#"<w:bookmarkStart w:id="1" w:name="x"/><w:r><w:t>Hello</w:t></w:r>"#] {
        let bytes = derived(markup); let d = open(&bytes);
        assert!(!d.can_edit, "{markup}"); assert_eq!(export(&d), bytes);
        let id = d.paragraphs[0].runs.first().map_or("missing".to_string(), |r| r.id.clone());
        assert!(replace_docx_text(&d, &edit(&id, "Blocked")).unwrap_err().message.contains("safely"));
    }
}

// ---- docx-structure.test.ts ----
fn range(d: &DocxDocument, a: usize, x: usize, b: usize, y: usize) -> TextRange {
    TextRange { anchor: TextPosition { paragraph_id: d.paragraphs[a].id.clone(), offset: x }, focus: TextPosition { paragraph_id: d.paragraphs[b].id.clone(), offset: y } }
}
fn at(d: &DocxDocument, a: usize, x: usize) -> TextRange { range(d, a, x, a, x) }
fn rr(d: &DocxDocument, r: TextRange, text: &str) -> RangeEdit { replace_docx_range(d, &r, text).unwrap_or_else(|e| panic!("{}", e.message)) }
fn rr_err(d: &DocxDocument, r: TextRange, text: &str) -> String { replace_docx_range(d, &r, text).err().expect("expected rejection").message }
fn sfix(body_xml: &str) -> DocxDocument {
    let bytes = swap_part(&export(&create("seed")), "word/document.xml", |x| replace_first_paragraph(x, body_xml));
    open(&bytes)
}
const MIXED: &str = r#"<w:p xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" w14:paraId="12345678" w14:textId="22345678"><w:pPr><w:jc w:val="center"/></w:pPr><w:r w:rsidR="12345678"><w:rPr><w:b/><w:lang w:val="en-US"/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:rPr><w:i/><w:color w:themeColor="accent1"/></w:rPr><w:t>Italic</w:t></w:r></w:p>"#;
fn src(d: &DocxDocument) -> String { document_xml(&export(d)) }
#[test]
fn protects_paragraph_section_boundaries_from_cloning() {
    let d = sfix(r#"<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr><w:r><w:t>Section</w:t></w:r></w:p>"#);
    assert!(d.can_edit);
    let bytes = export(&d);
    assert!(rr_err(&d, at(&d, 0, 3), "\n").contains("section boundaries"));
    assert!(apply_err(&d, &[Operation::DeleteParagraph { paragraph_id: d.paragraphs[0].id.clone() }]).contains("section"));
    assert!(src(&replace(&d, &d.paragraphs[0].runs[0].id, "Renamed")).contains(r#"<w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr><w:r><w:t xml:space="preserve">Renamed</w:t></w:r>"#));
    // The TypeScript also calls the internal source-range function directly; it is crate-private here.
    assert_eq!(export(&d), bytes);
}
#[test]
fn rejects_multiple_text_nodes_and_coalesces_cache_split_runs() {
    let d = sfix("<w:p><w:r><w:t>First</w:t><w:t>Second</w:t></w:r></w:p>");
    assert!(d.can_edit); assert!(!d.paragraphs[0].runs[0].can_edit);
    let bytes = export(&d);
    assert!(rr_err(&d, at(&d, 0, 2), "\n").contains("multiple text"));
    assert_eq!(export(&d), bytes);
    let cached = sfix("<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>First</w:t><w:lastRenderedPageBreak/><w:t>Second</w:t></w:r></w:p>");
    assert!(cached.can_edit);
    let changed = rr(&cached, at(&cached, 0, 7), "\n").document;
    assert_eq!(changed.text, "FirstSe\ncond");
    let r = reopen(&changed);
    assert_eq!(r.text, changed.text);
    assert!(r.paragraphs.iter().all(|p| p.runs.iter().all(|x| x.style.italic == Some(true))));
}
#[test]
fn protects_xml_comments_and_inter_paragraph_source_gaps() {
    for b in ["<w:p><!--retain this--><w:r><w:t>First</w:t></w:r></w:p>", "<w:p><w:r><w:t>First</w:t></w:r><!--retain this--></w:p>",
        "<w:p><w:r><w:t>Fi<!--retain this-->rst</w:t></w:r></w:p>", "<w:p><w:r><w:t>First</w:t></w:r></w:p><!--retain this--><w:p><w:r><w:t>Last</w:t></w:r></w:p>"] {
        let d = sfix(b); let bytes = export(&d);
        assert!(d.can_edit);
        let last = d.paragraphs.len() - 1;
        assert!(rr_err(&d, range(&d, 0, 1, last, 2), "\n").contains("source gaps"), "{b}");
        assert_eq!(export(&d), bytes);
    }
}
#[test]
fn splits_mixed_runs_retaining_raw_properties_and_exact_caret() {
    let d = sfix(MIXED);
    assert!(d.can_edit, "{:?}", d.diagnostics);
    let result = rr(&d, at(&d, 0, 6), "\n");
    assert_eq!(result.document.paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["BoldIt", "alic"]);
    assert_eq!(result.document.paragraphs[0].id, d.paragraphs[0].id);
    assert_ne!(result.document.paragraphs[1].id, d.paragraphs[0].id);
    let caret = TextPosition { paragraph_id: result.document.paragraphs[1].id.clone(), offset: 0 };
    assert_eq!(result.selection, TextRange { anchor: caret.clone(), focus: caret });
    let xml = src(&result.document);
    assert!(xml.contains(r#"<w:r w:rsidR="12345678"><w:rPr><w:b/><w:lang w:val="en-US"/></w:rPr><w:t>Bold</w:t></w:r>"#));
    assert_eq!(xml.matches(r#"<w:rPr><w:i/><w:color w:themeColor="accent1"/></w:rPr>"#).count(), 2);
    assert_eq!(xml.matches("w14:paraId=").count(), 1); assert_eq!(xml.matches("w14:textId=").count(), 1);
    let r = reopen(&result.document);
    assert!(r.can_edit); assert!(r.paragraphs.iter().all(|p| p.alignment.as_deref() == Some("center")));
    assert_eq!(r.paragraphs[1].runs[0].style.italic, Some(true));
    assert_eq!(d.text, "BoldItalic");
}
#[test]
fn joins_adjacent_boundaries_without_repainting_runs() {
    let d = sfix(MIXED);
    let split = rr(&d, at(&d, 0, 4), "\n").document;
    let joined = rr(&split, range(&split, 0, 4, 1, 0), "");
    assert_eq!(joined.document.text, d.text); assert_eq!(joined.document.paragraphs.len(), 1);
    assert_eq!(joined.document.paragraphs[0].runs.iter().map(|r| r.style.clone()).collect::<Vec<_>>(), d.paragraphs[0].runs.iter().map(|r| r.style.clone()).collect::<Vec<_>>());
    assert_eq!(joined.selection.anchor, TextPosition { paragraph_id: d.paragraphs[0].id.clone(), offset: 4 });
}
#[test]
fn replaces_reverse_multiblock_selections_and_maps_the_caret() {
    let d = create("First\nMiddle\nLast\nUntouched");
    let result = rr(&d, range(&d, 2, 2, 0, 2), "X\nYZ");
    assert_eq!(result.document.text, "FiX\nYZst\nUntouched");
    assert_eq!(result.document.paragraphs[0].id, d.paragraphs[0].id);
    assert_eq!(result.document.paragraphs[2].id, d.paragraphs[3].id);
    assert_eq!(result.selection.anchor, TextPosition { paragraph_id: result.document.paragraphs[1].id.clone(), offset: 2 });
    assert_eq!(result.selection.focus, result.selection.anchor);
    assert_eq!(reopen(&result.document).text, result.document.text);
}
#[test]
fn replaces_within_mixed_runs_keeping_rich_prefix_and_suffix() {
    let d = sfix(MIXED);
    let result = rr(&d, range(&d, 0, 2, 0, 7), "XYZ");
    assert_eq!(result.document.text, "BoXYZlic");
    let v: Vec<(String, Option<bool>, Option<bool>)> = result.document.paragraphs[0].runs.iter().map(|r| (r.text.clone(), r.style.bold, r.style.italic)).collect();
    assert_eq!(v, vec![(s("Bo"), Some(true), None), (s("XYZ"), Some(true), None), (s("lic"), None, Some(true))]);
    assert_eq!(result.selection.anchor.offset, 5);
    let xml = src(&result.document);
    assert!(xml.contains(r#"<w:color w:themeColor="accent1"/>"#)); assert_eq!(xml.matches(r#"<w:lang w:val="en-US"/>"#).count(), 2);
}
#[test]
fn retains_both_paragraph_contexts_in_multiline_cross_paragraph_replacement() {
    let mut d = create("First\nLast");
    let (p0, p1) = (d.paragraphs[0].id.clone(), d.paragraphs[1].id.clone());
    let align = |id: String, a: &str| Operation::FormatParagraph { paragraph_id: id, format: ParagraphFormat { alignment: Some(Some(a.into())), ..Default::default() } };
    d = apply(&d, &[align(p0, "center"), align(p1, "right")]);
    let result = rr(&d, range(&d, 0, 2, 1, 2), "X\nY");
    assert_eq!(result.document.paragraphs.iter().map(|p| (p.text.clone(), p.alignment.clone())).collect::<Vec<_>>(), vec![(s("FiX"), Some(s("center"))), (s("Yst"), Some(s("right")))]);
    assert_eq!(reopen(&result.document).paragraphs.iter().map(|p| p.alignment.clone()).collect::<Vec<_>>(), vec![Some(s("center")), Some(s("right"))]);
}
#[test]
fn splits_empty_paragraphs_and_retains_untouched_bytes() {
    let d = create("\nUnchanged");
    let untouched = r#"<w:p><w:r><w:t xml:space="preserve">Unchanged</w:t></w:r></w:p>"#;
    assert!(src(&d).contains(untouched));
    let result = rr(&d, at(&d, 0, 0), "\n");
    assert_eq!(result.document.paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["", "", "Unchanged"]);
    assert_eq!(result.document.paragraphs[2].id, d.paragraphs[1].id);
    assert!(src(&result.document).contains(untouched));
    assert!(reopen(&result.document).can_edit);
}
#[test]
fn creates_editable_text_owners_for_enter_delete_all_and_blank_paste_lines() {
    let d = create("abc");
    let entered = rr(&d, at(&d, 0, 3), "\n").document;
    assert!(entered.paragraphs[1].runs.iter().any(|r| r.can_edit && r.text.is_empty()));
    let typed = replace(&entered, &entered.paragraphs[1].runs[0].id, "X");
    assert_eq!(reopen(&typed).text, "abc\nX");
    let deleted = rr(&d, range(&d, 0, 0, 0, 3), "").document;
    assert!(deleted.paragraphs[0].runs.iter().any(|r| r.can_edit));
    let pasted = rr(&d, at(&d, 0, 3), "\n\n\n").document;
    for p in &pasted.paragraphs { assert!(p.runs.iter().any(|r| r.can_edit)); }
    let repeated = rr(&entered, at(&entered, 1, 0), "\n").document;
    for p in &repeated.paragraphs { assert!(p.runs.iter().any(|r| r.can_edit)); }
    for p in &reopen(&pasted).paragraphs { assert!(p.runs.iter().any(|r| r.can_edit)); }
    let formatted = sfix(MIXED);
    let trailing = rr(&formatted, at(&formatted, 0, 10), "\n").document;
    assert_eq!(trailing.paragraphs[1].runs[0].style.italic, Some(true));
    assert!(src(&trailing).contains(r#"<w:color w:themeColor="accent1"/>"#));
}
#[test]
fn keeps_authored_empty_formatting_runs_with_right_affinity() {
    let empty = r#"<w:r w:rsidR="11223344"><w:rPr><w:b/></w:rPr><w:t/></w:r>"#;
    let d = sfix(&format!("<w:p>{empty}<w:r><w:t>Text</w:t></w:r></w:p>"));
    let result = rr(&d, at(&d, 0, 0), "\n").document;
    assert!(src(&result).contains(empty));
    assert_eq!(result.paragraphs[1].runs[0].style.bold, Some(true));
    let only = sfix("<w:p><w:r><w:rPr><w:i/></w:rPr></w:r></w:p>");
    let typed = rr(&only, at(&only, 0, 0), "Typed").document;
    assert_eq!(typed.paragraphs[0].runs[0].style.italic, Some(true));
    assert_eq!(reopen(&typed).text, "Typed");
}
#[test]
fn keeps_no_ops_neutral_and_validates_graphemes() {
    // UTF-8 offsets: A 0..1, the family emoji 1..26, "e" 26..27, the combining acute 27..29, Z 29..30.
    let d = create("A👨\u{200d}👩\u{200d}👧\u{200d}👦e\u{301}Z");
    let bytes = export(&d);
    let result = rr(&d, at(&d, 0, 1), "");
    assert_eq!(result.document.revision, d.revision); assert_eq!(export(&result.document), bytes);
    for offset in [2usize, 3, 27, 99] { assert!(replace_docx_range(&d, &at(&d, 0, offset), "x").is_err(), "{offset}"); }
    let changed = rr(&d, range(&d, 0, 1, 0, 26), "🙂\n漢字");
    assert_eq!(changed.document.text, "A🙂\n漢字e\u{301}Z");
    assert_eq!(changed.selection.anchor.offset, "漢字".len());
}
#[test]
fn protects_intermediate_owners_and_table_boundaries() {
    let mut d = create("Before\nMiddle\nAfter");
    d = apply(&d, &[Operation::AddComment { paragraph_id: d.paragraphs[1].id.clone(), text: "Keep".into(), author: "Tester".into() }]);
    let bytes = export(&d);
    assert!(rr_err(&d, range(&d, 0, 1, 2, 1), "x").contains("comments"));
    assert_eq!(export(&d), bytes);
    let table = apply(&create("Before\nAfter"), &[Operation::InsertTable { after_paragraph_id: InsertAt::After("p0".into()), rows: 1, columns: 1, cells: None }]);
    assert!(rr_err(&table, range(&table, 0, 1, 2, 1), "x").contains("table"));
    assert!(rr_err(&table, range(&table, 0, 1, 1, 0), "x").contains("cell"));
}
#[test]
fn guards_inherited_style_changes_hyperlinks_and_page_breaks() {
    let mut d = create("One\nTwo");
    d = apply(&d, &[Operation::FormatParagraph { paragraph_id: d.paragraphs[1].id.clone(), format: ParagraphFormat { alignment: Some(Some("right".into())), ..Default::default() } }]);
    assert!(rr_err(&d, range(&d, 0, 3, 1, 0), "").contains("properties"));
    let linked = apply(&d, &[Operation::SetHyperlink { paragraph_id: d.paragraphs[0].id.clone(), start: 0, end: 3, target: "https://example.com".into() }]);
    assert!(rr_err(&linked, at(&linked, 0, 1), "\n").contains("hyperlinks"));
    let page = apply(&d, &[Operation::InsertPageBreak { paragraph_id: d.paragraphs[0].id.clone(), offset: 1 }]);
    assert!(rr_err(&page, at(&page, 0, 2), "\n").contains("authored breaks"));
}
#[test]
fn preserves_unrelated_parts_and_local_text_node_namespaces() {
    let d = sfix(r#"<w:p><w:r><x:t xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">Namespaced</x:t></w:r></w:p>"#);
    let before = read_zip(&export(&d), DEFAULT_ZIP_LIMITS).unwrap();
    let result = rr(&d, at(&d, 0, 4), "\n").document;
    let after = read_zip(&export(&result), DEFAULT_ZIP_LIMITS).unwrap();
    for p in before.iter().filter(|p| p.name != "word/document.xml") { assert_eq!(after.iter().find(|x| x.name == p.name).unwrap().data, p.data); }
    assert_eq!(result.metadata, d.metadata);
    assert_eq!(reopen(&result).text, "Name\nspaced");
}
#[test]
fn captures_insertion_run_namespace_context_when_the_destination_rebinds_a_prefix() {
    let d = sfix(&format!(r#"<w:p xmlns:q="{W}"><q:r><q:rPr><q:b/></q:rPr><q:t>First</q:t></q:r></w:p><w:p xmlns:q="urn:unrelated"><w:r><w:t>Last</w:t></w:r></w:p>"#));
    let result = rr(&d, range(&d, 0, 2, 1, 2), "X\nY").document;
    let r = reopen(&result);
    assert!(r.can_edit); assert_eq!(r.text, "FiX\nYst"); assert_eq!(r.paragraphs[1].runs[0].style.bold, Some(true));
    assert!(rr_err(&d, range(&d, 0, 5, 1, 0), "").contains("namespace scopes"));
}
#[test]
fn retains_core_metadata_and_its_original_bytes() {
    let core = r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Preserved title</dc:title><dc:creator>Original author</dc:creator></cp:coreProperties>"#;
    let mut parts = read_zip(&export(&create("Source")), DEFAULT_ZIP_LIMITS).unwrap();
    change_xml(&mut parts, "_rels/.rels", |x| x.replace("</Relationships>", r#"<Relationship Id="core" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#));
    parts.push(ZipEntry::new("docProps/core.xml", core));
    let d = open(&write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap());
    let result = rr(&d, at(&d, 0, 3), "\n").document;
    assert_eq!(result.metadata.get("title").map(String::as_str), Some("Preserved title"));
    assert_eq!(result.metadata.get("creator").map(String::as_str), Some("Original author"));
    assert_eq!(part(&export(&result), "docProps/core.xml").unwrap(), core);
    assert_eq!(reopen(&result).metadata, d.metadata);
}
// The TypeScript "does not route structural edits through other formats" case is enforced by
// types here: replace_docx_range only accepts a DocxDocument.

// ---- docx-styles.test.ts ----
fn style_fixture(style_id: &str) -> (Vec<u8>, String, DocxDocument) {
    let seed = apply(&create("Alpha Beta\nSecond paragraph"), &[Operation::FormatParagraph { paragraph_id: "p0".into(), format: ParagraphFormat { style_id: Some(Some("Heading1".into())), ..Default::default() } }]);
    let styles = r#"<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:rFonts w:ascii="Cambria"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="DefaultDoc"><w:name w:val="Document default"/><w:rPr><w:color w:val="333333"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="EditorialBody"><w:name w:val="Editorial body"/><w:basedOn w:val="DefaultDoc"/><w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:ascii="Aptos"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="EditorialLead"><w:name w:val="Editorial lead"/><w:basedOn w:val="EditorialBody"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Unbold"><w:name w:val="Toggle bold off"/><w:basedOn w:val="EditorialBody"/><w:rPr><w:b/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="CharacterAccent"><w:name w:val="Character accent"/><w:rPr><w:color w:val="225588"/><w:u/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="CycleA"><w:basedOn w:val="CycleB"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CycleB"><w:basedOn w:val="CycleA"/><w:rPr><w:b/></w:rPr></w:style>
  </w:styles>"#.to_string();
    let mut parts = read_zip(&export(&seed), DEFAULT_ZIP_LIMITS).unwrap();
    parts.iter_mut().find(|p| p.name == "word/styles.xml").unwrap().data = styles.clone().into_bytes();
    change_xml(&mut parts, "word/document.xml", |x| replace_first_paragraph(x, &format!(r#"<w:p><w:pPr><w:pStyle w:val="{style_id}"/></w:pPr><w:r><w:rPr><w:b w:val="0"/><w:color w:val="cc0000"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">Alpha </w:t></w:r><w:r><w:t>Beta</w:t></w:r></w:p>"#)));
    let bytes = write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap();
    let d = open(&bytes);
    (bytes, styles, d)
}
fn rs(b: Option<bool>, i: Option<bool>, c: Option<&str>, f: Option<&str>, sz: Option<f64>) -> RunStyle {
    RunStyle { bold: b, italic: i, underline: None, color: c.map(str::to_string), font_family: f.map(str::to_string), font_size_points: sz }
}
#[test]
fn resolves_defaults_inheritance_and_direct_overrides() {
    let (bytes, _, d) = style_fixture("EditorialLead");
    assert!(d.styles.contains(&NamedStyle { id: "EditorialLead".into(), name: "Editorial lead".into() }));
    assert!(!d.styles.iter().any(|s| s.id == "CharacterAccent"));
    assert_eq!((d.paragraphs[0].alignment.as_deref(), d.paragraphs[0].spacing_after_points), (Some("center"), Some(12.0)));
    assert_eq!(d.paragraphs[0].runs[0].style, rs(Some(false), None, Some("cc0000"), None, Some(9.0)));
    assert_eq!(d.paragraphs[0].runs[0].resolved_style, Some(rs(Some(false), Some(true), Some("cc0000"), Some("Aptos"), Some(9.0))));
    let r1 = d.paragraphs[0].runs[1].resolved_style.clone().unwrap();
    assert_eq!((r1.bold, r1.italic, r1.font_family.as_deref(), r1.font_size_points, r1.color.as_deref()), (Some(true), Some(true), Some("Aptos"), Some(16.0), Some("333333")));
    let r2 = d.paragraphs[1].runs[0].resolved_style.clone().unwrap();
    assert_eq!((r2.font_family.as_deref(), r2.font_size_points, r2.color.as_deref()), (Some("Cambria"), Some(11.0), Some("333333")));
    assert_eq!(export(&d), bytes);
}
#[test]
fn changes_only_the_paragraph_style_and_preserves_styles_and_parts() {
    let (bytes, styles, d) = style_fixture("EditorialBody");
    let exported = export(&apply(&d, &[Operation::FormatParagraph { paragraph_id: d.paragraphs[0].id.clone(), format: ParagraphFormat { style_id: Some(Some("EditorialLead".into())), ..Default::default() } }]));
    let r = open(&exported);
    assert_eq!(r.paragraphs[0].style_id.as_deref(), Some("EditorialLead"));
    assert_eq!(r.paragraphs[0].runs.iter().map(|x| x.style.clone()).collect::<Vec<_>>(), d.paragraphs[0].runs.iter().map(|x| x.style.clone()).collect::<Vec<_>>());
    let (a, b) = (read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap(), read_zip(&exported, DEFAULT_ZIP_LIMITS).unwrap());
    for p in a.iter().filter(|p| p.name != "word/document.xml") { assert_eq!(b.iter().find(|x| x.name == p.name).unwrap().data, p.data); }
    assert_eq!(part(&exported, "word/styles.xml").unwrap(), styles);
}
#[test]
fn uses_toggle_semantics_with_absolute_direct_false_and_bounded_cycles() {
    let (_, _, d) = style_fixture("Unbold");
    assert_eq!(d.paragraphs[0].runs[1].resolved_style.as_ref().unwrap().bold, Some(false));
    assert_eq!(d.paragraphs[0].runs[0].resolved_style.as_ref().unwrap().bold, Some(false));
    let (_, _, cycle) = style_fixture("CycleA");
    let r = cycle.paragraphs[0].runs[1].resolved_style.clone().unwrap();
    assert_eq!((r.bold, r.italic), (Some(true), Some(true)));
}
#[test]
fn applies_character_style_properties_after_paragraph_styles() {
    let (bytes, _, _) = style_fixture("EditorialBody");
    let d = open(&swap_part(&bytes, "word/document.xml", |x| x.replace("<w:r><w:t>Beta", r#"<w:r><w:rPr><w:rStyle w:val="CharacterAccent"/></w:rPr><w:t>Beta"#)));
    let r = d.paragraphs[0].runs[1].resolved_style.clone().unwrap();
    assert_eq!((r.color.as_deref(), r.underline.as_deref(), r.bold), (Some("225588"), Some("single"), Some(true)));
    assert_eq!(d.paragraphs[0].runs[1].style, RunStyle::default());
}
#[test]
fn does_not_misrepresent_unresolved_theme_references_or_exact_line_heights() {
    let (bytes, _, _) = style_fixture("EditorialLead");
    let d = open(&swap_part(&bytes, "word/styles.xml", |x| x.replace(r#"<w:spacing w:after="240"/>"#, r#"<w:spacing w:after="240" w:line="400" w:lineRule="exact"/>"#).replace("<w:rPr><w:i/></w:rPr>", r#"<w:rPr><w:i/><w:rFonts w:asciiTheme="majorHAnsi"/><w:color w:val="778899" w:themeColor="accent1"/></w:rPr>"#)));
    let r1 = d.paragraphs[0].runs[1].resolved_style.clone().unwrap();
    assert_eq!((r1.font_family, r1.color), (None, None));
    assert_eq!(d.paragraphs[0].line_spacing_multiple, None);
    assert_eq!(d.paragraphs[0].runs[0].resolved_style.as_ref().unwrap().color.as_deref(), Some("cc0000"));
}
