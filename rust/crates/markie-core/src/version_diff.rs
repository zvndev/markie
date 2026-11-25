//! "Highlight changes" for the History page: what a version added, and what
//! it removed, word by word inside a changed line. A port of Electron's
//! `src/lib/version-diff.ts` (the super-nightly `version-history-view`).
//!
//! Electron renders one merged document: the newer text with the removed
//! text put back. Inside a changed line, private-use sentinel characters
//! bracket inserted and removed words. They are plain text to the Markdown
//! parser, so they survive parsing, and the view turns them into marks. A
//! line's list, heading or quote prefix stays outside the marks, so a changed
//! list item is still a list item.
//!
//! One difference: Electron wraps a block that only one side has in a
//! `<div>` the stylesheet colours. Markie RS draws no HTML, so such a block
//! is marked line by line instead (text and code fences), which reads the
//! same. A display-math or raw-HTML block cannot hold marks: an added one is
//! shown as it is and a removed one is left out, so the page never shows
//! text the version does not have.

/// Brackets inserted words (`INS_OPEN`, `INS_CLOSE`).
pub const INS_OPEN: char = '\u{E000}';
pub const INS_CLOSE: char = '\u{E001}';
/// Brackets removed words (`DEL_OPEN`, `DEL_CLOSE`).
pub const DEL_OPEN: char = '\u{E002}';
pub const DEL_CLOSE: char = '\u{E003}';

fn is_sentinel(c: char) -> bool {
    matches!(c, INS_OPEN | INS_CLOSE | DEL_OPEN | DEL_CLOSE)
}

/// Past this many lines a side, highlighting is skipped: the view still
/// shows the version (`MAX_DIFF_LINES`).
pub const MAX_DIFF_LINES: usize = 6000;
const MAX_WORD_TOKENS: usize = 1500;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpanKind {
    Same,
    Ins,
    Del,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffSpan {
    pub kind: SpanKind,
    pub text: String,
}

fn span(kind: SpanKind, text: &str) -> DiffSpan {
    DiffSpan { kind, text: text.to_string() }
}

// ---- LCS over arbitrary tokens ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    Same,
    Ins,
    Del,
}

/// `lcsOps`: the edit script from `a` to `b`, as (op, index into a or b).
/// Same and Ins name `b`'s item, Del names `a`'s.
fn lcs_ops<T>(a: &[T], b: &[T], eq: impl Fn(&T, &T) -> bool) -> Vec<(Op, usize)> {
    let mut start = 0;
    while start < a.len() && start < b.len() && eq(&a[start], &b[start]) {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && eq(&a[end_a - 1], &b[end_b - 1]) {
        end_a -= 1;
        end_b -= 1;
    }
    let (n, m) = (end_a - start, end_b - start);
    let width = m + 1;
    let mut table = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i * width + j] = if eq(&a[start + i], &b[start + j]) {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let mut ops: Vec<(Op, usize)> = (0..start).map(|k| (Op::Same, k)).collect();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if eq(&a[start + i], &b[start + j]) {
            ops.push((Op::Same, start + j));
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            ops.push((Op::Del, start + i));
            i += 1;
        } else {
            ops.push((Op::Ins, start + j));
            j += 1;
        }
    }
    while i < n {
        ops.push((Op::Del, start + i));
        i += 1;
    }
    while j < m {
        ops.push((Op::Ins, start + j));
        j += 1;
    }
    ops.extend((end_b..b.len()).map(|k| (Op::Same, k)));
    ops
}

// ---- words ----

fn word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '_' || c == '\'' || c == '\u{2019}'
}

/// Words, runs of whitespace, and single punctuation marks, so "fox."
/// against "fox!" changes one character's token rather than the word.
fn tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((start, c)) = chars.next() {
        let class = |c: char| if word_char(c) { 0 } else if c.is_whitespace() { 1 } else { 2 };
        let k = class(c);
        let mut end = start + c.len_utf8();
        if k != 2 {
            while let Some(&(i, d)) = chars.peek() {
                if class(d) != k {
                    break;
                }
                end = i + d.len_utf8();
                chars.next();
            }
        }
        out.push(&text[start..end]);
    }
    out
}

/// `wordDiff`: the word-level difference between two strings, adjacent
/// spans of a kind merged.
pub fn word_diff(before: &str, after: &str) -> Vec<DiffSpan> {
    let a = tokens(before);
    let b = tokens(after);
    let ops: Vec<(Op, &str)> = if a.len() + b.len() > MAX_WORD_TOKENS {
        let mut ops = Vec::new();
        if !before.is_empty() {
            ops.push((Op::Del, before));
        }
        if !after.is_empty() {
            ops.push((Op::Ins, after));
        }
        ops
    } else {
        lcs_ops(&a, &b, |x, y| x == y)
            .into_iter()
            .map(|(op, k)| (op, if op == Op::Del { a[k] } else { b[k] }))
            .collect()
    };
    // One changed region at a time: the removed text, then the added text.
    // A run of whitespace both sides kept, between two changes, joins the
    // region, so "quick brown" to "slow red" reads as one replaced phrase.
    let mut spans: Vec<DiffSpan> = Vec::new();
    let (mut del, mut ins) = (String::new(), String::new());
    fn flush(spans: &mut Vec<DiffSpan>, del: &mut String, ins: &mut String) {
        if !del.is_empty() {
            spans.push(span(SpanKind::Del, del));
        }
        if !ins.is_empty() {
            spans.push(span(SpanKind::Ins, ins));
        }
        del.clear();
        ins.clear();
    }
    for (k, (op, value)) in ops.iter().enumerate() {
        match op {
            Op::Del => del.push_str(value),
            Op::Ins => ins.push_str(value),
            Op::Same => {
                let joins = (!del.is_empty() || !ins.is_empty())
                    && !value.is_empty()
                    && value.chars().all(char::is_whitespace)
                    && ops.get(k + 1).is_some_and(|(next, _)| *next != Op::Same);
                if joins {
                    del.push_str(value);
                    ins.push_str(value);
                } else {
                    flush(&mut spans, &mut del, &mut ins);
                    match spans.last_mut() {
                        Some(last) if last.kind == SpanKind::Same => last.text.push_str(value),
                        _ => spans.push(span(SpanKind::Same, value)),
                    }
                }
            }
        }
    }
    flush(&mut spans, &mut del, &mut ins);
    spans
}

fn count_words(text: &str) -> usize {
    let mut n = 0;
    let mut inside = false;
    for c in text.chars() {
        let w = c.is_alphabetic() || c.is_numeric();
        if w && !inside {
            n += 1;
        }
        inside = w;
    }
    n
}

/// How much two strings share, by words, from 0 (nothing) to 1 (the same).
pub fn similarity(before: &str, after: &str) -> f64 {
    if before.trim() == after.trim() {
        return 1.0;
    }
    let (mut same, mut del, mut ins) = (0, 0, 0);
    for s in word_diff(before, after) {
        match s.kind {
            SpanKind::Same => same += count_words(&s.text),
            SpanKind::Del => del += count_words(&s.text),
            SpanKind::Ins => ins += count_words(&s.text),
        }
    }
    let total = 2 * same + del + ins;
    if total == 0 { 0.0 } else { (2 * same) as f64 / total as f64 }
}

/// Surrounding whitespace stays outside the marks: a mark that opens on a
/// space draws a coloured gap.
fn wrap(text: &str, open: char, close: char) -> String {
    let body = text.trim_start();
    let lead = &text[..text.len() - body.len()];
    let middle = body.trim_end();
    if middle.is_empty() {
        return text.to_string();
    }
    let trail = &body[middle.len()..];
    format!("{lead}{open}{middle}{close}{trail}")
}

fn marked_words(before: &str, after: &str) -> String {
    word_diff(before, after)
        .into_iter()
        .map(|s| match s.kind {
            SpanKind::Same => s.text,
            SpanKind::Ins => wrap(&s.text, INS_OPEN, INS_CLOSE),
            SpanKind::Del => wrap(&s.text, DEL_OPEN, DEL_CLOSE),
        })
        .collect()
}

// ---- lines ----

/// The text with any sentinel characters it happened to contain removed.
pub fn strip(text: &str) -> String {
    text.chars().filter(|c| !is_sentinel(*c)).collect()
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n').unwrap_or(text).split('\n').collect()
}

/// A line's structural prefix: indentation, quote markers, a list marker
/// with its task box, or heading hashes. Marks go after it (`PREFIX`).
fn prefix_of(line: &str) -> &str {
    let bytes = line.as_bytes();
    let ws = |i: usize| i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\x0b' | b'\x0c' | b'\r');
    let mut i = 0;
    while ws(i) {
        i += 1;
    }
    while i < bytes.len() && bytes[i] == b'>' {
        i += 1;
        if ws(i) {
            i += 1;
        }
    }
    while ws(i) {
        i += 1;
    }
    let before_marker = i;
    // A list marker, a space, and an optional task box with its space.
    let mut j = i;
    let marker = if j < bytes.len() && matches!(bytes[j], b'-' | b'*' | b'+') {
        j += 1;
        true
    } else {
        let digits = bytes[j..].iter().take_while(|b| b.is_ascii_digit()).count();
        if (1..=9).contains(&digits) && matches!(bytes.get(j + digits), Some(b'.' | b')')) {
            j += digits + 1;
            true
        } else {
            false
        }
    };
    if marker && ws(j) {
        while ws(j) {
            j += 1;
        }
        if j + 2 < bytes.len() && bytes[j] == b'[' && matches!(bytes[j + 1], b' ' | b'x' | b'X') && bytes[j + 2] == b']' && ws(j + 3) {
            j += 3;
            while ws(j) {
                j += 1;
            }
        }
        return &line[..j];
    }
    let hashes = bytes[i..].iter().take_while(|b| **b == b'#').count();
    if (1..=6).contains(&hashes) && ws(i + hashes) {
        let mut j = i + hashes;
        while ws(j) {
            j += 1;
        }
        return &line[..j];
    }
    &line[..before_marker]
}

fn is_table_row(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 2 && t.starts_with('|') && t.ends_with('|')
}

fn is_table_separator(line: &str) -> bool {
    let mut s = line.trim();
    s = s.strip_prefix('|').unwrap_or(s);
    s = s.strip_suffix('|').unwrap_or(s);
    s.split('|').all(|cell| {
        let c = cell.trim();
        let c = c.strip_prefix(':').unwrap_or(c);
        let c = c.strip_suffix(':').unwrap_or(c);
        c.len() >= 2 && c.bytes().all(|b| b == b'-')
    })
}

fn cells(line: &str) -> Vec<&str> {
    let t = line.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    t.split('|').collect()
}

/// Raw HTML tags (a mark inside a tag would break it) and math (a mark
/// inside `$…$` is not a symbol) are not marked word by word.
fn unmarkable(line: &str) -> bool {
    let b = line.as_bytes();
    let tag = b.windows(2).enumerate().any(|(i, w)| {
        w[0] == b'<' && (w[1].is_ascii_alphabetic() || (w[1] == b'/' && b.get(i + 2).is_some_and(u8::is_ascii_alphabetic)))
    });
    tag || line.contains('$')
}

fn whole_line(line: &str, open: char, close: char, structural: bool) -> String {
    if !structural {
        return wrap(line, open, close);
    }
    if is_table_row(line) {
        if is_table_separator(line) {
            return line.to_string();
        }
        let marked: Vec<String> = cells(line).into_iter().map(|c| wrap(c, open, close)).collect();
        return format!("|{}|", marked.join("|"));
    }
    let prefix = prefix_of(line);
    format!("{prefix}{}", wrap(&line[prefix.len()..], open, close))
}

fn changed_line(before: &str, after: &str, structural: bool) -> Vec<String> {
    if !structural {
        return vec![marked_words(before, after)];
    }
    if is_table_row(before) && is_table_row(after) {
        let (a, b) = (cells(before), cells(after));
        if a.len() == b.len() && !is_table_separator(after) {
            let marked: Vec<String> = b.iter().enumerate().map(|(i, cell)| marked_words(a[i], cell)).collect();
            return vec![format!("|{}|", marked.join("|"))];
        }
        // A row that changed shape cannot share one row: show both rows.
        return vec![whole_line(before, DEL_OPEN, DEL_CLOSE, true), whole_line(after, INS_OPEN, INS_CLOSE, true)];
    }
    let (pa, pb) = (prefix_of(before), prefix_of(after));
    if pa.trim() != pb.trim() || unmarkable(before) || unmarkable(after) {
        return vec![whole_line(before, DEL_OPEN, DEL_CLOSE, true), whole_line(after, INS_OPEN, INS_CLOSE, true)];
    }
    vec![format!("{pb}{}", marked_words(&before[pa.len()..], &after[pb.len()..]))]
}

/// `mergeLines`: two runs of lines as one, marking what changed. Unmatched
/// lines are paired in order when they are alike enough to read as an edit;
/// the rest are whole removed or added lines.
fn merge_lines(before: &[&str], after: &[&str], structural: bool) -> Vec<String> {
    let mut out = Vec::new();
    let (mut dels, mut ins): (Vec<&str>, Vec<&str>) = (Vec::new(), Vec::new());
    let flush = |out: &mut Vec<String>, dels: &mut Vec<&str>, ins: &mut Vec<&str>| {
        let pairs = dels.len().min(ins.len());
        let (mut d, mut i) = (0, 0);
        while d < dels.len() || i < ins.len() {
            if d < dels.len() && i < ins.len() && d < pairs && similarity(dels[d], ins[i]) >= 0.35 {
                out.extend(changed_line(dels[d], ins[i], structural));
                d += 1;
                i += 1;
            } else if d < dels.len() && (i >= ins.len() || d <= i) {
                out.push(whole_line(dels[d], DEL_OPEN, DEL_CLOSE, structural));
                d += 1;
            } else {
                out.push(whole_line(ins[i], INS_OPEN, INS_CLOSE, structural));
                i += 1;
            }
        }
        dels.clear();
        ins.clear();
    };
    for (op, k) in lcs_ops(before, after, |x, y| x == y) {
        match op {
            Op::Same => {
                flush(&mut out, &mut dels, &mut ins);
                out.push(after[k].to_string());
            }
            Op::Del => dels.push(before[k]),
            Op::Ins => ins.push(after[k]),
        }
    }
    flush(&mut out, &mut dels, &mut ins);
    out
}

// ---- markdown blocks ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BlockKind {
    Text,
    Fence,
    Math,
    Html,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Block {
    text: String,
    kind: BlockKind,
}

/// `FENCE_OPEN`: up to three spaces, then three or more backticks or tildes.
/// Returns the fence run.
fn fence_open(line: &str) -> Option<&str> {
    let lead = line.len() - line.trim_start_matches([' ', '\t']).len();
    if lead > 3 {
        return None;
    }
    let rest = &line[lead..];
    let ch = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = rest.len() - rest.trim_start_matches(ch).len();
    (run >= 3).then(|| &rest[..run])
}

fn html_start(line: &str) -> bool {
    let lead = line.len() - line.trim_start_matches([' ', '\t']).len();
    let rest = line[lead.min(3)..].as_bytes();
    lead <= 3 && rest.first() == Some(&b'<') && rest.get(1).is_some_and(|b| b.is_ascii_alphabetic() || *b == b'!' || *b == b'/')
}

/// Blocks separated by blank lines, with a fenced code block or a `$$` math
/// block kept whole however many blank lines it holds.
fn split_blocks(markdown: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    let mut kind = BlockKind::Text;
    let mut fence: Option<String> = None;
    let mut math = false;
    fn push(blocks: &mut Vec<Block>, cur: &mut Vec<&str>, kind: &mut BlockKind) {
        if !cur.is_empty() {
            blocks.push(Block { text: cur.join("\n"), kind: *kind });
        }
        cur.clear();
        *kind = BlockKind::Text;
    }
    for line in split_lines(markdown) {
        if let Some(f) = &fence {
            cur.push(line);
            if line.trim().starts_with(f.as_str()) {
                fence = None;
                push(&mut blocks, &mut cur, &mut kind);
            }
            continue;
        }
        if math {
            cur.push(line);
            if line.trim().ends_with("$$") {
                math = false;
                push(&mut blocks, &mut cur, &mut kind);
            }
            continue;
        }
        if let Some(opener) = fence_open(line) {
            push(&mut blocks, &mut cur, &mut kind);
            fence = Some(opener.to_string());
            kind = BlockKind::Fence;
            cur.push(line);
            continue;
        }
        if line.trim().starts_with("$$") {
            push(&mut blocks, &mut cur, &mut kind);
            kind = BlockKind::Math;
            cur.push(line);
            if !(line.trim().len() > 2 && line.trim().ends_with("$$")) {
                math = true;
            } else {
                push(&mut blocks, &mut cur, &mut kind);
            }
            continue;
        }
        if line.trim().is_empty() {
            push(&mut blocks, &mut cur, &mut kind);
            continue;
        }
        if cur.is_empty() && html_start(line) {
            kind = BlockKind::Html;
        }
        cur.push(line);
    }
    push(&mut blocks, &mut cur, &mut kind);
    blocks
}

/// A block only one side has. Electron's `wrapBlock` puts it in a coloured
/// `<div>`; here each line is marked. Math and raw HTML hold no marks: an
/// added one shows as it is, a removed one is left out.
fn whole_block(block: &Block, ins: bool) -> Option<String> {
    let (open, close) = if ins { (INS_OPEN, INS_CLOSE) } else { (DEL_OPEN, DEL_CLOSE) };
    let lines = split_lines(&block.text);
    match block.kind {
        BlockKind::Text => Some(lines.iter().map(|l| whole_line(l, open, close, true)).collect::<Vec<_>>().join("\n")),
        BlockKind::Fence => {
            let last = lines.len().saturating_sub(1);
            let close_at = if lines.len() >= 2 && fence_open(lines[last]).is_some() { last } else { lines.len() };
            let body = lines.iter().enumerate().map(|(i, l)| if i == 0 || i >= close_at { l.to_string() } else { wrap(l, open, close) });
            Some(body.collect::<Vec<_>>().join("\n"))
        }
        BlockKind::Math | BlockKind::Html => ins.then(|| block.text.clone()),
    }
}

fn merge_block_pair(before: &Block, after: &Block) -> Vec<String> {
    let both = || whole_block(before, false).into_iter().chain(whole_block(after, true)).collect::<Vec<_>>();
    if before.kind != after.kind || matches!(after.kind, BlockKind::Math | BlockKind::Html) {
        return both();
    }
    let (a, b) = (split_lines(&before.text), split_lines(&after.text));
    if after.kind == BlockKind::Fence {
        // Inside a fence, lines are verbatim. The fence lines themselves must
        // not be marked, or the fence stops being one.
        if a[0] != b[0] || a.len() < 2 || b.len() < 2 {
            return both();
        }
        let close_a = if fence_open(a[a.len() - 1]).is_some() { a.len() - 1 } else { a.len() };
        let close_b = if fence_open(b[b.len() - 1]).is_some() { b.len() - 1 } else { b.len() };
        let mut out = vec![b[0].to_string()];
        out.extend(merge_lines(&a[1..close_a], &b[1..close_b], false));
        out.extend(b[close_b..].iter().map(|l| l.to_string()));
        return vec![out.join("\n")];
    }
    if similarity(&before.text, &after.text) < 0.3 {
        return both();
    }
    vec![merge_lines(&a, &b, true).join("\n")]
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkedDocument {
    /// The text to render, sentinels included.
    pub text: String,
    /// Whether anything differs.
    pub changed: bool,
    /// True when the document was too large to compare; `text` is then the
    /// newer text as it is.
    pub skipped: bool,
}

/// `markMarkdownChanges`: two Markdown documents merged for the rendered
/// "Highlight changes" view.
pub fn mark_markdown_changes(before_raw: &str, after_raw: &str) -> MarkedDocument {
    let before = strip(before_raw);
    let after = strip(after_raw);
    if before == after {
        return MarkedDocument { text: after, changed: false, skipped: false };
    }
    if split_lines(&before).len() > MAX_DIFF_LINES || split_lines(&after).len() > MAX_DIFF_LINES {
        return MarkedDocument { text: after, changed: true, skipped: true };
    }
    let a = split_blocks(&before);
    let b = split_blocks(&after);
    let mut out: Vec<String> = Vec::new();
    let (mut dels, mut ins): (Vec<&Block>, Vec<&Block>) = (Vec::new(), Vec::new());
    let flush = |out: &mut Vec<String>, dels: &mut Vec<&Block>, ins: &mut Vec<&Block>| {
        let pairs = dels.len().min(ins.len());
        for k in 0..pairs {
            out.extend(merge_block_pair(dels[k], ins[k]));
        }
        out.extend(dels[pairs..].iter().filter_map(|d| whole_block(d, false)));
        out.extend(ins[pairs..].iter().filter_map(|i| whole_block(i, true)));
        dels.clear();
        ins.clear();
    };
    for (op, k) in lcs_ops(&a, &b, |x, y| x.text == y.text) {
        match op {
            Op::Same => {
                flush(&mut out, &mut dels, &mut ins);
                out.push(b[k].text.clone());
            }
            Op::Del => dels.push(&a[k]),
            Op::Ins => ins.push(&b[k]),
        }
    }
    flush(&mut out, &mut dels, &mut ins);
    MarkedDocument { text: out.join("\n\n") + "\n", changed: true, skipped: false }
}

/// `markSourceChanges`: two plain-text documents merged for the source view
/// (plain text, CSV, Darkmown).
pub fn mark_source_changes(before_raw: &str, after_raw: &str) -> MarkedDocument {
    let before = strip(before_raw);
    let after = strip(after_raw);
    if before == after {
        return MarkedDocument { text: after, changed: false, skipped: false };
    }
    let (a, b) = (split_lines(&before), split_lines(&after));
    if a.len() > MAX_DIFF_LINES || b.len() > MAX_DIFF_LINES {
        return MarkedDocument { text: after, changed: true, skipped: true };
    }
    MarkedDocument { text: merge_lines(&a, &b, false).join("\n"), changed: true, skipped: false }
}

/// `markedSpans`: sentinel-marked text as spans, for the source view.
pub fn marked_spans(text: &str) -> Vec<DiffSpan> {
    let mut spans = Vec::new();
    let mut kind = SpanKind::Same;
    let mut buf = String::new();
    for ch in text.chars() {
        let next = match ch {
            INS_OPEN => Some(SpanKind::Ins),
            DEL_OPEN => Some(SpanKind::Del),
            INS_CLOSE | DEL_CLOSE => Some(SpanKind::Same),
            _ => None,
        };
        match next {
            Some(k) => {
                if !buf.is_empty() {
                    spans.push(DiffSpan { kind, text: std::mem::take(&mut buf) });
                }
                kind = k;
            }
            None => buf.push(ch),
        }
    }
    if !buf.is_empty() {
        spans.push(DiffSpan { kind, text: buf });
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(spans: &[DiffSpan], kind: SpanKind) -> Vec<&str> {
        spans.iter().filter(|s| s.kind == kind).map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn word_diff_marks_the_changed_words_and_keeps_the_rest() {
        assert_eq!(
            word_diff("the quick fox", "the slow fox"),
            vec![span(SpanKind::Same, "the "), span(SpanKind::Del, "quick"), span(SpanKind::Ins, "slow"), span(SpanKind::Same, " fox")]
        );
    }

    #[test]
    fn a_replaced_phrase_reads_as_one_change() {
        let spans = word_diff("a quick brown fox", "a slow red fox");
        assert_eq!(kinds(&spans, SpanKind::Del), ["quick brown"]);
        assert_eq!(kinds(&spans, SpanKind::Ins), ["slow red"]);
    }

    #[test]
    fn similarity_counts_shared_words() {
        assert_eq!(similarity("one two three", "one two three"), 1.0);
        assert!(similarity("one two three four", "one two three five") > 0.7);
        assert_eq!(similarity("alpha beta", "gamma delta"), 0.0);
    }

    #[test]
    fn a_paragraph_gets_inserted_and_removed_words() {
        let merged = mark_markdown_changes("The cat sat on the mat.\n", "The cat slept on the warm mat.\n");
        let spans = marked_spans(&merged.text);
        assert_eq!(kinds(&spans, SpanKind::Ins), ["slept", "warm"]);
        assert_eq!(kinds(&spans, SpanKind::Del), ["sat"]);
        assert_eq!(strip(&merged.text), "The cat satslept on the warm mat.\n");
    }

    #[test]
    fn list_items_and_headings_keep_their_prefix_outside_the_marks() {
        let merged = mark_markdown_changes("# Plan\n\n- eggs\n- milk\n", "# Plan B\n\n- eggs\n- oat milk\n- bread\n");
        let lines: Vec<&str> = merged.text.lines().collect();
        assert_eq!(lines[0], format!("# Plan {INS_OPEN}B{INS_CLOSE}"));
        assert!(lines.contains(&format!("- {INS_OPEN}oat{INS_CLOSE} milk").as_str()), "{lines:?}");
        assert!(lines.contains(&format!("- {INS_OPEN}bread{INS_CLOSE}").as_str()), "{lines:?}");
    }

    #[test]
    fn a_block_only_one_side_has_is_marked_whole() {
        let merged = mark_markdown_changes("Intro.\n\nOld paragraph here.\n", "Intro.\n\n## A new section\n\nIntro.\n");
        assert!(merged.text.contains(&format!("## {INS_OPEN}A new section{INS_CLOSE}")), "{}", merged.text);
        assert!(merged.text.contains(&format!("{DEL_OPEN}Old paragraph here.{DEL_CLOSE}")), "{}", merged.text);
    }

    #[test]
    fn a_code_fence_keeps_its_fence_lines() {
        let merged = mark_markdown_changes("```js\nconst a = 1;\nconst b = 2;\n```\n", "```js\nconst a = 1;\nconst b = 3;\n```\n");
        assert!(merged.text.starts_with("```js\nconst a = 1;\n"));
        assert!(merged.text.trim_end().ends_with("```"));
        let spans = marked_spans(&merged.text);
        assert_eq!(kinds(&spans, SpanKind::Ins), ["3"]);
        assert_eq!(kinds(&spans, SpanKind::Del), ["2"]);
    }

    #[test]
    fn a_changed_table_cell_is_marked_and_the_separator_is_not() {
        let before = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
        let after = "| a | b |\n| --- | --- |\n| 1 | 5 |\n| 3 | 4 |\n";
        let merged = mark_markdown_changes(before, after);
        assert!(merged.text.contains("| --- | --- |"));
        let spans = marked_spans(&merged.text);
        assert_eq!(kinds(&spans, SpanKind::Ins).iter().map(|s| s.trim()).collect::<Vec<_>>(), ["5", "3", "4"]);
    }

    #[test]
    fn an_unchanged_document_is_unmarked_and_stray_sentinels_go() {
        assert_eq!(mark_markdown_changes("# Same\n", "# Same\n"), MarkedDocument { text: "# Same\n".into(), changed: false, skipped: false });
        let res = mark_markdown_changes(&format!("a{INS_OPEN}b\n"), "ab\n");
        assert_eq!(res.text, "ab\n");
    }

    #[test]
    fn a_removed_math_block_is_left_out_and_an_added_one_shown() {
        let merged = mark_markdown_changes("Text.\n\n$$\nx^2\n$$\n", "Text.\n\n$$\ny^2\n$$\n");
        assert!(merged.text.contains("y^2"));
        assert!(!merged.text.contains("x^2"));
        assert!(!merged.text.contains(INS_OPEN));
    }

    #[test]
    fn source_changes_mark_words_and_whole_lines() {
        let res = mark_source_changes("a,b\n1,2\n", "a,b\n1,3\n4,5\n");
        let spans = marked_spans(&res.text);
        assert_eq!(kinds(&spans, SpanKind::Del), ["2"]);
        assert_eq!(kinds(&spans, SpanKind::Ins), ["3", "4,5"]);
    }

    #[test]
    fn prefixes_follow_electrons_pattern() {
        assert_eq!(prefix_of("  > - [x] done"), "  > - [x] ");
        assert_eq!(prefix_of("12. step"), "12. ");
        assert_eq!(prefix_of("### Title"), "### ");
        assert_eq!(prefix_of("####### seven"), "");
        assert_eq!(prefix_of("-not a list"), "");
        assert_eq!(prefix_of("plain"), "");
    }

    #[test]
    fn huge_documents_skip_highlighting() {
        let big: String = (0..MAX_DIFF_LINES + 1).map(|i| format!("line {i}\n")).collect();
        let res = mark_markdown_changes("small\n", &big);
        assert!(res.skipped && res.changed);
        assert_eq!(res.text, big);
    }
}
