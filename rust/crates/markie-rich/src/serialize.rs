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
    let tiers = [
        Escape { all: false, dollar: false, bare_links: true, html_marks: false },
        Escape { all: false, dollar: true, bare_links: true, html_marks: false },
        Escape { all: false, dollar: true, bare_links: false, html_marks: false },
        Escape { all: true, dollar: true, bare_links: false, html_marks: false },
        // `**a:**b` cannot close in Markdown (punctuation then a letter);
        // `<strong>` can, and both read back as the same mark.
        Escape { all: false, dollar: true, bare_links: true, html_marks: true },
        Escape { all: true, dollar: true, bare_links: false, html_marks: true },
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
        Node::Paragraph(c) => Node::Paragraph(expel_whitespace(c)),
        Node::Heading { level, content } => Node::Heading { level: *level, content: expel_whitespace(content) },
        Node::Blockquote(c) => Node::Blockquote(canonical(c)),
        Node::BulletList { tight, items } => {
            Node::BulletList { tight: *tight, items: items.iter().map(|i| canonical(i)).collect() }
        }
        Node::OrderedList { tight, start, items } => {
            Node::OrderedList { tight: *tight, start: *start, items: items.iter().map(|i| canonical(i)).collect() }
        }
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
        Node::Paragraph(c) => inline_md(c, esc, false),
        Node::Heading { level, content } => {
            format!("{} {}", "#".repeat(*level as usize), inline_md(content, esc, false))
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
        Node::Image { src, alt, title } => image(src, alt.as_deref().unwrap_or(""), title.as_deref()),
        Node::MathBlock { source } => source.clone(),
        Node::Embed { url } => url.clone(),
    }
}

fn list<'a>(items: impl Iterator<Item = (String, &'a Vec<Node>)>, tight: bool, esc: Escape) -> String {
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
                        Some(Node::Paragraph(i)) => inline_md(i, esc, true),
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
    Bold,
    Italic,
    Strike,
    Underline,
}

fn has(m: &Marks, k: MarkKind) -> bool {
    match k {
        MarkKind::Link => m.link.is_some(),
        MarkKind::Bold => m.bold,
        MarkKind::Italic => m.italic,
        MarkKind::Strike => m.strike,
        MarkKind::Underline => m.underline,
    }
}

const ORDER: [MarkKind; 5] =
    [MarkKind::Link, MarkKind::Bold, MarkKind::Italic, MarkKind::Strike, MarkKind::Underline];

fn bare(link: Option<&Link>, esc: Escape) -> bool {
    esc.bare_links && link.is_some_and(|l| l.style == LinkStyle::Autolink)
}

fn open(k: MarkKind, link: Option<&Link>, esc: Escape) -> &'static str {
    match k {
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
                LinkStyle::Reference(label) if l.title.is_none() => format!("][{label}]"),
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
    let inlines = expel_whitespace(inlines);
    let mut out = String::new();
    let mut stack: Vec<MarkKind> = Vec::new();
    let mut cur_link: Option<Link> = None;
    let empty = Marks::default();
    for inl in inlines.iter() {
        let marks = match inl {
            Inline::Text { marks, .. } => marks,
            _ => &empty,
        };
        // Close marks this run does not continue (and everything above them).
        let keep = stack
            .iter()
            .take_while(|k| {
                has(marks, **k) && (**k != MarkKind::Link || marks.link.as_ref() == cur_link.as_ref())
            })
            .count();
        while stack.len() > keep {
            let k = stack.pop().unwrap();
            out.push_str(&close(k, cur_link.as_ref(), esc));
            if k == MarkKind::Link {
                cur_link = None;
            }
        }
        for k in ORDER {
            if has(marks, k) && !stack.contains(&k) {
                if k == MarkKind::Link {
                    cur_link = marks.link.clone();
                }
                out.push_str(open(k, cur_link.as_ref(), esc));
                stack.push(k);
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
                    let at_start = out.is_empty() || out.ends_with('\n');
                    out.push_str(&escape(text, esc, at_start, in_table));
                }
            }
            Inline::Math { source } => out.push_str(source),
            Inline::HardBreak => out.push_str(if in_table { "<br>" } else { "\\\n" }),
        }
    }
    while let Some(k) = stack.pop() {
        out.push_str(&close(k, cur_link.as_ref(), esc));
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

fn escape(text: &str, esc: Escape, at_line_start: bool, in_table: bool) -> String {
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
        out = escape_line_start(&out);
    }
    out
}

fn escape_line_start(s: &str) -> String {
    let b = s.as_bytes();
    if b.is_empty() {
        return s.to_string();
    }
    match b[0] {
        b'#' | b'>' | b'+' | b'-' | b'=' => format!("\\{s}"),
        b'0'..=b'9' => {
            let digits = s.bytes().take_while(|c| c.is_ascii_digit()).count();
            match b.get(digits) {
                Some(b'.') | Some(b')') => format!("{}\\{}", &s[..digits], &s[digits..]),
                _ => s.to_string(),
            }
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
