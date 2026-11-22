//! The Library: every document the device index found, searchable and
//! filterable by type. Plain state owned by the workspace; no rendering here.

use std::collections::BTreeMap;

use markie_core::formats::FormatKind;
use markie_core::index::{IndexSnapshot, IndexedDoc};
use markie_core::search::{Hit, LibraryQuery, SearchIndex};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LibraryTab {
    #[default]
    All,
    Recent,
    Starred,
}

#[derive(Default)]
pub struct Library {
    pub tab: LibraryTab,
    docs: Vec<IndexedDoc>,
    recent: Vec<IndexedDoc>,
    starred: Vec<IndexedDoc>,
    /// Lowercase keys for each list, built when the list changes, not per query.
    docs_index: SearchIndex,
    recent_index: SearchIndex,
    starred_index: SearchIndex,
    /// `format_counts` for each tab, built with the list: the sidebar draws
    /// them every frame.
    counts: [Vec<(FormatKind, usize)>; 3],
    query: LibraryQuery,
    hits: Vec<Hit>,
    pub scanning: bool,
    pub truncated: bool,
}

/// A snapshot with its search keys and counts built, off the main thread.
pub struct PreparedSnapshot {
    snapshot: IndexSnapshot,
    index: SearchIndex,
    counts: Vec<(FormatKind, usize)>,
}

impl PreparedSnapshot {
    pub fn new(snapshot: IndexSnapshot) -> Self {
        let index = SearchIndex::new(&snapshot.files);
        let counts = count_formats(&snapshot.files);
        Self { snapshot, index, counts }
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.snapshot.elapsed_ms
    }

    pub fn len(&self) -> usize {
        self.snapshot.files.len()
    }
}

impl Library {
    pub fn set_snapshot(&mut self, prepared: PreparedSnapshot) {
        let PreparedSnapshot { snapshot, index, counts } = prepared;
        self.truncated = snapshot.truncated.is_some();
        self.docs = snapshot.files;
        self.docs_index = index;
        self.counts[0] = counts;
        self.refresh();
    }

    pub fn set_tab(&mut self, tab: LibraryTab) {
        self.tab = tab;
        self.refresh();
    }

    /// Recent and starred lists come from the registry as paths.
    /// Rows for registry paths. Each needs a stat, so call it off the main
    /// thread and hand the result to [`Self::set_rows`].
    pub fn rows_for(paths: Vec<std::path::PathBuf>) -> Vec<IndexedDoc> {
        paths.into_iter().filter_map(|p| row_for(&p)).collect()
    }

    pub fn set_rows(&mut self, recent: Vec<IndexedDoc>, starred: Vec<IndexedDoc>) {
        self.recent = recent;
        self.starred = starred;
        self.recent_index = SearchIndex::new(&self.recent);
        self.starred_index = SearchIndex::new(&self.starred);
        self.counts[1] = count_formats(&self.recent);
        self.counts[2] = count_formats(&self.starred);
        // The All tab's hits do not depend on these lists.
        if self.tab != LibraryTab::All {
            self.refresh();
        }
    }

    pub fn set_text(&mut self, text: &str) {
        if self.query.text != text {
            self.query.text = text.to_string();
            self.refresh();
        }
    }

    pub fn toggle_format(&mut self, kind: FormatKind) {
        if let Some(i) = self.query.formats.iter().position(|k| *k == kind) {
            self.query.formats.remove(i);
        } else {
            self.query.formats.push(kind);
        }
        self.refresh();
    }

    pub fn clear_formats(&mut self) {
        self.query.formats.clear();
        self.refresh();
    }

    pub fn is_filtered(&self, kind: FormatKind) -> bool {
        self.query.formats.contains(&kind)
    }

    pub fn has_filters(&self) -> bool {
        !self.query.formats.is_empty()
    }

    /// Formats present in the index, in display order, with their counts.
    pub fn format_counts(&self) -> Vec<(FormatKind, usize)> {
        self.counts[self.tab_slot()].clone()
    }

    fn tab_slot(&self) -> usize {
        match self.tab {
            LibraryTab::All => 0,
            LibraryTab::Recent => 1,
            LibraryTab::Starred => 2,
        }
    }

    pub fn total(&self) -> usize {
        self.source().len()
    }

    fn source(&self) -> &[IndexedDoc] {
        match self.tab {
            LibraryTab::All => &self.docs,
            LibraryTab::Recent => &self.recent,
            LibraryTab::Starred => &self.starred,
        }
    }

    pub fn hits(&self) -> &[Hit] {
        &self.hits
    }

    pub fn doc(&self, hit: &Hit) -> &IndexedDoc {
        &self.source()[hit.index]
    }

    fn refresh(&mut self) {
        let index = match self.tab {
            LibraryTab::All => &self.docs_index,
            LibraryTab::Recent => &self.recent_index,
            LibraryTab::Starred => &self.starred_index,
        };
        let mut hits = index.search(self.source(), &self.query);
        if self.tab != LibraryTab::All && self.query.text.trim().is_empty() {
            // Recent keeps the registry's order (newest open first), not mtime.
            hits.sort_by_key(|h| h.index);
        }
        self.hits = hits;
    }
}

fn count_formats(docs: &[IndexedDoc]) -> Vec<(FormatKind, usize)> {
    let mut counts: BTreeMap<FormatKind, usize> = BTreeMap::new();
    for doc in docs {
        *counts.entry(doc.format).or_default() += 1;
    }
    FormatKind::OPENABLE.iter().filter_map(|k| counts.get(k).map(|n| (*k, *n))).collect()
}

/// A Library row for a path that is not necessarily in the device index.
fn row_for(path: &std::path::Path) -> Option<IndexedDoc> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(IndexedDoc {
        path: path.to_path_buf(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        dir: path.parent()?.to_path_buf(),
        mtime_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0),
        size: meta.len(),
        format: markie_core::formats::classify(&path.to_string_lossy()),
        snippet: None,
    })
}
