//! Port of docx-comments.test.ts, docx-revisions.test.ts and docx-revisions-range.test.ts.
#[path = "common/docx_fixture.rs"]
mod docx_fixture;
use docx_fixture::*;

fn create(text: &str) -> DocxDocument { create_docx(text).unwrap() }
fn comment(p: &str, author: &str, text: &str) -> Operation { Operation::AddComment { paragraph_id: p.into(), author: author.into(), text: text.into() } }
fn track(p: &str, text: &str, author: &str) -> Operation { Operation::TrackParagraphText { paragraph_id: p.into(), text: text.into(), author: author.into() } }
fn range(p: &str, start: usize, end: usize, style: RunFormat) -> Operation { Operation::FormatRange { paragraph_id: p.into(), start, end, style } }
fn texts(d: &DocxDocument) -> Vec<String> { d.comments.iter().map(|c| c.text.clone()).collect() }
fn runs_bold(p: &Paragraph) -> Vec<(String, Option<bool>)> { p.runs.iter().filter(|r| !r.text.is_empty()).map(|r| (r.text.clone(), r.style.bold)).collect() }
fn s(v: &str) -> String { v.to_string() }

// ---- comments ----
#[test]
fn adds_exports_and_reopens_comments_with_relationships() {
    let original = create("Discuss this\nAnother paragraph");
    let d = apply(&original, &[comment(&original.paragraphs[0].id, "Writer \"A\"", "First line <&>\nSecond 😀")]);
    assert_eq!(d.comments.len(), 1);
    let c = &d.comments[0];
    assert_eq!((c.paragraph_id.as_str(), c.author.as_str(), c.text.as_str()), (original.paragraphs[0].id.as_str(), "Writer \"A\"", "First line <&>\nSecond 😀"));
    assert!(c.date.as_deref().unwrap().as_bytes()[..4].iter().all(u8::is_ascii_digit));
    assert!(original.comments.is_empty());
    let bytes = export(&d); let r = open(&bytes);
    assert!(r.can_edit); assert_eq!(r.text, original.text);
    assert_eq!((r.comments[0].author.as_str(), r.comments[0].text.as_str()), ("Writer \"A\"", "First line <&>\nSecond 😀"));
    assert!(part(&bytes, "word/comments.xml").is_some());
    assert!(part(&bytes, "word/_rels/document.xml.rels").unwrap().contains("/comments"));
    assert!(part(&bytes, "[Content_Types].xml").unwrap().contains("wordprocessingml.comments+xml"));
}
#[test]
fn preserves_whole_paragraph_anchors_through_edits() {
    let original = create("Original\nNext");
    let pid = original.paragraphs[0].id.clone();
    let mut d = apply(&original, &[comment(&pid, "A", "Keep anchor")]);
    d = replace(&d, &d.paragraphs[0].runs[0].id.clone(), "Run changed");
    d = apply(&d, &[Operation::ReplaceParagraph { paragraph_id: pid.clone(), text: "Paragraph changed".into() }, Operation::InsertParagraph { after_paragraph_id: InsertAt::Start, text: "Before".into() }]);
    assert_eq!(d.comments[0].paragraph_id, pid);
    assert_eq!(d.paragraph(&pid).unwrap().text, "Paragraph changed");
    let r = reopen(&d);
    assert!(r.can_edit);
    assert_eq!(r.paragraph(&r.comments[0].paragraph_id).unwrap().text, "Paragraph changed");
}
#[test]
fn handles_several_comments_and_deletion() {
    let original = create("Commented\nOther");
    let pid = original.paragraphs[0].id.clone();
    let mut d = apply(&original, &[comment(&pid, "A", "One"), comment(&pid, "B", "Two")]);
    assert_eq!(texts(&d), vec!["One", "Two"]);
    d = apply(&d, &[Operation::DeleteComment { comment_id: d.comments[0].id.clone() }]);
    assert_eq!(texts(&reopen(&d)), vec!["Two"]);
    d = apply(&d, &[Operation::DeleteComment { comment_id: d.comments[0].id.clone() }, Operation::DeleteParagraph { paragraph_id: pid }]);
    let r = reopen(&d);
    assert!(r.comments.is_empty()); assert_eq!(r.text, "Other"); assert!(r.can_edit);
}
#[test]
fn protects_comments_from_implicit_deletion() {
    let original = create("A\nB");
    let d = apply(&original, &[comment(&original.paragraphs[0].id, "A", "Protected anchor")]);
    assert!(apply_err(&d, &[Operation::DeleteParagraph { paragraph_id: original.paragraphs[0].id.clone() }]).contains("comments"));
    let table = apply(&original, &[Operation::InsertTable { after_paragraph_id: InsertAt::End, rows: 1, columns: 1, cells: None }]);
    let commented = apply(&table, &[comment(&table.tables[0].rows[0].cells[0].paragraph_ids[0], "A", "Cell comment")]);
    assert!(apply_err(&commented, &[Operation::DeleteTable { table_id: table.tables[0].id.clone() }]).contains("comments"));
    assert_eq!(reopen(&commented).comments.len(), 1);
}
fn regex_remove(x: &str, start_pat: &str, end_pat: &str) -> String {
    let s = x.find(start_pat).unwrap(); let e = s + x[s..].find(end_pat).unwrap() + end_pat.len();
    format!("{}{}", &x[..s], &x[e..])
}
#[test]
fn fails_closed_for_partial_ranges_orphans_and_formatted_comments() {
    let original = create("A");
    let d = apply(&original, &[comment(&original.paragraphs[0].id, "A", "Comment")]);
    for variant in ["missing-end", "missing-comment", "partial-range", "formatted-comment"] {
        let mut parts = read_zip(&export(&d), DEFAULT_ZIP_LIMITS).unwrap();
        match variant {
            "missing-end" => change_xml(&mut parts, "word/document.xml", |x| regex_remove(x, "<w:commentRangeEnd", "/>")),
            "missing-comment" => change_xml(&mut parts, "word/comments.xml", |x| regex_remove(x, "<w:comment ", "</w:comment>")),
            "partial-range" => change_xml(&mut parts, "word/document.xml", |x| {
                let s = x.find("<w:commentRangeStart").unwrap(); let e = s + x[s..].find("/>").unwrap() + 2;
                let marker = x[s..e].to_string();
                assert!(x[e..].starts_with("<w:r>"));
                format!("{}<w:r>{marker}{}", &x[..s], &x[e + 5..])
            }),
            _ => change_xml(&mut parts, "word/comments.xml", |x| x.replacen("<w:r>", "<w:r><w:rPr><w:b/></w:rPr>", 1)),
        }
        let bytes = write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap();
        let readonly = open(&bytes);
        assert!(!readonly.can_edit, "{variant}");
        assert_eq!(export(&readonly), bytes);
    }
}
#[test]
fn validates_comment_fields_and_unknown_ids() {
    let d = create("A");
    for op in [comment("p0", "", "A"), comment("p0", "A", ""), comment("p0", "A", "A\u{0}"), comment("absent", "A", "A"), Operation::DeleteComment { comment_id: "absent".into() }] {
        assert!(apply_docx_operations(&d, &[op]).is_err());
    }
    assert!(d.comments.is_empty()); assert!(!d.modified);
}

// ---- revisions ----
const ATTRS: &str = r#"w:id="1" w:author="Reviewer" w:date="2026-10-15T05:00:00Z""#;
fn incoming(content: &str) -> Vec<u8> {
    let mut parts = read_zip(&export(&create("Baseline")), DEFAULT_ZIP_LIMITS).unwrap();
    change_xml(&mut parts, "word/document.xml", |_| format!(r#"<w:document xmlns:w="{W}"><w:body>{content}</w:body></w:document>"#));
    write_zip(&parts, DEFAULT_ZIP_LIMITS).unwrap()
}
fn kinds(d: &DocxDocument) -> Vec<RevisionKind> { d.revisions.iter().map(|r| r.kind).collect() }
#[test]
fn writes_authored_deletion_and_insertion_ranges_with_views() {
    let original = create("Original 😀\nOther paragraph");
    let d = apply(&original, &[track("p0", "Replacement <&>", "Writer \"A\"")]);
    assert_eq!(d.text, "Replacement <&>\nOther paragraph");
    assert_eq!(d.original_text.as_deref(), Some(original.text.as_str()));
    let v: Vec<(RevisionKind, &str, &str)> = d.revisions.iter().map(|r| (r.kind, r.text.as_str(), r.author.as_str())).collect();
    assert_eq!(v, vec![(RevisionKind::Deletion, "Original 😀", "Writer \"A\""), (RevisionKind::Insertion, "Replacement <&>", "Writer \"A\"")]);
    assert_ne!(d.revisions[0].id, d.revisions[1].id);
    assert!(d.revisions.iter().all(|r| r.date.len() > 11 && r.date.as_bytes()[10] == b'T'));
    assert_eq!(d.paragraphs[0].revision_ids.len(), 2);
    let xml = document_xml(&export(&d));
    for needle in ["<w:del ", "<w:delText", "Original 😀", "<w:ins "] { assert!(xml.contains(needle), "{needle}"); }
    let saved = reopen(&d);
    assert!(saved.can_edit); assert_eq!(saved.text, d.text); assert_eq!(saved.original_text, Some(original.text.clone()));
    assert_eq!(saved.revisions, d.revisions);
    assert!(original.revisions.is_empty());
}
#[test]
fn preserves_deleted_run_formatting_paragraph_properties_and_comments() {
    let original = apply(&create("Bold plain"), &[
        range("p0", 0, 4, fmt(|f| { f.bold = Some(Some(true)); f.color = Some(Some("123456".into())); })),
        Operation::FormatParagraph { paragraph_id: "p0".into(), format: ParagraphFormat { alignment: Some(Some("center".into())), spacing_after_points: Some(Some(12.0)), ..Default::default() } },
        comment("p0", "C", "Comment stays"),
    ]);
    let d = apply(&original, &[track("p0", "New text", "R")]);
    assert_eq!(d.comments[0].text, "Comment stays");
    let p = &d.paragraphs[0];
    assert_eq!((p.original_text.as_deref(), p.text.as_str(), p.alignment.as_deref(), p.spacing_after_points), (Some("Bold plain"), "New text", Some("center"), Some(12.0)));
    let originals: Vec<(String, Option<bool>)> = p.original_runs.as_ref().unwrap().iter().filter(|r| !r.text.is_empty()).map(|r| (r.text.clone(), r.style.bold)).collect();
    assert_eq!(originals, vec![(s("Bold"), Some(true)), (s(" plain"), None)]);
    let saved = reopen(&apply(&d, &[Operation::RejectAllRevisions]));
    assert_eq!(saved.text, original.text); assert!(saved.revisions.is_empty());
    assert_eq!(saved.comments[0].text, "Comment stays");
    assert_eq!(runs_bold(&saved.paragraphs[0]), vec![(s("Bold"), Some(true)), (s(" plain"), None)]);
}
#[test]
fn accepts_all_ranges_and_removes_old_text_and_provenance() {
    let tracked = apply(&create("OLD PRIVATE TEXT"), &[track("p0", "Final", "Revision Author")]);
    let accepted = apply(&tracked, &[Operation::AcceptAllRevisions]);
    let xml = document_xml(&export(&accepted));
    for needle in ["OLD PRIVATE TEXT", "Revision Author", "delText", "<w:del ", "<w:del>", "<w:ins ", "<w:ins>"] { assert!(!xml.contains(needle), "{needle}"); }
    let saved = reopen(&accepted);
    assert_eq!(saved.text, "Final"); assert_eq!(saved.original_text.as_deref(), Some("Final")); assert!(saved.revisions.is_empty());
    assert_eq!(tracked.original_text.as_deref(), Some("OLD PRIVATE TEXT"));
}
#[test]
fn supports_accepting_and_rejecting_one_range() {
    let tracked = apply(&create("Old"), &[track("p0", "New", "R")]);
    let deletion = tracked.revisions.iter().find(|r| r.kind == RevisionKind::Deletion).unwrap().id.clone();
    let insertion = tracked.revisions.iter().find(|r| r.kind == RevisionKind::Insertion).unwrap().id.clone();
    let reject_deletion = apply(&tracked, &[Operation::RejectRevision { revision_id: deletion.clone() }]);
    assert_eq!(reject_deletion.text, "OldNew");
    assert_eq!(reject_deletion.revisions.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![insertion.clone()]);
    assert_eq!(reopen(&apply(&reject_deletion, &[Operation::AcceptRevision { revision_id: insertion.clone() }])).text, "OldNew");
    let accept_deletion = apply(&tracked, &[Operation::AcceptRevision { revision_id: deletion }]);
    assert_eq!(reopen(&apply(&accept_deletion, &[Operation::RejectRevision { revision_id: insertion }])).text, "");
}
#[test]
fn coalesces_continuous_same_author_typing() {
    let mut d = apply(&create("Original"), &[track("p0", "N", "R")]);
    let ids: Vec<String> = d.revisions.iter().map(|r| r.id.clone()).collect();
    for text in ["Ne", "New", "New text"] { d = apply(&d, &[track("p0", text, "R")]); }
    assert_eq!(d.revisions.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), ids);
    assert_eq!(d.original_text.as_deref(), Some("Original")); assert_eq!(d.text, "New text");
    assert!(apply_err(&d, &[track("p0", "Other author", "Someone else")]).contains("Resolve"));
    assert_eq!(reopen(&d).revisions.len(), 2);
}
#[test]
fn tracks_insertion_only_and_deletion_only_edits_and_keeps_empty_anchors() {
    let inserted = apply(&create(""), &[track("p0", "Inserted", "R")]);
    assert_eq!(kinds(&inserted), vec![RevisionKind::Insertion]);
    assert_eq!(inserted.original_text.as_deref(), Some(""));
    assert_eq!(reopen(&apply(&inserted, &[Operation::RejectAllRevisions])).text, "");
    let original = apply(&create("Delete me"), &[comment("p0", "C", "Anchor")]);
    let deleted = apply(&original, &[track("p0", "", "R")]);
    assert_eq!(kinds(&deleted), vec![RevisionKind::Deletion]);
    assert_eq!(deleted.comments.len(), 1);
    let saved = reopen(&apply(&deleted, &[Operation::AcceptAllRevisions]));
    assert_eq!(saved.text, ""); assert_eq!(saved.comments.len(), 1); assert!(saved.can_edit);
}
#[test]
fn coalesces_insertion_back_to_an_empty_formatted_commented_paragraph() {
    let original = apply(&create(""), &[Operation::FormatRun { run_id: "p0:r0".into(), style: fmt(|f| f.bold = Some(Some(true))) }, comment("p0", "C", "Point comment")]);
    let typed = apply(&original, &[track("p0", "Typed", "R")]);
    let emptied = apply(&typed, &[track("p0", "", "R")]);
    let saved = reopen(&emptied);
    assert_eq!(saved.text, ""); assert_eq!(saved.comments.len(), 1); assert!(saved.revisions.is_empty());
    assert_eq!(saved.paragraphs[0].runs[0].style.bold, Some(true));
    let again = apply(&emptied, &[track("p0", "Again", "R")]);
    assert_ne!(again.revisions[0].id, typed.revisions[0].id);
}
#[test]
fn rejects_untracked_destruction_through_ordinary_apis() {
    let d = apply(&create("Old\nOther"), &[track("p0", "New", "R")]);
    let id = d.paragraphs[0].runs[0].id.clone();
    assert!(replace_docx_text(&d, &edit(&id, "Flatten")).is_err());
    assert!(apply_err(&d, &[Operation::ReplaceParagraph { paragraph_id: "p0".into(), text: "Flatten".into() }]).contains("Resolve"));
    assert!(apply_err(&d, &[Operation::DeleteParagraph { paragraph_id: "p0".into() }]).contains("Resolve"));
    assert!(apply_err(&d, &[range("p0", 0, 1, fmt(|f| f.bold = Some(Some(true))))]).contains("Resolve"));
    let other = apply(&d, &[Operation::ReplaceParagraph { paragraph_id: "p1".into(), text: "Other edited".into() }]);
    assert_eq!(reopen(&other).revisions.len(), 2);
}
#[test]
fn keeps_unsupported_incoming_revision_combinations_read_only() {
    let cases = [
        format!(r#"<w:p><w:ins {ATTRS}><w:ins w:id="2" w:author="R" w:date="2026-10-15T05:00:00Z"><w:r><w:t>N</w:t></w:r></w:ins></w:ins></w:p>"#),
        format!(r#"<w:p><w:del {ATTRS}><w:r><w:t>Wrong text kind</w:t></w:r></w:del></w:p>"#),
        "<w:p><w:r><w:delText>Orphan</w:delText></w:r></w:p>".to_string(),
        format!(r#"<w:p><w:rPr><w:del {ATTRS}/></w:rPr><w:r><w:t>A</w:t></w:r></w:p>"#),
        format!(r#"<w:p><w:moveFrom {ATTRS}><w:r><w:t>Move</w:t></w:r></w:moveFrom></w:p>"#),
        format!(r#"<w:p><w:ins {}><w:r><w:t>Bad date</w:t></w:r></w:ins></w:p>"#, ATTRS.replace("2026-10-15T05:00:00Z", "2026-02-30T05:00:00Z")),
        format!(r#"<w:p><w:ins {}><w:r><w:t>Bad ID</w:t></w:r></w:ins></w:p>"#, ATTRS.replace(r#"w:id="1""#, r#"w:id="01""#)),
        format!(r#"<w:p><w:ins {ATTRS}><w:r><w:t>A</w:t></w:r></w:ins><w:ins {ATTRS}><w:r><w:t>B</w:t></w:r></w:ins></w:p>"#),
        format!(r#"<w:p><w:ins {}><w:r><w:t>Missing author</w:t></w:r></w:ins></w:p>"#, ATTRS.replace(r#" w:author="Reviewer""#, "")),
    ];
    for body in cases {
        let bytes = incoming(&body);
        let d = open(&bytes);
        assert!(!d.can_edit, "{body}");
        assert_eq!(export(&d), bytes);
        assert!(apply_err(&d, &[Operation::AcceptAllRevisions]).contains("safely"));
    }
}
#[test]
fn imports_simple_partial_ranges_for_individual_review() {
    let bytes = incoming(&format!(r#"<w:p><w:r><w:t>Before </w:t></w:r><w:del {ATTRS}><w:r><w:delText>Old</w:delText></w:r></w:del><w:ins {}><w:r><w:t>New</w:t></w:r></w:ins><w:r><w:t> after</w:t></w:r></w:p>"#, ATTRS.replace(r#"w:id="1""#, r#"w:id="2""#)));
    let d = open(&bytes);
    assert!(d.can_edit, "{:?}", d.diagnostics); assert_eq!(d.text, "Before New after"); assert_eq!(d.original_text.as_deref(), Some("Before Old after"));
    assert_eq!(export(&d), bytes);
    assert!(apply_err(&d, &[track("p0", "Whole replacement", "Reviewer")]).contains("Resolve"));
    assert_eq!(reopen(&apply(&d, &[Operation::RejectAllRevisions])).text, "Before Old after");
}
#[test]
fn preserves_namespace_bindings_local_to_imported_wrappers() {
    let bytes = incoming(&format!(r#"<w:p><q:del xmlns:q="{W}" q:id="1" q:author="Reviewer" q:date="2026-10-15T05:00:00Z"><q:r><q:rPr><q:b/></q:rPr><q:delText>Old</q:delText></q:r></q:del><q:ins xmlns:q="{W}" q:id="2" q:author="Reviewer" q:date="2026-10-15T05:00:00Z"><q:r><q:t>New</q:t></q:r></q:ins></w:p>"#));
    let original = open(&bytes);
    assert!(original.can_edit, "{:?}", original.diagnostics);
    assert_eq!(reopen(&apply(&original, &[track("p0", "Newest", "Reviewer")])).text, "Newest");
    let rejected = reopen(&apply(&original, &[Operation::RejectAllRevisions]));
    assert_eq!(rejected.text, "Old"); assert_eq!(rejected.paragraphs[0].runs[0].style.bold, Some(true));
    assert_eq!(reopen(&apply(&original, &[Operation::AcceptAllRevisions])).text, "New");
}

// ---- inline range formatting ----
fn bold_run(f: &mut RunFormat) { f.bold = Some(Some(true)); }
#[test]
fn formats_only_a_selected_word() {
    let original = create("Hello World!");
    let d = apply(&original, &[range("p0", 6, 11, fmt(bold_run))]);
    let expected = vec![(s("Hello "), None), (s("World"), Some(true)), (s("!"), None)];
    assert_eq!(runs_bold(&d.paragraphs[0]), expected);
    assert_eq!(d.text, original.text);
    assert_eq!(runs_bold(&reopen(&d).paragraphs[0]), expected);
    assert_eq!(original.paragraphs[0].runs.len(), 1);
}
#[test]
fn preserves_styles_across_a_range_spanning_runs_and_comment_anchors() {
    let mut d = apply(&create("Hello World!"), &[range("p0", 6, 11, fmt(bold_run)), comment("p0", "A", "Keep comment")]);
    d = apply(&d, &[range("p0", 3, 9, fmt(|f| { f.italic = Some(Some(true)); f.color = Some(Some("ff0000".into())); }))]);
    let saved = reopen(&d);
    assert_eq!(saved.text, "Hello World!"); assert_eq!(saved.comments[0].text, "Keep comment");
    let v: Vec<(String, Option<bool>, Option<bool>)> = saved.paragraphs[0].runs.iter().filter(|r| !r.text.is_empty()).map(|r| (r.text.clone(), r.style.bold, r.style.italic)).collect();
    assert_eq!(v, vec![(s("Hel"), None, None), (s("lo "), None, Some(true)), (s("Wor"), Some(true), Some(true)), (s("ld"), Some(true), None), (s("!"), None, None)]);
}
#[test]
fn rejects_out_of_bounds_collapsed_ranges_and_character_splits() {
    // UTF-8 offsets: "A" 0..1, the emoji 1..5, "B" 5..6. Negative and fractional offsets cannot be written.
    let d = create("A😀B");
    for (start, end) in [(0, 99), (1, 1), (1, 2), (2, 3)] { assert!(apply_docx_operations(&d, &[range("p0", start, end, fmt(bold_run))]).is_err(), "{start}..{end}"); }
    let valid = apply(&d, &[range("p0", 1, 5, fmt(bold_run))]);
    assert_eq!(valid.paragraphs[0].runs.iter().find(|r| r.text == "😀").unwrap().style.bold, Some(true));
    assert!(!d.modified);
}
