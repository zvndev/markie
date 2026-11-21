//! Port of docx-real-world.test.ts: synthetic, invented-text fixtures shaped like
//! Word, Google Docs and generator exports.
#[path = "common/docx_fixture.rs"]
mod docx_fixture;
use docx_fixture::*;
use std::collections::BTreeMap;

const W14: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
const WP: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const MC: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";
fn root() -> String { format!(r#"xmlns:w="{W}" xmlns:r="{R}" xmlns:w14="{W14}" xmlns:wp="{WP}" xmlns:a="{A}" xmlns:pic="{PIC}" xmlns:mc="{MC}" mc:Ignorable="w14""#) }

#[derive(Default)]
struct Fx { parts: Vec<(String, Vec<u8>)>, rels: Vec<String>, package_rels: Vec<String>, main_bytes: Option<Box<dyn Fn(&str) -> Vec<u8>>> }
fn build(body: &str, o: Fx) -> Vec<u8> {
    let mut entries = read_zip(&export(&create_docx("Seed").unwrap()), DEFAULT_ZIP_LIMITS).unwrap();
    let xml = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {}><w:body>{body}</w:body></w:document>"#, root());
    entries.iter_mut().find(|e| e.name == "word/document.xml").unwrap().data = match &o.main_bytes { Some(f) => f(&xml), None => xml.into_bytes() };
    change_xml(&mut entries, "[Content_Types].xml", |x| x.replacen("<Default", r#"<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Default"#, 1));
    for (name, data) in o.parts { entries.push(ZipEntry::new(name, data)); }
    if !o.rels.is_empty() { entries.push(ZipEntry::new("word/_rels/document.xml.rels", format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{REL}">{}</Relationships>"#, o.rels.concat()))); }
    if !o.package_rels.is_empty() { change_xml(&mut entries, "_rels/.rels", |x| x.replace("</Relationships>", &format!("{}</Relationships>", o.package_rels.concat()))); }
    write_zip(&entries, DEFAULT_ZIP_LIMITS).unwrap()
}
fn plain(body: &str) -> Vec<u8> { build(body, Fx::default()) }
fn parts_map(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> { read_zip(bytes, DEFAULT_ZIP_LIMITS).unwrap().into_iter().map(|e| (e.name, e.data)).collect() }
fn expect_only_main_changed(before: &[u8], after: &[u8]) {
    let (a, b) = (parts_map(before), parts_map(after));
    assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>());
    for (name, data) in &a { if name != "word/document.xml" { assert_eq!(b.get(name), Some(data), "{name}"); } }
}
fn run_of<'a>(d: &'a DocxDocument, text: &str) -> &'a Run { d.paragraphs.iter().flat_map(|p| p.runs.iter()).find(|r| r.text == text).unwrap_or_else(|| panic!("No run {text}")) }
fn s(v: &str) -> String { v.into() }
fn rel(id: &str, kind: &str, target: &str) -> String { format!(r#"<Relationship Id="{id}" Type="{R}/{kind}" Target="{target}"/>"#) }
fn tags(xml: &str, prefix: &str) -> Vec<String> {
    let mut out = vec![]; let mut i = 0;
    while let Some(p) = xml[i..].find('<') {
        let at = i + p + 1; let rest = &xml[at..];
        if rest.starts_with(prefix) { let end = rest.find(|c: char| c == ' ' || c == '/' || c == '>').unwrap(); out.push(rest[..end].to_string()); }
        i = at;
    }
    out
}

const HEADER: &str = r#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Invented header</w:t></w:r></w:p></w:hdr>"#;
const FOOTER: &str = r#"<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>"#;
const SECTION: &str = r#"<w:sectPr w:rsidR="00AB12CD"><w:headerReference w:type="default" r:id="rIdH1"/><w:headerReference w:type="first" r:id="rIdH2"/><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:start="1"/><w:cols w:space="720"/><w:titlePg/><w:docGrid w:linePitch="360"/></w:sectPr>"#;

fn word_package(body: &str, header: &str) -> Vec<u8> {
    let p = |n: &str, d: &str| (n.to_string(), d.as_bytes().to_vec());
    build(&format!("{body}{SECTION}"), Fx {
        parts: vec![
            p("word/header1.xml", header), p("word/header2.xml", HEADER), p("word/footer1.xml", FOOTER),
            ("docProps/thumbnail.jpeg".into(), vec![0xff, 0xd8, 0xff, 0xd9]),
            p("customXml/item1.xml", r#"<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/>"#),
            p("customXml/itemProps1.xml", r#"<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{00000000-0000-0000-0000-000000000001}"/>"#),
            p("customXml/_rels/item1.xml.rels", &format!(r#"<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{R}/customXmlProps" Target="itemProps1.xml"/></Relationships>"#)),
            p("word/stylesWithEffects.xml", &format!(r#"<w:styles xmlns:w="{W}"/>"#)),
            p("word/fontTable.xml", &format!(r#"<w:fonts xmlns:w="{W}" xmlns:r="{R}"><w:font w:name="Invented Sans"><w:embedRegular r:id="rIdFont1" w:fontKey="{{00000000-0000-0000-0000-000000000002}}"/></w:font></w:fonts>"#)),
            p("word/_rels/fontTable.xml.rels", &format!(r#"<Relationships xmlns="{REL}"><Relationship Id="rIdFont1" Type="{R}/font" Target="fonts/font1.odttf"/></Relationships>"#)),
            ("word/fonts/font1.odttf".into(), vec![1, 2, 3, 4]),
            p("word/webextensions/taskpanes.xml", r#"<wetp:taskpanes xmlns:wetp="http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11"/>"#),
            p("word/webextensions/_rels/taskpanes.xml.rels", &format!(r#"<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/webextension" Target="webextension1.xml"/></Relationships>"#)),
            p("word/webextensions/webextension1.xml", r#"<we:webextension xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" id="{00000000-0000-0000-0000-000000000003}"/>"#),
            p("word/people.xml", r#"<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"/>"#),
            p("word/commentsExtended.xml", r#"<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"/>"#),
        ],
        rels: vec![
            rel("rIdH1", "header", "header1.xml"), rel("rIdH2", "header", "header2.xml"), rel("rIdF1", "footer", "footer1.xml"), rel("rIdCx", "customXml", "../customXml/item1.xml"),
            r#"<Relationship Id="rIdSwe" Type="http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects" Target="stylesWithEffects.xml"/>"#.into(),
            rel("rIdFonts", "fontTable", "fontTable.xml"),
            r#"<Relationship Id="rIdPeople" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>"#.into(),
            r#"<Relationship Id="rIdCex" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>"#.into(),
            format!(r#"<Relationship Id="rIdUnused" Type="{R}/hyperlink" Target="https://example.invalid/unused" TargetMode="External"/>"#),
            format!(r#"<Relationship Id="rIdBare" Type="{R}/hyperlink" Target="www.example.invalid" TargetMode="External"/>"#),
        ],
        package_rels: vec![
            format!(r#"<Relationship Id="rIdThumb" Type="{REL}/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>"#),
            r#"<Relationship Id="rIdPanes" Type="http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes" Target="word/webextensions/taskpanes.xml"/>"#.into(),
        ],
        ..Default::default()
    })
}

#[test]
fn opens_a_full_word_package_editable_and_changes_only_the_edited_text() {
    let bytes = word_package("<w:p><w:r><w:t>Alpha bravo</w:t></w:r></w:p>", HEADER);
    let d = open(&bytes);
    assert!(d.diagnostics.iter().all(|x| x.severity != Severity::Warning), "{:?}", d.diagnostics);
    assert!(d.diagnostics.iter().any(|x| x.code == "unrendered-header-footer" && x.severity == Severity::Info));
    assert!(d.can_edit); assert_eq!(export(&d), bytes);
    let output = export(&replace(&d, &run_of(&d, "Alpha bravo").id, "Alpha charlie"));
    expect_only_main_changed(&bytes, &output);
    assert_eq!(document_xml(&output), document_xml(&bytes).replace("<w:t>Alpha bravo</w:t>", r#"<w:t xml:space="preserve">Alpha charlie</w:t>"#));
    assert!(open(&output).can_edit);
}
#[test]
fn keeps_header_and_footer_references_in_order_when_page_layout_changes() {
    let d = open(&word_package("<w:p><w:r><w:t>Body</w:t></w:r></w:p>", HEADER));
    let output = export(&apply(&d, &[Operation::SetPageLayout { layout: PageLayoutChange { orientation: Some(Orientation::Landscape), ..Default::default() } }]));
    let xml = document_xml(&output);
    let section = &xml[xml.find("<w:sectPr").unwrap()..xml.rfind("</w:sectPr>").unwrap() + 11];
    assert_eq!(tags(section, "w:"), vec!["w:sectPr", "w:headerReference", "w:headerReference", "w:footerReference", "w:pgSz", "w:pgMar", "w:pgNumType", "w:cols", "w:titlePg", "w:docGrid"]);
    assert!(section.contains(r#"w:type="first" r:id="rIdH2""#));
    assert_eq!(open(&output).page_layout.orientation, Orientation::Landscape);
}
#[test]
fn keeps_a_header_with_pending_tracked_changes_read_only() {
    let tracked = format!(r#"<w:hdr xmlns:w="{W}"><w:p><w:ins w:id="9" w:author="Reviewer" w:date="2024-01-01T00:00:00Z"><w:r><w:t>Added</w:t></w:r></w:ins></w:p></w:hdr>"#);
    let bytes = word_package("<w:p><w:r><w:t>Body</w:t></w:r></w:p>", &tracked);
    let d = open(&bytes);
    assert!(!d.can_edit);
    assert!(d.diagnostics.iter().any(|x| x.code == "unsupported-revisions" && x.part.as_deref() == Some("word/header1.xml")));
    assert_eq!(export(&d), bytes);
}
#[test]
fn keeps_script_data_and_file_destinations_read_only_even_unreferenced() {
    for target in ["javascript:alert(1)", "file:///C:/invented/run.exe", "../../invented/local.docx", "\\\\server\\share\\x.doc"] {
        let d = open(&build("<w:p><w:r><w:t>Body</w:t></w:r></w:p>", Fx { rels: vec![format!(r#"<Relationship Id="rIdX" Type="{R}/hyperlink" Target="{}" TargetMode="External"/>"#, target.replace('&', "&amp;"))], ..Default::default() }));
        assert!(!d.can_edit, "{target}"); assert!(d.diagnostics.iter().any(|x| x.code == "external-relationship"));
    }
}

const P_PR: &str = r#"<w:pPr><w:pStyle w:val="Normal"/><w:keepNext/><w:widowControl w:val="0"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:spacing w:after="120"/><w:contextualSpacing/><w:outlineLvl w:val="1"/><w:rPr><w:b/><w:lang w:val="en-GB"/></w:rPr></w:pPr>"#;
const R_PR: &str = r#"<w:rPr><w:rFonts w:ascii="Invented Serif" w:hAnsi="Invented Serif"/><w:caps/><w:color w:val="1F3864"/><w:kern w:val="2"/><w:highlight w:val="yellow"/><w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/><w:vertAlign w:val="superscript"/><w:lang w:val="en-US"/><w14:ligatures w14:val="standardContextual"/></w:rPr>"#;
fn opaque_paragraph() -> String { format!(r#"<w:p w:rsidR="00112233" w:rsidRDefault="00112233" w:rsidP="00445566" w14:paraId="1A2B3C4D" w14:textId="5E6F7A8B">{P_PR}<w:r w:rsidRPr="00778899">{R_PR}<w:t>Opaque formatting</w:t></w:r></w:p>"#) }

#[test]
fn edits_text_inside_unmodeled_ppr_and_rpr_without_touching_either() {
    let bytes = plain(&format!("{}<w:p><w:r><w:t>Second</w:t></w:r></w:p>", opaque_paragraph()));
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics);
    let output = export(&replace(&d, &run_of(&d, "Opaque formatting").id, "Still opaque"));
    let xml = document_xml(&output);
    assert!(xml.contains(P_PR) && xml.contains(R_PR));
    expect_only_main_changed(&bytes, &output);
}
#[test]
fn inserts_modeled_run_properties_at_their_schema_position() {
    let d = open(&plain(&opaque_paragraph()));
    let output = export(&apply(&d, &[Operation::FormatRun { run_id: run_of(&d, "Opaque formatting").id.clone(), style: fmt(|f| { f.bold = Some(Some(true)); f.underline = Some(Some("single".into())); f.font_size_points = Some(Some(11.0)); }) }]));
    let xml = document_xml(&output);
    let start = xml.find(r#"<w:r w:rsidRPr="00778899"><w:rPr>"#).unwrap() + r#"<w:r w:rsidRPr="00778899"><w:rPr>"#.len();
    let rpr = &xml[start..start + xml[start..].find("</w:rPr>").unwrap()];
    let names: Vec<String> = tags(rpr, "w").into_iter().collect();
    assert_eq!(names, vec!["w:rFonts", "w:b", "w:caps", "w:color", "w:kern", "w:sz", "w:highlight", "w:u", "w:shd", "w:vertAlign", "w:lang", "w14:ligatures"]);
    let st = open(&output).paragraphs[0].runs[0].style.clone();
    assert_eq!((st.bold, st.underline.as_deref(), st.font_size_points), (Some(true), Some("single"), Some(11.0)));
}
#[test]
fn inserts_alignment_and_numbering_at_schema_positions() {
    let numbering = format!(r#"<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#);
    let d = open(&build(&opaque_paragraph(), Fx { parts: vec![("word/numbering.xml".into(), numbering.into_bytes())], rels: vec![rel("rIdN", "numbering", "numbering.xml")], ..Default::default() }));
    let changed = apply(&d, &[Operation::FormatParagraph { paragraph_id: d.paragraphs[0].id.clone(), format: ParagraphFormat { alignment: Some(Some("center".into())), ..Default::default() } }, Operation::SetList { paragraph_id: d.paragraphs[0].id.clone(), kind: Some(ListKind::Bullet) }]);
    let xml = document_xml(&export(&changed));
    let start = xml.find("<w:pPr>").unwrap() + 7;
    let ppr = &xml[start..start + xml[start..].find("</w:pPr>").unwrap()];
    let names: Vec<String> = tags(ppr, "w:").into_iter().filter(|n| !["w:bottom", "w:tab", "w:b", "w:lang", "w:ilvl", "w:numId"].contains(&n.as_str())).collect();
    assert_eq!(names, vec!["w:pStyle", "w:keepNext", "w:widowControl", "w:numPr", "w:pBdr", "w:shd", "w:tabs", "w:spacing", "w:contextualSpacing", "w:jc", "w:outlineLvl", "w:rPr"]);
    let r = reopen(&changed);
    assert_eq!((r.paragraphs[0].alignment.as_deref(), r.paragraphs[0].list_kind), (Some("center"), Some(ListKind::Bullet)));
}
#[test]
fn splits_copying_opaque_properties_and_joins_only_identical_ppr() {
    let d = open(&plain(&format!("{}<w:p><w:r><w:t>Plain</w:t></w:r></w:p>", opaque_paragraph())));
    let pos = |d: &DocxDocument, p: usize, o: usize| TextPosition { paragraph_id: d.paragraphs[p].id.clone(), offset: o };
    let split = replace_docx_range(&d, &TextRange { anchor: pos(&d, 0, 6), focus: pos(&d, 0, 6) }, "\n").unwrap().document;
    let xml = document_xml(&export(&split));
    assert_eq!(xml.matches(P_PR).count(), 2); assert_eq!(xml.matches(R_PR).count(), 2); assert_eq!(xml.matches("w14:paraId").count(), 1);
    assert_eq!(split.text, "Opaque\n formatting\nPlain");
    let rejoined = replace_docx_range(&split, &TextRange { anchor: pos(&split, 0, 6), focus: pos(&split, 1, 0) }, "").unwrap().document;
    assert_eq!(rejoined.text, "Opaque formatting\nPlain");
    assert!(replace_docx_range(&rejoined, &TextRange { anchor: pos(&rejoined, 0, 17), focus: pos(&rejoined, 1, 0) }, "").unwrap_err().message.contains("different paragraph properties"));
}
#[test]
fn opens_word_and_google_table_shapes_editable_and_verbatim() {
    let cell = |text: &str, props: &str| format!(r#"<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>{props}<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/><w:tcMar><w:top w:w="100" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:tc>"#);
    let tbl_pr = r#"<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="6000" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>"#;
    let table = format!(r#"<w:tbl>{tbl_pr}<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:tblGridChange w:id="0"><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid></w:tblGridChange></w:tblGrid><w:tr w:rsidR="00AA0000" w14:paraId="0A0B0C0D" w14:textId="77777777"><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>{}{}</w:tr><w:tr><w:tblPrEx><w:tblCellMar><w:left w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx>{}{}{}</w:tr><w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>{}{}</w:tr></w:tbl>"#,
        cell("Head A", r#"<w:gridSpan w:val="2"/>"#), cell("Head B", ""), cell("One", r#"<w:vMerge w:val="restart"/>"#), cell("Two", ""), cell("Three", ""), cell("Four", ""), cell("Five", ""));
    let empty_grid = format!(r#"<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid/><w:tr>{}{}</w:tr><w:tr>{}</w:tr></w:tbl>"#, cell("X", ""), cell("Y", ""), cell("Z", r#"<w:gridSpan w:val="2"/>"#));
    let bytes = plain(&format!("<w:p><w:r><w:t>Before</w:t></w:r></w:p>{table}{empty_grid}<w:p/>"));
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics);
    assert_eq!(d.tables.iter().map(|t| t.rows.iter().map(|r| r.cells.len()).collect::<Vec<_>>()).collect::<Vec<_>>(), vec![vec![2, 3, 2], vec![2, 1]]);
    let output = export(&replace(&d, &run_of(&d, "Two").id, "Deux"));
    assert_eq!(document_xml(&output), document_xml(&bytes).replace("<w:t>Two</w:t>", r#"<w:t xml:space="preserve">Deux</w:t>"#));
}
#[test]
fn still_keeps_unsupported_shapes_read_only_and_byte_identical() {
    for markup in [
        r#"<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:pPr/></w:pPrChange></w:pPr><w:r><w:t>A</w:t></w:r></w:p>"#,
        r#"<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>A</w:t></w:r></w:p>"#,
        r#"<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r></w:p>"#,
        "<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r></w:p>",
        r#"<w:p><w:r><w:rPr><w:b/><w:b w:val="0"/></w:rPr><w:t>A</w:t></w:r></w:p>"#,
        "<w:p><w:pPr>hidden</w:pPr><w:r><w:t>A</w:t></w:r></w:p>",
        "<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr></w:tbl><w:p/>",
        r#"<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl><w:p/>"#,
        r#"<w:sdt><w:sdtPr><w:alias w:val="X"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>A</w:t></w:r></w:p></w:sdtContent></w:sdt><w:p/>"#,
        r#"<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>A</w:t></w:r></w:p>"#,
        r#"<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Check1"/></w:ffData></w:fldChar></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>"#,
        r#"<w:bookmarkStart w:id="4" w:name="_orphan"/><w:p><w:r><w:t>A</w:t></w:r></w:p>"#,
    ] {
        let bytes = plain(markup); let d = open(&bytes);
        assert!(!d.can_edit, "{markup}"); assert_eq!(export(&d), bytes);
    }
}
#[test]
fn keeps_tab_and_line_break_runs_read_only_while_neighbours_stay_editable() {
    let d = open(&plain("<w:p><w:r><w:t>Name</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Value</w:t></w:r></w:p><w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p>"));
    assert!(d.can_edit); assert_eq!(d.text, "Name\tValue\nLine one\nLine two");
    assert_eq!(d.paragraphs[0].runs.iter().map(|r| r.can_edit).collect::<Vec<_>>(), vec![true, false, true]);
    assert!(!d.paragraphs[1].runs[0].can_edit);
    let pid = d.paragraphs[0].id.clone();
    let bold = fmt(|f| f.bold = Some(Some(true)));
    let formatted = apply(&d, &[Operation::FormatRange { paragraph_id: pid.clone(), start: 5, end: 10, style: bold.clone() }]);
    assert_eq!(formatted.paragraphs[0].runs.iter().find(|r| r.text == "Value").unwrap().style.bold, Some(true));
    assert!(apply_err(&d, &[Operation::FormatRange { paragraph_id: pid.clone(), start: 3, end: 6, style: bold }]).contains("mixed"));
    let linked = apply(&d, &[Operation::SetHyperlink { paragraph_id: pid.clone(), start: 5, end: 10, target: "https://example.invalid/".into() }]);
    assert_eq!(linked.hyperlinks[0].text, "Value");
    assert!(apply_err(&d, &[Operation::DeleteParagraph { paragraph_id: pid }]).contains("tabs"));
}
#[test]
fn treats_a_multi_paragraph_toc_field_as_read_only_runs() {
    let field = r#"<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:hyperlink w:anchor="_Toc1" w:history="1"><w:r><w:t>Intro</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink w:anchor="_Toc2" w:history="1"><w:r><w:t>Scope</w:t></w:r></w:hyperlink><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>"#;
    let bytes = plain(&format!(r#"{field}<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Intro</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p><w:p><w:bookmarkStart w:id="1" w:name="_Toc2"/><w:r><w:t>Scope</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>"#));
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics); assert!(d.hyperlinks.is_empty());
    assert!(d.paragraphs[..2].iter().flat_map(|p| p.runs.iter()).all(|r| !r.can_edit));
    assert!(d.paragraphs[2].runs[0].can_edit);
    let at = |i: usize, o: usize| TextRange { anchor: TextPosition { paragraph_id: d.paragraphs[i].id.clone(), offset: o }, focus: TextPosition { paragraph_id: d.paragraphs[i].id.clone(), offset: o } };
    assert!(replace_docx_range(&d, &at(1, 2), "\n").unwrap_err().message.contains("field"));
    assert!(apply_err(&d, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After(d.paragraphs[0].id.clone()), text: "x".into() }]).contains("field"));
    assert!(apply_err(&d, &[Operation::DeleteParagraph { paragraph_id: d.paragraphs[1].id.clone() }]).contains("fields"));
    assert!(document_xml(&export(&replace(&d, &d.paragraphs[2].runs[0].id, "Introduction"))).contains(field));
}
#[test]
fn keeps_internal_anchor_and_bare_address_hyperlinks_as_opaque_containers() {
    let bytes = build(r#"<w:p><w:hyperlink w:anchor="_Top"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>Back to top</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink r:id="rIdBare"><w:r><w:t>example site</w:t></w:r></w:hyperlink></w:p><w:p><w:bookmarkStart w:id="0" w:name="_Top"/><w:bookmarkEnd w:id="0"/></w:p>"#,
        Fx { rels: vec![format!(r#"<Relationship Id="rIdBare" Type="{R}/hyperlink" Target="www.example.invalid" TargetMode="External"/>"#)], ..Default::default() });
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics); assert!(d.hyperlinks.is_empty());
    assert!(d.paragraphs.iter().flat_map(|p| p.runs.iter()).all(|r| r.target.is_none()));
    let output = export(&replace(&d, &run_of(&d, "Back to top").id, "Top"));
    assert!(document_xml(&output).contains(r#"<w:hyperlink w:anchor="_Top"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">Top</w:t></w:r></w:hyperlink>"#));
    expect_only_main_changed(&bytes, &output);
}
#[test]
fn preserves_body_level_bookmarks_between_paragraphs() {
    let d = open(&plain(r#"<w:bookmarkStart w:id="0" w:name="_gjdgxs"/><w:p><w:r><w:t>Kept</w:t></w:r></w:p><w:bookmarkEnd w:id="0"/><w:p><w:r><w:t>Next</w:t></w:r></w:p>"#));
    assert!(d.can_edit); assert_eq!(d.blocks.len(), 2);
    assert!(document_xml(&export(&replace(&d, &run_of(&d, "Next").id, "Changed"))).contains(r#"<w:bookmarkStart w:id="0" w:name="_gjdgxs"/><w:p><w:r><w:t>Kept</w:t></w:r></w:p><w:bookmarkEnd w:id="0"/>"#));
}
#[test]
fn accepts_cropped_outlined_pictures_with_repeated_ids_and_deletes_one() {
    let picture = |id: &str, rid: &str| format!(r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" wp14:anchorId="0A1B2C3D" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"><wp:extent cx="914400" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Picture" descr="Invented picture" title=""/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="{PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image.png"/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}" cstate="print"/><a:srcRect l="10" t="0" r="10" b="0"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="9525"><a:noFill/><a:headEnd/><a:tailEnd/></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#);
    let images = || vec![("word/media/image1.png".to_string(), png(1, 1)), ("word/media/image2.png".to_string(), png(1, 1))];
    let bytes = build(&format!("<w:p>{}</w:p><w:p>{}</w:p><w:p><w:r><w:t>Caption</w:t></w:r></w:p>", picture("1", "rIdImg1"), picture("1", "rIdImg2")),
        Fx { parts: images(), rels: vec![rel("rIdImg1", "image", "media/image1.png"), rel("rIdImg2", "image", "media/image2.png")], ..Default::default() });
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics);
    assert_eq!(d.images.iter().map(|i| (i.id.clone(), i.content_type)).collect::<Vec<_>>(), vec![(s("1"), ImageType::Png), (s("1~2"), ImageType::Png)]);
    assert_eq!(get_docx_image_bytes(&d, "1~2").unwrap(), png(1, 1));
    let deleted = apply(&d, &[Operation::DeleteImage { image_id: "1~2".into() }]);
    assert_eq!(reopen(&deleted).images.len(), 1);
    assert!(!parts_map(&export(&deleted)).contains_key("word/media/image2.png"));
    let linked = build(&format!("<w:p>{}</w:p>", picture("1", "rIdImg1").replace(r#"r:embed="rIdImg1""#, r#"r:link="rIdImg1""#)),
        Fx { parts: vec![("word/media/image1.png".into(), png(1, 1))], rels: vec![rel("rIdImg1", "image", "media/image1.png")], ..Default::default() });
    assert!(!open(&linked).can_edit);
}
#[test]
fn opens_a_utf16le_custom_xml_item_and_keeps_it_byte_identical() {
    let item = encode_docx_xml(r#"<?xml version="1.0" encoding="utf-16"?><invented xmlns="urn:invented:meta"><v>é</v></invented>"#, XmlEncoding::Utf16Le);
    let bytes = build("<w:p><w:r><w:t>Body</w:t></w:r></w:p>", Fx { parts: vec![("customXml/item1.xml".into(), item)], rels: vec![rel("rIdCx", "customXml", "../customXml/item1.xml")], ..Default::default() });
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics);
    expect_only_main_changed(&bytes, &export(&replace(&d, &run_of(&d, "Body").id, "Edited")));
}
#[test]
fn re_encodes_an_edited_main_part_in_its_original_encoding() {
    for encoding in [XmlEncoding::Utf16Le, XmlEncoding::Utf16Be, XmlEncoding::Utf8Bom] {
        let bytes = build("<w:p><w:r><w:t>Body</w:t></w:r></w:p>", Fx { main_bytes: Some(Box::new(move |xml| encode_docx_xml(&if encoding == XmlEncoding::Utf8Bom { xml.to_string() } else { xml.replace(r#"encoding="UTF-8""#, r#"encoding="UTF-16""#) }, encoding))), ..Default::default() });
        let d = open(&bytes);
        assert!(d.can_edit, "{encoding:?} {:?}", d.diagnostics); assert_eq!(export(&d), bytes);
        let output = export(&replace(&d, &run_of(&d, "Body").id, "Zoë"));
        assert_eq!(decode_docx_xml(&parts_map(&output)["word/document.xml"]).unwrap().1, encoding);
        assert_eq!(open(&output).text, "Zoë");
    }
}
#[test]
fn rejects_xml_whose_declaration_contradicts_its_bytes() {
    assert!(decode_docx_xml(br#"<?xml version="1.0" encoding="UTF-16"?><p/>"#).unwrap_err().message.contains("does not match"));
    assert!(decode_docx_xml(&encode_docx_xml(r#"<?xml version="1.0" encoding="UTF-8"?><p/>"#, XmlEncoding::Utf16Le)).unwrap_err().message.contains("does not match"));
    let bytes = build("<w:p/>", Fx { parts: vec![("customXml/item1.xml".into(), br#"<?xml version="1.0" encoding="UTF-16"?><x/>"#.to_vec())], rels: vec![rel("rIdCx", "customXml", "../customXml/item1.xml")], ..Default::default() });
    assert!(open_err(&bytes).contains("does not match"));
}
