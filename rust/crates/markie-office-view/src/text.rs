//! Caret arithmetic on paragraph text. The engine measures offsets in UTF-8
//! bytes; the platform text services (IME, accessibility) speak UTF-16 code
//! units. Every conversion here lands on a character boundary, and caret moves
//! land on the engine's grapheme boundaries.

use markie_office::docx::grapheme_boundary;

/// The UTF-16 length of `text`.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// UTF-8 byte offset to UTF-16 code units. Offsets past the end clamp.
pub fn utf8_to_utf16(text: &str, offset: usize) -> usize {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        if index >= offset {
            break;
        }
        units += ch.len_utf16();
    }
    units
}

/// UTF-16 code units to a UTF-8 byte offset. A unit inside a surrogate pair
/// snaps back to the start of that character; units past the end clamp.
pub fn utf16_to_utf8(text: &str, units: usize) -> usize {
    let mut seen = 0;
    for (index, ch) in text.char_indices() {
        let next = seen + ch.len_utf16();
        if next > units {
            return index;
        }
        seen = next;
    }
    text.len()
}

pub fn utf16_range_to_utf8(text: &str, range: std::ops::Range<usize>) -> std::ops::Range<usize> {
    let start = utf16_to_utf8(text, range.start);
    let end = utf16_to_utf8(text, range.end.max(range.start));
    start..end
}

pub fn utf8_range_to_utf16(text: &str, range: std::ops::Range<usize>) -> std::ops::Range<usize> {
    utf8_to_utf16(text, range.start)..utf8_to_utf16(text, range.end)
}

/// The nearest grapheme boundary at or before `offset`.
pub fn snap_back(text: &str, offset: usize) -> usize {
    let mut at = offset.min(text.len());
    while at > 0 && !grapheme_boundary(text, at) {
        at -= 1;
    }
    at
}

/// The grapheme boundary before `offset` (0 at the start).
pub fn prev_boundary(text: &str, offset: usize) -> usize {
    let offset = snap_back(text, offset);
    if offset == 0 {
        return 0;
    }
    snap_back(text, offset - 1)
}

/// The grapheme boundary after `offset` (the end at the end).
pub fn next_boundary(text: &str, offset: usize) -> usize {
    let mut at = snap_back(text, offset);
    if at >= text.len() {
        return text.len();
    }
    at += 1;
    while at < text.len() && !grapheme_boundary(text, at) {
        at += 1;
    }
    at
}

fn is_word(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '\''
}

/// Option-Left: back over spaces, then back over one word.
pub fn prev_word(text: &str, offset: usize) -> usize {
    let mut at = snap_back(text, offset);
    while at > 0 && !text[..at].chars().next_back().is_some_and(is_word) {
        at = prev_boundary(text, at);
    }
    while at > 0 && text[..at].chars().next_back().is_some_and(is_word) {
        at = prev_boundary(text, at);
    }
    at
}

/// Option-Right: forward over spaces, then over one word.
pub fn next_word(text: &str, offset: usize) -> usize {
    let mut at = snap_back(text, offset);
    while at < text.len() && !text[at..].chars().next().is_some_and(is_word) {
        at = next_boundary(text, at);
    }
    while at < text.len() && text[at..].chars().next().is_some_and(is_word) {
        at = next_boundary(text, at);
    }
    at
}

/// The word around `offset`, for a double click.
pub fn word_at(text: &str, offset: usize) -> std::ops::Range<usize> {
    let offset = snap_back(text, offset);
    let at_word = text[offset..].chars().next().is_some_and(is_word) || text[..offset].chars().next_back().is_some_and(is_word);
    if !at_word {
        return offset..next_boundary(text, offset);
    }
    let mut start = offset;
    while start > 0 && text[..start].chars().next_back().is_some_and(is_word) {
        start = prev_boundary(text, start);
    }
    let mut end = offset;
    while end < text.len() && text[end..].chars().next().is_some_and(is_word) {
        end = next_boundary(text, end);
    }
    start..end
}

/// Style segments `(length, style)` of a text, after `start..end` is
/// replaced by `insert` bytes of marked text. The marked text takes the style
/// of the segment it starts in (or the one before it at a boundary), and is
/// flagged `true`.
pub fn splice_segments<S: Copy>(segments: &[(usize, S)], start: usize, end: usize, insert: usize) -> Vec<(usize, S, bool)> {
    let mut out = Vec::new();
    let mut at = 0;
    let mut inserted = false;
    for &(len, style) in segments {
        let (from, to) = (at, at + len);
        at = to;
        let head_end = start.clamp(from, to);
        if head_end > from {
            out.push((head_end - from, style, false));
        }
        if !inserted && start >= from && start < to {
            out.push((insert, style, true));
            inserted = true;
        }
        let tail_start = end.clamp(from, to);
        if tail_start < to && tail_start >= start {
            out.push((to - tail_start, style, false));
        }
    }
    if !inserted && let Some(&(_, style)) = segments.last() {
        out.push((insert, style, true));
    }
    out.retain(|s| s.0 > 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_round_trips_on_ascii() {
        assert_eq!(utf8_to_utf16("hello", 3), 3);
        assert_eq!(utf16_to_utf8("hello", 3), 3);
        assert_eq!(utf16_len("hello"), 5);
    }

    #[test]
    fn utf16_maps_multibyte_and_astral_characters() {
        // "é" is 2 bytes and 1 unit; "😀" is 4 bytes and 2 units.
        let text = "aé😀b";
        assert_eq!(utf16_len(text), 5);
        assert_eq!(utf8_to_utf16(text, 1), 1);
        assert_eq!(utf8_to_utf16(text, 3), 2);
        assert_eq!(utf8_to_utf16(text, 7), 4);
        assert_eq!(utf8_to_utf16(text, 8), 5);
        assert_eq!(utf16_to_utf8(text, 2), 3);
        assert_eq!(utf16_to_utf8(text, 4), 7);
        assert_eq!(utf16_to_utf8(text, 5), 8);
    }

    #[test]
    fn utf16_inside_a_surrogate_pair_snaps_to_the_character_start() {
        let text = "a😀b";
        assert_eq!(utf16_to_utf8(text, 2), 1);
        assert!(text.is_char_boundary(utf16_to_utf8(text, 2)));
    }

    #[test]
    fn utf16_past_the_end_clamps() {
        assert_eq!(utf16_to_utf8("ab", 99), 2);
        assert_eq!(utf8_to_utf16("ab", 99), 2);
    }

    #[test]
    fn ranges_convert_both_ways() {
        let text = "日本語 text";
        let r8 = utf16_range_to_utf8(text, 1..3);
        assert_eq!(r8, 3..9);
        assert_eq!(utf8_range_to_utf16(text, r8), 1..3);
    }

    #[test]
    fn caret_steps_over_whole_graphemes() {
        // e + combining acute is one grapheme of 3 bytes.
        let text = "ae\u{301}b";
        assert_eq!(next_boundary(text, 1), 4);
        assert_eq!(prev_boundary(text, 4), 1);
        // A ZWJ family emoji is one grapheme.
        let family = "x👩\u{200d}👧y";
        let end = family.len() - 1;
        assert_eq!(next_boundary(family, 1), end);
        assert_eq!(prev_boundary(family, end), 1);
    }

    #[test]
    fn snap_back_leaves_boundaries_alone() {
        let text = "ae\u{301}b";
        assert_eq!(snap_back(text, 4), 4);
        assert_eq!(snap_back(text, 3), 1);
    }

    #[test]
    fn marked_text_splices_into_style_segments() {
        // "ab" + "cd" styled 1 and 2; mark 3 bytes replacing "bc".
        let segments = [(2, 1), (2, 2)];
        assert_eq!(splice_segments(&segments, 1, 3, 3), vec![(1, 1, false), (3, 1, true), (1, 2, false)]);
        // Insert at a boundary takes the next segment's style.
        assert_eq!(splice_segments(&segments, 2, 2, 1), vec![(2, 1, false), (1, 2, true), (2, 2, false)]);
        // At the end it takes the last style.
        assert_eq!(splice_segments(&segments, 4, 4, 2), vec![(2, 1, false), (2, 2, false), (2, 2, true)]);
        // An empty paragraph has no style to take.
        assert_eq!(splice_segments::<u8>(&[], 0, 0, 2), vec![]);
    }

    #[test]
    fn word_moves_and_double_click_words() {
        let text = "Hello, brave new world";
        assert_eq!(next_word(text, 0), 5);
        assert_eq!(next_word(text, 5), 12);
        assert_eq!(prev_word(text, text.len()), 17);
        assert_eq!(prev_word(text, 12), 7);
        assert_eq!(word_at(text, 9), 7..12);
        assert_eq!(word_at(text, 5), 0..5);
    }
}
