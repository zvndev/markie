//! Port of docx-generator-subset.test.ts.
#[path = "common/docx_fixture.rs"]
mod docx_fixture;
use docx_fixture::*;

const VML: &str = "urn:schemas-microsoft-com:vml";
const OFFICE: &str = "urn:schemas-microsoft-com:office:office";
const W14: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
fn numbering() -> String { format!(r#"<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="3"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num></w:numbering>"#) }
fn separator_footnotes() -> String { format!(r#"<w:footnotes xmlns:w="{W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote></w:footnotes>"#) }
fn separator_endnotes() -> String { format!(r#"<w:endnotes xmlns:w="{W}"><w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote></w:endnotes>"#) }
fn real_footnotes() -> String { format!(r#"<w:footnotes xmlns:w="{W}"><w:footnote w:id="1"><w:p><w:r><w:t>A real note</w:t></w:r></w:p></w:footnote></w:footnotes>"#) }
const HR_PICT: &str = r#"<w:pict w14:anchorId="1234ABCD"><v:rect o:hr="t" o:hralign="center" o:hrstd="t" style="width:100%"/></w:pict>"#;

fn generated(body_markup: &str, with_numbering: bool, notes: Option<&str>) -> Vec<u8> {
    let mut entries = read_zip(&export(&create_docx("Seed").unwrap()), DEFAULT_ZIP_LIMITS).unwrap();
    change_xml(&mut entries, "word/document.xml", |_| format!(r#"<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:v="{VML}" xmlns:o="{OFFICE}" xmlns:w14="{W14}"><w:body>{body_markup}</w:body></w:document>"#));
    let mut rels = String::new();
    if with_numbering {
        entries.push(ZipEntry::new("word/numbering.xml", numbering()));
        rels.push_str(&format!(r#"<Relationship Id="rId7" Type="{R}/numbering" Target="numbering.xml"/>"#));
    }
    if let Some(kind) = notes {
        entries.push(ZipEntry::new("word/footnotes.xml", if kind == "real" { real_footnotes() } else { separator_footnotes() }));
        entries.push(ZipEntry::new("word/endnotes.xml", separator_endnotes()));
        rels.push_str(&format!(r#"<Relationship Id="rId8" Type="{R}/footnotes" Target="footnotes.xml"/><Relationship Id="rId9" Type="{R}/endnotes" Target="endnotes.xml"/>"#));
    }
    if !rels.is_empty() { entries.push(ZipEntry::new("word/_rels/document.xml.rels", format!(r#"<Relationships xmlns="{REL}">{rels}</Relationships>"#))); }
    write_zip(&entries, DEFAULT_ZIP_LIMITS).unwrap()
}
fn item(level: u32, text: &str) -> String { format!(r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>"#) }

#[test]
fn treats_paired_bookmarks_and_noproof_as_inert() {
    let bytes = generated(r#"<w:p><w:bookmarkStart w:id="1" w:name="heading"/><w:r><w:rPr><w:noProof/></w:rPr><w:t>Hello</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p>"#, false, None);
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics);
    let output = export(&replace(&d, &d.paragraphs[0].runs[0].id, "Changed"));
    let xml = document_xml(&output);
    assert!(xml.contains(r#"<w:bookmarkStart w:id="1" w:name="heading"/>"#) && xml.contains("<w:noProof/>"));
    assert_eq!(open(&output).text, "Changed\nWorld");
}
#[test]
fn accepts_separator_only_note_parts_and_preserves_them() {
    let d = open(&generated("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>", false, Some("separator")));
    assert!(d.can_edit, "{:?}", d.diagnostics);
    let output = export(&replace(&d, &d.paragraphs[0].runs[0].id, "Edited"));
    assert_eq!(part(&output, "word/footnotes.xml").unwrap(), separator_footnotes());
    assert_eq!(part(&output, "word/endnotes.xml").unwrap(), separator_endnotes());
}
#[test]
fn keeps_real_footnote_content_read_only() {
    let bytes = generated("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>", false, Some("real"));
    let d = open(&bytes);
    assert!(!d.can_edit); assert_eq!(export(&d), bytes);
}
#[test]
fn preserves_a_vml_horizontal_rule_as_an_opaque_run() {
    let d = open(&generated(&format!("<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:p><w:r><w:rPr><w:noProof/></w:rPr>{HR_PICT}</w:r></w:p><w:p><w:r><w:t>After</w:t></w:r></w:p>"), false, None));
    assert!(d.can_edit, "{:?}", d.diagnostics); assert_eq!(d.paragraphs[1].text, "");
    let edited = replace(&d, &d.paragraphs[0].runs[0].id, "Changed");
    assert!(document_xml(&export(&edited)).contains(HR_PICT));
    assert!(reopen(&edited).can_edit);
}
#[test]
fn keeps_non_rule_vml_pictures_read_only() {
    let bytes = generated(r#"<w:p><w:r><w:pict><v:rect style="width:100pt;height:50pt"/></w:pict></w:r></w:p>"#, false, None);
    let d = open(&bytes);
    assert!(!d.can_edit); assert!(d.diagnostics.iter().any(|x| x.code == "unsupported-markup")); assert_eq!(export(&d), bytes);
}
#[test]
fn supports_multi_level_numbering_with_restarting_counters() {
    let d = open(&generated(&[item(0, "A"), item(1, "A1"), item(1, "A2"), item(0, "B"), item(1, "B1")].concat(), true, None));
    assert!(d.can_edit, "{:?}", d.diagnostics);
    let n = Some(ListKind::Numbered);
    assert_eq!(d.paragraphs.iter().map(|p| (p.list_kind, p.list_level, p.list_number)).collect::<Vec<_>>(), vec![(n, Some(0), Some(1)), (n, Some(1), Some(1)), (n, Some(1), Some(2)), (n, Some(0), Some(2)), (n, Some(1), Some(1))]);
    let r = reopen(&replace(&d, &d.paragraphs[1].runs[0].id, "A-one"));
    assert!(r.can_edit); assert_eq!(r.text, "A\nA-one\nA2\nB\nB1");
}
#[test]
fn fails_closed_for_a_missing_numbering_level() {
    let bytes = generated(&[item(0, "A"), item(2, "Too deep")].concat(), true, None);
    let d = open(&bytes);
    assert!(!d.can_edit); assert!(d.diagnostics.iter().any(|x| x.code == "unsupported-numbering")); assert_eq!(export(&d), bytes);
}
#[test]
fn opens_a_combined_generator_shaped_document_as_editable() {
    let body = format!(r#"<w:p><w:bookmarkStart w:id="1" w:name="title"/><w:r><w:t>Title</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p><w:p><w:r>{HR_PICT}</w:r></w:p>{}{}"#, item(0, "One"), item(1, "Sub"));
    let d = open(&generated(&body, true, Some("separator")));
    assert!(d.can_edit, "{:?}", d.diagnostics);
    let cleared = apply(&d, &[Operation::SetList { paragraph_id: d.paragraphs[2].id.clone(), kind: None }]);
    assert_eq!(reopen(&cleared).paragraphs[2].list_kind, None);
}
