//! Port of src/lib/office/odt.test.ts.
#[path = "common/odt_fixture.rs"]
mod odt_fixture;
use markie_office::model::*;
use markie_office::odt::*;
use markie_office::zip::{DEFAULT_ZIP_LIMITS, ZipEntry, read_zip, write_zip};
use odt_fixture::*;

fn fixture() -> Vec<u8> { odt_fixture(Opts::default()) }
fn open(bytes: &[u8]) -> OdtDocument { open_odt(bytes).unwrap_or_else(|e| panic!("{}", e.message)) }
fn err(bytes: &[u8]) -> String { open_odt(bytes).err().expect("expected rejection").message }
fn fmt(f: impl FnOnce(&mut RunFormat)) -> RunFormat { let mut r = RunFormat::default(); f(&mut r); r }
fn reopen(d: &OdtDocument) -> OdtDocument { open(&export_odt(d).unwrap()) }
fn edit(id: &str, text: &str) -> Vec<TextEdit> { vec![TextEdit { run_id: id.into(), text: text.into() }] }

#[test]
fn reads_defaults_parent_inheritance_spans_and_relative_sizes() {
    let d = open(&fixture());
    assert_eq!(d.format, Format::Odt); assert!(d.can_edit);
    let p0 = &d.paragraphs[0];
    assert_eq!(p0.text, "OpenDocument editing works.");
    assert_eq!((p0.alignment.as_deref(), p0.spacing_before_points, p0.spacing_after_points), (Some("center"), Some(3.0), Some(6.0)));
    let st = &p0.runs.iter().find(|r| r.text.contains("editing")).unwrap().style;
    assert_eq!((st.bold, st.font_family.as_deref(), st.font_size_points, st.color.as_deref()), (Some(true), Some("Georgia"), Some(20.0), Some("336699")));
    assert_eq!(d.paragraphs[1].text, "Unicode: café, Ελληνικά, 日本語, 👋  tabs\tand\nlines.");
}
#[test]
fn inherits_enclosing_span_and_paragraph_properties_before_family_defaults() {
    let styles = ODT_FIXTURE_STYLES.replace("<office:styles>", r##"<office:styles><style:default-style style:family="text"><style:text-properties fo:font-size="10pt" fo:color="#ff0000" fo:font-family="Courier New" fo:font-style="italic"/></style:default-style>"##);
    let content = ODT_FIXTURE_CONTENT.replace("  editing </text:span>", "outer <text:span>inner</text:span> end</text:span>");
    let d = open(&odt_fixture(Opts { styles: Some(styles), content: Some(content), ..Default::default() }));
    let check = |d: &OdtDocument| {
        for run in d.paragraphs[0].runs.iter().filter(|r| ["outer", "inner", "end"].iter().any(|w| r.text.contains(w))) {
            let s = &run.style;
            assert_eq!((s.font_size_points, s.color.as_deref(), s.font_family.as_deref(), s.bold, s.italic), (Some(20.0), Some("336699"), Some("Georgia"), Some(true), Some(true)), "{}", run.text);
        }
    };
    check(&d);
    let next = apply_odt_operations(&d, &[Operation::ReplaceParagraph { paragraph_id: d.paragraphs[1].id.clone(), text: "Edit".into() }]).unwrap();
    check(&reopen(&next));
}
#[test]
fn exports_unchanged_source_byte_for_byte_and_owns_an_isolated_copy() {
    let mut bytes = fixture(); let original = bytes.clone();
    let d = open(&bytes); bytes.fill(0);
    assert_eq!(export_odt(&d).unwrap(), original);
    let mut exported = export_odt(&d).unwrap(); exported.fill(0); assert_eq!(export_odt(&d).unwrap(), original);
}
#[test]
fn edits_and_reopens_same_format_preserving_unrelated_part_bytes() {
    let bytes = fixture(); let before = read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap(); let d = open(&bytes);
    let next = apply_odt_operations(&d, &[
        Operation::FormatRange { paragraph_id: d.paragraphs[0].id.clone(), start: 0, end: 12, style: fmt(|f| { f.italic = Some(Some(true)); f.color = Some(Some("990000".into())); }) },
        Operation::FormatParagraph { paragraph_id: d.paragraphs[1].id.clone(), format: ParagraphFormat { alignment: Some(Some("right".into())), spacing_after_points: Some(Some(9.0)), ..Default::default() } },
    ]).unwrap();
    let changed = replace_odt_text(&next, &edit(&next.paragraphs[1].runs[0].id, " Retained  spaces\tand\nUnicode 👋 ")).unwrap();
    let output = export_odt(&changed).unwrap(); let after = read_zip(&output, DEFAULT_ZIP_LIMITS).unwrap(); let r = open(&output);
    let st = &r.paragraphs[0].runs[0].style;
    assert_eq!((st.italic, st.color.as_deref(), st.font_family.as_deref()), (Some(true), Some("990000"), Some("Georgia")));
    assert_eq!((r.paragraphs[1].alignment.as_deref(), r.paragraphs[1].spacing_after_points), (Some("right"), Some(9.0)));
    assert_eq!(r.paragraphs[1].text, " Retained  spaces\tand\nUnicode 👋 ");
    for part in before.iter().filter(|e| e.name != "content.xml") { assert_eq!(after.iter().find(|e| e.name == part.name).unwrap().data, part.data); }
    assert_eq!(&output[30..38], b"mimetype");
    assert_eq!(u16::from_le_bytes([output[8], output[9]]), 0); assert_eq!(u16::from_le_bytes([output[28], output[29]]), 0);
    assert_eq!(export_odt(&d).unwrap(), bytes);
}
#[test]
fn creates_a_real_odt_package_and_handles_empty_and_new_paragraphs() {
    let d = create_odt("Hello\n\n World ").unwrap();
    assert_eq!(d.text, "Hello\n\n World ");
    let next = apply_odt_operations(&d, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After(d.paragraphs[0].id.clone()), text: "Inserted".into() }]).unwrap();
    assert_eq!(reopen(&next).text, "Hello\nInserted\n\n World ");
}
#[test]
fn keeps_no_op_operations_byte_neutral() {
    let bytes = fixture(); let d = open(&bytes);
    let same = replace_odt_text(&d, &edit(&d.paragraphs[0].runs[0].id, &d.paragraphs[0].runs[0].text.clone())).unwrap();
    assert_eq!(export_odt(&same).unwrap(), bytes);
}
#[test]
fn keeps_clear_format_defaults_identical_on_canvas_and_after_reopening() {
    let bytes = fixture(); let d = open(&bytes);
    let next = apply_odt_operations(&d, &[Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style: fmt(|f| { f.font_family = Some(None); f.font_size_points = Some(None); f.color = Some(None); }) }]).unwrap();
    let st = next.paragraphs[0].runs[0].style.clone();
    assert_eq!((st.font_family.as_deref(), st.font_size_points, st.color.as_deref()), (Some("Georgia"), Some(12.0), Some("222222")));
    let output = export_odt(&next).unwrap(); let r = open(&output);
    let rs = &r.paragraphs[0].runs[0].style;
    assert_eq!((rs.font_family.as_deref(), rs.font_size_points, rs.color.as_deref()), (Some("Georgia"), Some(12.0), Some("222222")));
    let styles = |b: &[u8]| read_zip(b, DEFAULT_ZIP_LIMITS).unwrap().into_iter().find(|p| p.name == "styles.xml").unwrap().data;
    assert_eq!(styles(&output), styles(&bytes));
    let inserted = apply_odt_operations(&d, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::End, text: "New defaults".into() }]).unwrap();
    let ist = &inserted.paragraphs[0].runs[0].style;
    assert_eq!((ist.font_family.as_deref(), ist.font_size_points, ist.color.as_deref()), (Some("Georgia"), Some(12.0), Some("222222")));
    let restored = reopen(&inserted);
    let rst = &restored.paragraphs[0].runs[0].style;
    assert_eq!((rst.font_family.as_deref(), rst.font_size_points, rst.color.as_deref()), (Some("Georgia"), Some(12.0), Some("222222")));
}
#[test]
fn rebases_paragraph_resets_to_retained_default_alignment_and_spacing() {
    let styles = ODT_FIXTURE_STYLES.replace(r#"<style:default-style style:family="paragraph">"#, r#"<style:default-style style:family="paragraph"><style:paragraph-properties fo:text-align="right" fo:margin-top="2pt" fo:margin-bottom="4pt" fo:line-height="150%"/>"#);
    let d = open(&odt_fixture(Opts { styles: Some(styles), ..Default::default() }));
    let next = apply_odt_operations(&d, &[Operation::FormatParagraph { paragraph_id: d.paragraphs[0].id.clone(), format: ParagraphFormat { alignment: Some(None), spacing_before_points: Some(None), spacing_after_points: Some(None), line_spacing_multiple: Some(None), style_id: None } }]).unwrap();
    for p in [&next.paragraphs[0], &reopen(&next).paragraphs[0]] {
        assert_eq!((p.alignment.as_deref(), p.spacing_before_points, p.spacing_after_points, p.line_spacing_multiple), (Some("right"), Some(2.0), Some(4.0), Some(1.5)));
    }
}
#[test]
fn rejects_imported_defaults_outside_the_editable_model_bounds() {
    for property in [r#"fo:line-height="600%""#, r#"fo:line-height="49%""#, r#"fo:margin-top="1001pt""#, r#"fo:margin-bottom="2000pt""#] {
        let styles = ODT_FIXTURE_STYLES.replace(r#"<style:default-style style:family="paragraph">"#, &format!(r#"<style:default-style style:family="paragraph"><style:paragraph-properties {property}/>"#));
        assert!(err(&odt_fixture(Opts { styles: Some(styles), ..Default::default() })).contains("supported"), "{property}");
    }
}
#[test]
fn accepts_and_edits_paragraph_defaults_exactly_at_the_model_limits() {
    let styles = ODT_FIXTURE_STYLES.replace(r#"<style:default-style style:family="paragraph">"#, r#"<style:default-style style:family="paragraph"><style:paragraph-properties fo:line-height="500%" fo:margin-top="1000pt" fo:margin-bottom="1000pt"/>"#);
    let d = open(&odt_fixture(Opts { styles: Some(styles), ..Default::default() }));
    let next = apply_odt_operations(&d, &[Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style: fmt(|f| f.italic = Some(Some(true))) }]).unwrap();
    let p = &reopen(&next).paragraphs[1];
    assert_eq!((p.line_spacing_multiple, p.spacing_before_points, p.spacing_after_points), (Some(5.0), Some(1000.0), Some(1000.0)));
}
#[test]
fn bounds_explicit_space_expansion_cumulatively() {
    let content = with_text(&format!("<office:text><text:p>{}</text:p></office:text>", r#"<text:s text:c="100000"/>"#.repeat(11)));
    assert!(err(&odt_fixture(Opts { content: Some(content), ..Default::default() })).contains("decoded text"));
    let across = with_text(&format!("<office:text>{}</office:text>", r#"<text:p><text:s text:c="100000"/></text:p>"#.repeat(11)));
    assert!(err(&odt_fixture(Opts { content: Some(across), ..Default::default() })).contains("decoded text"));
}
#[test]
fn reopens_an_edited_million_space_document_within_parser_budgets() {
    let content = with_text(&format!("<office:text><text:p>{}</text:p></office:text>", r#"<text:s text:c="100000"/>"#.repeat(10)));
    let d = open(&odt_fixture(Opts { content: Some(content), ..Default::default() }));
    assert_eq!(d.text.len(), 1_000_000);
    let next = apply_odt_operations(&d, &[Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style: fmt(|f| f.bold = Some(Some(true))) }]).unwrap();
    let output = export_odt(&next).unwrap();
    assert!(output.len() < 10000);
    let r = open(&output);
    assert_eq!(r.text, next.text); assert_eq!(r.paragraphs[0].runs[0].style.bold, Some(true));
}
#[test]
fn rejects_generated_candidates_beyond_reader_node_budgets() {
    let d = create_odt("safe").unwrap();
    let next = replace_odt_text(&d, &edit(&d.paragraphs[0].runs[0].id, &"\t".repeat(100001))).unwrap();
    assert!(export_odt(&next).unwrap_err().message.contains("structure exceeds"));
    assert_eq!(reopen(&d).text, "safe");
}
#[test]
fn rejects_direct_structural_text() {
    for tag in ["<office:text>", "<office:body>", "<office:automatic-styles>"] {
        assert!(open_odt(&odt_fixture(Opts { content: Some(ODT_FIXTURE_CONTENT.replace(tag, &format!("{tag}Silent loss"))), ..Default::default() })).is_err(), "{tag}");
    }
}
#[test]
fn rejects_unsupported_mutations() {
    // The TypeScript foreign-snapshot half (a DOCX passed as ODT) cannot be written: the types differ.
    let d = open(&fixture());
    assert!(apply_odt_operations(&d, &[Operation::SetPageLayout { layout: PageLayoutChange { margin_left_points: Some(1000.0), ..Default::default() } }]).unwrap_err().message.contains("Margins"));
    assert!(apply_odt_operations(&d, &[Operation::InsertTable { after_paragraph_id: InsertAt::End, rows: 1, columns: 1, cells: None }]).is_err());
}
#[test]
fn recognizes_only_owned_snapshots_from_the_same_opened_source() {
    let bytes = fixture(); let first = open(&bytes); let second = open(&bytes);
    let derived = apply_odt_operations(&first, &[Operation::ReplaceParagraph { paragraph_id: first.paragraphs[0].id.clone(), text: "Derived".into() }]).unwrap();
    assert!(is_same_odt_source(&first, &first)); assert!(is_same_odt_source(&first, &derived)); assert!(!is_same_odt_source(&first, &second));
}
#[test]
fn rejects_unrepresentable_formatting_before_mutation() {
    for style in [fmt(|f| f.color = Some(Some("auto".into()))), fmt(|f| f.underline = Some(Some("wave".into()))), fmt(|f| f.font_family = Some(Some("Arial, serif".into())))] {
        let bytes = fixture(); let d = open(&bytes);
        assert!(apply_odt_operations(&d, &[Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style }]).is_err());
        assert_eq!(export_odt(&d).unwrap(), bytes);
    }
}
#[test]
fn rejects_literal_carriage_return_edits() {
    let d = create_odt("safe").unwrap();
    assert!(replace_odt_text(&d, &edit(&d.paragraphs[0].runs[0].id, "a\rb")).unwrap_err().message.contains("carriage returns"));
    assert!(create_odt("a\rb").unwrap_err().message.contains("carriage returns"));
}
#[test]
fn retains_locally_declared_namespace_prefixes_in_existing_automatic_styles() {
    let start = ODT_FIXTURE_CONTENT.find("<office:automatic-styles>").unwrap();
    let end = ODT_FIXTURE_CONTENT.find("</office:automatic-styles>").unwrap() + "</office:automatic-styles>".len();
    let content = format!("{}{}{}", &ODT_FIXTURE_CONTENT[..start], r#"<office:automatic-styles xmlns:z="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><z:style z:name="Centered" z:family="paragraph" z:parent-style-name="Body"/><z:style z:name="Accent" z:family="text"><z:text-properties fo:font-weight="bold"/></z:style></office:automatic-styles>"#, &ODT_FIXTURE_CONTENT[end..]);
    let d = open(&odt_fixture(Opts { content: Some(content), ..Default::default() }));
    let next = apply_odt_operations(&d, &[Operation::ReplaceParagraph { paragraph_id: d.paragraphs[0].id.clone(), text: "Changed".into() }]).unwrap();
    assert_eq!(reopen(&next).paragraphs[0].text, "Changed");
}
#[test]
fn can_edit_a_self_closing_automatic_styles_container() {
    let d = create_odt("simple").unwrap();
    let parts = read_zip(&export_odt(&d).unwrap(), DEFAULT_ZIP_LIMITS).unwrap();
    let parts: Vec<ZipEntry> = parts.into_iter().map(|p| if p.name == "content.xml" { ZipEntry::new(p.name.clone(), String::from_utf8(p.data).unwrap().replace("<office:body>", "<office:automatic-styles/><office:body>")) } else { p }).collect();
    let opened = open(&write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap());
    let next = apply_odt_operations(&opened, &[Operation::FormatRun { run_id: opened.paragraphs[0].runs[0].id.clone(), style: fmt(|f| f.bold = Some(Some(true))) }]).unwrap();
    assert_eq!(reopen(&next).paragraphs[0].runs[0].style.bold, Some(true));
}
#[test]
fn rejects_unsupported_blocks() {
    for node in [r#"<table:table xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"/>"#, "<text:h>Not silently flattened</text:h>", "<text:tracked-changes/>", r#"<draw:frame xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"/>"#] {
        assert!(err(&odt_fixture(Opts { content: Some(ODT_FIXTURE_CONTENT.replace("<office:text>", &format!("<office:text>{node}"))), ..Default::default() })).contains("Unsupported ODT block"), "{node}");
    }
}
#[test]
fn rejects_unsupported_inline_semantics() {
    for node in [r#"<text:a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.com">link</text:a>"#, r#"<text:bookmark text:name="hidden"/>"#, r#"<text:span text:style-name="Missing">text</text:span>"#, r#"<text:s text:c="100001"/>"#, r#"<text:s text:c="0"/>"#] {
        assert!(open_odt(&odt_fixture(Opts { content: Some(ODT_FIXTURE_CONTENT.replace("works.", node)), ..Default::default() })).is_err(), "{node}");
    }
}
#[test]
fn collapses_raw_whitespace_across_nested_span_boundaries_not_nbsp() {
    let content = with_text("<office:text><text:p>  a <text:span>  <text:span>b </text:span> </text:span> c\u{a0} d  </text:p></office:text>");
    assert_eq!(open(&odt_fixture(Opts { content: Some(content), ..Default::default() })).text, "a b c\u{a0} d");
}
#[test]
fn rejects_unsupported_style_properties() {
    for property in [r##"fo:background-color="#ffff00""##, r#"style:font-name-asian="CJK""#, r#"fo:font-size="garbage""#, r#"fo:font-size="1200pt""#, r#"style:text-underline-type="double""#, r#"style:font-size-rel="2pt""#, r#"fo:font-weight="600""#] {
        assert!(open_odt(&odt_fixture(Opts { styles: Some(ODT_FIXTURE_STYLES.replace(r#"fo:font-size="16pt""#, property)), ..Default::default() })).is_err(), "{property}");
    }
}
#[test]
fn rejects_cyclic_or_missing_style_ancestry() {
    assert!(err(&odt_fixture(Opts { styles: Some(ODT_FIXTURE_STYLES.replace(r#"style:name="Body""#, r#"style:name="Body" style:parent-style-name="Body""#)), ..Default::default() })).contains("Cyclic"));
}
#[test]
fn requires_mimetype_first_and_rejects_wrong_manifest_media() {
    let entries = read_zip(&fixture(), DEFAULT_ZIP_LIMITS).unwrap();
    let mut reordered = vec![entries[1].clone(), entries[0].clone()]; reordered.extend(entries[2..].iter().cloned());
    assert!(err(&write_zip(&reordered, DEFAULT_ZIP_LIMITS).unwrap()).contains("first"));
    let swapped: Vec<ZipEntry> = entries.iter().map(|e| if e.name == "META-INF/manifest.xml" { ZipEntry::new(e.name.clone(), String::from_utf8(e.data.clone()).unwrap().replacen(r#"manifest:media-type="text/xml""#, r#"manifest:media-type="text/plain""#, 1)) } else { e.clone() }).collect();
    assert!(err(&write_zip(&swapped, DEFAULT_ZIP_LIMITS).unwrap()).contains("media types"));
}
#[test]
fn rejects_undeclared_missing_duplicate_encrypted_and_signed_entries() {
    let entries = read_zip(&fixture(), DEFAULT_ZIP_LIMITS).unwrap();
    let mut extra = entries.clone(); extra.push(ZipEntry::new("undeclared.bin", vec![1u8]));
    assert!(err(&write_zip(&extra, DEFAULT_ZIP_LIMITS).unwrap()).contains("undeclared"));
    let missing: Vec<ZipEntry> = entries.iter().filter(|e| e.name != "meta.xml").cloned().collect();
    assert!(err(&write_zip(&missing, DEFAULT_ZIP_LIMITS).unwrap()).contains("missing part"));
    let manifest = String::from_utf8(entries.iter().find(|e| e.name == "META-INF/manifest.xml").unwrap().data.clone()).unwrap();
    assert!(err(&odt_fixture(Opts { manifest: Some(manifest.replace("</manifest:manifest>", r#"<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>"#)), ..Default::default() })).contains("duplicate"));
    assert!(err(&odt_fixture(Opts { manifest: Some(manifest.replacen(r#"manifest:media-type="text/xml"/>"#, r#"manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry>"#, 1)), ..Default::default() })).contains("Encrypted"));
    assert!(err(&odt_fixture(Opts { extra: Some(vec![ZipEntry::new("META-INF/documentsignatures.xml", Vec::<u8>::new())]), ..Default::default() })).contains("Signed"));
}
#[test]
fn rejects_dtd_declarations_and_unsupported_package_versions() {
    let with = |prefix: &str, content: String| odt_fixture(Opts { content: Some(format!("{prefix}{content}")), ..Default::default() });
    assert!(err(&with(r#"<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]>"#, ODT_FIXTURE_CONTENT.replace("works.", "&secret;"))).contains("DTD"));
    assert!(err(&with(r#"<!DOCTYPE x SYSTEM "file:///secret" [<!ATTLIST x a CDATA "b">]>"#, ODT_FIXTURE_CONTENT.to_string())).contains("DTD"));
    let external = open(&with(r#"<!DOCTYPE x SYSTEM "file:///secret">"#, ODT_FIXTURE_CONTENT.to_string()));
    assert_eq!(external.text, open(&fixture()).text); assert!(external.can_edit);
    assert!(err(&with(r#"<!DOCTYPE x SYSTEM "file:///secret">"#, ODT_FIXTURE_CONTENT.replace("works.", "&secret;"))).contains("Custom XML entities"));
    assert!(err(&odt_fixture(Opts { content: Some(ODT_FIXTURE_CONTENT.replace(r#"office:version="1.3""#, r#"office:version="1.4""#)), ..Default::default() })).contains("1.2/1.3"));
}

// ---- odt-readonly.test.ts ----
fn real(name: &str) -> Vec<u8> {
    match name { "textedit" => include_bytes!("fixtures/textedit-report.odt").to_vec(), _ => include_bytes!("fixtures/libreoffice-report.odt").to_vec() }
}
fn top_level(d: &OdtDocument) -> Vec<String> {
    d.blocks.iter().map(|b| match b { Block::Paragraph(id) => d.paragraph(id).unwrap().text.clone(), Block::Table(_) => "[table]".into() }).collect()
}
fn cells(d: &OdtDocument) -> Vec<Vec<String>> {
    d.tables[0].rows.iter().map(|r| r.cells.iter().map(|c| c.paragraph_ids.iter().map(|id| d.paragraph(id).unwrap().text.clone()).collect::<Vec<_>>().join("\n")).collect()).collect()
}
fn by_text<'a>(d: &'a OdtDocument, text: &str) -> &'a Paragraph { d.paragraphs.iter().find(|p| p.text == text).unwrap_or_else(|| panic!("{text}")) }
fn with_part(bytes: &[u8], name: &str, replace: impl Fn(&str) -> String) -> Vec<u8> {
    let entries = read_zip(bytes, DEFAULT_ZIP_LIMITS).unwrap();
    write_zip(&entries.into_iter().map(|e| if e.name == name { ZipEntry::new(name, replace(&String::from_utf8(e.data).unwrap())) } else { e }).collect::<Vec<_>>(), DEFAULT_ZIP_LIMITS).unwrap()
}
fn replace_doctype(xml: &str, with: &str) -> String {
    let start = xml.find("<!DOCTYPE").unwrap(); let end = start + xml[start..].find('>').unwrap() + 1;
    format!("{}{}{}", &xml[..start], with, &xml[end..])
}
const REPORT: [&str; 9] = ["Quarterly Report", "This is bold and italic text.", "Items", "Step one", "Step two", "First item", "Second item", "[table]", "After the table."];
fn report_cells() -> Vec<Vec<String>> { [["Name", "Qty"], ["Apples", "3"], ["Pears", "5"]].iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect() }

#[test]
fn opens_a_real_textedit_odt_with_headings_emphasis_lists_and_a_table() {
    let bytes = real("textedit");
    let manifest = read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap().into_iter().find(|e| e.name == "META-INF/manifest.xml").unwrap();
    assert!(String::from_utf8(manifest.data).unwrap().contains("<!DOCTYPE manifest:manifest PUBLIC"));
    let d = open_odt_for_display(&bytes).unwrap();
    assert_eq!(d.format, Format::Odt); assert!(!d.can_edit);
    assert_eq!(top_level(&d), REPORT);
    assert_eq!(cells(&d), report_cells());
    let h = &by_text(&d, "Quarterly Report").runs[0].style;
    assert_eq!((h.bold, h.font_size_points, h.font_family.as_deref()), (Some(true), Some(24.0), Some("Times")));
    let body = by_text(&d, "This is bold and italic text.");
    assert_eq!(body.runs.iter().find(|r| r.text == "bold").unwrap().style.bold, Some(true));
    assert_eq!(body.runs.iter().find(|r| r.text == "italic").unwrap().style.italic, Some(true));
    let one = by_text(&d, "Step one");
    assert_eq!((one.list_kind, one.list_level, one.list_number), (Some(ListKind::Numbered), Some(0), Some(1)));
    let two = by_text(&d, "Step two");
    assert_eq!((two.list_kind, two.list_number), (Some(ListKind::Numbered), Some(2)));
    let first = by_text(&d, "First item");
    assert_eq!((first.list_kind, first.list_level), (Some(ListKind::Bullet), Some(0)));
    assert_eq!(by_text(&d, "Name").alignment.as_deref(), Some("center"));
    let l = d.page_layout;
    assert_eq!((l.width_points, l.height_points, l.margin_top_points, l.margin_left_points), (612.0, 792.0, 36.0, 72.0));
    assert_eq!((d.diagnostics[0].code.as_str(), d.diagnostics[0].severity), ("odt-read-only", Severity::Warning));
    assert_eq!(export_odt(&d).unwrap(), bytes);
    assert!(apply_odt_operations(&d, &[Operation::ReplaceParagraph { paragraph_id: d.paragraphs[0].id.clone(), text: "x".into() }]).unwrap_err().message.contains("read-only"));
}
#[test]
fn opens_a_real_libreoffice_odf_1_4_document() {
    let bytes = real("libreoffice");
    let d = open_odt_for_display(&bytes).unwrap();
    assert!(!d.can_edit);
    assert_eq!(top_level(&d), REPORT);
    assert_eq!(cells(&d), report_cells());
    let h = &by_text(&d, "Quarterly Report").runs[0].style;
    assert_eq!(h.bold, Some(true)); assert!(h.font_size_points.unwrap() > 12.0);
    assert_eq!(by_text(&d, "This is bold and italic text.").runs.iter().find(|r| r.text == "bold").unwrap().style.bold, Some(true));
    let two = by_text(&d, "Step two");
    assert_eq!((two.list_kind, two.list_number), (Some(ListKind::Numbered), Some(2)));
    assert_eq!(by_text(&d, "Second item").list_kind, Some(ListKind::Bullet));
    assert_eq!(export_odt(&d).unwrap(), bytes);
}
#[test]
fn keeps_a_document_the_bounded_codec_can_edit_editable() {
    let d = open_odt_for_display(&fixture()).unwrap();
    assert!(d.can_edit);
    assert_eq!(d.diagnostics.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["odt-bounded-rich-text"]);
}
#[test]
fn leaves_out_hidden_deleted_annotation_note_and_drawing_content_and_flattens_nested_tables() {
    let t = r#"xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0""#;
    let content = ODT_FIXTURE_CONTENT.replace(r#"office:version="1.3""#, &format!(r#"{t} office:version="1.4""#)).replace("<office:text>", r#"<office:text><text:tracked-changes><text:changed-region><text:deletion><text:p>deleted secret</text:p></text:deletion></text:changed-region></text:tracked-changes><text:section text:display="none"><text:p>hidden section</text:p></text:section><text:p>Keep<office:annotation><text:p>private comment</text:p></office:annotation><text:note><text:note-body><text:p>note text</text:p></text:note-body></text:note><draw:frame><draw:text-box><text:p>frame text</text:p></draw:text-box></draw:frame> <text:a>link</text:a></text:p><table:table><table:table-row><table:table-cell><text:p>Outer</text:p><table:table><table:table-row><table:table-cell><text:p>Inner</text:p></table:table-cell></table:table-row></table:table></table:table-cell><table:covered-table-cell/><table:table-cell/></table:table-row></table:table>"#);
    let d = open_odt_for_display(&odt_fixture(Opts { content: Some(content), ..Default::default() })).unwrap();
    assert!(!d.can_edit);
    for secret in ["secret", "hidden", "private", "note text", "frame text"] { assert!(!d.text.contains(secret), "{secret}"); }
    assert_eq!(d.paragraphs[0].text, "Keep link");
    assert_eq!(cells(&d), vec![vec!["Outer\nInner".to_string(), String::new()]]);
    assert_eq!(d.diagnostics.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["odt-read-only", "odt-omitted"]);
}
#[test]
fn refuses_tiny_nested_tables_whose_repeats_multiply() {
    let t = r#"xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0""#;
    let level = |inner: &str| format!(r#"<table:table><table:table-row table:number-rows-repeated="64"><table:table-cell table:number-columns-repeated="64">{inner}</table:table-cell></table:table-row></table:table>"#);
    let bomb = level(&level(&level("")));
    let content = ODT_FIXTURE_CONTENT.replace(r#"office:version="1.3""#, &format!(r#"{t} office:version="1.4""#)).replace("<office:text>", &format!("<office:text>{bomb}"));
    let started = std::time::Instant::now();
    assert!(open_odt_for_display(&odt_fixture(Opts { content: Some(content), ..Default::default() })).unwrap_err().message.contains("tables larger"));
    assert!(started.elapsed().as_millis() < 2000);
}
#[test]
fn still_refuses_hostile_xml_anywhere_instead_of_falling_back() {
    let lol = r#"<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>"#;
    let xxe = r#"<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>"#;
    let te = real("textedit");
    let decl = r#"<?xml version="1.0" encoding="UTF-8"?>"#;
    let cases = [
        with_part(&te, "META-INF/manifest.xml", |x| replace_doctype(x, lol)),
        with_part(&te, "META-INF/manifest.xml", |x| replace_doctype(x, xxe).replace(r#"manifest:full-path="/""#, r#"manifest:full-path="&xxe;""#)),
        with_part(&te, "META-INF/manifest.xml", |x| x.replace(r#""Manifest.dtd">"#, r#""Manifest.dtd" [<!ATTLIST manifest:manifest a CDATA "x">]>"#)),
        with_part(&te, "content.xml", |x| x.replacen(decl, &format!("{decl}{xxe}"), 1).replacen("Quarterly Report", "&xxe;", 1)),
        with_part(&te, "content.xml", |x| x.replacen(decl, &format!("{decl}{lol}"), 1).replacen("Quarterly Report", "&lol2;", 1)),
        with_part(&te, "styles.xml", |x| x.replacen(decl, &format!("{decl}{xxe}"), 1)),
    ];
    for bytes in cases {
        let message = open_odt_for_display(&bytes).unwrap_err().message.to_lowercase();
        assert!(message.contains("dtd") || message.contains("declarations") || message.contains("entit"), "{message}");
    }
}
#[test]
fn still_refuses_encrypted_signed_scripted_and_non_text_packages() {
    let manifest = |extra: &str| format!(r#"<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>{extra}</manifest:manifest>"#);
    let v14 = ODT_FIXTURE_CONTENT.replace(r#"office:version="1.3""#, r#"office:version="1.4""#);
    let o = |manifest: Option<String>, extra: Option<Vec<ZipEntry>>| odt_fixture(Opts { content: Some(v14.clone()), manifest, extra, ..Default::default() });
    assert!(open_odt_for_display(&o(Some(manifest(r#"<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry>"#)), Some(vec![]))).unwrap_err().message.contains("Encrypted"));
    assert!(open_odt_for_display(&o(None, Some(vec![ZipEntry::new("Basic/Standard/Module1.xml", vec![1u8])]))).unwrap_err().message.contains("executable"));
    assert!(open_odt_for_display(&o(None, Some(vec![ZipEntry::new("META-INF/documentsignatures.xml", Vec::<u8>::new())]))).unwrap_err().message.contains("Signed"));
    assert!(open_odt_for_display(&o(Some(manifest("").replace("opendocument.text", "opendocument.spreadsheet")), None)).unwrap_err().message.contains("media types"));
}
#[test]
fn keeps_the_strict_editable_codec_strict() {
    assert!(err(&real("textedit")).contains("1.2/1.3"));
    let d = open_odt_for_display(&real("textedit")).unwrap();
    assert_eq!(export_odt(&d).unwrap(), real("textedit"));
}

// ---- odt-layout.test.ts ----
const PROPERTIES: &str = r#"<style:page-layout-properties fo:page-width="21cm" fo:page-height="297mm" style:print-orientation="portrait" fo:margin="1in" fo:margin-left="36pt"/>"#;
fn layout_xml() -> String { format!(r#"<style:page-layout style:name="Paper" style:page-usage="all">{PROPERTIES}</style:page-layout>"#) }
const MASTER: &str = r#"<style:master-page style:name="Standard" style:display-name="Plain paper" style:page-layout-name="Paper"/>"#;
fn page_styles_with(automatic: &str, pages: &str) -> String {
    ODT_FIXTURE_STYLES.replace("</office:document-styles>", &format!("<office:automatic-styles>{automatic}</office:automatic-styles><office:master-styles>{pages}</office:master-styles></office:document-styles>"))
}
fn page_styles() -> String { page_styles_with(&layout_xml(), MASTER) }
fn parts(bytes: &[u8]) -> std::collections::BTreeMap<String, Vec<u8>> { read_zip(bytes, DEFAULT_ZIP_LIMITS).unwrap().into_iter().map(|e| (e.name, e.data)).collect() }
fn styled(styles: String) -> Vec<u8> { odt_fixture(Opts { styles: Some(styles), ..Default::default() }) }
fn layout_op(c: PageLayoutChange) -> Operation { Operation::SetPageLayout { layout: c } }

#[test]
fn reads_physical_units_margin_shorthand_and_the_referenced_master() {
    let d = open(&styled(page_styles()));
    assert!(d.can_edit);
    assert!((d.page_layout.width_points - 595.27559).abs() < 0.005);
    assert!((d.page_layout.height_points - 841.88976).abs() < 0.005);
    let l = d.page_layout;
    assert_eq!((l.orientation, l.margin_top_points, l.margin_right_points, l.margin_bottom_points, l.margin_left_points), (Orientation::Portrait, 72.0, 72.0, 72.0, 36.0));
}
#[test]
fn keeps_unchanged_odt_exact_and_body_edits_leave_styles_identical() {
    let bytes = styled(page_styles()); let original = parts(&bytes); let d = open(&bytes);
    assert_eq!(export_odt(&d).unwrap(), bytes);
    let edited = apply_odt_operations(&d, &[Operation::ReplaceParagraph { paragraph_id: d.paragraphs[0].id.clone(), text: "Page geometry is retained".into() }]).unwrap();
    let output = export_odt(&edited).unwrap(); let next_parts = parts(&output); let next = open(&output);
    assert_eq!(next.page_layout, d.page_layout); assert_eq!(next.text, edited.text);
    for (name, data) in &original { if name != "content.xml" { assert_eq!(next_parts.get(name), Some(data), "{name}"); } }
}
#[test]
fn changes_only_the_exact_page_properties_for_layout_only_edits() {
    let bytes = styled(page_styles()); let original = parts(&bytes); let d = open(&bytes);
    let edited = apply_odt_operations(&d, &[layout_op(PageLayoutChange { paper: Some(Paper::Legal), orientation: Some(Orientation::Landscape), margin_top_points: Some(24.0), margin_right_points: Some(48.0), ..Default::default() })]).unwrap();
    let output = export_odt(&edited).unwrap(); let next_parts = parts(&output); let next = open(&output);
    assert_eq!(next.page_layout, edited.page_layout);
    let l = next.page_layout;
    assert_eq!((l.width_points, l.height_points, l.orientation, l.margin_top_points, l.margin_right_points, l.margin_left_points), (1008.0, 612.0, Orientation::Landscape, 24.0, 48.0, 36.0));
    for (name, data) in &original { if name != "styles.xml" { assert_eq!(next_parts.get(name), Some(data), "{name}"); } }
    let styles = String::from_utf8(next_parts["styles.xml"].clone()).unwrap();
    let source = page_styles();
    let at = styles.find("<style:page-layout-properties").unwrap();
    assert_eq!(&styles[..at], &source[..source.find(PROPERTIES).unwrap()]);
    let close = at + styles[at..].find("/>").unwrap() + 2;
    assert_eq!(&styles[close..], &source[source.find(PROPERTIES).unwrap() + PROPERTIES.len()..]);
    assert_eq!(export_odt(&d).unwrap(), bytes);
}
#[test]
fn persists_sequential_geometry_and_body_edits() {
    let d = open(&styled(page_styles()));
    let landscape = apply_odt_operations(&d, &[layout_op(PageLayoutChange { orientation: Some(Orientation::Landscape), ..Default::default() })]).unwrap();
    let edited = apply_odt_operations(&landscape, &[
        Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style: fmt(|f| f.italic = Some(Some(true))) },
        layout_op(PageLayoutChange { paper: Some(Paper::Letter), orientation: Some(Orientation::Portrait), margin_bottom_points: Some(0.0), ..Default::default() }),
    ]).unwrap();
    let next = reopen(&edited);
    assert_eq!(next.page_layout, edited.page_layout);
    assert_eq!(next.paragraphs[0].runs[0].style.italic, Some(true));
    assert_eq!(landscape.page_layout.orientation, Orientation::Landscape); assert_eq!(d.page_layout.orientation, Orientation::Portrait);
}
#[test]
fn rejects_a_mid_body_paragraph_selecting_the_same_master() {
    for style in ["Body", "Centered"] {
        let styles = page_styles().replace(r#"style:name="Body""#, r#"style:name="Body" style:master-page-name="Standard""#);
        let content = ODT_FIXTURE_CONTENT.replace(r#"text:style-name="Centered""#, "").replace("<text:p>Unicode:", &format!(r#"<text:p text:style-name="{style}">Unicode:"#));
        assert!(err(&odt_fixture(Opts { styles: Some(styles), content: Some(content), ..Default::default() })).contains("master-page"));
    }
}
#[test]
fn rejects_master_page_references_on_first_paragraph_and_unused_styles() {
    let styles = page_styles().replace(r#"style:name="Body""#, r#"style:name="Body" style:master-page-name="Standard""#);
    assert!(err(&styled(styles.clone())).contains("master-page"));
    let content = ODT_FIXTURE_CONTENT.replace(r#"text:style-name="Centered""#, "");
    assert!(err(&odt_fixture(Opts { styles: Some(styles), content: Some(content), ..Default::default() })).contains("master-page"));
}
#[test]
fn creates_geometry_in_styles_xml_for_new_odt() {
    let d = create_odt("New document").unwrap(); let original = parts(&export_odt(&d).unwrap());
    assert!(String::from_utf8_lossy(&original["styles.xml"]).contains("style:master-page"));
    assert!(String::from_utf8_lossy(&original["META-INF/manifest.xml"]).contains(r#"manifest:full-path="styles.xml""#));
    assert!(!original.keys().any(|k| k.starts_with("word/")));
    let edited = apply_odt_operations(&d, &[layout_op(PageLayoutChange { paper: Some(Paper::A4), orientation: Some(Orientation::Landscape), ..Default::default() })]).unwrap();
    assert_eq!(reopen(&edited).page_layout, edited.page_layout);
}
#[test]
fn adds_geometry_to_legacy_styles() {
    for kind in ["no containers", "automatic", "master", "both"] {
        let mut extra = String::new();
        if kind == "automatic" || kind == "both" { extra.push_str("<office:automatic-styles/>"); }
        if kind == "master" || kind == "both" { extra.push_str("<office:master-styles/>"); }
        let bytes = styled(ODT_FIXTURE_STYLES.replace("</office:document-styles>", &format!("{extra}</office:document-styles>")));
        let d = open(&bytes); let original = parts(&bytes);
        let edited = apply_odt_operations(&d, &[layout_op(PageLayoutChange { paper: Some(Paper::A4), margin_top_points: Some(0.0), ..Default::default() })]).unwrap();
        let output = export_odt(&edited).unwrap();
        assert_eq!(open(&output).page_layout, edited.page_layout, "{kind}");
        assert_eq!(parts(&output)["content.xml"], original["content.xml"]);
    }
}
#[test]
fn adds_declared_geometry_to_a_minimal_package_without_styles_xml() {
    let bytes = export_odt(&create_odt("Minimal").unwrap()).unwrap();
    let entries: Vec<ZipEntry> = read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap().into_iter().filter(|e| e.name != "styles.xml").map(|e| {
        if e.name != "META-INF/manifest.xml" { return e; }
        let s = String::from_utf8(e.data).unwrap();
        let start = s.find(r#"<manifest:file-entry manifest:full-path="styles.xml""#).unwrap(); let end = start + s[start..].find("/>").unwrap() + 2;
        ZipEntry::new(e.name, format!("{}{}", &s[..start], &s[end..]))
    }).collect();
    let d = open(&write_zip(&entries, DEFAULT_ZIP_LIMITS).unwrap());
    let edited = apply_odt_operations(&d, &[layout_op(PageLayoutChange { paper: Some(Paper::Legal), margin_left_points: Some(0.0), ..Default::default() })]).unwrap();
    assert_eq!(reopen(&edited).page_layout, edited.page_layout);
}
#[test]
fn handles_arbitrary_namespace_prefixes_in_layout_and_master_definitions() {
    let styles = page_styles().replace("<style:", "<z:").replace("</style:", "</z:").replace(" style:", " z:").replace("xmlns:style=", "xmlns:z=");
    let d = open(&styled(styles));
    let edited = apply_odt_operations(&d, &[layout_op(PageLayoutChange { margin_left_points: Some(42.0), ..Default::default() })]).unwrap();
    assert_eq!(reopen(&edited).page_layout, edited.page_layout);
}
#[test]
fn rejects_unrepresented_page_features_rather_than_flattening_them() {
    let layout = layout_xml();
    let cases: Vec<(&str, String, String)> = vec![
        ("multiple masters", layout.clone(), format!("{MASTER}{}", MASTER.replace("Standard", "Other"))),
        ("multiple layouts", format!("{layout}{}", layout.replace("Paper", "Other")), MASTER.into()),
        ("missing master", layout.clone(), String::new()), ("missing layout", String::new(), MASTER.into()),
        ("missing reference", layout.clone(), MASTER.replace(r#"page-layout-name="Paper""#, r#"page-layout-name="Missing""#)),
        ("header", layout.clone(), MASTER.replace("/>", "><style:header/></style:master-page>")),
        ("footer", layout.clone(), MASTER.replace("/>", "><style:footer/></style:master-page>")),
        ("conditional next master", layout.clone(), MASTER.replace("/>", r#" style:next-style-name="Other"/>"#)),
        ("mirrored usage", layout.replace(r#"page-usage="all""#, r#"page-usage="mirrored""#), MASTER.into()),
        ("columns", layout.replacen("/>", "><style:columns/></style:page-layout-properties>", 1), MASTER.into()),
        ("background", layout.replace(r#"fo:margin="1in""#, r##"fo:background-color="#ffffff" fo:margin="1in""##), MASTER.into()),
        ("percentage width", layout.replace("21cm", "100%"), MASTER.into()),
        ("unknown orientation", layout.replace("portrait", "diagonal"), MASTER.into()),
        ("inconsistent orientation", layout.replace("portrait", "landscape"), MASTER.into()),
        ("too-large paper", layout.replace("21cm", "3000pt"), MASTER.into()),
        ("no text area", layout.replace(r#"fo:margin="1in""#, r#"fo:margin="10in""#), MASTER.into()),
        ("negative margins", layout.replace("36pt", "-1pt"), MASTER.into()),
    ];
    for (name, automatic, pages) in cases {
        assert!(err(&styled(page_styles_with(&automatic, &pages))).contains("page layout"), "{name}");
    }
}
#[test]
fn rejects_a_paragraph_switching_to_another_master() {
    assert!(err(&styled(page_styles().replace(r#"style:name="Body""#, r#"style:name="Body" style:master-page-name="Other""#))).contains("master-page switch"));
}
#[test]
fn rejects_page_layout_definitions_in_content_xml() {
    let content = ODT_FIXTURE_CONTENT.replace("<office:automatic-styles>", &format!("<office:automatic-styles>{}", layout_xml()));
    assert!(err(&odt_fixture(Opts { content: Some(content), styles: Some(page_styles()), ..Default::default() })).contains("page layout"));
}
#[test]
fn leaves_the_original_exact_when_a_mixed_batch_contains_invalid_geometry() {
    let bytes = styled(page_styles()); let d = open(&bytes);
    assert!(apply_odt_operations(&d, &[Operation::ReplaceParagraph { paragraph_id: d.paragraphs[0].id.clone(), text: "Must not persist".into() }, layout_op(PageLayoutChange { margin_top_points: Some(f64::INFINITY), ..Default::default() })]).is_err());
    assert_eq!(export_odt(&d).unwrap(), bytes); assert!(!d.modified);
}
#[test]
fn keeps_no_op_geometry_commands_and_a_reverted_layout_byte_neutral() {
    let bytes = styled(page_styles()); let d = open(&bytes);
    let noop = apply_odt_operations(&d, &[layout_op(PageLayoutChange { margin_left_points: Some(36.0), ..Default::default() })]).unwrap();
    assert_eq!(export_odt(&noop).unwrap(), bytes);
    let reverted = apply_odt_operations(&d, &[layout_op(PageLayoutChange { margin_left_points: Some(42.0), ..Default::default() }), layout_op(PageLayoutChange { margin_left_points: Some(36.0), ..Default::default() })]).unwrap();
    assert_eq!(export_odt(&reverted).unwrap(), bytes);
}
#[test]
fn does_not_rebase_text_defaults_or_rewrite_body_styles_during_layout_only_edits() {
    let styles = page_styles().replace("<office:styles>", r#"<office:styles><style:default-style style:family="text"><style:text-properties fo:font-style="italic"/></style:default-style>"#);
    let bytes = styled(styles); let d = open(&bytes); let before = parts(&bytes);
    let edited = apply_odt_operations(&d, &[layout_op(PageLayoutChange { paper: Some(Paper::Legal), ..Default::default() })]).unwrap();
    assert_eq!(edited.paragraphs, d.paragraphs);
    assert_eq!(parts(&export_odt(&edited).unwrap())["content.xml"], before["content.xml"]);
}
