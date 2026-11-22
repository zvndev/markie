//! The Library: every document the device index found, searchable and
//! filterable by type. Plain state owned by the workspace; no rendering here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use markie_core::doc_text::{SearchResponse, SearchRow, search_pool};
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

/// The Library panel's sort menu (`library-document-filters.tsx`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SortOrder {
    #[default]
    Default,
    Recent,
    Name,
    Type,
}

impl SortOrder {
    pub const ALL: [SortOrder; 4] = [SortOrder::Default, SortOrder::Recent, SortOrder::Name, SortOrder::Type];

    pub fn label(self) -> &'static str {
        match self {
            SortOrder::Default => "Default order",
            SortOrder::Recent => "Most recent",
            SortOrder::Name => "Name",
            SortOrder::Type => "Type",
        }
    }
}

/// What the background body search needs (Electron's `doc-search`).
pub struct BodySearch {
    pub pool: Arc<Vec<SearchRow>>,
    pub text: String,
    pub formats: Vec<FormatKind>,
}

struct BodyResults {
    text: String,
    formats: Vec<FormatKind>,
    docs: Vec<IndexedDoc>,
    hits: Vec<Hit>,
}

#[derive(Default)]
pub struct Library {
    /// Index rows plus recent files the walk missed, for body search. Built
    /// once per index, shared like `docs`.
    pool: Arc<Vec<SearchRow>>,
    body: Option<BodyResults>,
    pub sort: SortOrder,
    pub tab: LibraryTab,
    /// Shared between the Browse panel and search, never copied.
    docs: Rc<Vec<IndexedDoc>>,
    recent: Vec<IndexedDoc>,
    starred: Vec<IndexedDoc>,
    /// Lowercase keys for each list, built when the list changes (off the
    /// main thread for the index), not per query. Shared with `docs`.
    docs_index: Rc<SearchIndex>,
    recent_index: SearchIndex,
    starred_index: SearchIndex,
    query: LibraryQuery,
    hits: Vec<Hit>,
    pub scanning: bool,
    pub truncated: bool,
}

impl Library {
    /// Takes an `IndexSnapshot` (its search keys built here) or a
    /// [`PreparedSnapshot`] built off the main thread.
    pub fn set_snapshot(&mut self, prepared: impl Into<PreparedSnapshot>) {
        let PreparedSnapshot { snapshot, index } = prepared.into();
        self.truncated = snapshot.truncated.is_some();
        self.docs = Rc::new(snapshot.files);
        self.docs_index = Rc::new(index);
        self.pool = Arc::new(Vec::new());
        self.body = None;
        self.refresh();
    }

    /// Build the body-search pool: the index plus `recent` files outside it.
    pub fn build_pool(&mut self, recent: &[PathBuf]) {
        self.pool = Arc::new(search_pool(&self.docs, recent));
    }

    /// The body search to run for the current text, when one is owed.
    pub fn body_search(&self) -> Option<BodySearch> {
        if self.tab != LibraryTab::All || self.current_body().is_some() {
            return None;
        }
        Some(BodySearch { pool: self.pool.clone(), text: self.query.text.clone(), formats: self.query.formats.clone() })
    }

    /// Ranked hits from `markie_core::doc_text::search_documents`. Dropped when
    /// the query moved on while it ran.
    pub fn set_body_results(&mut self, text: &str, formats: &[FormatKind], resp: SearchResponse) {
        if resp.superseded || text != self.query.text || formats != self.query.formats.as_slice() {
            return;
        }
        let by_path: HashMap<&std::path::Path, &IndexedDoc> = self.docs.iter().map(|d| (d.path.as_path(), d)).collect();
        let mut docs = Vec::with_capacity(resp.results.len());
        let mut hits = Vec::with_capacity(resp.results.len());
        for (index, r) in resp.results.into_iter().enumerate() {
            docs.push(by_path.get(r.path.as_path()).map(|d| (*d).clone()).unwrap_or(IndexedDoc {
                path: r.path,
                name: r.name,
                dir: r.dir,
                mtime_ms: r.mtime_ms,
                size: 0,
                format: r.format,
                snippet: None,
            }));
            let (excerpt, marks) = r.excerpt.map_or((None, Vec::new()), |e| (Some(e.text), e.marks));
            hits.push(Hit { index, score: 0, excerpt, marks });
        }
        self.body = Some(BodyResults { text: text.into(), formats: formats.to_vec(), docs, hits });
        self.refresh();
    }

    fn current_body(&self) -> Option<&BodyResults> {
        self.body.as_ref().filter(|b| {
            self.tab == LibraryTab::All && self.sort == SortOrder::Default && b.text == self.query.text && b.formats == self.query.formats
        })
    }

    /// Use another Library's index without copying it.
    pub fn share_docs_from(&mut self, other: &Library) {
        self.truncated = other.truncated;
        self.docs = other.docs.clone();
        self.docs_index = other.docs_index.clone();
        self.pool = other.pool.clone();
        self.body = None;
        self.refresh();
    }

    pub fn set_tab(&mut self, tab: LibraryTab) {
        self.tab = tab;
        self.refresh();
    }

    /// Recent and starred lists come from the registry as paths.
    /// Rows for registry paths. Each needs a stat, so the window calls this
    /// off the main thread and hands the result to [`Self::set_rows`].
    pub fn rows_for(paths: Vec<std::path::PathBuf>) -> Vec<IndexedDoc> {
        paths.into_iter().filter_map(|p| row_for(&p)).collect()
    }

    pub fn set_rows(&mut self, recent: Vec<IndexedDoc>, starred: Vec<IndexedDoc>) {
        self.recent = recent;
        self.starred = starred;
        self.recent_index = SearchIndex::new(&self.recent);
        self.starred_index = SearchIndex::new(&self.starred);
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

    /// One type or every type, as the Library's type menu picks.
    pub fn set_only_format(&mut self, kind: Option<FormatKind>) {
        self.query.formats = kind.into_iter().collect();
        self.refresh();
    }

    pub fn only_format(&self) -> Option<FormatKind> {
        match self.query.formats.as_slice() {
            [k] => Some(*k),
            _ => None,
        }
    }

    pub fn set_sort(&mut self, sort: SortOrder) {
        self.sort = sort;
        self.refresh();
    }

    pub fn text(&self) -> &str {
        &self.query.text
    }

    pub fn query_active(&self) -> bool {
        !self.query.text.trim().is_empty() || !self.query.formats.is_empty() || self.sort != SortOrder::Default
    }

    pub fn clear_query(&mut self) {
        self.query = LibraryQuery::default();
        self.sort = SortOrder::Default;
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
        match self.current_body() {
            Some(b) => &b.docs[hit.index],
            None => &self.source()[hit.index],
        }
    }

    /// The index rows (for the Projects pass).
    pub fn docs(&self) -> &[IndexedDoc] {
        &self.docs
    }

    fn refresh(&mut self) {
        if let Some(b) = self.current_body() {
            self.hits = b.hits.clone();
            return;
        }
        let index: &SearchIndex = match self.tab {
            LibraryTab::All => &self.docs_index,
            LibraryTab::Recent => &self.recent_index,
            LibraryTab::Starred => &self.starred_index,
        };
        let mut hits = index.search(self.source(), &self.query);
        if self.tab != LibraryTab::All && self.query.text.trim().is_empty() {
            // Recent keeps the registry's order (newest open first), not mtime.
            hits.sort_by_key(|h| h.index);
        }
        let docs = self.source();
        match self.sort {
            SortOrder::Default => {}
            SortOrder::Recent => hits.sort_by(|a, b| docs[b.index].mtime_ms.total_cmp(&docs[a.index].mtime_ms)),
            SortOrder::Name => hits.sort_by_key(|h| docs[h.index].name.to_lowercase()),
            SortOrder::Type => hits.sort_by_key(|h| (docs[h.index].format.label(), docs[h.index].name.to_lowercase())),
        }
        self.hits = hits;
    }
}

/// A snapshot with its search keys built, off the main thread.
pub struct PreparedSnapshot {
    snapshot: IndexSnapshot,
    index: SearchIndex,
}

impl PreparedSnapshot {
    pub fn new(snapshot: IndexSnapshot) -> Self {
        let index = SearchIndex::new(&snapshot.files);
        Self { snapshot, index }
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.snapshot.elapsed_ms
    }

    pub fn len(&self) -> usize {
        self.snapshot.files.len()
    }

    pub fn files(&self) -> &[IndexedDoc] {
        &self.snapshot.files
    }
}

impl From<IndexSnapshot> for PreparedSnapshot {
    fn from(snapshot: IndexSnapshot) -> Self {
        Self::new(snapshot)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn doc(name: &str, ms: f64, format: FormatKind) -> IndexedDoc {
        IndexedDoc {
            path: PathBuf::from(format!("/x/{name}")),
            name: name.into(),
            dir: PathBuf::from("/x"),
            mtime_ms: ms,
            size: 1,
            format,
            snippet: None,
        }
    }

    #[test]
    fn sorts_and_filters_one_type() {
        let mut lib = Library::default();
        lib.set_snapshot(IndexSnapshot {
            files: vec![doc("b.md", 1.0, FormatKind::Markdown), doc("a.txt", 3.0, FormatKind::Text), doc("c.md", 2.0, FormatKind::Markdown)],
            ..Default::default()
        });
        lib.set_sort(SortOrder::Name);
        let names: Vec<_> = lib.hits().iter().map(|h| lib.doc(h).name.clone()).collect();
        assert_eq!(names, ["a.txt", "b.md", "c.md"]);
        lib.set_sort(SortOrder::Recent);
        assert_eq!(lib.doc(&lib.hits()[0].clone()).name, "a.txt");
        lib.set_only_format(Some(FormatKind::Markdown));
        assert_eq!(lib.hits().len(), 2);
        assert_eq!(lib.only_format(), Some(FormatKind::Markdown));
        assert!(lib.query_active());
        lib.clear_query();
        assert_eq!(lib.hits().len(), 3);
        assert!(!lib.query_active());
    }

    #[test]
    fn body_results_replace_the_instant_filter_until_the_query_moves() {
        let mut lib = Library::default();
        lib.set_snapshot(IndexSnapshot { files: vec![doc("a.md", 1.0, FormatKind::Markdown)], ..Default::default() });
        lib.set_text("zebra");
        assert!(lib.hits().is_empty());
        let req = lib.body_search().unwrap();
        assert_eq!(req.text, "zebra");
        let resp = SearchResponse {
            results: vec![markie_core::doc_text::SearchHit::for_test("/far/away.docx", FormatKind::Docx, "…a zebra…")],
            ..Default::default()
        };
        lib.set_body_results("stale", &[], resp.clone());
        assert!(lib.hits().is_empty(), "a stale answer is dropped");
        lib.set_body_results("zebra", &[], resp);
        assert_eq!(lib.hits().len(), 1);
        assert_eq!(lib.doc(&lib.hits()[0].clone()).name, "away.docx");
        assert!(lib.body_search().is_none(), "already answered");
        lib.set_text("zebr");
        assert!(lib.body_search().is_some());
    }
}
