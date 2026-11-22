//! How far apart two versions of a document are, in lines. An exact port of
//! `src/lib/line-diff.ts`: the counts the history rows and the outside-edit
//! dialog show.

/// Past this many lines on either side the LCS table is skipped for a
/// multiset count, as `MAX_DIFF_LINES`.
pub const MAX_DIFF_LINES: usize = 5000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineDiff {
    /// In `remote` but not `local`.
    pub added: usize,
    /// In `local` but not `remote`.
    pub removed: usize,
    pub same: usize,
}

/// `splitLines`: a trailing newline ends the last line; `\r` stays part of
/// the line, as JavaScript's `split("\n")` keeps it.
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n').unwrap_or(text).split('\n').collect()
}

fn counting_diff(a: &[&str], b: &[&str]) -> LineDiff {
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for line in a {
        *counts.entry(line).or_default() += 1;
    }
    let mut same = 0;
    for line in b {
        if let Some(n) = counts.get_mut(line).filter(|n| **n > 0) {
            same += 1;
            *n -= 1;
        }
    }
    LineDiff { added: b.len() - same, removed: a.len() - same, same }
}

pub fn line_diff(local: &str, remote: &str) -> LineDiff {
    let a = split_lines(local);
    let b = split_lines(remote);
    if a.len() > MAX_DIFF_LINES || b.len() > MAX_DIFF_LINES {
        return counting_diff(&a, &b);
    }
    let mut prev = vec![0u32; b.len() + 1];
    let mut cur = vec![0u32; b.len() + 1];
    for x in &a {
        cur[0] = 0;
        for (j, y) in b.iter().enumerate() {
            cur[j + 1] = if x == y { prev[j] + 1 } else { prev[j + 1].max(cur[j]) };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let same = prev[b.len()] as usize;
    LineDiff { added: b.len() - same, removed: a.len() - same, same }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values are lineDiff's own output on these inputs (run in Node).
    #[test]
    fn counts_like_line_diff_ts() {
        assert_eq!(line_diff("", ""), LineDiff { added: 0, removed: 0, same: 0 });
        assert_eq!(line_diff("a\nb\n", "a\nb"), LineDiff { added: 0, removed: 0, same: 2 });
        assert_eq!(line_diff("a\nb\nc", "a\nx\nc\nd"), LineDiff { added: 2, removed: 1, same: 2 });
        assert_eq!(line_diff("a\r\nb", "a\nb"), LineDiff { added: 1, removed: 1, same: 1 });
        assert_eq!(line_diff("a\n\n", "a\n"), LineDiff { added: 0, removed: 1, same: 1 });
    }

    #[test]
    fn long_documents_fall_back_to_counting() {
        let a: String = (0..6000).map(|i| format!("{i}\n")).collect();
        let b: String = (0..6000).rev().map(|i| format!("{i}\n")).collect();
        // LCS would say 1 line in common; the multiset count says all of them.
        assert_eq!(line_diff(&a, &b), LineDiff { added: 0, removed: 0, same: 6000 });
    }
}
