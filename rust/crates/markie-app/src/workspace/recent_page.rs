//! The Recent page: every recent document as a grid of cards in the document
//! area, newest first and grouped by when it was last opened. It is what a
//! launch with no file shows, and one click away on the left rail.
//!
//! The page and the Library panel's Recent list read the same `Library`
//! (`shell.recent`) through the same filter, type and sort, so they can never
//! disagree. Starred is this page's own filter; leaving the page puts the
//! shared list back on Recent.
//!
//! A card opens on click or Enter, has the Library row's ⋯ and right-click
//! menu, and a file that is gone stays as "Missing on disk" with Remove.
//!
//! Cards are selectable: ⌘-click, ⇧-click, ⌘A, ⇧ with the arrows, Space, or
//! the checkbox a card shows on hover. Escape clears. With anything
//! selected a bar over the grid offers Move to Folder… (the Projects tab's
//! folders), Remove from Folder, Star and Open, each undone by one ⌘Z.
//! Selected cards drag onto a folder in the Projects tab.
use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::chrome::menu_panel;
use super::doc_grid::{self, CardEvent, DocCard, Grid, GridView, Mark, MarkTone, Section, Thumb};
use super::doc_preview::{self, Lookup, Want};
use super::library_rows::{RowAction, SyncStatus};
use super::rail::{FilterMenu, LeftView, RAIL_WIDTH, TYPE_MENU, filter_field, type_menu_label};
use super::ui::{self, Tone};
use super::projects::DragItems;
use super::source::{EditSelectAll, EditUndo};
use crate::actions::{NewDocument, Open};
use markie_core::projects::folders::Item;
use crate::library::{LibraryTab, SortOrder};
use crate::themes::{self, Palette};

/// The registry settings that remember grid or list on each page.
pub(super) const RECENT_VIEW_KEY: &str = "recent_page_view";
pub(super) const CLOUD_VIEW_KEY: &str = "cloud_page_view";

/// The page's side margin, the same as its header's and the Browse page's.
pub(super) const PAGE_PAD: f32 = 20.;

/// The width a page's grid has in a window this wide: all of it, so the
/// grid lines up with the header and adds columns as the window widens.
pub(super) fn page_width(viewport: f32) -> f32 {
    ((viewport - RAIL_WIDTH).min(PAGE_MAX) - 2. * PAGE_PAD).max(doc_grid::CARD_MIN)
}

/// The widest the column of a document page (Recent, Cloud, Browse) gets,
/// padding included: about six cards, or a list row whose name, age and
/// badge still read as one line. Past it Recent and Cloud centre the column;
/// Browse keeps it against the rail, with its folder tree, as Finder does.
pub(super) const PAGE_MAX: f32 = 1200.;

/// Extra room on each side of the column once the window is wider than
/// [`PAGE_MAX`]. The header and toolbar add it to their padding, so their
/// hairlines still run the full width while every row lines up.
pub(super) fn page_gutter(viewport: f32) -> f32 {
    ((viewport - RAIL_WIDTH - PAGE_MAX) / 2.).max(0.).floor()
}

// ------------------------------------------------------------------ model

/// When a document was last opened, as the page groups it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Group {
    Today,
    Week,
    Earlier,
}

impl Group {
    pub(super) const ALL: [Group; 3] = [Group::Today, Group::Week, Group::Earlier];

    pub(super) fn label(self) -> &'static str {
        match self {
            Group::Today => "Today",
            Group::Week => "This week",
            Group::Earlier => "Earlier",
        }
    }
}

fn local(ms: f64) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::TimeZone as _;
    if !(ms.is_finite() && ms > 0.) {
        return None;
    }
    chrono::Local.timestamp_millis_opt(ms as i64).single()
}

/// Today is the same calendar day; This week the six days before it. A
/// document with no time on record is Earlier.
pub(super) fn group_of(opened_ms: f64, now: chrono::DateTime<chrono::Local>) -> Group {
    let Some(then) = local(opened_ms) else { return Group::Earlier };
    match (now.date_naive() - then.date_naive()).num_days() {
        d if d <= 0 => Group::Today,
        d if d < 7 => Group::Week,
        _ => Group::Earlier,
    }
}

/// Rows in their groups, the order inside each kept. Empty groups are left out.
pub(super) fn grouped(times: &[f64], now: chrono::DateTime<chrono::Local>) -> Vec<(Group, Vec<usize>)> {
    Group::ALL
        .into_iter()
        .map(|g| (g, (0..times.len()).filter(|i| group_of(times[*i], now) == g).collect::<Vec<_>>()))
        .filter(|(_, rows)| !rows.is_empty())
        .collect()
}

/// Whether the list is in time order, so grouping by time reads right: the
/// Recent list in its own order, or any list sorted by Most recent.
pub(super) fn groups_by_time(tab: LibraryTab, sort: SortOrder) -> bool {
    sort == SortOrder::Recent || (tab == LibraryTab::Recent && sort == SortOrder::Default)
}

/// "2 hours ago", "yesterday", "Monday", "Nov 3", "Nov 3, 2025".
fn ago(then: chrono::DateTime<chrono::Local>, now: chrono::DateTime<chrono::Local>) -> String {
    use chrono::Datelike as _;
    let seconds = (now - then).num_seconds().max(0);
    let plural = |n: i64, unit: &str| format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" });
    if seconds < 60 {
        return "just now".into();
    }
    if seconds < 3600 {
        return plural(seconds / 60, "minute");
    }
    match (now.date_naive() - then.date_naive()).num_days() {
        d if d <= 0 => plural(seconds / 3600, "hour"),
        1 => "yesterday".into(),
        d if d < 7 => then.format("%A").to_string(),
        _ if then.year() == now.year() => then.format("%b %-d").to_string(),
        _ => then.format("%b %-d, %Y").to_string(),
    }
}

/// "Created today", "Created yesterday", "Created Nov 3", "Created Nov 3,
/// 2025": a calendar day, since the hour a file was made rarely matters.
/// None when the time is unknown, so nothing is shown rather than a guess.
pub(super) fn created_line(ms: Option<f64>, now: chrono::DateTime<chrono::Local>) -> Option<String> {
    use chrono::Datelike as _;
    let then = local(ms?)?;
    let day = match (now.date_naive() - then.date_naive()).num_days() {
        d if d <= 0 => "today".to_string(),
        1 => "yesterday".to_string(),
        _ if then.year() == now.year() => then.format("%b %-d").to_string(),
        _ => then.format("%b %-d, %Y").to_string(),
    };
    Some(format!("Created {day}"))
}

/// A narrow list has no room for a Created column beside the name and its
/// age: the name keeps it. Cards always have the line.
pub(super) fn shows_created(view: doc_grid::GridView, page_width: f32) -> bool {
    view == doc_grid::GridView::Grid || page_width >= 720.
}

/// A card's quiet line: when it was opened, or when the file last changed
/// for a starred file never opened here.
pub(super) fn meta_line(opened_ms: f64, modified_ms: f64, missing: bool, now: chrono::DateTime<chrono::Local>) -> String {
    if missing {
        return "Missing on disk".into();
    }
    if let Some(then) = local(opened_ms) {
        return format!("Opened {}", ago(then, now));
    }
    match local(modified_ms) {
        Some(then) => format!("Edited {}", ago(then, now)),
        None => String::new(),
    }
}

/// "12 documents", or "3 of 12 documents" under a filter.
pub(super) fn count_line(shown: usize, total: usize) -> String {
    let noun = if total == 1 { "document" } else { "documents" };
    if shown == total { format!("{total} {noun}") } else { format!("{shown} of {total} {noun}") }
}

/// What an empty page says, and whether it offers to clear the filters.
pub(super) fn empty_copy(tab: LibraryTab, total: usize, filtered: bool) -> (&'static str, &'static str, bool) {
    if total > 0 || filtered {
        return ("No documents match", "Try other words or another type.", true);
    }
    match tab {
        LibraryTab::Starred => ("Nothing starred yet", "Star a file in Browse to keep it here.", false),
        _ => ("No documents yet", "Documents you open or create show up here.", false),
    }
}

/// The sync state icon of a card. A file that is only on this device has none.
pub(super) fn sync_mark(status: SyncStatus) -> Option<Mark> {
    let (icon, tone) = match status {
        SyncStatus::LocalOnly => return None,
        SyncStatus::Synced => ("markie/sync-synced.svg", MarkTone::Green),
        SyncStatus::Unpushed => ("markie/sync-unpushed.svg", MarkTone::Yellow),
        SyncStatus::Paused => ("markie/sync-paused.svg", MarkTone::Yellow),
        SyncStatus::Conflict => ("markie/sync-conflict.svg", MarkTone::Red),
        SyncStatus::Behind => ("markie/sync-behind.svg", MarkTone::Blue),
        SyncStatus::Shared => ("markie/sync-shared.svg", MarkTone::Purple),
    };
    Some(Mark::new(icon, tone, status.label()))
}

// -------------------------------------------------------------- behaviour

impl Workspace {
    /// A document is opening: the Recent, Browse and Cloud pages make way for it.
    pub(super) fn leave_page_for_document(&mut self) {
        if matches!(self.shell.view, LeftView::Recent | LeftView::Browse | LeftView::Cloud) {
            self.shell.panel_open = false;
        }
    }

    /// Show the Recent page in the document area.
    pub(super) fn show_recent_page(&mut self, cx: &mut Context<Self>) {
        if !(self.shell.panel_open && self.shell.view == LeftView::Recent) {
            self.select_view(LeftView::Recent, cx);
        }
    }

    /// Grid or list, as each page was left.
    pub(super) fn restore_home_pages(&mut self) {
        let Some(reg) = &self.registry else { return };
        self.shell.recent_grid.view = GridView::parse(reg.setting(RECENT_VIEW_KEY).ok().flatten().as_deref());
        self.shell.cloud_grid.view = GridView::parse(reg.setting(CLOUD_VIEW_KEY).ok().flatten().as_deref());
    }

    fn set_recent_view(&mut self, view: GridView) {
        self.shell.recent_grid.view = view;
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting(RECENT_VIEW_KEY, view.as_str());
        }
    }

    /// Once a frame, before drawing: move the keyboard to a page that just
    /// opened, and ask for the thumbnails the open page still lacks.
    pub(super) fn sync_home_pages(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open = self.shell.panel_open;
        if std::mem::take(&mut self.shell.page_focus_owed) {
            let on_a_grid = self.shell.recent_grid.focus.is_focused(window) || self.shell.cloud_grid.focus.is_focused(window);
            match self.shell.view {
                LeftView::Recent if open => self.shell.recent_grid.focus.focus(window, cx),
                LeftView::Cloud if open => self.shell.cloud_grid.focus.focus(window, cx),
                // The page the keyboard was on has closed: back to the document.
                _ if on_a_grid && !self.workspace_page_open() => {
                    if self.rich_active() {
                        self.focus_rich(window, cx);
                    } else if self.mode == super::Mode::Source {
                        self.focus_editor(window, cx);
                    } else {
                        self.focus_handle.focus(window, cx);
                    }
                }
                _ => {}
            }
        }
        if open && self.shell.view == LeftView::Cloud {
            self.sync_cloud_previews(cx);
        }
        if open && self.shell.view == LeftView::Recent {
            let wants: Vec<(Want, PathBuf, markie_core::formats::FormatKind)> = {
                let recent = &self.shell.recent;
                recent
                    .hits()
                    .iter()
                    .map(|hit| recent.doc(hit))
                    .filter(|doc| !recent.is_missing(&doc.path))
                    .map(|doc| (Want::file(&doc.path, doc.mtime_ms, doc.size), doc.path.clone(), doc.format))
                    .collect()
            };
            self.build_file_previews(wants, cx);
        }
    }

    /// Build the thumbnails of files not built yet, off the main thread and a
    /// screenful at a time, so the first cards fill in first.
    pub(super) fn build_file_previews(&mut self, wants: Vec<(Want, PathBuf, markie_core::formats::FormatKind)>, cx: &mut Context<Self>) {
        if wants.is_empty() {
            return;
        }
        let owed = self.shell.previews.claim(wants.iter().map(|(want, ..)| want.clone()));
        if owed.is_empty() {
            return;
        }
        let keep: std::collections::HashSet<String> = wants.iter().map(|(want, ..)| want.key.clone()).collect();
        self.shell.previews.trim(&keep);
        let jobs: Vec<_> = wants.into_iter().filter(|(want, ..)| owed.contains(want)).collect();
        cx.spawn(async move |this, cx| {
            for chunk in jobs.chunks(24) {
                let chunk = chunk.to_vec();
                let built = cx.background_spawn(async move { doc_preview::build_files(chunk) }).await;
                let landed = this.update(cx, |this, cx| {
                    for (want, preview) in built {
                        this.shell.previews.put(want, preview);
                    }
                    cx.notify();
                });
                if landed.is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    /// The thumbnail of a file's card, from the cache.
    pub(super) fn file_thumb(&self, path: &Path, mtime_ms: f64, size: u64) -> Thumb {
        match self.shell.previews.lookup(&Want::file(path, mtime_ms, size)) {
            Lookup::Ready(preview) => Thumb::Page(preview),
            Lookup::Nothing => Thumb::Tile,
            Lookup::Owed => Thumb::Loading,
        }
    }

    fn recent_card_event(&mut self, id: &SharedString, event: CardEvent, window: &mut Window, cx: &mut Context<Self>) {
        let path = PathBuf::from(id.as_ref());
        match event {
            CardEvent::Open => {
                self.shell.row_menu = None;
                if !self.shell.recent.is_missing(&path) {
                    self.open_path(&path, window, cx);
                }
            }
            CardEvent::Menu(at) => {
                // A right click on another card moves the menu there.
                if self.shell.row_menu.as_ref().is_some_and(|(open, _)| *open != path) {
                    self.shell.row_menu = None;
                }
                self.open_row_menu(path, at, cx);
            }
            // The card's only button is a missing file's Remove.
            CardEvent::Action => self.run_row_action(path, RowAction::Forget, window, cx),
        }
    }

    // ---------------------------------------------------------------- render

    pub(super) fn render_recent_page(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let p = themes::palette(cx);
        let recent = &self.shell.recent;
        let (total, shown) = (recent.total(), recent.hits().len());
        let starred = recent.tab == LibraryTab::Starred;
        let width = page_width(f32::from(window.viewport_size().width));
        let gutter = page_gutter(f32::from(window.viewport_size().width));
        let now = chrono::Local::now();

        let header = ui::page_header("markie/recent.svg", "Recent", &p)
            .px(px(20. + gutter))
            .when(self.shell.lists_loaded && (total > 0 || starred), |el| el.child(ui::hint(count_line(shown, total), &p)))
            .child(div().flex_1())
            .child(ui::button("recent-open", "Open file", None, Tone::Quiet, false, &p).on_click(|_, window, cx| window.dispatch_action(Box::new(Open), cx)))
            .child(
                ui::button("recent-new", "New document", Some(IconName::Plus), Tone::Primary, false, &p)
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(NewDocument), cx)),
            );

        let body: AnyElement = if !self.shell.lists_loaded {
            doc_grid::skeleton(width, doc_grid::columns(width) * 2, &p).into_any_element()
        } else if shown == 0 {
            let (title, text, clear) = empty_copy(recent.tab, total, recent.query_active());
            ui::empty_state(if starred && !clear { "markie/star.svg" } else { "markie/recent.svg" }, title, text, &p)
                .child(h_flex().mt(px(16.)).gap(px(8.)).map(|row| {
                    if clear {
                        row.child(ui::button("recent-empty-clear", "Clear filters", None, Tone::Secondary, false, &p).on_click(cx.listener(|this, _, window, cx| this.clear_recent_filters(window, cx))))
                    } else if starred {
                        row.child(ui::button("recent-empty-all", "Show recent", None, Tone::Secondary, false, &p).on_click(cx.listener(|this, _, _, cx| {
                            this.shell.recent.set_tab(LibraryTab::Recent);
                            cx.notify();
                        })))
                    } else {
                        row.child(ui::button("recent-empty-open", "Open file", None, Tone::Secondary, false, &p).on_click(|_, window, cx| window.dispatch_action(Box::new(Open), cx)))
                            .child(ui::button("recent-empty-bring", "Bring in your documents\u{2026}", None, Tone::Secondary, false, &p).on_click(cx.listener(|this, _, window, cx| this.open_bring_docs(false, window, cx))))
                    }
                }))
                .into_any_element()
        } else {
            let current = self.doc.as_ref().filter(|d| !d.untitled).map(|d| d.path.clone());
            let docs: Vec<_> = recent.hits().iter().map(|hit| recent.doc(hit)).collect();
            let card = |i: usize| {
                let doc = docs[i];
                let missing = recent.is_missing(&doc.path);
                let mut card = DocCard::new(doc.path.to_string_lossy().into_owned(), doc.name.clone(), doc.format);
                card.meta = meta_line(recent.opened_ms(&doc.path), doc.mtime_ms, missing, now).into();
                card.thumb = if missing { Thumb::Tile } else { self.file_thumb(&doc.path, doc.mtime_ms, doc.size) };
                card.missing = missing;
                card.created = if missing || !shows_created(self.shell.recent_grid.view, width) {
                    None
                } else {
                    created_line(recent.created_ms(&doc.path), now).map(Into::into)
                };
                card.openable = !missing;
                card.current = current.as_deref() == Some(doc.path.as_path());
                card.menu_open = self.shell.row_menu.as_ref().is_some_and(|(open, _)| *open == doc.path);
                card.action = missing.then(|| "Remove".into());
                card.selectable = true;
                let carried: Vec<Item> = if self.shell.recent_grid.selection.contains(&card.id) && self.shell.recent_grid.selection.items.len() > 1 {
                    self.shell.recent_grid.selected().into_iter().map(|id| Item::File(id.to_string())).collect()
                } else {
                    vec![Item::File(doc.path.to_string_lossy().into_owned())]
                };
                card.drag = (!missing).then(|| DragItems::new(carried, &|i| match i {
                    Item::File(p) => Path::new(p).file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
                    Item::Folder(_) => String::new(),
                }));
                if self.shell.stars.contains(&doc.path) {
                    card.marks.push(Mark::new("markie/star.svg", MarkTone::Yellow, "Starred"));
                }
                if !missing {
                    card.marks.extend(sync_mark(self.row_status(&doc.path)));
                    card.marks.extend(super::google_docs::mark(&doc.path));
                }
                card
            };
            let sections = if groups_by_time(recent.tab, recent.sort) {
                let times: Vec<f64> = docs.iter().map(|d| recent.opened_ms(&d.path)).collect();
                grouped(&times, now).into_iter().map(|(group, rows)| Section::new(Some(group.label()), rows.into_iter().map(card).collect())).collect()
            } else {
                vec![Section::new(None, (0..docs.len()).map(card).collect())]
            };
            doc_grid::render(
                Grid {
                    id: "recent-grid",
                    sections,
                    width,
                    state: |this: &mut Self| &mut this.shell.recent_grid,
                    on_event: Rc::new(|this: &mut Self, id, event, window, cx| this.recent_card_event(id, event, window, cx)),
                },
                &self.shell.recent_grid,
                window,
                &p,
                cx,
            )
        };

        let selected = self.shell.recent_grid.selected();
        v_flex()
            .id("recent-page")
            .size_full()
            .bg(p.background)
            .on_action(cx.listener(|this, _: &EditSelectAll, _, cx| {
                this.shell.recent_grid.select_all();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &EditUndo, window, cx| {
                if !this.bulk_undo(window, cx) {
                    cx.propagate();
                }
            }))
            .child(header)
            // With no documents at all there is nothing to filter, as on Browse.
            .when(!(self.shell.lists_loaded && total == 0 && !starred && !recent.query_active()), |el| el.child(self.render_recent_toolbar(&p, cx).px(px(20. + gutter))))
            .when(!selected.is_empty(), |el| el.child(div().flex_none().px(px(gutter)).child(self.render_bulk_bar(&selected, &p, cx))))
            .child(
                div()
                    .id("recent-page-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.shell.recent_grid.scroll)
                    .px(px(PAGE_PAD + gutter))
                    .pt(px(8.))
                    .pb(px(28.))
                    .child(body),
            )
            .into_any_element()
    }

    /// The bar over a selection: how many, and what can be done to all of them.
    fn render_bulk_bar(&self, ids: &[SharedString], p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let p = *p;
        let paths: Vec<String> = ids.iter().map(|i| i.to_string()).collect();
        let in_folder = self.placed_among(&paths);
        let all_starred = ids.iter().all(|id| self.shell.stars.contains(Path::new(id.as_ref())));
        let n = ids.len();
        h_flex()
            .id("recent-bulk-bar")
            .flex_none()
            .mx(px(PAGE_PAD))
            .mt(px(4.))
            .mb(px(4.))
            .px(px(10.))
            .py(px(6.))
            .gap(px(8.))
            .rounded(px(9.))
            .border_1()
            .border_color(p.blue.opacity(0.45))
            .bg(p.blue.opacity(if p.dark { 0.14 } else { 0.07 }))
            .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(p.foreground).child(selected_label(n)))
            .child(div().flex_1())
            .child(ui::button("bulk-move", "Move to Folder…", None, Tone::Primary, false, &p).on_click(cx.listener(|this, _, window, cx| this.bulk_move(window, cx))))
            .when(in_folder > 0, |el| {
                el.child(ui::button("bulk-unfile", "Remove from Folder", None, Tone::Secondary, false, &p).on_click(cx.listener(|this, _, window, cx| this.bulk_remove_from_folder(window, cx))))
            })
            .child(
                ui::button("bulk-star", if all_starred { "Unstar" } else { "Star" }, None, Tone::Secondary, false, &p)
                    .on_click(cx.listener(|this, _, _, cx| this.bulk_star(cx))),
            )
            .child(ui::button("bulk-open", "Open", None, Tone::Secondary, false, &p).on_click(cx.listener(|this, _, window, cx| this.bulk_open(window, cx))))
            .child(
                ui::button("bulk-clear", "Clear", None, Tone::Quiet, false, &p)
                    .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Clear the selection  Esc").build(window, cx))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.shell.recent_grid.selection.clear();
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    fn bulk_items(&self) -> Vec<Item> {
        self.shell.recent_grid.selected().into_iter().map(|id| Item::File(id.to_string())).collect()
    }

    /// Move to Folder… for every selected document at once.
    fn bulk_move(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let items = self.bulk_items();
        self.shell.bulk_pending = Some(self.projects.history.depth());
        self.ask_move_to(items, window, cx);
    }

    /// Called once Move to… finishes: a move that was recorded gets one ⌘Z.
    pub(super) fn bulk_move_done(&mut self) {
        if let Some(before) = self.shell.bulk_pending.take()
            && self.projects.history.depth() > before
        {
            self.shell.bulk_undo.push(BulkUndo::Organize);
        }
    }

    fn bulk_remove_from_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let before = self.projects.history.depth();
        let paths: Vec<String> = self.shell.recent_grid.selected().into_iter().map(|id| id.to_string()).collect();
        self.remove_from_folder(paths, window, cx);
        if self.projects.history.depth() > before {
            self.shell.bulk_undo.push(BulkUndo::Organize);
        }
        cx.notify();
    }

    /// Star every selected document, or unstar them when all are starred.
    fn bulk_star(&mut self, cx: &mut Context<Self>) {
        let Some(reg) = self.registry.clone() else { return };
        let paths: Vec<PathBuf> = self.shell.recent_grid.selected().into_iter().map(|id| PathBuf::from(id.as_ref())).collect();
        let flips = star_flips(&paths, &self.shell.stars);
        for p in &flips {
            let _ = reg.toggle_star(p, "file");
        }
        if !flips.is_empty() {
            self.shell.bulk_undo.push(BulkUndo::Star(flips));
        }
        self.refresh_lists(cx);
        cx.notify();
    }

    fn bulk_open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let items = self.bulk_items();
        self.shell.recent_grid.selection.clear();
        self.open_items(&items, window, cx);
    }

    /// ⌘Z on the Recent page: the last bulk action. False when there is none.
    pub(super) fn bulk_undo(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(last) = self.shell.bulk_undo.pop() else { return false };
        match last {
            BulkUndo::Organize => self.projects_undo(false, window, cx),
            BulkUndo::Star(paths) => {
                if let Some(reg) = self.registry.clone() {
                    for p in &paths {
                        let _ = reg.toggle_star(p, "file");
                    }
                }
                self.refresh_lists(cx);
            }
        }
        cx.notify();
        true
    }

    /// One row, laid out as the Browse page's: filter by name, type, sort,
    /// Starred, then grid or list.
    fn render_recent_toolbar(&self, p: &Palette, cx: &mut Context<Self>) -> Div {
        let p = *p;
        let recent = &self.shell.recent;
        let menu = self.shell.filter_menu;
        let starred = recent.tab == LibraryTab::Starred;
        let type_label = recent.only_format().map_or("All types", |k| type_menu_label(Some(k)));
        let dropdown = |which: FilterMenu, id: &'static str, label: &str, width: f32, cx: &mut Context<Self>| {
            div()
                .relative()
                .flex_none()
                .w(px(width))
                .child(ui::select(id, label.to_string(), menu == Some(which), &p).w_full().on_click(cx.listener(move |this, _, _, cx| this.toggle_filter_menu(which, cx))))
                .when(menu == Some(which), |el| el.child(self.render_recent_menu(which, &p, cx)))
        };
        ui::toolbar(&p)
            .child(div().flex_1().min_w(px(176.)).max_w(px(460.)).child(filter_field(&self.shell.recent_filter, 13., &p)))
            .child(dropdown(FilterMenu::RecentType, "recent-type", type_label, 136., cx))
            .child(dropdown(FilterMenu::RecentSort, "recent-sort", recent.sort.label(), 136., cx))
            .child(
                ui::button("recent-starred", "Starred", Some(if starred { IconName::StarFill } else { IconName::Star }), Tone::Quiet, false, &p)
                    .when(starred, |b| b.bg(p.fg(0.08)).text_color(p.foreground))
                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(if starred { "Show every recent document" } else { "Show only starred documents" }).build(window, cx))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.shell.recent.set_tab(if starred { LibraryTab::Recent } else { LibraryTab::Starred });
                        cx.notify();
                    })),
            )
            .child(div().flex_1())
            .when(recent.query_active(), |el| {
                el.child(ui::button("recent-clear", "Clear filters", None, Tone::Quiet, false, &p).on_click(cx.listener(|this, _, window, cx| this.clear_recent_filters(window, cx))))
            })
            .child(doc_grid::view_toggle(self.shell.recent_grid.view, &p, cx, |this: &mut Self, view, _| this.set_recent_view(view)))
    }

    /// The type or sort menu, under its button.
    fn render_recent_menu(&self, menu: FilterMenu, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let rows: Vec<AnyElement> = match menu {
            FilterMenu::RecentSort => SortOrder::RECENT_PAGE
                .iter()
                .enumerate()
                .map(|(i, sort)| {
                    let sort = *sort;
                    ui::menu_row(("recent-sort-row", i), sort.label(), self.shell.recent.sort == sort, &p)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.shell.recent.set_sort(sort);
                            this.shell.filter_menu = None;
                            cx.notify();
                        }))
                        .into_any_element()
                })
                .collect(),
            _ => {
                let current = self.shell.recent.only_format();
                std::iter::once(None)
                    .chain(TYPE_MENU.iter().copied().map(Some))
                    .enumerate()
                    .map(|(i, kind)| {
                        ui::menu_row(("recent-type-row", i), type_menu_label(kind), current == kind, &p)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.shell.recent.set_only_format(kind);
                                this.shell.filter_menu = None;
                                cx.notify();
                            }))
                            .into_any_element()
                    })
                    .collect()
            }
        };
        div().absolute().top(px(32. + 6.)).left_0().child(deferred(
            anchored().snap_to_window_with_margin(px(8.)).child(
                menu_panel(&p)
                    .id("recent-page-menu")
                    .occlude()
                    .p(px(4.))
                    .min_w(px(150.))
                    .rounded(px(10.))
                    .children(rows)
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| this.close_filter_menu(cx))),
            ),
        ))
    }
}

#[cfg(feature = "scene")]
impl Workspace {
    /// The Recent page for a scene. `{recents, tab?: "starred", view?: "list",
    /// filter?, type?: "markdown", sort?: "name", cursor?: n, menu?: "type" |
    /// "sort" | "row"}`. Ready once the rows and their thumbnails are in.
    pub(super) fn scene_recent(&mut self, args: &serde_json::Value, step: &mut usize, launch: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let text = |key: &str| args.get(key).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        let wanted = args.get("recents").and_then(serde_json::Value::as_array).map_or(0, Vec::len);
        if *step == 0 {
            if launch {
                self.open_launch_page(window, cx);
            } else {
                self.show_recent_page(cx);
            }
            if text("view") == "list" {
                self.shell.recent_grid.view = GridView::List;
            } else {
                self.shell.recent_grid.view = GridView::Grid;
            }
            *step = 1;
            return false;
        }
        if !self.shell.lists_loaded || (*step == 1 && self.shell.recent.total() < wanted) {
            return false;
        }
        if *step == 1 {
            if text("tab") == "starred" {
                self.shell.recent.set_tab(LibraryTab::Starred);
            }
            let filter = text("filter");
            if !filter.is_empty() {
                self.shell.recent.set_text(&filter);
                self.shell.recent_filter.update(cx, |s, cx| s.set_value(filter, window, cx));
            }
            if text("type") == "markdown" {
                self.shell.recent.set_only_format(Some(markie_core::formats::FormatKind::Markdown));
            }
            match text("sort").as_str() {
                "name" => self.shell.recent.set_sort(SortOrder::Name),
                "type" => self.shell.recent.set_sort(SortOrder::Type),
                "created" => self.shell.recent.set_sort(SortOrder::Created),
                _ => {}
            }
            match text("menu").as_str() {
                "type" => self.shell.filter_menu = Some(FilterMenu::RecentType),
                "sort" => self.shell.filter_menu = Some(FilterMenu::RecentSort),
                _ => {}
            }
            *step = 2;
            cx.notify();
            return false;
        }
        let recent = &self.shell.recent;
        let owed = recent.hits().iter().map(|hit| recent.doc(hit)).any(|doc| {
            !recent.is_missing(&doc.path) && self.shell.previews.lookup(&Want::file(&doc.path, doc.mtime_ms, doc.size)) == Lookup::Owed
        });
        if owed {
            return false;
        }
        if *step == 2 {
            let ids: Vec<SharedString> = recent.hits().iter().map(|hit| SharedString::from(recent.doc(hit).path.to_string_lossy().into_owned())).collect();
            if let Some(n) = args.get("cursor").and_then(serde_json::Value::as_u64) {
                self.shell.recent_grid.cursor = ids.get(n as usize).cloned();
                self.shell.recent_grid.focus.focus(window, cx);
            }
            // `select: [n, …]`: cards picked as ⌘-clicks pick them.
            for n in args.get("select").and_then(serde_json::Value::as_array).into_iter().flatten().filter_map(serde_json::Value::as_u64) {
                if let Some(id) = ids.get(n as usize) {
                    self.shell.recent_grid.press(id, true, false);
                }
            }
            if args.get("select").is_some() {
                self.shell.recent_grid.focus.focus(window, cx);
            }
            if text("menu") == "row" {
                if let Some(id) = ids.get(1) {
                    self.open_row_menu(PathBuf::from(id.as_ref()), point(px(520.), px(330.)), cx);
                }
            }
            *step = 3;
            cx.notify();
            return false;
        }
        true
    }
}

/// One bulk action on the Recent page, to put back on ⌘Z.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum BulkUndo {
    /// A move or Remove from Folder: the folder history holds it.
    Organize,
    /// These stars were flipped.
    Star(Vec<PathBuf>),
}

/// "1 document selected", "3 documents selected".
pub(super) fn selected_label(n: usize) -> String {
    if n == 1 { "1 document selected".into() } else { format!("{n} documents selected") }
}

/// Which stars Star flips: all of them off when every one is starred,
/// otherwise on for the ones that are not.
pub(super) fn star_flips(paths: &[PathBuf], stars: &std::collections::HashSet<PathBuf>) -> Vec<PathBuf> {
    let all = !paths.is_empty() && paths.iter().all(|p| stars.contains(p));
    paths.iter().filter(|p| stars.contains(*p) == all).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::{created_line, selected_label, shows_created, star_flips};
    use crate::workspace::doc_grid::GridView;
    use super::{Group, PAGE_MAX, count_line, empty_copy, group_of, grouped, groups_by_time, meta_line, page_gutter, page_width, sync_mark};
    use crate::library::{LibraryTab, SortOrder};
    use crate::workspace::library_rows::SyncStatus;
    use chrono::TimeZone as _;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    fn ms(t: chrono::DateTime<chrono::Local>) -> f64 {
        t.timestamp_millis() as f64
    }

    #[test]
    fn the_created_line_is_a_day_and_nothing_when_unknown() {
        let now = at(2026, 11, 25, 15, 0);
        assert_eq!(created_line(Some(ms(at(2026, 11, 25, 9, 0))), now).as_deref(), Some("Created today"));
        assert_eq!(created_line(Some(ms(at(2026, 11, 24, 9, 0))), now).as_deref(), Some("Created yesterday"));
        assert_eq!(created_line(Some(ms(at(2026, 11, 3, 9, 0))), now).as_deref(), Some("Created Nov 3"));
        assert_eq!(created_line(Some(ms(at(2025, 11, 3, 9, 0))), now).as_deref(), Some("Created Nov 3, 2025"));
        assert_eq!(created_line(None, now), None);
        assert_eq!(created_line(Some(0.), now), None);
    }

    #[test]
    fn a_narrow_list_drops_the_created_column_but_cards_keep_the_line() {
        assert!(shows_created(GridView::Grid, 400.));
        assert!(!shows_created(GridView::List, 600.));
        assert!(shows_created(GridView::List, 1108.));
    }

    #[test]
    fn documents_group_by_the_day_they_were_opened() {
        let now = at(2026, 11, 23, 15, 0);
        assert_eq!(group_of(ms(at(2026, 11, 23, 0, 5)), now), Group::Today);
        // Late last night is not today, even though it is under 24 hours ago.
        assert_eq!(group_of(ms(at(2026, 11, 22, 23, 50)), now), Group::Week);
        assert_eq!(group_of(ms(at(2026, 11, 17, 9, 0)), now), Group::Week);
        assert_eq!(group_of(ms(at(2026, 11, 16, 23, 0)), now), Group::Earlier);
        assert_eq!(group_of(0., now), Group::Earlier, "no time on record");
        assert_eq!(group_of(f64::NAN, now), Group::Earlier);
        // A clock that moved back never puts a document in the future.
        assert_eq!(group_of(ms(at(2026, 11, 24, 9, 0)), now), Group::Today);
    }

    #[test]
    fn groups_keep_their_order_and_leave_out_empty_ones() {
        let now = at(2026, 11, 23, 15, 0);
        let times = [ms(at(2026, 11, 23, 14, 0)), ms(at(2026, 11, 23, 9, 0)), ms(at(2026, 10, 1, 9, 0)), 0.];
        assert_eq!(grouped(&times, now), [(Group::Today, vec![0, 1]), (Group::Earlier, vec![2, 3])]);
        assert!(grouped(&[], now).is_empty());
        assert_eq!(Group::Week.label(), "This week");
    }

    #[test]
    fn only_a_list_in_time_order_is_grouped() {
        assert!(groups_by_time(LibraryTab::Recent, SortOrder::Default));
        assert!(groups_by_time(LibraryTab::Recent, SortOrder::Recent));
        assert!(groups_by_time(LibraryTab::Starred, SortOrder::Recent));
        assert!(!groups_by_time(LibraryTab::Starred, SortOrder::Default), "stars come in the order they were starred");
        assert!(!groups_by_time(LibraryTab::Recent, SortOrder::Name));
        assert!(!groups_by_time(LibraryTab::Recent, SortOrder::Type));
    }

    #[test]
    fn the_quiet_line_says_when_in_plain_words() {
        let now = at(2026, 11, 23, 15, 0);
        let line = |t| meta_line(ms(t), 0., false, now);
        assert_eq!(line(at(2026, 11, 23, 14, 59)), "Opened 1 minute ago");
        assert_eq!(line(at(2026, 11, 23, 14, 30)), "Opened 30 minutes ago");
        assert_eq!(line(at(2026, 11, 23, 13, 0)), "Opened 2 hours ago");
        assert_eq!(line(at(2026, 11, 23, 13, 30)), "Opened 1 hour ago");
        assert_eq!(line(at(2026, 11, 22, 22, 0)), "Opened yesterday");
        assert_eq!(line(at(2026, 11, 19, 9, 0)), "Opened Thursday");
        assert_eq!(line(at(2026, 11, 3, 9, 0)), "Opened Nov 3");
        assert_eq!(line(at(2025, 11, 3, 9, 0)), "Opened Nov 3, 2025");
        assert_eq!(meta_line(ms(now), 0., false, now), "Opened just now");
        // Never opened here (a starred file): when it last changed.
        assert_eq!(meta_line(0., ms(at(2026, 11, 22, 9, 0)), false, now), "Edited yesterday");
        assert_eq!(meta_line(0., 0., false, now), "");
        assert_eq!(meta_line(ms(now), ms(now), true, now), "Missing on disk");
    }

    #[test]
    fn star_stars_the_rest_or_unstars_all_and_the_bar_counts() {
        use std::path::PathBuf;
        let (a, b) = (PathBuf::from("/n/a.md"), PathBuf::from("/n/b.md"));
        let some: std::collections::HashSet<PathBuf> = [a.clone()].into();
        assert_eq!(star_flips(&[a.clone(), b.clone()], &some), vec![b.clone()], "the unstarred one gets a star");
        let all: std::collections::HashSet<PathBuf> = [a.clone(), b.clone()].into();
        assert_eq!(star_flips(&[a.clone(), b.clone()], &all), vec![a, b], "all starred: all lose it");
        assert!(star_flips(&[], &all).is_empty());
        assert_eq!(selected_label(1), "1 document selected");
        assert_eq!(selected_label(4), "4 documents selected");
    }

    #[test]
    fn the_count_and_the_empty_page_say_what_is_there() {
        assert_eq!(count_line(12, 12), "12 documents");
        assert_eq!(count_line(1, 1), "1 document");
        assert_eq!(count_line(3, 12), "3 of 12 documents");
        assert_eq!(count_line(0, 0), "0 documents");
        assert_eq!(empty_copy(LibraryTab::Recent, 0, false), ("No documents yet", "Documents you open or create show up here.", false));
        assert_eq!(empty_copy(LibraryTab::Starred, 0, false).0, "Nothing starred yet");
        let (title, _, clear) = empty_copy(LibraryTab::Recent, 12, true);
        assert_eq!((title, clear), ("No documents match", true));
    }

    #[test]
    fn a_file_only_on_this_device_has_no_sync_icon() {
        assert!(sync_mark(SyncStatus::LocalOnly).is_none());
        assert_eq!(sync_mark(SyncStatus::Synced).unwrap().label.as_ref(), "Synced");
        assert_eq!(sync_mark(SyncStatus::Conflict).unwrap().label.as_ref(), "Conflict: review changes");
        assert_eq!(sync_mark(SyncStatus::Shared).unwrap().icon, "markie/sync-shared.svg");
    }

    /// The page draws `shell.recent`, the Library panel's own list: what it
    /// filters, sorts and marks missing is what the panel shows.
    #[test]
    fn the_page_filters_sorts_and_keeps_missing_files_through_the_shared_list() {
        use crate::library::Library;
        let dir = tempfile::tempdir().unwrap();
        let file = |name: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, "x").unwrap();
            path
        };
        let (plan, notes, table) = (file("Plan.md"), file("notes.md"), file("Table.csv"));
        let gone = dir.path().join("Gone.md");
        let mut lib = Library::default();
        lib.set_tab(LibraryTab::Recent);
        lib.set_opened_at([(plan.clone(), "2026-11-23T10:00:00Z".to_string()), (notes.clone(), "2026-11-20T10:00:00Z".to_string())]);
        lib.set_lists(vec![plan.clone(), gone.clone(), notes.clone(), table.clone()], vec![notes.clone()]);
        let names = |lib: &Library| lib.hits().iter().map(|h| lib.doc(h).name.clone()).collect::<Vec<_>>();
        // Newest first as the registry gave them, the missing file still listed.
        assert_eq!(names(&lib), ["Plan.md", "Gone.md", "notes.md", "Table.csv"]);
        assert!(lib.is_missing(&gone) && !lib.is_missing(&plan));
        assert!(lib.opened_ms(&plan) > lib.opened_ms(&notes));
        assert_eq!(lib.opened_ms(&table), 0., "never opened here");
        lib.set_sort(SortOrder::Name);
        assert_eq!(names(&lib), ["Gone.md", "notes.md", "Plan.md", "Table.csv"]);
        lib.set_only_format(Some(markie_core::formats::FormatKind::Markdown));
        assert_eq!(names(&lib), ["Gone.md", "notes.md", "Plan.md"]);
        lib.set_text("no");
        assert_eq!(names(&lib), ["notes.md"]);
        assert_eq!(count_line(lib.hits().len(), lib.total()), "1 of 4 documents");
        // Starred is the page's filter on the same list.
        lib.clear_query();
        lib.set_tab(LibraryTab::Starred);
        assert_eq!(names(&lib), ["notes.md"]);
        lib.set_tab(LibraryTab::Recent);
        assert_eq!(lib.total(), 4);
    }

    #[test]
    fn the_page_is_as_wide_as_the_window_allows() {
        assert_eq!(page_width(1200.), 1200. - 52. - 40.);
        // Past the column's width the page stops growing and centres it.
        assert_eq!(page_width(1280.), PAGE_MAX - 40.);
        assert_eq!(page_width(2400.), PAGE_MAX - 40.);
        assert_eq!(page_gutter(1200.), 0.);
        assert_eq!(page_gutter(2400.), ((2400. - 52. - PAGE_MAX) / 2_f32).floor());
        assert_eq!(page_width(100.), 188.);
    }

    #[test]
    fn user_visible_copy_has_no_em_dashes() {
        let src = include_str!("recent_page.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        let prose: String = code.lines().filter(|l| !l.trim_start().starts_with("//")).collect();
        assert!(!prose.contains('\u{2014}'));
    }
}
