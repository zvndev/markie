//! Undo grouping, held to ProseMirror's history as TipTap runs it in
//! Electron (`prosemirror-history` 1.5.1 `applyTransaction`, TipTap's
//! `undoRedo` with `newGroupDelay: 500`): a change joins the group before
//! it when it comes within 500 ms of the previous change and touches the
//! range that change left. Every test fixes the clock, so the timing is
//! exact on a loaded machine.

use std::time::{Duration, Instant};

use markie_rich::editor::{Editor, MarkKind, Pos};

const MS: fn(u64) -> Duration = Duration::from_millis;

/// An editor on `md` with a fixed clock and the caret at the end.
fn editor(md: &str) -> Editor {
    let mut ed = Editor::parse(md);
    ed.set_clock(Instant::now());
    ed.move_doc_edge(true, false);
    ed
}

/// Type `s` one character at a time, `gap` apart, as keystrokes arrive.
fn type_keys(ed: &mut Editor, s: &str, gap: Duration) {
    for c in s.chars() {
        ed.advance_clock(gap);
        ed.insert_text(&c.to_string());
    }
}

fn undo_all(ed: &mut Editor) -> usize {
    let mut n = 0;
    while ed.undo() {
        n += 1;
    }
    n
}

#[test]
fn a_typing_run_with_spaces_is_one_undo() {
    // The capture pass's case: Electron's Edit › Undo takes back the whole
    // run, not only the last word.
    let mut ed = editor("First paragraph.\n");
    type_keys(&mut ed, " Typed in view.", MS(80));
    assert_eq!(ed.to_markdown(), "First paragraph. Typed in view.\n");
    assert_eq!(ed.undo_depth(), 1);
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "First paragraph.\n");
    assert!(!ed.can_undo());
    assert!(ed.redo());
    assert_eq!(ed.to_markdown(), "First paragraph. Typed in view.\n");
}

#[test]
fn a_pause_longer_than_500_ms_starts_a_new_group() {
    let mut ed = editor("A\n");
    type_keys(&mut ed, " one", MS(50));
    ed.advance_clock(MS(501));
    ed.insert_text(" ");
    type_keys(&mut ed, "two", MS(50));
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "A one\n");
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "A\n");
}

#[test]
fn exactly_500_ms_still_joins() {
    // `prevTime < time - newGroupDelay` is strict.
    let mut ed = editor("A\n");
    type_keys(&mut ed, "bc", MS(500));
    assert_eq!(ed.undo_depth(), 1);
}

#[test]
fn the_delay_runs_from_the_previous_change_not_the_group_start() {
    let mut ed = editor("A\n");
    type_keys(&mut ed, "bcdefghijk", MS(400));
    assert_eq!(ed.undo_depth(), 1, "4 s of steady typing is one group");
}

#[test]
fn a_selection_jump_starts_a_new_group() {
    let mut ed = editor("Hello world\n");
    type_keys(&mut ed, "!!", MS(50));
    ed.set_caret(Pos::new(0, 0, 0), false);
    type_keys(&mut ed, "¡", MS(50));
    assert_eq!(ed.to_markdown(), "¡Hello world!!\n");
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "Hello world!!\n");
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "Hello world\n");
}

#[test]
fn moving_away_and_back_keeps_the_group() {
    // A selection change alone changes nothing in ProseMirror's history; the
    // next edit is adjacent again.
    let mut ed = editor("Hi\n");
    type_keys(&mut ed, "abc", MS(50));
    ed.move_left(false, false);
    ed.move_right(false, false);
    type_keys(&mut ed, "d", MS(50));
    assert_eq!(ed.undo_depth(), 1);
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "Hi\n");
}

#[test]
fn formatting_is_a_group_of_its_own() {
    let mut ed = editor("Hi\n");
    type_keys(&mut ed, " bold", MS(50));
    let end = ed.head;
    ed.set_caret(Pos { offset: end.offset - 4, ..end }, false);
    ed.set_caret(end, true);
    ed.advance_clock(MS(50));
    ed.toggle_mark(MarkKind::Bold);
    ed.set_caret(end, false);
    type_keys(&mut ed, "!", MS(50));
    // Bold is inclusive, as TipTap's is.
    assert_eq!(ed.to_markdown(), "Hi **bold!**\n");
    assert!(ed.undo(), "typing after formatting is a new group");
    assert_eq!(ed.to_markdown(), "Hi **bold**\n");
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "Hi bold\n");
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "Hi\n");
}

#[test]
fn enter_joins_the_typing_around_it() {
    // TipTap's Enter is `splitBlock`, which does not close the history.
    let mut ed = editor("Top\n");
    type_keys(&mut ed, " line", MS(60));
    ed.advance_clock(MS(60));
    ed.enter();
    type_keys(&mut ed, "Next", MS(60));
    assert_eq!(ed.to_markdown(), "Top line\n\nNext\n");
    assert_eq!(ed.undo_depth(), 1);
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "Top\n");
}

#[test]
fn enter_after_a_pause_is_its_own_group() {
    let mut ed = editor("Top\n");
    type_keys(&mut ed, "!", MS(60));
    ed.advance_clock(MS(800));
    ed.enter();
    type_keys(&mut ed, "Next", MS(60));
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "Top!\n");
}

#[test]
fn deleting_joins_typing() {
    let mut ed = editor("A\n");
    type_keys(&mut ed, "bcd", MS(60));
    ed.advance_clock(MS(60));
    ed.backspace();
    type_keys(&mut ed, "x", MS(60));
    assert_eq!(ed.to_markdown(), "Abcx\n");
    assert_eq!(ed.undo_depth(), 1);
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "A\n");
}

#[test]
fn paste_groups_like_any_replace() {
    // At the caret within 500 ms it joins; after a pause it is its own.
    let mut ed = editor("A\n");
    type_keys(&mut ed, "b", MS(60));
    ed.advance_clock(MS(60));
    ed.paste_markdown("cd");
    assert_eq!(ed.undo_depth(), 1);
    ed.advance_clock(MS(900));
    ed.paste_markdown("ef");
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "Abcd\n");
}

#[test]
fn an_input_rule_starts_a_group_that_the_next_typing_joins() {
    // TipTap closes the history before a rule's transaction.
    let mut ed = editor("x\n");
    type_keys(&mut ed, "y", MS(60));
    ed.advance_clock(MS(60));
    ed.enter();
    type_keys(&mut ed, "# Head", MS(60));
    assert_eq!(ed.to_markdown(), "xy\n\n# Head\n");
    assert!(ed.undo(), "the heading and the text after it");
    // The rule took the typed space with it, as TipTap's does; the
    // serializer escapes the bare `#`.
    assert_eq!(ed.to_markdown(), "xy\n\n\\#\n");
    assert!(ed.undo(), "the typing before the rule, Enter with it");
    assert_eq!(ed.to_markdown(), "x\n");
    assert!(!ed.can_undo());
}

#[test]
fn backspace_right_after_a_rule_still_takes_only_the_rule_back() {
    let mut ed = editor("x\n");
    ed.enter();
    type_keys(&mut ed, "- ", MS(60));
    assert_eq!(ed.to_markdown(), "x\n\n-\n");
    ed.backspace();
    assert_eq!(ed.to_markdown(), "x\n\n\\-\n", "the typed `- ` is back as text");
}

#[test]
fn typing_after_undo_is_a_new_group() {
    let mut ed = editor("A\n");
    type_keys(&mut ed, "bc", MS(60));
    type_keys(&mut ed, "d", MS(60));
    assert!(ed.undo());
    type_keys(&mut ed, "x", MS(10));
    type_keys(&mut ed, "y", MS(10));
    assert_eq!(ed.to_markdown(), "Axy\n");
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), "A\n");
    assert!(!ed.can_undo(), "the first undo emptied the stack; xy is one new group");
}

#[test]
fn one_composition_is_one_group_however_long_it_takes() {
    let mut ed = editor("A\n");
    ed.composition = Some(1);
    type_keys(&mut ed, "n", MS(50));
    ed.advance_clock(MS(2000));
    let h = ed.head;
    ed.set_caret(Pos { offset: h.offset - 1, ..h }, false);
    ed.set_caret(h, true);
    ed.insert_text("日本");
    ed.composition = None;
    assert_eq!(ed.to_markdown(), "A日本\n");
    assert_eq!(ed.undo_depth(), 1);
    // A second composition after a pause is a new group.
    ed.composition = Some(2);
    ed.advance_clock(MS(2000));
    ed.insert_text("語");
    ed.composition = None;
    assert_eq!(ed.undo_depth(), 2);
    assert_eq!(undo_all(&mut ed), 2);
    assert_eq!(ed.to_markdown(), "A\n");
}

#[test]
fn groups_spanning_blocks_undo_byte_for_byte() {
    // Merged steps cover the union of the blocks each touched.
    let doc = "# T\n\nalpha\n\n- one\n- two\n\nomega\n";
    let mut ed = editor(doc);
    ed.set_caret(Pos::new(1, 0, 5), false);
    for _ in 0..4 {
        type_keys(&mut ed, "ab", MS(40));
        ed.advance_clock(MS(40));
        ed.enter();
    }
    ed.advance_clock(MS(40));
    ed.backspace();
    ed.advance_clock(MS(40));
    ed.backspace();
    assert_eq!(ed.undo_depth(), 1);
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), doc);
    assert!(ed.redo());
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), doc);
}

/// The text of top-level paragraph `i`.
fn para_text(ed: &Editor, i: usize) -> String {
    let markie_rich::Node::Paragraph { content, .. } = &ed.doc.nodes()[i] else { panic!("not a paragraph: {:?}", ed.doc.nodes()[i]) };
    content.iter().map(|inline| match inline {
        markie_rich::Inline::Text { text, .. } => text.as_str(),
        _ => "",
    }).collect()
}

#[test]
fn undo_after_a_typed_rule_leaves_the_text_before_the_keystroke() {
    // TipTap's rule replaces the typed space in its own transaction, so
    // Undo after `# ` leaves `#`, not `# `.
    let mut ed = editor("x\n");
    ed.advance_clock(MS(600));
    ed.enter();
    type_keys(&mut ed, "# ", MS(60));
    assert!(matches!(ed.doc.nodes()[1], markie_rich::Node::Heading { .. }));
    assert!(ed.undo());
    assert_eq!(para_text(&ed, 1), "#");
    assert!(ed.redo());
    assert!(matches!(ed.doc.nodes()[1], markie_rich::Node::Heading { .. }));
    // The same for a list and a mark rule.
    let mut ed = editor("x\n");
    ed.advance_clock(MS(600));
    ed.enter();
    type_keys(&mut ed, "- ", MS(60));
    assert!(ed.undo());
    assert_eq!(para_text(&ed, 1), "-");
    let mut ed = editor("x\n");
    ed.advance_clock(MS(600));
    type_keys(&mut ed, " **b**", MS(60));
    assert!(ed.undo());
    assert_eq!(para_text(&ed, 0), "x **b*");
}

#[test]
fn backspace_after_a_typed_rule_keeps_the_keystroke() {
    let mut ed = editor("x\n");
    ed.advance_clock(MS(600));
    ed.enter();
    type_keys(&mut ed, "# ", MS(60));
    ed.backspace();
    assert_eq!(para_text(&ed, 1), "# ");
    // Typing that does not trigger a rule still groups as before.
    let mut ed = editor("A\n");
    type_keys(&mut ed, " one two", MS(60));
    assert_eq!(ed.undo_depth(), 1);
}
