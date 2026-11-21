//! Port of rich-document.test.ts and rich-text-model.test.ts.
use markie_office::model::*;
use markie_office::rich_document::*;
use markie_office::rich_text_model::*;

fn bold(f: &mut RunFormat) { f.bold = Some(Some(true)); }
fn fmt(f: impl FnOnce(&mut RunFormat)) -> RunFormat { let mut r = RunFormat::default(); f(&mut r); r }
fn create(format: Format, text: &str) -> OfficeDocument { create_rich_document(format, text).unwrap() }

// ---- rich-document.test.ts ----
#[test]
fn keeps_rtf_and_odt_unchanged_when_selecting_their_current_page_setup() {
    for format in [Format::Rtf, Format::Odt] {
        let bytes = export_rich_document(&create(format, "No-op geometry")).unwrap();
        let opened = open_rich_document(format, &bytes).unwrap();
        let same = apply_rich_operations(&opened, &[Operation::SetPageLayout { layout: PageLayoutChange { paper: Some(Paper::Letter), orientation: Some(Orientation::Portrait), margin_top_points: Some(72.0), margin_left_points: Some(72.0), ..Default::default() } }]).unwrap();
        assert!(!same.modified); assert_eq!(same.revision, 0);
        assert_eq!(export_rich_document(&same).unwrap(), bytes);
    }
}
#[test]
fn opens_edits_and_exports_rtf_and_odt_without_a_docx_intermediate() {
    for format in [Format::Rtf, Format::Odt] {
        let bytes = export_rich_document(&create(format, "First\nSecond")).unwrap();
        let opened = open_rich_document(format, &bytes).unwrap();
        assert_eq!(opened.format, format); assert_eq!(opened.text, "First\nSecond");
        assert_eq!(export_rich_document(&opened).unwrap(), bytes);
        let edited = apply_rich_operations(&opened, &[
            Operation::FormatRun { run_id: opened.paragraphs[0].runs[0].id.clone(), style: fmt(|f| { f.bold = Some(Some(true)); f.font_family = Some(Some("Georgia".into())); f.color = Some(Some("336699".into())); f.font_size_points = Some(Some(16.0)); }) },
            Operation::FormatParagraph { paragraph_id: opened.paragraphs[0].id.clone(), format: ParagraphFormat { alignment: Some(Some("center".into())), spacing_after_points: Some(Some(12.0)), ..Default::default() } },
        ]).unwrap();
        let changed = replace_rich_text(&edited, &[TextEdit { run_id: edited.paragraphs[1].runs[0].id.clone(), text: "Updated".into() }]).unwrap();
        let saved = export_rich_document(&changed).unwrap();
        let r = open_rich_document(format, &saved).unwrap();
        assert_eq!(r.text, "First\nUpdated");
        let st = &r.paragraphs[0].runs[0].style;
        assert_eq!((st.bold, st.font_family.as_deref(), st.color.as_deref(), st.font_size_points), (Some(true), Some("Georgia"), Some("336699"), Some(16.0)));
        assert_eq!((r.paragraphs[0].alignment.as_deref(), r.paragraphs[0].spacing_after_points), (Some("center"), Some(12.0)));
        assert!(if format == Format::Rtf { saved.starts_with(b"{\\rtf1") } else { saved.starts_with(b"PK") });
    }
}
#[test]
fn gates_unsupported_rtf_and_odt_commands_in_the_adapter() {
    for format in [Format::Rtf, Format::Odt] {
        let d = create(format, "text");
        let c = rich_capabilities(&d);
        assert!(c.run_formatting && c.paragraph_formatting && c.page_layout);
        assert!(!c.review && !c.hyperlinks && !c.named_styles && !c.tables);
        let laid_out = apply_rich_operations(&d, &[Operation::SetPageLayout { layout: PageLayoutChange { paper: Some(Paper::A4), orientation: Some(Orientation::Landscape), margin_top_points: Some(36.0), margin_left_points: Some(54.0), ..Default::default() } }]).unwrap();
        let l = open_rich_document(format, &export_rich_document(&laid_out).unwrap()).unwrap().page_layout;
        assert_eq!((l.orientation, l.width_points, l.height_points, l.margin_top_points, l.margin_left_points), (Orientation::Landscape, 841.9, 595.3, 36.0, 54.0));
        assert!(apply_rich_operations(&d, &[Operation::InsertTable { after_paragraph_id: InsertAt::End, rows: 1, columns: 1, cells: None }]).is_err());
        assert!(rich_image_bytes(&d, "anything").is_err());
        assert_eq!(export_rich_document(&d).unwrap(), export_rich_document(&d).unwrap());
    }
}
#[test]
fn routes_docx_to_its_own_package_engine() {
    let d = create(Format::Docx, "Word");
    assert!(rich_capabilities(&d).tables);
    let updated = apply_rich_operations(&d, &[Operation::FormatRun { run_id: d.paragraphs[0].runs[0].id.clone(), style: fmt(|f| f.italic = Some(Some(true))) }]).unwrap();
    assert_eq!(open_rich_document(Format::Docx, &export_rich_document(&updated).unwrap()).unwrap().paragraphs[0].runs[0].style.italic, Some(true));
}
#[test]
fn exports_and_reopens_odt_at_the_joined_text_budget() {
    let initial = create(Format::Odt, &"a".repeat(999_999));
    let boundary = apply_rich_operations(&initial, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After(initial.paragraphs[0].id.clone()), text: String::new() }]).unwrap();
    let bytes = export_rich_document(&boundary).unwrap();
    assert_eq!(open_rich_document(Format::Odt, &bytes).unwrap().text, boundary.text);
    assert!(apply_rich_operations(&boundary, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After(boundary.paragraphs[1].id.clone()), text: String::new() }]).unwrap_err().message.contains("size"));
    assert_eq!(export_rich_document(&boundary).unwrap(), bytes);
    assert_eq!(boundary.text.len(), 1_000_000); assert_eq!(boundary.paragraphs.len(), 2);
}
#[test]
fn recognizes_only_derived_snapshots_as_the_same_source() {
    // The TypeScript session/library cases belong to the document workspace layer, not the codecs.
    for format in [Format::Rtf, Format::Odt] {
        let source = create(format, "");
        let other = open_rich_document(format, &export_rich_document(&source).unwrap()).unwrap();
        assert!(!same_rich_source(&source, &other));
        let edited = replace_rich_text(&source, &[TextEdit { run_id: source.paragraphs[0].runs[0].id.clone(), text: "Derived".into() }]).unwrap();
        assert!(same_rich_source(&source, &edited));
        assert!(!same_rich_source(&edited, &create(if format == Format::Rtf { Format::Odt } else { Format::Rtf }, "")));
    }
}
#[test]
fn refuses_structural_range_edits_for_other_formats() {
    let d = create(Format::Rtf, "RTF");
    let at = TextPosition { paragraph_id: d.paragraphs[0].id.clone(), offset: 1 };
    assert!(replace_rich_range(&d, &TextRange { anchor: at.clone(), focus: at }, "\n").unwrap_err().message.contains("not yet supported"));
}

// ---- rich-text-model.test.ts ----
fn run(text: &str, style: RunStyle) -> RunInput { RunInput { text: text.into(), style } }
fn para(runs: Vec<RunInput>) -> ParagraphInput { ParagraphInput { runs, ..Default::default() } }
fn fixture() -> NativeDocument {
    create_rich_snapshot(Format::Rtf, &[para(vec![run("Hello ", RunStyle { bold: Some(true), color: Some("336699".into()), ..Default::default() }), run("world", RunStyle::default())]), para(vec![run("Second", RunStyle::default())])], SnapshotOptions::default()).unwrap()
}
fn edit(id: &str, text: &str) -> TextEdit { TextEdit { run_id: id.into(), text: text.into() } }
#[test]
fn does_not_retain_mutable_codec_inputs() {
    let mut inputs = vec![para(vec![run("hello", RunStyle { bold: Some(true), ..Default::default() })])];
    let d = create_rich_snapshot(Format::Odt, &inputs, SnapshotOptions::default()).unwrap();
    inputs[0].runs[0].text = "changed".into(); inputs[0].runs[0].style.bold = Some(false);
    let r = &d.paragraphs[0].runs[0];
    assert_eq!((r.id.as_str(), r.text.as_str(), r.style.bold), ("p0:r0", "hello", Some(true)));
}
#[test]
fn keeps_identities_across_edits_and_no_op_transactions() {
    let d = fixture();
    assert_eq!(replace_simple_rich_text(&d, &[edit("p0:r0", "Hello ")]).unwrap(), d);
    assert_eq!(apply_simple_rich_operations(&d, &[]).unwrap(), d);
    let next = replace_simple_rich_text(&d, &[edit("p0:r0", "New ")]).unwrap();
    assert_eq!(next.text, "New world\nSecond"); assert_eq!(d.text, "Hello world\nSecond");
    assert_eq!((next.format, next.revision, next.modified), (Format::Rtf, 1, true));
    assert_eq!(next.paragraphs[0].runs[0].id, "p0:r0");
}
#[test]
fn splits_formatting_ranges_once_and_supports_null_clearing() {
    let d = apply_simple_rich_operations(&fixture(), &[Operation::FormatRange { paragraph_id: "p0".into(), start: 2, end: 8, style: fmt(|f| { f.bold = Some(None); f.italic = Some(Some(true)); }) }]).unwrap();
    assert_eq!(d.paragraphs[0].runs.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), vec!["He", "llo ", "wo", "rld"]);
    assert_eq!(d.paragraphs[0].runs[1].style, RunStyle { color: Some("336699".into()), italic: Some(true), ..Default::default() });
    let ids: Vec<String> = d.paragraphs.iter().flat_map(|p| p.runs.iter().map(|r| r.id.clone())).collect();
    assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), ids.len());
    let next = apply_simple_rich_operations(&d, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After("p0".into()), text: "Inserted".into() }, Operation::DeleteParagraph { paragraph_id: "p1".into() }]).unwrap();
    assert_eq!(next.text, "Hello world\nInserted"); assert_eq!(next.paragraphs[0].id, "p0");
}
#[test]
fn changes_paragraph_formatting_and_clears_fields() {
    let d = apply_simple_rich_operations(&fixture(), &[Operation::FormatParagraph { paragraph_id: "p0".into(), format: ParagraphFormat { alignment: Some(Some("center".into())), spacing_after_points: Some(Some(12.0)), line_spacing_multiple: Some(Some(1.5)), ..Default::default() } }]).unwrap();
    let p = &d.paragraphs[0];
    assert_eq!((p.alignment.as_deref(), p.spacing_after_points, p.line_spacing_multiple), (Some("center"), Some(12.0), Some(1.5)));
    let clear = apply_simple_rich_operations(&d, &[Operation::FormatParagraph { paragraph_id: "p0".into(), format: ParagraphFormat { alignment: Some(None), spacing_after_points: Some(None), ..Default::default() } }]).unwrap();
    assert_eq!((clear.paragraphs[0].alignment.clone(), clear.paragraphs[0].spacing_after_points), (None, None));
}
#[test]
fn rejects_operations_it_would_lose_source_for() {
    let ops = vec![
        Operation::InsertTable { after_paragraph_id: InsertAt::End, rows: 1, columns: 1, cells: None },
        Operation::SetList { paragraph_id: "p0".into(), kind: Some(ListKind::Bullet) },
        Operation::InsertImage(ImageInput { after_paragraph_id: InsertAt::End, bytes: vec![], content_type: ImageType::Png, width_points: 1.0, height_points: 1.0, alt_text: None }),
        Operation::SetHyperlink { paragraph_id: "p0".into(), start: 0, end: 1, target: "https://example.com".into() },
        Operation::AddComment { paragraph_id: "p0".into(), text: "x".into(), author: "a".into() },
        Operation::AcceptAllRevisions,
    ];
    for op in ops { assert!(apply_simple_rich_operations(&fixture(), &[op]).is_err()); }
}
#[test]
fn rejects_readonly_duplicate_unknown_and_out_of_bounds_edits_atomically() {
    let d = fixture();
    let ro = create_rich_snapshot(Format::Rtf, &[para(vec![run("x", RunStyle::default())])], SnapshotOptions { can_edit: Some(false), ..Default::default() }).unwrap();
    assert!(replace_simple_rich_text(&ro, &[]).unwrap_err().message.contains("read-only"));
    assert!(replace_simple_rich_text(&d, &[edit("p0:r0", "x"), edit("p0:r0", "y")]).unwrap_err().message.contains("Duplicate"));
    assert!(replace_simple_rich_text(&d, &[edit("unknown", "x")]).unwrap_err().message.contains("Unknown"));
    assert!(apply_simple_rich_operations(&d, &[Operation::FormatRange { paragraph_id: "p0".into(), start: 2, end: 99, style: RunFormat::default() }]).is_err());
    assert!(apply_simple_rich_operations(&d, &[Operation::FormatRun { run_id: "p0:r0".into(), style: fmt(|f| f.font_size_points = Some(Some(f64::NAN))) }]).is_err());
    assert!(apply_simple_rich_operations(&d, &[Operation::FormatParagraph { paragraph_id: "p0".into(), format: ParagraphFormat { style_id: Some(Some("Normal".into())), ..Default::default() } }]).is_err());
    assert_eq!(d.revision, 0);
}
#[test]
fn rejects_formatting_through_half_a_character() {
    let d = create_rich_snapshot(Format::Rtf, &[para(vec![run("a😀b", RunStyle::default())])], SnapshotOptions::default()).unwrap();
    assert!(apply_simple_rich_operations(&d, &[Operation::FormatRange { paragraph_id: "p0".into(), start: 1, end: 2, style: fmt(bold) }]).unwrap_err().message.contains("Unicode"));
}
#[test]
fn counts_paragraph_separators_in_the_text_budget() {
    let d = create_rich_snapshot(Format::Rtf, &[para(vec![run(&"a".repeat(999_999), RunStyle::default())])], SnapshotOptions::default()).unwrap();
    let boundary = apply_simple_rich_operations(&d, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After("p0".into()), text: String::new() }]).unwrap();
    assert_eq!(boundary.text.len(), 1_000_000);
    let source_id = boundary.paragraphs[1].id.clone();
    assert!(apply_simple_rich_operations(&boundary, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After(source_id.clone()), text: String::new() }]).unwrap_err().message.contains("size"));
    assert_eq!(boundary.revision, 1); assert_eq!(boundary.paragraphs[1].id, source_id); assert_eq!(boundary.paragraphs.len(), 2);
    let after = apply_simple_rich_operations(&boundary, &[Operation::DeleteParagraph { paragraph_id: source_id }, Operation::InsertParagraph { after_paragraph_id: InsertAt::After("p0".into()), text: String::new() }]).unwrap();
    assert_eq!(after.paragraphs[1].id, "p~2");
}
#[test]
fn rebases_missing_defaults_in_one_pass_without_changing_edit_state() {
    let initial = create_rich_snapshot(Format::Odt, &[ParagraphInput { runs: vec![run("a", RunStyle { bold: Some(false), underline: Some("none".into()), ..Default::default() }), run("b", RunStyle::default())], spacing_after_points: Some(0.0), ..Default::default() }], SnapshotOptions::default()).unwrap();
    let edited = apply_simple_rich_operations(&initial, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After("p0".into()), text: "new".into() }]).unwrap();
    let run_defaults = RunStyle { bold: Some(true), underline: Some("single".into()), font_family: Some("Georgia".into()), font_size_points: Some(12.0), ..Default::default() };
    let para_defaults = ParagraphDefaults { alignment: Some("left".into()), spacing_after_points: Some(9.0), line_spacing_multiple: Some(1.0), ..Default::default() };
    let next = rebase_simple_rich_defaults(&edited, &run_defaults, &para_defaults).unwrap();
    let st = &next.paragraphs[0].runs[0].style;
    assert_eq!((st.bold, st.underline.as_deref(), st.font_family.as_deref(), st.font_size_points), (Some(false), Some("none"), Some("Georgia"), Some(12.0)));
    assert_eq!((next.paragraphs[0].spacing_after_points, next.paragraphs[1].spacing_after_points), (Some(0.0), Some(9.0)));
    assert_eq!((next.revision, next.modified, &next.text), (edited.revision, edited.modified, &edited.text));
    assert_eq!(next.paragraphs.iter().map(|p| &p.id).collect::<Vec<_>>(), edited.paragraphs.iter().map(|p| &p.id).collect::<Vec<_>>());
    assert_eq!(rebase_simple_rich_defaults(&next, &run_defaults, &para_defaults).unwrap(), next);
    let inserted = apply_simple_rich_operations(&next, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::After(next.paragraphs[1].id.clone()), text: "next".into() }]).unwrap();
    assert_eq!(inserted.paragraphs[2].id, "p~2");
    assert!(rebase_simple_rich_defaults(&next, &RunStyle { font_size_points: Some(f64::NAN), ..Default::default() }, &ParagraphDefaults::default()).is_err());
    assert!(rebase_simple_rich_defaults(&next, &RunStyle::default(), &ParagraphDefaults { spacing_after_points: Some(-1.0), ..Default::default() }).is_err());
}
#[test]
fn lays_out_display_only_tables_and_list_markers_and_refuses_them_when_editable() {
    let inputs: Vec<ParagraphInput> = ["Intro", "A1", "B1", "B1 second", "A2", "B2", "Outro"].iter().map(|t| para(vec![run(t, RunStyle::default())])).collect();
    let blocks = vec![BlockInput::Paragraph(0), BlockInput::Table(vec![vec![vec![1], vec![2, 3]], vec![vec![4], vec![5]]]), BlockInput::Paragraph(6)];
    let d = create_rich_snapshot(Format::Rtf, &inputs, SnapshotOptions { can_edit: Some(false), blocks: Some(blocks.clone()), ..Default::default() }).unwrap();
    assert_eq!(d.blocks, vec![Block::Paragraph("p0".into()), Block::Table("t0".into()), Block::Paragraph("p6".into())]);
    let texts: Vec<Vec<Vec<String>>> = d.tables[0].rows.iter().map(|r| r.cells.iter().map(|c| c.paragraph_ids.iter().map(|id| d.paragraph(id).unwrap().text.clone()).collect()).collect()).collect();
    assert_eq!(texts, vec![vec![vec!["A1".to_string()], vec!["B1".into(), "B1 second".into()]], vec![vec!["A2".into()], vec!["B2".into()]]]);
    assert!(apply_simple_rich_operations(&d, &[Operation::ReplaceParagraph { paragraph_id: "p1".into(), text: "x".into() }]).unwrap_err().message.contains("read-only"));
    assert!(create_rich_snapshot(Format::Rtf, &inputs, SnapshotOptions { blocks: Some(blocks), ..Default::default() }).unwrap_err().message.contains("read-only"));
    for bad in [vec![BlockInput::Paragraph(1)], vec![BlockInput::Paragraph(0)], vec![BlockInput::Table(vec![vec![vec![0, 0]]])], vec![BlockInput::Table(vec![vec![vec![]]])]] {
        assert!(create_rich_snapshot(Format::Rtf, &inputs[..2], SnapshotOptions { can_edit: Some(false), blocks: Some(bad), ..Default::default() }).is_err());
    }
    let listed = create_rich_snapshot(Format::Odt, &[ParagraphInput { runs: vec![run("One", RunStyle::default())], list_kind: Some(ListKind::Numbered), list_level: Some(0), list_number: Some(1), ..Default::default() }], SnapshotOptions { can_edit: Some(false), ..Default::default() }).unwrap();
    assert_eq!((listed.paragraphs[0].list_kind, listed.paragraphs[0].list_number), (Some(ListKind::Numbered), Some(1)));
    assert!(create_rich_snapshot(Format::Odt, &[ParagraphInput { runs: vec![run("One", RunStyle::default())], list_kind: Some(ListKind::Bullet), ..Default::default() }], SnapshotOptions::default()).unwrap_err().message.contains("read-only"));
    assert!(create_rich_snapshot(Format::Odt, &[ParagraphInput { runs: vec![run("One", RunStyle::default())], list_kind: Some(ListKind::Bullet), list_level: Some(9), ..Default::default() }], SnapshotOptions { can_edit: Some(false), ..Default::default() }).is_err());
}
