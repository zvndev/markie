//! Port of src/lib/office/rtf.test.ts.
use markie_office::model::*;
use markie_office::rtf::*;

fn open(body: &str) -> RtfDocument { open_rtf(format!("{{\\rtf1\\ansi {body}}}").as_bytes()).unwrap() }
fn basic() -> Vec<u8> {
    br"{\rtf1\ansi\ansicpg1252\deff0\uc1{\fonttbl{\f0\fnil Georgia;}{\f1\fnil Arial;}}{\colortbl;\red51\green102\blue153;}{\*\generator Markie original RTF fixture;}\pard\qc\sb120\sa240\f0\fs32\b\cf1 Rich text in Markie\par\pard\ql\f1\fs22\b0\cf0 Plain, {\i italic}, {\ul underline}, Unicode \u233? and \u-10179?\u-8704?.}".to_vec()
}
fn cell_texts(d: &RtfDocument, index: usize) -> Vec<Vec<String>> {
    d.tables[index].rows.iter().map(|row| row.cells.iter().map(|cell| cell.paragraph_ids.iter().map(|id| d.paragraph(id).unwrap().text.clone()).collect::<Vec<_>>().join("\n")).collect()).collect()
}
fn kinds(d: &RtfDocument) -> Vec<&'static str> { d.blocks.iter().map(|b| match b { Block::Paragraph(_) => "paragraph", Block::Table(_) => "table" }).collect() }
fn replace(id: &str, text: &str) -> Operation { Operation::ReplaceParagraph { paragraph_id: id.into(), text: text.into() } }
fn edit(id: &str, text: &str) -> Vec<TextEdit> { vec![TextEdit { run_id: id.into(), text: text.into() }] }
fn reopen(d: &RtfDocument) -> RtfDocument { open_rtf(&export_rtf(d).unwrap()).unwrap() }
fn s(v: &[[&str; 2]]) -> Vec<Vec<String>> { v.iter().map(|r| r.iter().map(|x| x.to_string()).collect()).collect() }

#[test]
fn reads_a_real_textedit_table_into_rows_and_cells_read_only() {
    let source = include_bytes!("fixtures/textedit-report.rtf").to_vec();
    let d = open_rtf(&source).unwrap();
    assert_eq!(cell_texts(&d, 0), s(&[["Name", "Qty"], ["Apples", "3"], ["Pears", "5"]]));
    let k = kinds(&d);
    assert_eq!(k.iter().filter(|x| **x == "table").count(), 1);
    let t = k.iter().position(|x| *x == "table").unwrap();
    let Block::Paragraph(before) = &d.blocks[t - 1] else { panic!() };
    let Block::Paragraph(after) = &d.blocks[t + 1] else { panic!() };
    assert!(d.paragraph(before).unwrap().text.contains("Second item"));
    assert_eq!(d.paragraph(after).unwrap().text, "After the table.");
    let name = d.paragraphs.iter().find(|p| p.text == "Name").unwrap();
    assert_eq!(name.runs[0].style.bold, Some(true));
    assert_eq!(name.alignment.as_deref(), Some("center"));
    assert!(d.text.contains("Name\nQty\nApples\n3\nPears\n5\nAfter the table."));
    assert!(!d.can_edit);
    assert!(d.diagnostics[0].message.contains("table"));
    for w in ["trowd", "cellx", "clvertalc", "clwWidth", "brdrs"] { assert!(!d.diagnostics[0].message.contains(w), "{w}"); }
    assert_eq!(export_rtf(&d).unwrap(), source);
    assert!(apply_rtf_operations(&d, &[replace(&d.paragraphs[0].id, "x")]).unwrap_err().message.contains("read-only"));
}
#[test]
fn keeps_multi_paragraph_empty_and_unterminated_cells() {
    let d = open(r"Intro\par\trowd\cellx1000\cellx2000\pard\intbl One\par Two\cell\cell\row\trowd\cellx1000\pard\intbl Tail\cell Extra\row\pard Outro\par\trowd\cellx1000\pard\intbl Second\cell\row");
    assert_eq!(kinds(&d), vec!["paragraph", "table", "paragraph", "table"]);
    assert_eq!(cell_texts(&d, 0), s(&[["One\nTwo", ""], ["Tail", "Extra"]]));
    assert_eq!(cell_texts(&d, 1), vec![vec!["Second".to_string()]]);
    assert_eq!(d.paragraphs.iter().filter(|p| p.text == "Outro").count(), 1);
    assert!(!d.can_edit);
}
#[test]
fn flattens_nested_tables_into_the_outer_cell() {
    let d = open(r"\trowd\cellx4000\pard\intbl Outer\par\itap2 Inner A\nestcell Inner B\nestcell{\*\nesttableprops\trowd\cellx2000\cellx4000\nestrow}{\nonesttables\par}\itap1 After\cell\row");
    assert_eq!(cell_texts(&d, 0), vec![vec!["Outer\nInner A\nInner B\nAfter".to_string()]]);
    assert!(d.diagnostics[0].message.contains("nested-table"));
}
#[test]
fn projects_basic_rich_formatting_scoped_state_unicode_and_paragraphs() {
    let d = open_rtf(&basic()).unwrap();
    assert_eq!(d.format, Format::Rtf); assert!(d.can_edit, "{:?}", d.diagnostics);
    assert_eq!(d.paragraphs.len(), 2);
    let p0 = &d.paragraphs[0];
    assert_eq!((p0.alignment.as_deref(), p0.spacing_before_points, p0.spacing_after_points), (Some("center"), Some(6.0), Some(12.0)));
    let st = &p0.runs[0].style;
    assert_eq!((st.font_family.as_deref(), st.font_size_points, st.bold, st.color.as_deref()), (Some("Georgia"), Some(16.0), Some(true), Some("336699")));
    assert!(d.text.contains("Unicode é and 😀."));
    assert_eq!(d.paragraphs[1].runs.iter().find(|r| r.text == "italic").unwrap().style.italic, Some(true));
    assert_eq!(d.paragraphs[1].runs.last().unwrap().style.italic, None);
}
#[test]
fn opens_textedit_flavored_rtf_as_editable() {
    let source = b"{\\rtf1\\ansi\\ansicpg1252\\cocoartf2867\n\\cocoatextscaling0\\cocoaplatform0{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}}\n{\\colortbl;\\red255\\green255\\blue255;}\n{\\*\\expandedcolortbl;;}\n\\paperw11900\\paperh16840\\margl1440\\margr1440\\vieww11520\\viewh8400\\viewkind0\\viewscale100\\deftab720\n\\pard\\tx720\\tx1440\\pardirnatural\\partightenfactor0\n\\f0\\fs24 \\cf0 First paragraph\\par Second {\\b bold} tail\\par}";
    let d = open_rtf(source).unwrap();
    assert!(d.can_edit); assert!(d.diagnostics.is_empty());
    assert_eq!(d.text, "First paragraph\nSecond bold tail");
    let changed = replace_rtf_text(&d, &edit(&d.paragraphs[0].runs[0].id, "Edited first")).unwrap();
    let r = reopen(&changed);
    assert!(r.can_edit); assert_eq!(r.text, "Edited first\nSecond bold tail");
}
#[test]
fn retains_exact_original_bytes_and_owns_defensive_copies() {
    let mut source = basic(); let original = source.clone();
    let d = open_rtf(&source).unwrap(); source.fill(0);
    let mut exported = export_rtf(&d).unwrap(); assert_eq!(exported, original); exported.fill(0);
    assert_eq!(export_rtf(&d).unwrap(), original);
    // The TypeScript "{ ...document }" forgery cases cannot be written in Rust: snapshots carry their owner.
}
#[test]
fn projects_cleared_font_properties_and_inserted_paragraphs_to_rtf_defaults() {
    let d = open_rtf(&basic()).unwrap();
    let changed = apply_rtf_operations(&d, &[
        Operation::FormatRun { run_id: "p0:r0".into(), style: RunFormat { font_family: Some(None), font_size_points: Some(None), ..Default::default() } },
        Operation::InsertParagraph { after_paragraph_id: InsertAt::After("p1".into()), text: "Default paragraph".into() },
    ]).unwrap();
    let r = reopen(&changed);
    for index in [0, 2] {
        for doc in [&changed, &r] {
            let st = &doc.paragraphs[index].runs[0].style;
            assert_eq!((st.font_family.as_deref(), st.font_size_points), (Some("Georgia"), Some(12.0)));
        }
    }
    let again = apply_rtf_operations(&r, &[Operation::FormatRun { run_id: "p0:r0".into(), style: RunFormat { font_family: Some(None), ..Default::default() } }]).unwrap();
    assert_eq!(again.paragraphs[0].runs[0].style.font_family.as_deref(), Some("Georgia"));
}
#[test]
fn projects_cleared_paragraph_properties_to_exact_rtf_defaults() {
    let d = open_rtf(&basic()).unwrap();
    let changed = apply_rtf_operations(&d, &[Operation::FormatParagraph { paragraph_id: "p0".into(), format: ParagraphFormat { alignment: Some(None), spacing_before_points: Some(None), spacing_after_points: Some(None), line_spacing_multiple: Some(None), style_id: None } }]).unwrap();
    let r = reopen(&changed);
    for v in [&changed, &r] {
        let p = &v.paragraphs[0];
        assert_eq!((p.alignment.as_deref(), p.spacing_before_points, p.spacing_after_points, p.line_spacing_multiple), (Some("left"), Some(0.0), Some(0.0), Some(1.0)));
    }
    assert_eq!(changed.revision, 1);
}
#[test]
fn recognizes_only_actual_shared_source_ownership() {
    let first = create_rtf("First").unwrap(); let foreign = create_rtf("First").unwrap();
    let derived = replace_rtf_text(&first, &edit("p0:r0", "Changed")).unwrap();
    assert!(is_same_rtf_source(&first, &derived));
    assert!(!is_same_rtf_source(&first, &foreign));
}
#[test]
fn edits_and_reopens_genuine_rtf_with_paragraph_and_range_formatting() {
    let d = open_rtf(&basic()).unwrap();
    let edited = apply_rtf_operations(&d, &[
        replace("p0", "Changed 😀 \\ {safe}"),
        Operation::FormatRange { paragraph_id: "p0".into(), start: 0, end: 7, style: RunFormat { italic: Some(Some(true)), color: Some(Some("123456".into())), ..Default::default() } },
        Operation::InsertParagraph { after_paragraph_id: InsertAt::After("p1".into()), text: "Added".into() },
    ]).unwrap();
    let result = export_rtf(&edited).unwrap(); let r = open_rtf(&result).unwrap();
    assert!(result.starts_with(b"{\\rtf1"));
    assert!(r.can_edit); assert_eq!(r.text, edited.text);
    let st = &r.paragraphs[0].runs[0].style;
    assert_eq!((st.italic, st.color.as_deref(), st.font_family.as_deref()), (Some(true), Some("123456"), Some("Georgia")));
    assert!(String::from_utf8_lossy(&result).contains("Markie original RTF fixture;"));
    assert_eq!(export_rtf(&d).unwrap(), basic());
}
#[test]
fn supports_run_text_edits_and_no_op_identity() {
    let d = create_rtf("Hello").unwrap();
    let same = replace_rtf_text(&d, &edit("p0:r0", "Hello")).unwrap();
    assert_eq!(same.revision, d.revision); assert!(!same.modified);
    let changed = replace_rtf_text(&d, &edit("p0:r0", "Bye\nnext\tcell")).unwrap();
    assert_eq!(reopen(&changed).text, changed.text);
    assert_eq!(create_rtf("First\nSecond").unwrap().paragraphs.iter().map(|p| p.text.clone()).collect::<Vec<_>>(), vec!["First", "Second"]);
}
#[test]
fn retains_real_empty_and_trailing_paragraphs() {
    for value in ["", "a\n", "a\n\n", "\n", "\n\n", "a\nb\n"] {
        let d = create_rtf(value).unwrap();
        assert_eq!(d.text, value);
        let changed = apply_rtf_operations(&d, &[Operation::FormatRun { run_id: "p0:r0".into(), style: RunFormat { bold: Some(Some(true)), ..Default::default() } }]).unwrap();
        let r = reopen(&changed);
        assert_eq!(r.text, value); assert_eq!(r.paragraphs[0].runs[0].style.bold, Some(true));
        assert_eq!(open(r"a\par").paragraphs.len(), 1);
    }
}
#[test]
fn preserves_an_inserted_empty_last_paragraph() {
    let d = create_rtf("a").unwrap();
    let changed = apply_rtf_operations(&d, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After("p0".into()), text: String::new() }]).unwrap();
    assert_eq!(reopen(&changed).text, "a\n");
    assert_eq!(reopen(&d).text, "a");
}
#[test]
fn round_trips_unicode_font_names_and_retains_font_fallback_metadata() {
    let d = open(r"{\fonttbl{\f0\froman\fcharset204\cpg1251 Georgia;}}\f0 text");
    let changed = apply_rtf_operations(&d, &[Operation::FormatRun { run_id: "p0:r0".into(), style: RunFormat { font_family: Some(Some("游明朝".into())), ..Default::default() } }]).unwrap();
    let result = export_rtf(&changed).unwrap(); let r = open_rtf(&result).unwrap();
    assert!(r.can_edit); assert_eq!(r.paragraphs[0].runs[0].style.font_family.as_deref(), Some("游明朝"));
    assert!(String::from_utf8_lossy(&result).contains(r"\froman\fcharset204\cpg1251 Georgia;"));
}
#[test]
fn counts_escaped_bytes_controls_and_binary_as_unicode_fallback() {
    assert_eq!(open(r"\uc2\u233\'65?X").text, "éX");
    let r = &open(r"\uc1\u233\b X").paragraphs[0].runs[0];
    assert_eq!((r.text.as_str(), r.style.font_size_points), ("éX", Some(12.0)));
    assert_eq!(open(r"\uc1\u233\bin3 {x}X").text, "éX");
    assert_eq!(open(r"\uc1\u233{X}Y").text, "éXY");
    assert_eq!(open(r"{\uc0\u233}\u233?").text, "éé");
    assert_eq!(open("First\\\nSecond").paragraphs.iter().map(|p| p.text.clone()).collect::<Vec<_>>(), vec!["First", "Second"]);
    assert_eq!(open(r"\uc0{\fonttbl{\f0\fnil \u28216\u26126\u26397;}}\f0 Text").paragraphs[0].runs[0].style.font_family.as_deref(), Some("游明朝"));
}
#[test]
fn decodes_bytes_with_document_and_font_codepage_authority() {
    assert_eq!(open(r"\ansicpg1251\'cf\'f0").text, "Пр");
    let jis = open(r"{\fonttbl{\f0\fnil\fcharset128 Japanese;}}\f0\'82\'a0");
    assert!(jis.can_edit);
    assert_eq!(jis.text, "あ");
    let run = &jis.paragraphs[0].runs[0].id;
    let edited = replace_rtf_text(&jis, &edit(run, "日本語")).unwrap();
    assert_eq!(open_rtf(&export_rtf(&edited).unwrap()).unwrap().text, "日本語");
    assert_eq!(open(r"\ansicpg936\'d6\'d0").text, "中");
    assert_eq!(open(r"\ansicpg949\'b0\'a1").text, "가");
    assert_eq!(open(r"\ansicpg950\'a4\'a4").text, "中");
    assert!(!open(r"\ansicpg932\'82").can_edit);
    assert_eq!(open(r"{\fonttbl{\f0\fnil\fcharset128\cpg1251 Russian;}}\f0\'cf\'f0").text, "Пр");
    let mut raw = b"{\\rtf1\\ansi ".to_vec(); raw.push(0xe9); raw.push(b'}');
    assert_eq!(open_rtf(&raw).unwrap().text, "é");
}
#[test]
fn resets_character_and_paragraph_properties_without_losing_outer_scope() {
    let d = open(r"\qc\b A{\plain B}C\par\pard D");
    assert_eq!(d.paragraphs[0].alignment.as_deref(), Some("center"));
    let runs: Vec<(String, Option<bool>)> = d.paragraphs[0].runs.iter().map(|r| (r.text.clone(), r.style.bold)).collect();
    assert_eq!(runs, vec![("A".into(), Some(true)), ("B".into(), None), ("C".into(), Some(true))]);
    assert_eq!(d.paragraphs[1].alignment.as_deref(), Some("left"));
}
#[test]
fn preserves_common_passive_information_without_blocking_body_editing() {
    let info = r"{\info{\title Editorial \{notes\}}{\subject Draft}{\author Person}{\manager Manager}{\*\company Company}{\operator Editor}{\category Notes}{\keywords research, writing}{\comment Comment}{\doccomm Document comment}{\creatim\yr2026\mo10\dy17\hr21\min30\sec45}{\revtim\yr2026}{\printim}{\buptim\yr2025}\version2{\vern8247}\edmins4\nofpages1\nofwords2\nofchars12\nofcharsws13\id123}";
    let source = format!("{{\\rtf1\\ansi {info}Hello world}}").into_bytes();
    let d = open_rtf(&source).unwrap();
    assert!(d.can_edit, "{:?}", d.diagnostics); assert!(d.diagnostics.is_empty());
    assert_eq!(d.text, "Hello world"); assert_eq!(export_rtf(&d).unwrap(), source);
    let changed = replace_rtf_text(&d, &edit("p0:r0", "Changed body")).unwrap();
    let output = export_rtf(&changed).unwrap(); let written = String::from_utf8_lossy(&output).to_string(); let r = open_rtf(&output).unwrap();
    assert!(r.can_edit); assert_eq!(r.text, "Changed body");
    for expected in [r"{\author\uc1 Person}", r"{\title\uc1 Editorial \{notes\}}", r"{\creatim\yr2026\mo10\dy17\hr21\min30\sec45}", r"\nofcharsws13\id123"] {
        assert!(written.contains(expected), "{expected}");
    }
    assert_eq!(export_rtf(&d).unwrap(), source);
}
#[test]
fn canonicalizes_metadata_with_captured_charset_and_unicode_fallback_context() {
    for (context, field, expected) in [
        (r"\ansicpg932", r"{\author \'82\'a0}", r"{\author\uc1 \u12354?}"),
        (r"\ansicpg1251", r"{\author \'cf\'f0}", r"{\author\uc1 \u1055?\u1088?}"),
        (r"\uc2", r"{\author \u233?? and \uc0\u26085}", r"{\author\uc1 \u233? and \u26085?}"),
        (r"\uc0", r"{\title \u-10179\u-8704}", r"{\title\uc1 \u-10179?\u-8704?}"),
    ] {
        let source = format!("{{\\rtf1\\ansi {context}{{\\info{field}}}Body}}").into_bytes();
        let d = open_rtf(&source).unwrap();
        assert!(d.can_edit, "{context} {:?}", d.diagnostics); assert_eq!(d.text, "Body");
        assert_eq!(export_rtf(&d).unwrap(), source);
        let output = export_rtf(&replace_rtf_text(&d, &edit("p0:r0", "Edited")).unwrap()).unwrap();
        assert!(String::from_utf8_lossy(&output).contains(expected), "{}", String::from_utf8_lossy(&output));
        let r = open_rtf(&output).unwrap();
        assert!(r.can_edit); assert_eq!(r.text, "Edited");
        let second = export_rtf(&replace_rtf_text(&r, &edit("p0:r0", "Edited again")).unwrap()).unwrap();
        assert!(String::from_utf8_lossy(&second).contains(expected));
    }
}
#[test]
fn keeps_original_source_bytes_isolated_when_metadata_uses_raw_regional_bytes() {
    let mut source = br"{\rtf1\ansi\ansicpg1252{\info{\author Caf".to_vec(); source.push(0xe9); source.extend(b"}}Body}");
    let d = open_rtf(&source).unwrap(); let original = source.clone(); source.fill(0);
    let output = export_rtf(&replace_rtf_text(&d, &edit("p0:r0", "Changed")).unwrap()).unwrap();
    assert!(String::from_utf8_lossy(&output).contains(r"{\author\uc1 Caf\u233?}"));
    assert_eq!(export_rtf(&d).unwrap(), original);
}
#[test]
fn protects_unsupported_or_ambiguous_information_without_discarding_it() {
    for info in [r"{\info{\hlinkbase https://example.com}}", r"{\info{\author A}{\author B}}", r"{\info{\unknown value}}", r"{\info{\author {\field active}}}",
        r"{\info{\author \bin1 x}}", r"{\info{\author \u233\unknown}}", r"{\info{\author \uc2\u233?}}", r"{\info{\author \uc-1 text}}",
        r"{\info{\creatim\mo13}}", r"{\info{\creatim\yr2026\yr2025}}", r"{\info\version-1}", r"{\info\nofwords}", r"{\info{\version1 text}}",
        r"{\info{\author \ansicpg1251 text}}", r"{\info{\author \u65535?}}"] {
        let source = format!("{{\\rtf1\\ansi {info}Body}}").into_bytes();
        let d = open_rtf(&source).unwrap();
        assert!(!d.can_edit, "{info}"); assert_eq!(export_rtf(&d).unwrap(), source);
        assert!(replace_rtf_text(&d, &edit("p0:r0", "Changed")).unwrap_err().message.contains("read-only"));
    }
}
#[test]
fn exports_and_reopens_paper_orientation_and_exact_twip_margins() {
    let d = create_rtf("Page layout").unwrap();
    let changed = apply_rtf_operations(&d, &[Operation::SetPageLayout { layout: PageLayoutChange { paper: Some(Paper::A4), orientation: Some(Orientation::Landscape), margin_top_points: Some(36.0), margin_right_points: Some(14.45), margin_bottom_points: Some(72.05), margin_left_points: Some(54.0) } }]).unwrap();
    let r = reopen(&changed);
    assert!(r.can_edit);
    assert_eq!(r.page_layout, changed.page_layout);
    assert_eq!(r.page_layout, PageLayout { width_points: 841.9, height_points: 595.3, orientation: Orientation::Landscape, margin_top_points: 36.0, margin_right_points: 14.45, margin_bottom_points: 72.05, margin_left_points: 54.0 });
    let portrait = apply_rtf_operations(&r, &[Operation::SetPageLayout { layout: PageLayoutChange { paper: Some(Paper::Legal), orientation: Some(Orientation::Portrait), ..Default::default() } }]).unwrap();
    let pl = reopen(&portrait).page_layout;
    assert_eq!((pl.width_points, pl.height_points, pl.orientation, pl.margin_left_points), (612.0, 1008.0, Orientation::Portrait, 54.0));
    let original = export_rtf(&d).unwrap();
    assert!(apply_rtf_operations(&d, &[Operation::SetPageLayout { layout: PageLayoutChange { margin_top_points: Some(72.03), ..Default::default() } }]).unwrap_err().message.contains("exactly"));
    assert_eq!(export_rtf(&d).unwrap(), original);
}
#[test]
fn keeps_unsupported_semantics_read_only_and_exact() {
    for body in [r"{\*\unknown hidden}", r"{\object secret}", r"{\field secret}", r"\intbl", r"\revised text", r"\unknown text", r"\ansicpg9999 text", r"\sl300 text", r"{\pict image}", r"{\*\generator \u233?;}", r"\qc1 text", r"{\fonttbl{\f0\fnil Font;}{\f1\froman Font;}}text"] {
        let source = format!("{{\\rtf1\\ansi {body}}}").into_bytes();
        let d = open_rtf(&source).unwrap();
        assert!(!d.can_edit, "{body}"); assert_eq!(d.diagnostics[0].code, "rtf-unsupported");
        assert_eq!(export_rtf(&d).unwrap(), source);
        assert!(apply_rtf_operations(&d, &[replace("p0", "loss")]).unwrap_err().message.contains("read-only"));
    }
}
#[test]
fn rejects_malformed_or_over_budget_input() {
    let deep = format!("{{\\rtf1{}{}}}", "{".repeat(130), "}".repeat(130));
    for source in ["", "hello", "{\\rtf2 text}", "{\\rtf1 text", "{\\rtf1}junk", "{\\rtf1\\'xz}", "{\\rtf1\\bin5 xx}", "{\\rtf1\\u65535?}", "{\\rtf1\\uc-1}", deep.as_str()] {
        assert!(open_rtf(source.as_bytes()).is_err(), "{source}");
    }
}
#[test]
fn rejects_lossy_edits_instead_of_rounding_or_flattening_styles() {
    let d = create_rtf("Text").unwrap();
    for style in [RunFormat { font_size_points: Some(Some(10.25)), ..Default::default() }, RunFormat { underline: Some(Some("double".into())), ..Default::default() }, RunFormat { font_family: Some(Some("Bad;Font".into())), ..Default::default() }] {
        assert!(apply_rtf_operations(&d, &[Operation::FormatRun { run_id: "p0:r0".into(), style }]).is_err());
    }
    let auto = apply_rtf_operations(&d, &[Operation::FormatRun { run_id: "p0:r0".into(), style: RunFormat { color: Some(Some("auto".into())), ..Default::default() } }]).unwrap();
    assert!(reopen(&auto).can_edit);
}
#[test]
fn bounds_byte_and_token_counts_before_constructing_a_document() {
    assert!(open_rtf(&vec![0u8; 16 * 1024 * 1024 + 1]).unwrap_err().message.contains("byte budget"));
    assert!(open_rtf(format!("{{\\rtf1\\ansi {}}}", "x".repeat(250_000)).as_bytes()).unwrap_err().message.contains("token budget"));
}
#[test]
fn rejects_edits_exceeding_the_writer_reopen_token_budget() {
    let d = create_rtf("a").unwrap(); let original = export_rtf(&d).unwrap();
    assert!(replace_rtf_text(&d, &edit("p0:r0", &"a".repeat(300_000))).unwrap_err().message.contains("token budget"));
    assert!(apply_rtf_operations(&d, &[replace("p0", &"a".repeat(300_000))]).unwrap_err().message.contains("token budget"));
    assert_eq!(export_rtf(&d).unwrap(), original);
    let supported = replace_rtf_text(&d, &edit("p0:r0", &"a".repeat(20_000))).unwrap();
    assert_eq!(reopen(&supported).text, supported.text);
}
