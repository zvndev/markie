//! Port of docx-operations.test.ts, docx-numbering.test.ts and docx-parts.test.ts.
#[path = "common/docx_fixture.rs"]
mod docx_fixture;
use docx_fixture::*;

fn create(text: &str) -> DocxDocument { create_docx(text).unwrap() }
fn after(id: &str) -> InsertAt { InsertAt::After(id.into()) }
fn pformat(f: impl FnOnce(&mut ParagraphFormat)) -> ParagraphFormat { let mut p = ParagraphFormat::default(); f(&mut p); p }
fn swap_main(d: &DocxDocument, change: impl FnOnce(&str) -> String) -> Vec<u8> {
    let mut parts = read_zip(&export(d), DEFAULT_ZIP_LIMITS).unwrap();
    change_xml(&mut parts, "word/document.xml", change);
    write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap()
}

#[test]
fn round_trips_full_direct_run_formatting_and_null_removes_it() {
    let original = create("Typography");
    let id = original.paragraphs[0].runs[0].id.clone();
    let style = fmt(|f| { f.bold = Some(Some(true)); f.italic = Some(Some(false)); f.underline = Some(Some("double".into())); f.color = Some(Some("1255AA".into())); f.font_family = Some(Some("A \"quoted\" font".into())); f.font_size_points = Some(Some(18.5)); });
    let edited = apply(&original, &[Operation::FormatRun { run_id: id.clone(), style }]);
    assert_eq!(edited.paragraphs[0].runs[0].id, id);
    let s = &edited.paragraphs[0].runs[0].style;
    assert_eq!((s.bold, s.italic, s.underline.as_deref(), s.color.as_deref(), s.font_family.as_deref(), s.font_size_points), (Some(true), Some(false), Some("double"), Some("1255AA"), Some("A \"quoted\" font"), Some(18.5)));
    assert_eq!(reopen(&edited).paragraphs[0].runs[0].style, edited.paragraphs[0].runs[0].style);
    assert_eq!(original.paragraphs[0].runs[0].style.bold, None);
    let clear = fmt(|f| { f.bold = Some(None); f.italic = Some(None); f.underline = Some(None); f.color = Some(None); f.font_family = Some(None); f.font_size_points = Some(None); });
    let cleared = apply(&edited, &[Operation::FormatRun { run_id: id, style: clear }]);
    assert_eq!(reopen(&cleared).paragraphs[0].runs[0].style, original.paragraphs[0].runs[0].style);
}
#[test]
fn preserves_paragraph_identities_through_insert_replace_format_and_delete() {
    let original = create("One\nTwo\nThree");
    let (one, two, three) = (original.paragraphs[0].id.clone(), original.paragraphs[1].id.clone(), original.paragraphs[2].id.clone());
    let d = apply(&original, &[
        Operation::InsertParagraph { after_paragraph_id: InsertAt::Start, text: "Before".into() },
        Operation::InsertParagraph { after_paragraph_id: after(&one), text: "After one".into() },
        Operation::ReplaceParagraph { paragraph_id: two.clone(), text: "Replaced".into() },
        Operation::FormatParagraph { paragraph_id: two.clone(), format: pformat(|p| { p.alignment = Some(Some("center".into())); p.spacing_before_points = Some(Some(6.0)); p.spacing_after_points = Some(Some(12.0)); p.line_spacing_multiple = Some(Some(1.5)); }) },
        Operation::DeleteParagraph { paragraph_id: three },
    ]);
    assert_eq!(d.text, "Before\nOne\nAfter one\nReplaced");
    assert_eq!(d.paragraphs.iter().find(|p| p.text == "One").unwrap().id, one);
    let check = |p: &Paragraph| assert_eq!((p.alignment.as_deref(), p.spacing_before_points, p.spacing_after_points, p.line_spacing_multiple), (Some("center"), Some(6.0), Some(12.0), Some(1.5)));
    let replaced = d.paragraphs.iter().find(|p| p.text == "Replaced").unwrap();
    assert_eq!(replaced.id, two); check(replaced);
    let saved = reopen(&d);
    assert_eq!(saved.text, d.text); check(&saved.paragraphs[3]);
    assert_eq!(original.text, "One\nTwo\nThree");
}
#[test]
fn round_trips_page_paper_orientation_and_margins() {
    let d = create("Layout");
    let edited = apply(&d, &[Operation::SetPageLayout { layout: PageLayoutChange { paper: Some(Paper::A4), orientation: Some(Orientation::Landscape), margin_top_points: Some(36.0), margin_right_points: Some(48.0), margin_bottom_points: Some(54.0), margin_left_points: Some(60.0) } }]);
    let saved = reopen(&edited);
    assert_eq!(saved.page_layout, PageLayout { width_points: 841.9, height_points: 595.3, orientation: Orientation::Landscape, margin_top_points: 36.0, margin_right_points: 48.0, margin_bottom_points: 54.0, margin_left_points: 60.0 });
    assert_eq!(saved.text, "Layout");
    let portrait = apply(&edited, &[Operation::SetPageLayout { layout: PageLayoutChange { orientation: Some(Orientation::Portrait), ..Default::default() } }]);
    assert!(portrait.page_layout.width_points < portrait.page_layout.height_points);
}
#[test]
fn preserves_signed_top_and_bottom_margins() {
    let bytes = swap_main(&create("Signed margins"), |x| x.replace(r#"w:top="1440""#, r#"w:top="-720""#).replace(r#"w:bottom="1440""#, r#"w:bottom="-360""#));
    let d = open(&bytes);
    assert_eq!((d.page_layout.margin_top_points, d.page_layout.margin_bottom_points), (-36.0, -18.0));
    let changed = apply(&d, &[Operation::SetPageLayout { layout: PageLayoutChange { orientation: Some(Orientation::Landscape), ..Default::default() } }]);
    let l = reopen(&changed).page_layout;
    assert_eq!((l.margin_top_points, l.margin_bottom_points, l.orientation), (-36.0, -18.0, Orientation::Landscape));
}
fn cell_text(d: &DocxDocument, t: usize, r: usize, c: usize) -> &Paragraph { d.paragraph(&d.tables[t].rows[r].cells[c].paragraph_ids[0]).unwrap() }
#[test]
fn creates_tables_edits_cells_and_deletes_the_table() {
    let original = create("Before\nAfter");
    let d = apply(&original, &[Operation::InsertTable { after_paragraph_id: after(&original.paragraphs[0].id), rows: 2, columns: 2, cells: Some(vec![vec!["A".into(), "B".into()], vec!["C".into(), "D".into()]]) }]);
    assert_eq!(d.blocks.iter().map(|b| matches!(b, Block::Table(_))).collect::<Vec<_>>(), vec![false, true, false]);
    let texts: Vec<Vec<String>> = (0..2).map(|r| (0..2).map(|c| cell_text(&d, 0, r, c).text.clone()).collect()).collect();
    assert_eq!(texts, vec![vec!["A", "B"], vec!["C", "D"]]);
    let cell = cell_text(&d, 0, 1, 1).id.clone();
    let edited = apply(&d, &[Operation::ReplaceParagraph { paragraph_id: cell.clone(), text: "Edited cell".into() }, Operation::FormatParagraph { paragraph_id: cell, format: pformat(|p| p.alignment = Some(Some("right".into()))) }]);
    let saved = reopen(&edited);
    assert!(saved.can_edit);
    let p = cell_text(&saved, 0, 1, 1);
    assert_eq!((p.text.as_str(), p.alignment.as_deref()), ("Edited cell", Some("right")));
    assert_eq!(saved.text, "Before\nA\nB\nC\nEdited cell\nAfter");
    let without = apply(&edited, &[Operation::DeleteTable { table_id: d.tables[0].id.clone() }]);
    assert_eq!(reopen(&without).text, original.text);
    assert_eq!(without.paragraphs[1].id, original.paragraphs[1].id);
}
#[test]
fn supports_multiple_paragraphs_inside_cells_without_empty_cells() {
    let d = apply(&create("A"), &[Operation::InsertTable { after_paragraph_id: InsertAt::End, rows: 1, columns: 1, cells: None }]);
    let pid = d.tables[0].rows[0].cells[0].paragraph_ids[0].clone();
    assert!(apply_err(&d, &[Operation::DeleteParagraph { paragraph_id: pid.clone() }]).contains("at least"));
    let added = apply(&d, &[Operation::InsertParagraph { after_paragraph_id: after(&pid), text: "Second".into() }]);
    let deleted = apply(&added, &[Operation::DeleteParagraph { paragraph_id: pid }]);
    let saved = reopen(&deleted);
    assert_eq!(saved.tables[0].rows[0].cells[0].paragraph_ids.iter().map(|id| saved.paragraph(id).unwrap().text.clone()).collect::<Vec<_>>(), vec!["Second"]);
}
#[test]
fn handles_self_closing_empty_paragraphs_and_strict_namespaces() {
    let bytes = swap_main(&create("A"), |x| {
        let s = x.find("<w:p>").unwrap(); let e = x.find("</w:p>").unwrap() + 6;
        format!("{}<w:p/>{}", &x[..s], &x[e..]).replace("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main")
    });
    let original = open(&bytes);
    let id = original.paragraphs[0].id.clone();
    let formatted = apply(&original, &[Operation::FormatParagraph { paragraph_id: id.clone(), format: pformat(|p| p.alignment = Some(Some("right".into()))) }, Operation::ReplaceParagraph { paragraph_id: id.clone(), text: "Now text".into() }]);
    assert_eq!(formatted.paragraphs[0].id, id);
    let p = &reopen(&formatted).paragraphs[0];
    assert_eq!((p.text.as_str(), p.alignment.as_deref()), ("Now text", Some("right")));
}
#[test]
fn keeps_run_edit_compatibility_after_structure_or_formatting_mutations() {
    let original = create("One\nTwo");
    let id = original.paragraphs[1].runs[0].id.clone();
    let inserted = apply(&original, &[Operation::InsertParagraph { after_paragraph_id: InsertAt::Start, text: "Before".into() }, Operation::FormatRun { run_id: id.clone(), style: fmt(|f| f.bold = Some(Some(true))) }]);
    let replaced = replace(&inserted, &id, "Changed");
    assert_eq!(reopen(&replaced).text, "Before\nOne\nChanged");
    assert_eq!(replaced.paragraphs[2].runs[0].id, id);
    assert_eq!(replaced.paragraphs[2].runs[0].style.bold, Some(true));
}
#[test]
fn keeps_text_node_local_namespace_declarations_during_run_replacement() {
    let bytes = swap_main(&create("Local namespace"), |x| x.replace(r#"<w:t xml:space="preserve">Local namespace</w:t>"#, r#"<q:t xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xml:space="default">Local namespace</q:t>"#));
    assert_eq!(reopen(&replace(&open(&bytes), "p0:r0", " Updated ")).text, " Updated ");
}
#[test]
fn rejects_invalid_formatting_and_structural_operations_atomically() {
    // TypeScript also passes untyped values (bold "yes", unknown fields, paper "constructor",
    // orientation "diagonal", 1.5 rows) that the Rust operation types cannot express.
    let d = create("Original");
    let run = |style: RunFormat| Operation::FormatRun { run_id: "p0:r0".into(), style };
    let para = |format: ParagraphFormat| Operation::FormatParagraph { paragraph_id: "p0".into(), format };
    let layout = |l: PageLayoutChange| Operation::SetPageLayout { layout: l };
    let table = |rows, columns, cells| Operation::InsertTable { after_paragraph_id: InsertAt::End, rows, columns, cells };
    let invalid = vec![
        run(fmt(|f| f.color = Some(Some("red\" foo=\"bar".into())))), run(fmt(|f| f.font_size_points = Some(Some(f64::NAN)))),
        run(fmt(|f| f.font_size_points = Some(Some(12.2)))), run(fmt(|f| f.font_family = Some(Some("Bad\nfont".into())))),
        para(pformat(|p| p.style_id = Some(Some("a\"/>evil".into())))), para(pformat(|p| p.alignment = Some(Some("invalid".into())))),
        para(pformat(|p| p.line_spacing_multiple = Some(Some(-1.0)))),
        layout(PageLayoutChange { margin_left_points: Some(600.0), ..Default::default() }), layout(PageLayoutChange { margin_top_points: Some(f64::INFINITY), ..Default::default() }),
        table(0, 2, None), table(100, 20, None), table(2, 2, Some(vec![vec!["A".into()]])),
        Operation::ReplaceParagraph { paragraph_id: "p0".into(), text: "A\nB".into() }, Operation::DeleteParagraph { paragraph_id: "p0".into() },
        Operation::DeleteTable { table_id: "absent".into() }, Operation::FormatRun { run_id: "absent".into(), style: fmt(|f| f.bold = Some(Some(true))) },
    ];
    for op in invalid {
        assert!(apply_docx_operations(&d, &[run(fmt(|f| f.bold = Some(Some(true)))), op.clone()]).is_err(), "{op:?}");
        assert_eq!(d.text, "Original"); assert!(!d.modified);
    }
    assert_eq!(export(&d), export(&create("Original")));
}
#[test]
fn continues_to_reject_merged_tables_untouched() {
    let d = apply(&create("A"), &[Operation::InsertTable { after_paragraph_id: InsertAt::End, rows: 1, columns: 1, cells: None }]);
    let bytes = swap_main(&d, |x| x.replace("</w:tcPr>", r#"<w:gridSpan xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:val="2"/></w:tcPr>"#));
    let readonly = open(&bytes);
    assert!(!readonly.can_edit);
    assert!(apply_err(&readonly, &[Operation::SetPageLayout { layout: PageLayoutChange { paper: Some(Paper::A4), ..Default::default() } }]).contains("safely"));
    assert_eq!(export(&readonly), bytes);
}

// ---- docx-numbering.test.ts ----
#[test]
fn creates_portable_builtin_heading_definitions() {
    let original = create("Heading\nBody");
    let d = apply(&original, &[Operation::FormatParagraph { paragraph_id: "p0".into(), format: pformat(|p| p.style_id = Some(Some("Heading1".into()))) }]);
    let ids: Vec<&str> = d.styles.iter().map(|s| s.id.as_str()).collect();
    assert!(ids.contains(&"Heading1") && ids.contains(&"Normal"));
    let r = reopen(&d);
    assert!(r.can_edit); assert_eq!(r.paragraphs[0].style_id.as_deref(), Some("Heading1"));
    let styles = part(&export(&d), "word/styles.xml").unwrap();
    assert!(styles.contains(r#"w:styleId="Heading1""#) && styles.contains(r#"<w:sz w:val="40"/>"#));
    assert!(apply_err(&original, &[Operation::FormatParagraph { paragraph_id: "p0".into(), format: pformat(|p| p.style_id = Some(Some("UndefinedStyle".into()))) }]).contains("not defined"));
}
#[test]
fn round_trips_bullet_and_numbered_definitions_and_clears_lists() {
    let original = create("Bullet\nOne\nTwo\nPlain");
    let list = |p: &str, k| Operation::SetList { paragraph_id: p.into(), kind: k };
    let d = apply(&original, &[list("p0", Some(ListKind::Bullet)), list("p1", Some(ListKind::Numbered)), list("p2", Some(ListKind::Numbered)),
        Operation::FormatParagraph { paragraph_id: "p1".into(), format: pformat(|p| { p.spacing_after_points = Some(Some(6.0)); p.alignment = Some(Some("left".into())); }) }]);
    assert_eq!(d.paragraphs.iter().map(|p| (p.list_kind, p.list_number)).collect::<Vec<_>>(), vec![(Some(ListKind::Bullet), None), (Some(ListKind::Numbered), Some(1)), (Some(ListKind::Numbered), Some(2)), (None, None)]);
    let saved = reopen(&d);
    assert!(saved.can_edit); assert_eq!(saved.text, original.text);
    assert_eq!((saved.paragraphs[2].list_kind, saved.paragraphs[2].list_number), (Some(ListKind::Numbered), Some(2)));
    let cleared = apply(&d, &[list("p1", None)]);
    assert_eq!(reopen(&cleared).paragraphs[1].list_kind, None);
    assert_eq!(cleared.paragraphs[1].spacing_after_points, Some(6.0));
}
#[test]
fn accepts_valid_multilevel_and_fails_closed_for_a_corrupted_level_start() {
    let original = apply(&create("A"), &[Operation::SetList { paragraph_id: "p0".into(), kind: Some(ListKind::Numbered) }]);
    let mut parts = read_zip(&export(&original), DEFAULT_ZIP_LIMITS).unwrap();
    change_xml(&mut parts, "word/numbering.xml", |x| x.replace(r#"w:val="singleLevel""#, r#"w:val="multilevel""#));
    let accepted = open(&write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap());
    assert!(accepted.can_edit);
    let p = &accepted.paragraphs[0];
    assert_eq!((p.list_kind, p.list_level, p.list_number), (Some(ListKind::Numbered), Some(0), Some(1)));
    change_xml(&mut parts, "word/numbering.xml", |x| x.replace(r#"<w:start w:val="1"/>"#, r#"<w:start w:val="many"/>"#));
    let bytes = write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap();
    let readonly = open(&bytes);
    assert!(!readonly.can_edit); assert!(readonly.diagnostics.iter().any(|d| d.code == "unsupported-numbering"));
    assert_eq!(export(&readonly), bytes);
}

// ---- docx-parts.test.ts ----
#[test]
fn adds_the_main_relationship_type_declaration_for_new_parts() {
    for label in ["styles", "comments", "numbering"] {
        let mut parts = read_zip(&export(&create("Original")), DEFAULT_ZIP_LIMITS).unwrap();
        change_xml(&mut parts, "[Content_Types].xml", |x| {
            let s = x.find(r#"<Default Extension="rels""#).unwrap(); let e = s + x[s..].find("/>").unwrap() + 2;
            format!("{}{}{}", &x[..s], r#"<Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#, &x[e..])
        });
        let bytes = write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap();
        let original = open(&bytes);
        assert!(original.can_edit); assert_eq!(export(&original), bytes);
        let op = match label {
            "styles" => Operation::FormatParagraph { paragraph_id: "p0".into(), format: pformat(|p| p.style_id = Some(Some("Heading1".into()))) },
            "comments" => Operation::AddComment { paragraph_id: "p0".into(), author: "A".into(), text: "Portable comment".into() },
            _ => Operation::SetList { paragraph_id: "p0".into(), kind: Some(ListKind::Numbered) },
        };
        let candidate = export(&apply(&original, &[op]));
        let r = open(&candidate);
        assert!(r.can_edit, "{label}"); assert_eq!(r.text, "Original");
        assert!(part(&candidate, "[Content_Types].xml").unwrap().contains(r#"PartName="/word/_rels/document.xml.rels""#));
        assert!(part(&candidate, &format!("word/{label}.xml")).is_some());
        match label {
            "styles" => assert_eq!(r.paragraphs[0].style_id.as_deref(), Some("Heading1")),
            "comments" => assert_eq!(r.comments[0].text, "Portable comment"),
            _ => assert_eq!(r.paragraphs[0].list_kind, Some(ListKind::Numbered)),
        }
        assert_eq!(export(&original), bytes);
    }
}
