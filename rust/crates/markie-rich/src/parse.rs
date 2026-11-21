//! Markdown events to model nodes, the way TipTap reads the same text.
//!
//! TipTap parses Markdown with markdown-it (html, linkify), renders HTML and
//! lets ProseMirror's DOM parser read it back. Several of the rules below are
//! that round trip's side effects, copied on purpose because a shared room
//! must hold the same nodes whichever client seeded it:
//!
//! * whitespace runs collapse to one space, and a block's text is trimmed;
//! * a soft line break directly after an inline element (emphasis, code,
//!   link, image, inline HTML) disappears, and elsewhere it is a space;
//! * a picture is a block, so it splits the paragraph it sits in;
//! * bare addresses become links (linkify).

use std::ops::Range;

use pulldown_cmark::{CodeBlockKind, Event, LinkType, Options, Tag, TagEnd};

use crate::model::*;

pub fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH
        | Options::ENABLE_FOOTNOTES
}

pub type Ev<'a> = (Event<'a>, Range<usize>);

/// Why a block is kept as source only and has no editable nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opaque {
    Html,
    FootnoteDefinition,
    /// Link reference definitions and anything else the parser consumes.
    Definition,
    Unsupported,
}

pub enum Parsed {
    Nodes(Vec<Node>),
    Opaque(Opaque),
}

/// Parse a whole Markdown text into nodes (no block structure kept).
/// Opaque blocks have no nodes, so they are left out.
pub fn parse_nodes(md: &str) -> Vec<Node> {
    crate::document::Document::parse_body(md).nodes()
}

/// Convert the events of one top-level block.
pub fn convert_block_events(src: &str, events: &[Ev]) -> Parsed {
    let mut c = Conv { src, ev: events, i: 0, opaque: None };
    let nodes = c.blocks(None);
    match c.opaque {
        Some(o) => Parsed::Opaque(o),
        None => Parsed::Nodes(nodes),
    }
}

struct Conv<'s, 'e> {
    src: &'s str,
    ev: &'e [Ev<'s>],
    i: usize,
    opaque: Option<Opaque>,
}

/// Inline content in progress, before whitespace rules and image splits.
#[derive(Debug)]
enum Piece {
    Text(String, Marks),
    Math(String),
    HardBreak,
    Image(Node),
    /// A soft break, resolved later by what precedes it.
    Soft { after_element: bool, marks: Marks },
}

impl<'s, 'e> Conv<'s, 'e> {
    fn peek(&self) -> Option<&'e Ev<'s>> {
        self.ev.get(self.i)
    }

    fn fail(&mut self, why: Opaque) {
        if self.opaque.is_none() {
            self.opaque = Some(why);
        }
    }

    /// Read blocks until the End event matching `until` (consumed), or EOF.
    fn blocks(&mut self, until: Option<TagEnd>) -> Vec<Node> {
        let mut out = Vec::new();
        while let Some((ev, range)) = self.peek() {
            match ev {
                Event::End(end) if Some(*end) == until => {
                    self.i += 1;
                    return out;
                }
                Event::Start(Tag::Paragraph) => {
                    self.i += 1;
                    let start = range.start;
                    let pieces = self.inlines(TagEnd::Paragraph);
                    let raw = &self.src[start..range.end];
                    out.extend(paragraph_nodes(pieces, raw));
                }
                Event::Start(Tag::Heading { level, .. }) => {
                    let level = *level as u8;
                    self.i += 1;
                    let pieces = self.inlines(TagEnd::Heading((level as usize).try_into().unwrap()));
                    if pieces.iter().any(|p| matches!(p, Piece::Image(_))) {
                        self.fail(Opaque::Unsupported);
                    }
                    let content = finish_inlines(pieces);
                    out.push(Node::Heading { level, content });
                }
                Event::Start(Tag::BlockQuote(_)) => {
                    self.i += 1;
                    let inner = self.blocks(Some(TagEnd::BlockQuote(None)));
                    out.push(Node::Blockquote(inner));
                }
                Event::Start(Tag::List(start)) => {
                    let start = *start;
                    self.i += 1;
                    out.extend(self.list(start));
                }
                Event::Start(Tag::CodeBlock(kind)) => {
                    let language = match kind {
                        CodeBlockKind::Fenced(info) => {
                            info.split_whitespace().next().map(|s| s.to_string())
                        }
                        CodeBlockKind::Indented => None,
                    };
                    self.i += 1;
                    let mut code = String::new();
                    while let Some((ev, _)) = self.peek() {
                        self.i += 1;
                        match ev {
                            Event::Text(t) => code.push_str(t),
                            Event::End(TagEnd::CodeBlock) => break,
                            _ => {}
                        }
                    }
                    if code.ends_with('\n') {
                        code.pop();
                    }
                    out.push(Node::CodeBlock { language, code });
                }
                Event::Start(Tag::Table(aligns)) => {
                    let aligns = aligns.clone();
                    self.i += 1;
                    out.push(self.table(&aligns));
                }
                Event::Rule => {
                    self.i += 1;
                    out.push(Node::HorizontalRule);
                }
                Event::Start(Tag::HtmlBlock) => {
                    self.fail(Opaque::Html);
                    self.skip_container();
                }
                Event::Start(Tag::FootnoteDefinition(_)) => {
                    self.fail(Opaque::FootnoteDefinition);
                    self.skip_container();
                }
                Event::Start(_) => {
                    self.fail(Opaque::Unsupported);
                    self.skip_container();
                }
                Event::End(_) => {
                    // An End we were not waiting for: the caller's container.
                    return out;
                }
                Event::TaskListMarker(_) => self.i += 1,
                _ => {
                    // Inline content straight inside a container: a tight list item.
                    let pieces = self.loose_inlines();
                    if !pieces.is_empty() {
                        out.extend(paragraph_nodes(pieces, ""));
                    }
                }
            }
        }
        out
    }

    fn skip_container(&mut self) {
        let mut depth = 0usize;
        while let Some((ev, _)) = self.peek() {
            self.i += 1;
            match ev {
                Event::Start(_) => depth += 1,
                Event::End(_) => {
                    depth -= 1;
                    if depth == 0 {
                        return;
                    }
                }
                _ if depth == 0 => return,
                _ => {}
            }
        }
    }

    fn list(&mut self, start: Option<u64>) -> Vec<Node> {
        // Items in source order: (task marker, content, had a paragraph).
        let mut items: Vec<(Option<bool>, Vec<Node>)> = Vec::new();
        let mut tight = true;
        while let Some((ev, _)) = self.peek() {
            match ev {
                Event::Start(Tag::Item) => {
                    self.i += 1;
                    // A loose item starts with a paragraph, and its marker sits inside it.
                    if matches!(self.peek(), Some((Event::Start(Tag::Paragraph), _))) {
                        tight = false;
                    }
                    let mut task = None;
                    let mut j = self.i;
                    while let Some((ev, _)) = self.ev.get(j) {
                        match ev {
                            Event::TaskListMarker(c) => {
                                task = Some(*c);
                                break;
                            }
                            Event::Start(Tag::Paragraph) => j += 1,
                            _ => break,
                        }
                    }
                    let content = self.blocks(Some(TagEnd::Item));
                    items.push((task, content));
                }
                Event::End(TagEnd::List(_)) => {
                    self.i += 1;
                    break;
                }
                _ => {
                    self.i += 1;
                }
            }
        }
        // TipTap splits a list where items change between task and plain.
        let mut out = Vec::new();
        let mut run_start = 0;
        while run_start < items.len() {
            let is_task = items[run_start].0.is_some();
            let mut run_end = run_start;
            while run_end < items.len() && items[run_end].0.is_some() == is_task {
                run_end += 1;
            }
            let run: Vec<_> = items[run_start..run_end].to_vec();
            if is_task {
                out.push(Node::TaskList {
                    items: run
                        .into_iter()
                        .map(|(c, content)| TaskItem { checked: c.unwrap_or(false), content })
                        .collect(),
                });
            } else {
                let items: Vec<Vec<Node>> = run.into_iter().map(|(_, c)| c).collect();
                match start {
                    Some(n) => out.push(Node::OrderedList { tight, start: n, items }),
                    None => out.push(Node::BulletList { tight, items }),
                }
            }
            run_start = run_end;
        }
        out
    }

    fn table(&mut self, aligns: &[pulldown_cmark::Alignment]) -> Node {
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        let mut header = false;
        let mut row: Vec<Cell> = Vec::new();
        while let Some((ev, _)) = self.peek() {
            self.i += 1;
            match ev {
                Event::Start(Tag::TableHead) => {
                    header = true;
                    row.clear();
                }
                Event::End(TagEnd::TableHead) => {
                    rows.push(std::mem::take(&mut row));
                    header = false;
                }
                Event::Start(Tag::TableRow) => row.clear(),
                Event::End(TagEnd::TableRow) => rows.push(std::mem::take(&mut row)),
                Event::Start(Tag::TableCell) => {
                    let col = row.len();
                    let pieces = self.inlines(TagEnd::TableCell);
                    if pieces.iter().any(|p| matches!(p, Piece::Image(_))) {
                        self.fail(Opaque::Unsupported);
                    }
                    let align = match aligns.get(col) {
                        Some(pulldown_cmark::Alignment::Left) => Some(Align::Left),
                        Some(pulldown_cmark::Alignment::Center) => Some(Align::Center),
                        Some(pulldown_cmark::Alignment::Right) => Some(Align::Right),
                        _ => None,
                    };
                    row.push(Cell { header, align, content: vec![Node::Paragraph(finish_inlines(pieces))] });
                }
                Event::End(TagEnd::Table) => break,
                _ => {}
            }
        }
        Node::Table { rows }
    }

    /// Inline events straight inside a tight list item, up to the next block.
    fn loose_inlines(&mut self) -> Vec<Piece> {
        let mut st = InlineState::default();
        while let Some((ev, range)) = self.peek() {
            if is_block_boundary(ev) {
                break;
            }
            self.i += 1;
            self.inline_event(ev, range, &mut st);
        }
        st.pieces
    }

    fn inlines(&mut self, end: TagEnd) -> Vec<Piece> {
        let mut st = InlineState::default();
        while let Some((ev, range)) = self.peek() {
            self.i += 1;
            if let Event::End(e) = ev {
                if *e == end {
                    break;
                }
            }
            self.inline_event(ev, range, &mut st);
        }
        st.pieces
    }

    fn inline_event(&mut self, ev: &Event<'s>, range: &Range<usize>, st: &mut InlineState) {
        let after = std::mem::replace(&mut st.after_element, false);
        match ev {
            Event::Text(t) => st.text(t, false),
            Event::Code(t) => {
                let mut m = st.marks.clone();
                m.code = true;
                st.pieces.push(Piece::Text(t.to_string(), m));
                st.after_element = true;
            }
            Event::InlineMath(_) | Event::DisplayMath(_) => {
                let source = &self.src[range.clone()];
                // Markie's rule decides (rich-math.ts), not pulldown's: `$x$5`
                // and `$$$x$$$` are text there.
                if math_span_end(self.src, range.start) == Some(range.end) {
                    st.pieces.push(Piece::Math(source.replace("\r\n", "\n")));
                    st.after_math = true;
                } else {
                    st.text(source, true);
                }
            }
            Event::SoftBreak => {
                if std::mem::replace(&mut st.after_math, false) {
                    st.text(" ", false);
                } else {
                    st.pieces.push(Piece::Soft { after_element: after, marks: st.marks.clone() });
                }
            }
            Event::HardBreak => {
                st.pieces.push(Piece::HardBreak);
                // markdown-it writes `<br>\n`; TipTap drops that "\n".
                st.after_element = true;
            }
            Event::FootnoteReference(label) => {
                st.text(&format!("[^{label}]"), true);
            }
            Event::Html(h) | Event::InlineHtml(h) => {
                inline_html(h, st);
                st.after_element = true;
            }
            Event::Start(Tag::Emphasis) => st.marks.italic = true,
            Event::Start(Tag::Strong) => st.marks.bold = true,
            Event::Start(Tag::Strikethrough) => st.marks.strike = true,
            Event::End(TagEnd::Emphasis) => {
                st.marks.italic = false;
                st.after_element = true;
            }
            Event::End(TagEnd::Strong) => {
                st.marks.bold = false;
                st.after_element = true;
            }
            Event::End(TagEnd::Strikethrough) => {
                st.marks.strike = false;
                st.after_element = true;
            }
            Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
                let style = match link_type {
                    LinkType::Autolink | LinkType::Email => LinkStyle::Autolink,
                    LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut => {
                        LinkStyle::Reference(id.to_string())
                    }
                    _ => LinkStyle::Inline,
                };
                let href = if *link_type == LinkType::Email {
                    format!("mailto:{dest_url}")
                } else {
                    normalize_href(dest_url)
                };
                let title = if title.is_empty() { None } else { Some(title.to_string()) };
                st.marks.link = Some(Link { href, title, style });
            }
            Event::End(TagEnd::Link) => {
                st.marks.link = None;
                st.after_element = true;
            }
            Event::Start(Tag::Image { dest_url, title, .. }) => {
                let mut alt = String::new();
                let mut depth = 0;
                while let Some((ev, _)) = self.peek() {
                    self.i += 1;
                    match ev {
                        Event::End(TagEnd::Image) if depth == 0 => break,
                        Event::Start(_) => depth += 1,
                        Event::End(_) => depth -= 1,
                        Event::Text(t) | Event::Code(t) => alt.push_str(t),
                        Event::SoftBreak | Event::HardBreak => alt.push(' '),
                        _ => {}
                    }
                }
                let title = if title.is_empty() { None } else { Some(title.to_string()) };
                st.pieces.push(Piece::Image(Node::Image {
                    src: normalize_href(dest_url),
                    alt: Some(alt),
                    title,
                }));
                st.after_element = true;
            }
            Event::TaskListMarker(_) => {}
            Event::Start(_) => self.fail(Opaque::Unsupported),
            _ => {}
        }
    }
}

fn is_block_boundary(ev: &Event) -> bool {
    match ev {
        Event::Start(t) => matches!(
            t,
            Tag::Paragraph
                | Tag::Heading { .. }
                | Tag::BlockQuote(_)
                | Tag::CodeBlock(_)
                | Tag::HtmlBlock
                | Tag::List(_)
                | Tag::Item
                | Tag::FootnoteDefinition(_)
                | Tag::Table(_)
        ),
        Event::End(t) => matches!(
            t,
            TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::BlockQuote(_)
                | TagEnd::CodeBlock
                | TagEnd::HtmlBlock
                | TagEnd::List(_)
                | TagEnd::Item
                | TagEnd::FootnoteDefinition
                | TagEnd::Table
        ),
        Event::Rule => true,
        _ => false,
    }
}

#[derive(Default)]
struct InlineState {
    pieces: Vec<Piece>,
    marks: Marks,
    after_element: bool,
    after_math: bool,
}

impl InlineState {
    fn text(&mut self, t: &str, _literal: bool) {
        self.after_math = false;
        self.pieces.push(Piece::Text(t.to_string(), self.marks.clone()));
    }
}

/// The inline tags ProseMirror maps to marks; others keep only their text.
fn inline_html(h: &str, st: &mut InlineState) {
    let t = h.trim();
    let lower = t.to_ascii_lowercase();
    let (closing, name) = match lower.strip_prefix("</") {
        Some(rest) => (true, rest),
        None => (false, lower.strip_prefix('<').unwrap_or("")),
    };
    let name: String = name.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    let on = !closing;
    match name.as_str() {
        "b" | "strong" => st.marks.bold = on,
        "i" | "em" => st.marks.italic = on,
        "s" | "del" | "strike" => st.marks.strike = on,
        "u" => st.marks.underline = on,
        "code" => st.marks.code = on,
        "br" => st.pieces.push(Piece::HardBreak),
        _ => {}
    }
}

/// markdown-it's normalizeLink: percent-encode what a URL may not hold.
pub fn normalize_href(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let keep = b.is_ascii_alphanumeric() || b";/?:@&=+$,-_.!~*'()#".contains(&b);
        if b == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            out.push('%');
        } else if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
        i += 1;
    }
    out
}

/// Resolve soft breaks and whitespace, link bare addresses, and drop images
/// (callers that split on images take them out first).
fn finish_inlines(pieces: Vec<Piece>) -> Vec<Inline> {
    let mut raw: Vec<Inline> = Vec::new();
    for p in pieces {
        match p {
            Piece::Text(t, m) => raw.push(Inline::Text { text: t, marks: m }),
            Piece::Math(s) => raw.push(Inline::Math { source: s }),
            Piece::HardBreak => raw.push(Inline::HardBreak),
            Piece::Soft { after_element, marks } => {
                if !after_element {
                    raw.push(Inline::Text { text: " ".into(), marks });
                }
            }
            Piece::Image(_) => {}
        }
    }
    let collapsed = collapse_whitespace(raw);
    let linked = linkify(collapsed);
    normalize_inlines(linked)
}

/// ProseMirror's DOM parser: whitespace runs fold to one space, none at the
/// start of the block, after a break, or at the end.
fn collapse_whitespace(inlines: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    // True when the last emitted character was whitespace or a block/line start.
    let mut prev_space = true;
    for inline in inlines {
        match inline {
            Inline::Text { text, marks } => {
                let mut s = String::with_capacity(text.len());
                for ch in text.chars() {
                    if matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{c}') {
                        if !prev_space {
                            s.push(' ');
                            prev_space = true;
                        }
                    } else {
                        s.push(ch);
                        prev_space = false;
                    }
                }
                out.push(Inline::Text { text: s, marks });
            }
            Inline::HardBreak => {
                strip_trailing_space(&mut out);
                out.push(Inline::HardBreak);
                prev_space = true;
            }
            other => {
                out.push(other);
                prev_space = false;
            }
        }
    }
    strip_trailing_space(&mut out);
    out
}

fn strip_trailing_space(out: &mut Vec<Inline>) {
    while let Some(Inline::Text { text, .. }) = out.last_mut() {
        if text.ends_with(' ') {
            text.pop();
        }
        if text.is_empty() {
            out.pop();
            continue;
        }
        break;
    }
}

/// Split a paragraph's pieces around pictures, and recognise the blocks
/// TipTap reads from a paragraph: display math on its own and a bare video
/// link (an embed card).
fn paragraph_nodes(pieces: Vec<Piece>, raw: &str) -> Vec<Node> {
    let has_image = pieces.iter().any(|p| matches!(p, Piece::Image(_)));
    if !has_image {
        let content = finish_inlines(pieces);
        return vec![special_paragraph(content, raw)];
    }
    let mut out = Vec::new();
    let mut seg: Vec<Piece> = Vec::new();
    for p in pieces {
        match p {
            Piece::Image(img) => {
                if !seg.is_empty() {
                    out.push(Node::Paragraph(finish_inlines(std::mem::take(&mut seg))));
                }
                out.push(img);
            }
            // The "\n" after a picture is dropped like after any element.
            Piece::Soft { after_element: true, .. } if seg.is_empty() => {}
            other => seg.push(other),
        }
    }
    if !seg.is_empty() {
        out.push(Node::Paragraph(finish_inlines(seg)));
    }
    out
}

fn special_paragraph(content: Vec<Inline>, raw: &str) -> Node {
    if let [Inline::Math { source }] = content.as_slice() {
        if source.starts_with("$$") && raw.trim_end() == source {
            return Node::MathBlock { source: source.clone() };
        }
    }
    if let [Inline::Text { text, marks }] = content.as_slice() {
        if let Some(link) = &marks.link {
            if !marks.bold && !marks.italic && !marks.code && !marks.strike && link.href == *text {
                if crate::embed::is_embed(text) {
                    return Node::Embed { url: text.clone() };
                }
            }
        }
    }
    Node::Paragraph(content)
}

/// markdown-it's linkify, the cases Markie documents hit: scheme URLs,
/// `www.` hosts, bare domains on common TLDs, and email addresses.
fn linkify(inlines: Vec<Inline>) -> Vec<Inline> {
    let mut out = Vec::new();
    for inline in inlines {
        match inline {
            Inline::Text { text, marks } if marks.link.is_none() && !marks.code => {
                let mut rest = text.as_str();
                while let Some((start, end, href)) = crate::linkify::find(rest) {
                    if start > 0 {
                        out.push(Inline::Text { text: rest[..start].to_string(), marks: marks.clone() });
                    }
                    let mut m = marks.clone();
                    m.link = Some(Link { href, title: None, style: LinkStyle::Autolink });
                    out.push(Inline::Text { text: rest[start..end].to_string(), marks: m });
                    rest = &rest[end..];
                }
                if !rest.is_empty() {
                    out.push(Inline::Text { text: rest.to_string(), marks });
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// `mathSpanEnd` from `src/lib/rich-math.ts`: the end (exclusive) of a math
/// span opening at byte `from`, or None.
pub fn math_span_end(src: &str, from: usize) -> Option<usize> {
    let b = src.as_bytes();
    let to = b.len();
    if b.get(from) != Some(&b'$') {
        return None;
    }
    if from > 0 && b[from - 1] == b'\\' {
        return None;
    }
    let is_space = |i: usize| i >= to || (b[i] as char).is_ascii_whitespace();
    if b.get(from + 1) == Some(&b'$') {
        if b.get(from + 2) == Some(&b'$') {
            return None;
        }
        let mut i = from + 2;
        while i + 1 < to {
            if b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == b'$' && b[i + 1] == b'$' {
                return if i > from + 2 && !src[from + 2..i].trim().is_empty() { Some(i + 2) } else { None };
            }
            i += 1;
        }
        return None;
    }
    if is_space(from + 1) {
        return None;
    }
    let mut i = from + 1;
    while i < to {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == b'$' {
            let next_digit = i + 1 < to && b[i + 1].is_ascii_digit();
            if !is_space(i - 1) && !next_digit && b.get(i + 1) != Some(&b'$') {
                return if i > from + 1 { Some(i + 1) } else { None };
            }
        }
        i += 1;
    }
    None
}
