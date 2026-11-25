//! Source mode's Markdown keys, ported from `@codemirror/lang-markdown`
//! 6.5.2 (`dist/index.js`), which Electron's Source loads through
//! `markdown({ base: markdownLanguage })` in `editor.tsx`:
//!
//! | Key | Command |
//! |---|---|
//! | ↵ | `insertNewlineContinueMarkup`: the next list item, task (unchecked) or quoted line; on an empty item it ends the list or outdents a level |
//! | ⌫ | `deleteMarkupBackward`: right after list or quote markup, one level of markup goes |
//! | ⌘V | `pasteURLAsLink`: a URL pasted over selected text makes `[text](url)` |
//!
//! CodeMirror reads its Lezer syntax tree. Here pulldown-cmark parses the
//! text into the few nodes those commands ask about (lists, items, quotes,
//! fenced code and the marks), with each node's end set where Lezer's would
//! be: a list item ends at its last line with text, a quote at its last
//! quoted line. Each command is one edit, so one undo step. They run only in
//! Markdown documents, as Electron leaves the extension out of plain text,
//! and only with one cursor: GPUI Kit does not let an app read the others,
//! so with several the keys do what GPUI Kit does.

use std::ops::Range;
use std::sync::LazyLock;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag};

use gpui_kit::component::input as kit;
use gpui_kit::*;
use markie_core::formats::FormatKind;

use super::source_keys::Edit;
use super::{DocKind, Workspace};

// ---------------------------------------------------------------- lines

/// The text's lines, as CodeMirror's `doc.lineAt` sees them: a line's text
/// stops before its `\n` or `\r\n`.
struct Doc<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

#[derive(Clone, Copy)]
struct Line<'a> {
    from: usize,
    to: usize,
    n: usize,
    text: &'a str,
}

impl<'a> Doc<'a> {
    fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        Doc { text, starts }
    }

    fn line_n(&self, n: usize) -> Line<'a> {
        let from = self.starts[n];
        let mut to = self.starts.get(n + 1).map_or(self.text.len(), |s| s - 1);
        if to > from && self.text.as_bytes()[to - 1] == b'\r' && to < self.text.len() {
            to -= 1;
        }
        Line { from, to, n, text: &self.text[from..to] }
    }

    fn line_at(&self, pos: usize) -> Line<'a> {
        self.line_n(self.starts.partition_point(|s| *s <= pos) - 1)
    }

    /// The line break to insert: the one this line ends with, else the
    /// line above's, else `\n`.
    fn line_break(&self, line: &Line) -> &'static str {
        let ends_crlf = |l: &Line| self.text[l.to..].starts_with("\r\n");
        if line.to < self.text.len() {
            return if ends_crlf(line) { "\r\n" } else { "\n" };
        }
        if line.n > 0 && ends_crlf(&self.line_n(line.n - 1)) { "\r\n" } else { "\n" }
    }
}

/// JavaScript's `String.slice`: clamped, never panics.
fn sl(s: &str, a: usize, b: usize) -> &str {
    let b = b.min(s.len());
    let a = a.min(b);
    s.get(a..b).unwrap_or("")
}

fn has_text(s: &str) -> bool {
    s.chars().any(|c| !c.is_whitespace())
}

/// `/^[\s>]*$/`
fn only_quote_marks(s: &str) -> bool {
    s.chars().all(|c| c.is_whitespace() || c == '>')
}

/// `countColumn(string, 4, to)`.
fn count_column(s: &str, to: usize) -> usize {
    let mut n = 0;
    for c in sl(s, 0, to).chars() {
        n = if c == '\t' { n + 4 - n % 4 } else { n + 1 };
    }
    n
}

// ----------------------------------------------------------------- tree

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Document,
    Blockquote,
    BulletList,
    OrderedList,
    ListItem,
    FencedCode,
    ListMark,
    QuoteMark,
    /// Emphasis, header and task marks: not plain text to `pasteURLAsLink`.
    Mark,
    /// Code, HTML, links, images, rules, escapes, entities, URLs: the rest
    /// of `pasteURLAsLink`'s `nonPlainText`.
    Literal,
    /// Paragraphs, headings, tables, emphasis: plain.
    Plain,
}

impl Kind {
    fn plain(self) -> bool {
        !matches!(self, Kind::FencedCode | Kind::ListMark | Kind::QuoteMark | Kind::Mark | Kind::Literal)
    }
}

#[derive(Debug)]
struct Node {
    kind: Kind,
    from: usize,
    to: usize,
    parent: usize,
    children: Vec<usize>,
}

/// The syntax tree, node 0 the document. HTML blocks and GFM's bare URLs
/// are kept beside it, for the checks that ask about them.
struct Tree {
    nodes: Vec<Node>,
    html: Vec<Range<usize>>,
    urls: Vec<Range<usize>>,
}

static URL: LazyLock<regex::Regex> = LazyLock::new(|| {
    // GFM's autolinks, which Lezer's `markdownLanguage` marks as `URL`.
    regex::Regex::new(r"(?i)(?:https?://|www\.)[^\s<]*[^\s<?!.,:*_~)]|[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+").unwrap()
});

impl Tree {
    fn add(&mut self, kind: Kind, range: Range<usize>, parent: usize) -> usize {
        let id = self.nodes.len();
        self.nodes.push(Node { kind, from: range.start, to: range.end, parent, children: Vec::new() });
        self.nodes[parent].children.push(id);
        id
    }

    /// Parse as Lezer does. Lezer lets an empty item, or a number other
    /// than 1, break a paragraph inside a list of its kind (`isBulletList`,
    /// `isOrderedList` with `inList`); CommonMark does not. Such lines are
    /// patched so pulldown-cmark sees an item there, then parsed again.
    fn parse(doc: &Doc) -> Tree {
        let mut patches: Vec<Patch> = Vec::new();
        for _ in 0..4 {
            let t = Tree::parse_with(doc, &patches);
            let more = t.lenient_items(doc, &patches);
            if more.is_empty() {
                return t;
            }
            patches.extend(more);
            patches.sort_by_key(|p| p.at);
        }
        Tree::parse_with(doc, &patches)
    }

    /// The lines Lezer reads as an item that this tree has as paragraph text.
    fn lenient_items(&self, doc: &Doc, done: &[Patch]) -> Vec<Patch> {
        let mut out = Vec::new();
        for n in 1..doc.starts.len() {
            let line = doc.line_n(n);
            if !has_text(doc.line_n(n - 1).text) || done.iter().any(|p| p.at >= line.from && p.at <= line.to) {
                continue;
            }
            // Past the quote marks and the indentation to the marker.
            let mut col = 0;
            loop {
                col += spaces(&line.text[col..]);
                if line.text[col..].starts_with('>') {
                    col += 1;
                } else {
                    break;
                }
            }
            let m = line.from + col;
            let rest = &line.text[col..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            let (ordered, size) = match rest.as_bytes().get(digits).copied() {
                Some(b'.' | b')') if (1..=9).contains(&digits) => (true, digits + 1),
                Some(b'-' | b'+' | b'*') if digits == 0 => (false, 1),
                _ => continue,
            };
            let after = &rest[size..];
            if !(after.is_empty() || after.starts_with([' ', '\t'])) {
                continue;
            }
            let empty = !has_text(after);
            let not_one = ordered && &rest[..digits] != "1";
            if !(empty || not_one) || self.nodes.iter().any(|x| x.kind == Kind::ListMark && x.from == m) {
                continue;
            }
            // Inside a list of the same kind, as paragraph text, not code,
            // and less than four columns past the item's content.
            let mut node = self.resolve_left(m);
            let mut in_list = false;
            let mut content_col = None;
            loop {
                let x = &self.nodes[node];
                match x.kind {
                    Kind::FencedCode | Kind::Literal => {
                        in_list = false;
                        break;
                    }
                    Kind::OrderedList if ordered => in_list = true,
                    Kind::BulletList if !ordered => in_list = true,
                    Kind::ListItem if content_col.is_none() => {
                        let l = doc.line_at(x.from);
                        let mark = x.children.iter().find(|&&c| self.nodes[c].kind == Kind::ListMark).map_or(x.from, |&c| self.nodes[c].to);
                        let gap = spaces(sl(l.text, mark - l.from, l.text.len()));
                        content_col = Some(mark - l.from + if (1..=4).contains(&gap) { gap } else { 1 });
                    }
                    _ => {}
                }
                if node == 0 {
                    break;
                }
                node = x.parent;
            }
            if !in_list || content_col.is_some_and(|c| col >= c + 4) {
                continue;
            }
            if not_one {
                out.push(Patch { at: m, len: digits, insert: false });
            }
            if empty {
                out.push(Patch { at: line.to, len: if after.is_empty() { 2 } else { 1 }, insert: true });
            }
        }
        out
    }

    fn parse_with(doc: &Doc, patches: &[Patch]) -> Tree {
        let text = doc.text;
        let mut t = Tree { nodes: vec![Node { kind: Kind::Document, from: 0, to: text.len(), parent: 0, children: Vec::new() }], html: Vec::new(), urls: Vec::new() };
        let mut stack = vec![0usize];
        let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
        let src = Patch::apply(text, patches);
        for (ev, r) in Parser::new_ext(&src, opts).into_offset_iter() {
            let r = Patch::back(patches, r.start)..Patch::back(patches, r.end);
            let top = *stack.last().unwrap_or(&0);
            match ev {
                Event::Start(tag) => {
                    let kind = match &tag {
                        Tag::BlockQuote(_) => Kind::Blockquote,
                        Tag::List(None) => Kind::BulletList,
                        Tag::List(Some(_)) => Kind::OrderedList,
                        Tag::Item => Kind::ListItem,
                        Tag::CodeBlock(CodeBlockKind::Fenced(_)) => Kind::FencedCode,
                        Tag::CodeBlock(_) | Tag::HtmlBlock | Tag::Link { .. } | Tag::Image { .. } => Kind::Literal,
                        Tag::MetadataBlock(_) | Tag::FootnoteDefinition(_) => Kind::Literal,
                        _ => Kind::Plain,
                    };
                    let id = t.add(kind, r.clone(), top);
                    stack.push(id);
                    match tag {
                        Tag::HtmlBlock => t.html.push(r.start..r.start + text[r.clone()].trim_end_matches(['\n', '\r']).len()),
                        Tag::Item => {
                            let line = doc.line_at(r.start);
                            let s = sl(line.text, r.start - line.from, line.text.len());
                            let at = r.start + s.len() - s.trim_start_matches([' ', '\t']).len();
                            let rest = &text[at..line.to];
                            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
                            let size = if digits > 0 { digits + 1 } else { 1 };
                            t.add(Kind::ListMark, at..(at + size).min(line.to), id);
                        }
                        Tag::Heading { level, .. } => {
                            let n = match level {
                                HeadingLevel::H1 => 1,
                                HeadingLevel::H2 => 2,
                                HeadingLevel::H3 => 3,
                                HeadingLevel::H4 => 4,
                                HeadingLevel::H5 => 5,
                                HeadingLevel::H6 => 6,
                            };
                            if text[r.start..].starts_with('#') {
                                t.add(Kind::Mark, r.start..r.start + n, id);
                            }
                        }
                        Tag::Emphasis | Tag::Strong | Tag::Strikethrough => {
                            let src = &text[r.clone()];
                            let c = src.chars().next().unwrap_or('*');
                            let n = src.chars().take_while(|d| *d == c).count().min(if matches!(tag, Tag::Emphasis) { 1 } else { 2 });
                            if src.len() >= 2 * n {
                                t.add(Kind::Mark, r.start..r.start + n, id);
                                t.add(Kind::Mark, r.end - n..r.end, id);
                            }
                        }
                        _ => {}
                    }
                }
                Event::End(_) => {
                    stack.pop();
                }
                Event::Code(_) | Event::InlineHtml(_) | Event::Html(_) | Event::Rule | Event::FootnoteReference(_) | Event::InlineMath(_) | Event::DisplayMath(_) => {
                    t.add(Kind::Literal, r, top);
                }
                Event::TaskListMarker(_) => {
                    t.add(Kind::Mark, r, top);
                }
                Event::Text(_) => {
                    let src = &text[r.clone()];
                    // An escape (`\*`) and an entity (`&amp;`).
                    if r.start > 0 && text.as_bytes()[r.start - 1] == b'\\' && src.chars().next().is_some_and(|c| c.is_ascii_punctuation()) {
                        t.add(Kind::Literal, r.start - 1..r.start + 1, top);
                    } else if src.len() > 2 && src.starts_with('&') && src.ends_with(';') {
                        t.add(Kind::Literal, r, top);
                    }
                }
                _ => {}
            }
        }
        // The URLs of GFM's autolink extension, which pulldown-cmark leaves
        // as text. Only the paste check reads them.
        t.urls = URL.find_iter(text).map(|m| m.range()).collect();
        t.add_quote_marks(doc);
        t.set_ends(doc);
        let starts: Vec<usize> = t.nodes.iter().map(|n| n.from).collect();
        for n in &mut t.nodes {
            n.children.sort_by_key(|&c| (starts[c], c));
        }
        t
    }

    /// Lezer gives a quote a `QuoteMark` on every line it continues on.
    fn add_quote_marks(&mut self, doc: &Doc) {
        let quotes: Vec<usize> = (0..self.nodes.len()).filter(|&i| self.nodes[i].kind == Kind::Blockquote).collect();
        for q in quotes {
            let (from, end) = (self.nodes[q].from, self.nodes[q].to);
            let first = doc.line_at(from);
            let col = from - first.from;
            let mut n = first.n;
            while n < doc.starts.len() && doc.starts[n] < end.max(from + 1) {
                let line = doc.line_n(n);
                let lead = spaces(sl(line.text, col, line.text.len()));
                let at = line.from + col + lead;
                if col <= line.text.len() && lead <= 3 && text_at(doc.text, at) == Some('>') {
                    self.add(Kind::QuoteMark, at..at + 1, q);
                }
                n += 1;
            }
        }
    }

    /// Lezer's ends: a leaf ends where its text does; a list item at the
    /// end of its first line or of its last line with text; a quote at its
    /// last quoted line; a list at its last item.
    fn set_ends(&mut self, doc: &Doc) {
        for i in (1..self.nodes.len()).rev() {
            let (kind, from, raw) = (self.nodes[i].kind, self.nodes[i].from, self.nodes[i].to);
            let children_end = self.nodes[i].children.iter().map(|&c| self.nodes[c].to).max().unwrap_or(from);
            let first_line_end = doc.line_at(from).to;
            let to = match kind {
                Kind::ListItem | Kind::Blockquote => {
                    let mut end = first_line_end;
                    let mut n = doc.line_at(from).n + 1;
                    while n < doc.starts.len() && doc.starts[n] < raw {
                        let line = doc.line_n(n);
                        let counts = if kind == Kind::Blockquote { has_text(line.text) } else { !only_quote_marks(line.text) };
                        if counts {
                            end = line.to;
                        }
                        n += 1;
                    }
                    end.max(children_end)
                }
                Kind::BulletList | Kind::OrderedList => first_line_end.max(children_end),
                Kind::ListMark | Kind::QuoteMark | Kind::Mark => raw,
                _ => {
                    let s = &doc.text[from..raw];
                    (from + s.trim_end_matches(['\n', '\r']).len()).max(children_end)
                }
            };
            self.nodes[i].to = to;
        }
    }

    fn is_mark(&self, n: usize) -> bool {
        matches!(self.nodes[n].kind, Kind::ListMark | Kind::QuoteMark)
    }

    fn is_list(&self, n: usize) -> bool {
        matches!(self.nodes[n].kind, Kind::BulletList | Kind::OrderedList)
    }

    /// `tree.resolveInner(pos, -1)`: the innermost node that starts before
    /// `pos` and reaches it.
    fn resolve_left(&self, pos: usize) -> usize {
        let mut at = 0;
        'down: loop {
            for &c in self.nodes[at].children.iter().rev() {
                let n = &self.nodes[c];
                if n.from < pos && n.to >= pos {
                    at = c;
                    continue 'down;
                }
            }
            return at;
        }
    }

    /// `node.childBefore(pos)`: the last child starting before `pos`.
    fn child_before(&self, node: usize, pos: usize) -> Option<usize> {
        self.nodes[node].children.iter().rev().copied().find(|&c| self.nodes[c].from < pos)
    }

    fn items(&self, list: usize) -> impl Iterator<Item = usize> + '_ {
        self.nodes[list].children.iter().copied().filter(|&c| self.nodes[c].kind == Kind::ListItem)
    }

    fn next_item(&self, item: usize) -> Option<usize> {
        let list = self.nodes[item].parent;
        self.items(list).skip_while(|&c| c != item).nth(1)
    }

    /// `!markdownLanguage.isActiveAt(pos)` on both sides: inside an HTML
    /// block, where Lezer hands the text to the HTML parser.
    fn in_html(&self, pos: usize) -> bool {
        self.html.iter().any(|r| r.start < pos && pos < r.end)
    }
}

fn text_at(text: &str, at: usize) -> Option<char> {
    text.get(at..).and_then(|s| s.chars().next())
}

/// A change to the text pulldown-cmark reads: `len` letters inserted at
/// `at`, or the `len` digits at `at` rewritten as `0…01`.
#[derive(Clone, Copy, Debug)]
struct Patch {
    at: usize,
    len: usize,
    insert: bool,
}

impl Patch {
    fn apply<'a>(text: &'a str, patches: &[Patch]) -> std::borrow::Cow<'a, str> {
        if patches.is_empty() {
            return text.into();
        }
        let mut out = String::with_capacity(text.len() + 2 * patches.len());
        let mut at = 0;
        for p in patches {
            out.push_str(&text[at..p.at]);
            if p.insert {
                out.push_str(&" x"[2 - p.len..]);
                at = p.at;
            } else {
                out.push_str(&"0".repeat(p.len - 1));
                out.push('1');
                at = p.at + p.len;
            }
        }
        out.push_str(&text[at..]);
        out.into()
    }

    /// A position in the patched text, in the real one.
    fn back(patches: &[Patch], pos: usize) -> usize {
        let mut delta = 0;
        for p in patches.iter().filter(|p| p.insert) {
            let start = p.at + delta;
            if pos <= start {
                break;
            }
            if pos < start + p.len {
                return p.at;
            }
            delta += p.len;
        }
        pos - delta
    }
}

// -------------------------------------------------------------- context

/// One level of block markup on a line: CodeMirror's `Context`.
#[derive(Debug, Clone)]
struct Ctx {
    /// The list (for an item) or the quote.
    node: usize,
    from: usize,
    to: usize,
    space_before: String,
    space_after: String,
    typ: String,
    item: Option<usize>,
}

impl Ctx {
    fn quote(&self, t: &Tree) -> bool {
        t.nodes[self.node].kind == Kind::Blockquote
    }

    fn blank(&self, t: &Tree, max_width: Option<isize>, trailing: bool) -> String {
        let mut result = self.space_before.clone() + if self.quote(t) { ">" } else { "" };
        if let Some(w) = max_width {
            while (result.len() as isize) < w {
                result.push(' ');
            }
            return result;
        }
        let pad = self.to as isize - self.from as isize - result.len() as isize - self.space_after.len() as isize;
        for _ in 0..pad.max(0) {
            result.push(' ');
        }
        if trailing {
            result.push_str(&self.space_after);
        }
        result
    }

    fn marker(&self, t: &Tree, text: &str, add: i64) -> String {
        let number = if t.nodes[self.node].kind == Kind::OrderedList {
            self.item.and_then(|i| item_number(t, text, i)).map_or(String::new(), |(_, n, _)| (n + add).to_string())
        } else {
            String::new()
        };
        format!("{}{}{}{}", self.space_before, number, self.typ, self.space_after)
    }
}

/// `itemNumber`: `/^(\s*)(\d+)(?=[.)])/` at the item's start, as the
/// leading space's length, the number, and the length of both.
fn item_number(t: &Tree, text: &str, item: usize) -> Option<(usize, i64, usize)> {
    let from = t.nodes[item].from;
    let s = sl(text, from, from + 10);
    let space = s.len() - s.trim_start().len();
    let digits = s[space..].bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || !matches!(s.as_bytes().get(space + digits), Some(b'.' | b')')) {
        return None;
    }
    Some((space, s[space..space + digits].parse().ok()?, space + digits))
}

fn spaces(s: &str) -> usize {
    s.bytes().take_while(|b| *b == b' ').count()
}

/// `getContext`: the quotes and list items around `node`, outermost first;
/// none inside fenced code.
fn get_context(t: &Tree, doc: &Doc, node: usize) -> Vec<Ctx> {
    let mut nodes = Vec::new();
    let mut cur = node;
    loop {
        let n = &t.nodes[cur];
        if n.kind == Kind::FencedCode {
            return Vec::new();
        }
        if matches!(n.kind, Kind::ListItem | Kind::Blockquote) {
            nodes.push(cur);
        }
        if cur == 0 {
            break;
        }
        cur = n.parent;
    }
    let mut out = Vec::new();
    for &id in nodes.iter().rev() {
        let n = &t.nodes[id];
        let line = doc.line_at(n.from);
        let start = n.from - line.from;
        let s = sl(line.text, start, line.text.len());
        if n.kind == Kind::Blockquote {
            // /^ *>( ?)/
            let lead = spaces(s);
            if s[lead..].starts_with('>') {
                let after = if s[lead + 1..].starts_with(' ') { " " } else { "" };
                let len = lead + 1 + after.len();
                out.push(Ctx { node: id, from: start, to: start + len, space_before: String::new(), space_after: after.into(), typ: ">".into(), item: None });
            }
            continue;
        }
        let list = n.parent;
        let lead = spaces(s);
        let rest = &s[lead..];
        if t.nodes[list].kind == Kind::OrderedList {
            // /^( *)\d+([.)])( *)/
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            let Some(delim) = rest[digits..].chars().next().filter(|c| digits > 0 && matches!(c, '.' | ')')) else { continue };
            let mut after = spaces(&rest[digits + 1..]);
            let mut len = lead + digits + 1 + after;
            if after >= 4 {
                after -= 4;
                len -= 4;
            }
            out.push(Ctx { node: list, from: start, to: start + len, space_before: " ".repeat(lead), space_after: " ".repeat(after), typ: delim.into(), item: Some(id) });
        } else if t.nodes[list].kind == Kind::BulletList {
            // /^( *)([-+*])( {1,4}\[[ xX]\])?( +)/
            let Some(bullet) = rest.chars().next().filter(|c| matches!(c, '-' | '+' | '*')) else { continue };
            let gap = spaces(&rest[1..]);
            let task = &rest[1 + gap..];
            let (typ, after) = if (1..=4).contains(&gap) && (task.starts_with("[ ]") || task.starts_with("[x]") || task.starts_with("[X]")) && spaces(&task[3..]) > 0 {
                (format!("{bullet}{} [ ]", " ".repeat(gap - 1)), spaces(&task[3..]))
            } else if gap > 0 {
                (bullet.to_string(), gap)
            } else {
                continue;
            };
            let mut len = lead + typ.len() + after;
            let mut after = after;
            if after > 4 {
                after -= 4;
                len -= 4;
            }
            out.push(Ctx { node: list, from: start, to: start + len, space_before: " ".repeat(lead), space_after: " ".repeat(after), typ, item: Some(id) });
        }
    }
    out
}

/// `renumberList`: the items after `after` that count on from it, renumbered
/// to follow it (plus `offset`).
fn renumber(t: &Tree, text: &str, after: usize, changes: &mut Vec<(Range<usize>, String)>, offset: i64) {
    let mut prev: i64 = -1;
    let mut node = Some(after);
    while let Some(item) = node {
        let Some((space, number, len)) = item_number(t, text, item) else { return };
        if prev >= 0 {
            if number != prev + 1 {
                return;
            }
            let from = t.nodes[item].from;
            changes.push((from + space..from + len, (prev + 2 + offset).to_string()));
        }
        prev = number;
        node = t.next_item(item);
    }
}

/// `nonTightList`: a blank line between the list's first two items.
fn non_tight(t: &Tree, doc: &Doc, list: usize) -> bool {
    if !t.is_list(list) {
        return false;
    }
    let mut items = t.items(list);
    let (Some(first), Some(second)) = (items.next(), items.next()) else { return false };
    let line1 = doc.line_at(t.nodes[first].to);
    let line2 = doc.line_at(t.nodes[second].from);
    line1.n + if only_quote_marks(line1.text) { 0 } else { 1 } < line2.n
}

/// `blankLine`: the markup of every level but the innermost, as spaces.
fn blank_line(t: &Tree, cx: &[Ctx], line: &Line) -> String {
    let mut insert = String::new();
    if cx.len() < 2 {
        return insert;
    }
    let e = cx.len() - 2;
    for i in 0..=e {
        let w = (i < e).then(|| count_column(line.text, cx[i + 1].from) as isize - insert.len() as isize);
        insert += &cx[i].blank(t, w, i < e);
    }
    insert
}

/// Every change at once, as one replacement; `cursor` is in the new text.
fn combine(text: &str, mut changes: Vec<(Range<usize>, String)>, cursor: usize) -> Edit {
    changes.sort_by_key(|c| c.0.start);
    let start = changes[0].0.start;
    let end = changes.iter().map(|c| c.0.end).max().unwrap_or(start);
    let mut out = String::new();
    let mut at = start;
    for (r, s) in &changes {
        out.push_str(&text[at..r.start]);
        out.push_str(s);
        at = r.end;
    }
    out.push_str(&text[at..end]);
    Edit { range: start..end, text: out, select: cursor..cursor }
}

// ------------------------------------------------------------- parsing

/// Over this size only the text from a safe block start before the cursor
/// is parsed, as Lezer parses lazily.
const WHOLE_PARSE: usize = 1 << 20;

/// Where a parse can start for `pos`, and where it ends: the whole text,
/// or for a long one from the last top-level line after a blank line
/// outside fenced code.
fn window(text: &str, pos: usize) -> Range<usize> {
    if text.len() <= WHOLE_PARSE {
        return 0..text.len();
    }
    let mut start = 0;
    let mut fence: Option<(u8, usize)> = None;
    let mut blank_before = false;
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        if at > pos {
            break;
        }
        let body = line.trim_end_matches(['\n', '\r']);
        let lead = spaces(body);
        let rest = &body[lead..];
        let ch = rest.bytes().next();
        let run = ch.map_or(0, |c| rest.bytes().take_while(|b| *b == c).count());
        if lead < 4 && matches!(ch, Some(b'`' | b'~')) && run >= 3 {
            match fence {
                Some((c, n)) if c == ch.unwrap_or(0) && run >= n && rest[run..].trim().is_empty() => fence = None,
                None => fence = Some((ch.unwrap_or(0), run)),
                _ => {}
            }
        }
        if fence.is_none() && blank_before && lead == 0 && has_text(body) {
            start = at;
        }
        blank_before = fence.is_none() && !has_text(body);
        at += line.len();
    }
    let mut end = (pos + (WHOLE_PARSE / 4)).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    end = text[end..].find('\n').map_or(text.len(), |i| end + i);
    start..end
}

/// Run `f` on the part of the text worth parsing, and move its edit back.
fn windowed(text: &str, pos: usize, f: impl FnOnce(&str, usize) -> Option<Edit>) -> Option<Edit> {
    let w = window(text, pos);
    let e = f(&text[w.clone()], pos - w.start)?;
    let by = w.start;
    Some(Edit { range: e.range.start + by..e.range.end + by, text: e.text, select: e.select.start + by..e.select.end + by })
}

// ------------------------------------------------------------- commands

/// `insertNewlineContinueMarkup` (↵). `None` leaves Enter to GPUI Kit.
pub(super) fn continue_markup(text: &str, sel: Range<usize>) -> Option<Edit> {
    if sel.start != sel.end {
        return None;
    }
    windowed(text, sel.start, continue_markup_in)
}

fn continue_markup_in(text: &str, pos: usize) -> Option<Edit> {
    let doc = Doc::new(text);
    let t = Tree::parse(&doc);
    if t.in_html(pos) {
        return None;
    }
    let line = doc.line_at(pos);
    let col = pos - line.from;
    let brk = doc.line_break(&line);
    let mut cx = get_context(&t, &doc, t.resolve_left(pos));
    while cx.last().is_some_and(|c| c.from > col) {
        cx.pop();
    }
    let inner = cx.last()?.clone();
    if inner.to - inner.space_after.len() > col {
        return None;
    }
    let empty_line = col >= inner.to - inner.space_after.len() && !has_text(sl(line.text, inner.to, line.text.len()));

    // An empty item.
    if let (Some(item), true) = (inner.item, empty_line) {
        if t.nodes[item].from < line.from && !only_quote_marks(sl(line.text, 0, inner.to)) {
            return None;
        }
        let mut items = t.items(inner.node);
        let first = items.next()?;
        let second = items.next();
        let prev_blank = line.n > 0 && !doc.line_n(line.n - 1).text.chars().any(|c| !c.is_whitespace() && c != '>');
        if t.nodes[first].to >= pos || second.is_some_and(|s| t.nodes[s].to < pos) || prev_blank {
            // Not the second item, or a blank line before: one level goes.
            let next = (cx.len() > 1).then(|| cx[cx.len() - 2].clone());
            let (del_to, insert) = match &next {
                Some(n) if n.item.is_some() => (line.from + n.from, n.marker(&t, text, 1)),
                Some(n) => (line.from + n.to, String::new()),
                None => (line.from, String::new()),
            };
            let cursor = del_to + insert.len();
            let mut changes = vec![(del_to..pos, insert)];
            if t.nodes[inner.node].kind == Kind::OrderedList {
                renumber(&t, text, item, &mut changes, -2);
            }
            if let Some(n) = next.as_ref().filter(|n| t.nodes[n.node].kind == Kind::OrderedList) {
                renumber(&t, text, n.item?, &mut changes, 0);
            }
            return Some(combine(text, changes, cursor));
        }
        // The second item moves down: the tight two-item list goes loose.
        let insert = blank_line(&t, &cx, &line);
        let cursor = pos + insert.len() + brk.len();
        return Some(combine(text, vec![(line.from..line.from, insert + brk)], cursor));
    }

    // Two empty quoted lines in a row end the quote.
    if inner.quote(&t) && empty_line && line.from > 0 {
        let prev = doc.line_n(line.n - 1);
        let trimmed = prev.text.trim_end();
        if let Some(idx) = trimmed.strip_suffix('>').map(str::len)
            && idx == inner.from
        {
            let gone = prev.to - (prev.from + idx);
            let cursor = line.from + inner.from - gone;
            return Some(combine(text, vec![(prev.from + idx..prev.to, String::new()), (line.from + inner.from..line.to, String::new())], cursor));
        }
    }

    let mut changes = Vec::new();
    if t.nodes[inner.node].kind == Kind::OrderedList {
        renumber(&t, text, inner.item?, &mut changes, 0);
    }
    let continued = inner.item.is_some_and(|i| t.nodes[i].from < line.from);
    let mut insert = String::new();
    let markup = line.text.chars().take_while(|c| c.is_whitespace() || c.is_ascii_digit() || ".)-+*>".contains(*c)).map(char::len_utf8).sum::<usize>();
    if !continued || markup >= inner.to {
        let e = cx.len() - 1;
        for i in 0..=e {
            insert += &if i == e && !continued {
                cx[i].marker(&t, text, 1)
            } else {
                let w = (i < e).then(|| count_column(line.text, cx[i + 1].from) as isize - insert.len() as isize);
                cx[i].blank(&t, w, true)
            };
        }
    }
    let mut from = pos;
    while from > line.from && text[..from].chars().next_back().is_some_and(char::is_whitespace) {
        from -= text[..from].chars().next_back().map_or(1, char::len_utf8);
    }
    if non_tight(&t, &doc, inner.node) {
        insert = blank_line(&t, &cx, &line) + brk + &insert;
    }
    let cursor = from + brk.len() + insert.len();
    changes.push((from..pos, format!("{brk}{insert}")));
    Some(combine(text, changes, cursor))
}

/// `contextNodeForDelete`: the node whose markup ends at `pos`, stepping
/// back over marks and into a list that ends before it.
fn delete_context_node(t: &Tree, pos: usize) -> usize {
    let mut node = t.resolve_left(pos);
    let mut scan = pos;
    if t.is_mark(node) {
        scan = t.nodes[node].from;
        node = t.nodes[node].parent;
    }
    while let Some(prev) = t.child_before(node, scan) {
        if t.is_mark(prev) {
            scan = t.nodes[prev].from;
        } else if t.is_list(prev) {
            let Some(&last) = t.nodes[prev].children.iter().rev().find(|&&c| t.nodes[c].kind == Kind::ListItem) else { break };
            node = last;
            scan = t.nodes[node].to;
        } else {
            break;
        }
    }
    node
}

/// `deleteMarkupBackward` (⌫). `None` leaves Backspace to GPUI Kit.
pub(super) fn delete_markup(text: &str, sel: Range<usize>) -> Option<Edit> {
    if sel.start != sel.end {
        return None;
    }
    windowed(text, sel.start, delete_markup_in)
}

fn delete_markup_in(text: &str, pos: usize) -> Option<Edit> {
    let doc = Doc::new(text);
    let t = Tree::parse(&doc);
    if t.in_html(pos) {
        return None;
    }
    let line = doc.line_at(pos);
    let col = pos - line.from;
    let cx = get_context(&t, &doc, delete_context_node(&t, pos));
    let inner = cx.last()?;
    let space_end = inner.to - inner.space_after.len() + usize::from(!inner.space_after.is_empty());
    // Extra space after the markup goes first.
    if col > space_end && !has_text(sl(line.text, space_end, col)) {
        let at = line.from + space_end;
        return Some(Edit { range: at..pos, text: String::new(), select: at..at });
    }
    let on_item_line = inner.item.is_some_and(|i| line.from <= t.nodes[i].from);
    if col == space_end && (on_item_line || only_quote_marks(sl(line.text, 0, inner.to))) {
        let start = line.from + inner.from;
        // A later item's marker becomes spaces, to continue the item above.
        if let Some(item) = inner.item
            && t.nodes[inner.node].from < t.nodes[item].from
            && has_text(sl(line.text, inner.from, inner.to))
        {
            let w = count_column(line.text, inner.to) as isize - count_column(line.text, inner.from) as isize;
            let insert = inner.blank(&t, Some(w), true);
            let cursor = start + insert.len();
            return Some(Edit { range: start..line.from + inner.to, text: insert, select: cursor..cursor });
        }
        if start < pos {
            return Some(Edit { range: start..pos, text: String::new(), select: start..start });
        }
    }
    None
}

/// `pasteURLAsLink`: a pasted URL over a selection of plain text makes
/// `[text](url)`, the text still selected. `None` pastes as usual.
pub(super) fn paste_url_link(text: &str, sel: Range<usize>, clip: &str) -> Option<Edit> {
    if sel.start == sel.end {
        return None;
    }
    // /^(https?:\/\/|mailto:|xmpp:|www\.)/
    if !["http://", "https://", "mailto:", "xmpp:", "www."].iter().any(|p| clip.starts_with(p)) {
        return None;
    }
    let link = if clip.starts_with("www.") { format!("https://{clip}") } else { clip.to_string() };
    let w = window(text, sel.start);
    if sel.end > w.end {
        return None;
    }
    let part = &text[w.clone()];
    let (a, b) = (sel.start - w.start, sel.end - w.start);
    let doc = Doc::new(part);
    let t = Tree::parse(&doc);
    if t.in_html(a + 1) {
        return None;
    }
    // No node may start or end inside the selection, and none it touches
    // may be code, HTML, a link, an image, a mark, an escape or a URL.
    let touches = |r: &Range<usize>| r.start <= b && r.end >= a;
    let crosses = t.nodes.iter().any(|n| touches(&(n.from..n.to)) && (n.from > a || n.to < b || !n.kind.plain()))
        || t.html.iter().chain(&t.urls).any(touches);
    if crosses {
        return None;
    }
    let selected = &text[sel.clone()];
    Some(Edit { range: sel.clone(), text: format!("[{selected}]({link})"), select: sel.start + 1..sel.end + 1 })
}

// ----------------------------------------------------------------- glue

impl Workspace {
    /// Markdown text in Source, with the keyboard in its editor and, as far
    /// as Markie RS can tell, one cursor.
    fn source_markdown_ready(&self, window: &Window, cx: &App) -> bool {
        !self.source_keys.multi
            && self.doc.as_ref().is_some_and(|d| d.format == FormatKind::Markdown && matches!(d.kind, DocKind::Text { .. }))
            && self.editor.read(cx).focus_handle(cx).is_focused(window)
    }

    /// GPUI Kit's own Enter, Backspace and Paste, taken in the capture phase
    /// when a Markdown command applies; otherwise they go on to GPUI Kit.
    /// Taking the actions, not the keys, catches the Edit menu's Paste too.
    pub(super) fn source_markdown_keys(d: Div, cx: &mut Context<Self>) -> Div {
        d.capture_action(cx.listener(|this, a: &kit::Enter, window, cx| {
            if !a.secondary && !a.shift {
                this.source_markdown_command(continue_markup, window, cx);
            }
        }))
        .capture_action(cx.listener(|this, _: &kit::Backspace, window, cx| {
            this.source_markdown_command(delete_markup, window, cx);
        }))
        .capture_action(cx.listener(|this, _: &kit::Paste, window, cx| {
            if let Some(clip) = cx.read_from_clipboard().and_then(|c| c.text()) {
                this.source_markdown_command(|t, s| paste_url_link(t, s, &clip), window, cx);
            }
        }))
        .capture_action(cx.listener(|this, _: &gpui_kit::base::input::AddCursorAbove, _, _| this.source_keys.multi = true))
        .capture_action(cx.listener(|this, _: &gpui_kit::base::input::AddCursorBelow, _, _| this.source_keys.multi = true))
        // GPUI Kit's Escape drops the extra cursors first.
        .capture_action(cx.listener(|this, _: &kit::Escape, _, _| this.source_keys.multi = false))
    }

    /// Run one Markdown command; true when it applied and the action stops.
    pub(super) fn source_markdown_command(&mut self, f: impl FnOnce(&str, Range<usize>) -> Option<Edit>, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.source_markdown_ready(window, cx) {
            return false;
        }
        let (text, sel) = self.source_text_and_selection(cx);
        let Some(edit) = f(&text, sel) else { return false };
        self.apply_source_edit(edit, window, cx);
        cx.stop_propagation();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{continue_markup, delete_markup, paste_url_link, window, WHOLE_PARSE};
    use crate::workspace::source_keys::Edit;
    use std::ops::Range;

    fn apply(text: &str, e: &Edit) -> String {
        format!("{}{}{}", &text[..e.range.start], e.text, &text[e.range.end..])
    }

    /// The text with `|` for the cursor, or `[` `]` around a selection.
    fn marked(text: &str) -> (String, Range<usize>) {
        if let Some(i) = text.find('|') {
            return (text.replacen('|', "", 1), i..i);
        }
        let a = text.find('[').unwrap();
        let b = text.find(']').unwrap() - 1;
        (text.replacen('[', "", 1).replacen(']', "", 1), a..b)
    }

    fn show(text: &str, sel: &Range<usize>) -> String {
        if sel.start == sel.end {
            format!("{}|{}", &text[..sel.start], &text[sel.start..])
        } else {
            format!("{}«{}»{}", &text[..sel.start], &text[sel.clone()], &text[sel.end..])
        }
    }

    fn enter(input: &str) -> Option<String> {
        let (text, sel) = marked(input);
        continue_markup(&text, sel).map(|e| show(&apply(&text, &e), &e.select))
    }

    fn back(input: &str) -> Option<String> {
        let (text, sel) = marked(input);
        delete_markup(&text, sel).map(|e| show(&apply(&text, &e), &e.select))
    }

    #[test]
    fn enter_continues_bullets_of_each_kind() {
        assert_eq!(enter("- one|").as_deref(), Some("- one\n- |"));
        assert_eq!(enter("* one|\n").as_deref(), Some("* one\n* |\n"));
        assert_eq!(enter("+ one|\n+ two").as_deref(), Some("+ one\n+ |\n+ two"));
        assert_eq!(enter("-   wide|").as_deref(), Some("-   wide\n-   |"), "the space after the marker is kept");
        assert_eq!(enter("  - indented|").as_deref(), Some("  - indented\n  - |"));
    }

    #[test]
    fn enter_in_the_middle_of_an_item_splits_it() {
        assert_eq!(enter("- one tw|o").as_deref(), Some("- one tw\n- |o"));
        assert_eq!(enter("- one |two").as_deref(), Some("- one\n- |two"), "the space before the cursor goes, as CodeMirror trims it");
        assert_eq!(enter("1. ab|cd\n2. ef").as_deref(), Some("1. ab\n2. |cd\n3. ef"));
    }

    #[test]
    fn enter_before_the_markup_is_left_to_the_editor() {
        assert_eq!(enter("|- one"), None);
        // Between the marker and its space CodeMirror still continues.
        assert_eq!(enter("-| one").as_deref(), Some("-\n- | one"));
        assert_eq!(enter("plain text|"), None);
        assert_eq!(enter("# Heading|"), None);
    }

    #[test]
    fn enter_continues_numbers_and_renumbers_what_follows() {
        assert_eq!(enter("1. one|\n2. two\n3. three").as_deref(), Some("1. one\n2. |\n3. two\n4. three"));
        assert_eq!(enter("1) one|").as_deref(), Some("1) one\n2) |"));
        // A list that starts at 7 counts on from 7.
        assert_eq!(enter("7. seven|\n8. eight").as_deref(), Some("7. seven\n8. |\n9. eight"));
        // Renumbering stops where the numbers stop counting by one.
        assert_eq!(enter("1. a|\n2. b\n5. c").as_deref(), Some("1. a\n2. |\n3. b\n5. c"));
    }

    #[test]
    fn enter_on_a_task_starts_an_unchecked_task() {
        assert_eq!(enter("- [x] done|").as_deref(), Some("- [x] done\n- [ ] |"));
        assert_eq!(enter("- [ ] todo|").as_deref(), Some("- [ ] todo\n- [ ] |"));
        assert_eq!(enter("1. [X] first|").as_deref(), Some("1. [X] first\n2. |"), "ordered tasks take a plain number, as CodeMirror's regex");
    }

    #[test]
    fn enter_continues_quotes_and_lists_inside_them() {
        assert_eq!(enter("> quoted|").as_deref(), Some("> quoted\n> |"));
        assert_eq!(enter("> - item|").as_deref(), Some("> - item\n> - |"));
        assert_eq!(enter("> 1. item|").as_deref(), Some("> 1. item\n> 2. |"));
        // An empty quoted line keeps the quote; a second one ends it.
        assert_eq!(enter("> a\n> |").as_deref(), Some("> a\n>\n> |"));
        assert_eq!(enter("> a\n>\n> |").as_deref(), Some("> a\n\n|"));
    }

    #[test]
    fn enter_continues_nested_lists_at_their_indent() {
        assert_eq!(enter("- a\n  - b|").as_deref(), Some("- a\n  - b\n  - |"));
        assert_eq!(enter("1. a\n   - b|").as_deref(), Some("1. a\n   - b\n   - |"));
        assert_eq!(enter("- a\n  1. b|").as_deref(), Some("- a\n  1. b\n  2. |"));
    }

    #[test]
    fn enter_on_an_empty_item_ends_the_list_or_outdents() {
        assert_eq!(enter("- |").as_deref(), Some("|"), "a lone empty item loses its marker");
        assert_eq!(enter("- a\n- b\n- |").as_deref(), Some("- a\n- b\n|"));
        // The second item of a tight list moves down instead: the list goes loose.
        assert_eq!(enter("- a\n- |").as_deref(), Some("- a\n\n- |"));
        assert_eq!(enter("- a\n\n- |").as_deref(), Some("- a\n\n|"), "after a blank line it ends");
        // Nested: the item moves out a level and takes the outer marker,
        // counting on in a numbered outer list.
        assert_eq!(enter("- a\n  - |").as_deref(), Some("- a\n- |"));
        assert_eq!(enter("- a\n  - b\n  - c\n  - |").as_deref(), Some("- a\n  - b\n  - c\n- |"));
        assert_eq!(enter("1. a\n   - b\n   - c\n   - |\n2. d").as_deref(), Some("1. a\n   - b\n   - c\n2. |\n3. d"));
        assert_eq!(enter("1. a\n   1. |").as_deref(), Some("1. a\n2. |"));
        // A nested second item goes loose first, as at the top level.
        assert_eq!(enter("- a\n  - b\n  - |").as_deref(), Some("- a\n  - b\n \n  - |"));
        // In a quote the list ends and the quote stays.
        assert_eq!(enter("> - a\n> - b\n> - |").as_deref(), Some("> - a\n> - b\n> |"));
        // An empty numbered item: the items after it count down.
        assert_eq!(enter("1. a\n2. b\n3. |\n4. d").as_deref(), Some("1. a\n2. b\n|\n3. d"));
    }

    #[test]
    fn enter_in_a_loose_list_keeps_it_loose() {
        assert_eq!(enter("- a\n\n- b|").as_deref(), Some("- a\n\n- b\n\n- |"));
        assert_eq!(enter("- a\n- b|").as_deref(), Some("- a\n- b\n- |"), "a tight list stays tight");
    }

    #[test]
    fn enter_on_a_continuation_line_keeps_the_items_indent() {
        assert_eq!(enter("- a\n\n  more|").as_deref(), Some("- a\n\n  more\n  |"));
        assert_eq!(enter("- a\n  more|").as_deref(), Some("- a\n  more\n  |"));
    }

    #[test]
    fn list_markers_inside_fenced_code_do_not_continue() {
        assert_eq!(enter("```\n- not a list|\n```"), None);
        assert_eq!(enter("- item\n  ```\n  - code|\n  ```"), None);
        assert_eq!(enter("~~~md\n> quote|\n~~~\n"), None);
        assert_eq!(back("```\n- |\n```"), None);
    }

    #[test]
    fn the_end_of_the_document() {
        assert_eq!(enter("- a\n- b|").as_deref(), Some("- a\n- b\n- |"));
        assert_eq!(enter("intro\n\n1. a|").as_deref(), Some("intro\n\n1. a\n2. |"));
        assert_eq!(back("- a\n- |").as_deref(), Some("- a\n  |"));
    }

    #[test]
    fn crlf_documents_get_crlf() {
        assert_eq!(enter("- a|\r\n- b\r\n").as_deref(), Some("- a\r\n- |\r\n- b\r\n"));
        assert_eq!(enter("- a\r\n- b|").as_deref(), Some("- a\r\n- b\r\n- |"), "the last line takes the line above's break");
        assert_eq!(enter("1. a|\r\n2. b").as_deref(), Some("1. a\r\n2. |\r\n3. b"));
        assert_eq!(enter("- a\r\n- b\r\n- |\r\n").as_deref(), Some("- a\r\n- b\r\n|\r\n"));
        assert_eq!(enter("> a\r\n>\r\n> |").as_deref(), Some("> a\r\n\r\n|"));
        assert_eq!(back("- a\r\n- |\r\n").as_deref(), Some("- a\r\n  |\r\n"));
    }

    #[test]
    fn backspace_removes_one_level_of_markup() {
        assert_eq!(back("- |").as_deref(), Some("|"), "the first item's marker goes");
        assert_eq!(back("- a\n- |").as_deref(), Some("- a\n  |"), "a later item's marker becomes spaces");
        assert_eq!(back("- a\n  |").as_deref(), Some("- a\n|"), "then the spaces go");
        assert_eq!(back("> |").as_deref(), Some("|"));
        assert_eq!(back("> - |").as_deref(), Some("> |"));
        assert_eq!(back("1. |").as_deref(), Some("|"));
        assert_eq!(back("- [ ] |").as_deref(), Some("|"));
        assert_eq!(back("-   |").as_deref(), Some("- |"), "extra space after the marker goes first");
        assert_eq!(back("- a\n  - |").as_deref(), Some("- a\n  |"));
    }

    #[test]
    fn backspace_elsewhere_is_left_to_the_editor() {
        assert_eq!(back("- a|"), None);
        assert_eq!(back("-|"), None);
        assert_eq!(back("plain |"), None);
        assert_eq!(back("|"), None);
        assert_eq!(back("- [ab]"), None, "a selection deletes as usual");
    }

    #[test]
    fn a_pasted_url_over_plain_text_makes_a_link() {
        let paste = |input: &str, clip: &str| {
            let (text, sel) = marked(input);
            paste_url_link(&text, sel, clip).map(|e| show(&apply(&text, &e), &e.select))
        };
        assert_eq!(paste("see [the docs] here", "https://example.com/a").as_deref(), Some("see [«the docs»](https://example.com/a) here"));
        assert_eq!(paste("[word]", "www.example.org").as_deref(), Some("[«word»](https://www.example.org)"));
        assert_eq!(paste("[mail me]", "mailto:someone@example.com").as_deref(), Some("[«mail me»](mailto:someone@example.com)"));
        assert_eq!(paste("- [item text]", "http://example.net").as_deref(), Some("- [«item text»](http://example.net)"));
        assert_eq!(paste("# [Title]", "https://example.com").as_deref(), Some("# [«Title»](https://example.com)"));
        // Not a URL, nothing selected, or not plain text: an ordinary paste.
        assert_eq!(paste("[word]", "just words"), None);
        assert_eq!(paste("wo|rd", "https://example.com"), None);
        assert_eq!(paste("a `[code]` b", "https://example.com"), None);
        assert_eq!(paste("```\n[code]\n```", "https://example.com"), None);
        assert_eq!(paste("[one\n\ntwo]", "https://example.com"), None, "across two paragraphs");
        assert_eq!(paste("x *[em]* y", "https://example.com"), None, "touching emphasis marks");
        assert_eq!(paste("[- item]", "https://example.com"), None, "over a list marker");
    }

    #[test]
    fn a_long_document_parses_from_a_safe_start() {
        let filler = "Some words in a paragraph.\n\n".repeat(WHOLE_PARSE / 20);
        let text = format!("{filler}```\n- in code\n\n- still code\n```\n\nIntro line\n- a\n- b");
        let w = window(&text, text.len());
        assert!(w.start > filler.len(), "starts after the fence, at the last top-level block");
        assert_eq!(&text[w.start..w.start + 5], "Intro");
        let (t, sel) = (text.clone(), text.len()..text.len());
        let e = continue_markup(&t, sel).unwrap();
        assert!(apply(&t, &e).ends_with("- a\n- b\n- "));
        let inside = text.find("- still code").unwrap() + 12;
        assert_eq!(continue_markup(&text, inside..inside), None, "inside the fence, still code");
    }
}

