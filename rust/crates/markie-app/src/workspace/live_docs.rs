//! Live Docs (super-nightly in Electron, `MARKIE_RS_NIGHTLY=1` here), the
//! two pieces Electron 0.9.7 has:
//!
//! - The Live Docs area (`live-docs-area.tsx`): a page of its own from the
//!   rail. Its home lists the Darkmown projects a person added; a project
//!   shows its files in a tree and edits text files in tabs, saving only at
//!   the revision it read. Outside edits reach the tree and open tabs.
//! - The project preview (`live-docs-preview-panel.tsx`): "Open Darkmown
//!   project preview…" runs the folder's own `darkmown dev` and shows the
//!   site in a native web view laid over the panel body. The view hides
//!   whenever a GPUI layer would sit under it (`web_views_covered`).
//!
//! Folders, files and the dev server are `markie_web::live_docs`; this file
//! is the shell around them. The project list lives in Markie RS's own data
//! folder, never Electron's.

use std::cell::Cell;
use std::collections::HashSet;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui_kit::component::input::{Editor, EditorState, InputEvent};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use markie_web::island::{Bounds as IslandBounds, SitePreview};
use markie_web::live_docs::projects::{Projects, PublicEntry, Refusal, TreeKind};
use markie_web::live_docs::runner::{DevServer, check_project_folder};

use super::Workspace;
use crate::themes::{self, Palette};

pub(super) fn enabled() -> bool {
    std::env::var("MARKIE_RS_NIGHTLY").is_ok_and(|v| v == "1")
}

// ------------------------------------------------------------- the tree

#[derive(Clone, Debug, PartialEq)]
pub(super) struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: TreeKind,
    pub children: Vec<TreeNode>,
}

/// `Intl.Collator({ numeric: true, sensitivity: "base" })`: "p2" before "p10".
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n = String::new();
                while let Some(ch) = x.peek().copied().filter(char::is_ascii_digit) {
                    n.push(ch);
                    x.next();
                }
                let mut m = String::new();
                while let Some(ch) = y.peek().copied().filter(char::is_ascii_digit) {
                    m.push(ch);
                    y.next();
                }
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let o = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if o.is_ne() {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o.is_ne() {
                    return o;
                }
                x.next();
                y.next();
            }
        }
    }
}

fn sort_nodes(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| {
        let folder_first = (b.kind == TreeKind::Dir).cmp(&(a.kind == TreeKind::Dir));
        folder_first.then_with(|| natural_cmp(&a.name, &b.name))
    });
    for n in nodes.iter_mut() {
        sort_nodes(&mut n.children);
    }
}

fn place(level: &mut Vec<TreeNode>, segments: &[&str], prefix: &str, kind: TreeKind) {
    let Some((first, rest)) = segments.split_first() else { return };
    let path = if prefix.is_empty() { first.to_string() } else { format!("{prefix}/{first}") };
    let i = match level.iter().position(|n| n.name == *first) {
        Some(i) => i,
        None => {
            let k = if rest.is_empty() { kind.clone() } else { TreeKind::Dir };
            level.push(TreeNode { name: first.to_string(), path: path.clone(), kind: k, children: Vec::new() });
            level.len() - 1
        }
    };
    if !rest.is_empty() {
        place(&mut level[i].children, rest, &path, kind);
    }
}

/// `buildProjectTree`: folders first, then names in natural order.
pub(super) fn build_project_tree(entries: &[(String, TreeKind)]) -> Vec<TreeNode> {
    let mut root = Vec::new();
    for (path, kind) in entries {
        if path.is_empty() {
            continue;
        }
        let segments: Vec<&str> = path.split('/').collect();
        place(&mut root, &segments, "", kind.clone());
    }
    sort_nodes(&mut root);
    root
}

/// The way down to the pages: `site` and `site/pages`, when they exist.
pub(super) fn initially_expanded(entries: &[(String, TreeKind)]) -> HashSet<String> {
    ["site", "site/pages"]
        .into_iter()
        .filter(|f| entries.iter().any(|(p, k)| p == f && *k == TreeKind::Dir))
        .map(str::to_string)
        .collect()
}

pub(super) fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Markdown and Darkmown get the Markdown grammar; the rest is plain text.
pub(super) fn edits_as_markdown(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".wd", ".md", ".markdown", ".mdx"].iter().any(|e| lower.ends_with(e))
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

// ------------------------------------------------------------- the tabs

/// Each open tab keeps its text; twelve at most, as Electron's MAX_TABS.
pub(super) const MAX_TABS: usize = 12;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Disk {
    Changed { text: String, revision: String },
    Deleted,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Tab {
    pub path: String,
    pub text: String,
    pub saved_text: String,
    pub revision: String,
    pub saving: bool,
    pub disk: Option<Disk>,
    pub error: Option<String>,
}

impl Tab {
    pub fn dirty(&self) -> bool {
        self.text != self.saved_text
    }
}

#[derive(Default, Debug)]
pub(super) struct Tabs {
    pub tabs: Vec<Tab>,
    pub active: Option<String>,
    /// A file that could not get a tab: every tab has unsaved changes.
    pub refused: Option<String>,
}

impl Tabs {
    pub fn get_mut(&mut self, path: &str) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.path == path)
    }

    pub fn active_tab(&self) -> Option<&Tab> {
        self.active.as_deref().and_then(|a| self.tabs.iter().find(|t| t.path == a))
    }

    /// `opened`: a new tab, evicting a clean one when twelve are open.
    pub fn opened(&mut self, path: &str, text: String, revision: String) {
        if self.tabs.iter().any(|t| t.path == path) {
            self.active = Some(path.to_string());
            self.refused = None;
            return;
        }
        if self.tabs.len() >= MAX_TABS {
            let clean = |t: &Tab| !t.dirty() && !t.saving && t.disk.is_none();
            let evict = self
                .tabs
                .iter()
                .position(|t| Some(&t.path) != self.active.as_ref() && clean(t))
                .or_else(|| self.tabs.iter().position(clean));
            let Some(i) = evict else {
                self.refused = Some(path.to_string());
                return;
            };
            self.tabs.remove(i);
        }
        self.tabs.push(Tab { path: path.into(), saved_text: text.clone(), text, revision, saving: false, disk: None, error: None });
        self.active = Some(path.to_string());
        self.refused = None;
    }

    pub fn close(&mut self, path: &str) {
        let Some(at) = self.tabs.iter().position(|t| t.path == path) else { return };
        self.tabs.remove(at);
        if self.active.as_deref() == Some(path) {
            self.active = self.tabs.get(at).or_else(|| at.checked_sub(1).and_then(|i| self.tabs.get(i))).map(|t| t.path.clone());
        }
    }

    /// `disk-read`: what the file holds now, from the outside-change poll.
    pub fn disk_read(&mut self, path: &str, text: String, revision: String) {
        let Some(tab) = self.get_mut(path) else { return };
        if tab.saving {
            return;
        }
        if revision == tab.revision {
            tab.disk = None;
        } else if text == tab.text {
            tab.saved_text = text;
            tab.revision = revision;
            tab.disk = None;
        } else if !tab.dirty() {
            tab.saved_text = text.clone();
            tab.text = text;
            tab.revision = revision;
            tab.disk = None;
        } else {
            tab.disk = Some(Disk::Changed { text, revision });
        }
    }

    pub fn disk_missing(&mut self, path: &str) {
        if let Some(tab) = self.get_mut(path) {
            if !tab.saving && tab.disk != Some(Disk::Deleted) {
                tab.disk = Some(Disk::Deleted);
            }
        }
    }

    pub fn reload(&mut self, path: &str) {
        if let Some(tab) = self.get_mut(path) {
            if let Some(Disk::Changed { text, revision }) = tab.disk.take() {
                tab.saved_text = text.clone();
                tab.text = text;
                tab.revision = revision;
                tab.error = None;
            }
        }
    }

    pub fn keep_mine(&mut self, path: &str) {
        if let Some(tab) = self.get_mut(path) {
            if let Some(Disk::Changed { text, revision }) = tab.disk.take() {
                tab.saved_text = text;
                tab.revision = revision;
                tab.error = None;
            }
        }
    }
}

// ------------------------------------------------------------- state

#[derive(Clone)]
enum ConfirmAction {
    Remove(String),
    LeaveProject,
    CloseTab(String),
}

#[derive(Clone)]
struct Confirm {
    title: String,
    body: String,
    label: &'static str,
    action: ConfirmAction,
}

struct OpenProject {
    name: String,
    location: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Phase {
    Starting,
    Ready,
    Error,
    Rejected,
}

/// The project preview panel.
pub(super) struct Preview {
    name: String,
    root: Option<PathBuf>,
    phase: Phase,
    message: Option<String>,
    log: Vec<String>,
    url: Option<String>,
    node: Option<String>,
    server: Option<Arc<Mutex<DevServer>>>,
    island: Option<Rc<SitePreview>>,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    attempt: u64,
}

pub(super) struct LiveDocs {
    projects: Projects,
    list: Option<Vec<PublicEntry>>,
    project: Option<OpenProject>,
    entries: Vec<(String, TreeKind)>,
    truncated: bool,
    expanded: HashSet<String>,
    tabs: Tabs,
    notice: Option<String>,
    confirm: Option<Confirm>,
    editor: Option<Entity<EditorState>>,
    /// Which tab's text the editor holds.
    editor_for: Option<String>,
    _editor_sub: Option<Subscription>,
    _poll: Task<()>,
    /// Size and change time of each open tab's file at the last look, so the
    /// poll reads a file again only when it changed.
    stamps: std::collections::HashMap<String, Option<(std::time::SystemTime, u64)>>,
    busy: bool,
    pub(super) preview: Option<Preview>,
}

impl LiveDocs {
    pub(super) fn new(data_dir: &std::path::Path) -> Self {
        Self {
            projects: Projects::new(data_dir.join("live-docs-projects.json"), markie_core::paths::home_dir()),
            list: None,
            project: None,
            entries: Vec::new(),
            truncated: false,
            expanded: HashSet::new(),
            tabs: Tabs::default(),
            notice: None,
            confirm: None,
            editor: None,
            editor_for: None,
            _editor_sub: None,
            _poll: Task::ready(()),
            stamps: Default::default(),
            busy: false,
            preview: None,
        }
    }

    pub(super) fn dirty_count(&self) -> usize {
        self.tabs.tabs.iter().filter(|t| t.dirty()).count()
    }
}

fn refusal(r: &Refusal) -> String {
    if r.message.is_empty() { "Something went wrong.".into() } else { r.message.clone() }
}

fn island_bounds(b: Bounds<Pixels>) -> IslandBounds {
    IslandBounds { x: f32::from(b.origin.x) as f64, y: f32::from(b.origin.y) as f64, width: f32::from(b.size.width) as f64, height: f32::from(b.size.height) as f64 }
}

/// `markie-overlay-button`: Electron's small bordered button.
fn button(id: impl Into<ElementId>, label: impl Into<SharedString>, p: &Palette) -> Stateful<Div> {
    let (hover, fg) = (p.accent.opacity(0.4), p.foreground);
    div()
        .id(id)
        .flex_none()
        .rounded(px(6.))
        .border_1()
        .border_color(p.border)
        .px(px(10.))
        .py(px(4.))
        .text_size(px(12.))
        .text_color(p.muted)
        .cursor_pointer()
        .hover(move |s| s.bg(hover).text_color(fg))
        .child(label.into())
}

impl Workspace {
    pub(super) fn live_docs_open(&self) -> bool {
        self.shell.view == super::rail::LeftView::LiveDocs
    }

    /// The first time the page shows: the list.
    pub(super) fn live_docs_shown(&mut self, cx: &mut Context<Self>) {
        if self.live_docs.list.is_none() {
            self.live_docs.list = Some(self.live_docs.projects.list());
            cx.notify();
        }
    }

    fn live_reload_list(&mut self) {
        self.live_docs.list = Some(self.live_docs.projects.list());
    }

    fn live_add_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.live_docs.busy {
            return;
        }
        self.live_docs.busy = true;
        self.live_docs.notice = None;
        let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Add Project".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let chosen = rx.await.ok().and_then(|r| r.ok()).flatten().and_then(|p| p.into_iter().next());
            this.update(cx, |this, cx| {
                this.live_docs.busy = false;
                if let Some(path) = chosen {
                    match this.live_docs.projects.add(&path) {
                        Ok((entry, existed)) => {
                            this.live_reload_list();
                            if existed {
                                this.live_docs.notice = Some(format!("{} is already in Live Docs.", entry.name));
                            }
                        }
                        Err(r) => this.live_docs.notice = Some(refusal(&r)),
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn live_open_project(&mut self, entry: &PublicEntry, cx: &mut Context<Self>) {
        self.live_docs.notice = None;
        match self.live_docs.projects.open(&entry.id) {
            Ok(name) => {
                self.live_reset_project_view();
                self.live_docs.project = Some(OpenProject { name, location: entry.location.clone() });
                match self.live_docs.projects.tree() {
                    Ok((entries, truncated)) => {
                        self.live_docs.expanded = initially_expanded(&entries);
                        self.live_docs.entries = entries;
                        self.live_docs.truncated = truncated;
                    }
                    Err(r) => self.live_docs.notice = Some(refusal(&r)),
                }
                self.live_start_watch(cx);
            }
            Err(r) => {
                self.live_docs.notice = Some(refusal(&r));
                self.live_reload_list();
            }
        }
        cx.notify();
    }

    fn live_reset_project_view(&mut self) {
        let d = &mut self.live_docs;
        d.tabs = Tabs::default();
        d.entries.clear();
        d.truncated = false;
        d.expanded.clear();
        d.editor_for = None;
    }

    fn live_leave_project(&mut self, cx: &mut Context<Self>) {
        self.live_reset_project_view();
        self.live_docs.project = None;
        self.live_docs.notice = None;
        self.live_docs.projects.close();
        self.live_docs._poll = Task::ready(());
        self.live_reload_list();
        cx.notify();
    }

    /// Outside edits: Electron's fs.watch, here a two-second look at the
    /// tree and every open tab.
    fn live_start_watch(&mut self, cx: &mut Context<Self>) {
        self.live_docs._poll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let alive = this
                    .update(cx, |this, cx| {
                        if this.live_docs.project.is_none() {
                            return false;
                        }
                        this.live_check_outside(cx);
                        true
                    })
                    .unwrap_or(false);
                if !alive {
                    break;
                }
            }
        });
    }

    fn live_check_outside(&mut self, cx: &mut Context<Self>) {
        let d = &mut self.live_docs;
        let mut changed = false;
        if let Ok((entries, truncated)) = d.projects.tree() {
            if entries != d.entries || truncated != d.truncated {
                d.entries = entries;
                d.truncated = truncated;
                changed = true;
            }
        }
        let paths: Vec<String> = d.tabs.tabs.iter().map(|t| t.path.clone()).collect();
        let root = d.projects.open_root().map(PathBuf::from);
        d.stamps.retain(|k, _| paths.contains(k));
        for path in paths {
            let stamp = root.as_ref().and_then(|r| std::fs::symlink_metadata(r.join(&path)).ok()).map(|m| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len()));
            if d.stamps.get(&path) == Some(&stamp) {
                continue;
            }
            d.stamps.insert(path.clone(), stamp);
            let before = d.tabs.tabs.iter().find(|t| t.path == path).cloned();
            match d.projects.read(&path) {
                Ok(file) => d.tabs.disk_read(&path, file.text, file.revision),
                Err(r) if matches!(r.code, "missing" | "not-a-file" | "symlink") => d.tabs.disk_missing(&path),
                Err(_) => {}
            }
            if d.tabs.tabs.iter().find(|t| t.path == path).cloned() != before {
                changed = true;
                if d.editor_for.as_deref() == Some(path.as_str()) {
                    // The editor shows the reloaded text on the next frame.
                    d.editor_for = None;
                }
            }
        }
        if changed {
            cx.notify();
        }
    }

    fn live_open_file(&mut self, path: &str, cx: &mut Context<Self>) {
        if self.live_docs.tabs.tabs.iter().any(|t| t.path == path) {
            self.live_docs.tabs.active = Some(path.to_string());
            cx.notify();
            return;
        }
        match self.live_docs.projects.read(path) {
            Ok(file) => {
                self.live_docs.notice = None;
                self.live_docs.tabs.opened(path, file.text, file.revision);
            }
            Err(r) => self.live_docs.notice = Some(format!("{}: {}", base_name(path), refusal(&r))),
        }
        cx.notify();
    }

    /// ⌘S while the page shows.
    pub(super) fn live_save(&mut self, cx: &mut Context<Self>) {
        let d = &mut self.live_docs;
        let Some(active) = d.tabs.active.clone() else { return };
        let Some(tab) = d.tabs.get_mut(&active) else { return };
        if tab.saving || !tab.dirty() {
            return;
        }
        let (text, base) = (tab.text.clone(), tab.revision.clone());
        match d.projects.write(&active, &text, &base) {
            Ok((revision, _)) => {
                let tab = d.tabs.get_mut(&active).expect("tab");
                tab.saved_text = text;
                tab.revision = revision;
                tab.disk = None;
                tab.error = None;
            }
            Err(r) => {
                let conflict = r.code == "conflict";
                let message = if r.message.is_empty() { format!("{} was not saved.", base_name(&active)) } else { r.message.clone() };
                d.tabs.get_mut(&active).expect("tab").error = Some(message);
                if conflict {
                    if let Ok(file) = d.projects.read(&active) {
                        d.tabs.disk_read(&active, file.text, file.revision);
                    }
                }
            }
        }
        cx.notify();
    }

    fn live_request_close_tab(&mut self, path: String, cx: &mut Context<Self>) {
        let dirty = self.live_docs.tabs.tabs.iter().find(|t| t.path == path).is_some_and(Tab::dirty);
        if dirty {
            self.live_docs.confirm = Some(Confirm {
                title: format!("Close {} without saving?", base_name(&path)),
                body: "Your changes to this file will be lost.".into(),
                label: "Close without saving",
                action: ConfirmAction::CloseTab(path),
            });
        } else {
            self.live_docs.tabs.close(&path);
        }
        cx.notify();
    }

    fn live_request_leave(&mut self, cx: &mut Context<Self>) {
        let dirty = self.live_docs.dirty_count();
        if dirty == 0 {
            return self.live_leave_project(cx);
        }
        let name = self.live_docs.project.as_ref().map_or("this project".to_string(), |p| p.name.clone());
        self.live_docs.confirm = Some(Confirm {
            title: format!("Close {name}?"),
            body: format!("{} unsaved changes. Closing the project discards them.", plural(dirty, "file has", "files have")),
            label: "Discard and close",
            action: ConfirmAction::LeaveProject,
        });
        cx.notify();
    }

    fn live_confirm(&mut self, cx: &mut Context<Self>) {
        let Some(confirm) = self.live_docs.confirm.take() else { return };
        match confirm.action {
            ConfirmAction::Remove(id) => {
                if let Err(r) = self.live_docs.projects.remove(&id) {
                    self.live_docs.notice = Some(refusal(&r));
                }
                self.live_reload_list();
            }
            ConfirmAction::LeaveProject => self.live_leave_project(cx),
            ConfirmAction::CloseTab(path) => self.live_docs.tabs.close(&path),
        }
        cx.notify();
    }

    /// The one editor, holding the active tab's text.
    fn live_sync_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(active) = self.live_docs.tabs.active_tab().map(|t| (t.path.clone(), t.text.clone())) else { return };
        if self.live_docs.editor.is_none() {
            let editor = cx.new(|cx| EditorState::new(window, cx).soft_wrap(true).searchable(true));
            let sub = cx.subscribe(&editor, |this, state, ev: &InputEvent, cx| {
                if !matches!(ev, InputEvent::Change) {
                    return;
                }
                let text = state.read(cx).value().to_string();
                let d = &mut this.live_docs;
                if let Some(path) = d.editor_for.clone() {
                    if let Some(tab) = d.tabs.get_mut(&path) {
                        if tab.text != text {
                            tab.text = text;
                            tab.error = None;
                            cx.notify();
                        }
                    }
                }
            });
            self.live_docs.editor = Some(editor);
            self.live_docs._editor_sub = Some(sub);
        }
        if self.live_docs.editor_for.as_deref() != Some(active.0.as_str()) {
            let markdown = edits_as_markdown(&active.0);
            if let Some(editor) = &self.live_docs.editor {
                editor.update(cx, |s, cx| {
                    s.set_highlighter(if markdown { "markdown" } else { "text" }, cx);
                    s.set_value(active.1, window, cx);
                });
            }
            self.live_docs.editor_for = Some(active.0);
        }
    }

    // ------------------------------------------------------------ preview

    /// Palette: "Open Darkmown project preview…".
    pub(super) fn open_live_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Preview".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let Some(path) = rx.await.ok().and_then(|r| r.ok()).flatten().and_then(|p| p.into_iter().next()) else { return };
            this.update(cx, |this, cx| this.live_preview_choose(path, cx)).ok();
        })
        .detach();
    }

    fn live_preview_choose(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        self.live_preview_stop();
        let attempt = self.live_docs.preview.as_ref().map_or(0, |p| p.attempt + 1);
        let mut preview = Preview {
            name: "Darkmown project".into(),
            root: None,
            phase: Phase::Rejected,
            message: None,
            log: Vec::new(),
            url: None,
            node: None,
            server: None,
            island: None,
            bounds: Rc::new(Cell::new(None)),
            attempt,
        };
        match check_project_folder(&path, &markie_core::paths::home_dir()) {
            Ok(checked) => {
                preview.name = checked.name;
                preview.root = Some(checked.root);
                preview.phase = Phase::Starting;
            }
            Err((_, message)) => preview.message = Some(message),
        }
        let start = preview.root.clone();
        self.live_docs.preview = Some(preview);
        if let Some(root) = start {
            self.live_preview_start(root, attempt, cx);
        }
        cx.notify();
    }

    fn live_preview_start(&mut self, root: PathBuf, attempt: u64, cx: &mut Context<Self>) {
        let task = cx.background_spawn(async move { DevServer::start(&root, Duration::from_secs(30)) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                let Some(p) = this.live_docs.preview.as_mut().filter(|p| p.attempt == attempt) else {
                    // The panel closed or moved on: stop what started.
                    if let Ok(mut server) = result {
                        std::thread::spawn(move || server.stop());
                    }
                    return;
                };
                match result {
                    Ok(server) => {
                        p.url = Some(server.origin.clone());
                        p.node = Some(server.node.version.clone());
                        p.phase = Phase::Ready;
                        p.server = Some(Arc::new(Mutex::new(server)));
                    }
                    Err((_, message, log)) => {
                        p.phase = Phase::Error;
                        p.message = Some(message);
                        p.log = log;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn live_preview_retry(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.live_docs.preview.as_ref().and_then(|p| p.root.clone()) else { return };
        self.live_preview_choose(root, cx);
    }

    fn live_preview_stop(&mut self) {
        let Some(p) = self.live_docs.preview.as_mut() else { return };
        if let Some(island) = p.island.take() {
            let _ = island.set_visible(false);
        }
        if let Some(server) = p.server.take() {
            std::thread::spawn(move || {
                if let Ok(mut s) = server.lock() {
                    s.stop();
                }
            });
        }
    }

    pub(super) fn close_live_preview(&mut self, cx: &mut Context<Self>) {
        self.live_preview_stop();
        self.live_docs.preview = None;
        cx.notify();
    }

    /// Before each render: the native view goes where the panel body is, and
    /// shows only when the site is ready and nothing GPUI draws is over it.
    pub(super) fn sync_live_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let covered = self.web_views_covered(window, cx);
        if self.live_docs_open() {
            self.live_sync_editor(window, cx);
        }
        let Some(p) = self.live_docs.preview.as_mut() else { return };
        if p.phase != Phase::Ready {
            return;
        }
        if p.island.is_none() {
            let Some(url) = p.url.clone() else { return };
            let start = p.bounds.get().map(island_bounds).unwrap_or(IslandBounds { x: 0.0, y: 0.0, width: 1.0, height: 1.0 });
            match SitePreview::new(window, start, &url) {
                Ok(island) => p.island = Some(Rc::new(island)),
                Err(e) => {
                    p.phase = Phase::Error;
                    p.message = Some(format!("The preview could not start: {e}"));
                    return;
                }
            }
        }
        if let Some(island) = &p.island {
            let _ = island.set_visible(!covered && p.bounds.get().is_some());
        }
    }

    pub(super) fn render_live_preview(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = self.live_docs.preview.as_ref()?;
        let pal = themes::palette(cx);
        let status = match p.phase {
            Phase::Ready => [p.url.clone(), p.node.as_ref().map(|v| format!("Node {v}"))].into_iter().flatten().collect::<Vec<_>>().join(" · "),
            Phase::Starting => "Starting darkmown dev…".into(),
            Phase::Rejected => "Not a Darkmown project".into(),
            Phase::Error => "Not running".into(),
        };
        let bounds = p.bounds.clone();
        let island = p.island.clone();
        let ready = p.phase == Phase::Ready;
        let body: AnyElement = if ready {
            canvas(
                move |b, _, _| {
                    bounds.set(Some(b));
                    if let Some(island) = &island {
                        let _ = island.set_bounds(island_bounds(b));
                    }
                },
                |_, _, _, _| {},
            )
            .size_full()
            .into_any_element()
        } else {
            p.bounds.set(None);
            v_flex()
                .id("live-preview-body")
                .size_full()
                .gap(px(12.))
                .overflow_y_scroll()
                .p(px(24.))
                .text_size(px(13.))
                .when(p.phase == Phase::Starting, |d| d.child(div().text_color(pal.muted).child("Starting the project\u{2019}s own darkmown dev with your Node…")))
                .when(matches!(p.phase, Phase::Rejected | Phase::Error), |d| {
                    d.child(div().text_color(pal.foreground).child(p.message.clone().unwrap_or_else(|| "The preview stopped.".into())))
                })
                .when(!p.log.is_empty(), |d| {
                    d.child(
                        div()
                            .max_h(px(320.))
                            .rounded(px(6.))
                            .border_1()
                            .border_color(pal.border)
                            .bg(pal.surface)
                            .p(px(12.))
                            .text_size(px(11.5))
                            .text_color(pal.muted)
                            .font_family(markie_editor::MONO)
                            .child(p.log.join("\n")),
                    )
                })
                .into_any_element()
        };
        let error = p.phase == Phase::Error;
        Some(
            div()
                .id("live-preview-layer")
                .absolute()
                .left(px(12.))
                .right(px(12.))
                .bottom(px(12.))
                .top(px(48.))
                .occlude()
                .child(
                    v_flex()
                        .size_full()
                        .overflow_hidden()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(pal.border)
                        .bg(pal.surface2)
                        .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.28), offset: point(px(0.), px(18.)), blur_radius: px(48.), spread_radius: px(0.), inset: false }])
                        .child(
                            h_flex()
                                .h(px(40.))
                                .flex_none()
                                .gap(px(12.))
                                .px(px(12.))
                                .border_b_1()
                                .border_color(pal.border)
                                .child(div().text_size(px(10.)).font_weight(FontWeight::SEMIBOLD).text_color(pal.muted).child("PREVIEW"))
                                .child(div().min_w_0().truncate().text_size(px(13.)).text_color(pal.foreground).child(p.name.clone()))
                                .child(div().min_w_0().truncate().text_size(px(12.)).text_color(pal.muted).child(status))
                                .child(div().flex_1())
                                .when(error, |d| d.child(button("live-preview-retry", "Try again", &pal).on_click(cx.listener(|this, _, _, cx| this.live_preview_retry(cx)))))
                                .child(button("live-preview-choose", "Choose folder…", &pal).on_click(cx.listener(|this, _, window, cx| this.open_live_preview(window, cx))))
                                .child(
                                    div()
                                        .id("live-preview-close")
                                        .size(px(24.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(6.))
                                        .text_size(px(15.))
                                        .text_color(pal.muted)
                                        .cursor_pointer()
                                        .hover(|s| s.text_color(pal.foreground))
                                        .child("×")
                                        .on_click(cx.listener(|this, _, _, cx| this.close_live_preview(cx))),
                                ),
                        )
                        .child(div().relative().flex_1().min_h_0().bg(pal.background).child(body)),
                )
                .into_any_element(),
        )
    }

    // ------------------------------------------------------------ the page

    pub(super) fn render_live_docs(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = themes::palette(cx);
        let d = &self.live_docs;
        let notice = d.notice.clone().map(|n| {
            h_flex()
                .items_start()
                .gap(px(12.))
                .border_b_1()
                .border_color(p.border)
                .bg(p.surface)
                .px(px(12.))
                .py(px(8.))
                .text_size(px(12.5))
                .text_color(p.foreground)
                .child(div().flex_1().child(n))
                .child(button("live-notice-dismiss", "Dismiss", &p).on_click(cx.listener(|this, _, _, cx| {
                    this.live_docs.notice = None;
                    cx.notify();
                })))
        });
        let page = match &d.project {
            None => self.render_live_home(&p, cx),
            Some(project) => self.render_live_project(project, &p, cx),
        };
        div()
            .relative()
            .size_full()
            .bg(p.background)
            .child(v_flex().size_full().children(notice).child(div().flex_1().min_h_0().child(page)))
            .children(d.confirm.clone().map(|c| self.render_live_confirm(c, &p, cx)))
            .into_any_element()
    }

    fn render_live_home(&self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.live_docs;
        let list = d.list.clone();
        let rows: AnyElement = match list {
            None => div().mt(px(24.)).text_size(px(12.5)).text_color(p.muted).child("Loading…").into_any_element(),
            Some(entries) if entries.is_empty() => div()
                .mt(px(8.))
                .rounded(px(12.))
                .border_1()
                .border_dashed()
                .border_color(p.border)
                .px(px(16.))
                .py(px(20.))
                .text_size(px(12.5))
                .text_color(p.muted)
                .child("No projects yet. Add a Darkmown project folder: one with site/pages, or a package.json that depends on @zvndev/darkmown.")
                .into_any_element(),
            Some(entries) => v_flex()
                .mt(px(8.))
                .gap(px(8.))
                .children(entries.into_iter().enumerate().map(|(i, entry)| {
                    let (open, remove) = (entry.clone(), entry.clone());
                    let hover = p.foreground.opacity(0.22);
                    h_flex()
                        .id(("live-project", i))
                        .gap(px(12.))
                        .rounded(px(12.))
                        .border_1()
                        .border_color(p.border.opacity(0.75))
                        .bg(p.background.opacity(0.35))
                        .px(px(12.))
                        .py(px(10.))
                        .hover(move |s| s.border_color(hover))
                        .child(
                            v_flex()
                                .id(("live-project-open", i))
                                .flex_1()
                                .min_w_0()
                                .cursor_pointer()
                                .child(div().truncate().text_size(px(13.5)).font_weight(FontWeight::SEMIBOLD).text_color(p.foreground).child(entry.name.clone()))
                                .child(
                                    div()
                                        .mt(px(2.))
                                        .truncate()
                                        .text_size(px(11.5))
                                        .text_color(p.muted)
                                        .child(format!("{}{}", entry.location, if entry.available { "" } else { " · Folder not found" })),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| this.live_open_project(&open, cx))),
                        )
                        .child(button(("live-project-remove", i), "Remove", p).on_click(cx.listener(move |this, _, _, cx| {
                            this.live_docs.confirm = Some(Confirm {
                                title: format!("Remove {} from Live Docs?", remove.name),
                                body: "The folder and its files stay where they are. You can add it again at any time.".into(),
                                label: "Remove",
                                action: ConfirmAction::Remove(remove.id.clone()),
                            });
                            cx.notify();
                        })))
                }))
                .into_any_element(),
        };
        div()
            .id("live-home")
            .size_full()
            .overflow_y_scroll()
            .child(
                h_flex().w_full().justify_center().child(
                    v_flex()
                        .w_full()
                        .max_w(px(760.))
                        .px(px(24.))
                        .py(px(32.))
                        .child(
                            h_flex()
                                .items_start()
                                .justify_between()
                                .gap(px(16.))
                                .child(
                                    v_flex()
                                        .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).text_color(p.foreground).child("Live Docs"))
                                        .child(div().mt(px(4.)).text_size(px(12.5)).text_color(p.muted).child("Darkmown projects you are building. Open one to edit its pages, skins and scripts.")),
                                )
                                .child(
                                    button("live-add", "Add Project…", p)
                                        .when(d.busy, |b| b.opacity(0.4))
                                        .on_click(cx.listener(|this, _, window, cx| this.live_add_project(window, cx))),
                                ),
                        )
                        .child(div().mt(px(24.)).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(p.muted).child("ON THIS MAC"))
                        .child(rows),
                ),
            )
            .into_any_element()
    }

    fn render_live_tree(&self, nodes: &[TreeNode], depth: usize, p: &Palette, cx: &mut Context<Self>, out: &mut Vec<AnyElement>) {
        let d = &self.live_docs;
        for node in nodes {
            let guides = h_flex().h_full().flex_none().children((0..depth).map(|_| {
                div().w(px(12.)).h_full().flex_none().child(div().ml(px(6.)).h_full().border_l_1().border_color(p.border))
            }));
            let row = |id: SharedString| {
                h_flex().id(id).w_full().h(px(24.)).pl(px(4.)).pr(px(8.)).gap(px(4.)).text_size(px(12.)).child(guides)
            };
            let id = SharedString::from(format!("live-node-{}", node.path));
            match node.kind {
                TreeKind::Dir => {
                    let open = d.expanded.contains(&node.path);
                    let path = node.path.clone();
                    out.push(
                        row(id)
                            .cursor_pointer()
                            .hover(|s| s.bg(p.accent.opacity(0.3)))
                            .child(div().w(px(12.)).flex_none().text_color(p.muted).child(if open { "▾" } else { "▸" }))
                            .child(div().flex_1().min_w_0().truncate().text_color(p.fg(0.9)).child(node.name.clone()))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.live_docs.expanded.remove(&path) {
                                    this.live_docs.expanded.insert(path.clone());
                                }
                                cx.notify();
                            }))
                            .into_any_element(),
                    );
                    if open {
                        self.render_live_tree(&node.children, depth + 1, p, cx, out);
                    }
                }
                TreeKind::Link => out.push(
                    row(id)
                        .text_color(p.muted)
                        .child(div().w(px(12.)).flex_none())
                        .child(div().flex_1().min_w_0().truncate().italic().child(node.name.clone()))
                        .child(div().flex_none().text_size(px(10.)).child("link"))
                        .into_any_element(),
                ),
                TreeKind::File => {
                    let current = d.tabs.active.as_deref() == Some(node.path.as_str());
                    let dirty = d.tabs.tabs.iter().any(|t| t.path == node.path && t.dirty());
                    let path = node.path.clone();
                    out.push(
                        row(id)
                            .cursor_pointer()
                            .when(current, |r| r.bg(p.accent.opacity(0.4)))
                            .hover(|s| s.bg(p.accent.opacity(0.3)))
                            .child(div().w(px(12.)).flex_none())
                            .child(div().flex_1().min_w_0().truncate().child(node.name.clone()))
                            .when(dirty, |r| r.child(div().flex_none().text_size(px(10.)).text_color(p.blue).child("●")))
                            .on_click(cx.listener(move |this, _, _, cx| this.live_open_file(&path, cx)))
                            .into_any_element(),
                    );
                }
            }
        }
    }

    fn render_live_project(&self, project: &OpenProject, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.live_docs;
        let tree = build_project_tree(&d.entries);
        let mut tree_rows = Vec::new();
        self.render_live_tree(&tree, 0, p, cx, &mut tree_rows);
        let active = d.tabs.active_tab().cloned();
        let strip = |text: String| {
            h_flex().flex_wrap().gap(px(8.)).border_b_1().border_color(p.border).bg(p.surface).px(px(12.)).py(px(8.)).text_size(px(12.5)).text_color(p.foreground).child(div().flex_1().child(text))
        };
        let banner: Option<AnyElement> = active.as_ref().and_then(|tab| {
            let name = base_name(&tab.path).to_string();
            let path = tab.path.clone();
            match &tab.disk {
                Some(Disk::Changed { .. }) => {
                    let (a, b) = (path.clone(), path);
                    Some(
                        strip(format!("{name} changed outside Markie, and you have unsaved changes."))
                            .child(button("live-reload", "Reload from disk", p).on_click(cx.listener(move |this, _, _, cx| {
                                this.live_docs.tabs.reload(&a);
                                this.live_docs.editor_for = None;
                                cx.notify();
                            })))
                            .child(button("live-keep", "Keep my version", p).on_click(cx.listener(move |this, _, _, cx| {
                                this.live_docs.tabs.keep_mine(&b);
                                cx.notify();
                            })))
                            .into_any_element(),
                    )
                }
                Some(Disk::Deleted) => Some(
                    strip(format!("{name} was deleted or renamed outside Markie. Its text stays here until you close the tab."))
                        .child(button("live-dismiss", "Dismiss", p).on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(t) = this.live_docs.tabs.get_mut(&path) {
                                t.disk = None;
                            }
                            cx.notify();
                        })))
                        .into_any_element(),
                ),
                None => tab.error.clone().map(|e| strip(e).into_any_element()),
            }
        });
        let tabs_row = (!d.tabs.tabs.is_empty()).then(|| {
            h_flex()
                .id("live-tabs")
                .h(px(32.))
                .flex_none()
                .overflow_x_scroll()
                .border_b_1()
                .border_color(p.border)
                .bg(p.surface)
                .children(d.tabs.tabs.iter().enumerate().map(|(i, tab)| {
                    let selected = d.tabs.active.as_deref() == Some(tab.path.as_str());
                    let (activate, close) = (tab.path.clone(), tab.path.clone());
                    let fg = p.foreground;
                    h_flex()
                        .flex_none()
                        .h_full()
                        .border_r_1()
                        .border_color(p.border)
                        .when(selected, |t| t.bg(p.background).text_color(p.foreground))
                        .when(!selected, |t| t.text_color(p.muted))
                        .child(
                            h_flex()
                                .id(("live-tab", i))
                                .h_full()
                                .pl(px(12.))
                                .pr(px(4.))
                                .text_size(px(12.))
                                .cursor_pointer()
                                .hover(move |s| s.text_color(fg))
                                .child(base_name(&tab.path).to_string())
                                .when(tab.dirty(), |t| t.child(div().ml(px(6.)).text_color(p.blue).child("●")))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.live_docs.tabs.active = Some(activate.clone());
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id(("live-tab-close", i))
                                .px(px(6.))
                                .text_size(px(13.))
                                .text_color(p.muted)
                                .cursor_pointer()
                                .hover(move |s| s.text_color(fg))
                                .child("×")
                                .on_click(cx.listener(move |this, _, _, cx| this.live_request_close_tab(close.clone(), cx))),
                        )
                }))
        });
        let editor: AnyElement = match (&active, &d.editor) {
            (Some(_), Some(editor)) => Editor::new(editor).bordered(false).h_full().font_family(markie_editor::MONO).text_size(px(13.)).into_any_element(),
            _ => div().size_full().flex().items_center().justify_center().p(px(24.)).text_size(px(12.5)).text_color(p.muted).child("Choose a file in the tree to edit it.").into_any_element(),
        };
        let footer = h_flex()
            .h(px(24.))
            .flex_none()
            .gap(px(12.))
            .border_t_1()
            .border_color(p.border)
            .px(px(12.))
            .text_size(px(11.))
            .text_color(p.muted)
            .when_some(active.clone(), |f, tab| {
                f.child(div().min_w_0().truncate().child(tab.path.clone())).child(div().flex_1()).child(if tab.saving {
                    "Saving…"
                } else if tab.dirty() {
                    "Unsaved · ⌘S saves"
                } else {
                    "Saved"
                })
            });
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .h(px(40.))
                    .flex_none()
                    .gap(px(8.))
                    .border_b_1()
                    .border_color(p.border)
                    .px(px(12.))
                    .child(button("live-back", "← Live Docs", p).on_click(cx.listener(|this, _, _, cx| this.live_request_leave(cx))))
                    .child(div().truncate().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(p.foreground).child(project.name.clone()))
                    .child(div().min_w_0().truncate().text_size(px(11.5)).text_color(p.muted).child(project.location.clone()))
                    .child(div().flex_1())
                    .child(div().flex_none().text_size(px(11.)).text_color(p.muted).child("Watching for outside changes")),
            )
            .children(d.tabs.refused.clone().map(|r| strip(format!("Every open tab has unsaved changes. Save or close one to open {}.", base_name(&r)))))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        v_flex()
                            .id("live-tree")
                            .w(px(240.))
                            .flex_none()
                            .h_full()
                            .overflow_y_scroll()
                            .border_r_1()
                            .border_color(p.border)
                            .bg(p.surface)
                            .py(px(4.))
                            .children(tree_rows)
                            .when(d.truncated, |t| t.child(div().px(px(8.)).py(px(4.)).text_size(px(11.)).text_color(p.muted).child("This project has more files than the tree shows."))),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .children(tabs_row)
                            .children(banner)
                            .child(div().flex_1().min_h_0().child(editor))
                            .child(footer),
                    ),
            )
            .into_any_element()
    }

    fn render_live_confirm(&self, c: Confirm, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("live-confirm-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .p(px(16.))
            .bg(p.background.opacity(0.72))
            .occlude()
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| {
                this.live_docs.confirm = None;
                cx.notify();
            }))
            .child(
                v_flex()
                    .w(px(440.))
                    .rounded(px(14.))
                    .border_1()
                    .border_color(p.border)
                    .bg(p.surface2)
                    .p(px(20.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(p.foreground).child(c.title))
                    .child(div().mt(px(8.)).text_size(px(12.5)).text_color(p.muted).child(c.body))
                    .child(
                        h_flex()
                            .mt(px(16.))
                            .justify_end()
                            .gap(px(8.))
                            .child(button("live-confirm-cancel", "Cancel", p).on_click(cx.listener(|this, _, _, cx| {
                                this.live_docs.confirm = None;
                                cx.notify();
                            })))
                            .child(button("live-confirm-ok", c.label, p).on_click(cx.listener(|this, _, _, cx| this.live_confirm(cx)))),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{Disk, MAX_TABS, Tabs, TreeKind, base_name, build_project_tree, edits_as_markdown, initially_expanded, natural_cmp};

    fn e(path: &str, kind: TreeKind) -> (String, TreeKind) {
        (path.to_string(), kind)
    }

    #[test]
    fn tree_puts_folders_first_in_natural_order() {
        let tree = build_project_tree(&[
            e("site", TreeKind::Dir),
            e("site/pages", TreeKind::Dir),
            e("site/pages/p10.wd", TreeKind::File),
            e("site/pages/p2.wd", TreeKind::File),
            e("README.md", TreeKind::File),
            e("lib", TreeKind::Dir),
            e("link", TreeKind::Link),
        ]);
        let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["lib", "site", "link", "README.md"]);
        let pages = &tree[1].children[0];
        assert_eq!(pages.path, "site/pages");
        let files: Vec<&str> = pages.children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(files, ["p2.wd", "p10.wd"]);
        assert!(natural_cmp("a2", "a10").is_lt());
    }

    #[test]
    fn opens_the_way_down_to_the_pages() {
        let entries = [e("site", TreeKind::Dir), e("site/pages", TreeKind::Dir), e("x", TreeKind::Dir)];
        assert_eq!(initially_expanded(&entries).len(), 2);
        assert!(initially_expanded(&[e("other", TreeKind::Dir)]).is_empty());
    }

    #[test]
    fn names_and_grammars() {
        assert_eq!(base_name("site/pages/a.wd"), "a.wd");
        assert!(edits_as_markdown("a.WD"));
        assert!(!edits_as_markdown("theme.skin"));
    }

    #[test]
    fn tabs_open_close_and_evict_like_electron() {
        let mut t = Tabs::default();
        t.opened("a", "1".into(), "r1".into());
        t.opened("b", "2".into(), "r2".into());
        assert_eq!(t.active.as_deref(), Some("b"));
        t.close("b");
        assert_eq!(t.active.as_deref(), Some("a"));
        for i in 0..MAX_TABS {
            t.opened(&format!("f{i}"), String::new(), String::new());
        }
        assert_eq!(t.tabs.len(), MAX_TABS);
        assert!(!t.tabs.iter().any(|x| x.path == "a"), "a clean tab was evicted");
        for tab in &mut t.tabs {
            tab.text = "edited".into();
        }
        t.opened("z", String::new(), String::new());
        assert_eq!(t.refused.as_deref(), Some("z"));
    }

    #[test]
    fn outside_changes_reload_clean_tabs_and_ask_for_dirty_ones() {
        let mut t = Tabs::default();
        t.opened("a", "one".into(), "r1".into());
        t.disk_read("a", "two".into(), "r2".into());
        assert_eq!(t.tabs[0].text, "two");
        t.tabs[0].text = "mine".into();
        t.disk_read("a", "three".into(), "r3".into());
        assert!(matches!(t.tabs[0].disk, Some(Disk::Changed { .. })));
        t.keep_mine("a");
        assert_eq!(t.tabs[0].revision, "r3");
        assert_eq!(t.tabs[0].text, "mine");
        t.disk_missing("a");
        assert_eq!(t.tabs[0].disk, Some(Disk::Deleted));
    }
}
