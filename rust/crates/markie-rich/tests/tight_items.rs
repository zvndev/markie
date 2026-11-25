//! Tight list items whose text opens with an inline tag (bold, italic,
//! strike, a link, a picture). pulldown-cmark puts no paragraph around a
//! tight item's text, so the item's first event is that tag. The parser
//! used to read it as an unknown block and keep the whole list as source,
//! which View drew as a raw box in every Markdown style (reported 2026-11-24).

use markie_rich::document::{BlockContent, Document};
use markie_rich::editor::Editor;
use markie_rich::model::{Inline, Node};

const NOTE: &str = "## Before the picnic\n\n- [ ] **Pick a park.** Say \"yes\" and I book the shelter for Saturday.\n- [ ] **Bring a dish.** Tell me what you are making so nothing doubles up.\n\n## 1. Getting there\n";

fn no_opaque(md: &str) -> Document {
    let doc = Document::parse(md);
    for b in &doc.blocks {
        assert!(
            matches!(b.content, BlockContent::Nodes(_)),
            "block kept as source: {:?}\nin {md:?}",
            b.source
        );
    }
    assert_eq!(doc.to_markdown(), md, "zero edit is byte exact");
    doc
}

fn first_text(nodes: &[Node]) -> &Inline {
    match nodes.first() {
        Some(Node::Paragraph { content, .. }) => &content[0],
        other => panic!("expected a paragraph, got {other:?}"),
    }
}

#[test]
fn a_report_task_list_is_a_task_list() {
    let doc = no_opaque(NOTE);
    let Node::TaskList { items } = &doc.blocks[1].nodes()[0] else { panic!("{:?}", doc.blocks[1].nodes()) };
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|i| !i.checked));
    match first_text(&items[0].content) {
        Inline::Text { text, marks } => {
            assert_eq!(text, "Pick a park.");
            assert!(marks.bold);
        }
        other => panic!("{other:?}"),
    }
    let Node::Paragraph { content, .. } = &items[1].content[0] else { panic!() };
    let plain: String = content
        .iter()
        .map(|i| match i {
            Inline::Text { text, .. } => text.as_str(),
            _ => "",
        })
        .collect();
    assert_eq!(plain, "Bring a dish. Tell me what you are making so nothing doubles up.");
}

#[test]
fn checking_a_box_writes_x_and_keeps_the_rest() {
    let mut ed = Editor::parse(NOTE);
    let b = 1;
    let leaf = ed.leaves_of(b)[0].path.clone();
    ed.toggle_task(b, &leaf[..leaf.len() - 1]);
    let want = NOTE.replacen("- [ ] **Pick", "- [x] **Pick", 1);
    assert_eq!(ed.to_markdown(), want);
    ed.toggle_task(b, &leaf[..leaf.len() - 1]);
    assert_eq!(ed.to_markdown(), NOTE, "unchecking restores the bytes");
}

#[test]
fn every_list_kind_may_open_with_a_mark() {
    for md in [
        "- **a** b\n",
        "- *a* b\n",
        "- _a_ b\n",
        "- ~~a~~ b\n",
        "- [a link](https://example.com) b\n",
        "- <https://example.com> b\n",
        "- ![p](p.png)\n",
        "- **a**\n",
        "1. **a** b\n2. *c* d\n",
        "3) **a** b\n",
        "- [ ] *a* b\n- [x] ~~c~~ d\n",
        "- [ ] [link](https://example.com) and `code`\n",
        "- [ ] `code` first, then **bold**\n",
        "* **star** item\n+ **plus** item\n",
    ] {
        let doc = no_opaque(md);
        assert_eq!(doc.blocks.len(), if md.starts_with("* ") { 2 } else { 1 }, "{md:?}");
    }
}

#[test]
fn nested_task_lists_with_marks() {
    let md = "- [ ] **parent** item\n  - [x] *child* done\n  - [ ] [linked](https://example.com) child\n- [ ] second\n";
    let doc = no_opaque(md);
    let Node::TaskList { items } = &doc.blocks[0].nodes()[0] else { panic!() };
    assert_eq!(items.len(), 2);
    let Some(Node::TaskList { items: inner }) = items[0].content.get(1) else { panic!("{:?}", items[0].content) };
    assert_eq!(inner.len(), 2);
    assert!(inner[0].checked);
    let mixed = "1. **one**\n   - [ ] **sub task**\n2. two\n";
    no_opaque(mixed);
}

#[test]
fn task_list_right_after_a_heading_and_in_a_quote() {
    let doc = no_opaque("## Heading\n- [ ] **a** b\n- [x] c\n");
    assert!(matches!(doc.blocks[0].nodes()[0], Node::Heading { .. }));
    assert!(matches!(doc.blocks[1].nodes()[0], Node::TaskList { .. }));

    let doc = no_opaque("> - [ ] **quoted** task\n> - [x] *done*\n");
    let Node::Blockquote(inner) = &doc.blocks[0].nodes()[0] else { panic!() };
    assert!(matches!(inner[0], Node::TaskList { .. }), "{inner:?}");

    let doc = no_opaque("> 1. **first**\n> 2. second\n");
    let Node::Blockquote(inner) = &doc.blocks[0].nodes()[0] else { panic!() };
    assert!(matches!(inner[0], Node::OrderedList { .. }), "{inner:?}");
}

#[test]
fn edited_lists_with_marks_read_back_the_same() {
    // An edited block goes through the serializer; parsing what it wrote
    // must give the same nodes.
    for md in [NOTE, "- **a** b\n- *c*\n", "1. ~~x~~ y\n", "- [ ] [l](https://e.com) z\n"] {
        let doc = Document::parse(md);
        let nodes = doc.nodes();
        let written = markie_rich::serialize::nodes_to_markdown(&nodes);
        assert_eq!(Document::parse(&written).nodes(), nodes, "{md:?} wrote {written:?}");
    }
}
