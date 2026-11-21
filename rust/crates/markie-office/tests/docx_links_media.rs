//! Port of docx-hyperlinks.test.ts, docx-page-breaks.test.ts and docx-media.test.ts.
#[path = "common/docx_fixture.rs"]
mod docx_fixture;
use docx_fixture::*;

fn create(text: &str) -> DocxDocument { create_docx(text).unwrap() }
fn link(p: &str, start: usize, end: usize, target: &str) -> Operation { Operation::SetHyperlink { paragraph_id: p.into(), start, end, target: target.into() } }
fn s(v: &str) -> String { v.into() }

// ---- hyperlinks ----
#[test]
fn wraps_only_selected_text_in_an_external_relationship() {
    let original = create("Read this document now");
    let d = apply(&original, &[link("p0", 10, 18, "https://example.com/docs?q=one&x=two")]);
    assert_eq!(d.text, original.text);
    let h = &d.hyperlinks[0];
    assert_eq!((h.text.as_str(), h.target.as_str(), h.paragraph_id.as_str()), ("document", "https://example.com/docs?q=one&x=two", "p0"));
    assert_eq!(d.paragraphs[0].runs.iter().find(|r| r.text == "document").unwrap().target.as_deref(), Some(h.target.as_str()));
    let bytes = export(&d);
    assert!(document_xml(&bytes).contains("<w:hyperlink "));
    assert!(part(&bytes, "word/_rels/document.xml.rels").unwrap().contains(r#"TargetMode="External""#));
    let saved = open(&bytes);
    assert!(saved.can_edit); assert_eq!(saved.hyperlinks[0].target, h.target);
    assert!(original.hyperlinks.is_empty());
}
#[test]
fn keeps_formatting_and_comments_through_linking_editing_and_unlinking() {
    let mut d = apply(&create("Hello World"), &[Operation::FormatRange { paragraph_id: "p0".into(), start: 6, end: 11, style: fmt(|f| f.bold = Some(Some(true))) }, link("p0", 0, 11, "mailto:writer@example.com"), Operation::AddComment { paragraph_id: "p0".into(), author: "A".into(), text: "Comment survives".into() }]);
    assert_eq!(d.comments.len(), 1);
    let run = d.paragraphs[0].runs.iter().find(|r| r.text == "World").unwrap().id.clone();
    d = replace(&d, &run, "Earth");
    d = apply(&d, &[Operation::FormatRange { paragraph_id: "p0".into(), start: 1, end: 9, style: fmt(|f| f.italic = Some(Some(true))) }]);
    assert_eq!(d.hyperlinks[0].text, "Hello Earth");
    let saved = reopen(&d);
    assert!(saved.can_edit); assert_eq!(saved.comments[0].text, "Comment survives");
    assert_eq!(saved.paragraphs[0].runs.iter().filter(|r| !r.text.is_empty() && r.style.bold == Some(true)).map(|r| r.text.as_str()).collect::<String>(), "Earth");
    let removed = apply(&d, &[Operation::RemoveHyperlink { hyperlink_id: d.hyperlinks[0].id.clone() }]);
    let r = reopen(&removed);
    assert_eq!(r.text, "Hello Earth"); assert!(r.hyperlinks.is_empty()); assert_eq!(r.comments.len(), 1);
    assert!(!part(&export(&removed), "word/_rels/document.xml.rels").unwrap().contains("mailto:"));
}
#[test]
fn updates_one_link_without_changing_another_sharing_its_relationship() {
    let original = apply(&create("Link"), &[link("p0", 0, 4, "https://example.com/private-token")]);
    let bytes = swap_part(&export(&original), "word/document.xml", |x| {
        let s = x.find("<w:hyperlink").unwrap(); let e = x.find("</w:hyperlink>").unwrap() + "</w:hyperlink>".len();
        let l = x[s..e].to_string(); x.replacen(&l, &format!("{l}{l}"), 1)
    });
    let d = open(&bytes);
    let second = d.hyperlinks[1].id.clone();
    let updated = apply(&d, &[Operation::UpdateHyperlink { hyperlink_id: d.hyperlinks[0].id.clone(), target: "https://other.example/path".into() }]);
    assert_eq!(updated.hyperlinks.iter().map(|l| l.target.as_str()).collect::<Vec<_>>(), vec!["https://other.example/path", "https://example.com/private-token"]);
    assert_eq!(updated.hyperlinks[1].id, second);
    let removed = apply(&updated, &[Operation::RemoveHyperlink { hyperlink_id: updated.hyperlinks[0].id.clone() }, Operation::RemoveHyperlink { hyperlink_id: second }]);
    assert_eq!(reopen(&removed).text, "LinkLink");
    let rels = part(&export(&removed), "word/_rels/document.xml.rels").unwrap();
    assert!(!rels.contains("private-token") && !rels.contains("other.example"));
}
#[test]
fn declares_new_main_relationship_parts_for_override_only_manifests() {
    let d = open(&override_only_rels(&export(&create("Link"))));
    let linked = apply(&d, &[link("p0", 0, 4, "https://example.com")]);
    assert!(reopen(&linked).can_edit);
}
#[test]
fn rejects_unsafe_or_unsupported_targets() {
    for target in ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://example.com", "//example.com", "https:example.com", "https://user:password@example.com", "https://example.com/\npath", "https://example.com/%0Aheader", "https://example.com/%00", "https://example.com\\evil", " https://example.com", "https://example.com\u{a0}", "mailto:user@example.com?bcc=other@example.com", "mailto:user%0d%0a@example.com", "mailto:bad"] {
        assert!(safe_docx_hyperlink_target(target).is_err(), "{target:?}");
    }
}
#[test]
fn keeps_malicious_imported_targets_read_only_and_rejects_flattening() {
    let original = apply(&create("Link\nOther"), &[link("p0", 0, 4, "https://example.com")]);
    assert!(apply_err(&original, &[Operation::ReplaceParagraph { paragraph_id: "p0".into(), text: "Flatten".into() }]).contains("Remove hyperlinks"));
    assert!(apply_err(&original, &[Operation::TrackParagraphText { paragraph_id: "p0".into(), text: "Flatten".into(), author: "A".into() }]).contains("Remove hyperlinks"));
    let bytes = swap_part(&export(&original), "word/_rels/document.xml.rels", |x| x.replace("https://example.com/", "javascript:alert(1)"));
    let readonly = open(&bytes);
    assert!(!readonly.can_edit); assert_eq!(export(&readonly), bytes);
}

// ---- page breaks ----
fn page_break(p: &str, offset: usize) -> Operation { Operation::InsertPageBreak { paragraph_id: p.into(), offset } }
#[test]
fn inserts_a_page_break_at_a_caret_preserving_text_and_formatting() {
    let original = apply(&create("BeforeAfter"), &[Operation::FormatRun { run_id: "p0:r0".into(), style: fmt(|f| f.bold = Some(Some(true))) }, Operation::AddComment { paragraph_id: "p0".into(), author: "A".into(), text: "Keep anchor".into() }]);
    let d = apply(&original, &[page_break("p0", 6)]);
    assert_eq!(d.text, "BeforeAfter"); assert_eq!(d.page_breaks[0].offset, 6);
    assert_eq!(d.paragraphs[0].runs.iter().filter(|r| !r.text.is_empty()).map(|r| (r.text.clone(), r.style.bold)).collect::<Vec<_>>(), vec![(s("Before"), Some(true)), (s("After"), Some(true))]);
    assert_eq!(d.paragraphs[0].runs.iter().find(|r| !r.page_breaks.is_empty()).unwrap().page_breaks[0].offset, 0);
    assert!(document_xml(&export(&d)).contains(r#"<w:br w:type="page"/>"#));
    let saved = reopen(&d);
    assert!(saved.can_edit); assert_eq!(saved.page_breaks[0].offset, 6); assert_eq!(saved.comments.len(), 1);
    let removed = apply(&d, &[Operation::RemovePageBreak { page_break_id: d.page_breaks[0].id.clone() }]);
    assert!(reopen(&removed).page_breaks.is_empty());
}
#[test]
fn removes_only_the_break_when_an_imported_run_also_has_text() {
    let bytes = swap_part(&export(&create("KEEP TEXT")), "word/document.xml", |x| x.replacen("</w:t>", r#"</w:t><w:br w:type="page"/>"#, 1));
    let d = open(&bytes);
    assert!(d.can_edit); assert_eq!(d.page_breaks[0].offset, 9);
    assert_eq!(export(&d), bytes);
    let saved = reopen(&apply(&d, &[Operation::RemovePageBreak { page_break_id: d.page_breaks[0].id.clone() }]));
    assert_eq!(saved.text, "KEEP TEXT"); assert!(saved.page_breaks.is_empty());
}
#[test]
fn supports_boundary_and_empty_paragraphs_and_blocks_unsafe_offsets() {
    let blank = apply(&create(""), &[page_break("p0", 0)]);
    assert_eq!(reopen(&blank).page_breaks.len(), 1);
    // UTF-8 offsets: the emoji spans 1..5, so 2 splits it and 5 follows it (TypeScript: 2 and 3).
    let original = create("A😀B\nOther");
    for offset in [2usize, 99] { assert!(apply_docx_operations(&original, &[page_break("p0", offset)]).is_err(), "{offset}"); }
    let d = apply(&original, &[page_break("p0", 5)]);
    assert!(apply_err(&d, &[Operation::ReplaceParagraph { paragraph_id: "p0".into(), text: "Flatten".into() }]).contains("Remove hyperlinks"));
    assert!(apply_docx_operations(&d, &[Operation::DeleteParagraph { paragraph_id: "p0".into() }]).is_err());
    assert!(apply_docx_operations(&d, &[Operation::TrackParagraphText { paragraph_id: "p0".into(), text: "Tracked".into(), author: "A".into() }]).is_err());
    assert!(original.page_breaks.is_empty());
}
#[test]
fn preserves_line_and_column_breaks_verbatim_in_a_read_only_run() {
    for br in ["<w:br/>", r#"<w:br w:type="textWrapping"/>"#, r#"<w:br w:type="column"/>"#, r#"<w:br w:type="textWrapping" w:clear="all"/>"#] {
        let bytes = swap_part(&export(&create("A\nOther")), "word/document.xml", |x| x.replacen("A</w:t>", &format!("A</w:t>{br}<w:t>B</w:t>"), 1));
        let d = open(&bytes);
        assert!(d.can_edit, "{br}"); assert!(d.page_breaks.is_empty());
        assert_eq!((d.paragraphs[0].runs[0].text.as_str(), d.paragraphs[0].runs[0].can_edit), ("A\nB", false));
        assert!(apply_err(&d, &[Operation::ReplaceParagraph { paragraph_id: d.paragraphs[0].id.clone(), text: "Flatten".into() }]).contains("line breaks"));
        assert!(apply_err(&d, &[Operation::FormatRange { paragraph_id: d.paragraphs[0].id.clone(), start: 0, end: 1, style: fmt(|f| f.bold = Some(Some(true))) }]).contains("mixed"));
        let output = export(&replace(&d, &d.paragraphs[1].runs[0].id, "Edited"));
        assert!(document_xml(&output).contains(&format!("A</w:t>{br}<w:t>B</w:t>")));
        assert_eq!(export(&d), bytes);
    }
}
#[test]
fn places_page_break_offsets_on_visible_text_after_a_tab() {
    let bytes = swap_part(&export(&create("A")), "word/document.xml", |x| {
        let s = x.find("<w:r>").unwrap(); let e = x.find("</w:r>").unwrap() + 6;
        format!("{}{}{}", &x[..s], r#"<w:r><w:tab/></w:r><w:r><w:t>A</w:t><w:br w:type="page"/></w:r>"#, &x[e..])
    });
    let d = open(&bytes);
    assert!(d.can_edit); assert_eq!(d.paragraphs[0].text, "\tA"); assert_eq!(d.page_breaks[0].offset, 2);
    let inserted = apply(&d, &[page_break(&d.paragraphs[0].id, 1)]);
    assert_eq!(reopen(&inserted).page_breaks.iter().map(|b| b.offset).collect::<Vec<_>>(), vec![1, 2]);
}
#[test]
fn keeps_unsupported_breaks_read_only() {
    for br in [r#"<w:br w:type="page" w:clear="all"/>"#, r#"<w:br w:type="unknown"/>"#] {
        let bytes = swap_part(&export(&create("A")), "word/document.xml", |x| x.replacen("</w:t>", &format!("</w:t>{br}"), 1));
        let d = open(&bytes);
        assert!(!d.can_edit, "{br}"); assert_eq!(export(&d), bytes);
    }
}

// ---- media ----
#[test]
fn inserts_real_drawingml_parts_and_reopens_exact_image_bytes() {
    let original = create("Before\nAfter");
    let op = Operation::InsertImage(ImageInput { after_paragraph_id: InsertAt::After("p0".into()), bytes: png(1, 1), content_type: ImageType::Png, width_points: 120.0, height_points: 80.0, alt_text: Some("Red <&> \"pixel\"".into()) });
    let d = apply(&original, &[op]);
    assert_eq!(d.blocks.len(), 3);
    let i = &d.images[0];
    assert_eq!((i.width_points, i.height_points, i.alt_text.as_str(), i.content_type), (120.0, 80.0, "Red <&> \"pixel\"", ImageType::Png));
    let mut copy = get_docx_image_bytes(&d, &i.id).unwrap(); assert_eq!(copy, png(1, 1)); copy.fill(0);
    assert_eq!(get_docx_image_bytes(&d, &i.id).unwrap(), png(1, 1));
    let r = reopen(&d);
    assert!(r.can_edit); assert_eq!(r.images.len(), 1);
    assert_eq!(get_docx_image_bytes(&r, &r.images[0].id).unwrap(), png(1, 1));
    assert!(original.images.is_empty());
}
#[test]
fn deletes_image_payloads_relationships_and_overrides() {
    let d = apply(&create("A"), &[image(InsertAt::End, 72.0, 72.0)]);
    let pid = d.images[0].paragraph_id.clone();
    assert!(apply_err(&d, &[Operation::ReplaceParagraph { paragraph_id: pid.clone(), text: "Removed?".into() }]).contains("explicitly"));
    assert!(apply_err(&d, &[Operation::DeleteParagraph { paragraph_id: pid }]).contains("explicitly"));
    let deleted = apply(&d, &[Operation::DeleteImage { image_id: d.images[0].id.clone() }]);
    let bytes = export(&deleted);
    let parts = read_zip(&bytes, DEFAULT_ZIP_LIMITS).unwrap();
    assert!(!parts.iter().any(|p| p.name.contains("/media/")));
    assert!(!part(&bytes, "[Content_Types].xml").unwrap().contains("image/png"));
    assert!(!part(&bytes, "word/_rels/document.xml.rels").unwrap().contains("/image\""));
    assert!(open(&bytes).images.is_empty());
    assert_eq!(get_docx_image_bytes(&d, &d.images[0].id).unwrap(), png(1, 1));
    let again = apply(&deleted, &[image(InsertAt::End, 72.0, 72.0)]);
    assert_ne!(again.images[0].id, d.images[0].id);
    assert_eq!(reopen(&again).images.len(), 1);
}
#[test]
fn retains_media_exactness_while_formatting_text_and_page() {
    let d = apply(&create("A"), &[image(InsertAt::End, 72.0, 72.0), Operation::FormatRun { run_id: "p0:r0".into(), style: fmt(|f| f.bold = Some(Some(true))) }, Operation::SetPageLayout { layout: PageLayoutChange { orientation: Some(Orientation::Landscape), ..Default::default() } }]);
    let saved = reopen(&d);
    assert_eq!(saved.paragraphs[0].runs[0].style.bold, Some(true));
    assert_eq!(get_docx_image_bytes(&saved, &saved.images[0].id).unwrap(), png(1, 1));
}
#[test]
fn deletes_only_the_drawing_when_its_run_also_has_text() {
    let original = apply(&create("A"), &[image(InsertAt::End, 72.0, 72.0)]);
    let d = open(&swap_part(&export(&original), "word/document.xml", |x| x.replacen("<w:drawing>", "<w:t>KEEP TEXT</w:t><w:drawing>", 1)));
    assert!(d.can_edit, "{:?}", d.diagnostics); assert!(d.text.contains("KEEP TEXT"));
    let saved = reopen(&apply(&d, &[Operation::DeleteImage { image_id: d.images[0].id.clone() }]));
    assert!(saved.text.contains("KEEP TEXT")); assert!(saved.images.is_empty());
}
#[test]
fn rejects_forged_oversized_truncated_and_corrupt_rasters() {
    assert_eq!(inspect_docx_bitmap(&png(1, 1), ImageType::Png).unwrap(), Bitmap { width: 1, height: 1 });
    let mut corrupt = png(1, 1); corrupt[20] ^= 1;
    let truncated = png(1, 1)[..png(1, 1).len() - 2].to_vec();
    for bytes in [vec![0u8; 16], truncated, corrupt, png(20000, 20000)] { assert!(inspect_docx_bitmap(&bytes, ImageType::Png).is_err()); }
    assert!(inspect_docx_bitmap(&png(1, 1), ImageType::Jpeg).unwrap_err().message.contains("JPEG"));
    assert!(inspect_docx_bitmap(&vec![0u8; 9 * 1024 * 1024], ImageType::Png).unwrap_err().message.contains("byte"));
}
#[test]
fn fails_closed_for_unsupported_picture_effects() {
    let d = apply(&create("A"), &[image(InsertAt::End, 72.0, 72.0)]);
    let bytes = swap_part(&export(&d), "word/document.xml", |x| x.replace(r#"prst="rect""#, r#"prst="ellipse""#));
    let readonly = open(&bytes);
    assert!(!readonly.can_edit); assert!(readonly.diagnostics.iter().any(|x| x.code == "unsupported-image"));
    assert_eq!(export(&readonly), bytes);
}
#[test]
fn refuses_deletion_when_another_alias_owns_the_image() {
    let original = apply(&create("A"), &[image(InsertAt::End, 72.0, 72.0)]);
    let bytes = swap_part(&export(&original), "word/_rels/document.xml.rels", |x| x.replace("</Relationships>", r#"<Relationship Id="unusedImageAlias" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/markie-image1.png"/></Relationships>"#));
    let d = open(&bytes);
    assert!(d.can_edit);
    assert!(apply_err(&d, &[Operation::DeleteImage { image_id: d.images[0].id.clone() }]).contains("another package owner"));
    assert_eq!(export(&d), bytes);
    assert_eq!(get_docx_image_bytes(&d, &d.images[0].id).unwrap(), png(1, 1));
}
#[test]
fn declares_main_relationship_parts_for_image_insertion_into_override_only_manifests() {
    let bytes = override_only_rels(&export(&create("Original")));
    let original = open(&bytes);
    let saved = reopen(&apply(&original, &[image(InsertAt::End, 72.0, 72.0)]));
    assert!(saved.can_edit); assert_eq!(saved.images.len(), 1);
    assert_eq!(export(&original), bytes);
}

#[test]
fn normalizes_link_targets_like_the_url_serializer() {
    assert_eq!(safe_docx_hyperlink_target("HTTPS://Example.COM").unwrap(), "https://example.com/");
    assert_eq!(safe_docx_hyperlink_target("https://example.com:443/a").unwrap(), "https://example.com/a");
    assert_eq!(safe_docx_hyperlink_target("http://example.com:8080?q=1").unwrap(), "http://example.com:8080/?q=1");
    assert_eq!(safe_docx_hyperlink_target("https://example.com/caf\u{e9}?x=\"y\"#\u{e9}").unwrap(), "https://example.com/caf%C3%A9?x=%22y%22#%C3%A9");
    assert_eq!(safe_docx_hyperlink_target("MAILTO:writer@example.com").unwrap(), "mailto:writer@example.com");
    // Internationalized host names need IDNA mapping, which this port refuses rather than guesses.
    assert!(safe_docx_hyperlink_target("https://ex\u{e4}mple.com/").is_err());
}
