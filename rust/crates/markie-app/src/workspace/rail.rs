//! The left edge: the 52px activity bar of `src/components/activity-bar.tsx`
//! and the side panels it opens (`library.tsx`, `browse-view.tsx`), the
//! Cloud and Vault pages, and the ⇧⌘F search of `global-search.tsx`.
//!
//! What Markie RS has is wired; what it does not have yet shows the same
//! empty state the Electron app shows a signed-out or first-run user.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
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

pub(super) const RAIL_WIDTH: f32 = 52.;
const PANEL_DEFAULT_WIDTH: f32 = 252.;

/// What the left edge shows (`src/lib/left-rail.ts`, plus the Vault page).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LeftView {
    Library,
    Browse,
    Cloud,
    Skills,
    Vault,
    /// The pencil: the formatting rail, which owns no panel.
    Edit,
}

impl LeftView {
    fn title(self) -> &'static str {
        match self {
            LeftView::Library => "LIBRARY",
            LeftView::Browse => "BROWSE",
            LeftView::Cloud => "CLOUD",
            LeftView::Skills => "SKILLS",
            LeftView::Vault => "VAULT",
            LeftView::Edit => "",
        }
    }

    fn has_panel(self) -> bool {
        matches!(self, LeftView::Library | LeftView::Browse | LeftView::Skills)
    }

    /// Cloud and the Vault take the document area over instead of a panel.
    fn takes_workspace(self) -> bool {
        matches!(self, LeftView::Cloud | LeftView::Vault)
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

/// One row of Browse: a folder, or a file under an open folder.
#[derive(Clone)]
pub(super) enum BrowseRow {
    Folder { dir: PathBuf, label: SharedString, count: usize, open: bool },
    File { hit: usize },
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
    lib_tab: LibTab,
    filter_menu: Option<FilterMenu>,
    filter_closed: Option<(FilterMenu, Instant)>,
    pub recent: Library,
    recent_filter: Entity<InputState>,
    browse_filter: Entity<InputState>,
    browse_open: HashSet<PathBuf>,
    browse_rows: Option<Rc<Vec<BrowseRow>>>,
    browse_full_path: bool,
    /// Until a folder is toggled, every folder shows open, as in Electron.
    browse_touched: bool,
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
        let browse_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Search name, path, or text…"));
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
                    this.library.set_text(&text);
                    this.shell.browse_rows = None;
                    cx.notify();
                }
            }),
            cx.subscribe(&search_input, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.set_search_text(&text);
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
            lib_tab: LibTab::Recent,
            filter_menu: None,
            filter_closed: None,
            recent,
            recent_filter,
            browse_filter,
            browse_open: HashSet::new(),
            browse_rows: None,
            browse_full_path: false,
            browse_touched: false,
            search_open: false,
            search,
            search_input,
            search_selected: 0,
        };
        (shell, subs)
    }

    /// The index changed: Browse groups again on the next frame.
    pub(super) fn invalidate_browse(&mut self) {
        self.browse_rows = None;
    }

    /// The formatting rail is the chosen view (the editor reads this).
    #[allow(dead_code)]
    pub(super) fn format_rail_on(&self) -> bool {
        self.view == LeftView::Edit
    }
}

// ---------------------------------------------------------------- behaviour

impl Workspace {
    /// A rail click (`selectLeftView` in left-rail.ts): the current panel
    /// again closes it; the pencil twice returns to the last panel.
    fn select_view(&mut self, clicked: LeftView, cx: &mut Context<Self>) {
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

    fn toggle_filter_menu(&mut self, menu: FilterMenu, cx: &mut Context<Self>) {
        if let Some((closed, at)) = self.shell.filter_closed.take() {
            if closed == menu && at.elapsed().as_millis() < 250 {
                return;
            }
        }
        self.shell.filter_menu = if self.shell.filter_menu == Some(menu) { None } else { Some(menu) };
        cx.notify();
    }

    fn close_filter_menu(&mut self, cx: &mut Context<Self>) {
        if let Some(menu) = self.shell.filter_menu.take() {
            self.shell.filter_closed = Some((menu, Instant::now()));
            cx.notify();
        }
    }

    fn clear_recent_filters(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.recent.clear_query();
        self.shell.recent_filter.update(cx, |s, cx| s.set_value("", window, cx));
        cx.notify();
    }

    fn clear_browse_filters(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.library.set_only_format(None);
        self.shell.browse_filter.update(cx, |s, cx| s.set_value("", window, cx));
        self.shell.browse_rows = None;
        cx.notify();
    }

    fn toggle_folder(&mut self, dir: PathBuf, cx: &mut Context<Self>) {
        if !self.shell.browse_touched {
            self.shell.browse_touched = true;
            if let Some(rows) = &self.shell.browse_rows {
                self.shell.browse_open = rows
                    .iter()
                    .filter_map(|r| match r {
                        BrowseRow::Folder { dir, .. } => Some(dir.clone()),
                        BrowseRow::File { .. } => None,
                    })
                    .collect();
            }
        }
        if !self.shell.browse_open.remove(&dir) {
            self.shell.browse_open.insert(dir);
        }
        self.shell.browse_rows = None;
        cx.notify();
    }

    /// Group the Browse hits by folder. Runs only after the index, the
    /// filter or an open folder changed, never per frame.
    pub(super) fn ensure_browse_rows(&mut self) {
        if self.shell.browse_rows.is_some() || !(self.shell.panel_open && self.shell.view == LeftView::Browse) {
            return;
        }
        let forced = !self.library.text().trim().is_empty();
        let mut order: Vec<(PathBuf, Vec<usize>)> = Vec::new();
        let mut at: HashMap<&Path, usize> = HashMap::new();
        for (i, hit) in self.library.hits().iter().enumerate() {
            let dir = self.library.doc(hit).dir.as_path();
            match at.get(dir) {
                Some(&slot) => order[slot].1.push(i),
                None => {
                    at.insert(dir, order.len());
                    order.push((dir.to_path_buf(), vec![i]));
                }
            }
        }
        drop(at);
        if self.library.sort == SortOrder::Name {
            order.sort_by(|a, b| a.0.cmp(&b.0));
        }
        let home = markie_core::paths::home_dir();
        let mut rows = Vec::new();
        for (dir, files) in order {
            let open = forced || !self.shell.browse_touched || self.shell.browse_open.contains(&dir);
            rows.push(BrowseRow::Folder { label: compact_home(&dir, &home, self.shell.browse_full_path).into(), count: files.len(), open, dir });
            if open {
                rows.extend(files.into_iter().map(|hit| BrowseRow::File { hit }));
            }
        }
        self.shell.browse_rows = Some(Rc::new(rows));
    }

    fn show_agents(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let p = themes::palette(cx);
        window.open_dialog(cx, move |dialog, _, _| {
            dialog.title("Connect an agent").w(px(460.)).child(
                v_flex()
                    .gap(px(8.))
                    .text_size(px(12.5))
                    .child(div().text_color(p.fg(0.85)).child(
                        "Markie lets Claude, Codex and other agents read and edit your documents through its MCP server.",
                    ))
                    .child(div().text_color(p.muted).child(
                        "Markie RS does not run the agent bridge yet. Connect agents from the Markie app for now.",
                    )),
            )
        });
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
                |this, _, cx| this.select_view(LeftView::Browse, cx),
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
                |this, _, cx| this.select_view(LeftView::Skills, cx),
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
                |this, w, cx| this.show_agents(w, cx),
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
                    .child(
                        div()
                            .size(px(28.))
                            .rounded_full()
                            .border_1()
                            .border_color(p.border)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("markie/user.svg", 16., p.muted)),
                    )
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| this.set_rail_hover("rail-account", *hovered, cx)))
                    .when(self.shell.rail_hover == Some("rail-account"), |el| el.child(rail_tip("Sign in", &p)))
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
            LeftView::Library => self.render_library_view(&p, cx).into_any_element(),
            LeftView::Browse => self.render_browse_view(&p, cx).into_any_element(),
            _ => self.render_skills_view(&p).into_any_element(),
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
                .child(header)
                .child(body)
                .when(view != LeftView::Browse, |el| {
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
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.shell.lib_tab = tab;
                        cx.notify();
                    }))
            })),
        );
        let mut col = v_flex().flex_1().min_h_0().child(tabs);
        if s.lib_tab == LibTab::Projects {
            return col.child(
                v_flex().px(px(8.)).py(px(12.)).child(
                    v_flex()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.border.opacity(0.7))
                        .bg(p.background.opacity(0.45))
                        .px(px(10.))
                        .py(px(10.))
                        .gap(px(2.))
                        .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).child("No projects yet"))
                        .child(div().text_size(px(10.5)).text_color(p.muted).child(
                            "Projects group your documents by front matter and folder. They are not in Markie RS yet.",
                        )),
                ),
            );
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

    /// A Library row: format icon, name, type badge and where it lives.
    fn file_row(&self, doc: &IndexedDoc, active: bool, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let path = doc.path.clone();
        let hover = p.accent.opacity(0.4);
        div()
            .id(SharedString::from(format!("row-{}", doc.path.display())))
            .rounded(px(6.))
            .px(px(8.))
            .py(px(6.))
            .cursor_pointer()
            .when(active, |el| el.bg(p.accent))
            .when(!active, |el| el.hover(|s| s.bg(hover)))
            .child(
                h_flex()
                    .gap(px(6.))
                    .child(format_icon(doc.format, 15., p))
                    .child(div().flex_1().min_w_0().truncate().text_size(px(12.5)).text_color(p.foreground).child(doc.name.clone()))
                    .child(format_badge(doc.format, p))
                    .child(
                        div()
                            .size(px(16.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("markie/on-device.svg", 13., p.muted.opacity(0.7))),
                    ),
            )
            .on_click(cx.listener(move |this, _, window, cx| this.open_path(&path, window, cx)))
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
                let top = if menu == FilterMenu::RecentType { 188. } else { 82. };
                (v, top, 8.)
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
                            this.shell.browse_rows = None;
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

    fn render_browse_view(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let p = *p;
        let lib = &self.library;
        let rows = self.shell.browse_rows.clone().unwrap_or_default();
        let type_label = type_menu_label(lib.only_format());
        let filtered = lib.only_format().is_some() || !lib.text().is_empty();
        let sort_seg = segmented(&p).children([(SortOrder::Name, "Name"), (SortOrder::Recent, "Updated")].map(|(order, label)| {
            let on = lib.sort == order || (order == SortOrder::Name && lib.sort == SortOrder::Default);
            div()
                .id(SharedString::from(format!("bsort-{label}")))
                .h(px(28.))
                .px(px(10.4))
                .flex()
                .items_center()
                .rounded(px(7.))
                .text_size(px(11.5))
                .text_color(if on { p.foreground } else { p.muted })
                .when(on, |el| el.bg(segment_on(&p)))
                .hover(|s| s.text_color(p.foreground))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.library.set_sort(order);
                    this.shell.browse_rows = None;
                    cx.notify();
                }))
        }));
        let controls = v_flex()
            .flex_none()
            .gap(px(8.))
            .px(px(8.))
            .py(px(8.))
            .border_b_1()
            .border_color(p.border)
            .child(filter_field(&self.shell.browse_filter, 12., &p))
            .child(
                h_flex()
                    .gap(px(6.))
                    .text_size(px(11.))
                    .child(div().pl(px(2.)).text_color(p.muted).child("Type"))
                    .child(self.select_button(FilterMenu::BrowseType, type_label, &p, cx))
                    .when(filtered, |el| {
                        el.child(
                            div()
                                .id("browse-clear")
                                .h(px(32.))
                                .px(px(8.))
                                .flex()
                                .items_center()
                                .rounded(px(6.))
                                .text_color(p.muted)
                                .hover(|s| s.bg(p.accent.opacity(0.4)).text_color(p.foreground))
                                .child("Clear")
                                .on_click(cx.listener(|this, _, window, cx| this.clear_browse_filters(window, cx))),
                        )
                    }),
            )
            .child(
                h_flex()
                    .gap(px(4.))
                    .text_size(px(11.))
                    .child(div().pl(px(2.)).text_color(p.muted).child("Sort"))
                    .child(sort_seg)
                    .child(div().flex_1())
                    .child({
                        let starred = lib.tab == LibraryTab::Starred;
                        div()
                            .id("browse-starred")
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .when(starred, |el| el.bg(p.accent).text_color(p.yellow))
                            .when(!starred, |el| el.text_color(p.muted).hover(|s| s.text_color(p.foreground)))
                            .child("★")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.library.set_tab(if starred { LibraryTab::All } else { LibraryTab::Starred });
                                this.shell.browse_rows = None;
                                cx.notify();
                            }))
                    })
                    .child({
                        let full = self.shell.browse_full_path;
                        div()
                            .id("browse-fullpath")
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .when(full, |el| el.bg(p.accent).text_color(p.foreground))
                            .when(!full, |el| el.text_color(p.muted).hover(|s| s.text_color(p.foreground)))
                            .child("~/")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.shell.browse_full_path = !full;
                                this.shell.browse_rows = None;
                                cx.notify();
                            }))
                    })
                    .child(
                        div()
                            .id("browse-rescan")
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .text_color(p.muted)
                            .hover(|s| s.text_color(p.foreground))
                            .child(if lib.scanning { "…" } else { "⟳" })
                            .on_click(|_, w, cx| w.dispatch_action(Box::new(Rescan), cx)),
                    ),
            );
        let body: AnyElement = if lib.scanning && lib.total() == 0 {
            div().p(px(16.)).text_size(px(12.)).text_color(p.muted).child("Scanning your documents…").into_any_element()
        } else if rows.is_empty() {
            div()
                .p(px(16.))
                .text_size(px(12.))
                .text_color(p.muted)
                .child(if filtered { "No documents found for this filter." } else { "No documents found." })
                .into_any_element()
        } else {
            let current = self.doc.as_ref().map(|d| d.path.clone());
            let count = rows.len();
            uniform_list(
                "browse-rows",
                count,
                cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                    let p = themes::palette(cx);
                    let now = chrono::Local::now();
                    range
                        .map(|ix| match &rows[ix] {
                            BrowseRow::Folder { dir, label, count, open } => {
                                let dir = dir.clone();
                                h_flex()
                                    .id(("bfolder", ix))
                                    .w_full()
                                    .gap(px(4.))
                                    .pl(px(8.))
                                    .pr(px(8.))
                                    .py(px(4.))
                                    .text_size(px(12.))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(p.accent.opacity(0.3)))
                                    .child(div().w(px(12.)).text_color(p.muted).child(if *open { "▾" } else { "▸" }))
                                    .child(div().flex_1().min_w_0().truncate().text_color(p.fg(0.9)).child(label.clone()))
                                    .child(div().text_size(px(9.)).text_color(p.muted).child(count.to_string()))
                                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_folder(dir.clone(), cx)))
                            }
                            BrowseRow::File { hit } => {
                                let hit = this.library.hits()[*hit].clone();
                                let doc = this.library.doc(&hit);
                                let path = doc.path.clone();
                                let active = current.as_ref() == Some(&doc.path);
                                h_flex()
                                    .id(("bfile", ix))
                                    .w_full()
                                    .gap(px(4.))
                                    .pl(px(14.))
                                    .pr(px(8.))
                                    .py(px(4.))
                                    .text_size(px(12.))
                                    .cursor_pointer()
                                    .when(active, |el| el.bg(p.accent.opacity(0.4)))
                                    .hover(|s| s.bg(p.accent.opacity(0.3)))
                                    .child(div().w(px(12.)))
                                    .child(div().flex_1().min_w_0().truncate().child(doc.name.clone()))
                                    .child(div().text_size(px(10.)).text_color(p.muted).child(updated_ago(doc.mtime_ms, now)))
                                    .on_click(cx.listener(move |this, _, window, cx| this.open_path(&path, window, cx)))
                            }
                        })
                        .collect::<Vec<_>>()
                }),
            )
            .flex_1()
            .into_any_element()
        };
        v_flex()
            .flex_1()
            .min_h_0()
            .px(px(6.))
            .py(px(8.))
            .child(controls)
            .when(lib.truncated, |el| {
                el.child(
                    div()
                        .px(px(12.))
                        .py(px(6.))
                        .border_b_1()
                        .border_color(p.border)
                        .text_size(px(11.))
                        .text_color(p.yellow)
                        .child("Index is incomplete: the scan stopped at its limit."),
                )
            })
            .child(div().flex_1().min_h_0().flex().flex_col().child(body))
            .when(self.shell.filter_menu == Some(FilterMenu::BrowseType), |el| {
                el.child(self.render_filter_menu(FilterMenu::BrowseType, &p, cx))
            })
    }

    fn render_skills_view(&self, p: &Palette) -> impl IntoElement {
        v_flex().flex_1().min_h_0().px(px(14.)).py(px(14.)).gap(px(6.)).child(
            div()
                .text_size(px(12.))
                .text_color(p.muted)
                .child("Skills and agent files from Claude, Codex, Cursor and Gemini show here. They are not in Markie RS yet."),
        )
    }

    /// The Cloud or Vault page, in place of the document.
    pub(super) fn render_workspace_page(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = themes::palette(cx);
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
                                    .child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child(title))
                                    .child(
                                        h_flex()
                                            .id("page-sign-in")
                                            .mt(px(2.))
                                            .gap(px(6.))
                                            .text_size(px(11.))
                                            .text_color(p.muted)
                                            .cursor_pointer()
                                            .hover(|s| s.text_color(p.foreground))
                                            .child(div().size(px(6.)).rounded_full().bg(p.yellow))
                                            .child("Sign in")
                                            .on_click(cx.listener(|this, _, window, cx| this.open_account(window, cx))),
                                    ),
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
            .child(
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
                    .child(div().max_w(px(420.)).text_center().text_size(px(12.)).text_color(p.muted).child(body)),
            )
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
                                    .child(div().truncate().text_size(px(13.5)).font_weight(FontWeight::MEDIUM).child(doc.name.clone()))
                                    .child(div().ml_auto().flex_none().text_size(px(11.)).text_color(p.muted).child(updated_ago(doc.mtime_ms, now))),
                            )
                            .child(div().truncate().text_size(px(11.5)).text_color(p.muted).child(compact_dir(&doc.dir, &home, 3)))
                            .when_some(hit.excerpt.clone(), |el, ex| {
                                el.child(div().mt(px(4.)).text_size(px(12.)).line_height(px(16.5)).text_color(p.fg(0.75)).child(ex))
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
const TYPE_MENU: &[FormatKind] = &[
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
];

fn type_menu_label(kind: Option<FormatKind>) -> &'static str {
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
fn rail_tip(label: &'static str, p: &Palette) -> impl IntoElement {
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
                .child(label),
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
fn filter_field(state: &Entity<InputState>, size: f32, p: &Palette) -> impl IntoElement {
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
