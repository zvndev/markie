//! Math spans found the way remark-math with `remark-strict-math.ts` finds
//! them, so a document's dollars pair exactly as they do in Electron.
//!
//! pulldown-cmark's own math pairs dollars by GitHub's rule, which differs
//! from Pandoc's rule that Markie uses ("She paid $3.50 for $E=mc^2$" pairs
//! differently). So math is found here, over the source of each inline
//! container (paragraph, heading, table cell) pulldown reports, and each span
//! is swapped for a placeholder that pulldown passes through as plain text.
//! Within a container the scan is micromark's, left to right: a backslash
//! escape, a code span or an HTML tag is skipped whole, and a run of dollars
//! tries to open math.
//!
//! The strict rule (Pandoc's), for a single dollar: the opener is followed by
//! something other than whitespace; the closer follows something other than
//! whitespace and is not followed by a digit. `$$` runs pair with any run of
//! the same length. An opener with no closer before the end of the container
//! is a literal dollar.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// Brackets a placeholder's index. A plane-16 private-use character no
/// keyboard types; a document that already holds one skips the pre-pass.
pub const MARK: char = '\u{10FFFD}';

#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub tex: String,
    /// `$$` opened on a line of its own and closed on one: remark's flow math.
    pub flow: bool,
}

/// The source with math swapped for placeholders, and the math in order.
pub fn extract(source: &str, options: Options) -> Option<(String, Vec<Span>)> {
    if source.contains(MARK) || !source.contains('$') {
        return None;
    }
    // Inline containers, outermost first, with whether they sit in a quote or list.
    let mut ranges: Vec<(std::ops::Range<usize>, bool)> = Vec::new();
    let mut nest = 0usize;
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        match event {
            Event::Start(Tag::BlockQuote(_)) | Event::Start(Tag::Item) => nest += 1,
            Event::End(TagEnd::BlockQuote(_)) | Event::End(TagEnd::Item) => nest = nest.saturating_sub(1),
            Event::Start(Tag::Paragraph) | Event::Start(Tag::Heading { .. }) | Event::Start(Tag::TableCell) => {
                ranges.push((range, nest > 0));
            }
            _ => {}
        }
    }
    let mut out = String::with_capacity(source.len());
    let mut spans = Vec::new();
    let mut at = 0;
    for (range, nested) in ranges {
        if range.start < at {
            continue;
        }
        let slice = &source[range.clone()];
        for (start, end, open) in scan(slice) {
            let abs_start = range.start + start;
            let abs_end = range.start + end;
            let inner = &slice[start + open..end - open];
            let mut tex = strip_padding(inner);
            if nested && tex.contains('\n') {
                tex = tex.lines().map(strip_container_prefix).collect::<Vec<_>>().join("\n");
            }
            let flow = open >= 2 && is_flow(source, abs_start, abs_end, open);
            if flow {
                tex = inner.trim_matches(|c| c == '\n' || c == '\r').to_string();
                if nested {
                    tex = tex.lines().map(strip_container_prefix).collect::<Vec<_>>().join("\n");
                }
            }
            out.push_str(&source[at..abs_start]);
            out.push(MARK);
            out.push_str(&spans.len().to_string());
            out.push(MARK);
            spans.push(Span { tex, flow });
            at = abs_end;
        }
    }
    out.push_str(&source[at..]);
    Some((out, spans))
}

/// `$$` alone on the line it opens, and alone on the line it closes.
fn is_flow(source: &str, start: usize, end: usize, open: usize) -> bool {
    let line_start = source[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let before = &source[line_start..start];
    let after_open = &source[start + open..];
    let opens_line = before.trim_start_matches([' ', '>']).trim().is_empty() && after_open.starts_with(['\n', '\r']);
    let close_at = end - open;
    let close_line_start = source[..close_at].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let close_before = &source[close_line_start..close_at];
    let rest = source[end..].split('\n').next().unwrap_or("");
    opens_line && close_before.trim_start_matches([' ', '>']).trim().is_empty() && rest.trim().is_empty()
}

fn strip_container_prefix(line: &str) -> &str {
    let t = line.trim_start();
    let t = t.strip_prefix('>').map(|r| r.strip_prefix(' ').unwrap_or(r)).unwrap_or(t);
    t
}

/// micromark-extension-math, like code spans: one space or line ending is
/// dropped from each side when both sides have one and the text is not all
/// spaces.
fn strip_padding(inner: &str) -> String {
    let pad = |c: char| c == ' ' || c == '\n' || c == '\r';
    let first = inner.chars().next();
    let last = inner.chars().next_back();
    if inner.chars().count() >= 2 && first.is_some_and(pad) && last.is_some_and(pad) && !inner.chars().all(pad) {
        let a = first.unwrap().len_utf8();
        let b = last.unwrap().len_utf8();
        return inner[a..inner.len() - b].to_string();
    }
    inner.to_string()
}

fn is_ws(c: Option<char>) -> bool {
    c.is_none_or(|c| c == ' ' || c == '\t' || c == '\n' || c == '\r')
}

/// The math spans in one container's source: (start, end, dollar count).
pub fn scan(text: &str) -> Vec<(usize, usize, usize)> {
    let b = text.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    // A single-dollar opener that found no closer scanned to the end; later
    // single-dollar openers fail the same way (remark-strict-math's memo).
    let mut single_failed = false;
    while i < b.len() {
        match b[i] {
            b'\\' if i + 1 < b.len() && (b[i + 1] as char).is_ascii_punctuation() => i += 2,
            b'`' => {
                let n = run(b, i, b'`');
                match find_run(b, i + n, b'`', n) {
                    Some(close) => i = close + n,
                    None => i += n,
                }
            }
            b'<' => i = skip_tag(text, i).unwrap_or(i + 1),
            b'$' => {
                let n = run(b, i, b'$');
                let next = text[i + n..].chars().next();
                if n == 1 && (is_ws(next) || single_failed) {
                    i += n;
                    continue;
                }
                match find_closer(text, i + n, n) {
                    Some(close) => {
                        found.push((i, close + n, n));
                        i = close + n;
                    }
                    None => {
                        if n == 1 {
                            single_failed = true;
                        }
                        i += n;
                    }
                }
            }
            _ => i += 1,
        }
    }
    found
}

fn run(b: &[u8], at: usize, c: u8) -> usize {
    b[at..].iter().take_while(|&&x| x == c).count()
}

fn find_run(b: &[u8], from: usize, c: u8, n: usize) -> Option<usize> {
    let mut i = from;
    while i < b.len() {
        if b[i] == c {
            let m = run(b, i, c);
            if m == n {
                return Some(i);
            }
            i += m;
        } else {
            i += 1;
        }
    }
    None
}

fn find_closer(text: &str, from: usize, n: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut i = from;
    while i < b.len() {
        if b[i] != b'$' {
            i += 1;
            continue;
        }
        let m = run(b, i, b'$');
        if m == n {
            if n > 1 {
                return Some(i);
            }
            let before = text[..i].chars().next_back();
            let after = text[i + m..].chars().next();
            // The data before the run must not be empty either: `$$` with n=1 is two runs.
            if i > from && !is_ws(before) && !after.is_some_and(|c| c.is_ascii_digit()) {
                return Some(i);
            }
        }
        i += m;
    }
    None
}

/// An autolink or HTML tag at `at`, as micromark's html-text and autolink
/// constructs read them, returning the index after it.
fn skip_tag(text: &str, at: usize) -> Option<usize> {
    let rest = &text[at + 1..];
    let first = rest.chars().next()?;
    if !(first.is_ascii_alphabetic() || first == '/' || first == '!' || first == '?') {
        return None;
    }
    if let Some(stripped) = rest.strip_prefix("!--") {
        return stripped.find("-->").map(|e| at + 1 + 3 + e + 3);
    }
    let end = rest.find(['>', '<', '\n']).filter(|&e| rest.as_bytes()[e] == b'>')?;
    Some(at + 1 + end + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(s: &str) -> Vec<&str> {
        scan(s).into_iter().map(|(a, b, n)| &s[a + n..b - n]).collect()
    }

    #[test]
    fn pandoc_rule() {
        assert_eq!(spans("A price of $5 and $10 stay text"), Vec::<&str>::new());
        assert_eq!(spans("$x^2$ is math and $$a+b$$ too"), ["x^2", "a+b"]);
        // The pairing Electron does: the opener `$3` closes at `mc^2$`.
        assert_eq!(spans("She paid $3.50 for $E=mc^2$."), ["3.50 for $E=mc^2"]);
        assert_eq!(spans("costs $ 5 and $6"), Vec::<&str>::new());
        assert_eq!(spans("`$x$` and \\$y$ and <span title=\"$z$\">"), Vec::<&str>::new());
    }

    #[test]
    fn extract_marks_flow_math() {
        let (out, found) = extract("Para $x$.\n\n$$\n\\frac12\n$$\n", Options::empty()).unwrap();
        assert_eq!(found, [Span { tex: "x".into(), flow: false }, Span { tex: "\\frac12".into(), flow: true }]);
        assert!(out.contains(&format!("{MARK}0{MARK}")) && out.contains(&format!("{MARK}1{MARK}")));
    }
}
