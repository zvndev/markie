//! The three-way block diff between the last synced Markdown (the base),
//! the file on this Mac (local) and the Doc now (remote), and the merged
//! file it leads to.
//!
//! Blocks compare by their normalized key (`md.rs`). Blocks unchanged on all
//! three sides are fixed points; between them lie chunks:
//! - changed only here: sent to Google (`plan.rs`), the file keeps its text;
//! - changed only in Google: Google's blocks go into the file;
//! - changed the same way on both: nothing to do;
//! - changed differently on both, a conflict: Google's text wins in the Doc
//!   and the file, and the caller keeps Markie's version as a conflict copy.
//!
//! The merged file is made by splicing Google's blocks into the local text,
//! so everything else in the file keeps its exact bytes. If the splice does
//! not read back as the expected blocks, the file is rebuilt block by block.
use crate::md::{self, Kind, Parsed};
use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkKind {
    Same,
    LocalOnly,
    RemoteOnly,
    /// Both sides made the same change.
    Both,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub kind: ChunkKind,
    pub base: Range<usize>,
    pub local: Range<usize>,
    pub remote: Range<usize>,
}

/// The longest common subsequence of two key lists, as matched index pairs.
pub fn lcs(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let (am, bm) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    let mut out: Vec<(usize, usize)> = (0..pre).map(|i| (i, i)).collect();
    let (n, m) = (am.len(), bm.len());
    // Past this size the middle is one change: a sync never stalls on a huge Doc.
    if n > 0 && m > 0 && n.saturating_mul(m) <= 16_000_000 {
        let w = m + 1;
        let mut t = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                t[i * w + j] = if am[i] == bm[j] { t[(i + 1) * w + j + 1] + 1 } else { t[(i + 1) * w + j].max(t[i * w + j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if am[i] == bm[j] {
                out.push((pre + i, pre + j));
                i += 1;
                j += 1;
            } else if t[(i + 1) * w + j] >= t[i * w + j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    out.extend((0..suf).map(|k| (a.len() - suf + k, b.len() - suf + k)));
    out
}

/// One side's change against the base: base blocks `b` became that side's `o`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Hunk {
    b: Range<usize>,
    o: Range<usize>,
    local: bool,
}

fn hunks(base: &[&str], other: &[&str], local: bool) -> Vec<Hunk> {
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    for (bi, oj) in lcs(base, other).into_iter().chain(std::iter::once((base.len(), other.len()))) {
        if bi - i == oj - j && bi - i > 1 {
            // Several blocks each replaced by one: separate changes, so a
            // conflict on one of them leaves the others to merge.
            out.extend((0..bi - i).map(|k| Hunk { b: i + k..i + k + 1, o: j + k..j + k + 1, local }));
        } else if bi > i || oj > j {
            out.push(Hunk { b: i..bi, o: j..oj, local });
        }
        (i, j) = (bi + 1, oj + 1);
    }
    out
}

/// Whether two changes touch the same base blocks. Changes to neighbouring
/// blocks do not; two insertions at one place do.
fn overlaps(x: &Range<usize>, y: &Range<usize>) -> bool {
    match (x.is_empty(), y.is_empty()) {
        (false, false) => x.start < y.end && y.start < x.end,
        (true, false) => y.start < x.start && x.start < y.end,
        (false, true) => x.start < y.start && y.start < x.end,
        (true, true) => x.start == y.start,
    }
}

/// Split base, local and remote into chunks. Changes on different blocks,
/// even neighbouring ones, stay apart; only changes to the same blocks meet.
pub fn diff3(base: &[&str], local: &[&str], remote: &[&str]) -> Vec<Chunk> {
    let mut all: Vec<Hunk> = hunks(base, local, true).into_iter().chain(hunks(base, remote, false)).collect();
    all.sort_by_key(|h| (h.b.start, h.b.end));
    // Group changes that touch.
    let mut groups: Vec<Vec<Hunk>> = Vec::new();
    for h in all {
        let joins = groups.last().is_some_and(|g| g.iter().any(|x| overlaps(&x.b, &h.b)) || {
            let span = g.iter().map(|x| x.b.start).min().unwrap()..g.iter().map(|x| x.b.end).max().unwrap();
            !span.is_empty() && overlaps(&span, &h.b)
        });
        if joins {
            groups.last_mut().unwrap().push(h);
        } else {
            groups.push(vec![h]);
        }
    }
    let mut chunks = Vec::new();
    let (mut dl, mut dr) = (0isize, 0isize);
    let mut pos = 0usize;
    let at = |b: usize, d: isize| (b as isize + d) as usize;
    for g in groups {
        let s = g.iter().map(|h| h.b.start).min().unwrap();
        let e = g.iter().map(|h| h.b.end).max().unwrap();
        if s > pos {
            chunks.push(Chunk { kind: ChunkKind::Same, base: pos..s, local: at(pos, dl)..at(s, dl), remote: at(pos, dr)..at(s, dr) });
        }
        let gl: isize = g.iter().filter(|h| h.local).map(|h| h.o.len() as isize - h.b.len() as isize).sum();
        let gr: isize = g.iter().filter(|h| !h.local).map(|h| h.o.len() as isize - h.b.len() as isize).sum();
        let l = at(s, dl)..at(e, dl + gl);
        let r = at(s, dr)..at(e, dr + gr);
        let (has_l, has_r) = (g.iter().any(|h| h.local), g.iter().any(|h| !h.local));
        let kind = match (has_l, has_r) {
            (true, false) => ChunkKind::LocalOnly,
            (false, true) => ChunkKind::RemoteOnly,
            _ if local[l.clone()] == remote[r.clone()] => ChunkKind::Both,
            _ => ChunkKind::Conflict,
        };
        chunks.push(Chunk { kind, base: s..e, local: l, remote: r });
        dl += gl;
        dr += gr;
        pos = e;
    }
    if pos < base.len() {
        chunks.push(Chunk { kind: ChunkKind::Same, base: pos..base.len(), local: at(pos, dl)..at(base.len(), dl), remote: at(pos, dr)..at(base.len(), dr) });
    }
    chunks
}

/// Where a merged block comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum From {
    Local(usize),
    Remote(usize),
}

/// The merged file: local text with `replace` chunks (local block range,
/// remote block range) taken from remote. `expected` is the merged block
/// list, used to check the result.
pub fn merged_text(local: &Parsed, remote: &Parsed, replace: &[(Range<usize>, Range<usize>)], expected: &[From]) -> Option<String> {
    let keys = |p: &Parsed| p.blocks.iter().map(|b| b.key.clone()).collect::<Vec<_>>();
    let want: Vec<String> = expected
        .iter()
        .map(|f| match f {
            From::Local(i) => local.blocks[*i].key.clone(),
            From::Remote(i) => remote.blocks[*i].key.clone(),
        })
        .collect();
    if replace.is_empty() {
        return Some(local.text.clone());
    }
    let spliced = splice(local, remote, replace);
    if keys(&md::parse(&spliced)) == want {
        return Some(spliced);
    }
    let joined = join(local, remote, expected);
    if keys(&md::parse(&joined)) == want {
        return Some(joined);
    }
    None
}

fn sep(a: &Kind, b: &Kind) -> &'static str {
    if a.is_item() && b.is_item() { "\n" } else { "\n\n" }
}

fn splice(local: &Parsed, remote: &Parsed, replace: &[(Range<usize>, Range<usize>)]) -> String {
    let lb = &local.blocks;
    let rb = &remote.blocks;
    let rtext = |r: &Range<usize>| remote.text[rb[r.start].range.start..rb[r.end - 1].range.end].to_string();
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    for (l, r) in replace {
        if !l.is_empty() && !r.is_empty() {
            edits.push((lb[l.start].range.start..lb[l.end - 1].range.end, rtext(r)));
        } else if l.is_empty() && !r.is_empty() {
            let (first, last) = (&rb[r.start].kind, &rb[r.end - 1].kind);
            let text = rtext(r);
            if l.start > 0 {
                let prev = &lb[l.start - 1];
                let at = prev.range.end;
                match lb.get(l.start) {
                    Some(next) if local.text[at..next.range.start].trim().is_empty() => {
                        edits.push((at..next.range.start, format!("{}{text}{}{}", sep(&prev.kind, first), sep(last, &next.kind), indent_before(local, next.range.start))));
                    }
                    _ => edits.push((at..at, format!("{}{text}", sep(&prev.kind, first)))),
                }
            } else if let Some(next) = lb.first() {
                let at = line_start(&local.text, next.range.start);
                edits.push((at..at, format!("{text}{}", sep(last, &next.kind))));
            } else {
                let at = local.text.len();
                edits.push((at..at, format!("{}{text}\n", if local.text.trim().is_empty() { "" } else { "\n\n" })));
            }
        } else if !l.is_empty() && r.is_empty() {
            let range = if l.end < lb.len() {
                line_start(&local.text, lb[l.start].range.start)..line_start(&local.text, lb[l.end].range.start)
            } else if l.start > 0 {
                lb[l.start - 1].range.end..lb[l.end - 1].range.end
            } else {
                line_start(&local.text, lb[l.start].range.start)..lb[l.end - 1].range.end
            };
            edits.push((range, String::new()));
        }
    }
    edits.sort_by_key(|(r, _)| r.start);
    let mut out = String::new();
    let mut pos = 0;
    for (r, t) in edits {
        if r.start < pos {
            continue;
        }
        out.push_str(&local.text[pos..r.start]);
        out.push_str(&t);
        pos = r.end;
    }
    out.push_str(&local.text[pos..]);
    out
}

fn line_start(text: &str, at: usize) -> usize {
    text[..at].rfind('\n').map_or(0, |i| i + 1)
}

fn indent_before(text: &Parsed, at: usize) -> String {
    let s = line_start(&text.text, at);
    text.text[s..at].to_string()
}

/// Rebuild the file block by block: each block's own text, list items at
/// Markie's indentation, joined the way the converter joins them.
fn join(local: &Parsed, remote: &Parsed, expected: &[From]) -> String {
    let mut out = String::new();
    let mut prev: Option<&Kind> = None;
    for f in expected {
        let (p, b) = match f {
            From::Local(i) => (local, &local.blocks[*i]),
            From::Remote(i) => (remote, &remote.blocks[*i]),
        };
        if let Some(prev) = prev {
            out.push_str(sep(prev, &b.kind));
        }
        let own = &p.text[b.range.clone()];
        match &b.kind {
            Kind::Item { level, .. } if b.read_only.is_none() => out.push_str(&crate::convert::render_item(b, *level)),
            Kind::Paragraph | Kind::Heading(_) if b.read_only.is_none() => out.push_str(&crate::convert::render_block(b)),
            _ => out.push_str(own),
        }
        prev = Some(&b.kind);
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(base: &[&str], local: &[&str], remote: &[&str]) -> Vec<ChunkKind> {
        diff3(base, local, remote).into_iter().filter(|c| c.kind != ChunkKind::Same).map(|c| c.kind).collect()
    }

    #[test]
    fn changes_on_different_blocks_merge() {
        assert_eq!(kinds(&["a", "b", "c"], &["a", "B", "c"], &["a", "b", "C"]), [ChunkKind::LocalOnly, ChunkKind::RemoteOnly]);
        assert_eq!(kinds(&["a", "b"], &["a", "b", "n"], &["z", "a", "b"]), [ChunkKind::RemoteOnly, ChunkKind::LocalOnly]);
        assert_eq!(kinds(&["a", "b"], &["n", "a", "b"], &["a", "B"]), [ChunkKind::LocalOnly, ChunkKind::RemoteOnly]);
        let c = diff3(&["a", "b", "c"], &["a", "B", "c"], &["a", "b", "C"]);
        assert_eq!(c.iter().map(|c| (c.local.clone(), c.remote.clone())).collect::<Vec<_>>(), [(0..1, 0..1), (1..2, 1..2), (2..3, 2..3)]);
    }

    #[test]
    fn the_same_block_changed_on_both_sides_is_a_conflict_unless_equal() {
        assert_eq!(kinds(&["a", "b", "c"], &["a", "X", "c"], &["a", "Y", "c"]), [ChunkKind::Conflict]);
        assert_eq!(kinds(&["a", "b", "c"], &["a", "X", "c"], &["a", "X", "c"]), [ChunkKind::Both]);
        assert_eq!(kinds(&["a", "b", "c"], &["a", "c"], &["a", "b2", "c"]), [ChunkKind::Conflict]);
        // Two paragraphs edited here, one of them in Google too: only that one conflicts.
        assert_eq!(kinds(&["a", "b", "c"], &["a", "B", "C"], &["a", "b2", "c"]), [ChunkKind::Conflict, ChunkKind::LocalOnly]);
        assert!(kinds(&["a"], &["a"], &["a"]).is_empty());
    }

    #[test]
    fn lcs_matches_in_order() {
        assert_eq!(lcs(&["a", "b", "c", "d"], &["a", "c", "d", "e"]), vec![(0, 0), (2, 1), (3, 2)]);
        assert!(lcs(&[], &["a"]).is_empty());
    }

    #[test]
    fn the_merged_file_keeps_local_bytes_around_googles_blocks() {
        let local = md::parse("* one\n* two\n\nMine, edited.\n\n[ref]: https://example.com\n\nlast\n");
        let remote = md::parse("- one\n- two\n\nMine.\n\nlast, from Google\n");
        // Local block 3 ("last") is replaced by remote block 3.
        let expected = [From::Local(0), From::Local(1), From::Local(2), From::Remote(3)];
        let text = merged_text(&local, &remote, &[(3..4, 3..4)], &expected).unwrap();
        assert_eq!(text, "* one\n* two\n\nMine, edited.\n\n[ref]: https://example.com\n\nlast, from Google\n");
        // An insertion from Google between two local list items.
        let remote = md::parse("- one\n- new\n- two\n\nMine.\n\nlast\n");
        let expected = [From::Local(0), From::Remote(1), From::Local(1), From::Local(2), From::Local(3)];
        let text = merged_text(&local, &remote, &[(1..1, 1..2)], &expected).unwrap();
        assert_eq!(text, "* one\n- new\n* two\n\nMine, edited.\n\n[ref]: https://example.com\n\nlast\n");
        // A deletion from Google.
        let remote = md::parse("- one\n\nMine.\n\nlast\n");
        let expected = [From::Local(0), From::Local(2), From::Local(3)];
        let text = merged_text(&local, &remote, &[(1..2, 1..1)], &expected).unwrap();
        assert_eq!(md::parse(&text).keys(), [local.blocks[0].key.as_str(), local.blocks[2].key.as_str(), local.blocks[3].key.as_str()]);
    }
}
