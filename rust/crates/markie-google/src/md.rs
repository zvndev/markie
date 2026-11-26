//! Markdown split into the blocks two-way sync compares: one block per Docs
//! paragraph (a paragraph, a heading, one list item), plus code blocks,
//! tables, rules and the rest as whole blocks.
//!
//! Each block has a `key`: a normalized form, so the same content always
//! compares equal however it is spelled. `*` and `-` bullets, `1.` and `3.`
//! numbers, `__bold__` and `**bold**`, loose and tight lists, soft line breaks
//! and trailing spaces all give the same key. Marks on spaces never count,
//! since Markdown cannot show them. Base, local and remote are all read with
//! this one parser, so a sync never sees a change that is only spelling.
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::ops::Range;

/// One stretch of text with the marks Markdown and Docs both have.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    pub link: Option<String>,
}

impl Run {
    pub fn plain(text: impl Into<String>) -> Self {
        Self { text: text.into(), ..Default::default() }
    }
    pub fn marks(&self) -> Marks {
        Marks { bold: self.bold, italic: self.italic, strike: self.strike, code: self.code, link: self.link.clone() }
    }
}

/// The marks of one character.
#[derive(Debug, Clone, PartialEq, Eq, Default, Hash)]
pub struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    pub link: Option<String>,
}

impl Marks {
    /// What Markdown can show on this character: nothing on whitespace.
    pub fn visible(&self, c: char) -> Marks {
        if is_space(c) { Marks::default() } else { Marks { link: self.link.as_deref().map(norm_url), ..self.clone() } }
    }
}

pub fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{b}'
}

/// A link target as Markdown keeps it: the converter writes spaces and angle
/// brackets percent-encoded, so both sides compare in that form.
pub fn norm_url(u: &str) -> String {
    u.replace('<', "%3C").replace('>', "%3E").replace(' ', "%20")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ListKind {
    Bullet,
    Ordered,
    Check,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Paragraph,
    Heading(u8),
    Item { list: ListKind, level: usize, checked: bool },
    Code(Vec<String>),
    Rule,
    Table,
    Footnote,
    Quote,
    Html,
    FrontMatter,
}

impl Kind {
    /// A paragraph, heading or list item: one Docs paragraph of text.
    pub fn is_text(&self) -> bool {
        matches!(self, Kind::Paragraph | Kind::Heading(_) | Kind::Item { .. })
    }
    pub fn is_item(&self) -> bool {
        matches!(self, Kind::Item { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub kind: Kind,
    pub runs: Vec<Run>,
    /// The block's own bytes in the source: for a list item, its line(s)
    /// without its nested items.
    pub range: Range<usize>,
    pub key: String,
    /// Why this block can never be written to Google, in plain words.
    pub read_only: Option<&'static str>,
}

impl Block {
    /// The text a Docs paragraph would hold: soft breaks are spaces, hard
    /// breaks Docs' vertical tab.
    pub fn plain(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Parsed {
    pub text: String,
    pub blocks: Vec<Block>,
}

impl Parsed {
    pub fn keys(&self) -> Vec<&str> {
        self.blocks.iter().map(|b| b.key.as_str()).collect()
    }
}

fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
}

struct Open {
    kind: Kind,
    runs: Vec<Run>,
    start: usize,
    end: usize,
    read_only: Option<&'static str>,
    /// Raw text that is part of the key but not of the runs (images, HTML).
    extra: String,
    paragraphs: usize,
}

struct ListCtx {
    ordered: bool,
}

#[derive(Default)]
struct Inline {
    bold: usize,
    italic: usize,
    strike: usize,
    links: Vec<String>,
}

impl Inline {
    fn run(&self, text: String, code: bool) -> Run {
        Run { text, bold: self.bold > 0, italic: self.italic > 0, strike: self.strike > 0, code, link: self.links.last().cloned() }
    }
}

/// Parse a whole Markdown file into blocks.
pub fn parse(text: &str) -> Parsed {
    let mut blocks: Vec<Block> = Vec::new();
    let mut lists: Vec<ListCtx> = Vec::new();
    // Container depth outside lists that swallows everything into one block.
    let mut whole: Option<(Open, usize)> = None;
    let mut open: Option<Open> = None;
    let mut inline = Inline::default();
    let mut item_stack: Vec<Option<usize>> = Vec::new();
    let finish = |o: Open, blocks: &mut Vec<Block>, text: &str| {
        let end = trim_end_at(text, o.start, o.end);
        let start = o.start + text[o.start..end].len() - text[o.start..end].trim_start_matches([' ', '\t']).len();
        let mut b = Block { kind: o.kind, runs: o.runs, range: start..end, key: String::new(), read_only: o.read_only };
        if b.kind.is_item() && o.paragraphs > 1 {
            b.read_only = Some("list items with more than one paragraph");
        }
        b.key = key_of(&b, &o.extra);
        blocks.push(b);
    };

    for (event, range) in Parser::new_ext(text, options()).into_offset_iter() {
        // Inside a quote, table, footnote, HTML or code block: one block, raw.
        if let Some((o, depth)) = whole.as_mut() {
            match &event {
                Event::Start(_) => *depth += 1,
                Event::End(_) => {
                    *depth -= 1;
                    if *depth == 0 {
                        let (mut o, _) = whole.take().unwrap();
                        o.end = range.end;
                        if let Kind::Code(lines) = &mut o.kind {
                            let body = std::mem::take(&mut o.extra);
                            *lines = code_lines(&body);
                        }
                        finish(o, &mut blocks, text);
                    }
                    continue;
                }
                _ => {}
            }
            match event {
                Event::Text(t) | Event::Code(t) | Event::Html(t) | Event::InlineHtml(t) => o.extra.push_str(&t),
                Event::SoftBreak | Event::HardBreak => o.extra.push(' '),
                Event::FootnoteReference(l) => o.extra.push_str(&format!("[^{l}]")),
                Event::TaskListMarker(c) => o.extra.push_str(if c { "[x]" } else { "[ ]" }),
                Event::Start(Tag::TableCell) => o.extra.push('|'),
                Event::Start(Tag::TableRow) | Event::Start(Tag::TableHead) => o.extra.push('\n'),
                Event::Start(Tag::Image { dest_url, .. }) => o.extra.push_str(&format!("![{dest_url}]")),
                Event::Start(Tag::Link { dest_url, .. }) => o.extra.push_str(&format!("<{dest_url}>")),
                Event::Start(Tag::Strong) => o.extra.push_str("**"),
                Event::Start(Tag::Emphasis) => o.extra.push('*'),
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(tag) => {
                let whole_kind = match &tag {
                    Tag::BlockQuote(_) => Some((Kind::Quote, Some("quotes"))),
                    Tag::Table(_) => Some((Kind::Table, Some("tables"))),
                    Tag::FootnoteDefinition(_) => Some((Kind::Footnote, Some("footnotes"))),
                    Tag::HtmlBlock => Some((Kind::Html, Some("HTML"))),
                    Tag::MetadataBlock(_) => Some((Kind::FrontMatter, Some("front matter"))),
                    Tag::CodeBlock(_) => Some((Kind::Code(Vec::new()), None)),
                    _ => None,
                };
                if let Some((kind, ro)) = whole_kind {
                    // Inside a list item: the item cannot be written back.
                    if let Some(o) = open.as_mut().filter(|o| o.kind.is_item()) {
                        o.read_only = Some("list items with blocks inside");
                        o.extra.push_str(&text[range.clone()]);
                        o.end = o.end.max(range.end);
                        // Swallowed into the item: the inner block is dropped when it ends.
                        let _ = ro;
                        whole = Some((Open { kind, runs: Vec::new(), start: range.start, end: range.end, read_only: Some("__drop"), extra: String::new(), paragraphs: 0 }, 1));
                        continue;
                    }
                    if !lists.is_empty() {
                        // A block after an item's text, still inside the list item.
                        if let Some(Some(idx)) = item_stack.last() {
                            let b: &mut Block = &mut blocks[*idx];
                            b.read_only = Some("list items with blocks inside");
                            b.key.push_str("\u{3}");
                            b.key.push_str(&text[range.clone()]);
                        }
                        whole = Some((Open { kind, runs: Vec::new(), start: range.start, end: range.end, read_only: Some("__drop"), extra: String::new(), paragraphs: 0 }, 1));
                        continue;
                    }
                    let mut o = Open { kind, runs: Vec::new(), start: range.start, end: range.end, read_only: ro, extra: String::new(), paragraphs: 0 };
                    let label = match o.kind {
                        Kind::Quote => "quote:",
                        Kind::Table => "table:",
                        Kind::Footnote => "footnote:",
                        Kind::Html => "html:",
                        Kind::FrontMatter => "meta:",
                        _ => "",
                    };
                    o.extra.push_str(label);
                    if let Tag::FootnoteDefinition(l) = &tag {
                        o.extra.push_str(&format!("[^{l}]:"));
                    }
                    whole = Some((o, 1));
                    continue;
                }
                match tag {
                    Tag::Paragraph => {
                        if let Some(o) = open.as_mut().filter(|o| o.kind.is_item()) {
                            o.paragraphs += 1;
                            if o.paragraphs > 1 {
                                o.runs.push(Run::plain("\u{b}"));
                            }
                            o.end = o.end.max(range.end);
                        } else if open.is_none() && !lists.is_empty() {
                            // A second paragraph after the item's nested list.
                            if let Some(Some(idx)) = item_stack.last() {
                                let b: &mut Block = &mut blocks[*idx];
                                b.read_only = Some("list items with more than one paragraph");
                                b.key.push_str("\u{3}");
                                b.key.push_str(&text[range.clone()]);
                            }
                            whole = Some((Open { kind: Kind::Paragraph, runs: Vec::new(), start: range.start, end: range.end, read_only: Some("__drop"), extra: String::new(), paragraphs: 0 }, 1));
                        } else {
                            open = Some(Open { kind: Kind::Paragraph, runs: Vec::new(), start: range.start, end: range.end, read_only: None, extra: String::new(), paragraphs: 1 });
                        }
                    }
                    Tag::Heading { level, .. } => {
                        open = Some(Open { kind: Kind::Heading(heading_number(level)), runs: Vec::new(), start: range.start, end: range.end, read_only: None, extra: String::new(), paragraphs: 1 });
                    }
                    Tag::List(start) => {
                        // The item before keeps its text; its nested items follow.
                        if let Some(o) = open.take() {
                            let idx = blocks.len();
                            finish(o, &mut blocks, text);
                            if let Some(slot) = item_stack.last_mut() {
                                *slot = Some(idx);
                            }
                        }
                        lists.push(ListCtx { ordered: start.is_some() });
                    }
                    Tag::Item => {
                        let ctx = lists.last().map(|l| l.ordered).unwrap_or(false);
                        let level = lists.len().saturating_sub(1);
                        open = Some(Open {
                            kind: Kind::Item { list: if ctx { ListKind::Ordered } else { ListKind::Bullet }, level, checked: false },
                            runs: Vec::new(),
                            start: range.start,
                            end: range.start,
                            read_only: None,
                            extra: String::new(),
                            paragraphs: 0,
                        });
                        item_stack.push(None);
                    }
                    Tag::Emphasis => inline.italic += 1,
                    Tag::Strong => inline.bold += 1,
                    Tag::Strikethrough => inline.strike += 1,
                    Tag::Link { dest_url, .. } => inline.links.push(dest_url.to_string()),
                    Tag::Image { dest_url, .. } => {
                        if let Some(o) = open.as_mut() {
                            o.read_only = Some("images");
                            o.extra.push_str(&format!("![{dest_url}]"));
                        }
                        inline.links.push(String::new());
                    }
                    _ => {}
                }
            }
            Event::End(end) => match end {
                TagEnd::Paragraph => {
                    if let Some(o) = open.as_mut() {
                        o.end = o.end.max(range.end);
                        if !o.kind.is_item() {
                            let o = open.take().unwrap();
                            finish(o, &mut blocks, text);
                        }
                    }
                }
                TagEnd::Heading(_) => {
                    if let Some(mut o) = open.take() {
                        o.end = range.end;
                        finish(o, &mut blocks, text);
                    }
                }
                TagEnd::Item => {
                    if let Some(mut o) = open.take() {
                        o.end = o.end.max(range.end);
                        finish(o, &mut blocks, text);
                    }
                    item_stack.pop();
                }
                TagEnd::List(_) => {
                    lists.pop();
                }
                TagEnd::Emphasis => inline.italic = inline.italic.saturating_sub(1),
                TagEnd::Strong => inline.bold = inline.bold.saturating_sub(1),
                TagEnd::Strikethrough => inline.strike = inline.strike.saturating_sub(1),
                TagEnd::Link | TagEnd::Image => {
                    inline.links.pop();
                }
                _ => {}
            },
            Event::Text(t) => push_text(&mut open, &inline, &t, false, range.end),
            Event::Code(t) => push_text(&mut open, &inline, &t, true, range.end),
            Event::SoftBreak => push_text(&mut open, &inline, " ", false, range.end),
            Event::HardBreak => push_text(&mut open, &inline, "\u{b}", false, range.end),
            Event::TaskListMarker(checked) => {
                if let Some(Open { kind: Kind::Item { list, checked: c, .. }, .. }) = open.as_mut() {
                    *list = ListKind::Check;
                    *c = checked;
                }
            }
            Event::FootnoteReference(l) => {
                if let Some(o) = open.as_mut() {
                    o.read_only = Some("footnotes");
                    o.extra.push_str(&format!("[^{l}]"));
                    o.end = o.end.max(range.end);
                }
            }
            Event::InlineHtml(h) | Event::Html(h) => {
                if let Some(o) = open.as_mut() {
                    o.read_only = Some("HTML");
                    o.extra.push_str(&h);
                    o.end = o.end.max(range.end);
                }
            }
            Event::Rule => {
                blocks.push(Block { kind: Kind::Rule, runs: Vec::new(), range: range.start..trim_end_at(text, range.start, range.end), key: "R".into(), read_only: Some("horizontal lines") });
            }
            _ => {}
        }
    }
    let blocks = blocks.into_iter().filter(|b| b.read_only != Some("__drop")).collect();
    Parsed { text: text.to_string(), blocks }
}

fn push_text(open: &mut Option<Open>, inline: &Inline, t: &str, code: bool, end: usize) {
    let Some(o) = open.as_mut() else { return };
    if inline.links.last().is_some_and(|l| l.is_empty()) {
        // Image alt text: part of the key only.
        o.extra.push_str(t);
        return;
    }
    o.runs.push(inline.run(t.to_string(), code));
    o.end = o.end.max(end);
}

fn heading_number(l: HeadingLevel) -> u8 {
    match l {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// A code block's lines, without the blank lines around them.
fn code_lines(body: &str) -> Vec<String> {
    let mut lines: Vec<String> = body.strip_suffix('\n').unwrap_or(body).split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    lines
}

fn trim_end_at(text: &str, start: usize, end: usize) -> usize {
    let end = end.min(text.len()).max(start);
    start + text[start..end].trim_end().len()
}

/// Per character: the character and the marks Markdown can show on it.
pub fn styled_chars(runs: &[Run]) -> Vec<(char, Marks)> {
    let mut out = Vec::new();
    for r in runs {
        let m = r.marks();
        for c in r.text.chars() {
            out.push((c, m.visible(c)));
        }
    }
    out
}

/// Trim spaces at both ends: Markdown never keeps them.
pub fn trim_chars(chars: &[(char, Marks)]) -> &[(char, Marks)] {
    let start = chars.iter().position(|(c, _)| !is_space(*c)).unwrap_or(chars.len());
    let end = chars.iter().rposition(|(c, _)| !is_space(*c)).map_or(start, |i| i + 1);
    &chars[start..end.max(start)]
}

fn runs_key(runs: &[Run], heading: bool, check: bool) -> String {
    let chars = styled_chars(runs);
    let chars = trim_chars(&chars);
    let mut out = String::new();
    let mut last: Option<Marks> = None;
    for (c, m) in chars {
        let mut m = m.clone();
        if heading {
            m.bold = false;
        }
        if check {
            m.strike = false;
        }
        // Spaces inside a run are collapsed the way Markdown reads them.
        let c = if *c == '\t' || *c == '\n' || *c == '\r' { ' ' } else { *c };
        if last.as_ref() != Some(&m) {
            out.push('\u{1}');
            out.push_str(&format!("{}{}{}{}{}", m.bold as u8, m.italic as u8, m.strike as u8, m.code as u8, m.link.as_deref().unwrap_or("")));
            out.push('\u{2}');
            last = Some(m);
        }
        out.push(c);
    }
    out
}

fn key_of(b: &Block, extra: &str) -> String {
    let body = match &b.kind {
        Kind::Paragraph => format!("P{}", runs_key(&b.runs, false, false)),
        Kind::Heading(n) => format!("H{n}{}", runs_key(&b.runs, true, false)),
        Kind::Item { list, level, checked } => {
            let kind = match list {
                ListKind::Bullet => "b".to_string(),
                ListKind::Ordered => "o".to_string(),
                ListKind::Check => format!("c{}", *checked as u8),
            };
            format!("L{kind}{level}{}", runs_key(&b.runs, false, *list == ListKind::Check))
        }
        Kind::Code(lines) => format!("C{}", lines.join("\n")),
        Kind::Rule => "R".into(),
        _ => format!("X{}", extra.split_whitespace().collect::<Vec<_>>().join(" ")),
    };
    if extra.is_empty() || !b.kind.is_text() { body } else { format!("{body}\u{3}{extra}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(md: &str) -> Vec<String> {
        parse(md).blocks.into_iter().map(|b| b.key).collect()
    }

    #[test]
    fn spelling_never_changes_a_key() {
        assert_eq!(keys("- a\n- b\n"), keys("* a\n\n* b\n"));
        assert_eq!(keys("1. a\n2. b\n"), keys("3) a\n4) b\n"));
        assert_eq!(keys("__bold__ and _it_\n"), keys("**bold** and *it*\n"));
        assert_eq!(keys("one\ntwo\n"), keys("one two\n"));
        assert_eq!(keys("**bold** x  \n"), keys("**bold** x\n"));
        assert_eq!(keys("Title\n=====\n"), keys("# Title\n"));
        assert_eq!(keys("# **Title**\n"), keys("# Title\n"));
        assert_ne!(keys("a\n"), keys("b\n"));
        assert_ne!(keys("- a\n"), keys("1. a\n"));
        assert_ne!(keys("- [ ] a\n"), keys("- [x] a\n"));
    }

    #[test]
    fn list_items_are_blocks_with_their_level() {
        let p = parse("- Fruit\n    - Apple\n        - Green\n    - Pear\n- Bread\n\nAfter.\n");
        let levels: Vec<_> = p.blocks.iter().map(|b| match b.kind { Kind::Item { level, .. } => level as i32, _ => -1 }).collect();
        assert_eq!(levels, [0, 1, 2, 1, 0, -1]);
        assert_eq!(&p.text[p.blocks[0].range.clone()], "- Fruit");
        assert_eq!(&p.text[p.blocks[2].range.clone()], "- Green");
        assert_eq!(p.blocks[1].plain(), "Apple");
    }

    #[test]
    fn inline_marks_and_breaks_become_runs() {
        let p = parse("Plain **bold** [link](https://x.example/a) `code`\\\nnext\n");
        let b = &p.blocks[0];
        assert_eq!(b.plain(), "Plain bold link code\u{b}next");
        assert!(b.runs.iter().any(|r| r.bold && r.text == "bold"));
        assert!(b.runs.iter().any(|r| r.code && r.text == "code"));
        assert!(b.runs.iter().any(|r| r.link.as_deref() == Some("https://x.example/a")));
    }

    #[test]
    fn constructs_that_cannot_go_back_are_read_only() {
        let p = parse("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n![x](y.png)\n\n> quote\n\nfine\n");
        let ro: Vec<_> = p.blocks.iter().map(|b| b.read_only).collect();
        assert_eq!(ro, [Some("tables"), Some("horizontal lines"), Some("images"), Some("quotes"), None]);
    }

    #[test]
    fn code_blocks_keep_their_lines() {
        let p = parse("```rust\n\nfn main() {}\n\n```\n");
        assert_eq!(p.blocks[0].kind, Kind::Code(vec!["fn main() {}".into()]));
        assert_eq!(p.blocks[0].key, parse("```\nfn main() {}\n```\n").blocks[0].key);
    }

    #[test]
    fn task_items_and_nested_blocks() {
        let p = parse("- [x] done\n- [ ] todo\n    ```\n    code\n    ```\n");
        assert!(matches!(p.blocks[0].kind, Kind::Item { list: ListKind::Check, checked: true, .. }));
        assert_eq!(p.blocks.len(), 2);
        assert_eq!(p.blocks[1].read_only, Some("list items with blocks inside"));
    }
}
