//! The left edge: the 52px activity bar of `src/components/activity-bar.tsx`
//! and the side panels it opens (`library.tsx`, `browse-view.tsx`), the
//! Cloud and Vault pages, and the ⇧⌘F search of `global-search.tsx`.
//!
//! What Markie RS has is wired; what it does not have yet shows the same
//! empty state the Electron app shows a signed-out or first-run user.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_core::formats::FormatKind;
use markie_core::index::IndexedDoc;

use super::Workspace;
use super::chrome::{ChromeMenu, ColorMode, CopyState, hover_fill, icon, menu_panel, segment_on, segmented};
use crate::actions::*;
use crate::icons;
use crate::library::{Library, LibraryTab, SortOrder};
use crate::themes::{self, Palette, mix};

mod browse;
mod browse_page;

pub(super) const RAIL_WIDTH: f32 = 52.;
const PANEL_DEFAULT_WIDTH: f32 = 252.;
/// `src/lib/panel-width.ts`.
const PANEL_MIN_WIDTH: f32 = 200.;
const PANEL_MAX_WIDTH: f32 = 520.;
const PANEL_MAX_FRACTION: f32 = 0.45;
const PANEL_WIDTH_KEY: &str = "left_panel_width_v1";

/// The widest the panel may be in a window this wide, never below the minimum.
fn max_panel_width(viewport: f32) -> f32 {
    PANEL_MIN_WIDTH.max(PANEL_MAX_WIDTH.min((viewport * PANEL_MAX_FRACTION).round()))
}

/// `clampPanelWidth`: a bad width is the default, then the bounds.
fn clamp_panel_width(width: f32, viewport: f32) -> f32 {
    let wanted = if width.is_finite() && width > 0. { width } else { PANEL_DEFAULT_WIDTH };
    PANEL_MIN_WIDTH.max(max_panel_width(viewport).min(wanted.round()))
}
/// Electron's `markie.browse.open.v1`, kept in Markie RS's own registry.
const BROWSE_OPEN_KEY: &str = "browse_open_v1";

/// What the left edge shows (`src/lib/left-rail.ts`, plus the Vault page).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LeftView {
    /// The Recent page: every recent document as a grid, in the document area.
    Recent,
    Library,
    Browse,
    Cloud,
    Skills,
    Vault,
    /// Live Docs (super-nightly): Darkmown projects, a page of its own.
    LiveDocs,
    /// The pencil: the formatting rail, which owns no panel.
    Edit,
}

impl LeftView {
    fn title(self) -> &'static str {
        match self {
            LeftView::Recent => "RECENT",
            LeftView::Library => "LIBRARY",
            LeftView::Browse => "BROWSE",
            LeftView::Cloud => "CLOUD",
            LeftView::Skills => "SKILLS",
            LeftView::Vault => "VAULT",
            LeftView::LiveDocs => "LIVE DOCS",
            LeftView::Edit => "",
        }
    }

    fn has_panel(self) -> bool {
        matches!(self, LeftView::Library | LeftView::Skills)
    }

    /// Recent, Browse, Cloud and the Vault take the document area over instead of a panel.
    fn takes_workspace(self) -> bool {
        matches!(self, LeftView::Recent | LeftView::Browse | LeftView::Cloud | LeftView::Vault | LeftView::LiveDocs)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum LibTab {
    Recent,
    Projects,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum FilterMenu {
    RecentType,
    RecentSort,
    BrowseType,
}

/// Everything the chrome keeps between frames.
pub(super) struct Shell {
    pub color_mode: ColorMode,
    pub template: String,
    pub menu: Option<ChromeMenu>,
    pub menu_closed: Option<(ChromeMenu, Instant)>,
    pub copied: CopyState,
    pub _copy_task: Task<()>,
    pub view: LeftView,
    pub panel_open: bool,
    previous_panel: LeftView,
    rail_hover: Option<&'static str>,
    pub panel_width: f32,
    /// A resizer drag: where it started and the width then.
    pub panel_drag: Option<(f32, f32)>,
    resizer_hover: bool,
    lib_tab: LibTab,
    /// The Recent page's grid, and the Cloud page's (`doc_grid.rs`).
    pub recent_grid: super::doc_grid::DocGridState,
    pub cloud_grid: super::doc_grid::DocGridState,
    /// Card thumbnails, built off the main thread (`doc_preview.rs`).
    pub previews: super::doc_preview::PreviewCache,
    /// Recent and Starred have been read once: an empty list is really empty.
    pub lists_loaded: bool,
    /// The saved cloud thumbnails have been read from disk for this session.
    pub cloud_previews_loaded: bool,
    /// Whose cloud thumbnails are held (`doc_preview::cloud_session`): not
    /// asked yet, nobody (signed out), or the signed-in accounts.
    pub cloud_preview_session: Option<Option<String>>,
    /// Bumped when that changes, so a fetch begun for the last account lands nowhere.
    pub cloud_preview_epoch: u64,
    /// A page opened or closed: the next frame moves the keyboard to it.
    pub page_focus_owed: bool,
    /// library.tsx `uploadArea`: where Sync to cloud from a row puts a new
    /// cloud document. None is the default cloud.
    pub upload_area: Option<String>,
    pub upload_area_open: bool,
    pub filter_menu: Option<FilterMenu>,
    filter_closed: Option<(FilterMenu, Instant)>,
    pub recent: Library,
    pub recent_filter: Entity<InputState>,
    /// Browse: the page of documents on this Mac.
    pub browse: browse::BrowseState,
    /// Starred files and folders (Browse's ☆).
    pub stars: HashSet<PathBuf>,
    /// The Library row whose ⋯ menu is open, and where.
    pub row_menu: Option<(PathBuf, Point<Pixels>)>,
    /// A Cloud page row with no file here whose ⋯ menu is open, and where.
    pub cloud_row_menu: Option<(super::library_rows::CloudRow, Point<Pixels>)>,
    /// The focused item of the open row menu (`FileMenu` focuses the first).
    pub row_menu_focus: usize,
    /// The Recent page's bulk actions, newest last, for ⌘Z (`recent_page.rs`).
    pub bulk_undo: Vec<super::recent_page::BulkUndo>,
    /// Move to Folder… is open from the Recent page: the history depth before it.
    pub bulk_pending: Option<usize>,
    pub search_open: bool,
    pub search: Library,
    search_input: Entity<InputState>,
    search_selected: usize,
}

impl Shell {
    pub(super) fn new(
        color_mode: ColorMode,
        template: String,
        window: &mut Window,
        cx: &mut Context<Workspace>,
    ) -> (Self, Vec<Subscription>) {
        let recent_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter by name or folder"));
        let browse_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Find a document by name, folder or text"));
        let search_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search every document by name or what it says…"));
        let subs = vec![
            cx.subscribe(&recent_filter, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.shell.recent.set_text(&text);
                    cx.notify();
                }
            }),
            cx.subscribe(&browse_filter, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.browse_text_changed(&text, cx);
                }
            }),
            cx.subscribe(&search_input, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.set_search_text(&text);
                    this.schedule_body_search(cx);
                    cx.notify();
                }
            }),
        ];
        let mut recent = Library::default();
        recent.set_tab(LibraryTab::Recent);
        let mut search = Library::default();
        search.set_sort(SortOrder::Recent);
        let shell = Self {
            color_mode,
            template,
            menu: None,
            menu_closed: None,
            copied: CopyState::Idle,
            _copy_task: Task::ready(()),
            view: LeftView::Library,
            panel_open: false,
            previous_panel: LeftView::Library,
            rail_hover: None,
            panel_width: PANEL_DEFAULT_WIDTH,
            panel_drag: None,
            resizer_hover: false,
            lib_tab: LibTab::Recent,
            recent_grid: super::doc_grid::DocGridState::new(Default::default(), cx),
            cloud_grid: super::doc_grid::DocGridState::new(Default::default(), cx),
            previews: Default::default(),
            lists_loaded: false,
            cloud_previews_loaded: false,
            cloud_preview_session: None,
            cloud_preview_epoch: 0,
            page_focus_owed: false,
            upload_area: None,
            upload_area_open: false,
            filter_menu: None,
            filter_closed: None,
            recent,
            recent_filter,
            browse: browse::BrowseState::new(browse_filter),
            stars: HashSet::new(),
            row_menu: None,
            cloud_row_menu: None,
            row_menu_focus: 0,
            bulk_undo: Vec::new(),
            bulk_pending: None,
            search_open: false,
            search,
            search_input,
            search_selected: 0,
        };
        (shell, subs)
    }

    /// The index changed: Browse groups again on the next frame.
    pub(super) fn invalidate_browse(&mut self) {
        self.browse.view = None;
    }

    /// The formatting rail is the chosen view (the editor reads this).
    pub(super) fn format_rail_on(&self) -> bool {
        self.view == LeftView::Edit
    }
}

// ---------------------------------------------------------------- behaviour

impl Workspace {
    /// A rail click (`selectLeftView` in left-rail.ts): the current panel
    /// again closes it; the pencil twice returns to the last panel.
    pub(super) fn select_view(&mut self, clicked: LeftView, cx: &mut Context<Self>) {
        // A page may replace the document: the document keeps its scroll for Back.
        self.nav_capture(cx);
        let s = &mut self.shell;
        if clicked == LeftView::Edit {
            if s.view == LeftView::Edit {
                s.view = s.previous_panel;
                s.panel_open = true;
            } else {
                s.previous_panel = s.view;
                s.view = LeftView::Edit;
                s.panel_open = false;
            }
        } else {
            let closing = s.panel_open && s.view == clicked;
            s.view = clicked;
            s.panel_open = !closing;
        }
        s.filter_menu = None;
        // Starred is the Recent page's filter: the Library panel lists Recent.
        if !(s.view == LeftView::Recent && s.panel_open) && s.recent.tab != LibraryTab::Recent {
            s.recent.set_tab(LibraryTab::Recent);
        }
        s.page_focus_owed = true;
        if self.shell.view == LeftView::Cloud && self.shell.panel_open {
            self.refresh_cloud(false, cx);
        }
        if self.shell.view == LeftView::LiveDocs && self.shell.panel_open {
            self.live_docs_shown(cx);
        }
        if self.shell.view == LeftView::Browse && self.shell.panel_open && self.library.total() == 0 && !self.library.scanning {
            self.rescan(cx);
        }
        cx.notify();
    }

    pub(super) fn on_toggle_library(&mut self, _: &ToggleLibrary, _: &mut Window, cx: &mut Context<Self>) {
        if self.shell.view.has_panel() && self.shell.panel_open && self.shell.view != LeftView::Library {
            self.shell.view = LeftView::Library;
            cx.notify();
            return;
        }
        self.select_view(LeftView::Library, cx);
    }

    /// The workspace page (Cloud, Vault) is up instead of the document.
    pub(super) fn workspace_page_open(&self) -> bool {
        self.shell.panel_open && self.shell.view.takes_workspace()
    }

    pub(super) fn open_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Filled on open, not at launch: a pass over the whole index.
        self.shell.search.share_docs_from(&self.library);
        self.shell.search_open = true;
        self.shell.search_selected = 0;
        let handle = self.shell.search_input.read(cx).focus_handle(cx);
        handle.focus(window, cx);
        cx.notify();
    }

    fn close_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.search_open = false;
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    fn set_search_text(&mut self, text: &str) {
        let s = &mut self.shell.search;
        // Empty: the most recently changed. Typed: best match first.
        s.set_sort(if text.trim().is_empty() { SortOrder::Recent } else { SortOrder::Default });
        s.set_text(text);
        self.shell.search_selected = 0;
    }

    fn toggle_search_type(&mut self, kinds: &'static [FormatKind], cx: &mut Context<Self>) {
        for kind in kinds {
            self.shell.search.toggle_format(*kind);
        }
        self.shell.search_selected = 0;
        self.schedule_body_search(cx);
        cx.notify();
    }

    fn open_search_hit(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(hit) = self.shell.search.hits().get(index).cloned() else { return };
        let path = self.shell.search.doc(&hit).path.clone();
        self.close_search(window, cx);
        self.open_path(&path, window, cx);
    }

    fn search_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let shown = self.shell.search.hits().len().min(SEARCH_LIMIT);
        match event.keystroke.key.as_str() {
            "escape" => self.close_search(window, cx),
            "down" => self.shell.search_selected = (self.shell.search_selected + 1).min(shown.saturating_sub(1)),
            "up" => self.shell.search_selected = self.shell.search_selected.saturating_sub(1),
            "enter" => {
                let i = self.shell.search_selected;
                self.open_search_hit(i, window, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    pub(super) fn toggle_filter_menu(&mut self, menu: FilterMenu, cx: &mut Context<Self>) {
        if let Some((closed, at)) = self.shell.filter_closed.take() {
            if closed == menu && at.elapsed().as_millis() < 250 {
                return;
            }
        }
        self.shell.filter_menu = if self.shell.filter_menu == Some(menu) { None } else { Some(menu) };
        cx.notify();
    }

    pub(super) fn close_filter_menu(&mut self, cx: &mut Context<Self>) {
        if let Some(menu) = self.shell.filter_menu.take() {
            self.shell.filter_closed = Some((menu, Instant::now()));
            cx.notify();
        }
    }

    pub(super) fn clear_recent_filters(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.recent.clear_query();
        self.shell.recent_filter.update(cx, |s, cx| s.set_value("", window, cx));
        cx.notify();
    }

    /// The width saved by an earlier session.
    pub(super) fn restore_panel_width(&mut self, window: &Window) {
        let raw = self.registry.as_ref().and_then(|r| r.setting(PANEL_WIDTH_KEY).ok().flatten());
        let wanted = raw.and_then(|v| v.trim().parse::<f32>().ok()).unwrap_or(PANEL_DEFAULT_WIDTH);
        self.shell.panel_width = clamp_panel_width(wanted, f32::from(window.viewport_size().width));
    }

    fn commit_panel_width(&mut self, width: f32, cx: &mut Context<Self>) {
        self.shell.panel_width = width;
        if let Some(reg) = &self.registry {
            let _ = reg.set_setting(PANEL_WIDTH_KEY, &width.to_string());
        }
        cx.notify();
    }

    /// The pointer moved anywhere in the window during a resizer drag.
    pub(super) fn panel_drag_move(&mut self, x: f32, window: &Window, cx: &mut Context<Self>) {
        let Some((start_x, start_width)) = self.shell.panel_drag else { return };
        let width = clamp_panel_width(start_width + (x - start_x), f32::from(window.viewport_size().width));
        if (width - self.shell.panel_width).abs() >= 1. {
            self.shell.panel_width = width;
            cx.notify();
        }
    }

    pub(super) fn panel_drag_end(&mut self, cx: &mut Context<Self>) {
        if self.shell.panel_drag.take().is_some() {
            let width = self.shell.panel_width;
            self.commit_panel_width(width, cx);
        }
    }

    /// Escape during a drag puts the panel back where it started.
    pub(super) fn panel_drag_cancel(&mut self, cx: &mut Context<Self>) -> bool {
        let Some((_, start)) = self.shell.panel_drag.take() else { return false };
        self.shell.panel_width = start;
        cx.notify();
        true
    }

    /// The 7 px grab strip over the panel's right border.
    fn render_resizer(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let line = if self.shell.resizer_hover || self.shell.panel_drag.is_some() { p.blue.opacity(0.7) } else { gpui_kit::transparent_black() };
        div()
            .id("panel-resizer")
            .absolute()
            .top_0()
            .bottom_0()
            .right(px(-3.))
            .w(px(7.))
            .cursor_col_resize()
            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Drag to resize · double-click to reset").build(window, cx))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.shell.resizer_hover = *hovered;
                cx.notify();
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                if ev.click_count >= 2 {
                    this.shell.panel_drag = None;
                    let width = clamp_panel_width(PANEL_DEFAULT_WIDTH, f32::from(window.viewport_size().width));
                    this.commit_panel_width(width, cx);
                    return;
                }
                this.shell.panel_drag = Some((f32::from(ev.position.x), this.shell.panel_width));
                cx.notify();
            }))
            .child(div().absolute().top_0().bottom_0().left(px(3.)).w(px(1.)).bg(line))
    }

    /// Browse's ☆ on a file or folder row.
    fn toggle_browse_star(&mut self, path: PathBuf, kind: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(reg) = &self.registry else { return };
        if reg.toggle_star(&path, kind).is_err() {
            window.push_notification("Couldn't save that star.", cx);
            return;
        }
        self.refresh_lists(cx);
        cx.notify();
    }

    fn show_shortcuts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let p = themes::palette(cx);
        window.open_dialog(cx, move |dialog, _, _| {
            let group = |name: &'static str, rows: &[(&'static str, &'static str)]| {
                v_flex()
                    .child(
                        div()
                            .mb(px(6.))
                            .text_size(px(10.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.muted)
                            .child(name),
                    )
                    .children(rows.iter().map(|(title, keys)| {
                        h_flex()
                            .justify_between()
                            .py(px(2.))
                            .text_size(px(12.))
                            .child(div().text_color(p.fg(0.8)).child(*title))
                            .child(div().text_color(p.muted).child(*keys))
                    }))
            };
            dialog.title("Keyboard Shortcuts").w(px(560.)).child(
                h_flex()
                    .items_start()
                    .gap(px(32.))
                    .child(
                        v_flex()
                            .flex_1()
                            .gap(px(16.))
                            .child(group(
                                "FILE",
                                &[
                                    ("New document", "⌘N"),
                                    ("Open…", "⌘O"),
                                    ("Add folder", "⇧⌘O"),
                                    ("Save", "⌘S"),
                                    ("Duplicate (Fork)", "⇧⌘D"),
                                    ("Reveal in Finder", "⌥⌘R"),
                                    ("Version history", "⌥⌘Y"),
                                ],
                            ))
                            .child(group("APP", &[("Commands", "⌘K"), ("Settings", "⌘,"), ("Quit", "⌘Q")])),
                    )
                    .child(
                        v_flex().flex_1().gap(px(16.)).child(group(
                            "VIEW",
                            &[
                                ("Library", "⌘L"),
                                ("Search all documents", "⇧⌘F"),
                                ("Toggle View and Source", "⌘E"),
                                ("Outline", "⌥⌘O"),
                                ("Statistics", "⇧⌘I"),
                                ("Toggle dark mode", "⇧⌘L"),
                                ("Zoom in", "⌘="),
                                ("Zoom out", "⌘-"),
                                ("Actual size", "⌘0"),
                                ("Rescan documents", "⌘R"),
                            ],
                        )),
                    ),
            )
        });
    }

    // ------------------------------------------------------------ render

    pub(super) fn render_rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = themes::palette(cx);
        let s = &self.shell;
        let active = |v: LeftView| if v == LeftView::Edit { s.view == v } else { s.panel_open && s.view == v };
        let can_format = self.rich_active();
        let rule = || div().w(px(24.)).h(px(1.)).my(px(4.)).bg(p.border);

        let bg = if p.dark {
            Background::from(linear_gradient(
                180.,
                linear_color_stop(mix(p.surface2, p.surface, 0.58), 0.),
                linear_color_stop(p.surface, 0.35),
            ))
        } else {
            p.surface.into()
        };

        v_flex()
            .id("activity-bar")
            .w(px(RAIL_WIDTH))
            .flex_none()
            .h_full()
            .items_center()
            .py(px(8.))
            .gap(px(4.))
            .bg(bg)
            .border_r_1()
            .border_color(p.border)
            .child(self.rail_button("rail-new", "markie/new-file.svg", "New file (⌘N)", false, false, &p, cx, |_, w, cx| {
                w.dispatch_action(Box::new(NewDocument), cx)
            }))
            .child(self.rail_button(
                "rail-search",
                "markie/search.svg",
                "Search all documents (⇧⌘F)",
                false,
                false,
                &p,
                cx,
                |this, w, cx| this.open_search(w, cx),
            ))
            .child(rule())
            .child(self.rail_button(
                "rail-recent",
                "markie/recent.svg",
                "Recent documents",
                active(LeftView::Recent),
                false,
                &p,
                cx,
                |this, _, cx| this.select_view(LeftView::Recent, cx),
            ))
            .child(self.rail_button(
                "rail-library",
                "markie/library.svg",
                "Library: recent and projects (⌘L)",
                active(LeftView::Library),
                false,
                &p,
                cx,
                |this, _, cx| this.select_view(LeftView::Library, cx),
            ))
            .child(self.rail_button(
                "rail-browse",
                "markie/browse.svg",
                "Browse all documents",
                active(LeftView::Browse),
                false,
                &p,
                cx,
                |this, window, cx| {
                    this.select_view(LeftView::Browse, cx);
                    this.browse_focus_filter(window, cx);
                },
            ))
            .child(self.rail_button(
                "rail-cloud",
                "markie/cloud.svg",
                "Cloud: synced and shared",
                active(LeftView::Cloud),
                false,
                &p,
                cx,
                |this, _, cx| this.select_view(LeftView::Cloud, cx),
            ))
            .child(self.rail_button(
                "rail-skills",
                "markie/skills.svg",
                "Skills & agent files",
                active(LeftView::Skills),
                false,
                &p,
                cx,
                |this, window, cx| {
                    this.prepare_skills(window, cx);
                    this.select_view(LeftView::Skills, cx);
                },
            ))
            .child(self.rail_button(
                "rail-vault",
                "markie/vault.svg",
                "Vault: locked files and keys",
                active(LeftView::Vault),
                false,
                &p,
                cx,
                |this, _, cx| this.select_view(LeftView::Vault, cx),
            ))
            .when(super::live_docs::enabled(), |el| {
                el.child(self.rail_button(
                    "rail-live-docs",
                    "markie/live-docs.svg",
                    "Live Docs: Darkmown projects",
                    active(LeftView::LiveDocs),
                    false,
                    &p,
                    cx,
                    |this, _, cx| this.select_view(LeftView::LiveDocs, cx),
                ))
            })
            .child(rule())
            .child(self.rail_button(
                "rail-edit",
                "markie/pencil.svg",
                "Formatting tools",
                active(LeftView::Edit),
                !can_format,
                &p,
                cx,
                |this, _, cx| this.select_view(LeftView::Edit, cx),
            ))
            .child(div().flex_1())
            .child(self.rail_button(
                "rail-agents",
                "markie/agent.svg",
                "Connect an agent (MCP)",
                false,
                false,
                &p,
                cx,
                |this, w, cx| this.open_agents(w, cx),
            ))
            .child(self.rail_button(
                "rail-keys",
                "markie/keyboard.svg",
                "Keyboard shortcuts (⌘/)",
                false,
                false,
                &p,
                cx,
                |this, w, cx| this.show_shortcuts(w, cx),
            ))
            .child(
                div()
                    .id("rail-account")
                    .mt(px(2.))
                    .size(px(32.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .cursor_pointer()
                    .hover(|s| s.opacity(0.9))
                    // Signed in: initials on the account colour with a green dot,
                    // as activity-bar.tsx draws it (account.rs owns the session).
                    .child(match super::account::signed_in_user(cx) {
                        Some(user) => {
                            let (color, letters) = super::account::avatar_for(&user);
                            div()
                                .relative()
                                .size(px(28.))
                                .rounded_full()
                                .bg(color)
                                .flex()
                                .items_center()
                                .justify_center()
                                .text_size(px(10.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(black().opacity(0.8))
                                .child(letters)
                                .child(
                                    div()
                                        .absolute()
                                        .bottom(px(-2.))
                                        .right(px(-2.))
                                        .size(px(10.))
                                        .rounded_full()
                                        .bg(rgb(0x34d399))
                                        .border_2()
                                        .border_color(p.surface),
                                )
                        }
                        None => div()
                            .size(px(28.))
                            .rounded_full()
                            .border_1()
                            .border_color(p.border)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("markie/user.svg", 16., p.muted)),
                    })
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| this.set_rail_hover("rail-account", *hovered, cx)))
                    .when(self.shell.rail_hover == Some("rail-account"), |el| {
                        let tip: SharedString = match super::account::signed_in_user(cx) {
                            Some(u) => format!("{} (Account)", u.name.filter(|n| !n.is_empty()).unwrap_or(u.email)).into(),
                            None => "Sign in".into(),
                        };
                        el.child(rail_tip(tip, &p))
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.open_account(window, cx))),
            )
    }

    fn set_rail_hover(&mut self, id: &'static str, hovered: bool, cx: &mut Context<Self>) {
        if hovered {
            self.shell.rail_hover = Some(id);
        } else if self.shell.rail_hover == Some(id) {
            self.shell.rail_hover = None;
        }
        cx.notify();
    }

    #[allow(clippy::too_many_arguments)]
    fn rail_button(
        &self,
        id: &'static str,
        glyph: &'static str,
        label: &'static str,
        active: bool,
        disabled: bool,
        p: &Palette,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        let p = *p;
        let active_bg = if p.dark { p.accent } else { p.fg(0.10) };
        let hover_bg = if p.dark { p.accent.opacity(0.4) } else { p.fg(0.06) };
        let color = if active { p.foreground } else { p.muted };
        div()
            .id(id)
            .group(id)
            .relative()
            .flex_none()
            .size(px(36.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(9.))
            .border_1()
            .border_color(if active && p.dark { p.fg(0.09) } else { transparent_black() })
            .when(active, |el| el.bg(active_bg))
            .when(disabled, |el| el.opacity(0.35))
            .when(!disabled && !active, |el| el.hover(|s| s.bg(hover_bg)))
            .when(active, |el| {
                el.child(
                    div()
                        .absolute()
                        .left(px(-8.))
                        .top(px(7.))
                        .bottom(px(7.))
                        .w(px(3.))
                        .rounded_full()
                        .bg(p.blue)
                        .shadow(vec![BoxShadow {
                            color: p.blue.opacity(0.55),
                            offset: point(px(0.), px(0.)),
                            blur_radius: px(8.),
                            spread_radius: px(0.),
                            inset: false,
                        }]),
                )
            })
            .child(
                icon(glyph, 18., color)
                    .when(!disabled, |s| s.group_hover(id, |s| s.text_color(p.foreground))),
            )
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| this.set_rail_hover(id, *hovered, cx)))
            .when(self.shell.rail_hover == Some(id), |el| el.child(rail_tip(label, &p)))
            .when(!disabled, |el| el.on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx))))
    }

    /// The Library panel on its Projects tab: for scenes, and after
    /// "Bring your documents" made its folders.
    pub(super) fn show_projects_tab(&mut self, cx: &mut Context<Self>) {
        if !(self.shell.panel_open && self.shell.view == LeftView::Library) {
            self.select_view(LeftView::Library, cx);
        }
        self.shell.lib_tab = LibTab::Projects;
        self.compute_projects(cx);
        cx.notify();
    }

    /// The docked panel, when one is open.
    pub(super) fn render_side_panel(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let s = &self.shell;
        if !(s.panel_open && s.view.has_panel()) {
            return None;
        }
        let p = themes::palette(cx);
        let view = s.view;
        let header = h_flex()
            .h(px(40.))
            .flex_none()
            .px(px(12.))
            .justify_between()
            .border_b_1()
            .border_color(p.border)
            .child(
                div()
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.muted)
                    .child(view.title()),
            )
            .child(
                h_flex()
                    .gap(px(4.))
                    .child(small_icon_button("panel-open", "markie/plus.svg", &p).on_click(
                        cx.listener(|_, _, window, cx| window.dispatch_action(Box::new(Open), cx)),
                    ))
                    .child(small_icon_button("panel-collapse", "markie/collapse.svg", &p).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.shell.panel_open = false;
                            cx.notify();
                        },
                    ))),
            );
        let body = match view {
            // library.tsx `onDrop`: the panel takes the files it can open.
            LeftView::Library => div()
                .id("library-drop")
                .size_full()
                .flex()
                .flex_col()
                .min_h_0()
                .child(self.render_library_view(&p, cx))
                .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                    cx.stop_propagation();
                    this.drop_on_library(paths.paths().to_vec(), window, cx);
                }))
                .into_any_element(),
            _ => self.render_skills_panel(),
        };
        let bg = if p.dark {
            Background::from(linear_gradient(
                180.,
                linear_color_stop(mix(p.surface2, p.surface, 0.58), 0.),
                linear_color_stop(p.surface, 0.3),
            ))
        } else {
            p.surface.into()
        };
        Some(
            v_flex()
                .id("side-panel")
                .w(px(s.panel_width))
                .flex_none()
                .h_full()
                .bg(bg)
                .border_r_1()
                .border_color(p.border)
                .relative()
                .child(header)
                .child(body)
                .child(self.render_resizer(&p, cx))
                .when(super::account::signed_in_user(cx).is_none(), |el| {
                    el.child(
                        div()
                            .id("panel-sign-in")
                            .m(px(8.))
                            .px(px(8.))
                            .py(px(6.))
                            .rounded(px(6.))
                            .border_1()
                            .border_color(p.border)
                            .text_size(px(11.))
                            .line_height(px(15.))
                            .text_color(p.muted)
                            .cursor_pointer()
                            .hover(|s| s.text_color(p.foreground))
                            .child(StyledText::new("Sign in to sync these files across your devices and share them.").with_highlights([(
                                0..7,
                                HighlightStyle { color: Some(p.fg(0.9)), ..Default::default() },
                            )]))
                            .on_click(cx.listener(|this, _, window, cx| this.open_account(window, cx))),
                    )
                })
                .into_any_element(),
        )
    }

    fn render_library_view(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let s = &self.shell;
        let p = *p;
        let tabs = div().flex_none().px(px(8.)).py(px(8.)).border_b_1().border_color(p.border.opacity(0.6)).child(
            segmented(&p).w_full().children([(LibTab::Recent, "Recent"), (LibTab::Projects, "Projects")].map(|(tab, label)| {
                let on = s.lib_tab == tab;
                div()
                    .id(SharedString::from(format!("libtab-{label}")))
                    .flex_1()
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(7.))
                    .text_size(px(11.5))
                    .text_color(if on { p.foreground } else { p.muted })
                    .when(on, |el| el.bg(segment_on(&p)))
                    .hover(|s| s.text_color(p.foreground))
                    .child(label)
                    // A document dragged over the Projects tab opens it, so
                    // it can be dropped on a folder there.
                    .on_drag_move(cx.listener(move |this, ev: &DragMoveEvent<super::projects::DragItems>, _, cx| {
                        if tab == LibTab::Projects && this.shell.lib_tab != tab && ev.bounds.contains(&ev.event.position) {
                            this.shell.lib_tab = tab;
                            this.compute_projects(cx);
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.shell.lib_tab = tab;
                        if tab == LibTab::Projects {
                            this.compute_projects(cx);
                        }
                        cx.notify();
                    }))
            })),
        );
        let mut col = v_flex().flex_1().min_h_0().child(tabs);
        if s.lib_tab == LibTab::Projects {
            return col.child(self.render_projects(&p, cx));
        }
        let recent = &s.recent;
        let total = recent.total();
        let shown = recent.hits().len();
        col = col.child(
            div().flex_none().px(px(8.)).py(px(6.)).border_b_1().border_color(p.border.opacity(0.6)).child(
                div()
                    .id("lib-new-doc")
                    .w_full()
                    .px(px(8.))
                    .py(px(6.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(p.border.opacity(0.7))
                    .text_size(px(11.5))
                    .text_color(p.foreground)
                    .hover(|s| s.bg(hover_fill(&p)))
                    .child("New document…")
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(NewDocument), cx)),
            ),
        );
        if total > 0 {
            let type_label = recent.only_format().map_or("All types", |k| type_menu_label(Some(k)));
            col = col.child(
                v_flex()
                    .flex_none()
                    .px(px(8.))
                    .py(px(6.))
                    .gap(px(6.))
                    .child(filter_field(&self.shell.recent_filter, 11.5, &p))
                    .child(
                        h_flex()
                            .gap(px(6.))
                            .child(self.select_button(FilterMenu::RecentType, type_label, &p, cx))
                            .child(self.select_button(FilterMenu::RecentSort, recent.sort.label(), &p, cx)),
                    )
                    .when(recent.query_active(), |el| {
                        el.child(
                            div()
                                .id("lib-clear")
                                .h(px(32.))
                                .px(px(8.))
                                .flex()
                                .items_center()
                                .rounded(px(6.))
                                .text_size(px(11.))
                                .text_color(p.muted)
                                .hover(|s| s.bg(p.accent.opacity(0.4)).text_color(p.foreground))
                                .child("Clear filters")
                                .on_click(cx.listener(|this, _, window, cx| this.clear_recent_filters(window, cx))),
                        )
                    }),
            );
        }
        // library.tsx: signed in, the Recent tab offers "Upload destination".
        if super::account::signed_in_user(cx).is_some() {
            col = col.child(self.render_library_area_picker(&p, cx));
        }
        col = col.child(
            h_flex()
                .flex_none()
                .justify_between()
                .px(px(10.))
                .py(px(8.))
                .border_b_1()
                .border_color(p.border.opacity(0.6))
                .child(
                    div()
                        .text_size(px(10.))
                        .text_color(p.muted)
                        .child(format!("{total} ON THIS DEVICE")),
                )
                .child(div().text_size(px(10.5)).text_color(p.muted).child("All clear")),
        );
        if recent.query_active() {
            col = col.child(
                div()
                    .px(px(10.))
                    .py(px(4.))
                    .text_size(px(10.5))
                    .text_color(p.muted)
                    .child(format!("{shown} of {total} documents")),
            );
        }
        let current = self.doc.as_ref().map(|d| d.path.clone());
        let mut list = v_flex().id("lib-list").flex_1().min_h_0().overflow_y_scroll().px(px(6.)).py(px(8.));
        if total == 0 {
            list = list.child(
                div().px(px(8.)).py(px(12.)).child(
                    v_flex()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.border.opacity(0.7))
                        .bg(p.background.opacity(0.45))
                        .px(px(10.))
                        .py(px(10.))
                        .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).child("No recent files"))
                        .child(
                            h_flex()
                                .mt(px(8.))
                                .gap(px(6.))
                                .child(
                                    div()
                                        .id("empty-open")
                                        .rounded(px(6.))
                                        .bg(p.accent)
                                        .px(px(8.))
                                        .py(px(4.))
                                        .text_size(px(11.))
                                        .hover(|s| s.opacity(0.9))
                                        .child("Open file")
                                        .on_click(|_, w, cx| w.dispatch_action(Box::new(Open), cx)),
                                )
                                .child(
                                    div()
                                        .id("empty-projects")
                                        .rounded(px(6.))
                                        .border_1()
                                        .border_color(p.border)
                                        .px(px(8.))
                                        .py(px(4.))
                                        .text_size(px(11.))
                                        .text_color(p.muted)
                                        .hover(|s| s.bg(p.accent.opacity(0.4)).text_color(p.foreground))
                                        .child("Projects")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.shell.lib_tab = LibTab::Projects;
                                            this.compute_projects(cx);
                                            cx.notify();
                                        })),
                                ),
                        ),
                ),
            );
        } else if shown == 0 {
            list = list.child(div().px(px(8.)).py(px(8.)).text_size(px(12.)).text_color(p.muted).child("No documents match this filter."));
        } else {
            if recent.sort == SortOrder::Default {
                list = list.child(
                    h_flex()
                        .justify_between()
                        .px(px(8.))
                        .pt(px(12.))
                        .pb(px(4.))
                        .child(div().text_size(px(9.)).text_color(p.muted).child("ON THIS DEVICE"))
                        .child(
                            div()
                                .px(px(4.))
                                .rounded(px(4.))
                                .border_1()
                                .border_color(p.border.opacity(0.7))
                                .text_size(px(9.))
                                .text_color(p.muted)
                                .child(shown.to_string()),
                        ),
                );
            }
            for hit in recent.hits() {
                let doc = recent.doc(hit);
                let active = current.as_deref() == Some(doc.path.as_path());
                list = list.child(self.file_row(doc, active, &p, cx));
            }
        }
        col.child(list).when_some(self.shell.filter_menu, |el, menu| match menu {
            FilterMenu::RecentType | FilterMenu::RecentSort => el.child(self.render_filter_menu(menu, &p, cx)),
            _ => el,
        })
    }

    /// A Library row: format icon, name, type badge, sync state and ⋯.
    fn file_row(&self, doc: &IndexedDoc, active: bool, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let path = doc.path.clone();
        let hover = p.accent.opacity(0.4);
        let menu_open = self.shell.row_menu.as_ref().is_some_and(|(m, _)| *m == doc.path);
        let group = SharedString::from(format!("row-group-{}", doc.path.display()));
        let (menu_path, context_path) = (doc.path.clone(), doc.path.clone());
        let missing = self.shell.recent.is_missing(&doc.path);
        let muted = p.muted;
        let fg = p.foreground;
        div()
            .id(SharedString::from(format!("row-{}", doc.path.display())))
            .group(group.clone())
            .rounded(px(6.))
            .px(px(8.))
            .py(px(6.))
            .cursor_pointer()
            .when(active, |el| el.bg(p.accent))
            .when(!active && menu_open, |el| el.bg(hover))
            .when(!active && !menu_open, |el| el.hover(|s| s.bg(hover)))
            .child(
                h_flex()
                    .gap(px(6.))
                    .child(format_icon(doc.format, 15., p))
                    .child(div().flex_1().min_w_0().truncate().text_size(px(12.5)).text_color(p.foreground).child(doc.name.clone()))
                    .child(format_badge(doc.format, p))
                    .child(self.sync_status_icon(&doc.path, p))
                    .child(
                        div()
                            .id(SharedString::from(format!("row-more-{}", doc.path.display())))
                            .size(px(20.))
                            .flex_none()
                            .rounded(px(4.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_color(muted)
                            .when(menu_open, |d| d.bg(hover).text_color(fg))
                            .when(!menu_open, |d| d.opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)))
                            .hover(move |s| s.text_color(fg).bg(hover))
                            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Actions").build(window, cx))
                            .child("⋯")
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                                cx.stop_propagation();
                                let at = ev.position();
                                this.open_row_menu(menu_path.clone(), point(at.x - px(10.), at.y + px(14.)), cx);
                            })),
                    ),
            )
            // library.tsx: a row whose file is gone says so.
            .when(missing, |el| el.child(div().pl(px(21.)).text_size(px(10.)).text_color(p.red).child("Missing on disk")))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                this.shell.row_menu = None;
                this.open_row_menu(context_path.clone(), ev.position, cx);
            }))
            .when(!missing, |el| {
                let item = markie_core::projects::folders::Item::File(doc.path.to_string_lossy().into_owned());
                let drag = super::projects::DragItems::new(vec![item], &|_| doc.name.clone());
                let p = *p;
                el.on_drag(drag, move |d: &super::projects::DragItems, _, _, cx| {
                    cx.new(|_| super::projects::DragPreview { label: d.label.clone(), count: d.items.len(), palette: p })
                })
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.shell.row_menu = None;
                // Electron opens a row only while its file exists.
                if !missing {
                    this.open_path(&path, window, cx)
                }
            }))
    }

    /// `.markie-select-button` with its chevron.
    fn select_button(&self, menu: FilterMenu, label: &str, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.shell.filter_menu == Some(menu);
        let bg = if p.dark { mix(p.background, p.surface2, 0.72) } else { p.background };
        div()
            .id(SharedString::from(format!("select-{menu:?}")))
            .flex_1()
            .min_w_0()
            .h(px(32.))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(7.))
            .pl(px(10.4))
            .pr(px(8.8))
            .rounded(px(7.))
            .border_1()
            .border_color(if p.dark { p.border } else { mix(p.foreground, p.border, 0.14) })
            .bg(bg)
            .text_size(px(11.5))
            .text_color(if open { p.foreground } else { p.muted })
            .child(div().truncate().child(label.to_string()))
            .child(icon("markie/select-chevron.svg", 13., if open { p.foreground } else { p.muted }))
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_filter_menu(menu, cx)))
    }

    fn render_filter_menu(&self, menu: FilterMenu, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let (options, top, left): (Vec<(SharedString, bool, FilterChoice)>, f32, f32) = match menu {
            FilterMenu::RecentType | FilterMenu::BrowseType => {
                let current = if menu == FilterMenu::RecentType {
                    self.shell.recent.only_format()
                } else {
                    self.library.only_format()
                };
                let mut v = vec![(SharedString::from("All types"), current.is_none(), FilterChoice::Type(None))];
                v.extend(TYPE_MENU.iter().map(|k| {
                    (SharedString::from(type_menu_label(Some(*k))), current == Some(*k), FilterChoice::Type(Some(*k)))
                }));
                // Browse hangs the menu under its own button, in the page's toolbar.
                if menu == FilterMenu::RecentType { (v, 188., 8.) } else { (v, 36., 0.) }
            }
            FilterMenu::RecentSort => {
                let current = self.shell.recent.sort;
                (
                    SortOrder::ALL.iter().map(|s| (SharedString::from(s.label()), *s == current, FilterChoice::Sort(*s))).collect(),
                    188.,
                    (self.shell.panel_width - 16.) / 2. + 11.,
                )
            }
        };
        let rows = options.into_iter().enumerate().map(|(i, (label, on, choice))| {
            div()
                .id(("filter-opt", i))
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
                .child(label)
                .child(div().w(px(14.)).child(if on { "✓" } else { "" }))
                .on_click(cx.listener(move |this, _, _, cx| {
                    match (menu, choice) {
                        (FilterMenu::BrowseType, FilterChoice::Type(k)) => {
                            this.library.set_only_format(k);
                            this.shell.invalidate_browse();
                        }
                        (_, FilterChoice::Type(k)) => this.shell.recent.set_only_format(k),
                        (_, FilterChoice::Sort(s)) => this.shell.recent.set_sort(s),
                    }
                    this.shell.filter_menu = None;
                    cx.notify();
                }))
        });
        div().absolute().top(px(top)).left(px(left)).child(deferred(
            anchored().snap_to_window_with_margin(px(8.)).child(
                menu_panel(&p)
                    .id("filter-menu")
                    .occlude()
                    .p(px(4.))
                    .min_w(px(150.))
                    .max_w(px(230.))
                    .rounded(px(10.))
                    .children(rows)
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| this.close_filter_menu(cx))),
            ),
        ))
    }

    /// The Cloud or Vault page, in place of the document.
    pub(super) fn render_workspace_page(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        if self.shell.view == LeftView::Recent {
            return self.render_recent_page(window, cx);
        }
        if self.shell.view == LeftView::Browse {
            return self.render_browse_page(cx);
        }
        if self.shell.view == LeftView::Cloud {
            return self.render_cloud_workspace(window, cx);
        }
        if self.shell.view == LeftView::LiveDocs {
            return self.render_live_docs(cx);
        }
        if let Some(vault) = self.render_vault() {
            return vault;
        }
        let p = themes::palette(cx);
        let signed_in_cloud = self.shell.view == LeftView::Cloud && self.cloud.selected_scope().is_some();
        let (title, glyph, body) = match self.shell.view {
            LeftView::Vault => (
                "Vault",
                "markie/vault.svg",
                "Locked files and keys stay encrypted on this Mac. The vault is not in Markie RS yet.",
            ),
            _ => ("Cloud", "markie/cloud-large.svg", "Sign in to sync your documents across devices and share them."),
        };
        v_flex()
            .size_full()
            .bg(p.background)
            .child(
                h_flex()
                    .min_h(px(64.))
                    .flex_none()
                    .justify_between()
                    .gap(px(16.))
                    .px(px(28.))
                    .py(px(12.))
                    .border_b_1()
                    .border_color(p.border.opacity(0.7))
                    .child(
                        h_flex()
                            .gap(px(12.))
                            .child(
                                div()
                                    .size(px(40.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(11.))
                                    .border_1()
                                    .border_color(p.border.opacity(0.8))
                                    .bg(p.surface2.opacity(0.8))
                                    .child(icon(glyph, 20., p.blue)),
                            )
                            .child(
                                v_flex()
                                    // `leading-tight` title over a `leading-none` status line.
                                    .child(div().text_size(px(17.)).line_height(px(21.25)).font_weight(FontWeight::SEMIBOLD).child(title))
                                    .child(if signed_in_cloud {
                                        // Signed in, the header says so and is not a button (library.tsx).
                                        h_flex()
                                            .id("page-sign-in")
                                            .mt(px(2.))
                                            .gap(px(6.))
                                            .text_size(px(11.))
                                            .line_height(px(11.))
                                            .text_color(p.muted)
                                            .child(div().size(px(6.)).rounded_full().bg(p.green))
                                            .child("Connected")
                                    } else {
                                        h_flex()
                                            .id("page-sign-in")
                                            .mt(px(2.))
                                            .gap(px(6.))
                                            .text_size(px(11.))
                                            .line_height(px(11.))
                                            .text_color(p.muted)
                                            .cursor_pointer()
                                            .hover(|s| s.text_color(p.foreground))
                                            .child(div().size(px(6.)).rounded_full().bg(p.yellow))
                                            .child("Sign in")
                                            .on_click(cx.listener(|this, _, window, cx| this.open_account(window, cx)))
                                    }),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("page-open")
                            .h(px(32.))
                            .px(px(10.))
                            .gap(px(6.))
                            .rounded(px(6.))
                            .text_size(px(11.5))
                            .text_color(p.muted)
                            .hover(|s| s.bg(p.accent.opacity(0.4)).text_color(p.foreground))
                            .child("+")
                            .child("Open file")
                            .on_click(|_, w, cx| w.dispatch_action(Box::new(Open), cx)),
                    ),
            )
            .child({
                v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap(px(6.))
                    .px(px(28.))
                    .child(div().text_size(px(13.5)).child(if self.shell.view == LeftView::Vault {
                        "Nothing locked yet"
                    } else {
                        "Nothing in the cloud yet"
                    }))
                    .child(div().max_w(px(420.)).text_center().text_size(px(12.)).text_color(p.muted).child(body))
                    .into_any_element()
            })
            .into_any_element()
    }

    /// ⇧⌘F: search every document by name or what it says.
    pub(super) fn render_search(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.shell.search_open {
            return None;
        }
        let p = themes::palette(cx);
        let lib = &self.shell.search;
        let typed = !lib.text().trim().is_empty();
        let hits: Vec<_> = lib.hits().iter().take(SEARCH_LIMIT).cloned().collect();
        let selected = self.shell.search_selected.min(hits.len().saturating_sub(1));
        let heading = if typed {
            "RESULTS"
        } else if lib.has_filters() {
            "RECENTLY CHANGED OF THESE TYPES"
        } else {
            "RECENTLY CHANGED"
        };
        let home = markie_core::paths::home_dir();
        let now = chrono::Local::now();
        let chip = |id: &'static str, label: &'static str, on: bool| {
            div()
                .id(id)
                .px(px(9.9))
                .py(px(3.5))
                .rounded_full()
                .border_1()
                .border_color(if on { p.blue.opacity(0.55) } else { p.border.opacity(0.85) })
                .when(on, |el| el.bg(p.blue.opacity(0.16)))
                .text_size(px(11.5))
                .text_color(if on { p.foreground } else { p.muted })
                .hover(|s| s.text_color(p.foreground))
                .child(label)
        };
        let chips = h_flex()
            .flex_wrap()
            .gap(px(6.))
            .px(px(16.))
            .py(px(10.))
            .border_b_1()
            .border_color(p.border.opacity(0.6))
            .child(chip("chip-all", "All types", !lib.has_filters()).on_click(cx.listener(|this, _, _, cx| {
                this.shell.search.clear_formats();
                this.schedule_body_search(cx);
                cx.notify();
            })))
            .children(SEARCH_TYPES.iter().map(|(id, label, kinds)| {
                let on = kinds.iter().any(|k| lib.is_filtered(*k));
                chip(id, label, on).on_click(cx.listener(move |this, _, _, cx| this.toggle_search_type(kinds, cx)))
            }));
        let list = v_flex()
            .id("search-list")
            .min_h(px(120.))
            .flex_1()
            .overflow_y_scroll()
            .py(px(6.))
            .when(!hits.is_empty(), |el| {
                el.child(
                    div()
                        .px(px(16.))
                        .pt(px(6.))
                        .pb(px(4.))
                        .text_size(px(10.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(p.muted.opacity(0.8))
                        .child(heading),
                )
            })
            .when(hits.is_empty(), |el| {
                el.child(
                    v_flex()
                        .items_center()
                        .px(px(20.))
                        .py(px(40.))
                        .child(div().text_size(px(13.5)).child(if typed { "Nothing matches" } else { "No documents found yet" }))
                        .child(div().mt(px(4.)).text_size(px(12.)).text_color(p.muted).child(if typed {
                            if lib.has_filters() {
                                "Try another word, or include more document types."
                            } else {
                                "Try another word or a shorter phrase."
                            }
                        } else {
                            "Markie is still indexing this Mac, or nothing of these types was found."
                        })),
                )
            })
            .children(hits.iter().enumerate().map(|(i, hit)| {
                let doc = lib.doc(hit);
                let on = i == selected;
                h_flex()
                    .id(("search-hit", i))
                    .items_start()
                    .gap(px(12.))
                    .px(px(16.))
                    .py(px(10.))
                    .when(on, |el| el.bg(if p.dark { p.accent.opacity(0.72) } else { p.fg(0.06) }))
                    .child(div().mt(px(2.)).child(format_icon(doc.format, 18., &p)))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                h_flex()
                                    .gap(px(8.))
                                    .child(div().truncate().text_size(px(13.5)).font_weight(FontWeight::MEDIUM).child(super::projects::marked(
                                        &doc.name,
                                        &markie_core::doc_text::highlight_ranges(&doc.name, lib.text()),
                                        &p,
                                    )))
                                    .child(div().ml_auto().flex_none().text_size(px(11.)).text_color(p.muted).child(updated_ago(doc.mtime_ms, now))),
                            )
                            .child(div().truncate().text_size(px(11.5)).text_color(p.muted).child(compact_dir(&doc.dir, &home, 3)))
                            .when_some(hit.excerpt.clone(), |el, ex| {
                                // The body search's own marks; an instant-filter
                                // excerpt has none, so mark its terms here.
                                let marks = if hit.marks.is_empty() {
                                    markie_core::doc_text::highlight_ranges(&ex, lib.text())
                                } else {
                                    hit.marks.clone()
                                };
                                el.child(div().mt(px(4.)).text_size(px(12.)).line_height(px(16.5)).text_color(p.fg(0.75)).child(super::projects::marked(&ex, &marks, &p)))
                            }),
                    )
                    .on_mouse_move(cx.listener(move |this, _, _, cx| {
                        if this.shell.search_selected != i {
                            this.shell.search_selected = i;
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| this.open_search_hit(i, window, cx)))
            }));
        let footer = h_flex()
            .justify_between()
            .gap(px(12.))
            .px(px(16.))
            .py(px(8.))
            .border_t_1()
            .border_color(p.border.opacity(0.6))
            .text_size(px(11.))
            .text_color(p.muted)
            .child(if typed {
                format!("{} {} · {} documents indexed", lib.hits().len(), if lib.hits().len() == 1 { "match" } else { "matches" }, lib.total())
            } else {
                format!("{} documents indexed", lib.total())
            })
            .child(h_flex().gap(px(12.)).child("↑↓ move").child("↵ open"));
        let panel = v_flex()
            .id("search-panel")
            .occlude()
            .w(px(760.))
            .max_w(relative(0.94))
            .max_h(relative(0.72))
            .overflow_hidden()
            .rounded(px(16.))
            .bg(p.surface2)
            .border_1()
            .border_color(p.border)
            .shadow(vec![BoxShadow {
                color: hsla(0., 0., 0., if p.dark { 0.26 } else { 0.10 }),
                offset: point(px(0.), px(18.)),
                blur_radius: px(44.),
                spread_radius: px(0.),
                inset: false,
            }])
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| this.search_key(ev, window, cx)))
            .child(
                h_flex()
                    .gap(px(12.))
                    .px(px(16.))
                    .border_b_1()
                    .border_color(p.border.opacity(0.7))
                    .child(icon("markie/big-search.svg", 17., p.muted))
                    .child(div().flex_1().py(px(10.)).child(Input::new(&self.shell.search_input).appearance(false).text_size(px(15.))))
                    .child(
                        div()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .border_1()
                            .border_color(p.border.opacity(0.8))
                            .text_size(px(10.))
                            .text_color(p.muted)
                            .child("esc"),
                    ),
            )
            .child(chips)
            .child(list)
            .child(footer);
        Some(
            div()
                .id("search-scrim")
                .absolute()
                .inset_0()
                .flex()
                .justify_center()
                .pt(relative(0.12))
                .bg(p.background.opacity(0.58))
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close_search(window, cx)))
                .child(panel.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()))
                .into_any_element(),
        )
    }
}

#[derive(Clone, Copy)]
enum FilterChoice {
    Type(Option<FormatKind>),
    Sort(SortOrder),
}

const SEARCH_LIMIT: usize = 80;

/// `SEARCH_TYPES` in global-search.tsx.
const SEARCH_TYPES: &[(&str, &str, &[FormatKind])] = &[
    ("chip-markdown", "Markdown", &[FormatKind::Markdown]),
    ("chip-word", "Word", &[FormatKind::Docx, FormatKind::Doc]),
    ("chip-rtf", "Rich Text", &[FormatKind::Rtf]),
    ("chip-odt", "OpenDocument", &[FormatKind::Odt]),
    ("chip-text", "Plain text", &[FormatKind::Text]),
    ("chip-darkmown", "Darkmown", &[FormatKind::Darkmown]),
    ("chip-csv", "CSV", &[FormatKind::Csv]),
    ("chip-json", "JSON", &[FormatKind::Json]),
    ("chip-yaml", "YAML", &[FormatKind::Yaml]),
    ("chip-xml", "XML", &[FormatKind::Xml]),
    ("chip-html", "HTML", &[FormatKind::Html]),
];

/// The type menu's order (`TYPES` in library-document-filters.tsx).
pub(super) const TYPE_MENU: &[FormatKind] = &[
    FormatKind::Markdown,
    FormatKind::Text,
    FormatKind::Docx,
    FormatKind::Doc,
    FormatKind::Rtf,
    FormatKind::Odt,
    FormatKind::Darkmown,
    FormatKind::Csv,
    FormatKind::Json,
    FormatKind::Yaml,
    FormatKind::Xml,
    FormatKind::Html,
    FormatKind::Unsupported,
];

pub(super) fn type_menu_label(kind: Option<FormatKind>) -> &'static str {
    match kind {
        None => "All types",
        Some(FormatKind::Markdown) => "Markdown",
        Some(FormatKind::Text) => "Text",
        Some(FormatKind::Darkmown) => "Darkmown",
        Some(FormatKind::Unsupported) => "Other",
        Some(k) => icons::format_short(k),
    }
}

/// The rail's instant label, to the right of the button.
fn rail_tip(label: impl Into<SharedString>, p: &Palette) -> impl IntoElement {
    div().absolute().left(px(44.)).top(px(7.)).child(deferred(
        anchored().child(
            div()
                .whitespace_nowrap()
                .rounded(px(6.))
                .border_1()
                .border_color(p.border)
                .bg(p.surface2)
                .px(px(8.))
                .py(px(5.))
                .text_size(px(11.5))
                .line_height(px(11.5))
                .text_color(p.foreground)
                .shadow_lg()
                .child(label.into()),
        ),
    ))
}

fn small_icon_button(id: &'static str, glyph: &'static str, p: &Palette) -> Stateful<Div> {
    let (fg, fill) = (p.foreground, p.accent.opacity(0.4));
    div()
        .id(id)
        .group(id)
        .size(px(24.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .hover(|s| s.bg(fill))
        .child(icon(glyph, 15., p.muted).group_hover(id, |s| s.text_color(fg)))
}

/// `.markie-overlay-field` around a borderless input, with the search glyph.
pub(super) fn filter_field(state: &Entity<InputState>, size: f32, p: &Palette) -> impl IntoElement {
    let bg = if p.dark { mix(p.background, p.surface, 0.82) } else { p.background };
    let border = if p.dark { p.border } else { mix(p.foreground, p.border, 0.14) };
    h_flex()
        .h(px(32.))
        .w_full()
        .rounded(px(7.))
        .border_1()
        .border_color(border)
        .bg(bg)
        .pl(px(9.))
        .pr(px(8.))
        .gap(px(0.))
        .child(icon("markie/filter-search.svg", 13., p.muted))
        .child(div().flex_1().min_w_0().child(Input::new(state).appearance(false).text_size(px(size))))
}

/// `FormatFileIcon`: a page in the type's colour with its family glyph.
pub(super) fn format_icon(format: FormatKind, size: f32, p: &Palette) -> impl IntoElement {
    let (glyph, dark, light) = icons::format_glyph(format);
    let color: Hsla = rgb(if p.dark { dark } else { light }).into();
    div()
        .relative()
        .flex_none()
        .size(px(size))
        .child(svg().path("markie/fmt-fill.svg").absolute().inset_0().size(px(size)).text_color(color.opacity(0.12)))
        .child(svg().path("markie/fmt-page.svg").absolute().inset_0().size(px(size)).text_color(color))
        .child(svg().path(glyph).absolute().inset_0().size(px(size)).text_color(color))
}

/// `FormatBadge`: the short type label in its colour.
pub(super) fn format_badge(format: FormatKind, p: &Palette) -> impl IntoElement {
    let (_, dark, light) = icons::format_glyph(format);
    let color: Hsla = rgb(if p.dark { dark } else { light }).into();
    div()
        .flex_none()
        .min_w(px(33.6))
        .h(px(16.))
        .px(px(4.8))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .bg(color.opacity(0.14))
        .border_1()
        .border_color(color.opacity(0.28))
        .text_size(px(9.))
        .font_weight(FontWeight(650.))
        .text_color(color)
        .child(icons::format_short(format))
}

/// `compactHomePath` in path-display.ts: `Notes`, or `~/Notes` with the
/// full-path toggle on, for a folder under home.
fn compact_home(dir: &Path, home: &Path, full: bool) -> String {
    match dir.strip_prefix(home) {
        Ok(rel) if rel.as_os_str().is_empty() => if full { "~".into() } else { String::new() },
        Ok(rel) if full => format!("~/{}", rel.display()),
        Ok(rel) => rel.display().to_string(),
        Err(_) => dir.display().to_string(),
    }
}

/// `compactDir`: home folded to `~`, only the last `keep` folders.
fn compact_dir(dir: &Path, home: &Path, keep: usize) -> String {
    let full = compact_home(dir, home, true);
    let segs: Vec<&str> = full.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() <= keep {
        let joined = segs.join("/");
        return if full.starts_with('/') { format!("/{joined}") } else { joined };
    }
    format!("…/{}", segs[segs.len() - keep..].join("/"))
}

/// `updatedAgo` in relative-time.ts: "just now", "20m ago", "3h ago",
/// "yesterday", a weekday, "Nov 3", then the year.
fn updated_ago(ms: f64, now: chrono::DateTime<chrono::Local>) -> String {
    use chrono::{Datelike as _, TimeZone as _};
    if !(ms.is_finite() && ms > 0.0) {
        return String::new();
    }
    let Some(then) = chrono::Local.timestamp_millis_opt(ms as i64).single() else { return String::new() };
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
    if days < 7 {
        return then.format("%A").to_string();
    }
    if then.year() == now.year() {
        return then.format("%b %-d").to_string();
    }
    then.year().to_string()
}

#[cfg(test)]
mod tests {
    use super::{compact_dir, compact_home, updated_ago};
    use std::path::Path;
    use chrono::TimeZone as _;

    #[test]
    fn updated_ago_reads_like_electron() {
        let now = chrono::Local.with_ymd_and_hms(2026, 11, 21, 12, 0, 0).unwrap();
        let ms = |d: chrono::DateTime<chrono::Local>| d.timestamp_millis() as f64;
        assert_eq!(updated_ago(ms(now), now), "just now");
        assert_eq!(updated_ago(ms(now - chrono::Duration::minutes(20)), now), "20m ago");
        assert_eq!(updated_ago(ms(now - chrono::Duration::hours(3)), now), "3h ago");
        assert_eq!(updated_ago(ms(now - chrono::Duration::days(1)), now), "yesterday");
        assert_eq!(updated_ago(ms(chrono::Local.with_ymd_and_hms(2026, 3, 4, 9, 0, 0).unwrap()), now), "Mar 4");
        assert_eq!(updated_ago(ms(chrono::Local.with_ymd_and_hms(2024, 3, 4, 9, 0, 0).unwrap()), now), "2024");
        assert_eq!(updated_ago(f64::NAN, now), "");
    }

    #[test]
    fn compacts_home_paths() {
        let home = Path::new("/Users/k");
        assert_eq!(compact_home(Path::new("/Users/k/Notes"), home, true), "~/Notes");
        assert_eq!(compact_home(Path::new("/Users/k/Notes"), home, false), "Notes");
        assert_eq!(compact_home(Path::new("/Users/k"), home, true), "~");
        assert_eq!(compact_home(Path::new("/tmp/x"), home, false), "/tmp/x");
        assert_eq!(compact_dir(Path::new("/Users/k/a/b/c/d"), home, 3), "…/b/c/d");
        assert_eq!(compact_dir(Path::new("/Users/k/a"), home, 3), "~/a");
    }
}

/// `toLocaleString()` for a count: 30,000.
fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod count_tests {
    use super::group_thousands;

    #[test]
    fn counts_read_like_to_locale_string() {
        assert_eq!(group_thousands(7), "7");
        assert_eq!(group_thousands(1200), "1,200");
        assert_eq!(group_thousands(30000), "30,000");
        assert_eq!(group_thousands(1234567), "1,234,567");
    }
}

#[cfg(test)]
mod panel_width_tests {
    use super::{clamp_panel_width, max_panel_width};

    #[test]
    fn follows_panel_width_ts() {
        assert_eq!(max_panel_width(1280.), 520.);
        assert_eq!(max_panel_width(800.), 360.);
        assert_eq!(max_panel_width(300.), 200.);
        assert_eq!(clamp_panel_width(252., 1280.), 252.);
        assert_eq!(clamp_panel_width(900., 1280.), 520.);
        assert_eq!(clamp_panel_width(50., 1280.), 200.);
        assert_eq!(clamp_panel_width(f32::NAN, 1280.), 252.);
        assert_eq!(clamp_panel_width(-4., 1280.), 252.);
    }
}
