//! Markdown to HTML, shaped the way remark-rehype (mdast-util-to-hast) writes
//! it, so the passes after it see the tree Electron's passes see.
//!
//! The parse is pulldown-cmark with GFM tables, task lists, strikethrough,
//! footnotes and math. GFM autolink literals come from [`crate::autolink`].
//! The output keeps raw HTML verbatim, exactly as `allowDangerousHtml` does:
//! the next step parses it into the tree and the sanitizer decides what stays.
//! Math leaves here as remark-math's placeholders, `<code class="language-math
//! math-inline">` and `<pre><code class="language-math math-display">`.

use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd};

use crate::autolink;
use crate::strict_math::{self, MARK, Span};
use crate::hast::{escape_attr, escape_text};

#[derive(Debug)]
enum Block {
    Para(String),
    /// A paragraph that is only `$$ … $$` on lines of its own: remark-math's flow math.
    Math(String),
    Heading(u8, String),
    Rule,
    Code { lang: Option<String>, text: String },
    Html(String),
    Quote(Vec<Block>),
    List { ordered: bool, start: u64, loose: bool, items: Vec<Item> },
    Table { aligns: Vec<Alignment>, head: Vec<String>, rows: Vec<Vec<String>> },
}

#[derive(Debug, Default)]
struct Item {
    task: Option<bool>,
    blocks: Vec<Block>,
}

/// Where inline content is being written.
#[derive(Default)]
struct Inline {
    html: String,
    /// The paragraph so far is only one display formula.
    only_display_math: Option<String>,
    has_other: bool,
}

enum Frame {
    Root(Vec<Block>),
    Quote(Vec<Block>),
    List { ordered: bool, start: u64, loose: bool, items: Vec<Item> },
    Item(Item),
    Footnote { label: String, blocks: Vec<Block> },
    Table { aligns: Vec<Alignment>, head: Vec<String>, rows: Vec<Vec<String>>, row: Vec<String>, in_head: bool },
}

struct Footnotes {
    /// Labels in the order they were first referenced.
    order: Vec<String>,
    /// How many times each label (by order index) was referenced.
    counts: Vec<usize>,
    definitions: Vec<(String, Vec<Block>)>,
}

pub(crate) fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// The source pulldown reads, and the math found in it ([`strict_math`]).
/// A document that already holds the placeholder character falls back to
/// pulldown's own math.
pub(crate) fn prepare(markdown: &str) -> (String, Vec<Span>, Options) {
    match strict_math::extract(markdown, options()) {
        Some((source, spans)) => (source, spans, options()),
        None if markdown.contains(strict_math::MARK) => (markdown.to_string(), Vec::new(), options() | Options::ENABLE_MATH),
        None => (markdown.to_string(), Vec::new(), options()),
    }
}

/// Markdown to the HTML string remark-rehype would hand to rehype-raw.
pub fn markdown_to_html(markdown: &str) -> String {
    let (source, math, opts) = prepare(markdown);
    let markdown = source.as_str();
    let mut builder = Builder {
        math,
        stack: vec![Frame::Root(Vec::new())],
        inline: None,
        inline_stack: Vec::new(),
        code: None,
        html_block: None,
        image_alt: Vec::new(),
        notes: Footnotes { order: Vec::new(), counts: Vec::new(), definitions: Vec::new() },
        pending_text: String::new(),
        link_depth: 0,
        heading: None,
        source: markdown,
    };
    let events: Vec<(Event, std::ops::Range<usize>)> = Parser::new_ext(markdown, opts).into_offset_iter().collect();
    for (event, range) in events {
        builder.event(event, range);
    }
    builder.flush_text();
    let blocks = match builder.stack.pop() {
        Some(Frame::Root(blocks)) => blocks,
        _ => Vec::new(),
    };
    let mut out = render_blocks(&blocks, false);
    let notes = render_footnotes(&builder.notes);
    if !notes.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&notes);
    }
    out
}

struct Builder<'a> {
    math: Vec<Span>,
    stack: Vec<Frame>,
    inline: Option<Inline>,
    /// Open inline tags, so a block boundary can close the paragraph cleanly.
    inline_stack: Vec<&'static str>,
    code: Option<(Option<String>, String)>,
    html_block: Option<String>,
    /// Collecting an image's alt text (nested images collect into the outer one).
    image_alt: Vec<(String, String, String)>,
    notes: Footnotes,
    /// Text not yet written, merged so autolinks can span pulldown's splits.
    pending_text: String,
    link_depth: usize,
    heading: Option<u8>,
    source: &'a str,
}

impl Builder<'_> {
    fn push_block(&mut self, block: Block) {
        match self.stack.last_mut() {
            Some(Frame::Root(b)) | Some(Frame::Quote(b)) | Some(Frame::Footnote { blocks: b, .. }) => b.push(block),
            Some(Frame::Item(item)) => item.blocks.push(block),
            _ => {}
        }
    }

    fn in_item_without_paragraph(&self) -> bool {
        matches!(self.stack.last(), Some(Frame::Item(_)))
    }

    fn inline(&mut self) -> &mut Inline {
        if self.inline.is_none() {
            self.inline = Some(Inline::default());
        }
        self.inline.as_mut().unwrap()
    }

    fn write(&mut self, html: &str) {
        self.flush_text();
        self.raw_write(html);
    }

    fn raw_write(&mut self, html: &str) {
        if let Some((_, alt, _)) = self.image_alt.last_mut() {
            let _ = alt;
            return;
        }
        let inline = self.inline();
        inline.has_other = true;
        inline.html.push_str(html);
    }

    fn flush_text(&mut self) {
        if self.pending_text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.pending_text);
        // Math placeholders split the run; everything between is text.
        let mut pieces: Vec<(bool, String)> = Vec::new();
        let mut rest = text.as_str();
        while let Some(a) = rest.find(MARK) {
            let after = &rest[a + MARK.len_utf8()..];
            let Some(b) = after.find(MARK) else { break };
            pieces.push((false, rest[..a].to_string()));
            pieces.push((true, after[..b].to_string()));
            rest = &after[b + MARK.len_utf8()..];
        }
        pieces.push((false, rest.to_string()));
        for (is_math, piece) in pieces {
            if is_math {
                let span = piece.parse::<usize>().ok().and_then(|i| self.math.get(i)).cloned();
                let Some(span) = span else { continue };
                self.math_piece(span);
            } else if !piece.is_empty() {
                self.text_piece(piece);
            }
        }
    }

    fn math_piece(&mut self, span: Span) {
        if let Some((_, alt, _)) = self.image_alt.last_mut() {
            alt.push_str(&span.tex);
            return;
        }
        let html = format!("<code class=\"language-math math-inline\">{}</code>", escape_text(&span.tex));
        let inline = self.inline();
        if span.flow && !inline.has_other && inline.only_display_math.is_none() {
            inline.only_display_math = Some(span.tex.clone());
        } else {
            inline.has_other = true;
        }
        inline.html.push_str(&html);
    }

    fn text_piece(&mut self, text: String) {
        if let Some((_, alt, _)) = self.image_alt.last_mut() {
            alt.push_str(&text);
            return;
        }
        let mut html = String::new();
        if self.link_depth == 0 && self.code.is_none() {
            let prev = self.inline.as_ref().and_then(|i| last_text_char(&i.html));
            let mut at = 0;
            for found in autolink::find_all(&text, prev) {
                html.push_str(&escape_text(&text[at..found.start]));
                html.push_str(&format!(
                    "<a href=\"{}\">{}</a>",
                    escape_attr(&normalize_uri(&found.href)),
                    escape_text(&text[found.start..found.end])
                ));
                at = found.end;
            }
            html.push_str(&escape_text(&text[at..]));
        } else {
            html.push_str(&escape_text(&text));
        }
        let inline = self.inline();
        if !text.trim().is_empty() {
            inline.has_other = true;
        }
        inline.html.push_str(&html);
    }

    /// Ends the open paragraph (or implicit tight-item paragraph).
    fn close_inline(&mut self) {
        self.flush_text();
        if let Some(inline) = self.inline.take() {
            if let Some(level) = self.heading.take() {
                self.push_block(Block::Heading(level, inline.html));
                return;
            }
            if let (Some(tex), false) = (inline.only_display_math.clone(), inline.has_other) {
                self.push_block(Block::Math(tex));
            } else if !inline.html.is_empty() || self.in_item_without_paragraph() {
                self.push_block(Block::Para(inline.html));
            }
        }
    }

    fn event(&mut self, event: Event, range: std::ops::Range<usize>) {
        if let Some((_, text)) = &mut self.code {
            match event {
                Event::Text(t) => {
                    text.push_str(&t);
                    return;
                }
                Event::End(TagEnd::CodeBlock) => {}
                _ => return,
            }
        }
        if let Some(html) = &mut self.html_block {
            match event {
                Event::Html(t) | Event::Text(t) => {
                    html.push_str(&t);
                    return;
                }
                Event::End(TagEnd::HtmlBlock) => {}
                _ => return,
            }
        }
        match event {
            Event::Start(tag) => self.start(tag, range),
            Event::End(end) => self.end(end),
            Event::Text(t) => {
                self.mark_content();
                self.pending_text.push_str(&t);
            }
            Event::Code(c) => {
                self.mark_content();
                if let Some((_, alt, _)) = self.image_alt.last_mut() {
                    alt.push_str(&c);
                } else {
                    self.write(&format!("<code>{}</code>", escape_text(&c)));
                }
            }
            Event::InlineMath(m) => {
                self.mark_content();
                self.write(&format!("<code class=\"language-math math-inline\">{}</code>", escape_text(&m)));
            }
            Event::DisplayMath(m) => {
                // `$$x$$` inside a sentence is inline math to remark-math; only
                // a paragraph that is nothing else, on its own lines, is flow math.
                let own_lines = self.source[range.clone()].contains('\n') || self.source[..range.start].ends_with('\n') || range.start == 0;
                let empty_so_far = self.inline.as_ref().is_none_or(|i| !i.has_other && i.only_display_math.is_none()) && self.pending_text.trim().is_empty();
                self.flush_text();
                if own_lines && empty_so_far && self.image_alt.is_empty() && self.link_depth == 0 {
                    let tex = m.trim_matches('\n').to_string();
                    let inline = self.inline();
                    inline.only_display_math = Some(tex);
                    inline.html.push_str(&format!("<code class=\"language-math math-inline\">{}</code>", escape_text(&m)));
                } else {
                    self.write(&format!("<code class=\"language-math math-inline\">{}</code>", escape_text(&m)));
                }
            }
            Event::Html(h) | Event::InlineHtml(h) => {
                self.mark_content();
                self.write(&h);
            }
            Event::SoftBreak => {
                self.pending_text.push('\n');
            }
            Event::HardBreak => self.write("<br>\n"),
            Event::Rule => {
                self.close_inline();
                self.push_block(Block::Rule);
            }
            Event::TaskListMarker(checked) => {
                if let Some(Frame::Item(item)) = self.stack.last_mut() {
                    item.task = Some(checked);
                }
            }
            Event::FootnoteReference(label) => {
                self.mark_content();
                let key = label.to_lowercase();
                let index = match self.notes.order.iter().position(|l| *l == key) {
                    Some(i) => {
                        self.notes.counts[i] += 1;
                        i
                    }
                    None => {
                        self.notes.order.push(key.clone());
                        self.notes.counts.push(1);
                        self.notes.order.len() - 1
                    }
                };
                let id = normalize_uri(&key);
                let count = self.notes.counts[index];
                let suffix = if count > 1 { format!("-{count}") } else { String::new() };
                self.write(&format!(
                    "<sup><a href=\"#user-content-fn-{id}\" id=\"user-content-fnref-{id}{suffix}\" data-footnote-ref=\"\" aria-describedby=\"footnote-label\">{}</a></sup>",
                    index + 1
                ));
            }
        }
    }

    /// Any non-math content means the paragraph is not flow math.
    fn mark_content(&mut self) {}

    fn start(&mut self, tag: Tag, _range: std::ops::Range<usize>) {
        match tag {
            Tag::Paragraph => {
                self.close_inline();
                self.inline = Some(Inline::default());
            }
            Tag::Heading { level, .. } => {
                self.close_inline();
                self.heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                });
                self.inline = Some(Inline::default());
            }
            Tag::BlockQuote(_) => {
                self.close_inline();
                self.stack.push(Frame::Quote(Vec::new()));
            }
            Tag::CodeBlock(kind) => {
                self.close_inline();
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().map(|s| s.to_string()),
                    CodeBlockKind::Indented => None,
                };
                self.code = Some((lang, String::new()));
            }
            Tag::HtmlBlock => {
                self.close_inline();
                self.html_block = Some(String::new());
            }
            Tag::List(start) => {
                self.close_inline();
                self.stack.push(Frame::List { ordered: start.is_some(), start: start.unwrap_or(1), loose: false, items: Vec::new() });
            }
            Tag::Item => {
                self.close_inline();
                self.stack.push(Frame::Item(Item::default()));
            }
            Tag::FootnoteDefinition(label) => {
                self.close_inline();
                self.stack.push(Frame::Footnote { label: label.to_lowercase(), blocks: Vec::new() });
            }
            Tag::Table(aligns) => {
                self.close_inline();
                self.stack.push(Frame::Table { aligns, head: Vec::new(), rows: Vec::new(), row: Vec::new(), in_head: false });
            }
            Tag::TableHead => {
                if let Some(Frame::Table { in_head, .. }) = self.stack.last_mut() {
                    *in_head = true;
                }
            }
            Tag::TableRow => {}
            Tag::TableCell => {
                self.inline = Some(Inline::default());
            }
            Tag::Emphasis => self.open_inline("em", "<em>"),
            Tag::Strong => self.open_inline("strong", "<strong>"),
            Tag::Strikethrough => self.open_inline("del", "<del>"),
            Tag::Link { link_type, dest_url, title, .. } => {
                self.mark_content();
                let href = if link_type == LinkType::Email { format!("mailto:{dest_url}") } else { dest_url.to_string() };
                let title = if title.is_empty() { String::new() } else { format!(" title=\"{}\"", escape_attr(&title)) };
                self.write(&format!("<a href=\"{}\"{title}>", escape_attr(&normalize_uri(&href))));
                self.inline_stack.push("a");
                self.link_depth += 1;
            }
            Tag::Image { dest_url, title, .. } => {
                self.mark_content();
                self.flush_text();
                self.image_alt.push((dest_url.to_string(), String::new(), title.to_string()));
            }
            _ => {}
        }
    }

    fn open_inline(&mut self, name: &'static str, html: &str) {
        self.mark_content();
        self.write(html);
        self.inline_stack.push(name);
    }

    fn close_tag(&mut self, name: &'static str) {
        if let Some(at) = self.inline_stack.iter().rposition(|n| *n == name) {
            self.inline_stack.remove(at);
        }
        self.write(&format!("</{name}>"));
    }

    fn end(&mut self, end: TagEnd) {
        match end {
            TagEnd::Paragraph | TagEnd::Heading(_) => self.close_inline(),
            TagEnd::BlockQuote(_) => {
                self.close_inline();
                if let Some(Frame::Quote(blocks)) = self.stack.pop() {
                    self.push_block(Block::Quote(blocks));
                }
            }
            TagEnd::CodeBlock => {
                if let Some((lang, text)) = self.code.take() {
                    self.push_block(Block::Code { lang, text });
                }
            }
            TagEnd::HtmlBlock => {
                if let Some(html) = self.html_block.take() {
                    self.push_block(Block::Html(html.trim_end_matches('\n').to_string()));
                }
            }
            TagEnd::List(_) => {
                self.close_inline();
                if let Some(Frame::List { ordered, start, loose, items }) = self.stack.pop() {
                    self.push_block(Block::List { ordered, start, loose, items });
                }
            }
            TagEnd::Item => {
                self.close_inline();
                if let Some(Frame::Item(item)) = self.stack.pop() {
                    // pulldown wraps loose items' text in paragraphs and leaves tight
                    // items bare; an explicit paragraph event marks the list loose.
                    if let Some(Frame::List { items, .. }) = self.stack.last_mut() {
                        items.push(item);
                    }
                }
            }
            TagEnd::FootnoteDefinition => {
                self.close_inline();
                if let Some(Frame::Footnote { label, blocks }) = self.stack.pop() {
                    self.notes.definitions.push((label, blocks));
                }
            }
            TagEnd::TableCell => {
                self.flush_text();
                let html = self.inline.take().map(|i| i.html).unwrap_or_default();
                if let Some(Frame::Table { row, .. }) = self.stack.last_mut() {
                    row.push(html);
                }
            }
            TagEnd::TableHead => {
                if let Some(Frame::Table { head, row, in_head, .. }) = self.stack.last_mut() {
                    *head = std::mem::take(row);
                    *in_head = false;
                }
            }
            TagEnd::TableRow => {
                if let Some(Frame::Table { rows, row, .. }) = self.stack.last_mut() {
                    rows.push(std::mem::take(row));
                }
            }
            TagEnd::Table => {
                if let Some(Frame::Table { aligns, head, rows, .. }) = self.stack.pop() {
                    self.push_block(Block::Table { aligns, head, rows });
                }
            }
            TagEnd::Emphasis => self.close_tag("em"),
            TagEnd::Strong => self.close_tag("strong"),
            TagEnd::Strikethrough => self.close_tag("del"),
            TagEnd::Link => {
                // The link's own text is flushed while still inside it, so it is
                // never autolinked a second time.
                self.flush_text();
                self.link_depth = self.link_depth.saturating_sub(1);
                self.close_tag("a");
            }
            TagEnd::Image => {
                self.flush_text();
                if let Some((src, alt, title)) = self.image_alt.pop() {
                    let title = if title.is_empty() { String::new() } else { format!(" title=\"{}\"", escape_attr(&title)) };
                    let html = format!("<img src=\"{}\" alt=\"{}\"{title}>", escape_attr(&normalize_uri(&src)), escape_attr(&alt));
                    if let Some((_, outer, _)) = self.image_alt.last_mut() {
                        outer.push_str(&alt);
                    } else {
                        self.raw_write(&html);
                    }
                }
            }
            _ => {}
        }
        // A list is loose when any item held a real paragraph event.
        if matches!(end, TagEnd::Paragraph)
            && let Some(Frame::Item(_)) = self.stack.last()
        {
            let len = self.stack.len();
            if len >= 2
                && let Frame::List { loose, .. } = &mut self.stack[len - 2]
            {
                *loose = true;
            }
        }
    }
}

fn last_text_char(html: &str) -> Option<char> {
    // Good enough for a boundary check: the character before the next run.
    if html.ends_with('>') {
        return None;
    }
    html.chars().next_back()
}

fn render_blocks(blocks: &[Block], _tight: bool) -> String {
    blocks.iter().map(render_block).collect::<Vec<_>>().join("\n")
}

fn wrap(inner: &[String]) -> String {
    if inner.is_empty() {
        return "\n".to_string();
    }
    format!("\n{}\n", inner.join("\n"))
}

fn render_block(block: &Block) -> String {
    match block {
        Block::Para(html) => format!("<p>{html}</p>"),
        Block::Math(tex) => format!("<pre><code class=\"language-math math-display\">{}</code></pre>", escape_text(tex)),
        Block::Heading(level, html) => format!("<h{level}>{html}</h{level}>"),
        Block::Rule => "<hr>".to_string(),
        Block::Code { lang, text } => {
            let class = lang.as_ref().map(|l| format!(" class=\"language-{}\"", escape_attr(l))).unwrap_or_default();
            format!("<pre><code{class}>{}</code></pre>", escape_text(text))
        }
        Block::Html(html) => html.clone(),
        Block::Quote(blocks) => {
            let inner: Vec<String> = blocks.iter().map(render_block).collect();
            format!("<blockquote>{}</blockquote>", wrap(&inner))
        }
        Block::List { ordered, start, loose, items } => {
            let task = items.iter().any(|i| i.task.is_some());
            let class = if task { " class=\"contains-task-list\"" } else { "" };
            let tag = if *ordered { "ol" } else { "ul" };
            let start_attr = if *ordered && *start != 1 { format!(" start=\"{start}\"") } else { String::new() };
            let inner: Vec<String> = items.iter().map(|item| render_item(item, *loose)).collect();
            format!("<{tag}{start_attr}{class}>{}</{tag}>", wrap(&inner))
        }
        Block::Table { aligns, head, rows } => {
            let cell = |tag: &str, i: usize, html: &str| {
                let align = match aligns.get(i) {
                    Some(Alignment::Left) => " align=\"left\"",
                    Some(Alignment::Right) => " align=\"right\"",
                    Some(Alignment::Center) => " align=\"center\"",
                    _ => "",
                };
                format!("<{tag}{align}>{html}</{tag}>")
            };
            // to-hast puts newlines between table parts, and rehype-raw then
            // foster-parents every one of them out in front of the table. The
            // result is a table with no whitespace inside, which is written
            // directly here.
            let row = |tag: &str, cells: &[String]| {
                let inner: String = cells.iter().enumerate().map(|(i, c)| cell(tag, i, c)).collect();
                format!("<tr>{inner}</tr>")
            };
            let mut parts = format!("<thead>{}</thead>", row("th", head));
            if !rows.is_empty() {
                let body: String = rows.iter().map(|r| row("td", r)).collect();
                parts.push_str(&format!("<tbody>{body}</tbody>"));
            }
            format!("<table>{parts}</table>")
        }
    }
}

const CHECKBOX_OFF: &str = "<input type=\"checkbox\" disabled>";
const CHECKBOX_ON: &str = "<input type=\"checkbox\" checked disabled>";

fn render_item(item: &Item, loose: bool) -> String {
    let class = if item.task.is_some() { " class=\"task-list-item\"" } else { "" };
    let mut blocks: Vec<String> = Vec::new();
    let box_html = item.task.map(|c| if c { CHECKBOX_ON } else { CHECKBOX_OFF });
    let mut out = String::new();
    for (i, block) in item.blocks.iter().enumerate() {
        let mut html = match (block, loose) {
            (Block::Para(inner), false) => inner.clone(),
            _ => render_block(block),
        };
        if i == 0
            && let Some(b) = box_html
        {
            html = match (block, loose) {
                (Block::Para(inner), true) => format!("<p>{b} {inner}</p>"),
                (Block::Para(inner), false) => format!("{b} {inner}"),
                _ => format!("{b}{html}"),
            };
        }
        blocks.push(html);
        let _ = i;
    }
    if item.blocks.is_empty()
        && let Some(b) = box_html
    {
        blocks.push(b.to_string());
    }
    // mdast-util-to-hast: a newline before every child except a leading tight
    // paragraph, and after the last unless it is a tight paragraph.
    for (i, block) in item.blocks.iter().enumerate() {
        let unwrapped = matches!(block, Block::Para(_)) && !loose;
        if loose || i != 0 || !unwrapped {
            out.push('\n');
        }
        out.push_str(&blocks[i]);
    }
    if item.blocks.is_empty() {
        out.push_str(blocks.first().map(String::as_str).unwrap_or(""));
    }
    if let Some(last) = item.blocks.last()
        && (loose || !matches!(last, Block::Para(_)))
    {
        out.push('\n');
    }
    format!("<li{class}>{out}</li>")
}

fn render_footnotes(notes: &Footnotes) -> String {
    if notes.order.is_empty() {
        return String::new();
    }
    let mut items = Vec::new();
    for (index, label) in notes.order.iter().enumerate() {
        let Some((_, blocks)) = notes.definitions.iter().find(|(l, _)| l == label) else { continue };
        let id = normalize_uri(label);
        let count = notes.counts[index];
        let mut backrefs = String::new();
        for n in 1..=count {
            let suffix = if n > 1 { format!("-{n}") } else { String::new() };
            let sup = if n > 1 { format!("<sup>{n}</sup>") } else { String::new() };
            if n > 1 {
                backrefs.push(' ');
            }
            backrefs.push_str(&format!(
                "<a href=\"#user-content-fnref-{id}{suffix}\" data-footnote-backref=\"\" aria-label=\"Back to reference {}{suffix}\" class=\"data-footnote-backref\">↩{sup}</a>",
                index + 1
            ));
        }
        let mut rendered: Vec<String> = blocks.iter().map(render_block).collect();
        match blocks.last() {
            Some(Block::Para(inner)) => {
                let last = rendered.len() - 1;
                rendered[last] = format!("<p>{inner} {backrefs}</p>");
            }
            _ => rendered.push(backrefs),
        }
        items.push(format!("<li id=\"user-content-fn-{id}\">{}</li>", wrap(&rendered)));
    }
    if items.is_empty() {
        return String::new();
    }
    format!(
        "<section data-footnotes class=\"footnotes\"><h2 class=\"sr-only\" id=\"footnote-label\">Footnotes</h2>\n<ol>{}</ol>\n</section>",
        wrap(&items)
    )
}

/// micromark's `normalizeUri`: percent-encode what a URL may not hold raw,
/// keeping existing `%XX` escapes.
pub fn normalize_uri(value: &str) -> String {
    let mut out = String::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < value.len() {
        let c = value[i..].chars().next().unwrap();
        let len = c.len_utf8();
        if c == '%' && i + 2 < value.len() + 0 && bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit) && bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit) {
            out.push_str(&value[i..i + 3]);
            i += 3;
            continue;
        }
        let keep = c.is_ascii_alphanumeric() || matches!(c, '!' | '#' | '$' | '&'..=';' | '=' | '?' | '@' | '_' | '~');
        if keep {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        i += len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_normalizing_matches_micromark() {
        assert_eq!(normalize_uri("https://a.b/?a=1&b=\"2\""), "https://a.b/?a=1&b=%222%22");
        assert_eq!(normalize_uri("a b%20c%zz"), "a%20b%20c%25zz");
        assert_eq!(normalize_uri("é"), "%C3%A9");
    }

    #[test]
    fn tight_and_loose_lists() {
        assert_eq!(markdown_to_html("- a\n- b\n"), "<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
        assert_eq!(markdown_to_html("- a\n\n- b\n"), "<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>");
    }
}
