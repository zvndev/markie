//! Document statistics for the status bar. Mirrors `src/lib/stats.ts`.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DocStats {
    pub words: usize,
    pub chars: usize,
    pub lines: usize,
    pub headings: usize,
    pub reading_minutes: usize,
}

pub fn compute(content: &str) -> DocStats {
    let words = content.split_whitespace().count();
    DocStats {
        words,
        chars: content.chars().count(),
        lines: if content.is_empty() { 0 } else { content.split('\n').count() },
        headings: content
            .lines()
            .filter(|l| {
                let hashes = l.chars().take_while(|c| *c == '#').count();
                (1..=6).contains(&hashes) && l[hashes..].starts_with([' ', '\t'])
            })
            .count(),
        reading_minutes: if words == 0 { 0 } else { (words as f64 / 200.0).round().max(1.0) as usize },
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn counts() {
        let s = super::compute("# Title\n\nSome words here.\n## Two");
        assert_eq!((s.words, s.lines, s.headings, s.reading_minutes), (7, 4, 2, 1));
        assert_eq!(super::compute("").lines, 0);
    }
}
