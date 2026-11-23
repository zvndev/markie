//! What a document card's thumbnail shows: the start of the document as a
//! handful of blocks (title, headings, paragraphs, lists, a table), which
//! `doc_grid.rs` draws in miniature. No web view and no image: plain data,
//! built once per file version off the main thread and kept in a cache.
//!
//! - [`from_text`] and [`read_file`] build a [`Preview`]. Both are blocking
//!   and belong on a background thread.
//! - [`PreviewCache`] holds them by key and stamp (a file's path with its
//!   modified time and size; a cloud document's id with its version), says
//!   which are still owed, and can save and load the cloud ones.

use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use markie_core::doc_text;
use markie_core::formats::FormatKind;
use serde::{Deserialize, Serialize};

/// A thumbnail never shows more than this many lines.
pub const MAX_LINES: usize = 16;
/// Text documents are read this far and no further.
pub const HEAD_BYTES: u64 = 12 * 1024;
const MAX_CHARS: usize = 140;
const TABLE_ROWS: usize = 7;
const TABLE_COLS: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Block {
    Title(String),
    Heading(String),
    Text(String),
    Bullet(String),
    /// A task list item, done or not.
    Check(bool, String),
    /// "1." and its text.
    Numbered(String, String),
    Quote(String),
    /// One line of code or of a data file, indentation kept.
    Code(String),
    Rule,
    /// Rows of cells; the first row is the header.
    Table(Vec<Vec<String>>),
}

impl Block {
    /// How many thumbnail lines the block takes, for the line budget.
    fn lines(&self) -> usize {
        match self {
            Block::Table(rows) => rows.len(),
            Block::Text(t) => 1 + t.chars().count() / 48,
            _ => 1,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preview {
    pub blocks: Vec<Block>,
}

impl Preview {
    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }
}

fn clip(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(MAX_CHARS) {
        Some((at, _)) => text[..at].to_string(),
        None => text.to_string(),
    }
}

/// Markdown's inline marks removed: emphasis, code ticks, links and images
/// keep their words.
fn inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '*' | '`' => {}
            '~' if chars.get(i + 1) == Some(&'~') => i += 1,
            '!' if chars.get(i + 1) == Some(&'[') => {}
            '[' => {
                // [words](target) keeps the words; a bare bracket stays.
                let close = chars[i..].iter().position(|c| *c == ']').map(|n| i + n);
                match close {
                    Some(close) if chars.get(close + 1) == Some(&'(') => {
                        out.extend(chars[i + 1..close].iter());
                        let end = chars[close..].iter().position(|c| *c == ')').map(|n| close + n).unwrap_or(chars.len() - 1);
                        i = end;
                    }
                    _ => out.push(c),
                }
            }
            '<' => {
                // An inline tag such as <br> or <span …>.
                match chars[i..].iter().position(|c| *c == '>') {
                    Some(n) if n < 40 && chars.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic() || *c == '/') => i += n,
                    _ => out.push(c),
                }
            }
            _ => out.push(c),
        }
        i += 1;
    }
    clip(&out)
}

fn table_row(line: &str) -> Vec<String> {
    line.trim().trim_matches('|').split('|').take(TABLE_COLS).map(|c| inline(c)).collect()
}

fn is_table_rule(line: &str) -> bool {
    let t = line.trim();
    t.contains('-') && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

fn numbered(line: &str) -> Option<(String, &str)> {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 3 {
        return None;
    }
    let rest = &line[digits..];
    let rest = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?;
    Some((format!("{}.", &line[..digits]), rest))
}

struct Builder {
    blocks: Vec<Block>,
    lines: usize,
    paragraph: String,
}

impl Builder {
    fn new() -> Self {
        Self { blocks: Vec::new(), lines: 0, paragraph: String::new() }
    }
    fn full(&self) -> bool {
        self.lines >= MAX_LINES
    }
    fn flush(&mut self) {
        if !self.paragraph.is_empty() {
            let text = inline(&std::mem::take(&mut self.paragraph));
            if !text.is_empty() {
                self.push(Block::Text(text));
            }
        }
    }
    fn push(&mut self, block: Block) {
        if self.full() {
            return;
        }
        self.lines += block.lines();
        self.blocks.push(block);
    }
    fn finish(mut self) -> Preview {
        self.flush();
        Preview { blocks: self.blocks }
    }
}

fn markdown(text: &str) -> Preview {
    let mut b = Builder::new();
    let mut lines = text.lines().peekable();
    // Front matter is settings, not the document.
    if lines.peek().is_some_and(|l| l.trim() == "---") {
        let rest: Vec<&str> = text.lines().skip(1).collect();
        if let Some(end) = rest.iter().position(|l| matches!(l.trim(), "---" | "...")) {
            lines = text.lines().peekable();
            for _ in 0..end + 2 {
                lines.next();
            }
        }
    }
    let mut titled = false;
    let mut fence: Option<&str> = None;
    while let Some(raw) = lines.next() {
        if b.full() {
            break;
        }
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if let Some(mark) = fence {
            if trimmed.starts_with(mark) {
                fence = None;
            } else {
                b.push(Block::Code(clip_keep_indent(line)));
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            b.flush();
            fence = Some(&trimmed[..3]);
            continue;
        }
        if trimmed.is_empty() {
            b.flush();
            continue;
        }
        if trimmed.starts_with("<!--") || (trimmed.starts_with("![") && trimmed.ends_with(')')) {
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            b.flush();
            let text = inline(trimmed[hashes..].trim().trim_end_matches('#'));
            if text.is_empty() {
                continue;
            }
            if !titled && hashes == 1 && b.blocks.is_empty() {
                b.push(Block::Title(text));
            } else {
                b.push(Block::Heading(text));
            }
            titled = true;
            continue;
        }
        if matches!(trimmed, "---" | "***" | "___" | "- - -" | "* * *") {
            b.flush();
            b.push(Block::Rule);
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('>') {
            b.flush();
            b.push(Block::Quote(inline(rest)));
            continue;
        }
        if trimmed.starts_with('|') {
            b.flush();
            let mut rows = vec![table_row(trimmed)];
            while let Some(next) = lines.peek() {
                let next = next.trim();
                if !next.starts_with('|') {
                    break;
                }
                if !is_table_rule(next) && rows.len() < TABLE_ROWS {
                    rows.push(table_row(next));
                }
                lines.next();
            }
            b.push(Block::Table(rows));
            continue;
        }
        let item = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")).or_else(|| trimmed.strip_prefix("+ "));
        if let Some(item) = item {
            b.flush();
            let lower = item.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("[ ] ").map(|_| &item[4..]) {
                b.push(Block::Check(false, inline(rest)));
            } else if let Some(rest) = lower.strip_prefix("[x] ").map(|_| &item[4..]) {
                b.push(Block::Check(true, inline(rest)));
            } else {
                b.push(Block::Bullet(inline(item)));
            }
            continue;
        }
        if let Some((marker, rest)) = numbered(trimmed) {
            b.flush();
            b.push(Block::Numbered(marker, inline(rest)));
            continue;
        }
        if !b.paragraph.is_empty() {
            b.paragraph.push(' ');
        }
        b.paragraph.push_str(trimmed);
    }
    b.finish()
}

fn clip_keep_indent(line: &str) -> String {
    let line = line.replace('\t', "  ");
    match line.char_indices().nth(MAX_CHARS) {
        Some((at, _)) => line[..at].to_string(),
        None => line,
    }
}

/// Plain writing: paragraphs as they stand. With `titled`, a short first
/// line is the title, as a Word document usually opens.
fn prose(text: &str, titled: bool) -> Preview {
    let mut b = Builder::new();
    for line in text.lines() {
        if b.full() {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if titled && b.blocks.is_empty() && line.chars().count() <= 70 {
            b.push(Block::Title(clip(line)));
        } else {
            b.push(Block::Text(clip(line)));
        }
    }
    b.finish()
}

/// Code and data: each line as it stands, in the fixed-width face.
fn literal(text: &str) -> Preview {
    let blocks = text.lines().filter(|l| !l.trim().is_empty()).take(MAX_LINES).map(|l| Block::Code(clip_keep_indent(l.trim_end()))).collect();
    Preview { blocks }
}

/// One CSV record's cells, quotes honoured.
fn csv_cells(line: &str, delimiter: char) -> Vec<String> {
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cell.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            c if c == delimiter && !quoted => cells.push(clip(&std::mem::take(&mut cell))),
            c => cell.push(c),
        }
    }
    cells.push(clip(&cell));
    cells.truncate(TABLE_COLS);
    cells
}

fn csv(text: &str) -> Preview {
    let first = text.lines().next().unwrap_or_default();
    let delimiter = [',', ';', '\t'].into_iter().max_by_key(|d| first.matches(*d).count()).unwrap_or(',');
    let rows: Vec<Vec<String>> = text.lines().filter(|l| !l.trim().is_empty()).take(TABLE_ROWS + 3).map(|l| csv_cells(l, delimiter)).collect();
    if rows.is_empty() {
        return Preview::default();
    }
    Preview { blocks: vec![Block::Table(rows)] }
}

/// The preview of a document's text. `text` is the start of a text file, or
/// the words taken out of an office file.
pub fn from_text(format: FormatKind, text: &str) -> Preview {
    let text = text.trim_start_matches('\u{feff}');
    match format {
        FormatKind::Markdown | FormatKind::Darkmown => markdown(text),
        FormatKind::Csv => csv(text),
        FormatKind::Text => prose(text, false),
        FormatKind::Docx | FormatKind::Doc | FormatKind::Rtf | FormatKind::Odt | FormatKind::Html => prose(text, true),
        FormatKind::Json | FormatKind::Yaml | FormatKind::Xml => literal(text),
        FormatKind::Unsupported => Preview::default(),
    }
}

/// The preview of a file's bytes: the head of a text file, or the whole of an
/// office or HTML file, whose words are taken out first.
pub fn from_bytes(format: FormatKind, bytes: &[u8]) -> Option<Preview> {
    let preview = match format {
        FormatKind::Unsupported => return None,
        FormatKind::Docx | FormatKind::Doc | FormatKind::Rtf | FormatKind::Odt | FormatKind::Html => {
            let text = doc_text::text_from_bytes(bytes, format)?;
            // The extractor joins a document's paragraphs with spaces on one
            // line for search; sentences stand in for paragraphs then.
            let text = if text.contains('\n') { text } else { sentences(&text) };
            from_text(format, &text)
        }
        _ => {
            // A head cut mid line loses that line, never shows half of it.
            let text = String::from_utf8_lossy(bytes);
            let whole = bytes.len() < HEAD_BYTES as usize;
            let text = if whole { &text[..] } else { text.rfind('\n').map_or(&text[..], |at| &text[..at]) };
            from_text(format, text)
        }
    };
    (!preview.is_empty()).then_some(preview)
}

fn sentences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0;
    for part in text.split_inclusive(". ") {
        out.push_str(part);
        run += part.len();
        if run > 60 {
            out.push('\n');
            run = 0;
        }
    }
    out
}

/// Read a file for its preview. Blocking: call it off the main thread. A file
/// that is gone, too large to open or not text gives None, and the card shows
/// a clean tile for its type.
pub fn read_file(path: &Path, format: FormatKind) -> Option<Preview> {
    let office = matches!(format, FormatKind::Docx | FormatKind::Doc | FormatKind::Rtf | FormatKind::Odt | FormatKind::Html);
    let file = std::fs::File::open(path).ok()?;
    let limit = if office {
        if file.metadata().ok()?.len() > doc_text::byte_limit(format) {
            return None;
        }
        doc_text::byte_limit(format)
    } else {
        HEAD_BYTES
    };
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).ok()?;
    from_bytes(format, &bytes)
}

// ------------------------------------------------------------------ cache

/// A preview someone wants: its cache key, and the stamp that says which
/// version of the document it is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Want {
    pub key: String,
    pub stamp: String,
}

impl Want {
    /// A file on disk, stamped with the modified time and size its row
    /// already carries (no stat here).
    pub fn file(path: &Path, mtime_ms: f64, size: u64) -> Self {
        Self { key: path.to_string_lossy().into_owned(), stamp: format!("{}:{size}", mtime_ms as i64) }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Lookup {
    Ready(Arc<Preview>),
    /// Looked at, and there is nothing to show: draw the type's tile.
    Nothing,
    /// Not built yet (or built for an older version).
    Owed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Saved {
    stamp: String,
    preview: Option<Preview>,
}

/// Previews by key. One entry per document; a new stamp replaces the old.
#[derive(Default)]
pub struct PreviewCache {
    map: HashMap<String, (String, Option<Arc<Preview>>)>,
    pending: HashSet<String>,
}

/// Past this many entries, ones nobody asked for lately are dropped.
const MAX_ENTRIES: usize = 800;

impl PreviewCache {
    pub fn lookup(&self, want: &Want) -> Lookup {
        match self.map.get(&want.key) {
            Some((stamp, Some(preview))) if *stamp == want.stamp => Lookup::Ready(preview.clone()),
            Some((stamp, None)) if *stamp == want.stamp => Lookup::Nothing,
            // An older version's picture beats an empty card while the new one loads.
            Some((_, Some(preview))) => Lookup::Ready(preview.clone()),
            _ => Lookup::Owed,
        }
    }

    /// Of `wants`, the ones to build now: not cached for this stamp and not
    /// already being built. They are marked as being built.
    pub fn claim(&mut self, wants: impl IntoIterator<Item = Want>) -> Vec<Want> {
        let mut owed = Vec::new();
        for want in wants {
            let fresh = self.map.get(&want.key).is_some_and(|(stamp, _)| *stamp == want.stamp);
            if !fresh && self.pending.insert(want.key.clone()) {
                owed.push(want);
            }
        }
        owed
    }

    pub fn put(&mut self, want: Want, preview: Option<Preview>) {
        self.pending.remove(&want.key);
        self.map.insert(want.key, (want.stamp, preview.map(Arc::new)));
    }

    /// Some previews are still being built.
    pub fn busy(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Keep the cache bounded: drop entries outside `keep` once it is large.
    pub fn trim(&mut self, keep: &HashSet<String>) {
        if self.map.len() > MAX_ENTRIES {
            self.map.retain(|key, _| keep.contains(key));
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// The entries whose key starts with `prefix`, as JSON, for a file.
    pub fn save(&self, prefix: &str) -> String {
        let saved: HashMap<&str, Saved> = self
            .map
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, (stamp, preview))| (key.as_str(), Saved { stamp: stamp.clone(), preview: preview.as_deref().cloned() }))
            .collect();
        serde_json::to_string(&saved).unwrap_or_else(|_| "{}".into())
    }

    /// Take saved entries in. Ones already here win: they are newer.
    pub fn load(&mut self, json: &str) {
        let saved: HashMap<String, Saved> = serde_json::from_str(json).unwrap_or_default();
        for (key, entry) in saved {
            self.map.entry(key).or_insert((entry.stamp, entry.preview.map(Arc::new)));
        }
    }
}

/// Build the previews of files, in order. Blocking: run it on a background
/// thread and [`PreviewCache::put`] each answer on the main one.
pub fn build_files(wants: Vec<(Want, PathBuf, FormatKind)>) -> Vec<(Want, Option<Preview>)> {
    wants.into_iter().map(|(want, path, format)| (want, read_file(&path, format))).collect()
}

#[cfg(test)]
mod tests {
    use super::{Block, Lookup, PreviewCache, Want, from_bytes, from_text, read_file};
    use markie_core::formats::FormatKind;

    #[test]
    fn markdown_starts_with_its_title_and_keeps_the_shape_of_the_page() {
        let text = "---\ntitle: x\n---\n# Quarterly **plan**\n\nGoals for the\nquarter. See [the doc](https://example.com).\n\n## Ship\n\n- Rich view\n- [x] Done\n- [ ] Not yet\n1. First\n\n> Keep it short.\n\n---\n\n```js\nlet a = 1;\n```\n";
        let got = from_text(FormatKind::Markdown, text).blocks;
        assert_eq!(
            got,
            [
                Block::Title("Quarterly plan".into()),
                Block::Text("Goals for the quarter. See the doc.".into()),
                Block::Heading("Ship".into()),
                Block::Bullet("Rich view".into()),
                Block::Check(true, "Done".into()),
                Block::Check(false, "Not yet".into()),
                Block::Numbered("1.".into(), "First".into()),
                Block::Quote("Keep it short.".into()),
                Block::Rule,
                Block::Code("let a = 1;".into()),
            ]
        );
    }

    #[test]
    fn a_markdown_table_keeps_its_cells_and_drops_the_rule_row() {
        let got = from_text(FormatKind::Markdown, "| Who | What |\n| --- | --- |\n| Alice | Draft |\n| Bob | Review |\n\nAfter.").blocks;
        assert_eq!(got[0], Block::Table(vec![vec!["Who".into(), "What".into()], vec!["Alice".into(), "Draft".into()], vec!["Bob".into(), "Review".into()]]));
        assert_eq!(got[1], Block::Text("After.".into()));
    }

    #[test]
    fn only_the_first_top_heading_is_the_title() {
        let got = from_text(FormatKind::Markdown, "Intro line.\n\n# Late heading\n\n# Another").blocks;
        assert_eq!(got, [Block::Text("Intro line.".into()), Block::Heading("Late heading".into()), Block::Heading("Another".into())]);
    }

    #[test]
    fn a_csv_file_is_a_table_and_data_files_keep_their_lines() {
        let got = from_text(FormatKind::Csv, "Plan,Seats,\"Monthly, USD\"\nFree,1,0\n").blocks;
        assert_eq!(got, [Block::Table(vec![vec!["Plan".into(), "Seats".into(), "Monthly, USD".into()], vec!["Free".into(), "1".into(), "0".into()]])]);
        let semi = from_text(FormatKind::Csv, "a;b\n1;2\n").blocks;
        assert_eq!(semi, [Block::Table(vec![vec!["a".into(), "b".into()], vec!["1".into(), "2".into()]])]);
        let json = from_text(FormatKind::Json, "{\n  \"zoom\": 1.1\n}\n").blocks;
        assert_eq!(json, [Block::Code("{".into()), Block::Code("  \"zoom\": 1.1".into()), Block::Code("}".into())]);
    }

    #[test]
    fn plain_text_has_no_title_and_word_text_takes_its_first_line() {
        assert_eq!(from_text(FormatKind::Text, "Markie 0.9.7\n\nFixed\n").blocks, [Block::Text("Markie 0.9.7".into()), Block::Text("Fixed".into())]);
        assert_eq!(from_text(FormatKind::Docx, "Offer letter\nDear Sam,\n").blocks, [Block::Title("Offer letter".into()), Block::Text("Dear Sam,".into())]);
    }

    #[test]
    fn a_preview_is_bounded_however_long_the_document() {
        let long = "word ".repeat(400);
        let text = format!("# T\n\n{}\n", (0..200).map(|i| format!("- item {i} {long}")).collect::<Vec<_>>().join("\n"));
        let got = from_text(FormatKind::Markdown, &text);
        assert!(got.blocks.len() <= super::MAX_LINES);
        assert!(got.blocks.iter().all(|b| match b {
            Block::Bullet(t) => t.chars().count() <= 140,
            _ => true,
        }));
    }

    #[test]
    fn empty_and_unknown_files_have_no_preview() {
        assert_eq!(from_bytes(FormatKind::Markdown, b"\n\n"), None);
        assert_eq!(from_bytes(FormatKind::Unsupported, b"PK\x03\x04"), None);
        assert!(from_bytes(FormatKind::Markdown, b"hello").is_some());
    }

    #[test]
    fn a_long_text_file_is_read_only_at_its_head_and_never_shows_half_a_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let line = "0123456789 abcdefghij\n";
        std::fs::write(&path, line.repeat(5_000)).unwrap();
        let got = read_file(&path, FormatKind::Text).unwrap();
        assert!(got.blocks.iter().all(|b| *b == Block::Text("0123456789 abcdefghij".into())));
        assert_eq!(read_file(&dir.path().join("gone.md"), FormatKind::Markdown), None);
    }

    #[test]
    fn the_cache_builds_each_version_once() {
        let mut cache = PreviewCache::default();
        let v1 = Want { key: "/a.md".into(), stamp: "1:10".into() };
        assert_eq!(cache.lookup(&v1), Lookup::Owed);
        // Asked for twice before it lands: built once.
        assert_eq!(cache.claim([v1.clone()]), [v1.clone()]);
        assert!(cache.claim([v1.clone()]).is_empty());
        cache.put(v1.clone(), Some(from_text(FormatKind::Markdown, "# A")));
        assert!(matches!(cache.lookup(&v1), Lookup::Ready(_)));
        assert!(cache.claim([v1.clone()]).is_empty(), "the same version is never rebuilt");
        // The file changed: the old picture shows while the new one is owed.
        let v2 = Want { key: "/a.md".into(), stamp: "2:12".into() };
        assert!(matches!(cache.lookup(&v2), Lookup::Ready(_)));
        assert_eq!(cache.claim([v2.clone()]), [v2.clone()]);
        cache.put(v2.clone(), None);
        assert_eq!(cache.lookup(&v2), Lookup::Nothing);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn cloud_previews_survive_a_restart_and_file_ones_are_not_saved() {
        let mut cache = PreviewCache::default();
        let cloud = Want { key: "cloud:http://localhost:1:abc".into(), stamp: "v3".into() };
        cache.put(cloud.clone(), Some(from_text(FormatKind::Markdown, "# Roadmap")));
        cache.put(Want { key: "/local.md".into(), stamp: "1:1".into() }, Some(from_text(FormatKind::Markdown, "# Local")));
        let json = cache.save("cloud:");
        assert!(!json.contains("local.md"));
        let mut next = PreviewCache::default();
        next.load(&json);
        assert_eq!(next.len(), 1);
        assert!(matches!(next.lookup(&cloud), Lookup::Ready(p) if p.blocks == [Block::Title("Roadmap".into())]));
        next.load("not json");
        assert_eq!(next.len(), 1);
    }
}
