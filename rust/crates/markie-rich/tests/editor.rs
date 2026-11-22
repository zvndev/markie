//! The rich editor's model, driven the way the view drives it.

use markie_rich::editor::{BlockStyle, Editor, ListKind, MarkKind, Pos};

/// Caret at the end of the first leaf whose text contains `needle`, after it.
fn caret_after(ed: &mut Editor, needle: &str) {
    for b in 0..ed.block_count() {
        for l in 0..ed.leaves_of(b).len() {
            let t: String = ed.units(b, l).iter().map(|u| u.display()).collect();
            if let Some(i) = t.find(needle) {
                let off = t[..i + needle.len()].chars().count();
                ed.set_caret(Pos::new(b, l, off), false);
                return;
            }
        }
    }
    panic!("{needle:?} not found");
}

fn select(ed: &mut Editor, needle: &str) {
    for b in 0..ed.block_count() {
        for l in 0..ed.leaves_of(b).len() {
            let t: String = ed.units(b, l).iter().map(|u| u.display()).collect();
            if let Some(i) = t.find(needle) {
                let a = t[..i].chars().count();
                let e = a + needle.chars().count();
                ed.set_caret(Pos::new(b, l, a), false);
                ed.set_caret(Pos::new(b, l, e), true);
                return;
            }
        }
    }
    panic!("{needle:?} not found");
}

const DOC: &str = "# Title\n\nThis paragraph was wrapped\nby hand, and stays that way.\n\n- one\n- two\n\n<!-- kept -->\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nLast *para*.\n";

#[test]
fn zero_edit_and_undo_are_byte_exact() {
    let mut ed = Editor::parse(DOC);
    assert_eq!(ed.to_markdown(), DOC);
    caret_after(&mut ed, "Last");
    ed.insert_text("X");
    assert_ne!(ed.to_markdown(), DOC);
    ed.backspace();
    assert_eq!(ed.to_markdown(), DOC, "typing then deleting restores the block's bytes");
    ed.insert_text("abc");
    assert!(ed.undo());
    assert_eq!(ed.to_markdown(), DOC);
    assert!(ed.redo());
    assert!(ed.to_markdown().contains("Lastabc *para*."));
}

#[test]
fn enter_keeps_the_paragraph_bytes() {
    let mut ed = Editor::parse(DOC);
    caret_after(&mut ed, "stays that way.");
    ed.enter();
    ed.insert_text("New line.");
    let md = ed.to_markdown();
    assert!(md.contains("This paragraph was wrapped\nby hand, and stays that way.\n\nNew line.\n\n- one"), "{md}");
    let (edited, _) = ed.edit_counts();
    assert_eq!(edited, 1, "only the new paragraph is written by the serializer");
}

#[test]
fn split_and_join_paragraphs() {
    let mut ed = Editor::parse("alpha beta\n");
    caret_after(&mut ed, "alpha");
    ed.enter();
    assert_eq!(ed.to_markdown(), "alpha\n\nbeta\n");
    ed.backspace();
    assert_eq!(ed.to_markdown(), "alpha beta\n");
}

#[test]
fn lists_split_exit_indent_outdent() {
    let mut ed = Editor::parse("- one\n- two\n");
    caret_after(&mut ed, "one");
    ed.enter();
    ed.insert_text("one and a half");
    assert_eq!(ed.to_markdown(), "- one\n- one and a half\n- two\n");
    ed.indent();
    assert_eq!(ed.to_markdown(), "- one\n  - one and a half\n- two\n");
    ed.outdent();
    assert_eq!(ed.to_markdown(), "- one\n- one and a half\n- two\n");
    caret_after(&mut ed, "two");
    ed.enter();
    ed.enter(); // an empty item: leave the list
    ed.insert_text("after");
    assert_eq!(ed.to_markdown(), "- one\n- one and a half\n- two\n\nafter\n");
    // Backspace at the start of an item lifts it out of the list.
    caret_after(&mut ed, "one and a half");
    ed.move_leaf_edge(false, false);
    ed.backspace();
    assert_eq!(ed.to_markdown(), "- one\n\none and a half\n\n- two\n\nafter\n");
}

#[test]
fn input_rules() {
    let mut ed = Editor::parse("x\n");
    ed.move_doc_edge(true, false);
    ed.enter();
    ed.insert_text("#");
    ed.insert_text(" ");
    ed.insert_text("Head");
    ed.enter();
    for c in ["-", " ", "i", "t", "e", "m"] {
        ed.insert_text(c);
    }
    ed.enter();
    ed.enter();
    for c in ["1", ".", " ", "n"] {
        ed.insert_text(c);
    }
    ed.enter();
    ed.enter();
    for c in ["[", " ", "]", " ", "t"] {
        ed.insert_text(c);
    }
    ed.enter();
    ed.enter();
    for c in [">", " ", "q"] {
        ed.insert_text(c);
    }
    assert_eq!(ed.to_markdown(), "x\n\n# Head\n\n- item\n\n1. n\n\n- [ ] t\n\n> q\n");
}

#[test]
fn math_input_rule_makes_a_formula() {
    let mut ed = Editor::parse("Euler\n");
    ed.move_doc_edge(true, false);
    for c in " $e^{i\\pi}$".chars() {
        ed.insert_text(&c.to_string());
    }
    ed.insert_text(" ok");
    let md = ed.to_markdown();
    assert_eq!(md, "Euler $e^{i\\pi}$ ok\n");
    let nodes = ed.doc.nodes();
    let markie_rich::Node::Paragraph { content, .. } = &nodes[0] else { panic!() };
    assert!(content.iter().any(|i| matches!(i, markie_rich::Inline::Math { .. })));
}

#[test]
fn marks_and_tiptap_html_marks() {
    let mut ed = Editor::parse("make this bold and that red\n");
    select(&mut ed, "this");
    ed.toggle_mark(MarkKind::Bold);
    select(&mut ed, "that");
    ed.set_text_style(Some(Some("#dc2626".into())), None, None);
    select(&mut ed, "red");
    ed.set_highlight(Some(Some("#fef08a".into())));
    select(&mut ed, "and");
    ed.toggle_mark(MarkKind::Underline);
    assert_eq!(
        ed.to_markdown(),
        "make **this** bold <u>and</u> <span style=\"color: #dc2626;\">that</span> <mark data-color=\"#fef08a\" style=\"background-color: #fef08a; color: inherit;\">red</mark>\n"
    );
    // The toolbar reads it back.
    select(&mut ed, "that");
    assert_eq!(ed.toolbar().color.as_deref(), Some("#dc2626"));
    // And the file reads back as what the editor holds.
    let again = Editor::parse(&ed.to_markdown());
    assert_eq!(again.doc.nodes(), ed.doc.nodes());
    // Bold off again.
    select(&mut ed, "this");
    ed.toggle_mark(MarkKind::Bold);
    assert!(ed.to_markdown().starts_with("make this bold"));
}

#[test]
fn typing_marks_with_no_selection() {
    let mut ed = Editor::parse("a\n");
    ed.move_doc_edge(true, false);
    ed.toggle_mark(MarkKind::Italic);
    ed.insert_text("b");
    ed.toggle_mark(MarkKind::Italic);
    ed.insert_text("c");
    assert_eq!(ed.to_markdown(), "a*b*c\n");
}

#[test]
fn delete_across_blocks() {
    let mut ed = Editor::parse("# Title\n\nfirst para\n\n- item\n\nlast para\n");
    caret_after(&mut ed, "fir");
    let a = ed.head;
    caret_after(&mut ed, "last ");
    let b = ed.head;
    ed.set_selection(a, b);
    ed.backspace();
    assert_eq!(ed.to_markdown(), "# Title\n\nfirpara\n");
    ed.undo();
    assert_eq!(ed.to_markdown(), "# Title\n\nfirst para\n\n- item\n\nlast para\n");
}

#[test]
fn copy_and_paste_markdown() {
    let mut ed = Editor::parse("# Title\n\nSome **bold** text\n\n- a\n- b\n\nend\n");
    caret_after(&mut ed, "Some ");
    let a = ed.head;
    caret_after(&mut ed, "a");
    let mut b = ed.head;
    b.offset = 1;
    ed.set_selection(a, b);
    let md = ed.selection_markdown();
    assert_eq!(md, "**bold** text\n\n- a");
    assert_eq!(ed.selection_text(), "bold text\na");
    // Paste blocks in the middle of a paragraph.
    let mut ed = Editor::parse("before after\n");
    caret_after(&mut ed, "before");
    ed.paste_markdown("one\n\n## two\n\nthree");
    assert_eq!(ed.to_markdown(), "beforeone\n\n## two\n\nthree after\n");
    // Inline paste keeps marks.
    let mut ed = Editor::parse("x\n");
    ed.move_doc_edge(true, false);
    ed.paste_markdown(" *it*");
    assert_eq!(ed.to_markdown(), "x *it*\n");
    // Whole blocks are copied as their own bytes.
    let src = "keep   these\nbytes\n\nnext\n";
    let mut ed = Editor::parse(src);
    ed.select_all();
    assert_eq!(ed.selection_markdown(), "keep   these\nbytes\n\nnext");
}

#[test]
fn code_blocks() {
    let mut ed = Editor::parse("```rust\nfn a() {}\n```\n");
    caret_after(&mut ed, "{}");
    ed.enter();
    ed.insert_text("fn b() {}");
    assert_eq!(ed.to_markdown(), "```rust\nfn a() {}\nfn b() {}\n```\n");
    ed.enter();
    ed.enter();
    ed.enter(); // the third Enter on an empty last line leaves the block
    ed.insert_text("text");
    assert_eq!(ed.to_markdown(), "```rust\nfn a() {}\nfn b() {}\n```\n\ntext\n");
    caret_after(&mut ed, "text");
    ed.set_block_style(BlockStyle::Code);
    assert!(ed.to_markdown().ends_with("```\ntext\n```\n"));
}

#[test]
fn quotes_and_headings() {
    let mut ed = Editor::parse("> quoted\n");
    caret_after(&mut ed, "quoted");
    ed.enter();
    ed.enter(); // empty last paragraph in a quote: out of the quote
    ed.insert_text("out");
    assert_eq!(ed.to_markdown(), "> quoted\n\nout\n");
    ed.set_block_style(BlockStyle::Heading(2));
    assert_eq!(ed.to_markdown(), "> quoted\n\n## out\n");
    ed.set_block_style(BlockStyle::Heading(2));
    assert_eq!(ed.to_markdown(), "> quoted\n\nout\n");
    ed.toggle_quote();
    assert_eq!(ed.to_markdown(), "> quoted\n\n> out\n");
    ed.toggle_quote();
    assert_eq!(ed.to_markdown(), "> quoted\n\nout\n");
}

#[test]
fn list_toggles() {
    let mut ed = Editor::parse("a\n\nb\n");
    caret_after(&mut ed, "a");
    ed.toggle_list(ListKind::Bullet);
    assert_eq!(ed.to_markdown(), "- a\n\nb\n");
    caret_after(&mut ed, "b");
    ed.toggle_list(ListKind::Bullet);
    // Joined with the list before it.
    let md = ed.to_markdown();
    assert!(md == "- a\n- b\n" || md == "- a\n\n- b\n", "{md:?}");
    ed.toggle_list(ListKind::Ordered);
    assert_eq!(ed.to_markdown(), "1. a\n2. b\n");
    ed.toggle_list(ListKind::Task);
    assert_eq!(ed.to_markdown(), "- [ ] a\n- [ ] b\n");
    let item = ed.leaf(ed.head).unwrap().path.clone();
    ed.toggle_task(ed.head.block, &item[..item.len() - 1]);
    assert_eq!(ed.to_markdown(), "- [ ] a\n- [x] b\n");
    ed.toggle_list(ListKind::Task);
    assert_eq!(ed.to_markdown(), "a\n\nb\n");
}

#[test]
fn tables_tab_and_align() {
    let mut ed = Editor::parse("| a | b |\n|---|---|\n| 1 | 2 |\n");
    caret_after(&mut ed, "2");
    ed.indent(); // Tab in the last cell adds a row
    ed.insert_text("3");
    ed.set_column_align(Some(markie_rich::model::Align::Right));
    let md = ed.to_markdown();
    assert_eq!(md, "| a   | b   |\n| --: | --- |\n| 1   | 2   |\n| 3   |     |\n");
    // Enter in a cell is a line break, written as <br>.
    caret_after(&mut ed, "1");
    ed.enter();
    ed.insert_text("x");
    assert!(ed.to_markdown().contains("| 1<br>x |"));
}

#[test]
fn images_alignment_and_find() {
    let mut ed = Editor::parse("Para\n\n![shot](a.png)\n");
    let img = Pos::new(1, 0, 0);
    ed.set_image_width(img, Some(300));
    assert_eq!(ed.to_markdown(), "Para\n\n<img src=\"a.png\" alt=\"shot\" width=\"300\">\n");
    caret_after(&mut ed, "Para");
    ed.set_align(Some("center"));
    assert_eq!(ed.to_markdown(), "<p style=\"text-align: center;\">Para</p>\n\n<img src=\"a.png\" alt=\"shot\" width=\"300\">\n");
    let again = Editor::parse(&ed.to_markdown());
    assert_eq!(again.doc.nodes(), ed.doc.nodes());
    let found = ed.find("para", false);
    assert_eq!(found.len(), 1);
    ed.replace_all("Para", "Text", true);
    assert!(ed.to_markdown().starts_with("<p style=\"text-align: center;\">Text</p>"));
}

#[test]
fn atoms_select_then_delete() {
    let mut ed = Editor::parse("above\n\n---\n\nbelow\n");
    caret_after(&mut ed, "below");
    ed.move_leaf_edge(false, false);
    ed.backspace(); // selects the rule
    assert!(ed.selected_atom().is_some());
    ed.backspace(); // deletes it
    assert_eq!(ed.to_markdown(), "above\n\nbelow\n");
}

#[test]
fn source_blocks_edit_as_written() {
    let mut ed = Editor::parse("<div>raw</div>\n\ntext\n");
    caret_after(&mut ed, "raw");
    ed.insert_text("er");
    assert_eq!(ed.to_markdown(), "<div>rawer</div>\n\ntext\n");
}

#[test]
fn outline_lists_headings() {
    let ed = Editor::parse("# A\n\ntext\n\n## B\n\n> ### C\n");
    let o: Vec<(u8, String)> = ed.outline().into_iter().map(|e| (e.level, e.text)).collect();
    assert_eq!(o, vec![(1, "A".into()), (2, "B".into()), (3, "C".into())]);
}

#[test]
fn empty_file_stays_empty() {
    let mut ed = Editor::parse("");
    assert_eq!(ed.to_markdown(), "");
    ed.insert_text("hi");
    assert_eq!(ed.to_markdown().trim_end(), "hi");
}
