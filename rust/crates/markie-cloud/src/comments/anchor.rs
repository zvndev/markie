//! Text-quote anchors for comments on local documents. A port of
//! electron/text-anchor.mjs, offset for offset.
//!
//! A comment on a local file remembers the text it points at (`exact`), a
//! few characters on either side (`prefix`, `suffix`) and where it was last
//! seen (`start`, a hint). Offsets are JavaScript string offsets (UTF-16
//! code units), because the same `comments.json` is read and written by the
//! Electron app and the Markie MCP.
use serde::{Deserialize, Serialize};

/// How many characters of context an anchor keeps on each side.
pub const CONTEXT_CHARS: usize = 32;
/// The longest quote an anchor will hold.
pub const MAX_QUOTE_CHARS: usize = 2000;
const MAX_CANDIDATES: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextAnchor {
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
    pub start: usize,
}

/// A range in UTF-16 units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// A slice of UTF-16 units back to a string. JavaScript keeps a lone
/// surrogate where a slice cuts a pair; Rust strings cannot, so the slice
/// widens to keep the pair whole.
fn slice(u: &[u16], mut a: usize, mut b: usize) -> String {
    a = a.min(u.len());
    b = b.min(u.len()).max(a);
    if a > 0 && a < u.len() && (0xdc00..=0xdfff).contains(&u[a]) {
        a -= 1;
    }
    if b > 0 && b < u.len() && (0xdc00..=0xdfff).contains(&u[b]) {
        b += 1;
    }
    String::from_utf16_lossy(&u[a..b])
}

/// JavaScript's `\s`.
pub fn is_js_space(c: u16) -> bool {
    matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

/// JavaScript's `\w`.
pub fn is_js_word(c: u16) -> bool {
    matches!(c, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f)
}

/// The anchor for `text[start..end]` in UTF-16 units, or None when the range
/// is empty, out of bounds or too long.
pub fn make_anchor(text: &str, start: usize, end: usize) -> Option<TextAnchor> {
    let u = utf16(text);
    if end > u.len() || end <= start || end - start > MAX_QUOTE_CHARS {
        return None;
    }
    Some(TextAnchor {
        exact: slice(&u, start, end),
        prefix: slice(&u, start.saturating_sub(CONTEXT_CHARS), start),
        suffix: slice(&u, end, end + CONTEXT_CHARS),
        start,
    })
}

fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

fn exact_hits(text: &[u16], needle: &[u16]) -> Vec<TextRange> {
    let mut hits = Vec::new();
    let mut at = index_of(text, needle, 0);
    while let Some(i) = at {
        if hits.len() >= MAX_CANDIDATES {
            break;
        }
        hits.push(TextRange { start: i, end: i + needle.len() });
        at = index_of(text, needle, i + 1);
    }
    hits
}

/// Whitespace collapsed to single spaces, with a map back to where each
/// character came from.
fn collapse(text: &[u16]) -> (Vec<u16>, Vec<usize>) {
    let mut out = Vec::new();
    let mut map = Vec::new();
    let mut in_space = false;
    for (i, &c) in text.iter().enumerate() {
        if is_js_space(c) {
            if !in_space {
                out.push(0x20);
                map.push(i);
                in_space = true;
            }
        } else {
            out.push(c);
            map.push(i);
            in_space = false;
        }
    }
    (out, map)
}

fn trim(u: &[u16]) -> &[u16] {
    let a = u.iter().position(|c| !is_js_space(*c)).unwrap_or(u.len());
    let b = u.iter().rposition(|c| !is_js_space(*c)).map(|i| i + 1).unwrap_or(a);
    &u[a..b.max(a)]
}

/// Where `needle` appears in `text`: exactly if it does, otherwise ignoring
/// differences in whitespace. Ranges are in `text`'s own UTF-16 offsets.
pub fn find_all(text: &str, needle: &str) -> Vec<TextRange> {
    find_all_u(&utf16(text), &utf16(needle))
}

fn find_all_u(text: &[u16], needle: &[u16]) -> Vec<TextRange> {
    if needle.is_empty() {
        return vec![];
    }
    let exact = exact_hits(text, needle);
    if !exact.is_empty() {
        return exact;
    }
    let (squeezed, _) = collapse(trim(needle));
    if trim(&squeezed).is_empty() {
        return vec![];
    }
    let (hay, map) = collapse(text);
    exact_hits(&hay, &squeezed).into_iter().map(|h| TextRange { start: map[h.start], end: map[h.end - 1] + 1 }).collect()
}

fn agree_before(text: &[u16], at: usize, want: &[u16]) -> usize {
    let mut n = 0;
    while n < want.len() && at >= n + 1 && text[at - n - 1] == want[want.len() - n - 1] {
        n += 1;
    }
    n
}

fn agree_after(text: &[u16], at: usize, want: &[u16]) -> usize {
    let mut n = 0;
    while n < want.len() && at + n < text.len() && text[at + n] == want[n] {
        n += 1;
    }
    n
}

/// Find an anchor's text in the document as it is now. Among several
/// occurrences, the one whose surroundings best match the remembered prefix
/// and suffix wins, then the one nearest where it was last seen. None means
/// the quote is gone: the comment is detached.
pub fn resolve_anchor(text: &str, anchor: &TextAnchor) -> Option<TextRange> {
    if anchor.exact.is_empty() {
        return None;
    }
    let t = utf16(text);
    let hits = find_all_u(&t, &utf16(&anchor.exact));
    match hits.len() {
        0 => return None,
        1 => return Some(hits[0]),
        _ => {}
    }
    let prefix = utf16(&anchor.prefix);
    let suffix = utf16(&anchor.suffix);
    let mut best = hits[0];
    let mut best_score: isize = -1;
    let mut best_distance = usize::MAX;
    for h in hits {
        let score = (agree_before(&t, h.start, &prefix) + agree_after(&t, h.end, &suffix)) as isize;
        let distance = h.start.abs_diff(anchor.start);
        if score > best_score || (score == best_score && distance < best_distance) {
            best = h;
            best_score = score;
            best_distance = distance;
        }
    }
    Some(best)
}

/// Where an agent's quote points, for a new comment. Never guesses: a quote
/// that appears more than once needs `occurrence` (1-based) or a narrowing
/// prefix or suffix. The error strings are the MCP's.
pub fn locate_quote(text: &str, quote: &str, occurrence: Option<i64>, prefix: Option<&str>, suffix: Option<&str>) -> Result<TextRange, (String, usize)> {
    let q = utf16(quote);
    if trim(&q).is_empty() {
        return Err(("quote is required: the exact text the comment is about.".into(), 0));
    }
    if q.len() > MAX_QUOTE_CHARS {
        return Err((format!("quote is too long. Quote at most {MAX_QUOTE_CHARS} characters."), 0));
    }
    let t = utf16(text);
    let mut hits = find_all_u(&t, &q);
    if hits.is_empty() {
        return Err(("That quote is not in the document. Quote the text exactly as it appears in the file.".into(), 0));
    }
    let narrowed = prefix.is_some_and(|p| !trim(&utf16(p)).is_empty()) || suffix.is_some_and(|s| !trim(&utf16(s)).is_empty());
    if let Some(p) = prefix.map(utf16).filter(|p| !trim(p).is_empty()) {
        let (want, _) = collapse(trim(&p));
        hits.retain(|h| {
            let from = h.start.saturating_sub(want.len() * 4 + 16);
            let (before, _) = collapse(&t[from..h.start]);
            let end = before.iter().rposition(|c| !is_js_space(*c)).map(|i| i + 1).unwrap_or(0);
            before[..end].ends_with(&want)
        });
    }
    if let Some(s) = suffix.map(utf16).filter(|s| !trim(s).is_empty()) {
        let (want, _) = collapse(trim(&s));
        hits.retain(|h| {
            let to = (h.end + want.len() * 4 + 16).min(t.len());
            let (after, _) = collapse(&t[h.end..to]);
            let start = after.iter().position(|c| !is_js_space(*c)).unwrap_or(after.len());
            after[start..].starts_with(&want)
        });
    }
    if hits.is_empty() {
        return Err(("The quote is in the document, but not with that prefix or suffix around it.".into(), 0));
    }
    if let Some(n) = occurrence {
        if n < 1 || n as usize > hits.len() {
            let c = hits.len();
            return Err((
                format!(
                    "occurrence must be between 1 and {c}: the quote appears {c} time{}{}.",
                    if c == 1 { "" } else { "s" },
                    if narrowed { " with that prefix or suffix" } else { "" }
                ),
                c,
            ));
        }
        return Ok(hits[n as usize - 1]);
    }
    if hits.len() > 1 {
        let c = hits.len();
        return Err((format!("The quote appears {c} times. Pass occurrence (1 to {c}, counted from the top), or a prefix or suffix, to say which one."), c));
    }
    Ok(hits[0])
}

/// A well-formed anchor this module can resolve.
pub fn is_anchor(a: &TextAnchor) -> bool {
    let len = |s: &str| s.encode_utf16().count();
    !a.exact.is_empty() && len(&a.exact) <= MAX_QUOTE_CHARS && len(&a.prefix) <= CONTEXT_CHARS * 4 && len(&a.suffix) <= CONTEXT_CHARS * 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_keep_context_and_resolve_after_edits() {
        let text = "The quick brown fox jumps over the lazy dog. The quick cat.";
        let a = make_anchor(text, 4, 9).unwrap();
        assert_eq!(a.exact, "quick");
        assert_eq!(a.prefix, "The ");
        assert_eq!(a.suffix, " brown fox jumps over the lazy d");
        assert_eq!(resolve_anchor(text, &a), Some(TextRange { start: 4, end: 9 }));
        // An edit above it moves it; the prefix and suffix pick the right "quick".
        let edited = format!("Intro line.\n{text}");
        assert_eq!(resolve_anchor(&edited, &a), Some(TextRange { start: 16, end: 21 }));
        // Rewrapped text still matches, whitespace collapsed.
        let a2 = make_anchor(text, 4, 19).unwrap();
        let wrapped = text.replace("brown ", "brown\n");
        let r = resolve_anchor(&wrapped, &a2).unwrap();
        assert_eq!(&wrapped[r.start..r.end], "quick brown\nfox");
        assert_eq!(resolve_anchor("gone", &a), None);
    }

    #[test]
    fn offsets_are_utf16() {
        let text = "😀 café quick";
        let a = make_anchor(text, 8, 13).unwrap();
        assert_eq!(a.exact, "quick");
        assert_eq!(a.prefix, "😀 café ");
        assert_eq!(resolve_anchor(text, &a), Some(TextRange { start: 8, end: 13 }));
    }

    #[test]
    fn quotes_are_located_without_guessing() {
        let text = "alpha beta\nalpha gamma";
        assert!(locate_quote(text, "alpha", None, None, None).unwrap_err().0.contains("appears 2 times"));
        assert_eq!(locate_quote(text, "alpha", Some(2), None, None), Ok(TextRange { start: 11, end: 16 }));
        assert_eq!(locate_quote(text, "alpha", None, None, Some("gamma")), Ok(TextRange { start: 11, end: 16 }));
        assert!(locate_quote(text, "alpha", Some(3), None, None).unwrap_err().0.starts_with("occurrence must be between 1 and 2"));
        assert!(locate_quote(text, "zeta", None, None, None).unwrap_err().0.starts_with("That quote is not"));
        assert!(locate_quote(text, "  ", None, None, None).unwrap_err().0.starts_with("quote is required"));
    }
}
