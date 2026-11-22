//! Document statistics: a line for line port of `src/lib/stats.ts`, counting
//! as JavaScript counts (UTF-16 lengths, `\s`, multiline `^`).

use std::sync::LazyLock;

use regex::Regex;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DocStats {
    pub words: usize,
    pub chars: usize,
    pub chars_no_spaces: usize,
    pub lines: usize,
    pub headings: usize,
    pub code_blocks: usize,
    pub links: usize,
    pub reading_minutes: usize,
}

/// JavaScript's `\s`.
pub fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// The starts of lines as a multiline `^` sees them: after `\n`, `\r`,
/// U+2028 and U+2029.
fn js_lines(s: &str) -> impl Iterator<Item = &str> {
    s.split(['\n', '\r', '\u{2028}', '\u{2029}'])
}

pub fn compute(content: &str) -> DocStats {
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]\([^)]+\)").unwrap());
    let trimmed = content.trim_matches(is_js_space);
    let words = if trimmed.is_empty() { 0 } else { trimmed.split(is_js_space).filter(|w| !w.is_empty()).count() };
    let utf16 = |s: &str| s.encode_utf16().count();
    DocStats {
        words,
        chars: utf16(content),
        chars_no_spaces: content.chars().filter(|c| !is_js_space(*c)).map(char::len_utf16).sum(),
        lines: if content.is_empty() { 0 } else { content.split('\n').count() },
        // `/^#{1,6}\s/gm`: one to six hashes, then any white space, a line
        // break included.
        headings: {
            let mut n = 0;
            let mut rest = content;
            loop {
                let line_end = rest.find(['\n', '\r', '\u{2028}', '\u{2029}']);
                let hashes = rest.chars().take_while(|c| *c == '#').count();
                if (1..=6).contains(&hashes) && rest[hashes..].chars().next().is_some_and(is_js_space) {
                    n += 1;
                }
                match line_end {
                    Some(i) => rest = &rest[i + rest[i..].chars().next().map_or(1, char::len_utf8)..],
                    None => break,
                }
            }
            n
        },
        code_blocks: js_lines(content).filter(|l| l.starts_with("```")).count() / 2,
        links: LINK.find_iter(content).count(),
        reading_minutes: if words == 0 { 0 } else { ((words as f64 / 200.0).round() as usize).max(1) },
    }
}

/// `toLocaleString()` in en-US: `1,234,567`.
pub fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn counts() {
        let s = super::compute("# Title\n\nSome words here.\n## Two");
        assert_eq!((s.words, s.lines, s.headings, s.reading_minutes), (7, 4, 2, 1));
        assert_eq!(super::compute("").lines, 0);
        assert_eq!(super::grouped(1234567), "1,234,567");
        assert_eq!(super::grouped(999), "999");
    }
}
