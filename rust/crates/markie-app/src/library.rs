//! The Library: every document the device index found, searchable and
//! filterable by type. Plain state owned by the workspace; no rendering here.

use std::collections::BTreeMap;

use markie_core::formats::FormatKind;
use markie_core::index::{IndexSnapshot, IndexedDoc};
use markie_core::search::{Hit, LibraryQuery, search_library};

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
    query: LibraryQuery,
    hits: Vec<Hit>,
    pub scanning: bool,
    pub truncated: bool,
}

impl Library {
    pub fn set_snapshot(&mut self, snapshot: IndexSnapshot) {
        self.truncated = snapshot.truncated.is_some();
        self.docs = snapshot.files;
        self.refresh();
    }

    pub fn set_tab(&mut self, tab: LibraryTab) {
        self.tab = tab;
        self.refresh();
    }

    /// Recent and starred lists come from the registry as paths.
    pub fn set_lists(&mut self, recent: Vec<std::path::PathBuf>, starred: Vec<std::path::PathBuf>) {
        self.recent = recent.into_iter().filter_map(|p| row_for(&p)).collect();
        self.starred = starred.into_iter().filter_map(|p| row_for(&p)).collect();
        self.refresh();
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
        let mut counts: BTreeMap<FormatKind, usize> = BTreeMap::new();
        for doc in self.source() {
            *counts.entry(doc.format).or_default() += 1;
        }
        FormatKind::OPENABLE.iter().filter_map(|k| counts.get(k).map(|n| (*k, *n))).collect()
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
        let mut hits = search_library(self.source(), &self.query);
        if self.tab != LibraryTab::All && self.query.text.trim().is_empty() {
            // Recent keeps the registry's order (newest open first), not mtime.
            hits.sort_by_key(|h| h.index);
        }
        self.hits = hits;
    }
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
