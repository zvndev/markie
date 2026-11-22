//! Putting a local comment on screen in View mode. A port of the projection
//! half of src/lib/local-comments.ts.
//!
//! A thread is anchored by quoted Markdown. Source mode shows the Markdown,
//! so a resolved range is already a range there. View mode shows what the
//! Markdown renders to, so a range is found by projecting the Markdown to
//! its visible text, finding the passage's visible form in the editor's own
//! text, and taking the same occurrence; a selection in View goes back the
//! same way. Offsets are UTF-16 units, as in the web app.
use crate::comments::anchor::{is_js_space, is_js_word, utf16};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub from: usize,
    pub to: usize,
}

/// The Markdown with its syntax removed, and for each character of it, its
/// index in the Markdown.
pub struct Projection {
    pub text: Vec<u16>,
    pub map: Vec<usize>,
}

fn starts_with(hay: &[u16], at: usize, pat: &str) -> bool {
    let p: Vec<u16> = pat.encode_utf16().collect();
    hay.len() >= at + p.len() && hay[at..at + p.len()] == p[..]
}

fn find_from(hay: &[u16], pat: &str, from: usize) -> Option<usize> {
    let p: Vec<u16> = pat.encode_utf16().collect();
    if p.is_empty() || hay.len() < p.len() {
        return None;
    }
    (from..=hay.len() - p.len()).find(|&i| hay[i..i + p.len()] == p[..])
}

fn is_digit(c: u16) -> bool {
    (0x30..=0x39).contains(&c)
}

/// The length of `^(\s{0,3}(?:>\s?)*)(#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+(?:\[[ xX]\]\s+)?)?`.
fn block_prefix(l: &[u16]) -> usize {
    let mut i = 0;
    while i < 3 && i < l.len() && is_js_space(l[i]) {
        i += 1;
    }
    while i < l.len() && l[i] == b'>' as u16 {
        i += 1;
        if i < l.len() && is_js_space(l[i]) {
            i += 1;
        }
    }
    let spaces = |mut j: usize| -> Option<usize> {
        let s = j;
        while j < l.len() && is_js_space(l[j]) {
            j += 1;
        }
        (j > s).then_some(j)
    };
    let task = |j: usize| -> usize {
        if j + 2 < l.len() && l[j] == b'[' as u16 && matches!(l[j + 1], 0x20 | 0x78 | 0x58) && l[j + 2] == b']' as u16 {
            if let Some(k) = spaces(j + 3) {
                return k;
            }
        }
        j
    };
    let start = i;
    // Heading.
    let mut h = start;
    while h < l.len() && l[h] == b'#' as u16 && h - start < 6 {
        h += 1;
    }
    if h > start && !(h < l.len() && l[h] == b'#' as u16) {
        if let Some(k) = spaces(h) {
            return k;
        }
    }
    // Bullet.
    if start < l.len() && matches!(l[start], 0x2d | 0x2a | 0x2b) {
        if let Some(k) = spaces(start + 1) {
            return task(k);
        }
    }
    // Ordered.
    let mut d = start;
    while d < l.len() && is_digit(l[d]) && d - start < 9 {
        d += 1;
    }
    if d > start && d < l.len() && matches!(l[d], 0x2e | 0x29) {
        if let Some(k) = spaces(d + 1) {
            return task(k);
        }
    }
    start
}

/// `^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$`
fn is_table_rule(l: &[u16]) -> bool {
    let mut i = 0;
    let ws = |i: &mut usize| {
        while *i < l.len() && is_js_space(l[*i]) {
            *i += 1;
        }
    };
    let cell = |i: &mut usize| -> bool {
        if *i < l.len() && l[*i] == b':' as u16 {
            *i += 1;
        }
        let s = *i;
        while *i < l.len() && l[*i] == b'-' as u16 {
            *i += 1;
        }
        if *i - s < 3 {
            return false;
        }
        if *i < l.len() && l[*i] == b':' as u16 {
            *i += 1;
        }
        true
    };
    ws(&mut i);
    if i < l.len() && l[i] == b'|' as u16 {
        i += 1;
    }
    ws(&mut i);
    if !cell(&mut i) {
        return false;
    }
    ws(&mut i);
    loop {
        let save = i;
        if i < l.len() && l[i] == b'|' as u16 {
            i += 1;
            ws(&mut i);
            if cell(&mut i) {
                ws(&mut i);
                continue;
            }
        }
        i = save;
        break;
    }
    if i < l.len() && l[i] == b'|' as u16 {
        i += 1;
    }
    ws(&mut i);
    i == l.len()
}

fn is_fence(l: &[u16]) -> bool {
    let mut i = 0;
    while i < 3 && i < l.len() && l[i] == 0x20 {
        i += 1;
    }
    starts_with(l, i, "```") || starts_with(l, i, "~~~")
}

/// `^<\/?[A-Za-z][^<>]*>`: the tag's length.
fn tag_len(rest: &[u16]) -> Option<usize> {
    let mut i = 1;
    if rest.get(i) == Some(&(b'/' as u16)) {
        i += 1;
    }
    let c = *rest.get(i)?;
    if !((0x41..=0x5a).contains(&c) || (0x61..=0x7a).contains(&c)) {
        return None;
    }
    i += 1;
    while i < rest.len() && rest[i] != b'<' as u16 && rest[i] != b'>' as u16 {
        i += 1;
    }
    (rest.get(i) == Some(&(b'>' as u16))).then_some(i + 1)
}

/// Front matter's length: `^---\r?\n[\s\S]*?\r?\n---\r?\n`.
fn front_matter_len(md: &[u16]) -> usize {
    let open = if starts_with(md, 0, "---\n") {
        4
    } else if starts_with(md, 0, "---\r\n") {
        5
    } else {
        return 0;
    };
    let mut i = open;
    while i < md.len() {
        if md[i] == b'\n' as u16 && i > 0 {
            let line_start = i + 1;
            if starts_with(md, line_start, "---\n") {
                return line_start + 4;
            }
            if starts_with(md, line_start, "---\r\n") {
                return line_start + 5;
            }
        }
        i += 1;
    }
    0
}

/// Strip Markdown down to roughly what View mode shows, keeping a map back.
pub fn project_markdown(markdown: &str) -> Projection {
    let md = utf16(markdown);
    let mut text = Vec::new();
    let mut map = Vec::new();
    let mut i = front_matter_len(&md);
    let mut in_fence = false;
    'lines: while i < md.len() {
        let line_end = md[i..].iter().position(|&c| c == b'\n' as u16).map(|p| i + p).unwrap_or(md.len());
        let line = &md[i..line_end];
        if is_fence(line) {
            in_fence = !in_fence;
        } else if in_fence {
            for (k, &c) in line.iter().enumerate() {
                text.push(c);
                map.push(i + k);
            }
        } else if !is_table_rule(line) {
            let mut k = block_prefix(line);
            while k < line.len() {
                let at = i + k;
                let ch = line[k];
                let rest = &line[k..];
                if starts_with(rest, 0, "<!--") {
                    let stop = find_from(&md, "-->", at + 4).map(|c| c + 3).unwrap_or(md.len());
                    if stop > line_end {
                        i = stop;
                        continue 'lines;
                    }
                    k = stop - i;
                    continue;
                }
                if ch == b'\\' as u16 && k + 1 < line.len() {
                    text.push(line[k + 1]);
                    map.push(at + 1);
                    k += 2;
                    continue;
                }
                if ch == b']' as u16 && line.get(k + 1) == Some(&(b'(' as u16)) {
                    k = line[k + 2..].iter().position(|&c| c == b')' as u16).map(|p| k + 2 + p + 1).unwrap_or(line.len());
                    continue;
                }
                if ch == b'<' as u16 {
                    if let Some(n) = tag_len(rest) {
                        k += n;
                        continue;
                    }
                }
                if matches!(ch, 0x2a | 0x60 | 0x7e | 0x5b) || (ch == b'!' as u16 && line.get(k + 1) == Some(&(b'[' as u16))) {
                    k += 1;
                    continue;
                }
                if ch == b'_' as u16 {
                    let before = if k > 0 { line[k - 1] } else { 0x20 };
                    let after = line.get(k + 1).copied().unwrap_or(0x20);
                    if !(is_js_word(before) && is_js_word(after)) {
                        k += 1;
                        continue;
                    }
                }
                if ch == b'|' as u16 {
                    text.push(0x20);
                    map.push(at);
                    k += 1;
                    continue;
                }
                text.push(ch);
                map.push(at);
                k += 1;
            }
        }
        if line_end < md.len() {
            text.push(b'\n' as u16);
            map.push(line_end);
        }
        i = line_end + 1;
    }
    Projection { text, map }
}

fn squeeze(text: &[u16]) -> (Vec<u16>, Vec<usize>) {
    let mut out = Vec::new();
    let mut map = Vec::new();
    let mut in_space = false;
    for (i, &c) in text.iter().enumerate() {
        if is_js_space(c) {
            if !in_space {
                out.push(0x20);
                map.push(i);
            }
            in_space = true;
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

fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return if needle.is_empty() && from <= hay.len() { Some(from) } else { None };
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

fn occurrences_before(hay: &[u16], needle: &[u16], before: usize) -> usize {
    let mut n = 0;
    let mut at = index_of(hay, needle, 0);
    while let Some(i) = at {
        if i >= before {
            break;
        }
        n += 1;
        at = index_of(hay, needle, i + 1);
    }
    n
}

fn nth_index(hay: &[u16], needle: &[u16], n: usize) -> Option<usize> {
    let mut at = index_of(hay, needle, 0);
    let mut last = at;
    let mut i = 0;
    while let Some(a) = at {
        if i >= n {
            break;
        }
        last = Some(a);
        at = index_of(hay, needle, a + 1);
        i += 1;
    }
    at.or(last)
}

/// A Markdown range as a range in View mode's visible text, or None when the
/// passage cannot be found there.
pub fn markdown_to_visible(markdown: &str, range: Range, visible: &str) -> Option<Range> {
    let proj = project_markdown(markdown);
    let (mut p_from, mut p_to) = (None, 0);
    for (p, &src) in proj.map.iter().enumerate() {
        if src >= range.from && src < range.to {
            if p_from.is_none() {
                p_from = Some(p);
            }
            p_to = p + 1;
        }
    }
    let p_from = p_from?;
    let (sp, sp_map) = squeeze(&proj.text);
    let vis = utf16(visible);
    let (sv, sv_map) = squeeze(&vis);
    let to_squeezed = |p: usize| sp_map.iter().position(|&s| s >= p).unwrap_or(sp_map.len());
    let (s_from, s_to) = (to_squeezed(p_from), to_squeezed(p_to));
    let needle = trim(&sp[s_from..s_to.max(s_from)]);
    if needle.is_empty() {
        return None;
    }
    let k = occurrences_before(&sp, needle, s_from);
    let at = nth_index(&sv, needle, k)?;
    Some(Range { from: sv_map[at], to: sv_map[at + needle.len() - 1] + 1 })
}

/// A selection in View mode's visible text as a Markdown range, or None
/// when the selected text cannot be found in the Markdown.
pub fn visible_to_markdown(markdown: &str, visible: &str, range: Range) -> Option<Range> {
    let vis = utf16(visible);
    let (sv, sv_map) = squeeze(&vis);
    let to_squeezed = |p: usize| sv_map.iter().position(|&s| s >= p).unwrap_or(sv_map.len());
    let (v_from, v_to) = (to_squeezed(range.from), to_squeezed(range.to));
    let sel = &sv[v_from..v_to.max(v_from)];
    let needle = trim(sel);
    if needle.is_empty() {
        return None;
    }
    let lead = sel.iter().position(|c| !is_js_space(*c)).unwrap_or(0);
    let k = occurrences_before(&sv, needle, v_from + lead);
    let proj = project_markdown(markdown);
    let (sp, sp_map) = squeeze(&proj.text);
    let at = nth_index(&sp, needle, k)?;
    let from = proj.map[sp_map[at]];
    let to = proj.map[sp_map[at + needle.len() - 1]] + 1;
    (to > from).then_some(Range { from, to })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(u: &[u16]) -> String {
        String::from_utf16_lossy(u)
    }

    #[test]
    fn projection_drops_syntax() {
        let p = project_markdown("---\ntitle: x\n---\n# Head\n\nSome **bold** and [a link](https://x.y) `code`.\n\n- [ ] task\n\n| a | b |\n|---|---|\n");
        assert_eq!(s(&p.text), "Head\n\nSome bold and a link code.\n\ntask\n\n a   b \n");
    }

    #[test]
    fn ranges_go_both_ways() {
        let md = "# Title\n\nSome **bold** words here, and bold again.\n";
        let visible = "Title\nSome bold words here, and bold again.";
        // "bold" in the Markdown, inside the stars: the first one.
        let from = md.find("bold").unwrap();
        let r = markdown_to_visible(md, Range { from, to: from + 4 }, visible).unwrap();
        assert_eq!(&visible[r.from..r.to], "bold");
        assert_eq!(r.from, 11);
        let back = visible_to_markdown(md, visible, r).unwrap();
        assert_eq!(&md[back.from..back.to], "bold");
        assert_eq!(back.from, from);
        // The second "bold" maps to the second one.
        let second = visible.rfind("bold").unwrap();
        let back = visible_to_markdown(md, visible, Range { from: second, to: second + 4 }).unwrap();
        assert_eq!(back.from, md.rfind("bold").unwrap());
    }
}
