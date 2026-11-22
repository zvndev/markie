//! The Cloud page when signed in: Electron's cloud workspace
//! (`library.tsx` with `presentation="workspace"`, `cloud-view.tsx`,
//! `library-document-filters.tsx` and `document-cloud-library.tsx`).
//!
//! One page, no tabs. Under the header: the area picker and the filters
//! (search, document type, order). Then synced and shared files as one list,
//! newest first, with a summary band, the source chips (All, Only me, Shared
//! by me, Shared with me), and the share requests waiting for this account.
//! Then the document snapshots, under their own heading.
use std::collections::HashMap;
use std::path::PathBuf;

use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_cloud::docs::{DocMeta, Role};
use markie_cloud::platform::SnapshotMeta;
use markie_cloud::sharing::SharedByMeDoc;
use markie_core::formats::{self, FormatKind};

use super::Workspace;
use super::chrome::{icon, menu_panel};
use super::cloud::{Scope, name};
use super::dialog_chrome::{self, Tokens};
use super::rail::{filter_field, format_badge, format_icon};
use crate::themes::{self, Palette, hex, mix};

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
}

pub(super) const SORTS: [(Sort, &str); 4] =
    [(Sort::Default, "Default order"), (Sort::Recent, "Most recent"), (Sort::Name, "Name"), (Sort::Type, "Type")];

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
    area: Option<&str>,
) -> Vec<Entry> {
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
                path,
                updated_at: doc.updated_at.clone(),
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
            path,
            updated_at: match &share {
                Some(s) => later(doc.updated_at.clone(), s.updated_at.clone()),
                None => doc.updated_at.clone(),
            },
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
                updated_at: None,
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

/// The band beside the snapshot section (`scopedBand`).
pub(super) fn scoped_band(total: usize, shown: usize, lists: Lists, searching: bool) -> String {
    if total > 0 {
        return band_text(total, shown, lists);
    }
    match lists {
        Lists::Loading => "Checking file sync and sharing…".into(),
        Lists::Incomplete => "Some synced or shared files didn't load".into(),
        Lists::Ready if searching => "No synced or shared files match these filters.".into(),
        Lists::Ready => "No synced or shared files yet.".into(),
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
    ("Nothing in your cloud yet".into(), "Documents you sync, and docs people share with you, show up here.")
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

/// `markie-cloud-chip` colours.
fn chip(id: impl Into<ElementId>, on: bool, p: &Palette) -> Stateful<Div> {
    let border = if on { mix(p.blue, hsla(0., 0., 0., 0.), 0.55) } else { mix(p.border, hsla(0., 0., 0., 0.), 0.85) };
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(4.8))
        .rounded_full()
        .border_1()
        .border_color(border)
        .px(px(8.))
        .py(px(2.56))
        .text_size(px(10.5))
        .line_height(rems(1.2 * 10.5 / 16.))
        .text_color(if on { p.foreground } else { p.muted })
        .when(on, |el| el.bg(p.blue.opacity(0.16)))
        .hover(move |s| {
            let s = s.text_color(p.foreground);
            if on { s } else { s.border_color(p.foreground.opacity(0.22)) }
        })
        .cursor_pointer()
}

fn purple(p: &Palette) -> Hsla {
    hex(if p.dark { "#d8b4fe" } else { "#6b21a8" })
}

/// `markie-cloud-source`.
fn source_badge(source: Source, text: String, p: &Palette) -> Div {
    let (color, border) = match source {
        Source::ByMe => (p.blue, p.blue.opacity(0.45)),
        Source::WithMe => (purple(p), purple(p).opacity(0.45)),
        Source::OnlyMe => (p.muted, mix(p.border, hsla(0., 0., 0., 0.), 0.85)),
    };
    div()
        .flex_none()
        .rounded_full()
        .border_1()
        .border_color(border)
        .px(px(5.6))
        .text_size(px(9.5))
        .line_height(px(9.5 * 1.45))
        .text_color(color)
        .child(text)
}

/// `.markie-select-button`, with an optional kicker before the value.
fn select_button(id: impl Into<ElementId>, kicker: Option<&str>, label: &str, open: bool, p: &Palette) -> Stateful<Div> {
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

fn sync_icon(state: Option<&'static str>, shared: bool, p: &Palette) -> Option<AnyElement> {
    let (glyph, color, label) = if shared {
        ("markie/sync-shared.svg", purple(p), "Shared")
    } else {
        match state? {
            "Synced" => ("markie/sync-synced.svg", p.green, "Synced"),
            "Not backed up" => ("markie/sync-unpushed.svg", p.yellow, "Not backed up"),
            "Paused" => ("markie/sync-paused.svg", p.yellow, "Sync paused"),
            "Conflict" => ("markie/sync-conflict.svg", p.red, "Conflict: review changes"),
            "Update available" => ("markie/sync-behind.svg", p.blue, "Update available"),
            _ => return None,
        }
    };
    Some(
        div()
            .id(SharedString::from(format!("sync-{label}")))
            .flex_none()
            .size(px(16.))
            .flex()
            .items_center()
            .justify_center()
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx))
            .child(icon(glyph, 13., color))
            .into_any_element(),
    )
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

    /// The signed-in Cloud page body, under the header `rail.rs` draws.
    pub(super) fn render_cloud_library(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = themes::palette(cx);
        let scope = self.cloud.selected_scope();
        let q = self.cloud_query(cx);
        v_flex()
            .flex_1()
            .min_h_0()
            .size_full()
            .relative()
            .child(self.render_cloud_filters(scope.as_ref(), &q, &p, cx))
            .child(
                div()
                    .id("cloud-workspace-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(px(28.))
                    .py(px(20.))
                    .child(
                        v_flex()
                            .w_full()
                            .max_w(px(1180.))
                            .mx_auto()
                            .gap(px(32.))
                            .child(self.render_cloud_files(scope.as_ref(), &q, &p, cx))
                            .child(self.render_cloud_snapshots(scope.as_ref(), &q, &p, cx)),
                    ),
            )
            .into_any_element()
    }

    /// The area picker and `LibraryDocumentFilters` in its workspace layout.
    fn render_cloud_filters(&self, scope: Option<&Scope>, q: &Query, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let areas = scope.and_then(|s| self.cloud.listing(s)).map(|l| l.areas.clone()).unwrap_or_default();
        let area_label = self
            .cloud
            .area
            .as_ref()
            .and_then(|id| areas.iter().find(|a| &a.id == id))
            .map(|a| a.label.clone())
            .unwrap_or_else(|| "All areas".into());
        let type_label = TYPES.iter().find(|(f, _)| *f == q.format).map(|(_, l)| *l).unwrap_or("All types");
        let sort_label = SORTS.iter().find(|(s, _)| *s == q.sort).map(|(_, l)| *l).unwrap_or("Default order");
        let menu = self.cloud.menu;
        let toggle = |m: Menu| move |this: &mut Self, _: &ClickEvent, _: &mut Window, cx: &mut Context<Self>| {
            this.cloud.menu = if this.cloud.menu == Some(m) { None } else { Some(m) };
            cx.notify();
        };
        div().flex_none().border_b_1().border_color(p.border.opacity(0.6)).px(px(28.)).py(px(16.)).child(
            v_flex()
                .w_full()
                .max_w(px(1180.))
                .mx_auto()
                .gap(px(12.))
                .when(scope.is_some(), |el| {
                    el.child(h_flex().justify_end().child(
                        div()
                            .relative()
                            .w(px(300.))
                            .child(
                                select_button("cloud-area-picker", Some("Cloud area"), &area_label, menu == Some(Menu::Area), p)
                                    .w_full()
                                    .on_click(cx.listener(toggle(Menu::Area))),
                            )
                            .when(menu == Some(Menu::Area), |el| el.child(self.render_cloud_menu(Menu::Area, scope, p, cx))),
                    ))
                })
                .child(
                    h_flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.))
                        .child(div().min_w(px(220.)).flex_1().child(filter_field(&self.cloud_search, 11.5, p)))
                        .child(
                            h_flex()
                                .flex_wrap()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .relative()
                                        .min_w(px(154.))
                                        .max_w(px(190.))
                                        .flex_1()
                                        .child(
                                            select_button("cloud-type", None, type_label, menu == Some(Menu::Type), p)
                                                .w_full()
                                                .on_click(cx.listener(toggle(Menu::Type))),
                                        )
                                        .when(menu == Some(Menu::Type), |el| el.child(self.render_cloud_menu(Menu::Type, scope, p, cx))),
                                )
                                .child(
                                    div()
                                        .relative()
                                        .min_w(px(154.))
                                        .max_w(px(190.))
                                        .flex_1()
                                        .child(
                                            select_button("cloud-sort", None, sort_label, menu == Some(Menu::Sort), p)
                                                .w_full()
                                                .on_click(cx.listener(toggle(Menu::Sort))),
                                        )
                                        .when(menu == Some(Menu::Sort), |el| el.child(self.render_cloud_menu(Menu::Sort, scope, p, cx))),
                                ),
                        )
                        .when(q.active(), |el| {
                            el.child(
                                div()
                                    .id("cloud-clear-filters")
                                    .h(px(32.))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .rounded(px(6.))
                                    .px(px(8.))
                                    .text_size(px(11.))
                                    .text_color(p.muted)
                                    .hover(|s| s.bg(p.accent.opacity(0.4)).text_color(p.foreground))
                                    .cursor_pointer()
                                    .child("Clear filters")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.cloud.type_filter = None;
                                        this.cloud.sort = Sort::Default;
                                        this.cloud_search.update(cx, |s, cx| {
                                            s.set_value("", window, cx);
                                            s.focus(window, cx);
                                        });
                                        cx.notify();
                                    })),
                            )
                        }),
                ),
        )
    }

    /// A menu under its button (`top-full mt-1.5`): type, order, or the area chips.
    fn render_cloud_menu(&self, menu: Menu, scope: Option<&Scope>, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let panel = |id: &'static str| menu_panel(&p).id(id).occlude().p(px(4.)).rounded(px(10.));
        let close = cx.listener(|this, _: &MouseDownEvent, _, cx| {
            this.cloud.menu = None;
            cx.notify();
        });
        let item = |id: SharedString, label: SharedString, on: bool| {
            div()
                .id(id)
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .px(px(8.))
                .py(px(6.))
                .rounded(px(6.))
                .text_size(px(11.5))
                .text_color(p.foreground)
                .hover(|s| s.bg(p.accent.opacity(0.4)))
                .cursor_pointer()
                .child(label)
                .child(div().w(px(14.)).child(if on { "✓" } else { "" }))
        };
        let body = match menu {
            Menu::Type => panel("cloud-type-menu")
                .min_w(px(154.))
                .max_w(px(230.))
                .children(TYPES.iter().enumerate().map(|(i, (format, label))| {
                    let format = *format;
                    item(SharedString::from(format!("cloud-type-{i}")), (*label).into(), self.cloud.type_filter == format).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.cloud.type_filter = format;
                            this.cloud.menu = None;
                            cx.notify();
                        },
                    ))
                }))
                .on_mouse_down_out(close)
                .into_any_element(),
            Menu::Sort => panel("cloud-sort-menu")
                .min_w(px(154.))
                .max_w(px(230.))
                .children(SORTS.iter().enumerate().map(|(i, (sort, label))| {
                    let sort = *sort;
                    item(SharedString::from(format!("cloud-sort-{i}")), (*label).into(), self.cloud.sort == sort).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.cloud.sort = sort;
                            this.cloud.menu = None;
                            cx.notify();
                        },
                    ))
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
                    .child(h_flex().flex_wrap().gap(px(4.)).children(chips))
                    .on_mouse_down_out(close)
                    .into_any_element()
            }
        };
        div()
            .absolute()
            .top(px(32. + 6.))
            .left_0()
            .child(deferred(anchored().snap_to_window_with_margin(px(8.)).child(body)))
    }

    /// `CloudView` beside the snapshots (`alongsideSnapshots`).
    fn render_cloud_files(&self, scope: Option<&Scope>, q: &Query, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let listing = scope.and_then(|s| self.cloud.listing(s));
        let docs = listing.and_then(|l| l.docs.clone()).unwrap_or_default();
        let by_me = listing.and_then(|l| l.shared_by_me.as_deref());
        let by_me_error = listing.is_some_and(|l| l.shared_by_me_error);
        let cloud_error = listing.and_then(|l| l.error.clone());
        let local: Vec<(PathBuf, Option<String>)> = match scope {
            Some(s) => self
                .cloud
                .bindings
                .iter()
                .filter(|(path, b)| {
                    s.matches(b)
                        && self.cloud.remote(path).is_none()
                        && matches!(b.record.state, markie_cloud::sync::SyncState::Unpushed | markie_cloud::sync::SyncState::Paused | markie_cloud::sync::SyncState::Conflict)
                })
                .map(|(path, b)| (path.clone(), b.record.cloud_doc_id.clone()))
                .collect(),
            None => Vec::new(),
        };
        let all = match scope {
            Some(s) => entries(&docs, by_me, &local, |id| self.cloud.find(s, id), self.cloud.area.as_deref()),
            None => Vec::new(),
        };
        let matched = query(all, q);
        let mut counts: HashMap<Source, usize> = HashMap::new();
        for e in &matched {
            *counts.entry(e.source).or_default() += 1;
        }
        let sources = self.cloud.sources.clone();
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
        let has_files = !matched.is_empty();
        let band = scoped_band(matched.len(), shown.len(), lists, q.searching());
        let condensed = !has_files;
        let share_list_known = by_me.is_some() && !by_me_error;
        let includes = |s: Source| sources.is_empty() || sources.contains(&s);
        let share_list_matters = includes(Source::ByMe) || includes(Source::OnlyMe);
        let settled = cloud_error.is_none() && (share_list_known || !share_list_matters);
        let (empty_title, empty_body) = empty_copy(&sources, q.searching());

        let chips = (!booting && !condensed).then(|| {
            let mut row = vec![chip("cloud-chip-all", sources.is_empty(), &p)
                .child("All")
                .child(div().opacity(0.7).child(matched.len().to_string()))
                .on_click(cx.listener(|this, _, _, cx| this.set_cloud_sources(Vec::new(), cx)))];
            for (source, id, label, _) in SOURCES {
                let on = sources.contains(&source);
                row.push(
                    chip(SharedString::from(format!("cloud-chip-{id}")), on, &p)
                        .child(label)
                        .child(div().opacity(0.7).child(counts.get(&source).copied().unwrap_or(0).to_string()))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let mut next = this.cloud.sources.clone();
                            if let Some(i) = next.iter().position(|s| *s == source) {
                                next.remove(i);
                            } else {
                                next.push(source);
                            }
                            this.set_cloud_sources(next, cx);
                        })),
                );
            }
            h_flex().flex_none().flex_wrap().items_center().gap(px(4.)).mb(px(12.)).children(row)
        });

        let show_list = !(condensed && !by_me_error && by_me.is_some()) && !booting;
        let rows: Vec<AnyElement> = shown.iter().map(|e| self.render_cloud_row(scope.cloned(), e, share_list_known, &p, cx)).collect();
        v_flex()
            .min_h_0()
            .child(
                div()
                    .mb(px(12.))
                    .flex_none()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(p.border.opacity(0.7))
                    .bg(p.background.opacity(0.35))
                    .px(px(12.))
                    .py(px(8.))
                    .text_size(px(11.))
                    .text_color(p.muted)
                    .child(band),
            )
            .children(chips)
            .when(!booting, |el| el.children(self.render_share_requests(cx)))
            // Nothing has arrived yet: the skeleton stands for the whole list.
            .when(booting, |el| el.child(skeleton(&p)))
            .when(show_list, |el| {
                el.child(
                    v_flex()
                        .min_w_0()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(p.border.opacity(0.75))
                        .bg(p.surface2.opacity(0.55))
                        .p(px(8.))
                        .when(by_me_error && share_list_matters, |el| {
                            el.child(empty_state(
                                "markie/people.svg",
                                "Couldn't load the documents you've shared",
                                "The server didn't answer. Your shares are unchanged.",
                                Some(("Try again", cx.listener(|this, _, _, cx| this.refresh_cloud(false, cx)))),
                                &p,
                            ))
                        })
                        .children(rows)
                        .when(by_me.is_none() && !by_me_error && share_list_matters, |el| el.child(skeleton(&p)))
                        .when(shown.is_empty() && settled && !condensed, |el| {
                            el.child(empty_state("markie/cloud.svg", &empty_title, empty_body, None::<(&'static str, fn(&ClickEvent, &mut Window, &mut App))>, &p))
                        }),
                )
            })
            .when_some(cloud_error, |el, e| {
                el.child(div().mt(px(8.)).px(px(8.)).text_size(px(11.)).text_color(p.red).child(e))
            })
    }

    /// One document: the Library row (icon, name, type, sync state), then the
    /// line saying how it reached this account, with Manage on rows you share.
    fn render_cloud_row(&self, scope: Option<Scope>, e: &Entry, share_list_known: bool, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let format = format_of(&e.name);
        let local = e.path.clone();
        let badge = local.as_deref().and_then(|path| self.cloud.badge(path));
        let shared = e.doc.as_ref().is_some_and(|d| d.shared);
        let state = if shared {
            None
        } else if local.is_none() {
            None
        } else {
            badge
        };
        let media = local.as_deref().and_then(|path| self.cloud.media_note(path)).map(|m| m.trim_start_matches(" · ").to_string());
        let doc = e.doc.clone();
        let share = e.share.clone();
        let entry_name = e.name.clone();
        let open_path = local.clone().filter(|p| p.is_file());
        let shared_line = doc.as_ref().filter(|d| d.shared && (d.shared_by.is_some() || d.role.is_some())).map(|d| {
            let mut line = match &d.shared_by {
                Some(by) => format!("Shared by {by}"),
                None => "Shared with you".into(),
            };
            if let Some(role) = d.role {
                line.push_str(if role == Role::Editor { " · Editor" } else { " · Viewer" });
            }
            line
        });
        let manage = share.clone().filter(|_| e.source == Source::ByMe);
        let row_id = SharedString::from(format!("cloud-row-{}", e.key));
        let clickable = open_path.is_some() || doc.is_some();
        v_flex()
            .id(row_id)
            .group("cloud-row")
            .rounded(px(6.))
            .px(px(8.))
            .py(px(6.))
            .when(clickable, |el| el.cursor_pointer().hover(|s| s.bg(p.accent.opacity(0.4))))
            .child(
                h_flex()
                    .gap(px(6.))
                    .child(format_icon(format, 13., &p))
                    .child(div().flex_1().min_w_0().truncate().text_size(px(12.5)).text_color(p.foreground).child(entry_name.clone()))
                    .child(format_badge(format, &p))
                    .children(sync_icon(state, shared, &p)),
            )
            .when(local.as_ref().is_some_and(|p| !p.exists()), |el| {
                el.child(div().pl(px(20.)).text_size(px(10.)).text_color(p.red).child("Missing on disk"))
            })
            .when_some(shared_line, |el, line| el.child(div().pl(px(20.)).truncate().text_size(px(10.)).text_color(p.muted).child(line)))
            .child(
                h_flex()
                    .min_w_0()
                    .gap(px(6.))
                    .pt(px(2.))
                    .pl(px(20.))
                    .text_size(px(10.))
                    .text_color(p.muted)
                    .child(source_badge(e.source, source_badge_text(e, share_list_known), &p))
                    .when_some(media, |el, m| el.child(div().min_w_0().truncate().child(m)))
                    .when(e.doc.is_none() && e.share.is_some(), |el| {
                        el.children(
                            e.updated_at
                                .as_deref()
                                .and_then(|u| chrono::DateTime::parse_from_rfc3339(u).ok())
                                .map(|d| super::account::short_ago_ms(d.timestamp_millis()))
                                .filter(|s| !s.is_empty()),
                        )
                    })
                    .when_some(manage, |el, share| {
                        el.child(
                            div()
                                .id(SharedString::from(format!("cloud-manage-{}", share.id)))
                                .ml_auto()
                                .flex_none()
                                .invisible()
                                .group_hover("cloud-row", |s| s.visible())
                                .text_size(px(10.))
                                .text_color(p.muted)
                                .hover(|s| s.text_color(p.foreground))
                                .cursor_pointer()
                                .child("Manage")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.manage_cloud_share(share.id.clone(), share.name.clone(), window, cx);
                                })),
                        )
                    }),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                if let Some(path) = open_path.clone() {
                    this.open_path(&path, window, cx);
                } else if let (Some(scope), Some(doc)) = (scope.clone(), doc.clone()) {
                    this.open_cloud_text(scope, doc.id.clone(), doc.name.clone(), window, cx);
                }
            }))
            .into_any_element()
    }

    /// `DocumentCloudLibrary` in the workspace.
    fn render_cloud_snapshots(&self, scope: Option<&Scope>, q: &Query, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let listing = scope.and_then(|s| self.cloud.listing(s));
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
        let mut rows: Vec<SnapshotMeta> = all
            .into_iter()
            .filter(|r| q.format.is_none_or(|f| r.format == f))
            .filter(|r| words.iter().all(|w| r.name.to_lowercase().contains(w)))
            .collect();
        if q.sort != Sort::Default {
            rows.sort_by(|a, b| {
                let primary = match q.sort {
                    Sort::Recent => b.updated_at.cmp(&a.updated_at),
                    Sort::Type => format_key(a.format).cmp(format_key(b.format)),
                    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                };
                primary.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.id.cmp(&b.id))
            });
        }
        let status = if listing.is_some() && !loading && error.is_none() {
            format!("{} of {} snapshots", rows.len(), total)
        } else if scope.is_some() {
            "Snapshots".into()
        } else {
            "Account required".into()
        };
        let tokens = Tokens::current(&self.registry.as_ref().and_then(|r| r.setting("style_template").ok().flatten()).unwrap_or_else(|| "markie".into()), cx);
        let refresh = |label: &'static str, cx: &mut Context<Self>| {
            div()
                .id(SharedString::from(format!("cloud-snapshots-{label}")))
                .h(px(28.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(6.))
                .px(px(8.))
                .text_size(px(11.))
                .text_color(p.muted)
                .when(self.cloud.checking, |el| el.opacity(0.4))
                .hover(|s| s.bg(p.accent.opacity(0.4)).text_color(p.foreground))
                .cursor_pointer()
                .child(icon("markie/refresh.svg", 12., p.muted))
                .child(label)
                .on_click(cx.listener(|this, _, _, cx| this.refresh_cloud(false, cx)))
        };
        let now = chrono::Local::now();
        let body: AnyElement = if scope.is_none() {
            state_card("Sign in to view snapshots", None, false, None, &p).into_any_element()
        } else if let Some((title, detail)) = error {
            state_card(&title, Some(detail), true, Some(refresh("Try again", cx).into_any_element()), &p).into_any_element()
        } else if listing.is_none() {
            state_card("Loading snapshots…", None, false, None, &p).into_any_element()
        } else if rows.is_empty() {
            if total > 0 {
                state_card("No snapshots match these filters", None, false, None, &p).into_any_element()
            } else {
                state_card("No document snapshots yet", Some("Share a local document to create one.".into()), false, None, &p).into_any_element()
            }
        } else {
            // `xl:grid-cols-2`: two columns at Markie's usual window width.
            let cards: Vec<AnyElement> = rows
                .iter()
                .map(|row| {
                    let meta = snapshot_meta(row, now);
                    let target = (scope.cloned(), row.clone());
                    div()
                        .id(SharedString::from(format!("snapshot-{}", row.id)))
                        .group("snapshot-card")
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .rounded(px(12.))
                        .border_1()
                        .border_color(p.border.opacity(0.75))
                        .bg(p.surface2.opacity(0.65))
                        .px(px(12.))
                        .py(px(10.))
                        .hover(|s| s.border_color(p.foreground.opacity(0.2)).bg(p.accent.opacity(0.45)))
                        .cursor_pointer()
                        .child(dialog_chrome::format_mark(format_key(row.format), "md", &tokens))
                        .child(
                            v_flex()
                                .min_w_0()
                                .flex_1()
                                .child(div().truncate().text_size(px(14.)).text_color(p.foreground).child(row.name.clone()))
                                .child(div().mt(px(2.)).truncate().text_size(px(11.)).text_color(p.muted).child(meta)),
                        )
                        .child(div().flex_none().text_size(px(14.)).text_color(p.muted).invisible().group_hover("snapshot-card", |s| s.visible()).child("Open"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if let (Some(scope), meta) = (target.0.clone(), target.1.clone()) {
                                this.show_snapshot(scope, meta, window, cx);
                            }
                        }))
                        .into_any_element()
                })
                .collect();
            let mut left = Vec::new();
            let mut right = Vec::new();
            for (i, c) in cards.into_iter().enumerate() {
                if i % 2 == 0 { left.push(c) } else { right.push(c) }
            }
            h_flex()
                .items_start()
                .gap(px(8.))
                .child(v_flex().flex_1().min_w_0().gap(px(8.)).children(left))
                .child(v_flex().flex_1().min_w_0().gap(px(8.)).children(right))
                .into_any_element()
        };
        v_flex()
            .min_w_0()
            .child(
                h_flex()
                    .mb(px(12.))
                    .justify_between()
                    .gap(px(12.))
                    .child(div().text_size(px(11.)).text_color(p.muted).child(status))
                    .child(refresh("Refresh", cx)),
            )
            .child(body)
    }
}

/// `stateCard` in document-cloud-library.tsx (workspace form).
fn state_card(title: &str, body: Option<String>, alert: bool, action: Option<AnyElement>, p: &Palette) -> Div {
    h_flex()
        .max_w(px(576.))
        .items_start()
        .gap(px(12.))
        .rounded(px(12.))
        .border_1()
        .border_color(p.border.opacity(0.8))
        .bg(p.surface2.opacity(0.7))
        .px(px(16.))
        .py(px(12.))
        .child(
            div()
                .mt(px(2.))
                .flex_none()
                .size(px(28.))
                .rounded_full()
                .border_1()
                .border_color(if alert { p.red.opacity(0.5) } else { p.border })
                .flex()
                .items_center()
                .justify_center()
                .child(icon("markie/cloud.svg", 14., if alert { p.red } else { p.muted })),
        )
        .child(
            v_flex()
                .min_w_0()
                .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(title.to_string()))
                .when_some(body, |el, b| el.child(div().mt(px(2.)).text_size(px(11.)).text_color(p.muted).child(b))),
        )
        .when_some(action, |el, a| el.child(div().ml_auto().flex_none().child(a)))
}

/// `CloudEmptyState`.
fn empty_state(glyph: &'static str, title: &str, body: &str, action: Option<(&'static str, impl Fn(&ClickEvent, &mut Window, &mut App) + 'static)>, p: &Palette) -> Div {
    div().px(px(8.)).py(px(12.)).child(
        div()
            .rounded(px(6.))
            .border_1()
            .border_color(p.border.opacity(0.7))
            .bg(p.background.opacity(0.45))
            .px(px(10.))
            .py(px(10.))
            .child(
                h_flex()
                    .items_start()
                    .gap(px(8.))
                    .child(div().mt(px(1.)).flex_none().child(icon(glyph, 15., p.muted)))
                    .child(
                        v_flex()
                            .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(title.to_string()))
                            .when(!body.is_empty(), |el| el.child(div().mt(px(2.)).text_size(px(11.)).text_color(p.muted).child(body.to_string())))
                            .when_some(action, |el, (label, on_click)| {
                                el.child(
                                    div()
                                        .id("cloud-empty-action")
                                        .mt(px(6.))
                                        .text_size(px(11.))
                                        .text_color(p.foreground)
                                        .underline()
                                        .cursor_pointer()
                                        .child(label)
                                        .on_click(on_click),
                                )
                            }),
                    ),
            ),
    )
}

/// `CloudSkeleton`.
fn skeleton(p: &Palette) -> Div {
    v_flex().children(["68%", "52%", "76%", "44%"].map(|w| {
        let frac = w.trim_end_matches('%').parse::<f32>().unwrap_or(50.) / 100.;
        div().rounded(px(6.)).px(px(8.)).py(px(6.)).child(
            h_flex()
                .gap(px(6.))
                .child(div().size(px(13.)).flex_none().rounded(px(4.)).bg(p.accent))
                .child(div().h(px(10.)).flex_1().child(div().h_full().w(relative(frac)).rounded(px(4.)).bg(p.accent)))
                .child(div().h(px(12.)).w(px(32.)).flex_none().rounded(px(4.)).bg(p.accent)),
        )
    }))
}

#[cfg(test)]
mod tests {
    // Not `super::*`: that brings in GPUI's own `test` macro.
    use super::{
        DocMeta, FormatKind, Lists, Query, Role, SharedByMeDoc, Sort, Source, band_text, empty_copy, entries, file_size, query,
        scoped_band, share_badge_text, snapshot_error, source_badge_text, sources_from_setting, sources_to_setting,
    };

    fn doc(id: &str, name: &str, updated: &str, shared: bool) -> DocMeta {
        DocMeta {
            id: id.into(),
            name: name.into(),
            version: 1,
            hash: None,
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
    fn sources_come_from_ownership_and_the_shared_list_newest_first() {
        let docs = vec![
            doc("a", "alpha.md", "2026-11-21T10:00:00Z", false),
            doc("b", "beta.md", "2026-11-22T10:00:00Z", true),
            doc("c", "gamma.docx", "2026-11-19T10:00:00Z", false),
        ];
        let by_me = vec![share("c", "gamma.docx", 2, 1), share("z", "only-shared.md", 1, 0)];
        let rows = entries(&docs, Some(&by_me), &[], |_| None, None);
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

    #[test]
    fn type_and_order_menus_filter_like_library_document_query() {
        let docs = vec![
            doc("a", "Notes.md", "2026-11-21T10:00:00Z", false),
            doc("b", "report.docx", "2026-11-22T10:00:00Z", false),
            doc("c", "data.csv", "2026-11-20T10:00:00Z", false),
            doc("d", "archive.zip", "2026-11-18T10:00:00Z", false),
        ];
        let rows = entries(&docs, Some(&[]), &[], |_| None, None);
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
        assert_eq!(scoped_band(0, 0, Lists::Loading, false), "Checking file sync and sharing…");
        assert_eq!(scoped_band(0, 0, Lists::Incomplete, false), "Some synced or shared files didn't load");
        assert_eq!(scoped_band(0, 0, Lists::Ready, true), "No synced or shared files match these filters.");
        assert_eq!(scoped_band(0, 0, Lists::Ready, false), "No synced or shared files yet.");
        assert_eq!(empty_copy(&[], false).0, "Nothing in your cloud yet");
        assert_eq!(empty_copy(&[Source::ByMe, Source::WithMe], false).0, "No documents you've shared or shared with you yet");
        assert_eq!(empty_copy(&[Source::OnlyMe], true).0, "No documents only you can see match this search");
        assert_eq!(share_badge_text(&share("x", "x", 0, 0)), "Shared");
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
