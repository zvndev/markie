//! Model nodes back to Markdown, for blocks the user changed.
//!
//! Untouched blocks never come through here: the document writes their
//! source bytes. The output follows tiptap-markdown's style (`**`, `*`, `-`,
//! fenced code, aligned tables) so a block edited in Markie RS reads the
//! same as one edited in the web app. Every block is checked by parsing it
//! back; when escaping was not enough the block is written again with every
//! punctuation character escaped, which is ugly but cannot change meaning.

use crate::model::*;
use crate::parse::parse_nodes;

/// Serialize nodes as one Markdown text, blocks separated by a blank line.
pub fn nodes_to_markdown(nodes: &[Node]) -> String {
    nodes_to_markdown_with(nodes, "")
}

/// As `nodes_to_markdown`, checked in the context of `definitions`: the
/// document's link reference definitions, which give `[text][label]` its
/// meaning.
pub fn nodes_to_markdown_with(nodes: &[Node], definitions: &str) -> String {
    let want = canonical(nodes);
    let reads_back = |s: &str| {
        if definitions.is_empty() {
            parse_nodes(s) == want
        } else {
            parse_nodes(&format!("{s}\n\n{definitions}")) == want
        }
    };
    let e = |all, dollar, bare_links, html_marks, inline_refs| Escape { all, dollar, bare_links, html_marks, inline_refs };
    let tiers = [
        e(false, false, true, false, false),
        e(false, true, true, false, false),
        e(false, true, false, false, false),
        e(true, true, false, false, false),
        // `**a:**b` cannot close in Markdown (punctuation then a letter);
        // `<strong>` can, and both read back as the same mark.
        e(false, true, true, true, false),
        e(true, true, false, true, false),
        // A reference whose definition was deleted: write the link inline.
        e(false, false, true, false, true),
        e(false, true, false, true, true),
        e(true, true, false, true, true),
    ];
    let first = write_nodes(nodes, tiers[0]);
    if reads_back(&first) {
        return first;
    }
    for t in &tiers[1..] {
        let s = write_nodes(nodes, *t);
        if reads_back(&s) {
            return s;
        }
    }
    first
}

/// Is `nodes_to_markdown_with(nodes, definitions)` read back as `nodes`
/// (in canonical form)?
pub fn is_stable(nodes: &[Node], definitions: &str) -> bool {
    let s = nodes_to_markdown_with(nodes, definitions);
    let text = if definitions.is_empty() { s } else { format!("{s}\n\n{definitions}") };
    parse_nodes(&text) == canonical(nodes)
}

/// The nodes as Markdown can say them: a space at the edge of a mark takes
/// only the marks its neighbour shares (`**a **b` cannot close). This is
/// prosemirror-markdown's whitespace expulsion, so TipTap reads an edited
/// block back the same way.
pub fn canonical(nodes: &[Node]) -> Vec<Node> {
    nodes.iter().map(canonical_node).collect()
}

fn canonical_node(n: &Node) -> Node {
    match n {
        Node::Paragraph { content, align } if is_aligned(align, content) => {
            Node::Paragraph { content: crate::html::inline_html_content(&crate::html::inline_to_html(content)), align: align.clone() }
        }
        Node::Heading { level, content, align } if is_aligned(align, content) => Node::Heading {
            level: *level,
            content: crate::html::inline_html_content(&crate::html::inline_to_html(content)),
            align: align.clone(),
        },
        // An alignment HTML would not carry reads back as none.
        Node::Paragraph { content, .. } => Node::para(expel_whitespace(&collapse(content))),
        Node::Heading { level, content, .. } => Node::heading(*level, expel_whitespace(&heading_content(content))),
        Node::Blockquote(c) => Node::Blockquote(canonical(c)),
        Node::BulletList { tight, items } => Node::BulletList {
            tight: effective_tight(*tight, items.iter()),
            items: items.iter().map(|i| canonical(i)).collect(),
        },
        Node::OrderedList { tight, start, items } => Node::OrderedList {
            tight: effective_tight(*tight, items.iter()),
            start: *start,
            items: items.iter().map(|i| canonical(i)).collect(),
        },
        Node::TaskList { items } => Node::TaskList {
            items: items.iter().map(|i| TaskItem { checked: i.checked, content: canonical(&i.content) }).collect(),
        },
        Node::Table { rows } => Node::Table {
            rows: rows
                .iter()
                .map(|r| {
                    r.iter().map(|c| Cell { header: c.header, align: c.align, content: canonical(&c.content) }).collect()
                })
                .collect(),
        },
        other => other.clone(),
    }
}

#[derive(Clone, Copy, PartialEq)]
struct Escape {
    /// Escape every ASCII punctuation character.
    all: bool,
    /// Escape `$`, which could otherwise open math.
    dollar: bool,
    /// Write a link whose text is its address as that bare text (linkify).
    bare_links: bool,
    /// Write emphasis as inline HTML tags.
    html_marks: bool,
    /// Write reference links inline (their definition may be gone).
    inline_refs: bool,
}

fn write_nodes(nodes: &[Node], esc: Escape) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut alt = false;
    for (i, n) in nodes.iter().enumerate() {
        // Two lists of the same kind in a row would read back as one list,
        // unless the second uses the other bullet (`*`, or `)` after a number).
        alt = i > 0 && same_list_kind(&nodes[i - 1], n) && !alt;
        parts.push(block(n, esc, alt));
    }
    parts.join("\n\n")
}

fn same_list_kind(a: &Node, b: &Node) -> bool {
    matches!(
        (a, b),
        (Node::BulletList { .. }, Node::BulletList { .. })
            | (Node::OrderedList { .. }, Node::OrderedList { .. })
            | (Node::TaskList { .. }, Node::TaskList { .. })
    )
}

fn block(n: &Node, esc: Escape, alt: bool) -> String {
    let bullet = if alt { "* " } else { "- " };
    let delim = if alt { ')' } else { '.' };
    match n {
        Node::Paragraph { content, align } if is_aligned(align, content) => {
            crate::html::aligned_html("p", align.as_deref().unwrap_or(""), content)
        }
        Node::Heading { level, content, align } if is_aligned(align, content) => {
            crate::html::aligned_html(&format!("h{level}"), align.as_deref().unwrap_or(""), content)
        }
        Node::Paragraph { content, .. } => inline_md(&collapse(content), esc, false),
        Node::Heading { level, content, .. } => {
            format!("{} {}", "#".repeat(*level as usize), inline_md_after(&heading_content(content), esc, false, true))
        }
        Node::Blockquote(children) => prefix_lines(&write_nodes(children, esc), "> ", ">"),
        Node::BulletList { tight, items } => list(items.iter().map(|c| (bullet.to_string(), c)), *tight, esc),
        Node::OrderedList { tight, start, items } => list(
            items.iter().enumerate().map(|(k, c)| (format!("{}{delim} ", start + k as u64), c)),
            *tight,
            esc,
        ),
        Node::TaskList { items } => {
            let tight = items.iter().all(|i| i.content.len() <= 1);
            list(
                items.iter().map(|i| (format!("{}[{}] ", bullet, if i.checked { 'x' } else { ' ' }), &i.content)),
                tight,
                esc,
            )
        }
        Node::CodeBlock { language, code } => {
            let longest = longest_run(code, '`');
            let fence = "`".repeat(3.max(longest + 1));
            format!("{fence}{}\n{code}\n{fence}", language.as_deref().unwrap_or(""))
        }
        Node::HorizontalRule => "---".into(),
        Node::Table { rows } => table(rows, esc),
        Node::Image { src, alt, title, width } => {
            crate::html::sized_media_html(src, alt.as_deref(), title.as_deref(), *width)
                .unwrap_or_else(|| image(src, alt.as_deref().unwrap_or(""), title.as_deref()))
        }
        Node::MathBlock { source } => source.clone(),
        Node::Embed { url } => url.clone(),
    }
}

/// Whitespace as Markdown can hold it: one space per run, none at the edges
/// (what the parser reads anyway, so the editor may hold anything).
fn collapse(content: &[Inline]) -> Vec<Inline> {
    let edge_break = matches!(content.first(), Some(Inline::HardBreak)) || matches!(content.last(), Some(Inline::HardBreak));
    let needs = edge_break
        || content.iter().any(|i| matches!(i, Inline::Text { text, .. } if text.contains("  ") || text.starts_with(' ') || text.ends_with(' ') || text.contains(['\t', '\n'])));
    if !needs {
        return content.to_vec();
    }
    // A line break at either end of a paragraph has nothing to break.
    let mut v = content.to_vec();
    while matches!(v.first(), Some(Inline::HardBreak)) {
        v.remove(0);
    }
    while matches!(v.last(), Some(Inline::HardBreak)) {
        v.pop();
    }
    // Code keeps its spaces in the source, but reads back collapsed too.
    normalize_inlines(crate::parse::collapse_whitespace(v))
}

/// A heading is one line: a line break in it is a space.
fn heading_content(content: &[Inline]) -> Vec<Inline> {
    if !content.iter().any(|i| matches!(i, Inline::HardBreak)) {
        return collapse(content);
    }
    let spaced: Vec<Inline> = content
        .iter()
        .map(|i| match i {
            Inline::HardBreak => Inline::text(" "),
            other => other.clone(),
        })
        .collect();
    collapse(&normalize_inlines(spaced))
}

/// `isAligned` in rich-aligned-blocks.ts: left is no alignment, and an
/// empty block has nothing to align.
pub fn is_aligned(align: &Option<String>, content: &[Inline]) -> bool {
    align.as_deref().is_some_and(|a| !a.is_empty() && a != "left") && !content.is_empty()
}

/// A tight list writes an item's blocks on consecutive lines, so a
/// paragraph followed by anything that cannot interrupt it (another
/// paragraph, `$$`, `---`, a table) needs a loose list.
pub fn effective_tight<'a>(tight: bool, mut items: impl Iterator<Item = &'a Vec<Node>>) -> bool {
    tight
        && items.all(|c| {
            !c.windows(2).any(|w| {
                matches!(w[0], Node::Paragraph { .. })
                    && !matches!(
                        w[1],
                        Node::BulletList { .. } | Node::OrderedList { .. } | Node::TaskList { .. } | Node::CodeBlock { .. } | Node::Blockquote(_) | Node::Heading { .. }
                    )
            })
        })
}

fn list<'a>(items: impl Iterator<Item = (String, &'a Vec<Node>)>, tight: bool, esc: Escape) -> String {
    let items: Vec<(String, &'a Vec<Node>)> = items.collect();
    let tight = effective_tight(tight, items.iter().map(|(_, c)| *c));
    let mut out: Vec<String> = Vec::new();
    for (marker, content) in items {
        // A tight item's blocks sit on consecutive lines, as tiptap-markdown writes them.
        let body = if content.is_empty() {
            String::new()
        } else if tight {
            content.iter().map(|n| block(n, esc, false)).collect::<Vec<_>>().join("\n")
        } else {
            write_nodes(content, esc)
        };
        let indent = if marker.ends_with("] ") { "  ".to_string() } else { " ".repeat(marker.len()) };
        let mut s = String::new();
        for (k, line) in body.split('\n').enumerate() {
            if k == 0 {
                s.push_str(marker.trim_end());
                if !line.is_empty() {
                    s.push(' ');
                    s.push_str(line);
                }
            } else {
                s.push('\n');
                if !line.is_empty() {
                    s.push_str(&indent);
                    s.push_str(line);
                }
            }
        }
        out.push(s);
    }
    out.join(if tight { "\n" } else { "\n\n" })
}

fn prefix_lines(text: &str, prefix: &str, empty: &str) -> String {
    text.split('\n')
        .map(|l| if l.is_empty() { empty.to_string() } else { format!("{prefix}{l}") })
        .collect::<Vec<_>>()
        .join("\n")
}

fn longest_run(s: &str, ch: char) -> usize {
    let (mut best, mut cur) = (0, 0);
    for c in s.chars() {
        if c == ch {
            cur += 1;
            best = best.max(cur);
        } else {
            cur = 0;
        }
    }
    best
}

fn image(src: &str, alt: &str, title: Option<&str>) -> String {
    let alt = alt.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]");
    let src = if src.contains([' ', '(', ')']) { format!("<{src}>") } else { src.to_string() };
    match title {
        Some(t) => format!("![{alt}]({src} \"{}\")", t.replace('"', "\\\"")),
        None => format!("![{alt}]({src})"),
    }
}

fn table(rows: &[Vec<Cell>], esc: Escape) -> String {
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let text: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            r.iter()
                .map(|c| {
                    let inl = match c.content.first() {
                        Some(Node::Paragraph { content: i, .. }) => inline_md(&collapse(i), esc, true),
                        _ => String::new(),
                    };
                    inl
                })
                .collect()
        })
        .collect();
    let aligns: Vec<Option<Align>> =
        (0..cols).map(|c| rows.first().and_then(|r| r.get(c)).and_then(|c| c.align)).collect();
    let widths: Vec<usize> = (0..cols)
        .map(|c| {
            text.iter().map(|r| r.get(c).map(|s| s.chars().count()).unwrap_or(0)).max().unwrap_or(0).max(3)
        })
        .collect();
    let row_line = |cells: &[String]| {
        let padded: Vec<String> = (0..cols)
            .map(|c| {
                let s = cells.get(c).cloned().unwrap_or_default();
                let pad = widths[c] - s.chars().count();
                format!("{s}{}", " ".repeat(pad))
            })
            .collect();
        format!("| {} |", padded.join(" | "))
    };
    let delim: Vec<String> = (0..cols)
        .map(|c| {
            let w = widths[c];
            match aligns[c] {
                Some(Align::Left) => format!(":{}", "-".repeat(w - 1)),
                Some(Align::Right) => format!("{}:", "-".repeat(w - 1)),
                Some(Align::Center) => format!(":{}:", "-".repeat(w.saturating_sub(2).max(1))),
                None => "-".repeat(w),
            }
        })
        .collect();
    let mut lines = Vec::new();
    if let Some(first) = text.first() {
        lines.push(row_line(first));
        lines.push(format!("| {} |", delim.join(" | ")));
        for r in &text[1..] {
            lines.push(row_line(r));
        }
    }
    lines.join("\n")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MarkKind {
    Link,
    TextStyle,
    Bold,
    Italic,
    Strike,
    Underline,
    Highlight,
}

fn has(m: &Marks, k: MarkKind) -> bool {
    match k {
        MarkKind::Link => m.link.is_some(),
        MarkKind::TextStyle => m.text_style.as_ref().is_some_and(|t| crate::html::span_open(t).is_some()),
        MarkKind::Bold => m.bold,
        MarkKind::Italic => m.italic,
        MarkKind::Strike => m.strike,
        MarkKind::Underline => m.underline,
        MarkKind::Highlight => m.highlight.is_some(),
    }
}

/// Outside in, as tiptap-markdown nests them: `[<span>**<mark>a</mark>**</span>](…)`.
const ORDER: [MarkKind; 7] = [
    MarkKind::Link,
    MarkKind::TextStyle,
    MarkKind::Bold,
    MarkKind::Italic,
    MarkKind::Strike,
    MarkKind::Underline,
    MarkKind::Highlight,
];

/// Does an open mark `k` (opened for `open`) continue into `next`?
fn continues(k: MarkKind, open: &Marks, next: &Marks) -> bool {
    has(next, k)
        && match k {
            MarkKind::Link => next.link == open.link,
            MarkKind::TextStyle => next.text_style == open.text_style,
            MarkKind::Highlight => next.highlight == open.highlight,
            _ => true,
        }
}

fn bare(link: Option<&Link>, esc: Escape) -> bool {
    esc.bare_links && link.is_some_and(|l| l.style == LinkStyle::Autolink)
}

fn open(k: MarkKind, marks: &Marks, esc: Escape) -> String {
    let link = marks.link.as_ref();
    match k {
        MarkKind::TextStyle => marks.text_style.as_ref().and_then(crate::html::span_open).unwrap_or_default(),
        MarkKind::Highlight => marks.highlight.as_ref().map(crate::html::mark_open).unwrap_or_default(),
        _ => open_simple(k, link, esc).to_string(),
    }
}

fn open_simple(k: MarkKind, link: Option<&Link>, esc: Escape) -> &'static str {
    match k {
        MarkKind::TextStyle | MarkKind::Highlight => "",
        MarkKind::Link if bare(link, esc) => "",
        MarkKind::Link => "[",
        MarkKind::Bold if esc.html_marks => "<strong>",
        MarkKind::Italic if esc.html_marks => "<em>",
        MarkKind::Strike if esc.html_marks => "<s>",
        MarkKind::Bold => "**",
        MarkKind::Italic => "*",
        MarkKind::Strike => "~~",
        MarkKind::Underline => "<u>",
    }
}

fn close(k: MarkKind, link: Option<&Link>, esc: Escape) -> String {
    match k {
        MarkKind::Link if bare(link, esc) => String::new(),
        MarkKind::Link => {
            let l = link.expect("link mark");
            match &l.style {
                LinkStyle::Reference(label) if l.title.is_none() && !esc.inline_refs => format!("][{label}]"),
                _ => {
                    let href = if l.href.contains([' ', '(', ')', '<', '>']) {
                        format!("<{}>", l.href)
                    } else {
                        l.href.clone()
                    };
                    match &l.title {
                        Some(t) => format!("]({href} \"{}\")", t.replace('"', "\\\"")),
                        None => format!("]({href})"),
                    }
                }
            }
        }
        MarkKind::Bold if esc.html_marks => "</strong>".into(),
        MarkKind::Italic if esc.html_marks => "</em>".into(),
        MarkKind::Strike if esc.html_marks => "</s>".into(),
        MarkKind::Bold => "**".into(),
        MarkKind::Italic => "*".into(),
        MarkKind::Strike => "~~".into(),
        MarkKind::Underline => "</u>".into(),
        MarkKind::TextStyle => "</span>".into(),
        MarkKind::Highlight => "</mark>".into(),
    }
}

/// Marks two neighbours share, for whitespace pushed out of a mark.
fn common(a: &Marks, b: &Marks) -> Marks {
    Marks {
        bold: a.bold && b.bold,
        italic: a.italic && b.italic,
        strike: a.strike && b.strike,
        underline: a.underline && b.underline,
        code: false,
        link: if a.link == b.link { a.link.clone() } else { None },
        highlight: if a.highlight == b.highlight { a.highlight.clone() } else { None },
        text_style: if a.text_style == b.text_style { a.text_style.clone() } else { None },
    }
}

/// Markdown cannot close emphasis right after a space, so whitespace at the
/// edge of a marked run moves to the marks it shares with its neighbour.
fn expel_whitespace(inlines: &[Inline]) -> Vec<Inline> {
    let marks_at = |i: usize| match inlines.get(i) {
        Some(Inline::Text { marks, .. }) => marks.clone(),
        _ => Marks::default(),
    };
    let mut out = Vec::new();
    for (i, inl) in inlines.iter().enumerate() {
        match inl {
            Inline::Text { text, marks } if !marks.is_plain() && !marks.code => {
                let core = text.trim_matches(' ');
                let lead = text.len() - text.trim_start_matches(' ').len();
                let trail = text.len() - text.trim_end_matches(' ').len();
                if core.is_empty() {
                    let prev = if i > 0 { marks_at(i - 1) } else { Marks::default() };
                    out.push(Inline::Text { text: text.clone(), marks: common(marks, &prev) });
                    continue;
                }
                if lead > 0 {
                    let prev = if i > 0 { marks_at(i - 1) } else { Marks::default() };
                    out.push(Inline::Text { text: " ".repeat(lead), marks: common(marks, &prev) });
                }
                out.push(Inline::Text { text: core.to_string(), marks: marks.clone() });
                if trail > 0 {
                    out.push(Inline::Text { text: " ".repeat(trail), marks: common(marks, &marks_at(i + 1)) });
                }
            }
            other => out.push(other.clone()),
        }
    }
    normalize_inlines(out)
}

fn inline_md(inlines: &[Inline], esc: Escape, in_table: bool) -> String {
    inline_md_after(inlines, esc, in_table, false)
}

/// `after_prefix`: the text follows a marker on its line (a heading's `### `),
/// so its first characters are not at the start of a line and need no
/// line-start escape, as prosemirror-markdown writes `### 1. Title`.
fn inline_md_after(inlines: &[Inline], esc: Escape, in_table: bool, after_prefix: bool) -> String {
    let inlines = expel_whitespace(inlines);
    let mut out = String::new();
    // Open marks, each with the marks of the run that opened it.
    let mut stack: Vec<(MarkKind, Marks)> = Vec::new();
    let empty = Marks::default();
    for inl in inlines.iter() {
        let marks = match inl {
            Inline::Text { marks, .. } => marks,
            _ => &empty,
        };
        // Close marks this run does not continue (and everything above them).
        let keep = stack.iter().take_while(|(k, opened)| continues(*k, opened, marks)).count();
        while stack.len() > keep {
            let (k, opened) = stack.pop().unwrap();
            out.push_str(&close(k, opened.link.as_ref(), esc));
        }
        for k in ORDER {
            if has(marks, k) && !stack.iter().any(|(x, _)| *x == k) {
                out.push_str(&open(k, marks, esc));
                stack.push((k, marks.clone()));
            }
        }
        match inl {
            Inline::Text { text, marks } => {
                if marks.code {
                    // In a table, GFM splits cells before code spans, so a pipe needs `\|` even there.
                    let t = if in_table { text.replace('|', "\\|") } else { text.clone() };
                    out.push_str(&code_span(&t));
                } else if bare(marks.link.as_ref(), esc) {
                    out.push_str(text);
                } else {
                    let at_start = (out.is_empty() && !after_prefix) || out.ends_with('\n');
                    out.push_str(&escape(text, esc, at_start, out.is_empty(), in_table));
                }
            }
            Inline::Math { source } => out.push_str(source),
            Inline::HardBreak => out.push_str(if in_table { "<br>" } else { "\\\n" }),
        }
    }
    while let Some((k, opened)) = stack.pop() {
        out.push_str(&close(k, opened.link.as_ref(), esc));
    }
    out
}

fn code_span(text: &str) -> String {
    let n = longest_run(text, '`') + 1;
    let ticks = "`".repeat(n);
    let pad = text.starts_with('`') || text.ends_with('`') || (text.starts_with(' ') && text.ends_with(' ') && !text.trim().is_empty());
    if pad {
        format!("{ticks} {text} {ticks}")
    } else {
        format!("{ticks}{text}{ticks}")
    }
}

fn escape(text: &str, esc: Escape, at_line_start: bool, first_line: bool, in_table: bool) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let chars: Vec<char> = text.chars().collect();
    // `[^label]` is a footnote reference; escaped it would stop being one.
    let mut keep = vec![false; chars.len()];
    if !esc.all {
        let mut i = 0;
        while i + 2 < chars.len() {
            if chars[i] == '[' && chars[i + 1] == '^' {
                if let Some(k) = chars[i + 2..].iter().position(|c| *c == ']' || c.is_whitespace() || *c == '[') {
                    if chars[i + 2 + k] == ']' && k > 0 {
                        keep[i] = true;
                        keep[i + 2 + k] = true;
                        i += k + 3;
                        continue;
                    }
                }
            }
            i += 1;
        }
    }
    for (i, &c) in chars.iter().enumerate() {
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        let next = chars.get(i + 1).copied();
        let needs = if keep[i] {
            false
        } else if esc.all {
            c.is_ascii_punctuation()
        } else {
            match c {
                '\\' | '`' | '*' | '~' | '[' | ']' => true,
                '_' => !(prev.is_some_and(|p| p.is_alphanumeric()) && next.is_some_and(|n| n.is_alphanumeric())),
                '<' => next.is_some_and(|n| n.is_ascii_alphabetic() || n == '/' || n == '!' || n == '?'),
                '|' => in_table,
                '$' => esc.dollar,
                '&' => {
                    let rest: String = chars[i + 1..].iter().take(32).collect();
                    rest.find(';').is_some_and(|k| k > 0 && rest[..k].chars().all(|c| c.is_ascii_alphanumeric() || c == '#'))
                }
                _ => false,
            }
        };
        if needs {
            out.push('\\');
        }
        out.push(c);
    }
    if !esc.all && at_line_start {
        out = escape_line_start(&out, first_line);
    }
    out
}

/// prosemirror-markdown's `esc(str, startOfLine)` line-start rules:
/// `-`, `*`, `>` always; `+` before white space; one to six `#` before white
/// space or the end; digits before `. ` and white space. Markie RS adds the
/// two cases where that rule lets a line read back differently: a number
/// before `)` and white space, or before `.` or `)` at the very end (both
/// start an ordered list), and `=` on a line after a break (a setext
/// underline). Neither ever occurs in what TipTap writes byte for byte.
fn escape_line_start(s: &str, first_line: bool) -> String {
    let b = s.as_bytes();
    let space_or_end = |i: usize| b.get(i).is_none_or(|c| c.is_ascii_whitespace());
    let space = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_whitespace());
    match b.first() {
        None => s.to_string(),
        Some(b'-' | b'*' | b'>') => format!("\\{s}"),
        Some(b'+') if space_or_end(1) => format!("\\{s}"),
        Some(b'=') if !first_line => format!("\\{s}"),
        Some(b'#') => {
            let hashes = s.bytes().take_while(|c| *c == b'#').count();
            if hashes <= 6 && space_or_end(hashes) { format!("\\{s}") } else { s.to_string() }
        }
        Some(b'0'..=b'9') => {
            let digits = s.bytes().take_while(|c| c.is_ascii_digit()).count();
            let escape = match b.get(digits) {
                Some(b'.') => space_or_end(digits + 1),
                Some(b')') => space_or_end(digits + 1) && (space(digits + 1) || digits + 1 == b.len()),
                _ => false,
            };
            if escape { format!("{}\\{}", &s[..digits], &s[digits..]) } else { s.to_string() }
        }
        _ => s.to_string(),
    }
}

/// `src/lib/format-tables.ts`: pad every table's cells to aligned columns.
/// Markie's documented normalization on a rich edit, and what the TipTap
/// round-trip probe compares under.
pub fn format_markdown_tables(markdown: &str) -> String {
    fn split_row(line: &str) -> Vec<String> {
        let t = line.trim();
        let t = t.strip_prefix('|').unwrap_or(t);
        let t = t.strip_suffix('|').unwrap_or(t);
        let mut cells = Vec::new();
        let mut cur = String::new();
        let mut escaped = false;
        for ch in t.chars() {
            if escaped {
                cur.push('\\');
                cur.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '|' {
                cells.push(cur.trim().to_string());
                cur.clear();
            } else {
                cur.push(ch);
            }
        }
        if escaped {
            cur.push('\\');
        }
        cells.push(cur.trim().to_string());
        cells
    }
    fn is_delim_cell(c: &str) -> bool {
        let c = c.strip_prefix(':').unwrap_or(c);
        let c = c.strip_suffix(':').unwrap_or(c);
        !c.is_empty() && c.chars().all(|x| x == '-')
    }
    fn is_delim_row(line: &str) -> bool {
        let cells = split_row(line);
        !cells.is_empty() && cells.iter().all(|c| is_delim_cell(c))
    }
    fn looks_like_row(line: &str) -> bool {
        line.trim().starts_with('|')
    }
    fn format_block(lines: &[&str]) -> Vec<String> {
        let rows: Vec<Vec<String>> = lines.iter().map(|l| split_row(l)).collect();
        let delim = &rows[1];
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let widths: Vec<usize> = (0..cols)
            .map(|c| {
                let mut w = 3;
                for (r, row) in rows.iter().enumerate() {
                    if r != 1 {
                        w = w.max(row.get(c).map(|s| s.encode_utf16().count()).unwrap_or(0));
                    }
                }
                w
            })
            .collect();
        rows.iter()
            .enumerate()
            .map(|(r, cells)| {
                let padded: Vec<String> = (0..cols)
                    .map(|c| {
                        let w = widths[c];
                        if r == 1 {
                            let d = delim.get(c).map(|s| s.as_str()).unwrap_or("---");
                            let (l, rt) = (d.starts_with(':'), d.ends_with(':'));
                            if l && rt {
                                format!(":{}:", "-".repeat(w.saturating_sub(2).max(1)))
                            } else if l {
                                format!(":{}", "-".repeat(w.saturating_sub(1).max(2)))
                            } else if rt {
                                format!("{}:", "-".repeat(w.saturating_sub(1).max(2)))
                            } else {
                                "-".repeat(w)
                            }
                        } else {
                            let s = cells.get(c).cloned().unwrap_or_default();
                            let pad = w.saturating_sub(s.encode_utf16().count());
                            format!("{s}{}", " ".repeat(pad))
                        }
                    })
                    .collect();
                format!("| {} |", padded.join(" | "))
            })
            .collect()
    }
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            out.push(line.to_string());
            i += 1;
            continue;
        }
        if !in_fence
            && looks_like_row(line)
            && i + 1 < lines.len()
            && looks_like_row(lines[i + 1])
            && is_delim_row(lines[i + 1])
        {
            let mut block = vec![line, lines[i + 1]];
            let mut j = i + 2;
            while j < lines.len() && looks_like_row(lines[j]) && !is_delim_row(lines[j]) {
                block.push(lines[j]);
                j += 1;
            }
            out.extend(format_block(&block));
            i = j;
            continue;
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}
