//! The Skills view: src/components/skills-view.tsx's InstalledSkills, over the
//! device index. Rows come from `markie_agent::skills::from_index`, which ports
//! the view's grouping; this file is its look and its actions.
//!
//! The rows differ from Electron's by design (audit row 16.8): a name and a
//! description each get two lines before an ellipsis, and the row's actions
//! (Show in Finder, the star, Remove) sit in a small toolbar that appears on
//! hover and on the keyboard cursor, and in the row's menu (right-click, the
//! ⋯ button, Shift-F10 or Control-Return), instead of a line of links under
//! every row.
use super::Workspace;
use crate::themes::{Palette, mix};
use gpui_kit::accesskit::{Action as AccessibleAction, Role};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use markie_agent::skills::{self, Kind, Row, Tool};
use markie_core::{
    index::{self, IndexedDoc, ScanOptions},
    registry::Registry,
};
use std::{cell::Cell, collections::BTreeSet, path::PathBuf, rc::Rc};

/// skills-view.tsx `FULL_KEY`, kept in Markie RS's own settings.
const FULL_KEY: &str = "markie.skills.fullpath.v1";

/// The list's inset and a row's own padding: section labels, the kind
/// toggles and the row text all start on the same line, as in Library.
const LIST_X: f32 = 6.;
const ROW_X: f32 = 8.;

impl Workspace {
    pub(super) fn prepare_skills(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.skills.is_some() {
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Filter skills & agent files…"));
        let directories = self.registry.as_ref().and_then(|r| r.roots().ok()).unwrap_or_default();
        // The index's own home: the scratch data folder in a test run.
        let opts = super::device_scan_options(directories);
        let home = opts.home.clone();
        let config = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|v| PathBuf::from(v.trim()))
        };
        // A scratch run indexes no configured agent folders, so it names none.
        let scratch = std::env::var_os("MARKIE_RS_DATA_DIR").is_some();
        let (claude, codex) = if scratch { (None, None) } else { (config("CLAUDE_CONFIG_DIR"), config("CODEX_HOME")) };
        let snapshot = self.registry.as_ref().and_then(|r| r.load_snapshot().ok().flatten());
        let registry = self.registry.clone();
        let full_path = registry
            .as_ref()
            .and_then(|r| r.setting(FULL_KEY).ok().flatten())
            .is_some_and(|v| v == "1");
        let workspace = cx.weak_entity();
        let panel = cx.new(|cx: &mut Context<SkillsPanel>| {
            let sub = cx.subscribe(&input, |_, _, _: &InputEvent, cx| cx.notify());
            let mut panel = SkillsPanel {
                input,
                trash_roots: skills::roots(&home, claude.clone(), codex.clone()),
                tool_roots: skills::tool_roots(&home, claude, codex),
                opts,
                rows: Vec::new(),
                closed: BTreeSet::new(),
                full_path,
                loading: true,
                notice: None,
                stars: BTreeSet::new(),
                confirming: None,
                busy: None,
                registry,
                workspace,
                focus: cx.focus_handle(),
                scroll: ScrollHandle::new(),
                cursor: None,
                menu: None,
                order: Vec::new(),
                cursor_bounds: Rc::new(Cell::new(None)),
                _sub: sub,
            };
            panel.load_stars();
            panel.load(snapshot, cx);
            panel
        });
        self.skills = Some(panel);
    }

    pub(super) fn render_skills_panel(&self) -> AnyElement {
        self.skills.clone().map(IntoElement::into_any_element).unwrap_or_else(|| {
            div().p_3().text_xs().child("Looking for agent files…").into_any_element()
        })
    }

    /// `onMdIndexUpdated`: a fresh device index replaces the panel's rows.
    pub(super) fn skills_index_updated(&self, files: &[IndexedDoc], cx: &mut Context<Self>) {
        if let Some(panel) = &self.skills {
            let files = files.to_vec();
            panel.update(cx, |panel, cx| panel.set_rows(files, cx));
        }
    }
}

pub(super) struct SkillsPanel {
    input: Entity<InputState>,
    trash_roots: Vec<(Tool, PathBuf)>,
    tool_roots: Vec<(Tool, PathBuf)>,
    opts: ScanOptions,
    rows: Vec<Row>,
    /// Kinds toggled from their default (Skills open, the rest closed).
    closed: BTreeSet<(Tool, Kind)>,
    full_path: bool,
    loading: bool,
    notice: Option<String>,
    stars: BTreeSet<PathBuf>,
    /// The skill folder whose Remove is asking "Move … to the Trash?".
    confirming: Option<PathBuf>,
    busy: Option<PathBuf>,
    registry: Option<Rc<Registry>>,
    workspace: WeakEntity<Workspace>,
    focus: FocusHandle,
    scroll: ScrollHandle,
    /// The row the arrow keys are on, by its file.
    cursor: Option<PathBuf>,
    menu: Option<RowMenu>,
    /// The rows as last drawn, in order, with each one's place among the
    /// list's children (for scrolling the cursor into view).
    order: Vec<(PathBuf, usize)>,
    /// Where the cursor row was drawn, for a menu opened from the keyboard.
    cursor_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    _sub: Subscription,
}

/// A row's open action menu.
struct RowMenu {
    path: PathBuf,
    at: Point<Pixels>,
    focus: usize,
}

/// What a row can do. Every one is in the row's menu; Show in Finder and the
/// star are also in its hover toolbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RowAction {
    Open,
    Reveal,
    Star,
    Remove,
}

#[derive(Debug, PartialEq, Eq)]
struct MenuEntry {
    action: RowAction,
    label: &'static str,
    danger: bool,
    separated: bool,
}

/// The row menu: open, show in the file manager, star, then (for a skill
/// folder Markie may throw away) Remove on its own at the bottom, as
/// Electron keeps it apart from the other links.
fn menu_entries(starred: bool, removable: bool) -> Vec<MenuEntry> {
    let e = |action, label, danger, separated| MenuEntry { action, label, danger, separated };
    let mut entries = vec![
        e(RowAction::Open, "Open", false, false),
        e(RowAction::Reveal, reveal_label(), false, false),
        e(RowAction::Star, if starred { "Unstar" } else { "Star" }, false, false),
    ];
    if removable {
        entries.push(e(RowAction::Remove, "Remove…", true, true));
    }
    entries
}

/// A menu item's icon; Remove uses Library's bin, as its Delete file does.
fn menu_icon(action: RowAction, starred: bool, color: Hsla) -> AnyElement {
    let name = match action {
        RowAction::Open => IconName::ExternalLink,
        RowAction::Reveal => IconName::FolderOpen,
        RowAction::Star if starred => IconName::StarOff,
        RowAction::Star => IconName::Star,
        RowAction::Remove => {
            let bytes = super::library_rows::svg_bytes(super::library_rows::ICON_TRASH, 14);
            return svg().data(&bytes).size(px(14.)).text_color(color).into_any_element();
        }
    };
    div().text_color(color).child(Icon::new(name).xsmall()).into_any_element()
}

/// `revealWord`: what the platform's file manager is called.
fn reveal_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Show in Finder"
    } else if cfg!(windows) {
        "Show in Explorer"
    } else {
        "Show in your file manager"
    }
}

/// path-display.ts `inferHomePath` and `compactHomePath(dir, home, full)`.
fn compact_home_path(input: &std::path::Path, home: &std::path::Path, full: bool) -> String {
    let Ok(rest) = input.strip_prefix(home) else {
        return input.display().to_string();
    };
    let rest = rest.to_string_lossy();
    match (rest.is_empty(), full) {
        (true, true) => "~".into(),
        (true, false) => String::new(),
        (false, false) => rest.into_owned(),
        (false, true) => format!("~{}{rest}", std::path::MAIN_SEPARATOR),
    }
}

/// A name or path laid out to wrap between its parts. Line breaking already
/// allows a break after a hyphen; this adds one (a zero-width space) after a
/// slash, underscore or colon that has more text after it, so
/// `pdf_form_filler` and `~/.claude/skills` break there and not mid-word.
fn with_break_points(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if matches!(c, '/' | '\\' | '_' | ':') && chars.peek().is_some_and(|n| !matches!(n, '/' | '\\' | '_' | ':')) {
            out.push('\u{200B}');
        }
    }
    out
}

/// Where a menu opened from the keyboard goes: under the row's toolbar, its
/// right edge near the row's.
fn menu_point(row: Option<Bounds<Pixels>>) -> Point<Pixels> {
    row.map_or(point(px(40.), px(80.)), |b| point(b.right() - px(190.), b.top() + px(28.)))
}

/// Where the arrow keys move the cursor in a list of `len` rows.
fn step_cursor(len: usize, at: Option<usize>, key: &str) -> Option<usize> {
    if len == 0 {
        return None;
    }
    let last = len - 1;
    Some(match (key, at) {
        ("down", None) | ("home", _) => 0,
        ("up", None) | ("end", _) => last,
        ("down", Some(i)) => (i + 1).min(last),
        ("up", Some(i)) => i.saturating_sub(1),
        _ => return at,
    })
}

impl SkillsPanel {
    fn set_rows(&mut self, files: Vec<IndexedDoc>, cx: &mut Context<Self>) {
        let roots = self.tool_roots.clone();
        cx.spawn(async move |this, cx| {
            let rows = cx.background_spawn(async move { skills::from_index(&files, &roots) }).await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                this.rows = rows;
                cx.notify();
            });
        })
        .detach();
    }

    fn load(&mut self, snapshot: Option<index::IndexSnapshot>, cx: &mut Context<Self>) {
        let (opts, roots) = (self.opts.clone(), self.tool_roots.clone());
        cx.spawn(async move |this, cx| {
            let rows = cx
                .background_spawn(async move {
                    let index = snapshot.unwrap_or_else(|| index::scan(&opts));
                    skills::from_index(&index.files, &roots)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                this.rows = rows;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn load_stars(&mut self) {
        self.stars = self
            .registry
            .as_ref()
            .and_then(|r| r.stars().ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
    }

    fn toggle_star(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        match self.registry.as_ref().map(|r| r.toggle_star(&path, "file")) {
            Some(Ok(_)) => {
                self.notice = None;
                self.load_stars();
            }
            _ => self.notice = Some("Couldn't save that star.".into()),
        }
        cx.notify();
    }

    fn toggle_full_path(&mut self, cx: &mut Context<Self>) {
        self.full_path = !self.full_path;
        if let Some(reg) = &self.registry {
            // A preference that will not save is not worth a broken panel.
            let _ = reg.set_setting(FULL_KEY, if self.full_path { "1" } else { "0" });
        }
        cx.notify();
    }

    fn trash(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        self.confirming = None;
        self.busy = Some(folder.clone());
        self.notice = None;
        let roots = self.trash_roots.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let target = skills::trash_target(&folder, &roots).map_err(str::to_owned)?;
                    trash::delete(target).map_err(|_| "Couldn't move that skill to the Trash.".to_string())
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                match result {
                    // onReindex: read the device again.
                    Ok(()) => this.load(None, cx),
                    Err(e) => this.notice = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn open(&self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let _ = self.workspace.update(cx, |ws, cx| ws.open_external(vec![path], window, cx));
    }

    fn row_for(&self, path: &std::path::Path) -> Option<&Row> {
        self.rows.iter().find(|r| r.path == path)
    }

    /// The folder a skill row's Remove throws away.
    fn folder_of(row: &Row) -> PathBuf {
        row.folder.clone().unwrap_or_else(|| row.path.clone())
    }

    fn entries_for(&self, path: &std::path::Path) -> Vec<MenuEntry> {
        let removable = self.row_for(path).is_some_and(|r| r.kind == Kind::Skill && r.removable);
        menu_entries(self.stars.contains(path), removable)
    }

    fn run(&mut self, path: PathBuf, action: RowAction, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        match action {
            RowAction::Open => self.open(path, window, cx),
            RowAction::Reveal => crate::logs::reveal_in_file_manager(&path),
            RowAction::Star => self.toggle_star(path, cx),
            RowAction::Remove => {
                if self.busy.is_none()
                    && let Some(row) = self.row_for(&path)
                {
                    self.confirming = Some(Self::folder_of(row));
                }
            }
        }
        cx.notify();
    }

    fn open_menu(&mut self, path: PathBuf, at: Point<Pixels>, cx: &mut Context<Self>) {
        let same = self.menu.as_ref().is_some_and(|m| m.path == path);
        self.menu = if same { None } else { Some(RowMenu { path: path.clone(), at, focus: 0 }) };
        self.cursor = Some(path);
        cx.notify();
    }

    /// The menu's keys while it is open, as Library's `FileMenu`: the arrows,
    /// Home and End move round the items, Return and Space run one, Escape
    /// and Tab close it.
    fn menu_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(menu) = &self.menu else { return false };
        let entries = self.entries_for(&menu.path);
        let n = entries.len();
        let i = menu.focus.min(n.saturating_sub(1));
        let path = menu.path.clone();
        let focus = match key {
            "down" => (i + 1) % n,
            "up" => (i + n - 1) % n,
            "home" => 0,
            "end" => n - 1,
            "enter" | "space" => {
                self.run(path, entries[i].action, window, cx);
                return true;
            }
            "escape" | "tab" => {
                self.menu = None;
                cx.notify();
                return true;
            }
            _ => return false,
        };
        if let Some(menu) = &mut self.menu {
            menu.focus = focus;
        }
        cx.notify();
        true
    }

    /// Keys anywhere in the panel, the filter included: the arrows move the
    /// row cursor, Return opens its row, Shift-F10 or Control-Return opens its
    /// menu, and Escape leaves the inline Trash question or the cursor.
    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &event.keystroke;
        let key = k.key.as_str();
        if self.menu.is_some() {
            if self.menu_key(key, window, cx) {
                cx.stop_propagation();
            }
            return;
        }
        let in_filter = self.input.read(cx).focus_handle(cx).is_focused(window);
        let wants_menu = (key == "f10" && k.modifiers.shift) || (key == "enter" && k.modifiers.control);
        if k.modifiers.platform || k.modifiers.alt || (k.modifiers.shift && !wants_menu) || (k.modifiers.control && !wants_menu) {
            return;
        }
        let at = self.cursor.as_ref().and_then(|c| self.order.iter().position(|(p, _)| p == c));
        match key {
            _ if wants_menu => {
                let Some(path) = self.cursor.clone().filter(|_| at.is_some()) else { return };
                let at = menu_point(self.cursor_bounds.get());
                self.menu = None;
                self.open_menu(path, at, cx);
            }
            "down" | "up" => self.move_cursor(at, key),
            "home" | "end" if !in_filter => self.move_cursor(at, key),
            "enter" if self.confirming.is_some() && at.is_some() => {
                if let Some(folder) = self.confirming.clone() {
                    self.trash(folder, cx);
                }
            }
            "enter" => {
                let Some(path) = self.cursor.clone().filter(|_| at.is_some()) else { return };
                self.open(path, window, cx);
            }
            "escape" if self.confirming.is_some() => self.confirming = None,
            "escape" if self.cursor.is_some() && !in_filter => self.cursor = None,
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn move_cursor(&mut self, at: Option<usize>, key: &str) {
        if let Some(i) = step_cursor(self.order.len(), at, key) {
            let (path, child) = self.order[i].clone();
            self.cursor = Some(path);
            self.scroll.scroll_to_item(child);
        }
    }
}

fn link(id: SharedString, label: impl Into<SharedString>, color: Hsla, hover: Hsla) -> Stateful<Div> {
    let label = label.into();
    div()
        .id(id)
        .role(Role::Button)
        .aria_label(label.clone())
        .rounded(px(3.))
        .text_size(px(11.))
        .line_height(px(15.))
        .text_color(color)
        .cursor_pointer()
        .hover(move |s| s.text_color(hover))
        .child(label)
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

/// One button in a row's hover toolbar. A `lit` one (a set star) keeps its
/// colour on hover.
fn tool_button(id: SharedString, icon: IconName, label: SharedString, color: Hsla, lit: bool, p: &Palette) -> Stateful<Div> {
    let (fg, hover) = (p.foreground, p.fg(0.08));
    let tip = label.clone();
    div()
        .id(id)
        .role(Role::Button)
        .aria_label(label)
        .flex_none()
        .size(px(20.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.))
        .text_color(color)
        .cursor_pointer()
        .hover(move |s| {
            let s = s.bg(hover);
            if lit { s } else { s.text_color(fg) }
        })
        .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
        .child(Icon::new(icon).xsmall())
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

impl Render for SkillsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = crate::themes::palette(cx);
        let filter = self.input.read(cx).value().to_string();
        let q = filter.trim().to_lowercase();
        let active = self
            .workspace
            .upgrade()
            .and_then(|ws| ws.read(cx).doc.as_ref().map(|d| d.path.clone()));
        let focused = self.focus.contains_focused(window, cx);
        // Skills match their label, folder or description; other files their path.
        let shown = |row: &&Row| {
            q.is_empty()
                || if row.kind == Kind::Skill {
                    row.label.to_lowercase().contains(&q)
                        || row
                            .folder
                            .as_ref()
                            .is_some_and(|f| f.to_string_lossy().to_lowercase().contains(&q))
                        || row.description.as_ref().is_some_and(|d| d.to_lowercase().contains(&q))
                } else {
                    row.path.to_string_lossy().to_lowercase().contains(&q)
                }
        };
        let mut children: Vec<AnyElement> = Vec::new();
        let mut order: Vec<(PathBuf, usize)> = Vec::new();
        let mut total = 0;
        for tool in Tool::ALL {
            let rows: Vec<&Row> = self.rows.iter().filter(|r| r.tool == tool).filter(shown).collect();
            if rows.is_empty() {
                continue;
            }
            let first = total == 0;
            total += rows.len();
            children.push(section_header(tool, rows.len(), first, &p).into_any_element());
            for kind in [Kind::Skill, Kind::Instructions, Kind::Command, Kind::Agent, Kind::Memory, Kind::Other] {
                let matches: Vec<&Row> = rows.iter().copied().filter(|r| r.kind == kind).collect();
                if matches.is_empty() {
                    continue;
                }
                let open = !q.is_empty() || ((kind == Kind::Skill) ^ self.closed.contains(&(tool, kind)));
                children.push(kind_toggle(tool, kind, matches.len(), open, &p, cx).into_any_element());
                if open {
                    for row in matches {
                        let is_active = active.as_ref() == Some(&row.path);
                        let on_cursor = focused && self.cursor.as_ref() == Some(&row.path);
                        order.push((row.path.clone(), children.len()));
                        children.push(self.row(row, is_active, on_cursor, &p, cx));
                    }
                }
            }
        }
        // A cursor whose row left the list (filtered out, folded, removed) goes.
        if self.cursor.as_ref().is_some_and(|c| !order.iter().any(|(p, _)| p == c)) {
            self.cursor = None;
        }
        self.order = order;
        let message = |text: String| {
            div().px(px(LIST_X + ROW_X)).py_4().text_size(px(12.)).line_height(px(17.)).text_color(p.muted).child(text).into_any_element()
        };
        if self.loading {
            children = vec![message("Looking for agent files…".into())];
        } else if total == 0 {
            children = vec![message(format!(
                "No agent files found{}. Markie looks for CLAUDE.md, AGENTS.md, GEMINI.md, and the skills folders of Claude Code, Codex, Cursor, Gemini and ~/.agents.",
                if filter.is_empty() { "" } else { " for this filter" }
            ))];
        }
        let full = self.full_path;
        let fg = p.foreground;
        let menu = self.render_menu(&p, cx);
        v_flex()
            .id("skills-panel")
            .track_focus(&self.focus)
            .size_full()
            .min_h_0()
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| this.on_key(event, window, cx)))
            .child(
                h_flex()
                    .flex_none()
                    .px_2()
                    .py(px(6.))
                    .gap(px(6.))
                    .border_b_1()
                    .border_color(p.border)
                    .child(div().flex_1().min_w_0().child(super::rail::filter_field(&self.input, 12., &p)))
                    .child(
                        div()
                            .id("skills-full-path")
                            .role(Role::CheckBox)
                            .aria_label("Show full ~ paths")
                            .aria_toggled(if full { accesskit::Toggled::True } else { accesskit::Toggled::False })
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .text_size(px(11.))
                            .cursor_pointer()
                            .when(full, |d| d.bg(p.accent).text_color(p.foreground))
                            .when(!full, |d| d.text_color(p.muted).hover(move |s| s.text_color(fg)))
                            .tooltip(|window, cx| Tooltip::new("Show full ~ paths").build(window, cx))
                            .child("~/")
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_full_path(cx))),
                    ),
            )
            .children(self.notice.as_ref().map(|notice| {
                div()
                    .flex_none()
                    .px_2()
                    .py(px(6.))
                    .text_size(px(11.))
                    .text_color(p.red)
                    .border_b_1()
                    .border_color(p.border)
                    .child(notice.clone())
            }))
            .child(
                v_flex()
                    .id("skills-scroll")
                    .role(Role::List)
                    .aria_label("Skills and agent files")
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(px(LIST_X))
                    .pb(px(10.))
                    .children(children),
            )
            .children(menu)
    }
}

/// A tool's section label and count, as Library's "ON THIS DEVICE".
fn section_header(tool: Tool, count: usize, first: bool, p: &Palette) -> impl IntoElement {
    h_flex()
        .id(SharedString::from(format!("skills-tool-{tool:?}")))
        .role(Role::Heading)
        .aria_level(2)
        .aria_label(format!("{} {count}", tool.label()))
        .justify_between()
        .px(px(ROW_X))
        .pt(px(if first { 10. } else { 16. }))
        .pb(px(4.))
        .child(div().text_size(px(9.)).text_color(p.muted).child(tool.label().to_uppercase()))
        .child(
            div()
                .px(px(4.))
                .rounded(px(4.))
                .border_1()
                .border_color(p.border.opacity(0.7))
                .text_size(px(9.))
                .text_color(p.muted)
                .child(count.to_string()),
        )
}

/// A kind's fold toggle: "▾ Skills 9".
fn kind_toggle(tool: Tool, kind: Kind, count: usize, open: bool, p: &Palette, cx: &mut Context<SkillsPanel>) -> impl IntoElement {
    let fg = p.foreground;
    h_flex()
        .id(SharedString::from(format!("skills-kind-{tool:?}-{kind:?}")))
        .role(Role::Button)
        .aria_label(format!("{} {count}", kind.label()))
        .aria_expanded(open)
        .w_full()
        .px(px(ROW_X))
        .pt(px(6.))
        .pb(px(3.))
        .gap(px(4.))
        .text_size(px(10.5))
        .line_height(px(14.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(p.muted)
        .cursor_pointer()
        .hover(move |s| s.text_color(fg))
        .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).xsmall())
        .child(kind.label())
        .child(div().font_weight(FontWeight::NORMAL).text_color(p.muted.opacity(0.75)).child(count.to_string()))
        .on_click(cx.listener(move |this, _, _, cx| {
            if !this.closed.remove(&(tool, kind)) {
                this.closed.insert((tool, kind));
            }
            cx.notify();
        }))
}

impl SkillsPanel {
    /// `InstalledSkillRow`, and the row of any other agent file: the name on
    /// up to two lines, then the description (a skill) or the folder (any
    /// other file) on up to two more. A lit star stays in the corner.
    fn row(&self, row: &Row, active: bool, on_cursor: bool, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let home = &self.opts.home;
        let skill = row.kind == Kind::Skill;
        let path = row.path.clone();
        let id = path.display().to_string();
        let group = SharedString::from(format!("skills-row-{id}"));
        let label = row.label.clone();
        let starred = self.stars.contains(&row.path);
        let folder = Self::folder_of(row);
        let confirming = skill && self.confirming.as_ref() == Some(&folder);
        let busy = skill && self.busy.as_ref() == Some(&folder);
        let menu_open = self.menu.as_ref().is_some_and(|m| m.path == row.path);
        let detail = if skill {
            row.description.clone()
        } else {
            row.path.parent().map(|d| compact_home_path(d, home, self.full_path)).filter(|d| !d.is_empty()).map(|d| with_break_points(&d))
        };
        // skills-view.tsx's `title`: the folder for a skill, the file for the rest.
        let place = compact_home_path(if skill { &folder } else { &row.path }, home, true);
        let tip_description = if skill { row.description.clone() } else { None };
        let (tip_name, tip_place) = (label.clone(), place);
        let reveal = SharedString::from(format!("{}: {label}", reveal_label()));
        let star_label = SharedString::from(format!("{} {label}", if starred { "Unstar" } else { "Star" }));

        let p2 = *p;
        let hover_bg = p.accent.opacity(0.4);
        let cursor_bg = if p.dark { p.accent.opacity(0.72) } else { p.fg(0.07) };
        let toolbar_bg = if p.dark { p.surface2 } else { mix(p.background, p.surface2, 0.58) };
        let show_tools = on_cursor || menu_open;

        let (reveal_path, star_path, menu_path, context_path, open_path, a11y_path, down_path) =
            (path.clone(), path.clone(), path.clone(), path.clone(), path.clone(), path.clone(), path.clone());
        let tools = h_flex()
            .absolute()
            .top(px(3.))
            .right(px(4.))
            .gap(px(1.))
            .rounded(px(6.))
            .bg(toolbar_bg)
            .border_1()
            .border_color(p.border.opacity(if p.dark { 1. } else { 0.7 }))
            .shadow(vec![BoxShadow {
                color: hsla(0., 0., 0., if p.dark { 0.25 } else { 0.08 }),
                offset: point(px(0.), px(1.)),
                blur_radius: px(3.),
                spread_radius: px(0.),
                inset: false,
            }])
            .when(!show_tools, |d| d.opacity(0.).group_hover(group.clone(), |s| s.opacity(1.)))
            .child(
                tool_button(SharedString::from(format!("skill-reveal-{id}")), IconName::FolderOpen, reveal, p.muted, false, p)
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        crate::logs::reveal_in_file_manager(&reveal_path);
                    }),
            )
            .child(
                tool_button(
                    SharedString::from(format!("skill-star-{id}")),
                    if starred { IconName::StarFill } else { IconName::Star },
                    star_label,
                    if starred { p.yellow } else { p.muted },
                    starred,
                    p,
                )
                .aria_toggled(if starred { accesskit::Toggled::True } else { accesskit::Toggled::False })
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.toggle_star(star_path.clone(), cx);
                })),
            )
            .child(
                tool_button(SharedString::from(format!("skill-more-{id}")), IconName::Ellipsis, SharedString::from(format!("Actions for {label}")), p.muted, false, p)
                    .when(menu_open, |d| d.bg(p.fg(0.08)).text_color(p.foreground))
                    .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                        cx.stop_propagation();
                        let at = ev.position();
                        this.open_menu(menu_path.clone(), point(at.x - px(170.), at.y + px(14.)), cx);
                    })),
            );

        let name = div()
            .text_size(px(12.5))
            .line_height(px(16.))
            .text_color(p.foreground)
            .when(active, |d| d.font_weight(FontWeight::MEDIUM))
            .whitespace_normal()
            .line_clamp(2)
            .text_ellipsis()
            .when(starred, |d| d.pr(px(18.)))
            .child(with_break_points(&row.label));
        let mut body = v_flex().gap(px(1.)).child(name);
        if busy {
            body = body.child(div().text_size(px(11.)).line_height(px(15.)).text_color(p.muted).child("Removing…"));
        } else if let Some(detail) = detail {
            body = body.child(
                div()
                    .text_size(px(11.))
                    .line_height(px(15.))
                    .text_color(p.muted)
                    .whitespace_normal()
                    .line_clamp(2)
                    .text_ellipsis()
                    .child(detail),
            );
        }
        if confirming {
            let target = folder.clone();
            body = body.child(
                h_flex()
                    .flex_wrap()
                    .gap_x(px(10.))
                    .pt(px(3.))
                    .child(div().text_size(px(11.)).line_height(px(15.)).text_color(p.muted).child(format!("Move {label} to the Trash?")))
                    .child(
                        link(SharedString::from(format!("skill-trash-{id}")), "Move to Trash", p.red, p.red)
                            .aria_label(format!("Move {label} to the Trash"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.trash(target.clone(), cx);
                            })),
                    )
                    .child(link(SharedString::from(format!("skill-cancel-{id}")), "Cancel", p.muted, p.foreground).on_click(cx.listener(
                        |this, _, _, cx| {
                            cx.stop_propagation();
                            this.confirming = None;
                            cx.notify();
                        },
                    ))),
            );
        }

        let bounds = self.cursor_bounds.clone();
        div()
            .id(SharedString::from(format!("{}-row-{id}", if skill { "skill" } else { "agent" })))
            .group(group)
            .role(Role::ListItem)
            .aria_label(label.clone())
            .when_some(row.description.clone().filter(|_| skill), |d, desc| d.aria_description(desc))
            .aria_selected(on_cursor)
            .relative()
            .w_full()
            .rounded(px(6.))
            .px(px(ROW_X))
            .py(px(6.))
            .cursor_pointer()
            .when(active, |d| d.bg(p.accent))
            .when(!active && on_cursor, |d| d.bg(cursor_bg))
            .when(!active && !on_cursor && menu_open, |d| d.bg(hover_bg))
            .when(!active && !on_cursor && !menu_open, |d| d.hover(move |s| s.bg(hover_bg)))
            .tooltip(move |window, cx| {
                let (name, description, place) = (tip_name.clone(), tip_description.clone(), tip_place.clone());
                Tooltip::element(move |_, _| {
                    v_flex()
                        .max_w(px(320.))
                        .gap(px(3.))
                        .child(div().font_weight(FontWeight::MEDIUM).child(name.clone()))
                        .when_some(description.clone(), |d, desc| d.child(div().whitespace_normal().child(desc)))
                        .child(div().text_size(px(11.)).text_color(p2.muted).child(with_break_points(&place)))
                })
                .build(window, cx)
            })
            .child(body)
            .when(starred, |d| {
                d.child(
                    div()
                        .absolute()
                        .top(px(8.))
                        .right(px(9.))
                        .text_color(p2.yellow)
                        .child(Icon::new(IconName::StarFill).xsmall()),
                )
            })
            .child(tools)
            .when(on_cursor, |d| {
                d.child(
                    canvas(move |b, _, _| bounds.set(Some(b)), |_, _, _, _| {})
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                )
            })
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, window, cx| {
                this.menu = None;
                this.cursor = Some(down_path.clone());
                window.focus(&this.focus, cx);
            }))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                window.focus(&this.focus, cx);
                this.menu = None;
                this.open_menu(context_path.clone(), ev.position, cx);
            }))
            .on_a11y_action(AccessibleAction::ShowContextMenu, {
                let this = cx.weak_entity();
                let bounds = self.cursor_bounds.clone();
                move |_, _, cx| {
                    let at = menu_point(bounds.get());
                    let path = a11y_path.clone();
                    let _ = this.update(cx, |this, cx| this.open_menu(path, at, cx));
                }
            })
            .on_click(cx.listener(move |this, _, window, cx| this.open(open_path.clone(), window, cx)))
            .into_any_element()
    }

    /// The open row's menu, at the click or beside the cursor row.
    fn render_menu(&self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.menu.as_ref()?;
        let p = *p;
        let starred = self.stars.contains(&menu.path);
        let entries = self.entries_for(&menu.path);
        let focus = menu.focus.min(entries.len().saturating_sub(1));
        let hover = p.accent.opacity(0.85);
        let items = entries.into_iter().enumerate().map(|(i, entry)| {
            let color = if entry.danger { (p.red, p.red) } else { (p.foreground, p.muted) };
            let (path, action) = (menu.path.clone(), entry.action);
            div()
                .when(entry.separated, |d| d.child(div().h(px(1.)).mx(px(6.)).my(px(4.)).bg(p.border)))
                .child(
                    h_flex()
                        .id(("skills-menu-item", i))
                        .role(Role::MenuItem)
                        .aria_label(entry.label)
                        .gap(px(8.))
                        .w_full()
                        .rounded(px(6.))
                        .px(px(8.))
                        .py(px(5.))
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .text_color(color.0)
                        .cursor_pointer()
                        .when(i == focus, |d| d.bg(hover))
                        .hover(move |s| s.bg(hover))
                        .child(div().w(px(16.)).flex_none().flex().justify_center().child(menu_icon(entry.action, starred, color.1)))
                        .child(div().min_w_0().truncate().child(entry.label))
                        .on_click(cx.listener(move |this, _, window, cx| this.run(path.clone(), action, window, cx))),
                )
        });
        Some(
            deferred(
                anchored().position(menu.at).child(
                    super::chrome::menu_panel(&p)
                        .id("skills-row-menu")
                        .role(Role::Menu)
                        .occlude()
                        .rounded(px(10.))
                        .p(px(4.))
                        .min_w(px(184.))
                        .max_w(px(260.))
                        .children(items)
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.menu = None;
                            cx.notify();
                        })),
                ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

#[cfg(feature = "scene")]
impl Workspace {
    /// The Skills panel over the scratch data folder's agent tree
    /// (docs/rust-port/SCREEN.md). Args: `filter` (words typed in the
    /// filter), `full: true` (the `~/` toggle), `star` (labels to star),
    /// `cursor` (the label the keyboard cursor is on, which shows its
    /// toolbar), `menu` (a label whose row menu is open), `confirm` (a label
    /// whose Remove is asking), `closed` (kind labels to fold, such as
    /// "Skills"), `open` (kind labels to unfold). Ready once the rows are in.
    pub(super) fn scene_skills(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(panel) = self.skills.clone() else { return false };
        if panel.read(cx).loading {
            return false;
        }
        if *step == 1 {
            panel.update(cx, |panel, cx| panel.scene_apply(args, window, cx));
            *step = 2;
            return false;
        }
        if *step == 2 {
            panel.update(cx, |panel, cx| panel.scene_late(args, window, cx));
            *step = 3;
            return false;
        }
        if *step == 3 {
            panel.update(cx, |panel, cx| panel.scene_menu(args, cx));
            *step = 4;
            return false;
        }
        true
    }
}

#[cfg(feature = "scene")]
impl SkillsPanel {
    fn scene_label(&self, args: &serde_json::Value, key: &str) -> Option<PathBuf> {
        let label = args.get(key)?.as_str()?;
        self.rows.iter().find(|r| r.label == label).map(|r| r.path.clone())
    }

    fn scene_apply(&mut self, args: &serde_json::Value, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(filter) = args.get("filter").and_then(|v| v.as_str()) {
            let filter = filter.to_string();
            self.input.update(cx, |input, cx| input.set_value(filter, window, cx));
        }
        if args.get("full").and_then(|v| v.as_bool()).unwrap_or(false) && !self.full_path {
            self.full_path = true;
        }
        for label in args.get("star").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_str()) {
            if let Some(path) = self.rows.iter().find(|r| r.label == label).map(|r| r.path.clone())
                && !self.stars.contains(&path)
            {
                self.toggle_star(path, cx);
            }
        }
        let kinds = [Kind::Skill, Kind::Instructions, Kind::Command, Kind::Agent, Kind::Memory, Kind::Other];
        for (key, fold) in [("closed", true), ("open", false)] {
            for label in args.get(key).and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_str()) {
                for kind in kinds.iter().copied().filter(|k| k.label() == label) {
                    for tool in Tool::ALL {
                        // Skills start open; the rest start closed.
                        if fold == (kind == Kind::Skill) {
                            self.closed.insert((tool, kind));
                        }
                    }
                }
            }
        }
        if let Some(folder) = self.scene_label(args, "confirm").and_then(|p| self.row_for(&p).map(Self::folder_of)) {
            self.confirming = Some(folder);
        }
        if args.get("cursor").is_some() || args.get("menu").is_some() {
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }

    /// After a frame, so the cursor row has been drawn and placed.
    fn scene_late(&mut self, args: &serde_json::Value, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(path) = self.scene_label(args, "cursor").or_else(|| self.scene_label(args, "menu")) {
            self.cursor = Some(path.clone());
            if let Some((_, child)) = self.order.iter().find(|(p, _)| *p == path) {
                self.scroll.scroll_to_item(*child);
            }
        }
        cx.notify();
    }

    /// Once the cursor row has been drawn: its menu, where Shift-F10 opens it.
    fn scene_menu(&mut self, args: &serde_json::Value, cx: &mut Context<Self>) {
        if let Some(path) = self.scene_label(args, "menu") {
            self.menu = Some(RowMenu { path, at: menu_point(self.cursor_bounds.get()), focus: 0 });
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{RowAction, compact_home_path, menu_entries, step_cursor, with_break_points};
    use std::path::Path;

    #[test]
    fn home_paths_compact_as_path_display_does() {
        let home = Path::new("/Users/k");
        assert_eq!(compact_home_path(Path::new("/Users/k/work/app"), home, false), "work/app");
        assert_eq!(compact_home_path(Path::new("/Users/k/work/app"), home, true), "~/work/app");
        assert_eq!(compact_home_path(home, home, false), "");
        assert_eq!(compact_home_path(home, home, true), "~");
        assert_eq!(compact_home_path(Path::new("/opt/x"), home, true), "/opt/x");
    }

    #[test]
    fn names_and_paths_may_break_after_their_separators() {
        assert_eq!(with_break_points("agent-harness-best-practices"), "agent-harness-best-practices");
        assert_eq!(with_break_points("pdf_form_filler"), "pdf_\u{200B}form_\u{200B}filler");
        assert_eq!(with_break_points("~/.claude/skills"), "~/\u{200B}.claude/\u{200B}skills");
        assert_eq!(with_break_points("plugin:skill"), "plugin:\u{200B}skill");
        // Nothing after the last separator, or a run of them: no break inside.
        assert_eq!(with_break_points("trailing/"), "trailing/");
        assert_eq!(with_break_points("a//b"), "a//\u{200B}b");
        assert_eq!(with_break_points("nobreaks").chars().count(), 8);
    }

    #[test]
    fn every_electron_action_is_in_the_row_menu() {
        let actions = |starred, removable| menu_entries(starred, removable).into_iter().map(|e| (e.action, e.label)).collect::<Vec<_>>();
        let reveal = super::reveal_label();
        assert_eq!(actions(false, false), vec![(RowAction::Open, "Open"), (RowAction::Reveal, reveal), (RowAction::Star, "Star")]);
        assert_eq!(
            actions(true, true),
            vec![(RowAction::Open, "Open"), (RowAction::Reveal, reveal), (RowAction::Star, "Unstar"), (RowAction::Remove, "Remove…")]
        );
        let remove = menu_entries(false, true).pop().unwrap();
        assert!(remove.danger && remove.separated, "Remove sits apart, in red");
    }

    #[test]
    fn the_arrow_keys_walk_the_rows_and_stop_at_the_ends() {
        assert_eq!(step_cursor(0, None, "down"), None);
        assert_eq!(step_cursor(3, None, "down"), Some(0));
        assert_eq!(step_cursor(3, None, "up"), Some(2));
        assert_eq!(step_cursor(3, Some(0), "down"), Some(1));
        assert_eq!(step_cursor(3, Some(2), "down"), Some(2));
        assert_eq!(step_cursor(3, Some(0), "up"), Some(0));
        assert_eq!(step_cursor(3, Some(1), "home"), Some(0));
        assert_eq!(step_cursor(3, Some(1), "end"), Some(2));
    }

    #[test]
    fn user_visible_copy_has_no_em_dashes() {
        let source = include_str!("skills.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert!(!code.lines().filter(|l| !l.trim_start().starts_with("//")).any(|l| l.contains('\u{2014}')));
    }

    /// A scratch run indexes its data folder as home; the Skills view must
    /// match tool roots against that same folder, or it finds nothing.
    #[test]
    fn a_scratch_index_and_its_tool_roots_share_one_home() {
        let data = tempfile::tempdir().unwrap();
        let data = data.path().canonicalize().unwrap();
        for (rel, text) in [
            (".claude/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: First\n---\n# Alpha\n"),
            (".claude/CLAUDE.md", "# Claude\n"),
        ] {
            let path = data.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let opts = crate::workspace::scan_options_for(Some(data.clone()), "/nonexistent-home".into(), Vec::new());
        assert_eq!(opts.home, data);
        let index = markie_core::index::scan(&opts);
        let rows = markie_agent::skills::from_index(&index.files, &markie_agent::skills::tool_roots(&opts.home, None, None));
        let labels: Vec<&str> = rows.iter().map(|r| r.label.as_str()).collect();
        assert!(rows.iter().any(|r| r.label == "alpha" && r.tool == markie_agent::skills::Tool::Claude), "{labels:?}");
        assert!(rows.iter().any(|r| r.path.ends_with(".claude/CLAUDE.md")), "{labels:?}");
    }
}
