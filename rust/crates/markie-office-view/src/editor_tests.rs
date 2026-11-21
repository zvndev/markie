//! Editing model tests against the real engine. No GPUI here.

use markie_office::model::{Format, ListKind, Orientation, RichDocument, TextPosition};
use markie_office::rich_document::{OfficeDocument, create_rich_document, export_rich_document, open_rich_document};

use crate::commands::{available_commands, is_available, paper_of, run_command};
use crate::editor::{Common, Outcome, Tool, WordEditor, paragraph_input, picture_operation};

fn word(text: &str) -> WordEditor {
    WordEditor::new(create_rich_document(Format::Docx, text).unwrap())
}

/// Save and reopen, as a second session would see the file.
fn reopen(editor: &WordEditor) -> OfficeDocument {
    let format = editor.rich().format;
    open_rich_document(format, &editor.export().unwrap()).unwrap()
}

fn texts(doc: &RichDocument) -> Vec<String> {
    doc.paragraphs.iter().map(|p| p.text.clone()).collect()
}

fn at(editor: &WordEditor, paragraph: usize, offset: usize) -> TextPosition {
    TextPosition { paragraph_id: editor.rich().paragraphs[paragraph].id.clone(), offset }
}

fn caret(editor: &mut WordEditor, paragraph: usize, offset: usize) {
    let position = at(editor, paragraph, offset);
    editor.set_caret(position, false);
}

fn select(editor: &mut WordEditor, from: (usize, usize), to: (usize, usize)) {
    let (a, b) = (at(editor, from.0, from.1), at(editor, to.0, to.1));
    editor.select(a, b);
}

/// A tiny valid RGBA PNG.
fn png(width: u32, height: u32) -> Vec<u8> {
    let chunk = |name: &[u8], data: &[u8]| {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend(name);
        out.extend(data);
        let crc = markie_office::zip::zip_crc32(&out[4..]);
        out.extend(crc.to_be_bytes());
        out
    };
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8u8, 6, 0, 0, 0]);
    let row = 1 + 4 * width as usize;
    let raw = vec![0u8; row * height as usize];
    let idat = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
    let mut out = vec![137u8, 80, 78, 71, 13, 10, 26, 10];
    out.extend(chunk(b"IHDR", &ihdr));
    out.extend(chunk(b"IDAT", &idat));
    out.extend(chunk(b"IEND", &[]));
    out
}

#[test]
fn an_untouched_document_saves_its_original_bytes() {
    let original = export_rich_document(&create_rich_document(Format::Docx, "Hello").unwrap()).unwrap();
    let editor = WordEditor::new(open_rich_document(Format::Docx, &original).unwrap());
    assert_eq!(editor.export().unwrap(), original);
    assert!(!editor.is_dirty());
}

#[test]
fn typing_edits_the_run_and_survives_a_save() {
    let mut editor = word("Hello world");
    caret(&mut editor, 0, 5);
    assert!(editor.replace_selection(","));
    assert_eq!(texts(editor.rich()), ["Hello, world"]);
    assert_eq!(editor.focus.offset, 6);
    assert!(editor.is_dirty());
    assert_eq!(texts(&reopen(&editor)), ["Hello, world"]);
}

#[test]
fn undo_back_to_the_start_saves_the_original_bytes_again() {
    let original = export_rich_document(&create_rich_document(Format::Docx, "Hello").unwrap()).unwrap();
    let mut editor = WordEditor::new(open_rich_document(Format::Docx, &original).unwrap());
    caret(&mut editor, 0, 5);
    editor.replace_selection("!");
    editor.replace_selection("?");
    editor.undo();
    editor.undo();
    assert!(!editor.is_dirty());
    assert_eq!(editor.export().unwrap(), original);
    editor.redo();
    assert_eq!(texts(editor.rich()), ["Hello!"]);
    assert!(editor.is_dirty());
    assert_eq!(editor.focus.offset, 6);
}

#[test]
fn saving_marks_clean_and_a_later_edit_marks_dirty() {
    let mut editor = word("Hi");
    caret(&mut editor, 0, 2);
    editor.replace_selection("!");
    editor.mark_saved();
    assert!(!editor.is_dirty());
    editor.undo();
    assert!(editor.is_dirty());
    editor.redo();
    assert!(!editor.is_dirty());
}

#[test]
fn backspace_and_delete_remove_whole_graphemes() {
    let mut editor = word("ae\u{301}b👍🏽c");
    caret(&mut editor, 0, 4);
    editor.backspace();
    assert_eq!(texts(editor.rich()), ["ab👍🏽c"]);
    assert_eq!(editor.focus.offset, 1);
    caret(&mut editor, 0, 2);
    editor.delete_forward();
    assert_eq!(texts(editor.rich()), ["abc"]);
}

#[test]
fn enter_splits_and_backspace_joins_word_paragraphs() {
    let mut editor = word("HelloWorld");
    caret(&mut editor, 0, 5);
    assert!(editor.split());
    assert_eq!(texts(editor.rich()), ["Hello", "World"]);
    assert_eq!(editor.focus, at(&editor, 1, 0));
    assert!(editor.backspace());
    assert_eq!(texts(editor.rich()), ["HelloWorld"]);
    assert_eq!(editor.focus.offset, 5);
    assert_eq!(texts(&reopen(&editor)), ["HelloWorld"]);
}

#[test]
fn delete_at_a_paragraph_end_joins_the_next() {
    let mut editor = word("One\nTwo");
    caret(&mut editor, 0, 3);
    assert!(editor.delete_forward());
    assert_eq!(texts(editor.rich()), ["OneTwo"]);
}

#[test]
fn cross_paragraph_selections_replace_as_one_edit() {
    let mut editor = word("Alpha\nBeta\nGamma");
    select(&mut editor, (0, 2), (2, 3));
    assert_eq!(editor.copy_text().as_deref(), Some("pha\nBeta\nGam"));
    assert!(editor.replace_selection("X"));
    assert_eq!(texts(editor.rich()), ["AlXma"]);
    assert_eq!(editor.focus.offset, 3);
    editor.undo();
    assert_eq!(texts(editor.rich()), ["Alpha", "Beta", "Gamma"]);
}

#[test]
fn multiline_paste_into_word_makes_paragraphs() {
    let mut editor = word("Start end");
    caret(&mut editor, 0, 6);
    assert!(editor.paste("one\r\ntwo\n"));
    assert_eq!(texts(editor.rich()), ["Start one", "two", "end"]);
}

#[test]
fn rtf_enter_splits_with_replace_and_insert() {
    let mut editor = WordEditor::new(create_rich_document(Format::Rtf, "HelloWorld").unwrap());
    caret(&mut editor, 0, 5);
    assert!(editor.split());
    assert_eq!(texts(editor.rich()), ["Hello", "World"]);
    assert_eq!(editor.focus, at(&editor, 1, 0));
    assert_eq!(texts(&reopen(&editor)), ["Hello", "World"]);
}

#[test]
fn rtf_refuses_cross_paragraph_edits_with_a_reason() {
    let mut editor = WordEditor::new(create_rich_document(Format::Rtf, "One\nTwo").unwrap());
    select(&mut editor, (0, 1), (1, 1));
    assert!(!editor.replace_selection(""));
    assert!(editor.error.as_deref().unwrap().contains("not applied"));
    assert_eq!(texts(editor.rich()), ["One", "Two"]);
}

#[test]
fn odt_typing_and_save_round_trip() {
    let mut editor = WordEditor::new(create_rich_document(Format::Odt, "Draft").unwrap());
    caret(&mut editor, 0, 5);
    editor.replace_selection(" two");
    assert_eq!(texts(&reopen(&editor)), ["Draft two"]);
}

#[test]
fn bold_toggles_a_selected_range_and_the_caret_run() {
    let mut editor = word("make this bold");
    select(&mut editor, (0, 5), (0, 9));
    assert!(editor.toggle_bold());
    assert_eq!(editor.selection_format().bold, Common::Value(true));
    let reopened = reopen(&editor);
    let bold: String = reopened.paragraphs[0].runs.iter().filter(|r| r.style.bold == Some(true)).map(|r| r.text.as_str()).collect();
    assert_eq!(bold, "this");
    // The selection survives so a second press turns it off.
    assert!(editor.toggle_bold());
    assert_eq!(editor.selection_format().bold, Common::Value(false));
}

#[test]
fn formatting_across_body_paragraphs_formats_each_part() {
    let mut editor = word("first\nsecond");
    select(&mut editor, (0, 2), (1, 3));
    assert!(editor.toggle_italic());
    let doc = reopen(&editor);
    let italic: Vec<String> = doc.paragraphs.iter().map(|p| p.runs.iter().filter(|r| r.style.italic == Some(true)).map(|r| r.text.clone()).collect()).collect();
    assert_eq!(italic, ["rst", "sec"]);
}

#[test]
fn headings_lists_and_alignment_change_the_paragraph() {
    let mut editor = word("Title\nItem");
    caret(&mut editor, 0, 0);
    assert_eq!(run_command(&mut editor, "format-heading-1"), Outcome::Done);
    assert_eq!(editor.rich().paragraphs[0].style_id.as_deref(), Some("Heading1"));
    caret(&mut editor, 1, 0);
    assert_eq!(run_command(&mut editor, "format-bullets"), Outcome::Done);
    assert_eq!(editor.rich().paragraphs[1].list_kind, Some(ListKind::Bullet));
    assert_eq!(run_command(&mut editor, "format-bullets"), Outcome::Done);
    assert_eq!(editor.rich().paragraphs[1].list_kind, None);
    assert_eq!(run_command(&mut editor, "format-align-center"), Outcome::Done);
    let doc = reopen(&editor);
    assert_eq!(doc.paragraphs[1].alignment.as_deref(), Some("center"));
    assert_eq!(doc.paragraphs[0].style_id.as_deref(), Some("Heading1"));
}

#[test]
fn page_breaks_insert_at_the_caret_and_add_a_paragraph_at_the_end() {
    let mut editor = word("Page one");
    caret(&mut editor, 0, 8);
    assert_eq!(run_command(&mut editor, "insert-page-break"), Outcome::Done);
    assert_eq!(editor.rich().page_breaks.len(), 1);
    assert_eq!(editor.rich().paragraphs.len(), 2);
    assert_eq!(editor.focus, at(&editor, 1, 0));
    let id = editor.rich().page_breaks[0].id.clone();
    assert!(editor.remove_page_break(&id));
    assert!(editor.rich().page_breaks.is_empty());
}

#[test]
fn page_breaks_refuse_a_text_selection() {
    let mut editor = word("Page one");
    select(&mut editor, (0, 0), (0, 4));
    assert!(!editor.insert_page_break());
    assert!(!is_available(&editor, "insert-page-break"));
}

#[test]
fn page_size_and_orientation_follow_the_layout_commands() {
    let mut editor = word("x");
    run_command(&mut editor, "layout-a4");
    run_command(&mut editor, "layout-landscape");
    let layout = reopen(&editor).page_layout;
    assert_eq!(layout.orientation, Orientation::Landscape);
    assert!(layout.width_points > layout.height_points);
    assert_eq!(paper_of(layout.width_points, layout.height_points), Some(markie_office::model::Paper::A4));
}

#[test]
fn tables_insert_after_the_caret_and_are_editable() {
    let mut editor = word("Before");
    caret(&mut editor, 0, 6);
    assert!(editor.insert_table(2, 3));
    let doc = editor.rich().clone();
    assert_eq!(doc.tables.len(), 1);
    assert_eq!(doc.tables[0].rows.len(), 2);
    assert_eq!(doc.tables[0].rows[0].cells.len(), 3);
    // The caret lands in the first cell; typing there edits that cell.
    let cell = doc.tables[0].rows[0].cells[0].paragraph_ids[0].clone();
    assert_eq!(editor.focus.paragraph_id, cell);
    assert!(editor.caret_table().is_some());
    assert!(editor.replace_selection("A1"));
    assert_eq!(editor.paragraph(&cell).unwrap().text, "A1");
    assert!(!is_available(&editor, "insert-picture"));
    let table = editor.rich().tables[0].id.clone();
    assert!(editor.delete_table(&table));
    assert!(editor.rich().tables.is_empty());
}

#[test]
fn links_need_a_selection_and_can_be_retargeted() {
    let mut editor = word("Visit Markie today");
    caret(&mut editor, 0, 3);
    assert!(!editor.set_link("https://example.com"));
    assert!(editor.error.is_some());
    select(&mut editor, (0, 6), (0, 12));
    assert!(editor.set_link("https://example.com/"));
    assert_eq!(editor.rich().hyperlinks.len(), 1);
    caret(&mut editor, 0, 8);
    assert!(editor.caret_link().is_some());
    assert!(editor.set_link("https://markiedocs.com/"));
    assert_eq!(reopen(&editor).hyperlinks[0].target, "https://markiedocs.com/");
    let id = editor.rich().hyperlinks[0].id.clone();
    assert!(editor.remove_link(&id));
    assert!(editor.rich().hyperlinks.is_empty());
}

#[test]
fn typing_inside_a_link_falls_back_to_the_range_edit_or_explains() {
    let mut editor = word("Visit Markie today");
    select(&mut editor, (0, 6), (0, 12));
    editor.set_link("https://example.com/");
    caret(&mut editor, 0, 8);
    let applied = editor.replace_selection("x");
    // Either the engine edits the link text safely, or nothing changes and a reason shows.
    if applied {
        assert_eq!(editor.rich().paragraphs[0].text, "Visit Maxrkie today");
    } else {
        assert!(editor.error.is_some());
        assert_eq!(editor.rich().paragraphs[0].text, "Visit Markie today");
    }
}

#[test]
fn comments_attach_to_the_caret_paragraph() {
    let mut editor = word("One\nTwo");
    caret(&mut editor, 1, 0);
    assert!(editor.add_comment("Check this", "Kirby"));
    let doc = reopen(&editor);
    assert_eq!(doc.comments.len(), 1);
    assert_eq!(doc.comments[0].author, "Kirby");
    assert_eq!(doc.comments[0].paragraph_id, doc.paragraphs[1].id);
    let id = editor.rich().comments[0].id.clone();
    assert!(editor.delete_comment(&id));
    assert!(editor.rich().comments.is_empty());
    assert!(!editor.add_comment("  ", "Kirby"));
}

#[test]
fn tracked_typing_makes_a_revision_that_can_be_accepted() {
    let mut editor = word("Plain text");
    editor.set_tracking(true);
    editor.review_author = "Kirby".into();
    caret(&mut editor, 0, 10);
    assert!(editor.replace_selection(" added"));
    let doc = editor.rich().clone();
    assert!(!doc.revisions.is_empty());
    assert_eq!(doc.paragraphs[0].text, "Plain text added");
    assert!(doc.original_text.is_some());
    // Untracked editing of a paragraph with revisions is refused.
    editor.set_tracking(false);
    assert!(!editor.replace_selection("!"));
    // The original view is read-only and shows the text without insertions.
    editor.set_original_view(true);
    assert!(!editor.can_mutate());
    assert!(available_commands(&editor).contains(&"review-final"));
    editor.set_original_view(false);
    assert!(editor.accept_all());
    assert!(editor.rich().revisions.is_empty());
    assert_eq!(texts(&reopen(&editor)), ["Plain text added"]);
}

#[test]
fn tracking_refuses_structural_edits() {
    let mut editor = word("A\nB");
    editor.set_tracking(true);
    caret(&mut editor, 0, 1);
    assert!(!editor.split());
    assert!(editor.error.as_deref().unwrap().contains("tracking"));
}

#[test]
fn pictures_scale_into_the_content_box() {
    let mut editor = word("Caption");
    caret(&mut editor, 0, 0);
    assert!(editor.insert_picture(png(2000, 100), "wide.png"));
    let picture = &editor.rich().images[0];
    let (max_w, _) = editor.content_box_points();
    assert!((picture.width_points - max_w).abs() < 0.01);
    assert_eq!(picture.alt_text, "wide.png");
    assert_eq!(reopen(&editor).images.len(), 1);
    let id = editor.rich().images[0].id.clone();
    assert!(editor.delete_picture(&id));
    assert!(editor.rich().images.is_empty());
}

#[test]
fn pictures_refuse_other_formats() {
    let error = picture_operation(b"GIF89a....".to_vec(), "x.gif", (400.0, 600.0), None).err().unwrap();
    assert!(error.contains("PNG and JPEG"));
}

#[test]
fn a_read_only_host_blocks_every_edit_but_copy() {
    let mut editor = word("Locked text");
    editor.host_read_only = true;
    caret(&mut editor, 0, 0);
    assert!(!editor.replace_selection("x"));
    assert!(!editor.toggle_bold());
    select(&mut editor, (0, 0), (0, 6));
    assert_eq!(editor.copy_text().as_deref(), Some("Locked"));
    assert!(editor.cut().is_none());
    assert_eq!(texts(editor.rich()), ["Locked text"]);
    assert!(!available_commands(&editor).contains(&"format-bold"));
}

#[test]
fn cut_copies_and_removes() {
    let mut editor = word("cut me out");
    select(&mut editor, (0, 4), (0, 7));
    assert_eq!(editor.cut().as_deref(), Some("me "));
    assert_eq!(texts(editor.rich()), ["cut out"]);
}

#[test]
fn select_all_spans_the_document() {
    let mut editor = word("a\nb\nc");
    editor.select_all();
    assert_eq!(editor.copy_text().as_deref(), Some("a\nb\nc"));
}

#[test]
fn arrows_cross_paragraphs_and_collapse_selections() {
    let mut editor = word("ab\ncd");
    caret(&mut editor, 0, 2);
    editor.move_horizontal(true, false);
    assert_eq!(editor.focus, at(&editor, 1, 0));
    editor.move_horizontal(false, true);
    assert_eq!(editor.anchor, at(&editor, 1, 0));
    assert_eq!(editor.focus, at(&editor, 0, 2));
    editor.move_horizontal(true, false);
    assert!(editor.is_collapsed());
    assert_eq!(editor.focus, at(&editor, 1, 0));
    editor.move_to_document_edge(true, false);
    assert_eq!(editor.focus, at(&editor, 1, 2));
    editor.move_word(false, false);
    assert_eq!(editor.focus, at(&editor, 1, 0));
}

#[test]
fn menu_commands_follow_the_selection_and_format() {
    let mut editor = word("text");
    let available = available_commands(&editor);
    for id in ["format-bold", "format-heading-1", "format-bullets", "insert-table", "insert-picture", "insert-page-break", "layout-a4", "review-comments"] {
        assert!(available.contains(&id), "{id}");
    }
    assert!(!available.contains(&"insert-link"));
    assert!(!available.contains(&"format-strike"));
    assert_eq!(run_command(&mut editor, "format-font"), Outcome::Open(Tool::Font));
    let rtf = WordEditor::new(create_rich_document(Format::Rtf, "text").unwrap());
    let available = available_commands(&rtf);
    assert!(available.contains(&"format-bold") && available.contains(&"format-align-center"));
    assert!(!available.contains(&"insert-table") && !available.contains(&"format-heading-1") && !available.contains(&"review-comments"));
}

#[test]
fn paragraph_input_refuses_protected_runs_and_splits_across_runs() {
    let mut editor = word("make this bold");
    select(&mut editor, (0, 5), (0, 9));
    editor.toggle_bold();
    let paragraph = editor.rich().paragraphs[0].clone();
    assert!(paragraph.runs.len() >= 2);
    // A replacement across the run boundary edits both runs.
    let (edits, caret) = paragraph_input(&paragraph, 3, 7, "X").unwrap();
    assert_eq!(edits.len(), 2);
    assert_eq!(caret, 4);
    let mut locked = paragraph.clone();
    locked.runs[0].can_edit = false;
    assert!(paragraph_input(&locked, 0, 1, "x").is_err());
    assert!(paragraph_input(&paragraph, 0, 0, "tab\there").is_err());
}

#[test]
fn multibyte_offsets_stay_on_character_boundaries() {
    let mut editor = word("日本語");
    caret(&mut editor, 0, 4); // inside 本: snaps back to 3
    assert_eq!(editor.focus.offset, 3);
    editor.replace_selection("と");
    assert_eq!(texts(editor.rich()), ["日と本語"]);
    assert_eq!(editor.focus.offset, 6);
}
