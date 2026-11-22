//! TipTap behaviours Markie's View mode has in Electron: input rules,
//! Backspace undoing a rule, code block keys and the table bar.

use markie_rich::editor::{Editor, Pos};

fn md(ed: &Editor) -> String {
    ed.to_markdown().trim_end().to_string()
}

fn typed(md: &str, keys: &str) -> Editor {
    let mut ed = Editor::parse(md);
    ed.move_doc_edge(true, false);
    for c in keys.chars() {
        if c == '\n' {
            ed.enter();
        } else {
            ed.insert_text(&c.to_string());
        }
    }
    ed
}

#[test]
fn mark_rules() {
    assert_eq!(md(&typed("", "a **b** c")), "a **b** c");
    let ed = typed("", "a **b**");
    assert_eq!(ed.to_markdown(), "a **b**");
    let markie_rich::Node::Paragraph { content, .. } = &ed.doc.nodes()[0] else { panic!() };
    assert!(content.iter().any(|i| matches!(i, markie_rich::Inline::Text { text, marks } if text == "b" && marks.bold)));
    // What is typed after the rule is plain again.
    assert_eq!(md(&typed("", "**b**c")), "**b**c");
    assert_eq!(md(&typed("", "_i_ ~~s~~ `c` ==h==")), "*i* ~~s~~ `c` <mark>h</mark>");
    // Not after a letter, not inside code.
    assert_eq!(md(&typed("", "x**b**")), "x\\*\\*b\\*\\*");
}

#[test]
fn backspace_undoes_a_rule() {
    let mut ed = typed("", "**b**");
    ed.backspace();
    assert_eq!(md(&ed), "\\*\\*b\\*\\*", "the rule is taken back, the typing kept");
    let mut ed = typed("", "# ");
    ed.backspace();
    assert_eq!(md(&ed), "\\#");
    // Only straight after: a move in between makes Backspace delete again.
    let mut ed = typed("", "# x");
    ed.backspace();
    ed.backspace();
    // An empty heading at the start of the document becomes a paragraph.
    assert!(matches!(ed.doc.nodes()[0], markie_rich::Node::Paragraph { .. }));
}

#[test]
fn block_rules() {
    assert_eq!(md(&typed("", "```rust x")), "```rust\nx\n```");
    assert_eq!(md(&typed("", "```\nx")), "```\nx\n```");
    assert_eq!(md(&typed("", "#\nT")), "# T");
    assert_eq!(md(&typed("", "---")), "---");
    let ed = typed("", "---");
    assert!(matches!(ed.doc.nodes()[0], markie_rich::Node::HorizontalRule));
    assert_eq!(md(&typed("", "*** x")), "---\n\nx");
    assert_eq!(md(&typed("", "3. x")), "3. x");
    assert_eq!(md(&typed("", "-\nx")), "- x");
    assert_eq!(typed("", "![cat](cat.png)").doc.nodes().iter().filter(|n| matches!(n, markie_rich::Node::Image { .. })).count(), 1);
}

#[test]
fn a_new_list_joins_the_one_before() {
    let ed = typed("- a\n", "\n\n- b");
    assert_eq!(ed.to_markdown(), "- a\n- b\n");
    let ed = typed("1. a\n", "\n\n2. b");
    assert_eq!(ed.to_markdown(), "1. a\n2. b\n");
}

#[test]
fn code_block_keys() {
    // Shift-Enter (hard_break) leaves a code block.
    let mut ed = typed("```\ncode\n```\n", "");
    ed.hard_break();
    ed.insert_text("after");
    assert_eq!(ed.to_markdown(), "```\ncode\n```\n\nafter\n");
    // ArrowDown at the end of the last block makes a paragraph.
    let mut ed = typed("```\ncode\n```\n", "");
    assert!(ed.code_arrow_down());
    ed.insert_text("p");
    assert_eq!(ed.to_markdown(), "```\ncode\n```\n\np\n");
    // Backspace in an empty code block makes it a paragraph.
    let mut ed = Editor::parse("x\n\n```\n```\n");
    ed.move_doc_edge(true, false);
    ed.backspace();
    ed.insert_text("t");
    assert_eq!(ed.to_markdown(), "x\n\nt\n");
}

#[test]
fn table_bar() {
    let md = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    let mut ed = Editor::parse(md);
    ed.set_caret(Pos::new(0, 3, 0), false);
    assert!(ed.in_table());
    let at = ed.cell_at_caret().unwrap();
    assert_eq!((at.row, at.col, at.rows, at.cols), (1, 1, 2, 2));
    ed.add_column(true);
    assert_eq!(ed.to_markdown(), "| a   | b   |     |\n| --- | --- | --- |\n| 1   | 2   |     |\n");
    ed.delete_column();
    ed.add_row(true);
    ed.insert_text("3");
    assert!(ed.to_markdown().contains("| 3 "), "{}", ed.to_markdown());
    ed.delete_row();
    assert_eq!(ed.cell_at_caret().unwrap().rows, 2);
    ed.set_caret(Pos::new(0, 0, 0), false);
    ed.add_row(false);
    let at = ed.cell_at_caret().unwrap();
    assert_eq!((at.row, at.rows), (0, 3));
    ed.delete_table();
    assert!(!ed.in_table());
    while ed.undo() {}
    assert_eq!(ed.to_markdown(), md);
}

#[test]
fn an_address_pasted_over_a_selection_links_it() {
    let mut ed = Editor::parse("read this\n");
    ed.set_caret(Pos::new(0, 0, 5), false);
    ed.set_caret(Pos::new(0, 0, 9), true);
    ed.paste_markdown("https://example.com");
    assert_eq!(ed.to_markdown(), "read [this](https://example.com)\n");
}
