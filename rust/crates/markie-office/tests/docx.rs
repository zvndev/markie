//! Port of src/lib/office/docx.test.ts.
#[path = "common/docx_fixture.rs"]
mod docx_fixture;
use docx_fixture::*;

#[test]
fn creates_minimal_packages_and_exposes_text_snapshots() {
    let d = create_docx("Hello 😀\r\nSecond line\n").unwrap();
    assert_eq!(d.format, Format::Docx);
    assert_eq!(d.text, "Hello 😀\nSecond line\n");
    assert!(d.can_edit); assert_eq!(d.paragraphs.len(), 3); assert!(!d.modified);
}
#[test]
fn returns_the_byte_identical_original_when_untouched_or_reverted() {
    let mut bytes = fixture(|_| {}); let original = bytes.clone();
    let d = open(&bytes); bytes.fill(0);
    let mut exported = export(&d); assert_eq!(exported, original); exported.fill(0);
    assert_eq!(export(&d), original);
    let run = d.paragraphs[0].runs[0].clone();
    let changed = replace(&d, &run.id, "Changed");
    let reverted = replace(&changed, &run.id, &run.text);
    assert!(!reverted.modified);
    assert_eq!(export(&reverted), original);
}
#[test]
fn edits_explicit_runs_escapes_markup_preserves_styling_and_unrelated_parts() {
    let bytes = fixture(|e| {
        body(e, r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:i w:val="false"/><w:sz w:val="28"/><w:rFonts w:ascii="Arial"/><w:color w:val="123456"/></w:rPr><w:t>Hello</w:t></w:r><w:r><w:t> tail</w:t></w:r></w:p>"#);
        e.push(ZipEntry::new("custom/preserve.bin", vec![0u8, 1, 255, 2]));
        change_xml(e, "[Content_Types].xml", |x| x.replace("</Types>", r#"<Default Extension="bin" ContentType="application/octet-stream"/></Types>"#));
    });
    let d = open(&bytes);
    assert_eq!(d.paragraphs[0].style_id.as_deref(), Some("Heading1"));
    assert_eq!(d.paragraphs[0].alignment.as_deref(), Some("center"));
    let st = &d.paragraphs[0].runs[0].style;
    assert_eq!((st.bold, st.italic, st.font_family.as_deref(), st.font_size_points, st.color.as_deref()), (Some(true), Some(false), Some("Arial"), Some(14.0), Some("123456")));
    let edited = replace(&d, "p0:r0", "  <&> 😀\r  ");
    assert_eq!(d.text, "Hello tail"); assert_eq!(edited.revision, 1); assert!(edited.modified);
    let output = export(&edited); let r = open(&output);
    assert_eq!(r.text, "  <&> 😀\r   tail");
    assert_eq!(r.paragraphs[0].runs[0].style, d.paragraphs[0].runs[0].style);
    let before = read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap(); let after = read_zip(&output, DEFAULT_ZIP_LIMITS).unwrap();
    for p in before.iter().filter(|p| p.name != "word/document.xml") { assert_eq!(after.iter().find(|x| x.name == p.name).unwrap().data, p.data); }
    assert!(document_xml(&output).contains(r#"<w:t xml:space="preserve">  &lt;&amp;&gt; 😀&#13;  </w:t>"#));
}
#[test]
fn reads_strict_namespaces_and_arbitrary_word_prefixes() {
    let bytes = fixture(|e| {
        change_xml(e, "word/document.xml", |x| x.replace(W, "http://purl.oclc.org/ooxml/wordprocessingml/main").replace("w:", "q:").replacen("xmlns:w", "xmlns:q", 1));
        change_xml(e, "_rels/.rels", |x| x.replace(R, "http://purl.oclc.org/ooxml/officeDocument/relationships"));
    });
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics);
    assert_eq!(reopen(&replace(&d, "p0:r0", "Strict")).text, "Strict\nWorld");
}
#[test]
fn resolves_the_main_part_through_relationships() {
    let bytes = fixture(|e| {
        e.iter_mut().find(|x| x.name == "word/document.xml").unwrap().name = "content/main.xml".into();
        change_xml(e, "_rels/.rels", |x| x.replace("word/document.xml", "content/main.xml"));
        change_xml(e, "[Content_Types].xml", |x| x.replace("word/document.xml", "content/main.xml"));
    });
    let d = open(&bytes);
    assert_eq!(d.text, "Hello\nWorld");
    assert_eq!(reopen(&replace(&d, "p1:r0", "Elsewhere")).text, "Hello\nElsewhere");
}
#[test]
fn fails_closed_for_unsupported_markup_while_preserving_original_bytes() {
    for markup in [r#"<w:p><w:r><w:t>A</w:t><w:drawing/></w:r></w:p>"#, r#"<w:p><w:r><w:t>A</w:t><w:unknown/></w:r></w:p>"#,
        r#"<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>A</w:t></w:r></w:p>"#, r#"<w:p><w:ins w:id="1"><w:r><w:t>A</w:t></w:r></w:ins></w:p>"#,
        r#"<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:t>A</w:t></w:r></w:p>"#, r#"<w:p><w:bookmarkStart w:id="1" w:name="x"/><w:r><w:t>A</w:t></w:r></w:p>"#,
        r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#, r#"<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>A</w:t></w:r></w:p>"#,
        r#"<w:p w:unknown="true"><w:r><w:t>A</w:t></w:r></w:p>"#] {
        let bytes = fixture(|e| body(e, markup));
        let d = open(&bytes);
        assert!(!d.can_edit, "{markup}");
        assert!(d.diagnostics.iter().any(|x| ["unsupported-markup", "unsupported-comments", "unsupported-revisions"].contains(&x.code.as_str()) && x.message.contains("Read-only")), "{markup}");
        assert!(replace_docx_text(&d, &edit("p0:r0", "no")).unwrap_err().message.contains("safely edited"));
        assert_eq!(export(&d), bytes);
    }
}
#[test]
fn keeps_a_multi_text_node_run_read_only_while_the_rest_stays_editable() {
    let bytes = fixture(|e| body(e, "<w:p><w:r><w:t>A</w:t><w:t>B</w:t></w:r></w:p><w:p><w:r><w:t>Plain</w:t></w:r></w:p>"));
    let d = open(&bytes);
    assert!(d.can_edit);
    assert_eq!((d.paragraphs[0].runs[0].text.as_str(), d.paragraphs[0].runs[0].can_edit), ("AB", false));
    assert!(replace_docx_text(&d, &edit(&d.paragraphs[0].runs[0].id, "no")).unwrap_err().message.contains("Unknown"));
    let output = export(&replace(&d, &d.paragraphs[1].runs[0].id, "Edited"));
    assert!(document_xml(&output).contains("<w:r><w:t>A</w:t><w:t>B</w:t></w:r>"));
    assert_eq!(open(&output).text, "AB\nEdited");
    assert_eq!(export(&d), bytes);
}
#[test]
fn preserves_an_unreferenced_external_hyperlink_relationship() {
    let bytes = fixture(|e| add_relationship(e, "hyperlink", "https://example.invalid/private", r#" TargetMode="External""#));
    let d = open(&bytes);
    assert!(d.can_edit); assert!(d.hyperlinks.is_empty());
    let output = export(&replace(&d, &d.paragraphs[0].runs[0].id, "Changed"));
    assert!(part(&output, "word/_rels/document.xml.rels").unwrap().contains(r#"Target="https://example.invalid/private" TargetMode="External""#));
}
#[test]
fn keeps_external_loaded_targets_read_only() {
    for kind in ["attachedTemplate", "image", "oleObject", "frame", "subDocument"] {
        let bytes = fixture(|e| add_relationship(e, kind, "https://example.invalid/remote", r#" TargetMode="External""#));
        let d = open(&bytes);
        assert!(!d.can_edit, "{kind}");
        assert!(d.diagnostics.iter().any(|x| x.code == "external-relationship"));
        assert_eq!(export(&d), bytes);
    }
}
#[test]
fn honors_document_protection_outside_the_main_part() {
    let bytes = fixture(|e| { add_relationship(e, "settings", "settings.xml", ""); e.push(ZipEntry::new("word/settings.xml", format!(r#"<w:settings xmlns:w="{W}"><w:documentProtection w:edit="readOnly"/></w:settings>"#))); });
    let d = open(&bytes);
    assert!(!d.can_edit); assert!(d.diagnostics.iter().any(|x| x.code == "protected-or-review-document"));
}
#[test]
fn finds_protection_in_non_xml_parts_via_content_types() {
    let bytes = fixture(|e| {
        add_relationship(e, "settings", "settings.dat", "");
        e.push(ZipEntry::new("word/settings.dat", format!(r#"<w:settings xmlns:w="{W}"><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>"#)));
        change_xml(e, "[Content_Types].xml", |x| x.replace("</Types>", r#"<Override PartName="/word/settings.dat" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>"#));
    });
    let d = open(&bytes);
    assert!(!d.can_edit); assert!(d.diagnostics.iter().any(|x| x.code == "protected-or-review-document"));
}
#[test]
fn fails_closed_for_an_opaque_settings_content_type() {
    let bytes = fixture(|e| {
        add_relationship(e, "settings", "settings.dat", "");
        e.push(ZipEntry::new("word/settings.dat", format!(r#"<w:settings xmlns:w="{W}"><w:trackRevisions/></w:settings>"#)));
        change_xml(e, "[Content_Types].xml", |x| x.replace("</Types>", r#"<Default Extension="dat" ContentType="application/octet-stream"/></Types>"#));
    });
    let d = open(&bytes);
    assert!(!d.can_edit); assert!(d.diagnostics.iter().any(|x| x.code == "opaque-formatting-dependency"));
}
#[test]
fn does_not_trust_role_names_from_unrecognized_namespaces() {
    let bytes = fixture(|e| {
        add_relationship(e, "settings", "settings.xml", "");
        e.push(ZipEntry::new("word/settings.xml", format!(r#"<w:settings xmlns:w="{W}"/>"#)));
        change_xml(e, "word/_rels/document.xml.rels", |x| x.replace(&format!("{R}/settings"), "https://unrecognized.invalid/settings"));
    });
    assert!(!open(&bytes).can_edit);
}
#[test]
fn rejects_malformed_closing_tags() {
    assert!(open_err(&fixture(|e| change_xml(e, "word/document.xml", |x| x.replacen("</w:t>", "</ w:t>", 1)))).contains("closing XML tag"));
}
#[test]
fn rejects_malformed_declarations_or_non_xml_whitespace() {
    let changes: [fn(&str) -> String; 3] = [|x| x.replacen("w:pgSz w:w=", "w:pgSz\u{a0}w:w=", 1), |x| x.replacen("<?xml version", "<?XML version", 1), |x| format!("{x}&#32;")];
    for change in changes { assert!(open_docx(&fixture(|e| change_xml(e, "word/document.xml", change)), DEFAULT_ZIP_LIMITS).is_err()); }
}
#[test]
fn extracts_core_metadata() {
    let bytes = fixture(|e| {
        change_xml(e, "_rels/.rels", |x| x.replace("</Relationships>", &format!(r#"<Relationship Id="core" Type="{REL}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#)));
        e.push(ZipEntry::new("docProps/core.xml", r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Generated title</dc:title><dc:creator>Test author</dc:creator></cp:coreProperties>"#));
    });
    let d = open(&bytes);
    assert_eq!(d.metadata.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), vec![("creator", "Test author"), ("title", "Generated title")]);
    assert!(d.can_edit);
}
#[test]
fn rejects_missing_targets_and_unresolved_references() {
    assert!(open_err(&fixture(|e| add_relationship(e, "styles", "missing.xml", ""))).contains("missing"));
    assert!(open_err(&fixture(|e| body(e, r#"<w:p><w:hyperlink r:id="absent"><w:r><w:t>A</w:t></w:r></w:hyperlink></w:p>"#))).contains("Unresolved"));
    assert!(open_err(&fixture(|e| add_relationship(e, "styles", "../../escape.xml", ""))).contains("escapes"));
    assert!(open_err(&fixture(|e| change_xml(e, "_rels/.rels", |x| x.replace("word/document.xml", "https://bad.test/a")))).contains("unsafe"));
}
#[test]
fn rejects_macros_duplicate_ids_and_malformed_manifests() {
    assert!(open_err(&fixture(|e| change_xml(e, "[Content_Types].xml", |x| x.replace("wordprocessingml.document.main+xml", "word.document.macroEnabled.main+xml")))).contains("non-macro"));
    assert!(open_err(&fixture(|e| change_xml(e, "_rels/.rels", |x| x.replace("</Relationships>", &format!(r#"<Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>"#))))).contains("duplicate"));
    assert!(open_err(&fixture(|e| change_xml(e, "[Content_Types].xml", |_| format!(r#"<Types xmlns="{CT}"/>"#)))).contains("no declared"));
    assert!(open_err(&fixture(|e| change_xml(e, "word/document.xml", |x| format!(r#"<!DOCTYPE x [<!ENTITY x "a">]>{x}"#)))).contains("DTD"));
}
#[test]
fn rejects_invalid_edit_ids_duplicates_controls_tabs_and_breaks_atomically() {
    let d = create_docx("A").unwrap();
    assert!(replace_docx_text(&d, &edit("missing", "B")).unwrap_err().message.contains("Unknown"));
    assert!(replace_docx_text(&d, &[TextEdit { run_id: "p0:r0".into(), text: "B".into() }, TextEdit { run_id: "p0:r0".into(), text: "C".into() }]).unwrap_err().message.contains("duplicate"));
    for text in ["a\nb", "a\tb", "\u{0}"] { assert!(replace_docx_text(&d, &edit("p0:r0", text)).is_err()); }
    assert_eq!(d.text, "A");
    // Lone surrogates and forged snapshots ({ ...doc }) cannot be expressed in Rust.
}
#[test]
fn bounds_edits_and_handles_self_closing_text_nodes() {
    let bytes = fixture(|e| body(e, "<w:p><w:r><w:t/></w:r></w:p>"));
    let d = open_docx(&bytes, ZipLimits { max_entry_bytes: 2000, ..DEFAULT_ZIP_LIMITS }).unwrap();
    let edited = replace(&d, "p0:r0", "new");
    assert_eq!(open_docx(&export(&edited), ZipLimits { max_entry_bytes: 2000, ..DEFAULT_ZIP_LIMITS }).unwrap().text, "new");
    assert!(replace_docx_text(&d, &edit("p0:r0", &"A".repeat(3000))).unwrap_err().message.contains("limit"));
}
