//! The editing core the GPUI example drives, tested without a window.

use markie_rich::edit::{MarkKind, RichEditor};
use markie_rich::Document;

const DOC: &str = "---\ntitle: Spike\n---\n# Notes\n\nThis paragraph was wrapped\nby hand.\n\n<!-- keep me -->\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSecond paragraph.\n";

fn editor() -> RichEditor {
    RichEditor::new(Document::parse(DOC))
}

#[test]
fn typing_rewrites_only_the_paragraph_typed_in() {
    let mut ed = editor();
    // Starts in the first editable block: the heading. Down keeps the column.
    ed.move_vertical(1);
    ed.activate(ed.active, None);
    ed.insert_text(" Typed.");
    assert_eq!(
        ed.to_markdown(),
        DOC.replace("This paragraph was wrapped\nby hand.", "This paragraph was wrapped by hand. Typed.")
    );
    assert_eq!(ed.edit_counts().0, 1);
}

#[test]
fn bold_a_selection_and_italic_while_typing() {
    let mut ed = editor();
    ed.move_vertical(1);
    ed.move_vertical(1); // the comment and the table are skipped
    ed.activate(ed.active, Some(0));
    for _ in 0.."Second".len() {
        ed.move_horizontal(1, true);
    }
    ed.toggle_mark(MarkKind::Bold);
    ed.move_horizontal(1, false);
    ed.activate(ed.active, None);
    ed.insert_text(" ");
    ed.toggle_mark(MarkKind::Italic);
    ed.insert_text("emphasis");
    let out = ed.to_markdown();
    assert!(out.ends_with("**Second** paragraph. *emphasis*\n"), "{out}");
    assert!(out.starts_with("---\ntitle: Spike\n---\n# Notes\n\nThis paragraph was wrapped\nby hand.\n\n<!-- keep me -->\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"));
}

#[test]
fn headings_and_back() {
    let mut ed = editor();
    ed.set_heading(2);
    assert!(ed.to_markdown().contains("\n## Notes\n"));
    ed.set_heading(0);
    assert!(ed.to_markdown().contains("\nNotes\n"));
}

#[test]
fn enter_splits_and_backspace_joins() {
    let mut ed = RichEditor::new(Document::parse("# T\n\nHello world.\n"));
    ed.move_vertical(1);
    ed.activate(ed.active, Some(5));
    ed.split();
    assert_eq!(ed.to_markdown(), "# T\n\nHello\n\n world.\n");
    ed.backspace();
    assert_eq!(ed.to_markdown(), "# T\n\nHello world.\n");
}

#[test]
fn unicode_and_math_atoms() {
    let mut ed = RichEditor::new(Document::parse("Euler: $e^{i\\pi}$ ok\n"));
    ed.activate(0, None);
    ed.insert_text(" 🎉 café");
    assert_eq!(ed.to_markdown(), "Euler: $e^{i\\pi}$ ok 🎉 café\n");
    // The formula is one unit: one backspace from after it removes it whole.
    ed.activate(0, Some("Euler: ".chars().count() + 1));
    ed.backspace();
    assert_eq!(ed.to_markdown(), "Euler:  ok 🎉 café\n");
}
