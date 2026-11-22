//! Markdown as an mdast-shaped tree, the one `export-formats.ts` walks
//! (remark-parse, remark-gfm, remark-math with the strict rule).

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, LinkType, Parser, Tag, TagEnd};

use crate::autolink;
use crate::markdown::prepare;
use crate::strict_math::{MARK, Span};

#[derive(Clone, Debug, PartialEq)]
pub enum Md {
    Heading(u8, Vec<Md>),
    Paragraph(Vec<Md>),
    Quote(Vec<Md>),
    List { ordered: bool, start: u64, items: Vec<Md> },
    Item { checked: Option<bool>, children: Vec<Md> },
    Code(String),
    Math(String),
    /// Rows of cells of phrasing.
    Table(Vec<Vec<Vec<Md>>>),
    Rule,
    Html(String),
    FootnoteDefinition { label: String, children: Vec<Md> },
    Text(String),
    Strong(Vec<Md>),
    Emphasis(Vec<Md>),
    Delete(Vec<Md>),
    InlineCode(String),
    InlineMath(String),
    Break,
    Link { url: String, children: Vec<Md> },
    Image { alt: String },
    FootnoteReference(String),
    InlineHtml(String),
}

enum Frame {
    Root(Vec<Md>),
    Block(Tag<'static>, Vec<Md>),
    Item(Option<bool>, Vec<Md>),
    Table(Vec<Vec<Vec<Md>>>, Vec<Vec<Md>>),
    Inline(Tag<'static>, Vec<Md>),
    Image(String),
}

/// Parses Markdown into top-level mdast nodes.
pub fn parse(markdown: &str) -> Vec<Md> {
    let (source, math, opts) = prepare(markdown);
    let mut stack: Vec<Frame> = vec![Frame::Root(Vec::new())];
    let mut code: Option<String> = None;
    let mut html: Option<String> = None;
    let mut link_depth = 0usize;

    fn push(stack: &mut Vec<Frame>, node: Md) {
        match stack.last_mut() {
            Some(Frame::Root(c)) | Some(Frame::Block(_, c)) | Some(Frame::Item(_, c)) | Some(Frame::Inline(_, c)) => c.push(node),
            Some(Frame::Table(_, row)) => {
                if let Some(cell) = row.last_mut() {
                    cell.push(node);
                }
            }
            Some(Frame::Image(alt)) => alt.push_str(&plain(&node)),
            None => {}
        }
    }
    // Inline content directly in an item (a tight list) sits in a paragraph.
    fn inline_target(stack: &mut Vec<Frame>) {
        if let Some(Frame::Item(_, children)) = stack.last_mut()
            && !matches!(children.last(), Some(Md::Paragraph(_)))
        {
            children.push(Md::Paragraph(Vec::new()));
        }
    }
    fn push_inline(stack: &mut Vec<Frame>, node: Md) {
        if let Some(Frame::Item(_, children)) = stack.last_mut() {
            if let Some(Md::Paragraph(p)) = children.last_mut() {
                p.push(node);
                return;
            }
            children.push(Md::Paragraph(vec![node]));
            return;
        }
        push(stack, node);
    }

    for event in Parser::new_ext(&source, opts) {
        if let Some(text) = &mut code {
            match event {
                Event::Text(t) => text.push_str(&t),
                Event::End(TagEnd::CodeBlock) => {
                    let mut value = code.take().unwrap();
                    if value.ends_with('\n') {
                        value.pop();
                    }
                    push(&mut stack, Md::Code(value));
                }
                _ => {}
            }
            continue;
        }
        if let Some(text) = &mut html {
            match event {
                Event::Html(t) | Event::Text(t) => text.push_str(&t),
                Event::End(TagEnd::HtmlBlock) => {
                    let value = html.take().unwrap();
                    push(&mut stack, Md::Html(value.trim_end_matches('\n').to_string()));
                }
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(tag) => match tag {
                Tag::CodeBlock(_) => code = Some(String::new()),
                Tag::HtmlBlock => html = Some(String::new()),
                Tag::Item => stack.push(Frame::Item(None, Vec::new())),
                Tag::Table(_) => stack.push(Frame::Table(Vec::new(), Vec::new())),
                Tag::TableHead | Tag::TableRow => {}
                Tag::TableCell => {
                    if let Some(Frame::Table(_, row)) = stack.last_mut() {
                        row.push(Vec::new());
                    }
                }
                Tag::Image { .. } => {
                    inline_target(&mut stack);
                    stack.push(Frame::Image(String::new()));
                }
                Tag::Emphasis | Tag::Strong | Tag::Strikethrough | Tag::Link { .. } => {
                    inline_target(&mut stack);
                    if matches!(tag, Tag::Link { .. }) {
                        link_depth += 1;
                    }
                    stack.push(Frame::Inline(tag.into_static(), Vec::new()));
                }
                other => stack.push(Frame::Block(other.into_static(), Vec::new())),
            },
            Event::End(end) => match end {
                TagEnd::Item => {
                    if let Some(Frame::Item(checked, children)) = stack.pop() {
                        push(&mut stack, Md::Item { checked, children });
                    }
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some(Frame::Table(rows, row)) = stack.last_mut() {
                        rows.push(std::mem::take(row));
                    }
                }
                TagEnd::TableCell => {}
                TagEnd::Table => {
                    if let Some(Frame::Table(rows, _)) = stack.pop() {
                        push(&mut stack, Md::Table(rows));
                    }
                }
                TagEnd::Image => {
                    if let Some(Frame::Image(alt)) = stack.pop() {
                        push_inline(&mut stack, Md::Image { alt });
                    }
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
                    if let Some(Frame::Inline(tag, children)) = stack.pop() {
                        let node = match tag {
                            Tag::Emphasis => Md::Emphasis(children),
                            Tag::Strong => Md::Strong(children),
                            Tag::Strikethrough => Md::Delete(children),
                            Tag::Link { link_type, dest_url, .. } => {
                                link_depth = link_depth.saturating_sub(1);
                                let url = if link_type == LinkType::Email { format!("mailto:{dest_url}") } else { dest_url.to_string() };
                                Md::Link { url, children }
                            }
                            _ => continue,
                        };
                        push_inline(&mut stack, node);
                    }
                }
                _ => {
                    if let Some(Frame::Block(tag, children)) = stack.pop() {
                        let node = match tag {
                            Tag::Paragraph => match children.as_slice() {
                                [Md::InlineMath(_)] if is_flow_marker(&children) => Md::Math(flow_tex(&children)),
                                _ => Md::Paragraph(children),
                            },
                            Tag::Heading { level, .. } => Md::Heading(level_num(level), children),
                            Tag::BlockQuote(_) => Md::Quote(children),
                            Tag::List(start) => Md::List { ordered: start.is_some(), start: start.unwrap_or(1), items: children },
                            Tag::FootnoteDefinition(label) => Md::FootnoteDefinition { label: label.to_string(), children },
                            _ => continue,
                        };
                        push(&mut stack, node);
                    }
                }
            },
            Event::Text(t) => {
                for node in split_text(&t, &math, link_depth > 0) {
                    push_inline(&mut stack, node);
                }
            }
            Event::Code(c) => push_inline(&mut stack, Md::InlineCode(c.to_string())),
            Event::InlineMath(m) => push_inline(&mut stack, Md::InlineMath(m.to_string())),
            Event::DisplayMath(m) => push_inline(&mut stack, Md::InlineMath(m.to_string())),
            Event::Html(h) | Event::InlineHtml(h) => push_inline(&mut stack, Md::InlineHtml(h.to_string())),
            Event::SoftBreak => push_inline(&mut stack, Md::Text("\n".into())),
            Event::HardBreak => push_inline(&mut stack, Md::Break),
            Event::Rule => push(&mut stack, Md::Rule),
            Event::TaskListMarker(checked) => {
                if let Some(Frame::Item(slot, _)) = stack.last_mut() {
                    *slot = Some(checked);
                }
            }
            Event::FootnoteReference(label) => push_inline(&mut stack, Md::FootnoteReference(label.to_string())),
        }
        let _ = CodeBlockKind::Indented;
    }
    // Flow math markers carry their flag through a side table.
    let mut nodes = match stack.into_iter().next() {
        Some(Frame::Root(n)) => n,
        _ => Vec::new(),
    };
    mark_flow(&mut nodes, &math);
    merge_text(&mut nodes);
    nodes
}

const FLOW_PREFIX: &str = "\u{10FFFC}flow:";

fn is_flow_marker(children: &[Md]) -> bool {
    matches!(children, [Md::InlineMath(t)] if t.starts_with(FLOW_PREFIX))
}

fn flow_tex(children: &[Md]) -> String {
    match children {
        [Md::InlineMath(t)] => t.trim_start_matches(FLOW_PREFIX).to_string(),
        _ => String::new(),
    }
}

fn mark_flow(nodes: &mut [Md], _math: &[Span]) {
    for node in nodes {
        match node {
            Md::Paragraph(c) if is_flow_marker(c) => *node = Md::Math(flow_tex(c)),
            Md::Paragraph(c) | Md::Heading(_, c) | Md::Quote(c) | Md::Item { children: c, .. } | Md::FootnoteDefinition { children: c, .. } | Md::Strong(c) | Md::Emphasis(c) | Md::Delete(c) | Md::Link { children: c, .. } => {
                for child in c.iter_mut() {
                    if let Md::InlineMath(t) = child
                        && t.starts_with(FLOW_PREFIX)
                    {
                        *t = t.trim_start_matches(FLOW_PREFIX).to_string();
                    }
                }
                mark_flow(c, _math);
            }
            Md::List { items, .. } => mark_flow(items, _math),
            _ => {}
        }
    }
}

/// Adjacent text nodes merge, as mdast keeps one text node per run.
fn merge_text(nodes: &mut Vec<Md>) {
    let mut out: Vec<Md> = Vec::with_capacity(nodes.len());
    for node in nodes.drain(..) {
        match (out.last_mut(), node) {
            (Some(Md::Text(a)), Md::Text(b)) => a.push_str(&b),
            (_, mut other) => {
                match &mut other {
                    Md::Paragraph(c) | Md::Heading(_, c) | Md::Quote(c) | Md::Item { children: c, .. } | Md::FootnoteDefinition { children: c, .. } | Md::Strong(c) | Md::Emphasis(c) | Md::Delete(c) | Md::Link { children: c, .. } => merge_text(c),
                    Md::List { items, .. } => merge_text(items),
                    Md::Table(rows) => rows.iter_mut().flatten().for_each(merge_text),
                    _ => {}
                }
                out.push(other);
            }
        }
    }
    *nodes = out;
}

fn split_text(text: &str, math: &[Span], in_link: bool) -> Vec<Md> {
    let mut out = Vec::new();
    let mut rest = text;
    let push_text = |s: &str, out: &mut Vec<Md>| {
        if s.is_empty() {
            return;
        }
        if in_link {
            out.push(Md::Text(s.to_string()));
            return;
        }
        let mut at = 0;
        for found in autolink::find_all(s, None) {
            if found.start > at {
                out.push(Md::Text(s[at..found.start].to_string()));
            }
            out.push(Md::Link { url: found.href.clone(), children: vec![Md::Text(s[found.start..found.end].to_string())] });
            at = found.end;
        }
        if at < s.len() {
            out.push(Md::Text(s[at..].to_string()));
        }
    };
    while let Some(a) = rest.find(MARK) {
        let after = &rest[a + MARK.len_utf8()..];
        let Some(b) = after.find(MARK) else { break };
        push_text(&rest[..a], &mut out);
        if let Some(span) = after[..b].parse::<usize>().ok().and_then(|i| math.get(i)) {
            let tex = if span.flow { format!("{FLOW_PREFIX}{}", span.tex) } else { span.tex.clone() };
            out.push(Md::InlineMath(tex));
        }
        rest = &after[b + MARK.len_utf8()..];
    }
    push_text(rest, &mut out);
    out
}

fn level_num(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// mdast-util-to-string of a node.
pub fn plain(node: &Md) -> String {
    match node {
        Md::Text(t) | Md::InlineCode(t) | Md::InlineMath(t) | Md::Code(t) | Md::Math(t) => t.clone(),
        Md::Image { alt } => alt.clone(),
        Md::Heading(_, c) | Md::Paragraph(c) | Md::Quote(c) | Md::Strong(c) | Md::Emphasis(c) | Md::Delete(c) | Md::Link { children: c, .. } | Md::Item { children: c, .. } | Md::FootnoteDefinition { children: c, .. } => c.iter().map(plain).collect(),
        _ => String::new(),
    }
}
