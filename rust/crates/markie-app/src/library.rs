//! The Library: every document the device index found, searchable and
//! filterable by type. Plain state owned by the workspace; no rendering here.

use std::collections::BTreeMap;

use markie_core::formats::FormatKind;
use markie_core::index::{IndexSnapshot, IndexedDoc};
use markie_core::search::{Hit, LibraryQuery, search_library};

#[derive(Default)]
pub struct Library {
    docs: Vec<IndexedDoc>,
    query: LibraryQuery,
    hits: Vec<Hit>,
    counts: BTreeMap<FormatKind, usize>,
    pub scanning: bool,
    pub truncated: bool,
}

impl Library {
    pub fn set_snapshot(&mut self, snapshot: IndexSnapshot) {
        self.truncated = snapshot.truncated.is_some();
        self.docs = snapshot.files;
        self.counts.clear();
        for doc in &self.docs {
            *self.counts.entry(doc.format).or_default() += 1;
        }
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
        FormatKind::OPENABLE
            .iter()
            .filter_map(|k| self.counts.get(k).map(|n| (*k, *n)))
            .collect()
    }

    pub fn total(&self) -> usize {
        self.docs.len()
    }

    pub fn hits(&self) -> &[Hit] {
        &self.hits
    }

    pub fn doc(&self, hit: &Hit) -> &IndexedDoc {
        &self.docs[hit.index]
    }

    fn refresh(&mut self) {
        self.hits = search_library(&self.docs, &self.query);
    }
}
