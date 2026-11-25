//! The Cloud page when signed in: Electron's cloud workspace
//! (`library.tsx` with `presentation="workspace"`, `cloud-view.tsx`,
//! `library-document-filters.tsx` and `document-cloud-library.tsx`).
//!
//! One page, no tabs, laid out to be calm (Markie RS's own layout; the
//! rules and the words are Electron's). The header says the connection and
//! the count. One toolbar row holds the name filter, whose documents (All,
//! Only me, Shared by me, Shared with me), the area, type and order. Share
//! requests wait in a one-line strip that opens. Then synced and shared
//! files as cards (`doc_grid.rs`), newest first, and the document snapshots
//! under their own heading.
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_cloud::docs::{DocMeta, Role};
use markie_cloud::platform::{PlatformClient, SnapshotMeta};
use markie_cloud::sharing::SharedByMeDoc;
use markie_core::formats::{self, FormatKind};

use super::Workspace;
use super::chrome::{icon, menu_panel};
use super::cloud::{Scope, name};
use super::doc_grid::{self, CardEvent, DocCard, Grid, GridView, Mark, MarkTone, Section, Thumb};
use super::doc_preview::{self, Lookup, Want};
use super::rail::filter_field;
use super::ui::{self, Kind, Tone};
use crate::actions::{NewDocument, Open};
use crate::themes::{self, Palette, mix};

// ------------------------------------------------------------------ model

/// How a document reached this account (`CloudSource`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Source {
    OnlyMe,
    ByMe,
    WithMe,
}

/// `CLOUD_SOURCES`: id, label and the phrase the empty state uses.
pub(super) const SOURCES: [(Source, &str, &str, &str); 3] = [
    (Source::OnlyMe, "only-me", "Only me", "only you can see"),
    (Source::ByMe, "by-me", "Shared by me", "you've shared"),
    (Source::WithMe, "with-me", "Shared with me", "shared with you"),
];

/// The registry setting that remembers the chips (`markie.cloud.sources.v1`).
pub(super) const SOURCES_SETTING: &str = "cloud_sources";

pub(super) fn sources_from_setting(raw: Option<&str>) -> Vec<Source> {
    let parsed: Vec<String> = raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or_default();
    SOURCES.iter().filter(|(_, id, ..)| parsed.iter().any(|p| p == id)).map(|(s, ..)| *s).collect()
}

pub(super) fn sources_to_setting(sources: &[Source]) -> String {
    let ids: Vec<&str> = SOURCES.iter().filter(|(s, ..)| sources.contains(s)).map(|(_, id, ..)| *id).collect();
    serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into())
}

/// `TYPES` in library-document-filters.tsx. `Unsupported` is "Other".
pub(super) const TYPES: [(Option<FormatKind>, &str); 14] = [
    (None, "All types"),
    (Some(FormatKind::Markdown), "Markdown"),
    (Some(FormatKind::Text), "Text"),
    (Some(FormatKind::Docx), "DOCX"),
    (Some(FormatKind::Doc), "DOC"),
    (Some(FormatKind::Rtf), "RTF"),
    (Some(FormatKind::Odt), "ODT"),
    (Some(FormatKind::Darkmown), "Darkmown"),
    (Some(FormatKind::Csv), "CSV"),
    (Some(FormatKind::Json), "JSON"),
    (Some(FormatKind::Yaml), "YAML"),
    (Some(FormatKind::Xml), "XML"),
    (Some(FormatKind::Html), "HTML"),
    (Some(FormatKind::Unsupported), "Other"),
];

/// `SORTS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(super) enum Sort {
    #[default]
    Default,
    Recent,
    Name,
    Type,
    /// Newest first; documents with no known time last.
    Created,
}

pub(super) const SORTS: [(Sort, &str); 5] =
    [(Sort::Default, "Default order"), (Sort::Recent, "Most recent"), (Sort::Name, "Name"), (Sort::Type, "Type"), (Sort::Created, "Date created")];

/// When an entry was created, in ms: the server's time for a document it
/// lists, the file's birth time for one only on this Mac. None when unknown.
pub(super) fn entry_created_ms(e: &Entry) -> Option<f64> {
    match &e.doc {
        Some(d) => d.created_at.as_deref().and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok()).map(|d| d.timestamp_millis() as f64),
        None if e.share.is_none() => e.path.as_deref().and_then(crate::library::birth_ms),
        None => None,
    }
}

/// `LibraryDocumentQuery`.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Query {
    pub search: String,
    pub format: Option<FormatKind>,
    pub sort: Sort,
}

impl Query {
    pub fn active(&self) -> bool {
        !self.search.is_empty() || self.format.is_some() || self.sort != Sort::Default
    }
    fn searching(&self) -> bool {
        !self.search.trim().is_empty() || self.format.is_some()
    }
}

/// `libraryDocumentFormat`: the type bucket of a name.
pub(super) fn format_of(name: &str) -> FormatKind {
    formats::classify(name)
}

/// The bucket's key, which the Type order compares (`metadata.format`).
fn format_key(f: FormatKind) -> &'static str {
    match f {
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

/// One row of the list (`CloudEntry`).
#[derive(Clone, Debug)]
pub(super) struct Entry {
    pub key: String,
    pub source: Source,
    pub name: String,
    /// The file on this device, when there is one.
    pub path: Option<PathBuf>,
    pub updated_at: Option<String>,
    /// The listing row; absent for a document only the shared list named.
    pub doc: Option<DocMeta>,
    pub share: Option<SharedByMeDoc>,
}

fn time(value: Option<&str>) -> i64 {
    value
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

fn later(a: Option<String>, b: Option<String>) -> Option<String> {
    if time(b.as_deref()) > time(a.as_deref()) { b } else { a }
}

/// `newestFirst`: most recently updated first, then by name.
fn newest_first(a: &Entry, b: &Entry) -> std::cmp::Ordering {
    time(b.updated_at.as_deref())
        .cmp(&time(a.updated_at.as_deref()))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
}

/// Every document the area allows, each tagged with its source (the
/// `matched` memo before the query). `local` is files on this device bound to
/// this account that the listing does not have yet (not pushed, paused, in
/// conflict): they are the owner's, only theirs until shared.
pub(super) fn entries(
    docs: &[DocMeta],
    by_me: Option<&[SharedByMeDoc]>,
    local: &[(PathBuf, Option<String>)],
    path_for: impl Fn(&str) -> Option<PathBuf>,
    opened_at: impl Fn(&std::path::Path) -> Option<String>,
    area: Option<&str>,
) -> Vec<Entry> {
    // sync.js `listLibrary`: a document with a file on this device is a
    // registry row, and its time is when that file was last opened here;
    // only a document with no local copy takes the listing's time.
    let time_of = |path: &Option<PathBuf>, listed: Option<String>| match path {
        Some(p) => opened_at(p),
        None => listed,
    };
    let in_area = |row: Option<&DocMeta>| area.is_none() || row.and_then(|r| r.area_id.as_deref()) == area;
    let mut unclaimed: HashMap<&str, &SharedByMeDoc> = by_me.unwrap_or_default().iter().map(|d| (d.id.as_str(), d)).collect();
    let mut out = Vec::new();
    for doc in docs.iter().filter(|d| in_area(Some(d))) {
        let path = path_for(&doc.id);
        if doc.shared {
            out.push(Entry {
                key: format!("item:{}", doc.id),
                source: Source::WithMe,
                name: doc.name.clone(),
                updated_at: time_of(&path, doc.updated_at.clone()),
                path,
                doc: Some(doc.clone()),
                share: None,
            });
            continue;
        }
        let share = unclaimed.remove(doc.id.as_str()).cloned();
        out.push(Entry {
            key: format!("item:{}", doc.id),
            source: if share.is_some() { Source::ByMe } else { Source::OnlyMe },
            name: doc.name.clone(),
            updated_at: match &share {
                Some(s) => later(time_of(&path, doc.updated_at.clone()), s.updated_at.clone()),
                None => time_of(&path, doc.updated_at.clone()),
            },
            path,
            doc: Some(doc.clone()),
            share,
        });
    }
    if area.is_none() {
        for (path, id) in local {
            out.push(Entry {
                key: format!("item:{}", id.clone().unwrap_or_else(|| path.display().to_string())),
                source: Source::OnlyMe,
                name: name(path),
                path: Some(path.clone()),
                updated_at: opened_at(path),
                doc: None,
                share: None,
            });
        }
    }
    // Shared documents with no listing row of their own.
    let mut rest: Vec<&SharedByMeDoc> = unclaimed.into_values().collect();
    rest.sort_by(|a, b| a.id.cmp(&b.id));
    for doc in rest.into_iter().filter(|_| area.is_none()) {
        out.push(Entry {
            key: format!("share:{}", doc.id),
            source: Source::ByMe,
            name: doc.name.clone(),
            path: path_for(&doc.id),
            updated_at: doc.updated_at.clone(),
            doc: None,
            share: Some(doc.clone()),
        });
    }
    out.sort_by(newest_first);
    out
}

/// `queryLibraryDocuments`: the text and type filters, then the order.
pub(super) fn query(rows: Vec<Entry>, q: &Query) -> Vec<Entry> {
    let words: Vec<String> = q.search.trim().to_lowercase().split_whitespace().map(str::to_string).collect();
    let mut rows: Vec<Entry> = rows
        .into_iter()
        .filter(|e| q.format.is_none_or(|f| format_of(&e.name) == f))
        .filter(|e| {
            let fields = [e.name.to_lowercase(), e.path.as_ref().map(|p| p.display().to_string().to_lowercase()).unwrap_or_default()];
            words.iter().all(|w| fields.iter().any(|f| f.contains(w)))
        })
        .collect();
    if q.sort != Sort::Default {
        rows.sort_by(|a, b| {
            let primary = match q.sort {
                Sort::Recent => time(b.updated_at.as_deref()).cmp(&time(a.updated_at.as_deref())),
                Sort::Type => format_key(format_of(&a.name)).cmp(format_key(format_of(&b.name))),
                Sort::Created => entry_created_ms(b).unwrap_or(0.).total_cmp(&entry_created_ms(a).unwrap_or(0.)),
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            };
            primary.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.key.cmp(&b.key))
        });
    }
    rows
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lists {
    Loading,
    Incomplete,
    Ready,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// `cloudBandText`.
pub(super) fn band_text(total: usize, shown: usize, lists: Lists) -> String {
    if total > 0 {
        return if shown == total {
            plural(total, "document", "documents")
        } else {
            format!("{shown} of {}", plural(total, "document", "documents"))
        };
    }
    match lists {
        Lists::Loading => "Checking your cloud…".into(),
        Lists::Incomplete => "Some of your cloud didn't load".into(),
        Lists::Ready => "Nothing in the cloud yet".into(),
    }
}

/// `shareBadgeText`: "Shared with 2 · 1 invited".
pub(super) fn share_badge_text(doc: &SharedByMeDoc) -> String {
    let mut bits = Vec::new();
    if doc.member_count > 0 {
        bits.push(format!("Shared with {}", doc.member_count));
    }
    if doc.pending_count > 0 {
        bits.push(format!("{} invited", doc.pending_count));
    }
    if bits.is_empty() { "Shared".into() } else { bits.join(" · ") }
}

/// `sourceBadgeText`.
pub(super) fn source_badge_text(entry: &Entry, share_list_known: bool) -> String {
    if let Some(share) = &entry.share {
        return share_badge_text(share);
    }
    match entry.source {
        Source::WithMe => "Shared with you".into(),
        _ if share_list_known => "Only you".into(),
        _ => "Yours".into(),
    }
}

/// `cloudEmptyCopy`: the sentence names the chips that are on.
pub(super) fn empty_copy(sources: &[Source], searching: bool) -> (String, &'static str) {
    let phrases: Vec<&str> = SOURCES.iter().filter(|(s, ..)| sources.contains(s)).map(|(.., p)| *p).collect();
    let which = if phrases.is_empty() { String::new() } else { format!(" {}", phrases.join(" or ")) };
    if searching {
        return (
            format!("No documents{which} match this search"),
            if phrases.is_empty() { "Try other words or another type." } else { "Try other words, or turn on more of the buttons above." },
        );
    }
    if !phrases.is_empty() {
        return (format!("No documents{which} yet"), "Turn on more of the buttons above, or choose All.");
    }
    ("Nothing in your cloud yet".into(), "Documents you sync, and documents people share with you, show up here.")
}

/// `fileSize` in document-cloud-library.tsx.
pub(super) fn file_size(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        let kb = bytes as f64 / 1024.;
        return if bytes < 10 * 1024 { format!("{kb:.1} KB") } else { format!("{kb:.0} KB") };
    }
    format!("{:.1} MB", bytes as f64 / (1024. * 1024.))
}

/// `updatedAgo` in relative-time.ts.
pub(super) fn updated_ago(ms: i64, now: chrono::DateTime<chrono::Local>) -> String {
    use chrono::{Datelike as _, TimeZone as _};
    if ms <= 0 {
        return String::new();
    }
    let Some(then) = chrono::Local.timestamp_millis_opt(ms).single() else { return String::new() };
    let delta = (now - then).num_seconds().max(0);
    if delta < 60 {
        return "just now".into();
    }
    if delta < 3600 {
        return format!("{}m ago", delta / 60);
    }
    let days = (now.date_naive() - then.date_naive()).num_days();
    if days <= 0 {
        return format!("{}h ago", delta / 3600);
    }
    if days == 1 {
        return "yesterday".into();
    }
    if then.year() == now.year() {
        return then.format("%b %-d").to_string();
    }
    then.year().to_string()
}

/// The metadata line of a snapshot card.
pub(super) fn snapshot_meta(row: &SnapshotMeta, now: chrono::DateTime<chrono::Local>) -> String {
    let role = match row.role {
        Role::Owner => "Owner",
        Role::Editor => "Editor",
        Role::Viewer => "Viewer",
    };
    [
        format_key(row.format).to_uppercase(),
        role.to_string(),
        format!("v{}", row.version),
        file_size(row.byte_length),
        updated_ago(row.updated_at as i64, now),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

/// `errorPresentation` for the snapshot list.
pub(super) fn snapshot_error(error: &str) -> (String, String) {
    let lower = error.to_lowercase();
    if lower.contains("does not provide the new document-sharing service") {
        return ("Snapshots unavailable on this server".into(), "Update the Markie server to use document snapshots.".into());
    }
    if lower.contains("could not be reached") || lower.contains("connection") || lower.contains("fetch failed") {
        return ("Snapshots could not be reached".into(), "Check your connection and try again.".into());
    }
    if lower.contains("sign in again") || lower.contains("session") || lower.contains("account changed") {
        return ("Account confirmation needed".into(), "Sign in again, then refresh snapshots.".into());
    }
    ("Snapshots could not load".into(), error.to_string())
}

// ------------------------------------------------------------------ state

/// Which of the page's menus is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Menu {
    Type,
    Sort,
    Area,
}

// ------------------------------------------------------------------ render

/// `.markie-select-button`, with an optional kicker before the value.
pub(super) fn select_button(id: impl Into<ElementId>, kicker: Option<&str>, label: &str, open: bool, p: &Palette) -> Stateful<Div> {
    let bg = mix(p.background, p.surface2, 0.72);
    div()
        .id(id)
        .h(px(32.))
        .flex()
        .items_center()
        .gap(px(7.2))
        .pl(px(10.4))
        .pr(px(8.8))
        .rounded(px(7.))
        .border_1()
        .border_color(if open { mix(p.blue, p.border, 0.66) } else { p.border })
        .bg(bg)
        .text_size(px(11.5))
        .text_color(if open { p.foreground } else { p.muted })
        .hover(|s| s.text_color(p.foreground).border_color(mix(p.foreground, p.border, 0.18)))
        .cursor_pointer()
        .when_some(kicker.map(str::to_string), |el, k| el.child(div().flex_none().text_color(p.muted.opacity(0.82)).child(k)))
        .child(div().flex_1().min_w_0().truncate().when(kicker.is_some(), |el| el.text_color(p.foreground.opacity(0.85))).child(label.to_string()))
        .child(icon("markie/select-chevron.svg", 13., if open { p.foreground } else { p.muted }))
}

/// What the header's chip says about the server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Connection {
    Checking,
    Connected,
    /// The server could not be reached.
    Offline,
    /// It answered, but something did not load.
    Problem,
}

impl Connection {
    pub(super) fn label(self) -> &'static str {
        match self {
            Connection::Checking => "Checking",
            Connection::Connected => "Connected",
            Connection::Offline => "Offline",
            Connection::Problem => "Needs attention",
        }
    }
}

/// `booting`: nothing has arrived yet. `error`: why the listing failed.
pub(super) fn connection(booting: bool, error: Option<&str>) -> Connection {
    match error {
        Some(e) => {
            let lower = e.to_lowercase();
            let offline = ["reach", "connection", "offline", "network", "timed out", "fetch failed"].iter().any(|w| lower.contains(w));
            if offline { Connection::Offline } else { Connection::Problem }
        }
        None if booting => Connection::Checking,
        None => Connection::Connected,
    }
}

/// The server's address, shown only when it is not the usual one.
pub(super) fn server_label(origin: &str, primary: &str) -> Option<String> {
    if origin.trim_end_matches('/') == primary.trim_end_matches('/') {
        return None;
    }
    let host = origin.split_once("://").map_or(origin, |(_, rest)| rest).trim_end_matches('/');
    Some(format!("on {host}"))
}

/// A card's quiet line: who owns it or how it is shared, then anything the
/// row has to say about its media, then the age of a share with no listing row.
pub(super) fn card_meta(entry: &Entry, share_list_known: bool, media: Option<&str>, age: Option<&str>) -> String {
    let mut line = match entry.doc.as_ref().filter(|d| d.shared && (d.shared_by.is_some() || d.role.is_some())) {
        Some(d) => {
            let mut line = match &d.shared_by {
                Some(by) => format!("Shared by {by}"),
                None => "Shared with you".into(),
            };
            if let Some(role) = d.role {
                line.push_str(if role == Role::Editor { " · Editor" } else { " · Viewer" });
            }
            line
        }
        None => source_badge_text(entry, share_list_known),
    };
    for extra in [media, age].into_iter().flatten().filter(|s| !s.is_empty()) {
        line.push_str(" · ");
        line.push_str(extra);
    }
    line
}

/// A snapshot card's quiet line. Its type is the badge beside it.
pub(super) fn snapshot_card_meta(row: &SnapshotMeta, now: chrono::DateTime<chrono::Local>) -> String {
    let meta = snapshot_meta(row, now);
    meta.split_once(" · ").map_or(meta.clone(), |(_, rest)| rest.to_string())
}

/// The cache key of a cloud document's thumbnail: account, server and
/// document, at one version.
pub(super) fn cloud_want(account: &str, origin: &str, id: &str, stamp: &str) -> Want {
    Want { key: doc_preview::cloud_key(account, origin, id), stamp: stamp.to_string() }
}

/// Where the cloud thumbnails are kept between launches.
fn cloud_previews_file() -> PathBuf {
    markie_core::paths::data_dir().join("cloud-previews.json")
}

/// Cloud documents whose words can be drawn: the text family the sync carries.
fn previewable(format: FormatKind) -> bool {
    !matches!(format, FormatKind::Unsupported | FormatKind::Docx | FormatKind::Doc | FormatKind::Rtf | FormatKind::Odt)
}

#[derive(Clone)]
enum MenuKey {
    Path(PathBuf),
    Cloud(super::library_rows::CloudRow),
}

/// What a card of the page is, for the grid's one handler.
#[derive(Clone)]
enum Target {
    Doc { open_path: Option<PathBuf>, scope: Scope, doc: Option<DocMeta>, menu: Option<MenuKey>, manage: Option<SharedByMeDoc> },
    Snapshot(Scope, SnapshotMeta),
}

/// The synced and shared files as the filters leave them.
struct Files {
    matched: Vec<Entry>,
    shown: Vec<Entry>,
    counts: HashMap<Source, usize>,
    lists: Lists,
    booting: bool,
    by_me_error: bool,
    cloud_error: Option<String>,
    share_list_known: bool,
    share_list_matters: bool,
    share_list_loading: bool,
}

impl Workspace {
    fn cloud_query(&self, cx: &App) -> Query {
        Query { search: self.cloud_search.read(cx).value().to_string(), format: self.cloud.type_filter, sort: self.cloud.sort }
    }

    fn set_cloud_sources(&mut self, sources: Vec<Source>, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting(SOURCES_SETTING, &sources_to_setting(&sources));
        }
        self.cloud.sources = sources;
        cx.notify();
    }

    fn set_cloud_view(&mut self, view: GridView) {
        self.shell.cloud_grid.view = view;
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting(super::recent_page::CLOUD_VIEW_KEY, view.as_str());
        }
    }

    fn clear_cloud_filters(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cloud.type_filter = None;
        self.cloud.sort = Sort::Default;
        self.cloud_search.update(cx, |s, cx| s.set_value("", window, cx));
        cx.notify();
    }

    /// `CloudView`'s `matched` and `shown` memos and what is known so far.
    fn cloud_files(&self, scope: &Scope, q: &Query) -> Files {
        let listing = self.cloud.listing(scope);
        let docs = listing.and_then(|l| l.docs.clone()).unwrap_or_default();
        let by_me = listing.and_then(|l| l.shared_by_me.as_deref());
        let by_me_error = listing.is_some_and(|l| l.shared_by_me_error);
        let cloud_error = listing.and_then(|l| l.error.clone());
        let local: Vec<(PathBuf, Option<String>)> = self
            .cloud
            .bindings
            .iter()
            .filter(|(path, b)| {
                scope.matches(b)
                    && self.cloud.remote(path).is_none()
                    && matches!(b.record.state, markie_cloud::sync::SyncState::Unpushed | markie_cloud::sync::SyncState::Paused | markie_cloud::sync::SyncState::Conflict)
            })
            .map(|(path, b)| (path.clone(), b.record.cloud_doc_id.clone()))
            .collect();
        let all = entries(
            &docs,
            by_me,
            &local,
            |id| self.cloud.find(scope, id),
            |path| self.registry.as_ref().and_then(|r| r.last_opened(path).ok().flatten()),
            self.cloud.area.as_deref(),
        );
        let matched = query(all, q);
        let mut counts: HashMap<Source, usize> = HashMap::new();
        for e in &matched {
            *counts.entry(e.source).or_default() += 1;
        }
        let sources = &self.cloud.sources;
        let shown: Vec<Entry> = matched.iter().filter(|e| sources.is_empty() || sources.contains(&e.source)).cloned().collect();
        let booting = listing.is_none();
        let lists = if booting {
            Lists::Loading
        } else if by_me_error || cloud_error.is_some() {
            Lists::Incomplete
        } else if by_me.is_none() {
            Lists::Loading
        } else {
            Lists::Ready
        };
        let includes = |s: Source| sources.is_empty() || sources.contains(&s);
        let share_list_matters = includes(Source::ByMe) || includes(Source::OnlyMe);
        Files {
            matched,
            shown,
            counts,
            lists,
            booting,
            by_me_error,
            cloud_error,
            share_list_known: by_me.is_some() && !by_me_error,
            share_list_matters,
            share_list_loading: by_me.is_none() && !by_me_error,
        }
    }

    /// The accounts whose media and thumbnails may be kept: every signed-in
    /// server but one being signed out of.
    pub(super) fn cache_scopes(&self, cx: &App) -> Vec<(String, String)> {
        let excluded = super::account::AccountStore::global(cx).and_then(|account| account.read(cx).cache_excluded_origin().map(str::to_owned));
        self.cloud
            .scopes()
            .into_iter()
            .filter(|scope| Some(scope.origin()) != excluded.as_deref() && !self.cloud.media_signing_out.contains(scope.origin()))
            .map(|scope| (scope.user.clone(), scope.origin().to_string()))
            .collect()
    }

    /// Whose cloud thumbnails are stored, the media cache's rule: the same
    /// accounts keep them across launches; a sign-out, another account or
    /// another server removes them from disk and from memory at once, and
    /// drops any fetch still under way.
    pub(super) fn bind_cloud_previews(&mut self, cx: &mut Context<Self>) {
        let session = doc_preview::cloud_session(&self.cache_scopes(cx));
        if self.shell.cloud_preview_session.as_ref() == Some(&session) {
            return;
        }
        self.shell.cloud_preview_session = Some(session.clone());
        self.shell.cloud_preview_epoch = self.shell.cloud_preview_epoch.wrapping_add(1);
        self.shell.previews.clear_cloud();
        // On this thread, so nothing of the last account's outlives the change.
        let kept = doc_preview::bind_cloud_file(&cloud_previews_file(), session.as_deref()).unwrap_or_default();
        if let Some(session) = &session {
            self.shell.previews.load_cloud(&kept, session);
        }
        self.shell.cloud_previews_loaded = true;
        cx.notify();
    }

    /// Write the cloud thumbnails for the accounts they belong to: private,
    /// and whole or not at all.
    fn save_cloud_previews(&self) {
        if let Some(Some(session)) = &self.shell.cloud_preview_session {
            let _ = doc_preview::write_private(&cloud_previews_file(), self.shell.previews.save_cloud(session).as_bytes());
        }
    }

    /// Ask for the thumbnails the Cloud page still lacks: each document's
    /// text is fetched once per version, in the background, and kept on disk
    /// for this account. A document that left the list, or that the server
    /// no longer lets this account read, loses its stored thumbnail.
    pub(super) fn sync_cloud_previews(&mut self, cx: &mut Context<Self>) {
        self.bind_cloud_previews(cx);
        let Some(scope) = self.cloud.selected_scope() else { return };
        let (account, origin) = (scope.user.clone(), scope.origin().to_string());
        // A server being signed out of keeps nothing.
        if !self.cache_scopes(cx).iter().any(|(user, server)| *user == account && *server == origin) {
            return;
        }
        let Some(listing) = self.cloud.listing(&scope) else { return };
        let mut wants: Vec<(Want, String, FormatKind)> = Vec::new();
        let mut listed: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for doc in listing.docs.iter().flatten() {
            listed.insert(doc.id.as_str());
            let format = format_of(&doc.name);
            if previewable(format) {
                wants.push((cloud_want(&account, &origin, &doc.id, &format!("v{}", doc.version)), doc.id.clone(), format));
            }
        }
        for share in listing.shared_by_me.iter().flatten().filter(|s| !listed.contains(s.id.as_str())) {
            let format = format_of(&share.name);
            if previewable(format) {
                wants.push((cloud_want(&account, &origin, &share.id, share.updated_at.as_deref().unwrap_or_default()), share.id.clone(), format));
            }
        }
        // Once both lists are in, what is in neither is no longer this account's to keep.
        let mut pruned = false;
        if let (Some(_), Some(shares)) = (&listing.docs, &listing.shared_by_me) {
            let mut ids = listed.clone();
            ids.extend(shares.iter().map(|s| s.id.as_str()));
            pruned = self.shell.previews.retain_cloud(&doc_preview::cloud_scope(&account, &origin), &ids);
        }
        let owed = self.shell.previews.claim(wants.iter().map(|(want, ..)| want.clone()));
        if owed.is_empty() {
            if pruned {
                self.save_cloud_previews();
            }
            return;
        }
        let jobs: Vec<_> = wants.into_iter().filter(|(want, ..)| owed.contains(want)).collect();
        let epoch = self.shell.cloud_preview_epoch;
        cx.spawn(async move |this, cx| {
            for (want, id, format) in jobs {
                let client = scope.client.clone();
                // Refused (403), gone (404) or unreachable: nothing to draw, and
                // nothing stays stored for it.
                let text = super::cloud::network(async move { markie_cloud::docs::DocsClient::new(&client).get(&id).await.ok().map(|doc| doc.content) }).await.ok().flatten();
                let preview = cx
                    .background_spawn(async move {
                        let text = text?;
                        let mut end = text.len().min(doc_preview::HEAD_BYTES as usize);
                        while !text.is_char_boundary(end) {
                            end -= 1;
                        }
                        doc_preview::from_bytes(format, &text.as_bytes()[..end])
                    })
                    .await;
                let landed = this.update(cx, |this, cx| {
                    // The account changed while this was fetched: it is nobody's now.
                    if this.shell.cloud_preview_epoch != epoch {
                        return false;
                    }
                    this.shell.previews.put(want, preview);
                    cx.notify();
                    true
                });
                if !matches!(landed, Ok(true)) {
                    return;
                }
            }
            let _ = this.update(cx, |this, _| {
                if this.shell.cloud_preview_epoch == epoch {
                    this.save_cloud_previews();
                }
            });
        })
        .detach();
    }

    /// The Cloud page: header, one toolbar row, then what is waiting and the
    /// documents as cards.
    pub(super) fn render_cloud_workspace(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let p = themes::palette(cx);
        let Some(scope) = self.cloud.selected_scope() else {
            return self.render_cloud_signed_out(window, &p, cx);
        };
        let q = self.cloud_query(cx);
        let files = self.cloud_files(&scope, &q);
        let width = super::recent_page::page_width(f32::from(window.viewport_size().width));
        let gutter = super::recent_page::page_gutter(f32::from(window.viewport_size().width));
        let state = connection(files.booting || (self.cloud.checking && files.matched.is_empty() && files.lists == Lists::Loading), files.cloud_error.as_deref());
        let dot = match state {
            Connection::Connected => p.green,
            Connection::Checking => p.yellow,
            Connection::Offline | Connection::Problem => p.red,
        };
        let header = ui::page_header("markie/cloud.svg", "Cloud", &p)
            .px(px(20. + gutter))
            .child(ui::chip(state.label(), dot, &p))
            .child(ui::hint(band_text(files.matched.len(), files.shown.len(), files.lists), &p))
            .children(server_label(scope.origin(), &self.cloud.primary_origin()).map(|s| ui::hint(s, &p)))
            .child(div().flex_1())
            .child(ui::button("cloud-open", "Open file", None, Tone::Quiet, false, &p).on_click(|_, window, cx| window.dispatch_action(Box::new(Open), cx)))
            .child(
                ui::button("cloud-new", "New document", Some(IconName::Plus), Tone::Primary, false, &p)
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(NewDocument), cx)),
            );

        let retry = |id: &'static str, cx: &mut Context<Self>| ui::button(id, "Try again", None, Tone::Secondary, self.cloud.checking, &p).on_click(cx.listener(|this, _, _, cx| this.refresh_cloud(false, cx)));
        let banners = v_flex()
            .gap(px(8.))
            .children(files.cloud_error.clone().map(|e| h_flex().gap(px(8.)).items_start().child(ui::banner(Kind::Error, e, &p).flex_1()).child(retry("cloud-retry", cx))))
            .when(files.by_me_error && files.share_list_matters, |el| {
                el.child(
                    h_flex()
                        .gap(px(8.))
                        .items_start()
                        .child(ui::banner(Kind::Error, "Couldn't load the documents you've shared. The server didn't answer. Your shares are unchanged.", &p).flex_1())
                        .child(retry("cloud-retry-shares", cx)),
                )
            })
            .children(if files.booting { None } else { self.render_share_requests(cx) });

        let (cards, mut targets) = self.cloud_cards(&scope, &files, &p);
        // Each card's file on this Mac, if it has one: only those can go in a folder.
        let locals: HashMap<SharedString, Option<PathBuf>> =
            files.shown.iter().map(|e| (SharedString::from(e.key.clone()), e.path.clone().filter(|p| p.is_file()))).collect();
        let picked: Vec<(SharedString, Option<PathBuf>)> =
            self.shell.cloud_grid.selected().into_iter().map(|id| { let l = locals.get(&id).cloned().flatten(); (id, l) }).collect();
        let filtered = q.searching() || !self.cloud.sources.is_empty();
        let documents: AnyElement = if files.booting {
            doc_grid::skeleton(width, doc_grid::columns(width) * 2, &p).into_any_element()
        } else if cards.is_empty() && files.share_list_loading && files.share_list_matters {
            doc_grid::skeleton(width, doc_grid::columns(width), &p).into_any_element()
        } else if cards.is_empty() {
            let (title, text) = empty_copy(&self.cloud.sources, q.searching());
            ui::empty_state("markie/cloud.svg", title, text, &p)
                .when(!filtered, |el| el.child(ui::hint("To sync one, open its menu in Recent and choose Sync to cloud.", &p).mt(px(2.))))
                .child(h_flex().mt(px(16.)).gap(px(8.)).map(|row| {
                    if filtered {
                        row.child(ui::button("cloud-empty-all", "Show all documents", None, Tone::Secondary, false, &p).on_click(cx.listener(|this, _, window, cx| {
                            this.set_cloud_sources(Vec::new(), cx);
                            this.clear_cloud_filters(window, cx);
                        })))
                    } else {
                        row.child(ui::button("cloud-empty-recent", "Show recent documents", None, Tone::Secondary, false, &p).on_click(cx.listener(|this, _, _, cx| this.show_recent_page(cx))))
                    }
                }))
                .into_any_element()
        } else {
            div().into_any_element()
        };

        let (snapshot_section, snapshot_targets) = self.cloud_snapshot_section(&scope, &q, &p, cx);
        targets.extend(snapshot_targets);
        let has_cards = !cards.is_empty();
        let mut sections = Vec::new();
        if has_cards {
            sections.push(Section::new(Some("Documents"), cards));
        }
        sections.push(snapshot_section);
        if !super::recent_page::shows_created(self.shell.cloud_grid.view, width) {
            sections.iter_mut().flat_map(|s| s.cards.iter_mut()).for_each(|c| c.created = None);
        }
        let targets = Rc::new(targets);
        let grid = doc_grid::render(
            Grid {
                id: "cloud-grid",
                sections,
                width,
                state: |this: &mut Self| &mut this.shell.cloud_grid,
                on_event: Rc::new(move |this: &mut Self, id, event, window, cx| {
                    if let Some(target) = targets.get(id) {
                        this.cloud_card_event(target.clone(), event, window, cx);
                    }
                }),
            },
            &self.shell.cloud_grid,
            window,
            &p,
            cx,
        );

        v_flex()
            .id("cloud-page")
            .size_full()
            .bg(p.background)
            .on_action(cx.listener(|this, _: &super::source::EditSelectAll, _, cx| {
                this.shell.cloud_grid.select_all();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &super::source::EditUndo, window, cx| {
                if !this.bulk_undo(window, cx) {
                    cx.propagate();
                }
            }))
            .child(header)
            .child(self.render_cloud_toolbar(&scope, &q, &files, &p, cx).px(px(20. + gutter)))
            .when(!picked.is_empty(), |el| el.child(div().flex_none().px(px(gutter)).child(self.render_cloud_bulk_bar(picked, &p, cx))))
            .child(
                div()
                    .id("cloud-workspace-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.shell.cloud_grid.scroll)
                    .px(px(super::recent_page::PAGE_PAD + gutter))
                    .pt(px(12.))
                    .pb(px(28.))
                    .child(
                        v_flex()
                            .w_full()
                            .gap(px(8.))
                            .child(banners)
                            .when(!has_cards, |el| el.child(documents))
                            .child(grid),
                    ),
            )
            .into_any_element()
    }

    /// The Cloud page's bar over a selection. Only documents with a file on
    /// this Mac can go in a folder; the bar says so when some cannot.
    fn render_cloud_bulk_bar(&self, picked: Vec<(SharedString, Option<PathBuf>)>, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let local: Vec<String> = picked.iter().filter_map(|(_, l)| l.as_ref().map(|p| p.to_string_lossy().into_owned())).collect();
        let cloud_only = picked.len() - local.len();
        let in_folder = self.placed_among(&local);
        let (move_paths, unfile_paths, open_paths) = (local.clone(), local.clone(), local.clone());
        h_flex()
            .id("cloud-bulk-bar")
            .flex_none()
            .mx(px(super::recent_page::PAGE_PAD))
            .mt(px(4.))
            .px(px(10.))
            .py(px(6.))
            .gap(px(8.))
            .rounded(px(9.))
            .border_1()
            .border_color(p.blue.opacity(0.45))
            .bg(p.blue.opacity(if p.dark { 0.14 } else { 0.07 }))
            .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(super::recent_page::selected_label(picked.len())))
            .when(cloud_only > 0, |el| el.child(div().min_w_0().truncate().text_size(px(11.5)).text_color(p.muted).child(cloud_only_note(cloud_only, local.is_empty()))))
            .child(div().flex_1())
            .child(ui::button("cloud-bulk-move", "Move to Folder…", None, Tone::Primary, local.is_empty(), &p).when(!local.is_empty(), |b| {
                b.on_click(cx.listener(move |this, _, window, cx| {
                    let items = move_paths.iter().map(|p| markie_core::projects::folders::Item::File(p.clone())).collect();
                    this.shell.bulk_pending = Some(this.projects.history.depth());
                    this.ask_move_to(items, window, cx);
                }))
            }))
            .when(in_folder > 0, |el| {
                el.child(ui::button("cloud-bulk-unfile", "Remove from Folder", None, Tone::Secondary, false, &p).on_click(cx.listener(move |this, _, window, cx| {
                    let before = this.projects.history.depth();
                    this.remove_from_folder(unfile_paths.clone(), window, cx);
                    if this.projects.history.depth() > before {
                        this.shell.bulk_undo.push(super::recent_page::BulkUndo::Organize);
                    }
                })))
            })
            .when(!local.is_empty(), |el| {
                el.child(ui::button("cloud-bulk-open", "Open", None, Tone::Secondary, false, &p).on_click(cx.listener(move |this, _, window, cx| {
                    let items: Vec<_> = open_paths.iter().map(|p| markie_core::projects::folders::Item::File(p.clone())).collect();
                    this.shell.cloud_grid.selection.clear();
                    this.open_items(&items, window, cx);
                })))
            })
            .child(ui::button("cloud-bulk-clear", "Clear", None, Tone::Quiet, false, &p).on_click(cx.listener(|this, _, _, cx| {
                this.shell.cloud_grid.selection.clear();
                cx.notify();
            })))
            .into_any_element()
    }

    /// Signed out, or still asking who is signed in.
    fn render_cloud_signed_out(&self, window: &Window, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        // A session the sync has no scope for yet: the account's own page.
        if super::account::signed_in_user(cx).is_some() {
            return self.render_cloud_page();
        }
        let p = *p;
        let checking = super::account::AccountStore::global(cx).is_some_and(|s| s.read(cx).status == super::account::AuthStatus::Checking);
        let width = super::recent_page::page_width(f32::from(window.viewport_size().width));
        let gutter = super::recent_page::page_gutter(f32::from(window.viewport_size().width));
        let header = ui::page_header("markie/cloud.svg", "Cloud", &p)
            .px(px(20. + gutter))
            .child(if checking { ui::chip("Checking", p.yellow, &p) } else { ui::chip("Signed out", p.muted, &p) })
            .child(div().flex_1())
            .child(ui::button("cloud-open", "Open file", None, Tone::Quiet, false, &p).on_click(|_, window, cx| window.dispatch_action(Box::new(Open), cx)));
        let body = if checking {
            div().pt(px(20.)).child(doc_grid::skeleton(width, doc_grid::columns(width), &p))
        } else {
            ui::empty_state("markie/cloud.svg", "Sign in to see synced and shared files", "Documents you sync, and documents people share with you, show up here.", &p).child(
                div().mt(px(16.)).child(
                    ui::button("cloud-sign-in", "Sign in", None, Tone::Primary, false, &p).on_click(cx.listener(|this, _, window, cx| this.open_account(window, cx))),
                ),
            )
        };
        v_flex()
            .id("cloud-page")
            .size_full()
            .bg(p.background)
            .child(header)
            .child(div().flex_1().min_h_0().px(px(super::recent_page::PAGE_PAD + gutter)).child(body))
            .into_any_element()
    }

    /// One row: filter by name, whose documents, then area, type, order and
    /// grid or list.
    fn render_cloud_toolbar(&self, scope: &Scope, q: &Query, files: &Files, p: &Palette, cx: &mut Context<Self>) -> Div {
        let p = *p;
        let areas = self.cloud.listing(scope).map(|l| l.areas.clone()).unwrap_or_default();
        let area_label = self.cloud.area.as_ref().and_then(|id| areas.iter().find(|a| &a.id == id)).map(|a| a.label.clone()).unwrap_or_else(|| "All areas".into());
        let type_label = TYPES.iter().find(|(f, _)| *f == q.format).map(|(_, l)| *l).unwrap_or("All types");
        let sort_label = SORTS.iter().find(|(s, _)| *s == q.sort).map(|(_, l)| *l).unwrap_or("Default order");
        let menu = self.cloud.menu;
        let dropdown = |which: Menu, id: &'static str, label: String, cx: &mut Context<Self>| {
            div()
                .relative()
                .flex_none()
                .w(px(128.))
                .child(ui::select(id, label, menu == Some(which), &p).w_full().on_click(cx.listener(move |this, _, window, cx| {
                    this.cloud.menu = if this.cloud.menu == Some(which) { None } else { Some(which) };
                    if this.cloud.menu == Some(Menu::Area) {
                        this.ensure_area_input(window, cx);
                    }
                    cx.notify();
                })))
                .when(menu == Some(which), |el| el.child(self.render_cloud_menu(which, Some(scope), &p, cx)))
        };
        let sources = &self.cloud.sources;
        let mut scopes = ui::segments(&p).child(
            ui::segment("cloud-chip-all", "All", Some(files.matched.len()), sources.is_empty(), &p).on_click(cx.listener(|this, _, _, cx| this.set_cloud_sources(Vec::new(), cx))),
        );
        for (source, id, label, _) in SOURCES {
            // Each one turns on and off by itself, so two can be on at once.
            scopes = scopes.child(
                ui::segment(SharedString::from(format!("cloud-chip-{id}")), label, Some(files.counts.get(&source).copied().unwrap_or(0)), sources.contains(&source), &p).on_click(cx.listener(
                    move |this, _, _, cx| {
                        let mut next = this.cloud.sources.clone();
                        if let Some(i) = next.iter().position(|s| *s == source) {
                            next.remove(i);
                        } else {
                            next.push(source);
                        }
                        this.set_cloud_sources(next, cx);
                    },
                )),
            );
        }
        ui::toolbar(&p)
            .child(div().flex_1().min_w(px(216.)).max_w(px(300.)).child(filter_field(&self.cloud_search, 13., &p)))
            // With nothing in the cloud there is nothing to tell apart.
            .when(!files.booting && (!files.matched.is_empty() || q.searching()), |el| el.child(scopes))
            .child(dropdown(Menu::Type, "cloud-type", type_label.to_string(), cx))
            .child(dropdown(Menu::Sort, "cloud-sort", sort_label.to_string(), cx))
            .child(dropdown(Menu::Area, "cloud-area-picker", area_label, cx))
            .child(div().flex_1())
            .when(q.active(), |el| {
                el.child(ui::button("cloud-clear-filters", "Clear filters", None, Tone::Quiet, false, &p).on_click(cx.listener(|this, _, window, cx| {
                    this.clear_cloud_filters(window, cx);
                    this.cloud_search.update(cx, |s, cx| s.focus(window, cx));
                })))
            })
            .child(doc_grid::view_toggle(self.shell.cloud_grid.view, &p, cx, |this: &mut Self, view, _| this.set_cloud_view(view)))
    }

    /// A menu under its button: type, order, or the area chips.
    fn render_cloud_menu(&self, menu: Menu, scope: Option<&Scope>, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let panel = |id: &'static str| menu_panel(&p).id(id).occlude().p(px(4.)).rounded(px(10.));
        let close = cx.listener(|this, _: &MouseDownEvent, _, cx| {
            this.cloud.menu = None;
            cx.notify();
        });
        let body = match menu {
            Menu::Type => panel("cloud-type-menu")
                .min_w(px(160.))
                .children(TYPES.iter().enumerate().map(|(i, (format, label))| {
                    let format = *format;
                    ui::menu_row(SharedString::from(format!("cloud-type-{i}")), *label, self.cloud.type_filter == format, &p).on_click(cx.listener(move |this, _, _, cx| {
                        this.cloud.type_filter = format;
                        this.cloud.menu = None;
                        cx.notify();
                    }))
                }))
                .on_mouse_down_out(close)
                .into_any_element(),
            Menu::Sort => panel("cloud-sort-menu")
                .min_w(px(160.))
                .children(SORTS.iter().enumerate().map(|(i, (sort, label))| {
                    let sort = *sort;
                    ui::menu_row(SharedString::from(format!("cloud-sort-{i}")), *label, self.cloud.sort == sort, &p).on_click(cx.listener(move |this, _, _, cx| {
                        this.cloud.sort = sort;
                        this.cloud.menu = None;
                        cx.notify();
                    }))
                }))
                .on_mouse_down_out(close)
                .into_any_element(),
            Menu::Area => {
                let areas = scope.and_then(|s| self.cloud.listing(s)).map(|l| l.areas.clone()).unwrap_or_default();
                let chip_for = |id: Option<String>, label: String, on: bool, cx: &mut Context<Self>| {
                    div()
                        .id(SharedString::from(format!("cloud-area-{}", id.as_deref().unwrap_or("all"))))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(if on { p.foreground.opacity(0.25) } else { p.border })
                        .when(on, |el| el.bg(p.accent))
                        .px(px(8.))
                        .py(px(4.))
                        .text_size(px(11.5))
                        .text_color(if on { p.foreground } else { p.muted })
                        .hover(|s| s.text_color(p.foreground))
                        .cursor_pointer()
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.cloud.area = id.clone();
                            this.cloud.menu = None;
                            cx.notify();
                        }))
                };
                let mut chips = vec![chip_for(None, "All areas".into(), self.cloud.area.is_none(), cx)];
                for a in areas {
                    let on = self.cloud.area.as_deref() == Some(a.id.as_str());
                    chips.push(chip_for(Some(a.id.clone()), a.label.clone(), on, cx));
                }
                panel("cloud-area-menu")
                    .w(px(300.))
                    .p(px(8.))
                    .child(div().mb(px(6.)).text_size(px(11.)).text_color(p.muted).child("Cloud area"))
                    .child(h_flex().flex_wrap().gap(px(4.)).children(chips))
                    .children(self.render_area_create(AreaTarget::Page, &p, cx))
                    .on_mouse_down_out(close)
                    .into_any_element()
            }
        };
        div().absolute().top(px(32. + 6.)).left_0().child(deferred(anchored().snap_to_window_with_margin(px(8.)).child(body)))
    }

    /// The "New area" field under the area chips, created the first time a
    /// picker opens (it needs the window).
    pub(super) fn ensure_area_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.cloud.area_input.is_none() {
            let input = cx.new(|cx| gpui_kit::component::input::InputState::new(window, cx).placeholder("New area"));
            self.cloud.area_input = Some(input);
        }
        self.cloud.area_error = None;
    }

    /// `createArea` then `areas` (cloud-area-picker.tsx): the new area is
    /// listed and selected in the picker that made it.
    pub(super) fn create_cloud_area(&mut self, target: AreaTarget, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self.cloud.area_input.clone() else { return };
        let label = input.read(cx).value().to_string();
        if self.cloud.area_busy || label.trim().is_empty() {
            return;
        }
        let scope = match target {
            AreaTarget::Page => self.cloud.selected_scope(),
            AreaTarget::Office => self.office_scope(),
            AreaTarget::Share | AreaTarget::Library => self.cloud.primary_scope(),
        };
        let Some(scope) = scope else { return };
        self.cloud.area_busy = true;
        self.cloud.area_error = None;
        let request = scope.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = super::cloud::network(async move {
                let platform = PlatformClient(&request.client);
                let area = platform.create_area(&label).await?;
                let areas = platform.areas().await?;
                Ok::<_, markie_cloud::error::CloudError>((area, areas))
            })
            .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.cloud.area_busy = false;
                match result {
                    Ok(Ok((area, areas))) => {
                        if let Some(listing) = this.cloud.listings.get_mut(scope.origin()).filter(|l| l.user == scope.user) {
                            listing.areas = areas;
                        }
                        match target {
                            AreaTarget::Share => {
                                if let Some(sheet) = this.collab.share.as_mut() {
                                    sheet.set_upload_area(Some(area.id));
                                }
                            }
                            AreaTarget::Page => {
                                this.cloud.area = Some(area.id);
                                this.cloud.menu = None;
                            }
                            AreaTarget::Library => {
                                this.shell.upload_area = Some(area.id);
                                this.shell.upload_area_open = false;
                            }
                            AreaTarget::Office => this.office_area_created(area.id),
                        }
                        input.update(cx, |s, cx| s.set_value("", window, cx));
                    }
                    Ok(Err(markie_cloud::error::CloudError::Invalid(m))) => this.cloud.area_error = Some(m),
                    _ => this.cloud.area_error = Some("Cloud area could not be created.".into()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The form row: field and Create, then the busy and error lines.
    pub(super) fn render_area_create(&self, target: AreaTarget, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let input = self.cloud.area_input.clone()?;
        let p = *p;
        let empty = input.read(cx).value().trim().is_empty();
        let busy = self.cloud.area_busy;
        Some(
            v_flex()
                .gap(px(6.))
                .mt(px(8.))
                .pt(px(8.))
                .border_t_1()
                .border_color(p.border.opacity(0.7))
                .child(
                    h_flex()
                        .gap(px(4.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .h(px(26.))
                                .px(px(4.))
                                .flex()
                                .items_center()
                                .rounded(px(6.))
                                .border_1()
                                .border_color(p.border)
                                .bg(p.background)
                                .child(gpui_kit::component::input::Input::new(&input).appearance(false).text_size(px(11.)).w_full()),
                        )
                        .child(
                            div()
                                .id(match target {
                                    AreaTarget::Share => "share-area-create",
                                    AreaTarget::Page => "cloud-area-create",
                                    AreaTarget::Library => "library-area-create",
                                    AreaTarget::Office => "office-area-create",
                                })
                                .rounded(px(6.))
                                .border_1()
                                .border_color(p.border)
                                .px(px(8.))
                                .py(px(4.))
                                .text_size(px(11.))
                                .text_color(p.muted)
                                .when(busy || empty, |el| el.opacity(0.4))
                                .when(!busy && !empty, |el| el.cursor_pointer().hover(|s| s.text_color(p.foreground)))
                                .child("Create")
                                .on_click(cx.listener(move |this, _, window, cx| this.create_cloud_area(target, window, cx))),
                        ),
                )
                .when(busy, |el| el.child(div().text_size(px(11.)).text_color(p.muted).child("Loading areas…")))
                .when_some(self.cloud.area_error.clone(), |el, e| el.child(div().text_size(px(11.)).text_color(p.red).child(e)))
                .into_any_element(),
        )
    }

    /// The documents as cards, and what each card does.
    fn cloud_cards(&self, scope: &Scope, files: &Files, _p: &Palette) -> (Vec<DocCard>, HashMap<SharedString, Target>) {
        let mut targets = HashMap::new();
        let origin = scope.origin();
        let cards = files
            .shown
            .iter()
            .map(|e| {
                let format = format_of(&e.name);
                let local = e.path.clone();
                let on_disk = local.as_deref().is_some_and(|p| p.is_file());
                let shared = e.doc.as_ref().is_some_and(|d| d.shared);
                let media = local.as_deref().and_then(|path| self.cloud.media_note(path)).map(|m| m.trim_start_matches(" · ").to_string());
                let age = (e.doc.is_none() && e.share.is_some())
                    .then(|| e.updated_at.as_deref().and_then(|u| chrono::DateTime::parse_from_rfc3339(u).ok()).map(|d| super::account::short_ago_ms(d.timestamp_millis())))
                    .flatten();
                let menu = match (&local, &e.doc) {
                    (Some(path), _) => Some(MenuKey::Path(path.clone())),
                    (None, Some(d)) => Some(MenuKey::Cloud(super::library_rows::CloudRow { scope: scope.clone(), id: d.id.clone(), name: d.name.clone() })),
                    _ => None,
                };
                let manage = e.share.clone().filter(|_| e.source == Source::ByMe);
                let gone = local.is_some() && !on_disk;
                let mut card = DocCard::new(e.key.clone(), e.name.clone(), format);
                card.selectable = true;
                if on_disk && let Some(path) = &local {
                    let item = markie_core::projects::folders::Item::File(path.to_string_lossy().into_owned());
                    card.drag = Some(super::projects::DragItems::new(vec![item], &|_| e.name.clone()));
                }
                card.meta = if gone { format!("Missing on disk · {}", card_meta(e, files.share_list_known, None, None)) } else { card_meta(e, files.share_list_known, media.as_deref(), age.as_deref()) }.into();
                card.missing = gone;
                card.created = super::recent_page::created_line(entry_created_ms(e), chrono::Local::now()).map(Into::into);
                card.openable = on_disk || e.doc.is_some();
                card.has_menu = menu.is_some();
                card.menu_open = match &menu {
                    Some(MenuKey::Path(path)) => self.shell.row_menu.as_ref().is_some_and(|(m, _)| m == path),
                    Some(MenuKey::Cloud(row)) => self.cloud_row_menu_open(row.scope.origin(), &row.id),
                    None => false,
                };
                card.action = manage.as_ref().map(|_| "Manage".into());
                // The sync state of the copy on this device, then how it is shared.
                if shared {
                    card.marks.push(Mark::new("markie/sync-shared.svg", MarkTone::Purple, "Shared with you"));
                } else {
                    match local.as_deref().and_then(|path| self.cloud.badge(path)) {
                        Some(badge) => card.marks.extend(super::recent_page::sync_mark(super::library_rows::SyncStatus::from_badge(Some(badge), false))),
                        None if local.is_none() => card.marks.push(Mark::new("markie/cloud.svg", MarkTone::Muted, "In the cloud, not on this Mac")),
                        None => {}
                    }
                    if e.source == Source::ByMe {
                        card.marks.push(Mark::new("markie/sync-shared.svg", MarkTone::Blue, "Shared by you"));
                    }
                }
                let cloud_id = e.doc.as_ref().map(|d| (d.id.clone(), format!("v{}", d.version))).or_else(|| e.share.as_ref().map(|s| (s.id.clone(), s.updated_at.clone().unwrap_or_default())));
                card.thumb = match cloud_id {
                    Some((id, stamp)) if previewable(format) => match self.shell.previews.lookup(&cloud_want(&scope.user, origin, &id, &stamp)) {
                        Lookup::Ready(preview) => Thumb::Page(preview),
                        Lookup::Nothing => Thumb::Tile,
                        Lookup::Owed => Thumb::Loading,
                    },
                    _ => Thumb::Tile,
                };
                targets.insert(
                    card.id.clone(),
                    Target::Doc { open_path: local.filter(|_| on_disk), scope: scope.clone(), doc: e.doc.clone(), menu, manage },
                );
                card
            })
            .collect();
        (cards, targets)
    }

    fn cloud_card_event(&mut self, target: Target, event: CardEvent, window: &mut Window, cx: &mut Context<Self>) {
        match (target, event) {
            (Target::Snapshot(scope, meta), CardEvent::Open) => self.show_snapshot(scope, meta, window, cx),
            (Target::Snapshot(..), _) => {}
            (Target::Doc { open_path, scope, doc, .. }, CardEvent::Open) => {
                self.shell.row_menu = None;
                self.shell.cloud_row_menu = None;
                if let Some(path) = open_path {
                    self.open_path(&path, window, cx);
                } else if let Some(doc) = doc {
                    self.open_cloud_text(scope, doc.id.clone(), doc.name.clone(), window, cx);
                }
            }
            (Target::Doc { menu, .. }, CardEvent::Menu(at)) => match menu {
                Some(MenuKey::Path(path)) => {
                    if self.shell.row_menu.as_ref().is_some_and(|(open, _)| *open != path) {
                        self.shell.row_menu = None;
                    }
                    self.open_row_menu(path, at, cx);
                }
                Some(MenuKey::Cloud(row)) => {
                    if !self.cloud_row_menu_open(row.scope.origin(), &row.id) {
                        self.shell.cloud_row_menu = None;
                    }
                    self.open_cloud_row_menu(row, at, cx);
                }
                None => {}
            },
            (Target::Doc { manage, .. }, CardEvent::Action) => {
                if let Some(share) = manage {
                    self.manage_cloud_share(share.id, share.name, window, cx);
                }
            }
        }
    }

    /// `DocumentCloudLibrary`: the snapshots as their own section of cards.
    fn cloud_snapshot_section(&self, scope: &Scope, q: &Query, p: &Palette, cx: &mut Context<Self>) -> (Section, HashMap<SharedString, Target>) {
        let p = *p;
        let listing = self.cloud.listing(scope);
        let loading = self.cloud.checking && listing.is_none();
        let error = listing.and_then(|l| l.snapshot_error.clone()).map(|e| snapshot_error(&e));
        let all: Vec<SnapshotMeta> = listing
            .map(|l| l.snapshots.clone())
            .unwrap_or_default()
            .into_iter()
            .filter(|r| self.cloud.area.as_ref().is_none_or(|a| r.area_id.as_ref() == Some(a)))
            .collect();
        let total = listing.map_or(0, |l| l.snapshots.len());
        let words: Vec<String> = q.search.trim().to_lowercase().split_whitespace().map(str::to_string).collect();
        let mut rows: Vec<SnapshotMeta> = all.into_iter().filter(|r| q.format.is_none_or(|f| r.format == f)).filter(|r| words.iter().all(|w| r.name.to_lowercase().contains(w))).collect();
        if q.sort != Sort::Default {
            rows.sort_by(|a, b| {
                let primary = match q.sort {
                    Sort::Recent => b.updated_at.cmp(&a.updated_at),
                    Sort::Type => format_key(a.format).cmp(format_key(b.format)),
                    Sort::Created => b.created_at.cmp(&a.created_at),
                    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                };
                primary.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.id.cmp(&b.id))
            });
        }
        let now = chrono::Local::now();
        let mut targets = HashMap::new();
        let cards: Vec<DocCard> = rows
            .iter()
            .map(|row| {
                let mut card = DocCard::new(format!("snapshot:{}", row.id), row.name.clone(), row.format);
                card.meta = snapshot_card_meta(row, now).into();
                card.created = super::recent_page::created_line(Some(row.created_at as f64), chrono::Local::now()).map(Into::into);
                card.has_menu = false;
                targets.insert(card.id.clone(), Target::Snapshot(scope.clone(), row.clone()));
                card
            })
            .collect();
        let note = |title: String, body: Option<String>, alert: bool| {
            v_flex()
                .py(px(6.))
                .child(div().text_size(px(13.)).text_color(if alert { p.red } else { p.muted }).child(title))
                .children(body.map(|b| ui::hint(b, &p)))
                .into_any_element()
        };
        let empty = if let Some((title, detail)) = error {
            Some(note(title, Some(detail), true))
        } else if listing.is_none() || loading {
            Some(note("Loading snapshots…".into(), None, false))
        } else if rows.is_empty() && total > 0 {
            Some(note("No snapshots match these filters.".into(), None, false))
        } else if rows.is_empty() {
            Some(note("No document snapshots yet.".into(), Some("Share a local document to create one.".into()), false))
        } else {
            None
        };
        let mut section = Section::new(Some("Snapshots"), cards);
        section.count = Some(if rows.len() == total { total.to_string() } else { format!("{} of {total}", rows.len()) });
        section.empty = empty;
        section.trailing = Some(
            ui::button("cloud-snapshots-refresh", "Refresh", None, Tone::Quiet, self.cloud.checking, &p)
                .h(px(26.))
                .text_size(px(12.))
                .on_click(cx.listener(|this, _, _, cx| this.refresh_cloud(false, cx)))
                .into_any_element(),
        );
        (section, targets)
    }
}

#[cfg(feature = "scene")]
impl Workspace {
    /// Scene mode: the cards at these places picked, as ⌘-clicks pick them.
    pub(super) fn scene_cloud_select(&mut self, places: &[u64], window: &mut Window, cx: &mut Context<Self>) {
        let Some(scope) = self.cloud.selected_scope() else { return };
        let q = self.cloud_query(cx);
        let ids: Vec<SharedString> = self.cloud_files(&scope, &q).shown.iter().map(|e| SharedString::from(e.key.clone())).collect();
        for n in places {
            if let Some(id) = ids.get(*n as usize) {
                self.shell.cloud_grid.press(id, true, false);
            }
        }
        if !places.is_empty() {
            self.shell.cloud_grid.focus.focus(window, cx);
        }
    }

    /// Open one of the page's menus for a scene.
    pub(super) fn scene_cloud_menu(&mut self, which: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.cloud.menu = match which {
            "area" => {
                self.ensure_area_input(window, cx);
                Some(Menu::Area)
            }
            "type" => Some(Menu::Type),
            "sort" => Some(Menu::Sort),
            _ => None,
        };
        if which == "row"
            && let Some(scope) = self.cloud.selected_scope()
        {
            let q = self.cloud_query(cx);
            let files = self.cloud_files(&scope, &q);
            if let Some(path) = files.shown.iter().find_map(|e| e.path.clone()) {
                self.open_row_menu(path, point(px(300.), px(440.)), cx);
            }
        }
    }
}

/// Why some selected cloud documents cannot go in a folder.
pub(super) fn cloud_only_note(n: usize, all: bool) -> String {
    match (n, all) {
        (1, true) => "It is only in the cloud. Download it to put it in a folder.".into(),
        (_, true) => "They are only in the cloud. Download them to put them in a folder.".into(),
        (1, false) => "1 is only in the cloud and stays out of folders.".into(),
        (n, false) => format!("{n} are only in the cloud and stay out of folders."),
    }
}

#[cfg(test)]
mod tests {
    // Not `super::*`: that brings in GPUI's own `test` macro.
    use super::{
        Connection, DocMeta, FormatKind, Lists, Query, Role, SharedByMeDoc, Sort, Source, band_text, card_meta, cloud_want, connection, empty_copy, entries,
        file_size, query, server_label, share_badge_text, snapshot_error, source_badge_text, sources_from_setting, sources_to_setting,
    };

    fn doc(id: &str, name: &str, updated: &str, shared: bool) -> DocMeta {
        DocMeta {
            id: id.into(),
            name: name.into(),
            version: 1,
            hash: None,
            created_at: None,
            updated_at: Some(updated.into()),
            shared,
            role: shared.then_some(Role::Editor),
            shared_by: None,
            shared_out: Some(false),
            area_id: None,
        }
    }

    fn share(id: &str, name: &str, members: i64, pending: i64) -> SharedByMeDoc {
        SharedByMeDoc { id: id.into(), name: name.into(), updated_at: Some("2026-11-20T10:00:00Z".into()), member_count: members, pending_count: pending }
    }

    #[test]
    fn cloud_only_documents_say_why_they_cannot_go_in_a_folder() {
        use super::cloud_only_note;
        assert_eq!(cloud_only_note(1, true), "It is only in the cloud. Download it to put it in a folder.");
        assert_eq!(cloud_only_note(2, false), "2 are only in the cloud and stay out of folders.");
        assert!(cloud_only_note(3, true).starts_with("They are only in the cloud."));
    }

    #[test]
    fn sources_come_from_ownership_and_the_shared_list_newest_first() {
        let docs = vec![
            doc("a", "alpha.md", "2026-11-21T10:00:00Z", false),
            doc("b", "beta.md", "2026-11-22T10:00:00Z", true),
            doc("c", "gamma.docx", "2026-11-19T10:00:00Z", false),
        ];
        let by_me = vec![share("c", "gamma.docx", 2, 1), share("z", "only-shared.md", 1, 0)];
        let rows = entries(&docs, Some(&by_me), &[], |_| None, |_| None, None);
        let summary: Vec<_> = rows.iter().map(|e| (e.name.as_str(), e.source)).collect();
        assert_eq!(
            summary,
            // gamma takes the shared list's later time, ties only-shared, and
            // the tie goes by name.
            [("beta.md", Source::WithMe), ("alpha.md", Source::OnlyMe), ("gamma.docx", Source::ByMe), ("only-shared.md", Source::ByMe)]
        );
        // A document of mine that I shared is one row, with the later time.
        assert_eq!(rows[2].updated_at.as_deref(), Some("2026-11-20T10:00:00Z"));
        assert_eq!(source_badge_text(&rows[2], true), "Shared with 2 · 1 invited");
        assert!(rows[3].doc.is_none(), "only the shared list named it");
        assert_eq!(source_badge_text(&rows[1], true), "Only you");
        assert_eq!(source_badge_text(&rows[1], false), "Yours");
        assert_eq!(source_badge_text(&rows[0], true), "Shared with you");
    }

    /// sync.js lists a document with a file on this device by that file's
    /// last open, so documents just landed or opened lead the default order.
    #[test]
    fn a_local_copy_dates_its_row_by_its_last_open() {
        let docs = vec![
            doc("old", "Roadmap.md", "2026-11-20T10:00:00Z", false),
            doc("new", "From Bob.md", "2026-11-22T10:00:00Z", true),
        ];
        let rows = entries(
            &docs,
            Some(&[]),
            &[],
            |id| (id == "old").then(|| std::path::PathBuf::from("/x/Roadmap.md")),
            |_| Some("2026-11-23T08:00:00Z".into()),
            None,
        );
        let names: Vec<_> = rows.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Roadmap.md", "From Bob.md"]);
        // Never opened here: no time at all, as a registry row without one.
        let rows = entries(&docs, Some(&[]), &[], |id| (id == "old").then(|| "/x/Roadmap.md".into()), |_| None, None);
        assert_eq!(rows.last().map(|e| e.name.as_str()), Some("Roadmap.md"));
    }

    #[test]
    fn type_and_order_menus_filter_like_library_document_query() {
        let docs = vec![
            doc("a", "Notes.md", "2026-11-21T10:00:00Z", false),
            doc("b", "report.docx", "2026-11-22T10:00:00Z", false),
            doc("c", "data.csv", "2026-11-20T10:00:00Z", false),
            doc("d", "archive.zip", "2026-11-18T10:00:00Z", false),
        ];
        let rows = entries(&docs, Some(&[]), &[], |_| None, |_| None, None);
        let names = |q: Query| query(rows.clone(), &q).into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names(Query::default()), ["report.docx", "Notes.md", "data.csv", "archive.zip"]);
        assert_eq!(names(Query { format: Some(FormatKind::Docx), ..Default::default() }), ["report.docx"]);
        assert_eq!(names(Query { format: Some(FormatKind::Unsupported), ..Default::default() }), ["archive.zip"]);
        assert_eq!(names(Query { sort: Sort::Name, ..Default::default() }), ["archive.zip", "data.csv", "Notes.md", "report.docx"]);
        assert_eq!(names(Query { sort: Sort::Type, ..Default::default() }), ["data.csv", "report.docx", "Notes.md", "archive.zip"]);
        assert_eq!(names(Query { search: "rep DOCX".into(), ..Default::default() }), ["report.docx"]);
        assert!(Query { sort: Sort::Recent, ..Default::default() }.active());
        assert!(!Query::default().active());
    }

    #[test]
    fn the_band_and_empty_state_say_what_electron_says() {
        assert_eq!(band_text(5, 5, Lists::Ready), "5 documents");
        assert_eq!(band_text(5, 2, Lists::Ready), "2 of 5 documents");
        assert_eq!(band_text(1, 1, Lists::Ready), "1 document");
        assert_eq!(band_text(0, 0, Lists::Loading), "Checking your cloud…");
        assert_eq!(band_text(0, 0, Lists::Incomplete), "Some of your cloud didn't load");
        assert_eq!(band_text(0, 0, Lists::Ready), "Nothing in the cloud yet");
        assert_eq!(empty_copy(&[], false).0, "Nothing in your cloud yet");
        assert_eq!(empty_copy(&[Source::ByMe, Source::WithMe], false).0, "No documents you've shared or shared with you yet");
        assert_eq!(empty_copy(&[Source::OnlyMe], true).0, "No documents only you can see match this search");
        assert_eq!(share_badge_text(&share("x", "x", 0, 0)), "Shared");
    }

    #[test]
    fn the_header_says_how_the_server_is_doing() {
        assert_eq!(connection(true, None), Connection::Checking);
        assert_eq!(connection(false, None), Connection::Connected);
        assert_eq!(connection(false, Some("The server could not be reached.")), Connection::Offline);
        assert_eq!(connection(true, Some("Connection refused")), Connection::Offline, "an error beats still loading");
        assert_eq!(connection(false, Some("This server sent an answer Markie could not read.")), Connection::Problem);
        assert_eq!(Connection::Problem.label(), "Needs attention");
        // Only a server other than the usual one is named.
        assert_eq!(server_label("https://api.markiedocs.com", "https://api.markiedocs.com/"), None);
        assert_eq!(server_label("http://localhost:18995", "https://api.markiedocs.com").as_deref(), Some("on localhost:18995"));
    }

    #[test]
    fn a_card_says_who_owns_it_or_how_it_is_shared() {
        let mut theirs = doc("b", "beta.md", "2026-11-22T10:00:00Z", true);
        theirs.shared_by = Some("Bob Chen".into());
        let docs = vec![doc("a", "alpha.md", "2026-11-21T10:00:00Z", false), theirs, doc("c", "gamma.md", "2026-11-19T10:00:00Z", false)];
        let by_me = vec![share("c", "gamma.md", 2, 1), share("z", "only-shared.md", 1, 0)];
        let rows = entries(&docs, Some(&by_me), &[], |_| None, |_| None, None);
        let line = |name: &str, media: Option<&str>, age: Option<&str>| card_meta(rows.iter().find(|e| e.name == name).unwrap(), true, media, age);
        assert_eq!(line("alpha.md", None, None), "Only you");
        assert_eq!(line("beta.md", None, None), "Shared by Bob Chen · Editor");
        assert_eq!(line("gamma.md", None, None), "Shared with 2 · 1 invited");
        assert_eq!(line("gamma.md", Some("media pending"), None), "Shared with 2 · 1 invited · media pending");
        assert_eq!(line("only-shared.md", None, Some("3d")), "Shared with 1 · 3d");
        assert_eq!(line("alpha.md", Some(""), None), "Only you", "an empty note adds nothing");
        // Before the shared list is in, a document of mine is only "Yours".
        assert_eq!(card_meta(&rows[1], false, None, None), "Yours");
    }

    #[test]
    fn a_cloud_thumbnail_is_kept_per_account_server_document_and_version() {
        let a = cloud_want("alice", "http://localhost:1", "abc", "v3");
        assert!(a.key.starts_with("cloud:") && a.key.ends_with(":abc"));
        assert_eq!(a.stamp, "v3");
        assert_ne!(a.key, cloud_want("alice", "http://localhost:2", "abc", "v3").key, "another server");
        assert_ne!(a.key, cloud_want("bob", "http://localhost:1", "abc", "v3").key, "another account");
        assert_eq!(a.key, cloud_want("alice", "http://localhost:1", "abc", "v4").key, "a new version replaces the old");
    }

    #[test]
    fn user_visible_copy_has_no_em_dashes() {
        let src = include_str!("cloud_page.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        let prose: String = code.lines().filter(|l| !l.trim_start().starts_with("//")).collect();
        assert!(!prose.contains('\u{2014}'));
    }

    #[test]
    fn chips_are_remembered_in_electrons_order() {
        let saved = sources_to_setting(&[Source::WithMe, Source::OnlyMe]);
        assert_eq!(saved, r#"["only-me","with-me"]"#);
        assert_eq!(sources_from_setting(Some(&saved)), [Source::OnlyMe, Source::WithMe]);
        assert!(sources_from_setting(Some("not json")).is_empty());
        assert!(sources_from_setting(None).is_empty());
    }

    #[test]
    fn snapshot_cards_read_like_the_document_library() {
        assert_eq!(file_size(512), "512 B");
        assert_eq!(file_size(2048), "2.0 KB");
        assert_eq!(file_size(20 * 1024), "20 KB");
        assert_eq!(file_size(3 * 1024 * 1024), "3.0 MB");
        assert_eq!(snapshot_error("This server does not provide the new document-sharing service.").0, "Snapshots unavailable on this server");
        assert_eq!(snapshot_error("Please sign in again").0, "Account confirmation needed");
        assert_eq!(snapshot_error("boom").1, "boom");
    }
}

/// The three area pickers: the Cloud page's filter, the share gate's and the
/// Library's upload destination. A new area is selected in the one that made it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AreaTarget {
    Page,
    Share,
    Library,
    /// The office cloud dialog's pickers.
    Office,
}
