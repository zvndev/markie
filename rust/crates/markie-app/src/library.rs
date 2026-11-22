//! The Library: every document the device index found, searchable and
//! filterable by type. Plain state owned by the workspace; no rendering here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use markie_core::doc_text::{SearchResponse, SearchRow, search_pool};
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
    query: LibraryQuery,
    hits: Vec<Hit>,
    pub scanning: bool,
    pub truncated: bool,
    /// When each Recent row was last opened, in ms (`lastOpenedAt`).
    opened_at: HashMap<PathBuf, f64>,
}

impl Library {
    pub fn set_snapshot(&mut self, snapshot: IndexSnapshot) {
        self.truncated = snapshot.truncated.is_some();
        self.docs = Rc::new(snapshot.files);
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
        self.pool = other.pool.clone();
        self.body = None;
        self.refresh();
    }

    pub fn set_tab(&mut self, tab: LibraryTab) {
        self.tab = tab;
        self.refresh();
    }

    /// The registry's `last_opened_at` per path, for "Most recent".
    pub fn set_opened_at(&mut self, opened: impl IntoIterator<Item = (PathBuf, String)>) {
        self.opened_at = opened.into_iter().map(|(p, at)| (p, markie_core::clock::parse_iso(&at).map_or(0., |ms| ms as f64))).collect();
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
        if self.tab != LibraryTab::All {
            // The Library panel's lists filter and sort like Electron's
            // `queryLibraryDocuments`, never ranking or reading bodies.
            self.hits = query_rows(self.source(), &self.query, self.sort, &self.opened_at);
            return;
        }
        let mut hits = search_library(self.source(), &self.query);
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

/// `LibraryFormat` ids, which Electron's Type sort compares as text.
pub fn library_format_id(kind: FormatKind) -> &'static str {
    match kind {
        FormatKind::Markdown => "markdown",
        FormatKind::Darkmown => "darkmown",
        FormatKind::Text => "text",
        FormatKind::Csv => "csv",
        FormatKind::Json => "json",
        FormatKind::Yaml => "yaml",
        FormatKind::Xml => "xml",
        FormatKind::Docx => "docx",
        FormatKind::Doc => "doc",
        FormatKind::Rtf => "rtf",
        FormatKind::Html => "html",
        FormatKind::Odt => "odt",
        FormatKind::Unsupported => "other",
    }
}

/// `matchesLibraryDocument` for a native row: the type, then every word in
/// the name or the path. Native rows carry no body, so none is searched.
fn matches_row(doc: &IndexedDoc, query: &LibraryQuery) -> bool {
    if !query.formats.is_empty() && !query.formats.contains(&doc.format) {
        return false;
    }
    let words: Vec<String> = query.text.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return true;
    }
    let fields = [doc.name.to_lowercase(), doc.path.to_string_lossy().to_lowercase()];
    words.iter().all(|w| fields.iter().any(|f| f.contains(w.as_str())))
}

/// `queryLibraryDocuments` over rows in the panel's order (newest open
/// first): filter, then a stable sort by `compareLibraryDocuments`. Its key
/// is the path; "Most recent" compares `lastOpenedAt` (0 when unknown).
pub fn query_rows(docs: &[IndexedDoc], query: &LibraryQuery, sort: SortOrder, opened_at: &HashMap<PathBuf, f64>) -> Vec<Hit> {
    let mut hits: Vec<Hit> = (0..docs.len())
        .filter(|&i| matches_row(&docs[i], query))
        .map(|index| Hit { index, score: 0, excerpt: None, marks: Vec::new() })
        .collect();
    let lower = |i: usize| docs[i].name.to_lowercase();
    let key = |i: usize| docs[i].path.to_string_lossy().into_owned();
    let tie = |a: usize, b: usize| lower(a).cmp(&lower(b)).then_with(|| key(a).to_lowercase().cmp(&key(b).to_lowercase())).then_with(|| key(a).cmp(&key(b)));
    match sort {
        SortOrder::Default => {}
        SortOrder::Recent => {
            let at = |i: usize| opened_at.get(&docs[i].path).copied().filter(|t| t.is_finite() && *t > 0.).unwrap_or(0.);
            hits.sort_by(|a, b| at(b.index).total_cmp(&at(a.index)).then_with(|| tie(a.index, b.index)))
        }
        SortOrder::Name => hits.sort_by(|a, b| tie(a.index, b.index)),
        SortOrder::Type => hits.sort_by(|a, b| {
            library_format_id(docs[a.index].format).cmp(library_format_id(docs[b.index].format)).then_with(|| tie(a.index, b.index))
        }),
    }
    hits
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

    /// Electron's `queryLibraryDocuments`, run by
    /// rust/scripts/parity/library-settings-parity.mjs on the same rows.
    #[test]
    fn recent_query_matches_electrons_query_library_documents() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("fixtures/library-settings-parity.json")).unwrap();
        let opened: HashMap<PathBuf, f64> = fixture["library"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (PathBuf::from(r["path"].as_str().unwrap()), r["at"].as_f64().unwrap()))
            .collect();
        let rows: Vec<IndexedDoc> = fixture["library"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let path = PathBuf::from(r["path"].as_str().unwrap());
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                IndexedDoc { dir: path.parent().unwrap().into(), format: markie_core::formats::classify(&name), name, path, mtime_ms: 0., size: 1, snippet: None }
            })
            .collect();
        let format_of = |id: &str| match id {
            "all" => None,
            "markdown" => Some(FormatKind::Markdown),
            "other" => Some(FormatKind::Unsupported),
            "doc" => Some(FormatKind::Doc),
            other => panic!("{other}"),
        };
        let sort_of = |id: &str| match id {
            "default" => SortOrder::Default,
            "recent" => SortOrder::Recent,
            "name" => SortOrder::Name,
            _ => SortOrder::Type,
        };
        let cases = fixture["library"]["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 112);
        for case in cases {
            let query = LibraryQuery { text: case["search"].as_str().unwrap().into(), formats: format_of(case["format"].as_str().unwrap()).into_iter().collect() };
            let got: Vec<String> = query_rows(&rows, &query, sort_of(case["sort"].as_str().unwrap()), &opened).iter().map(|h| rows[h.index].path.to_string_lossy().into_owned()).collect();
            let want: Vec<String> = case["paths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect();
            assert_eq!(got, want, "{case}");
        }
    }

    #[test]
    fn the_recent_tab_filters_without_ranking_or_reading_bodies() {
        let mut lib = Library::default();
        let mut with_body = doc("z.md", 1.0, FormatKind::Markdown);
        with_body.snippet = Some("alpha inside".into());
        lib.recent = vec![doc("b alpha.md", 1.0, FormatKind::Markdown), doc("alpha.md", 2.0, FormatKind::Markdown), with_body];
        lib.set_tab(LibraryTab::Recent);
        lib.set_text("alpha");
        let names: Vec<_> = lib.hits().iter().map(|h| lib.doc(h).name.clone()).collect();
        assert_eq!(names, ["b alpha.md", "alpha.md"], "panel order kept, the body is not searched");
    }
}
