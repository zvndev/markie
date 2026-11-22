//! Spell check in View mode, through the macOS spell checker, as Chromium
//! does it for Electron's contenteditable editor: misspelled words get a
//! red dotted underline, and the word being typed is left alone until the
//! caret leaves it. Code blocks are checked too, as Chromium checks every
//! editable text; the inline formula field is not (`spellcheck = false`). Electron Markie has no context menu, so there are no
//! suggestions to offer. Source mode is CodeMirror, which turns spell check
//! off, and so does Markie RS.
//!
//! Checks run off the keystroke: a leaf whose text is not in the cache is
//! queued, and the queue is drained a little later in one batch.

use std::collections::{HashMap, HashSet};
use std::ops::Range;

/// Misspelled ranges, in characters, by leaf text.
#[derive(Default)]
pub struct SpellCache {
    known: HashMap<String, Vec<Range<usize>>>,
    queued: HashSet<String>,
    pub scheduled: bool,
}

const MAX_ENTRIES: usize = 4096;

impl SpellCache {
    /// The misspelled ranges of `text`, minus the word touching `caret`;
    /// `None` when the text still has to be checked (it is queued).
    pub fn ranges(&mut self, text: &str, caret: Option<usize>) -> Option<Vec<Range<usize>>> {
        if text.trim().is_empty() {
            return Some(vec![]);
        }
        match self.known.get(text) {
            Some(r) => Some(
                r.iter()
                    .filter(|r| caret.is_none_or(|c| c < r.start || c > r.end))
                    .cloned()
                    .collect(),
            ),
            None => {
                self.queued.insert(text.to_string());
                None
            }
        }
    }

    pub fn has_queue(&self) -> bool {
        !self.queued.is_empty()
    }

    /// Check what is queued. Returns whether anything new was learned.
    pub fn drain(&mut self) -> bool {
        if self.queued.is_empty() {
            return false;
        }
        if self.known.len() > MAX_ENTRIES {
            self.known.clear();
        }
        for text in std::mem::take(&mut self.queued) {
            let r = check(&text);
            self.known.insert(text, r);
        }
        true
    }
}

/// UTF-16 offsets (what the platform checker reports) to char offsets.
pub fn utf16_to_chars(s: &str, r: Range<usize>) -> Range<usize> {
    let mut u = 0;
    let (mut a, mut b) = (None, None);
    for (i, c) in s.chars().enumerate() {
        if a.is_none() && u >= r.start {
            a = Some(i);
        }
        if b.is_none() && u >= r.end {
            b = Some(i);
        }
        u += c.len_utf16();
    }
    let n = s.chars().count();
    a.unwrap_or(n)..b.unwrap_or(n)
}

/// Is the range inside a web or mail address (a space-separated token with
/// `://`, `www.` or `@`), or an atom? Those are never marked.
fn in_address(text: &str, r: &Range<usize>) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut a = r.start.min(chars.len());
    while a > 0 && !chars[a - 1].is_whitespace() {
        a -= 1;
    }
    let mut b = r.end.min(chars.len());
    while b < chars.len() && !chars[b].is_whitespace() {
        b += 1;
    }
    let token: String = chars[a..b].iter().collect();
    token.contains("://") || token.starts_with("www.") || token.contains('@') || token.contains('\u{fffc}')
}

#[cfg(target_os = "macos")]
pub fn check(text: &str) -> Vec<Range<usize>> {
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::NSString;

    let checker = NSSpellChecker::sharedSpellChecker();
    let ns = NSString::from_str(text);
    let lang = checker.language();
    let len16 = text.encode_utf16().count();
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < len16 {
        // An explicit language, as Chromium passes one: left to guess, the
        // checker reads some English words as another language's.
        let mut words: isize = 0;
        let r = unsafe {
            checker.checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(&ns, at as isize, Some(&lang), false, 0, &mut words)
        };
        if r.location >= isize::MAX as usize || r.length == 0 || r.location < at {
            break;
        }
        let chars = utf16_to_chars(text, r.location..r.location + r.length);
        if !in_address(text, &chars) {
            out.push(chars);
        }
        at = r.location + r.length;
    }
    out
}

#[cfg(not(target_os = "macos"))]
pub fn check(_text: &str) -> Vec<Range<usize>> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets() {
        assert_eq!(utf16_to_chars("a🎉bc", 3..5), 2..4);
        assert_eq!(utf16_to_chars("abc", 0..3), 0..3);
    }

    #[test]
    fn cache_queues_then_answers_and_spares_the_typed_word() {
        let mut c = SpellCache::default();
        c.known.insert("teh cat".into(), vec![0..3]);
        assert_eq!(c.ranges("teh cat", None), Some(vec![0..3]));
        assert_eq!(c.ranges("teh cat", Some(3)), Some(vec![]));
        assert_eq!(c.ranges("new text", None), None);
        assert!(c.has_queue());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_checker_finds_a_misspelling() {
        let r = check("This sentense has one mistake.");
        assert!(r.contains(&(5..13)), "{r:?}");
        assert!(check("https://example.com/xqzt").is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn code_block_text_is_checked_across_its_lines() {
        let code = "// the recieved value\nlet total = 1;";
        let r = check(code);
        assert!(r.contains(&(7..15)), "{r:?}");
    }
}
