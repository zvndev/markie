//! Search: finding documents across the device index, and finding text inside
//! one document. In-document find mirrors `src/lib/doc-search.ts`.

use crate::formats::FormatKind;
use crate::index::IndexedDoc;

#[derive(Clone, Copy, Debug, Default)]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
}

/// Byte ranges into `text`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match {
    pub from: usize,
    pub to: usize,
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

/// Non-overlapping literal matches, left to right. The query is never a regex.
pub fn find_matches(text: &str, query: &str, opts: FindOptions) -> Vec<Match> {
    if query.is_empty() {
        return Vec::new();
    }
    // Case folding that keeps byte offsets: only ASCII-insensitive when the
    // lowercase form changes length, which keeps offsets valid for the source.
    let (hay, needle) = if opts.case_sensitive {
        (text.to_string(), query.to_string())
    } else {
        let lower = text.to_lowercase();
        if lower.len() == text.len() {
            (lower, query.to_lowercase())
        } else {
            (text.to_ascii_lowercase(), query.to_ascii_lowercase())
        }
    };
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = hay[from..].find(&needle).map(|i| i + from) {
        let end = at + needle.len();
        let ok = !opts.whole_word
            || (!is_word(text[..at].chars().next_back()) && !is_word(text[end..].chars().next()));
        if ok {
            out.push(Match { from: at, to: end });
            from = end;
        } else {
            from = at + text[at..].chars().next().map_or(1, char::len_utf8);
        }
        if from >= hay.len() {
            break;
        }
    }
    out
}

/// The first match at or after `position`, wrapping to the top.
pub fn match_at_or_after(matches: &[Match], position: usize) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    Some(matches.iter().position(|m| m.from >= position).unwrap_or(0))
}

/// Step with wrap-around in both directions.
pub fn step_match(count: usize, current: Option<usize>, delta: isize) -> Option<usize> {
    if count == 0 {
        return None;
    }
    let count = count as isize;
    Some(match current {
        None if delta >= 0 => 0,
        None => (count - 1) as usize,
        Some(c) => (((c as isize + delta) % count + count) % count) as usize,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub index: usize,
    pub score: u32,
    /// A one-line excerpt around the first body match, when the body matched.
    pub excerpt: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct LibraryQuery {
    pub text: String,
    /// Empty means every format.
    pub formats: Vec<FormatKind>,
}

fn excerpt_around(body: &str, at: usize, len: usize) -> String {
    let start = body[..at]
        .char_indices()
        .rev()
        .take(48)
        .last()
        .map_or(0, |(i, _)| i);
    let end = body[at + len..]
        .char_indices()
        .take(72)
        .last()
        .map_or(at + len, |(i, c)| at + len + i + c.len_utf8());
    let mut s: String = body[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        s.insert(0, '…');
    }
    if end < body.len() {
        s.push('…');
    }
    s
}

/// Position of `needle` (already ASCII-lowercase) in `hay`, ignoring ASCII
/// case, without allocating a lowercase copy of `hay`.
fn find_ascii_ci(hay: &str, needle: &str) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    let first = *n.first()?;
    if n.len() > h.len() {
        return None;
    }
    let last_start = h.len() - n.len();
    let (lo, up) = (first.to_ascii_lowercase(), first.to_ascii_uppercase());
    let mut from = 0;
    while from <= last_start {
        let at = from + memchr::memchr2(lo, up, &h[from..=last_start])?;
        if h[at + 1..at + n.len()].eq_ignore_ascii_case(&n[1..]) {
            return Some(at);
        }
        from = at + 1;
    }
    None
}

/// The lowercase keys of every document, built once per index snapshot so a
/// query does not lowercase 100,000 names and paths on every keystroke, and
/// the recency order an empty query shows.
#[derive(Clone, Debug, Default)]
pub struct SearchIndex {
    names: Vec<String>,
    paths: Vec<String>,
    by_recency: Vec<usize>,
}

impl SearchIndex {
    pub fn new(docs: &[IndexedDoc]) -> Self {
        let mut by_recency: Vec<usize> = (0..docs.len()).collect();
        by_recency.sort_by(|&a, &b| {
            docs[b].mtime_ms.partial_cmp(&docs[a].mtime_ms).unwrap_or(std::cmp::Ordering::Equal)
        });
        Self {
            names: docs.iter().map(|d| d.name.to_lowercase()).collect(),
            paths: docs.iter().map(|d| d.path.to_string_lossy().to_lowercase()).collect(),
            by_recency,
        }
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    /// [`search_library`] over the documents this index was built from.
    pub fn search(&self, docs: &[IndexedDoc], query: &LibraryQuery) -> Vec<Hit> {
        debug_assert_eq!(docs.len(), self.names.len(), "index built from other documents");
        let terms: Vec<String> = query.text.split_whitespace().map(str::to_lowercase).collect();
        let format_ok = |d: &IndexedDoc| query.formats.is_empty() || query.formats.contains(&d.format);
        if terms.is_empty() {
            return self
                .by_recency
                .iter()
                .filter(|&&i| format_ok(&docs[i]))
                .map(|&index| Hit { index, score: 0, excerpt: None })
                .collect();
        }
        let mut hits: Vec<(Hit, f64)> = docs
            .iter()
            .enumerate()
            .filter(|(_, d)| format_ok(d))
            .filter_map(|(index, doc)| {
                let (name, path) = (&self.names[index], &self.paths[index]);
                let body = doc.snippet.as_deref().unwrap_or("");
                // Lowercased only when a non-ASCII term needs it, and once.
                let mut body_lower: Option<String> = None;
                let mut score = 0;
                let mut excerpt = None;
                for term in &terms {
                    if name.starts_with(term.as_str()) {
                        score += 40;
                    } else if name.contains(term.as_str()) {
                        score += 30;
                    } else if path.contains(term.as_str()) {
                        score += 10;
                    } else if term.is_ascii() {
                        let at = find_ascii_ci(body, term)?;
                        score += 3;
                        if excerpt.is_none() {
                            excerpt = Some(excerpt_around(body, at, term.len()));
                        }
                    } else {
                        let lower = body_lower.get_or_insert_with(|| body.to_lowercase());
                        let at = lower.find(term.as_str())?;
                        score += 3;
                        if excerpt.is_none() && lower.len() == body.len() {
                            excerpt = Some(excerpt_around(body, at, term.len()));
                        }
                    }
                }
                Some((Hit { index, score, excerpt }, doc.mtime_ms))
            })
            .collect();
        hits.sort_by(|a, b| {
            b.0.score
                .cmp(&a.0.score)
                .then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
        });
        hits.into_iter().map(|(h, _)| h).collect()
    }
}

/// Rank documents for the library and global search. Every term must match the
/// name, path or body. Name matches rank above path, path above body, and
/// recency breaks ties. An empty query lists everything, most recent first.
///
/// Builds a [`SearchIndex`] each call; keep one per snapshot when searching
/// the same documents repeatedly.
pub fn search_library(docs: &[IndexedDoc], query: &LibraryQuery) -> Vec<Hit> {
    SearchIndex::new(docs).search(docs, query)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn literal_non_overlapping_matches() {
        assert_eq!(find_matches("aaaa", "aa", FindOptions::default()).len(), 2);
        assert_eq!(find_matches("a.b axb", "a.b", FindOptions::default()).len(), 1);
        let ww = FindOptions { whole_word: true, ..Default::default() };
        let m = find_matches("concatenate cat", "cat", ww);
        assert_eq!(m, vec![Match { from: 12, to: 15 }]);
        assert_eq!(find_matches("Hello hello", "HELLO", FindOptions::default()).len(), 2);
    }

    #[test]
    fn stepping_wraps() {
        assert_eq!(step_match(3, Some(2), 1), Some(0));
        assert_eq!(step_match(3, Some(0), -1), Some(2));
        assert_eq!(step_match(0, None, 1), None);
    }

    fn doc(name: &str, body: &str, mtime: f64, format: FormatKind) -> IndexedDoc {
        IndexedDoc {
            path: PathBuf::from(format!("/home/me/notes/{name}")),
            name: name.into(),
            dir: PathBuf::from("/home/me/notes"),
            mtime_ms: mtime,
            size: body.len() as u64,
            format,
            snippet: Some(body.into()),
        }
    }

    #[test]
    fn ranks_name_over_body_and_filters_by_format() {
        let docs = vec![
            doc("roadmap.md", "nothing here", 1.0, FormatKind::Markdown),
            doc("notes.md", "the roadmap for q3", 5.0, FormatKind::Markdown),
            doc("roadmap.csv", "a,b", 9.0, FormatKind::Csv),
        ];
        let hits = search_library(&docs, &LibraryQuery { text: "roadmap".into(), formats: vec![] });
        assert_eq!(hits.iter().map(|h| h.index).collect::<Vec<_>>(), vec![2, 0, 1]);
        assert!(hits[2].excerpt.as_deref().unwrap().contains("roadmap"));
        let md = search_library(
            &docs,
            &LibraryQuery { text: "roadmap".into(), formats: vec![FormatKind::Markdown] },
        );
        assert_eq!(md.iter().map(|h| h.index).collect::<Vec<_>>(), vec![0, 1]);
        let all = search_library(&docs, &LibraryQuery::default());
        assert_eq!(all[0].index, 2, "empty query lists most recent first");
    }

    #[test]
    fn body_match_ignores_case_and_handles_non_ascii() {
        let docs = vec![
            doc("a.md", "Intro\nThe ROADMAP for Q3", 1.0, FormatKind::Markdown),
            doc("b.md", "Ünïcode Straße notes", 2.0, FormatKind::Markdown),
        ];
        let idx = SearchIndex::new(&docs);
        let hits = idx.search(&docs, &LibraryQuery { text: "roadmap q3".into(), formats: vec![] });
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].score, 6);
        assert!(hits[0].excerpt.as_deref().unwrap().contains("ROADMAP"));
        let hits = idx.search(&docs, &LibraryQuery { text: "straße".into(), formats: vec![] });
        assert_eq!(hits.iter().map(|h| h.index).collect::<Vec<_>>(), vec![1]);
        let hits = idx.search(&docs, &LibraryQuery { text: "STRASSE".into(), formats: vec![] });
        assert!(hits.is_empty(), "no folding beyond to_lowercase");
        assert_eq!(find_ascii_ci("abcABC", "bc"), Some(1));
        assert_eq!(find_ascii_ci("ab", "abc"), None);
        assert_eq!(find_ascii_ci("xxAbC", "abc"), Some(2));
    }
}
