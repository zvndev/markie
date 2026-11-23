//! Browse: the documents the device index found on this Mac, as a page with
//! a folder tree on the left and the chosen folder's contents on the right.
//!
//! This file holds what the page shows and how it reacts: the pure model
//! ([`build_view`], [`key_effect`], [`status_line`]), the state kept between
//! frames, and the `Workspace` methods the controls call. The drawing is in
//! `browse_page.rs`. The tree itself is still `folder_tree.rs`, the port of
//! Electron's `folder-tree.ts`.
//!
//! Electron's Browse is a 252 px side panel with the files inside the tree.
//! Markie RS differs on purpose (docs/rust-port/AUDIT-LIBRARY-SETTINGS.md,
//! row 3.1): a narrow panel cut names short, lost the place in a deep tree
//! and never said what was listed or when it was last checked.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use gpui_kit::component::input::InputState;
use gpui_kit::*;

use super::super::Workspace;
use super::super::folder_tree::{self as tree, FileEntry, FolderNode};
use super::{BROWSE_OPEN_KEY, LeftView, compact_dir, group_thousands};
use crate::library::{LibraryTab, SortOrder};

// ------------------------------------------------------------------ model

/// One folder in the tree column.
#[derive(Clone, Debug, PartialEq)]
pub(in crate::workspace) struct TreeRow {
    pub path: PathBuf,
    pub label: String,
    /// Documents in the folder and everything below it.
    pub count: usize,
    pub depth: usize,
    pub open: bool,
    /// It has folders of its own, so it gets a chevron.
    pub expandable: bool,
}

/// One row of the contents column.
#[derive(Clone, Debug, PartialEq)]
pub(in crate::workspace) enum PaneRow {
    Folder { path: PathBuf, label: String, count: usize, latest_mtime_ms: f64 },
    /// A document in the chosen folder; `hit` indexes Browse's hit list.
    File { hit: usize },
    /// A filter match somewhere under the chosen folder, drawn with its path.
    Match { hit: usize },
}

/// One step of the breadcrumb. `path` is `None` for the top.
#[derive(Clone, Debug, PartialEq)]
pub(in crate::workspace) struct Crumb {
    pub label: String,
    pub path: Option<PathBuf>,
}

/// A folder whose documents changed lately: a way back to where the work is.
#[derive(Clone, Debug, PartialEq)]
pub(in crate::workspace) struct Shortcut {
    pub path: PathBuf,
    pub label: String,
    /// Where the folder is, shortened.
    pub place: String,
    pub mtime_ms: f64,
}

/// What the page asks of the tree.
pub(in crate::workspace) struct Query<'a> {
    pub home: &'a Path,
    pub open: &'a HashSet<PathBuf>,
    pub closed: &'a HashSet<PathBuf>,
    /// The person opened or closed a folder; until then the tree opens to
    /// its first branching level.
    pub touched: bool,
    pub selected: Option<&'a Path>,
    /// Words are typed in the filter: the contents column lists matches.
    pub typed: bool,
    /// Any filter is on (words, a type, starred only). A chosen folder with
    /// nothing in it is then empty, not gone.
    pub narrowed: bool,
    pub by_updated: bool,
}

/// Everything the page draws, built once per change, never per frame.
#[derive(Clone, Debug, Default)]
pub(in crate::workspace) struct View {
    /// The first tree row: everything. "Home", a folder, or "This Mac".
    pub top_label: String,
    pub top_count: usize,
    pub tree: Vec<TreeRow>,
    pub pane: Vec<PaneRow>,
    pub crumbs: Vec<Crumb>,
    pub shortcuts: Vec<Shortcut>,
    /// The folder on show, as resolved against today's tree. `None` is the top.
    pub selected: Option<PathBuf>,
    /// The chosen folder is no longer there: its name, for the notice.
    pub gone: Option<String>,
    /// Folders and documents directly in the folder on show.
    pub folders_here: usize,
    pub files_here: usize,
    /// The contents column lists filter matches.
    pub matches: bool,
    pub open_now: HashSet<PathBuf>,
    /// A filter holds the tree open to its matches.
    pub forced: bool,
}

/// How many shortcuts the tree column offers.
pub(in crate::workspace) const SHORTCUTS: usize = 4;
/// Shortcuts only help once there are more folders than fit at a glance.
pub(in crate::workspace) const SHORTCUTS_FROM_FOLDERS: usize = 8;

/// A folder as a person names it: `Home`, `~/Notes`, or the full path
/// outside the home folder.
pub(in crate::workspace) fn place_label(dir: &Path, home: &Path) -> String {
    match dir.strip_prefix(home) {
        Ok(rel) if rel.as_os_str().is_empty() => "Home".into(),
        Ok(rel) => format!("~/{}", rel.display()),
        Err(_) => dir.display().to_string(),
    }
}

/// The nodes from a root down to `target`, and whether it was found. When it
/// was not, the chain ends at the nearest folder above it that is there.
fn chain_to<'a>(nodes: &'a [FolderNode], target: &Path) -> (Vec<&'a FolderNode>, bool) {
    let mut chain = Vec::new();
    let mut level = nodes;
    loop {
        let Some(node) = level.iter().find(|n| n.path == target || tree::is_under(target, &n.path)) else { return (chain, false) };
        chain.push(node);
        if node.path == target {
            return (chain, true);
        }
        level = &node.children;
    }
}

/// Strictly inside the home folder.
fn nodes_in_home(path: &Path, home: &Path) -> bool {
    tree::is_under(path, home)
}

fn last_segment(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

fn hits_below(node: &FolderNode, out: &mut Vec<usize>) {
    out.extend(node.files.iter().map(|f| f.hit));
    node.children.iter().for_each(|c| hits_below(c, out));
}

fn flatten(children: &[FolderNode], depth: usize, open: &HashSet<PathBuf>, rows: &mut Vec<TreeRow>) {
    for node in children {
        let is_open = open.contains(&node.path) && !node.children.is_empty();
        rows.push(TreeRow {
            path: node.path.clone(),
            label: node.label.clone(),
            count: node.total,
            depth,
            open: is_open,
            expandable: !node.children.is_empty(),
        });
        if is_open {
            flatten(&node.children, depth + 1, open, rows);
        }
    }
}

fn shortcuts(nodes: &[FolderNode], home: &Path) -> Vec<Shortcut> {
    fn collect<'a>(node: &'a FolderNode, out: &mut Vec<(&'a FolderNode, f64)>) {
        if let Some(latest) = node.files.iter().map(|f| f.mtime_ms).reduce(f64::max) {
            out.push((node, latest));
        }
        node.children.iter().for_each(|c| collect(c, out));
    }
    let mut all = Vec::new();
    nodes.iter().for_each(|n| collect(n, &mut all));
    if all.len() < SHORTCUTS_FROM_FOLDERS {
        return Vec::new();
    }
    all.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.path.cmp(&b.0.path)));
    all.into_iter()
        .take(SHORTCUTS)
        .map(|(node, mtime_ms)| Shortcut {
            path: node.path.clone(),
            label: if node.path == home { "Home".into() } else { last_segment(&node.path) },
            place: node.path.parent().filter(|_| node.path != home).map(|p| compact_dir(p, home, 2)).unwrap_or_default(),
            mtime_ms,
        })
        .collect()
}

/// Build the page from Browse's hits (`entries`, in hit order).
pub(in crate::workspace) fn build_view(entries: Vec<FileEntry>, q: &Query) -> View {
    let mut nodes = tree::build_folder_tree(entries);
    if q.by_updated {
        tree::sort_by_updated(&mut nodes);
    }
    // The top stays the same place whatever a filter leaves in the tree:
    // "Home" while every document is in the home folder, "This Mac" once
    // some are elsewhere. A root that is the home folder is the top itself;
    // any other root prints as a place (`~/Notes`, `/Volumes/Disk`), and
    // every level below is named by its parent.
    let single = nodes.len() == 1 && nodes[0].path == q.home;
    if !single {
        for root in &mut nodes {
            root.label = match root.path.strip_prefix(q.home) {
                Ok(rel) if nodes_in_home(&root.path, q.home) => rel.display().to_string(),
                _ => place_label(&root.path, q.home),
            };
        }
    }
    let in_home = nodes.iter().all(|n| n.path == q.home || nodes_in_home(&n.path, q.home));
    let top_label = if in_home && nodes.len() <= 1 { "Home".to_string() } else { "This Mac".to_string() };
    let top_count = nodes.iter().map(|n| n.total).sum();
    let top_path = single.then(|| nodes[0].path.clone());

    let forced = (q.narrowed && tree::count_nodes(&nodes) <= 200).then(|| tree::paths_to_files(&nodes));
    let open_now = if q.touched { tree::open_with_ancestors(q.open, q.closed, &nodes) } else { tree::initial_open_set(&nodes) };
    let mut tree_rows = Vec::new();
    flatten(if single { &nodes[0].children } else { &nodes }, 0, forced.as_ref().unwrap_or(&open_now), &mut tree_rows);

    // Resolve the chosen folder against the tree as it stands.
    let wanted = q.selected.filter(|s| top_path.as_deref() != Some(*s));
    let (chain, found) = wanted.map_or((Vec::new(), true), |s| chain_to(&nodes, s));
    let mut gone = None;
    let mut missing: Option<&Path> = None;
    if let Some(s) = wanted.filter(|_| !found) {
        if q.narrowed {
            // Still there, as far as anyone knows: nothing in it matches.
            missing = Some(s);
        } else {
            gone = Some(last_segment(s));
        }
    }
    let shown: Option<&FolderNode> = if missing.is_some() { None } else { chain.last().copied().or(single.then(|| &nodes[0])) };
    let selected = match (missing, shown) {
        (Some(s), _) => Some(s.to_path_buf()),
        (None, Some(node)) if top_path.as_deref() != Some(node.path.as_path()) => Some(node.path.clone()),
        _ => None,
    };

    let mut crumbs = vec![Crumb { label: top_label.clone(), path: None }];
    crumbs.extend(chain.iter().filter(|n| top_path.as_deref() != Some(n.path.as_path())).map(|n| Crumb { label: n.label.clone(), path: Some(n.path.clone()) }));
    if let Some(s) = missing {
        let above = chain.last().map(|n| n.path.as_path()).or(top_path.as_deref()).or(Some(q.home));
        let label = above.and_then(|a| s.strip_prefix(a).ok()).map_or_else(|| place_label(s, q.home), |rel| rel.display().to_string());
        crumbs.push(Crumb { label, path: Some(s.to_path_buf()) });
    }

    let (folders, files): (&[FolderNode], &[FileEntry]) = match shown {
        Some(node) => (&node.children, &node.files),
        None if missing.is_some() => (&[], &[]),
        None => (&nodes, &[]),
    };
    let pane = if q.typed {
        let mut hits = Vec::new();
        match shown {
            Some(node) => hits_below(node, &mut hits),
            None if missing.is_some() => {}
            None => nodes.iter().for_each(|n| hits_below(n, &mut hits)),
        }
        // Hit order is the Library's: best match first, or the chosen sort.
        hits.sort_unstable();
        hits.into_iter().map(|hit| PaneRow::Match { hit }).collect()
    } else {
        folders
            .iter()
            .map(|n| PaneRow::Folder { path: n.path.clone(), label: n.label.clone(), count: n.total, latest_mtime_ms: n.latest_mtime_ms })
            .chain(files.iter().map(|f| PaneRow::File { hit: f.hit }))
            .collect()
    };

    View {
        top_label,
        top_count,
        tree: tree_rows,
        crumbs,
        shortcuts: if q.narrowed { Vec::new() } else { shortcuts(&nodes, q.home) },
        selected,
        gone,
        folders_here: folders.len(),
        files_here: files.len(),
        matches: q.typed,
        pane,
        forced: forced.is_some(),
        open_now,
    }
}

/// The breadcrumb as drawn: a long one keeps its first step and its last
/// `tail`, with the middle folded into one "…" step (which leads to the
/// folder just before the tail).
pub(in crate::workspace) fn shown_crumbs(crumbs: &[Crumb], tail: usize) -> Vec<Crumb> {
    if crumbs.len() <= tail + 2 {
        return crumbs.to_vec();
    }
    let cut = crumbs.len() - tail;
    let mut out = vec![crumbs[0].clone(), Crumb { label: "…".into(), path: crumbs[cut - 1].path.clone() }];
    out.extend_from_slice(&crumbs[cut..]);
    out
}

/// What a key does while the page has the keyboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::workspace) enum KeyEffect {
    /// Move the highlight to this row.
    Cursor(usize),
    /// Open the document, or go into the folder, on this row.
    Activate(usize),
    ClearText,
    /// Go to the folder above.
    Parent,
    /// Not the page's key.
    None,
}

/// Type, arrow keys, Return, Escape. `cursor` is the highlighted row, when
/// there is one; with words typed, Return opens the first match.
pub(in crate::workspace) fn key_effect(key: &str, platform: bool, rows: usize, cursor: Option<usize>, typed: bool) -> KeyEffect {
    let last = rows.saturating_sub(1);
    match key {
        "up" if platform => KeyEffect::Parent,
        "down" if rows > 0 => KeyEffect::Cursor(cursor.map_or(0, |c| (c + 1).min(last))),
        "up" if rows > 0 => cursor.map_or(KeyEffect::None, |c| KeyEffect::Cursor(c.min(last).saturating_sub(1))),
        "enter" if rows > 0 => match cursor {
            Some(c) => KeyEffect::Activate(c.min(last)),
            None if typed => KeyEffect::Activate(0),
            None => KeyEffect::None,
        },
        "escape" if typed => KeyEffect::ClearText,
        _ => KeyEffect::None,
    }
}

/// `1 document`, `1,204 documents`.
pub(in crate::workspace) fn counted(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", group_thousands(n), if n == 1 { one } else { many })
}

/// What the index holds and when it was last checked, for the page header.
/// `checked` is the time since the walk, already worded ("20m ago").
pub(in crate::workspace) fn status_line(total: usize, folders: usize, scanning: bool, found: usize, checked: &str) -> String {
    let holds = format!("{} in {}", counted(total, "document", "documents"), counted(folders, "folder", "folders"));
    match (scanning, total) {
        (true, 0) if found > 0 => format!("Looking for documents… {} so far", group_thousands(found)),
        (true, 0) => "Looking for documents…".into(),
        (true, _) => format!("{holds} · Checking for changes…"),
        (false, 0) if checked.is_empty() => "No documents found".into(),
        (false, 0) => format!("No documents found · Checked {checked}"),
        (false, _) if checked.is_empty() => holds,
        (false, _) => format!("{holds} · Checked {checked}"),
    }
}

/// The line beside the breadcrumb: what the folder on show holds.
pub(in crate::workspace) fn pane_summary(view: &View) -> String {
    if view.matches {
        return counted(view.pane.len(), "match", "matches");
    }
    match (view.folders_here, view.files_here) {
        (0, 0) => String::new(),
        (folders, 0) => counted(folders, "folder", "folders"),
        (0, files) => counted(files, "document", "documents"),
        (folders, files) => format!("{}, {}", counted(folders, "folder", "folders"), counted(files, "document", "documents")),
    }
}

// ------------------------------------------------------------------ state

/// What Browse keeps between frames.
pub(in crate::workspace) struct BrowseState {
    pub filter: Entity<InputState>,
    /// Folders the person opened and closed by hand (`OpenedByHand`); until
    /// they touch one, the tree opens to its first branching level.
    pub(super) open: HashSet<PathBuf>,
    pub(super) closed: HashSet<PathBuf>,
    pub(super) touched: bool,
    /// The folder whose contents show. `None` is the top.
    pub(super) selected: Option<PathBuf>,
    /// A chosen folder that vanished: its name, until the person moves on.
    pub(super) gone: Option<String>,
    /// The row the arrow keys are on.
    pub(super) cursor: Option<usize>,
    pub(super) view: Option<Rc<View>>,
    pub(super) tree_scroll: UniformListScrollHandle,
    pub(super) pane_scroll: UniformListScrollHandle,
    /// Documents the running walk has found so far.
    pub found: Arc<AtomicUsize>,
}

impl BrowseState {
    pub(super) fn new(filter: Entity<InputState>) -> Self {
        Self {
            filter,
            open: HashSet::new(),
            closed: HashSet::new(),
            touched: false,
            selected: None,
            gone: None,
            cursor: None,
            view: None,
            tree_scroll: UniformListScrollHandle::new(),
            pane_scroll: UniformListScrollHandle::new(),
            found: Arc::new(AtomicUsize::new(0)),
        }
    }
}

// -------------------------------------------------------------- behaviour

impl Workspace {
    pub(in crate::workspace) fn browse_page_open(&self) -> bool {
        self.shell.panel_open && self.shell.view == LeftView::Browse
    }

    /// The home folder the index was walked from. A scratch data folder
    /// stands in for it, so a test run never names a real folder.
    pub(super) fn browse_home() -> PathBuf {
        super::super::device_scan_options(Vec::new()).home
    }

    fn browse_narrowed(&self) -> bool {
        !self.library.text().trim().is_empty() || self.library.only_format().is_some() || self.library.tab == LibraryTab::Starred
    }

    /// Build the page from the index. Runs only after the index, a filter,
    /// the sort, the chosen folder or an open folder changed, never per frame.
    pub(in crate::workspace) fn ensure_browse_rows(&mut self) {
        if self.shell.browse.view.is_some() || !self.browse_page_open() {
            return;
        }
        let entries: Vec<FileEntry> = self
            .library
            .hits()
            .iter()
            .enumerate()
            .map(|(i, hit)| {
                let doc = self.library.doc(hit);
                FileEntry { hit: i, name: doc.name.clone(), dir: doc.dir.clone(), mtime_ms: doc.mtime_ms }
            })
            .collect();
        let home = Self::browse_home();
        let b = &self.shell.browse;
        let view = build_view(
            entries,
            &Query {
                home: &home,
                open: &b.open,
                closed: &b.closed,
                touched: b.touched,
                selected: b.selected.as_deref(),
                typed: !self.library.text().trim().is_empty(),
                narrowed: self.browse_narrowed(),
                by_updated: self.library.sort == SortOrder::Recent,
            },
        );
        let b = &mut self.shell.browse;
        if view.gone.is_some() {
            b.gone = view.gone.clone();
        }
        b.selected = view.selected.clone();
        b.cursor = b.cursor.filter(|_| !view.pane.is_empty()).map(|c| c.min(view.pane.len().saturating_sub(1)));
        b.view = Some(Rc::new(view));
    }

    /// The filter's words changed.
    pub(super) fn browse_text_changed(&mut self, text: &str, cx: &mut Context<Self>) {
        self.library.set_text(text);
        let b = &mut self.shell.browse;
        // With words typed, Return opens the first match.
        b.cursor = (!text.trim().is_empty()).then_some(0);
        b.pane_scroll.scroll_to_item(0, ScrollStrategy::Top);
        b.view = None;
        cx.notify();
    }

    /// The compass was clicked: typing goes straight to the filter.
    pub(in crate::workspace) fn browse_focus_filter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.browse_page_open() {
            let handle = self.shell.browse.filter.read(cx).focus_handle(cx);
            handle.focus(window, cx);
        }
    }

    /// Show a folder's contents. `None` is the top.
    pub(super) fn browse_select(&mut self, dir: Option<PathBuf>, cx: &mut Context<Self>) {
        let b = &mut self.shell.browse;
        if let Some(dir) = &dir {
            // Opening it in the tree opens the folders above it too
            // (`open_with_ancestors`), so the tree shows where this is.
            let mut open = b.view.as_ref().map(|v| v.open_now.clone()).unwrap_or_default();
            if open.insert(dir.clone()) || !b.touched {
                b.closed.remove(dir);
                b.open = open;
                b.touched = true;
                self.persist_browse_open();
            }
        }
        let b = &mut self.shell.browse;
        b.selected = dir;
        b.gone = None;
        b.cursor = (!self.library.text().trim().is_empty()).then_some(0);
        b.pane_scroll.scroll_to_item(0, ScrollStrategy::Top);
        b.view = None;
        cx.notify();
    }

    /// The folder above the one on show.
    pub(super) fn browse_parent(&mut self, cx: &mut Context<Self>) {
        let Some(view) = self.shell.browse.view.clone() else { return };
        if view.crumbs.len() < 2 {
            return;
        }
        let parent = view.crumbs[view.crumbs.len() - 2].path.clone();
        self.browse_select(parent, cx);
    }

    /// A chevron click (browse-view.tsx `toggle`). While a filter holds the
    /// tree open it does nothing; otherwise what is open now becomes the
    /// remembered set, so a folder opened for a remembered child stays open.
    pub(super) fn toggle_folder(&mut self, dir: PathBuf, cx: &mut Context<Self>) {
        let Some(view) = self.shell.browse.view.clone() else { return };
        if view.forced {
            return;
        }
        let b = &mut self.shell.browse;
        let mut open = view.open_now.clone();
        if open.remove(&dir) {
            b.closed.insert(dir);
        } else {
            b.closed.remove(&dir);
            open.insert(dir);
        }
        b.open = open;
        b.touched = true;
        b.view = None;
        self.persist_browse_open();
        cx.notify();
    }

    fn persist_browse_open(&self) {
        let Some(reg) = &self.registry else { return };
        let list = |set: &HashSet<PathBuf>| set.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>();
        let value = serde_json::json!({ "open": list(&self.shell.browse.open), "closed": list(&self.shell.browse.closed) });
        let _ = reg.set_setting(BROWSE_OPEN_KEY, &value.to_string());
    }

    /// The folders opened by hand in an earlier session.
    pub(in crate::workspace) fn restore_browse_open(&mut self) {
        let Some(raw) = self.registry.as_ref().and_then(|r| r.setting(BROWSE_OPEN_KEY).ok().flatten()) else { return };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
        let set = |key: &str| -> HashSet<PathBuf> {
            value.get(key).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|p| p.as_str().map(PathBuf::from)).collect()).unwrap_or_default()
        };
        self.shell.browse.open = set("open");
        self.shell.browse.closed = set("closed");
        self.shell.browse.touched = true;
    }

    /// Every filter off: words, type and starred only.
    pub(super) fn clear_browse_filters(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.library.set_only_format(None);
        if self.library.tab == LibraryTab::Starred {
            self.library.set_tab(LibraryTab::All);
        }
        self.shell.browse.filter.update(cx, |s, cx| s.set_value("", window, cx));
        self.browse_text_changed("", cx);
    }

    fn browse_clear_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.shell.browse.filter.update(cx, |s, cx| s.set_value("", window, cx));
        self.browse_text_changed("", cx);
    }

    /// A click, or Return, on a contents row.
    pub(super) fn browse_activate(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.shell.browse.view.as_ref().and_then(|v| v.pane.get(index).cloned()) else { return };
        match row {
            PaneRow::Folder { path, .. } => self.browse_select(Some(path), cx),
            PaneRow::File { hit } | PaneRow::Match { hit } => {
                let Some(path) = self.library.hits().get(hit).map(|h| self.library.doc(h).path.clone()) else { return };
                self.open_path(&path, window, cx);
            }
        }
    }

    /// Keys while the page is up: the filter keeps the typing, the arrows and
    /// Return work the contents column, Escape clears the words.
    pub(super) fn browse_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.shell.row_menu.is_some() || self.shell.filter_menu.is_some() {
            return;
        }
        let rows = self.shell.browse.view.as_ref().map_or(0, |v| v.pane.len());
        let typed = !self.library.text().trim().is_empty();
        let k = &event.keystroke;
        if k.modifiers.control || k.modifiers.alt || k.modifiers.shift {
            return;
        }
        match key_effect(k.key.as_str(), k.modifiers.platform, rows, self.shell.browse.cursor, typed) {
            KeyEffect::Cursor(c) => {
                self.shell.browse.cursor = Some(c);
                self.shell.browse.pane_scroll.scroll_to_item(c, ScrollStrategy::Nearest);
            }
            KeyEffect::Activate(c) => self.browse_activate(c, window, cx),
            KeyEffect::ClearText => self.browse_clear_text(window, cx),
            KeyEffect::Parent => self.browse_parent(cx),
            KeyEffect::None => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}

// ------------------------------------------------------------------ scenes

#[cfg(feature = "scene")]
impl Workspace {
    /// Browse over the scratch index (docs/rust-port/SCREEN.md). Args:
    /// `state` (`scanning`, `rescanning`, `empty`, `truncated`, or the
    /// default tree), `filter`, `type` (`markdown`, `docx`), `starred`,
    /// `open` (folders under the scratch home to open by hand), `select` (the
    /// folder on show), `cursor` (the highlighted row).
    pub(in crate::workspace) fn scene_browse(&mut self, args: &serde_json::Value, step: &mut usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        use markie_core::formats::FormatKind;
        use markie_core::index::{IndexSnapshot, Truncation};
        use std::sync::atomic::Ordering;
        if *step > 0 {
            return true;
        }
        if self.library.scanning {
            return false;
        }
        let text = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if !self.browse_page_open() {
            self.select_view(LeftView::Browse, cx);
        }
        // The scratch home is the app's data folder: its own files are not documents.
        let data = markie_core::paths::data_dir();
        let (scanned_at_ms, drafts) = (self.library.scanned_at_ms, data.join("drafts"));
        let files: Vec<_> = self.library.docs().iter().filter(|d| d.dir != data && !d.dir.starts_with(&drafts)).cloned().collect();
        self.library.set_snapshot(IndexSnapshot { files, scanned_at_ms, ..Default::default() });
        match text("state").as_str() {
            "scanning" => {
                self.library.set_snapshot(IndexSnapshot::default());
                self.library.scanning = true;
                self.shell.browse.found.store(214, Ordering::Relaxed);
            }
            "rescanning" => self.library.scanning = true,
            "empty" => {
                let scanned_at_ms = self.library.scanned_at_ms;
                self.library.set_snapshot(IndexSnapshot { scanned_at_ms, ..Default::default() });
            }
            "truncated" => {
                self.library.truncated = true;
                self.library.truncation = Some(Truncation::Time);
            }
            _ => {}
        }
        let home = Self::browse_home();
        if let Some(open) = args.get("open").and_then(|v| v.as_array()) {
            self.shell.browse.open = open.iter().filter_map(|v| v.as_str()).map(|rel| home.join(rel)).collect();
            self.shell.browse.touched = true;
        }
        let select = text("select");
        if !select.is_empty() {
            self.shell.browse.selected = Some(home.join(select));
        }
        match text("type").as_str() {
            "markdown" => self.library.set_only_format(Some(FormatKind::Markdown)),
            "docx" => self.library.set_only_format(Some(FormatKind::Docx)),
            _ => {}
        }
        if args.get("starred").and_then(|v| v.as_bool()).unwrap_or(false) {
            self.library.set_tab(LibraryTab::Starred);
        }
        let filter = text("filter");
        if !filter.is_empty() {
            self.shell.browse.filter.update(cx, |s, cx| s.set_value(filter.clone(), window, cx));
            self.browse_text_changed(&filter, cx);
        }
        if let Some(cursor) = args.get("cursor").and_then(|v| v.as_u64()) {
            self.shell.browse.cursor = Some(cursor as usize);
        }
        self.shell.browse.view = None;
        cx.notify();
        *step = 1;
        false
    }
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    // Named, not `super::*`: that would bring in GPUI's own `test` macro.
    use super::{Crumb, FileEntry, KeyEffect, PaneRow, Query, View, build_view, key_effect, pane_summary, place_label, shown_crumbs, status_line};
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};

    const HOME: &str = "/Users/k";

    fn entries(files: &[(&str, f64)]) -> Vec<FileEntry> {
        files
            .iter()
            .enumerate()
            .map(|(hit, (path, mtime_ms))| {
                let (dir, name) = path.rsplit_once('/').unwrap();
                FileEntry { hit, name: name.into(), dir: PathBuf::from(dir), mtime_ms: *mtime_ms }
            })
            .collect()
    }

    fn library() -> Vec<FileEntry> {
        entries(&[
            ("/Users/k/todo.md", 5.),
            ("/Users/k/Documents/Work/Clients/Acme/Proposal.md", 40.),
            ("/Users/k/Documents/Work/Clients/Acme/Pricing.csv", 10.),
            ("/Users/k/Documents/Work/Clients/Globex/Notes.md", 30.),
            ("/Users/k/Documents/Work/Plan.md", 20.),
            ("/Users/k/Documents/Recipes/Soup.md", 3.),
            ("/Users/k/Projects/atlas/docs/guides/Setup.md", 50.),
        ])
    }

    struct Ask {
        open: HashSet<PathBuf>,
        closed: HashSet<PathBuf>,
        touched: bool,
        selected: Option<PathBuf>,
        typed: bool,
        narrowed: bool,
        by_updated: bool,
    }

    impl Default for Ask {
        fn default() -> Self {
            Self { open: HashSet::new(), closed: HashSet::new(), touched: false, selected: None, typed: false, narrowed: false, by_updated: false }
        }
    }

    fn view(entries: Vec<FileEntry>, ask: &Ask) -> View {
        build_view(
            entries,
            &Query {
                home: Path::new(HOME),
                open: &ask.open,
                closed: &ask.closed,
                touched: ask.touched,
                selected: ask.selected.as_deref(),
                typed: ask.typed,
                narrowed: ask.narrowed,
                by_updated: ask.by_updated,
            },
        )
    }

    fn at(path: &str) -> Ask {
        Ask { selected: Some(PathBuf::from(path)), ..Default::default() }
    }

    fn crumb_labels(v: &View) -> Vec<&str> {
        v.crumbs.iter().map(|c| c.label.as_str()).collect()
    }

    fn pane_labels(v: &View, lib: &[FileEntry]) -> Vec<String> {
        v.pane
            .iter()
            .map(|row| match row {
                PaneRow::Folder { label, count, .. } => format!("{label}/ ({count})"),
                PaneRow::File { hit } => lib[*hit].name.clone(),
                PaneRow::Match { hit } => format!("match {}", lib[*hit].name),
            })
            .collect()
    }

    #[test]
    fn the_top_is_the_home_folder_with_folders_before_documents() {
        let v = view(library(), &Ask::default());
        assert_eq!(v.top_label, "Home");
        assert_eq!(v.top_count, 7);
        assert_eq!(v.selected, None);
        assert_eq!(crumb_labels(&v), ["Home"]);
        assert_eq!(pane_labels(&v, &library()), ["Documents/ (5)", "Projects/atlas/docs/guides/ (1)", "todo.md"]);
        assert_eq!((v.folders_here, v.files_here), (2, 1));
        assert_eq!(pane_summary(&v), "2 folders, 1 document");
    }

    #[test]
    fn the_tree_lists_folders_only_with_their_document_counts() {
        let v = view(library(), &Ask { open: [PathBuf::from("/Users/k/Documents")].into(), touched: true, ..Default::default() });
        let rows: Vec<_> = v.tree.iter().map(|r| (r.label.as_str(), r.count, r.depth, r.open, r.expandable)).collect();
        assert_eq!(
            rows,
            [
                ("Documents", 5, 0, true, true),
                ("Recipes", 1, 1, false, false),
                ("Work", 4, 1, false, true),
                ("Projects/atlas/docs/guides", 1, 0, false, false),
            ]
        );
    }

    #[test]
    fn a_chosen_folder_shows_its_contents_and_the_way_back() {
        let v = view(library(), &at("/Users/k/Documents/Work"));
        assert_eq!(crumb_labels(&v), ["Home", "Documents", "Work"]);
        assert_eq!(v.crumbs[1].path.as_deref(), Some(Path::new("/Users/k/Documents")));
        assert_eq!(pane_labels(&v, &library()), ["Clients/ (3)", "Plan.md"]);
        assert_eq!(v.selected.as_deref(), Some(Path::new("/Users/k/Documents/Work")));
        assert!(v.gone.is_none());
    }

    #[test]
    fn several_roots_sit_under_this_mac() {
        let mut lib = library();
        lib.extend(entries(&[("/Volumes/Disk/Notes/a.md", 1.)]).into_iter().map(|mut e| {
            e.hit = 7;
            e
        }));
        let v = view(lib.clone(), &Ask::default());
        assert_eq!(v.top_label, "This Mac");
        assert_eq!(pane_labels(&v, &lib), ["Home/ (7)", "/Volumes/Disk/Notes/ (1)"]);
        assert_eq!(view(Vec::new(), &Ask::default()).top_label, "Home", "nothing listed is still the home folder");
        let v = view(lib, &at("/Users/k/Documents"));
        assert_eq!(crumb_labels(&v), ["This Mac", "Home", "Documents"]);
    }

    #[test]
    fn a_folder_that_vanished_falls_back_to_the_nearest_one_above() {
        let v = view(library(), &at("/Users/k/Documents/Work/Old drafts"));
        assert_eq!(v.gone.as_deref(), Some("Old drafts"));
        assert_eq!(v.selected.as_deref(), Some(Path::new("/Users/k/Documents/Work")));
        assert_eq!(crumb_labels(&v), ["Home", "Documents", "Work"]);
        // Nothing left above it: the top.
        let v = view(library(), &at("/Users/k/Gone/Deeper"));
        assert_eq!(v.gone.as_deref(), Some("Deeper"));
        assert_eq!(v.selected, None);
        assert_eq!(crumb_labels(&v), ["Home"]);
    }

    #[test]
    fn under_a_filter_a_folder_with_no_match_is_empty_not_gone() {
        // Only the Acme files match; Recipes is chosen.
        let lib = library();
        let matching: Vec<FileEntry> = lib.iter().filter(|e| e.dir.ends_with("Acme")).cloned().collect();
        let ask = Ask { typed: true, narrowed: true, ..at("/Users/k/Documents/Recipes") };
        let v = view(matching, &ask);
        assert!(v.gone.is_none());
        assert!(v.pane.is_empty());
        assert_eq!(v.selected.as_deref(), Some(Path::new("/Users/k/Documents/Recipes")));
        // The matches fold into one root below home: the top is still Home.
        assert_eq!(v.top_label, "Home");
        assert_eq!(v.tree[0].label, "Documents/Work/Clients/Acme");
        assert_eq!(crumb_labels(&v), ["Home", "Documents/Recipes"]);
        assert_eq!(v.crumbs[0].path, None, "the first step still leads to every folder");
        let v = view(lib.iter().filter(|e| e.dir.ends_with("Acme")).cloned().collect(), &Ask { typed: true, narrowed: true, ..Default::default() });
        assert_eq!(pane_labels(&v, &lib), ["match Proposal.md", "match Pricing.csv"]);
    }

    #[test]
    fn typed_words_list_matches_below_the_chosen_folder_in_hit_order() {
        // Hit order is the Library's ranking: keep it, whatever the tree's order.
        let lib = entries(&[
            ("/Users/k/Documents/Work/Zeta plan.md", 1.),
            ("/Users/k/Projects/atlas/Plan.md", 2.),
            ("/Users/k/Documents/Work/Clients/Acme/Plan B.md", 3.),
            ("/Users/k/Documents/Alpha plan.md", 4.),
        ]);
        let v = view(lib.clone(), &Ask { typed: true, narrowed: true, ..Default::default() });
        assert_eq!(pane_labels(&v, &lib), ["match Zeta plan.md", "match Plan.md", "match Plan B.md", "match Alpha plan.md"]);
        assert_eq!(pane_summary(&v), "4 matches");
        let v = view(lib.clone(), &Ask { typed: true, narrowed: true, ..at("/Users/k/Documents/Work") });
        assert_eq!(pane_labels(&v, &lib), ["match Zeta plan.md", "match Plan B.md"]);
        assert!(v.forced, "a filter holds the tree open to its matches");
        assert!(v.shortcuts.is_empty(), "shortcuts step aside for a filter");
    }

    #[test]
    fn sorting_by_updated_puts_the_newest_first() {
        let v = view(library(), &Ask { by_updated: true, ..at("/Users/k/Documents/Work/Clients") });
        assert_eq!(pane_labels(&v, &library()), ["Acme/ (2)", "Globex/ (1)"]);
        let v = view(library(), &Ask { by_updated: true, ..at("/Users/k/Documents/Work/Clients/Acme") });
        assert_eq!(pane_labels(&v, &library()), ["Proposal.md", "Pricing.csv"]);
    }

    #[test]
    fn shortcuts_are_the_folders_whose_documents_changed_last() {
        assert!(view(library(), &Ask::default()).shortcuts.is_empty(), "too few folders to need them");
        let mut files: Vec<(String, f64)> = (0..10).map(|i| (format!("/Users/k/Notes/Area {i}/note.md"), i as f64)).collect();
        files.push(("/Users/k/readme.md".into(), 100.));
        let borrowed: Vec<(&str, f64)> = files.iter().map(|(p, m)| (p.as_str(), *m)).collect();
        let v = view(entries(&borrowed), &Ask::default());
        let got: Vec<_> = v.shortcuts.iter().map(|s| (s.label.as_str(), s.place.as_str())).collect();
        assert_eq!(got, [("Home", ""), ("Area 9", "~/Notes"), ("Area 8", "~/Notes"), ("Area 7", "~/Notes")]);
    }

    #[test]
    fn a_long_breadcrumb_folds_its_middle() {
        let crumbs: Vec<Crumb> = ["Home", "a", "b", "c", "d", "e"].iter().map(|l| Crumb { label: l.to_string(), path: Some(PathBuf::from(l)) }).collect();
        let labels = |c: &[Crumb]| c.iter().map(|c| c.label.clone()).collect::<Vec<_>>();
        assert_eq!(labels(&shown_crumbs(&crumbs[..4], 3)), ["Home", "a", "b", "c"]);
        let folded = shown_crumbs(&crumbs, 3);
        assert_eq!(labels(&folded), ["Home", "…", "c", "d", "e"]);
        assert_eq!(folded[1].path.as_deref(), Some(Path::new("b")), "the fold leads to the folder before the tail");
    }

    #[test]
    fn keys_type_move_open_and_clear() {
        // Nothing highlighted until an arrow key, unless words are typed.
        assert_eq!(key_effect("down", false, 5, None, false), KeyEffect::Cursor(0));
        assert_eq!(key_effect("down", false, 5, Some(3), false), KeyEffect::Cursor(4));
        assert_eq!(key_effect("down", false, 5, Some(4), false), KeyEffect::Cursor(4));
        assert_eq!(key_effect("up", false, 5, Some(0), false), KeyEffect::Cursor(0));
        assert_eq!(key_effect("up", false, 5, Some(2), false), KeyEffect::Cursor(1));
        assert_eq!(key_effect("up", false, 5, None, false), KeyEffect::None);
        assert_eq!(key_effect("enter", false, 5, Some(2), false), KeyEffect::Activate(2));
        assert_eq!(key_effect("enter", false, 5, None, false), KeyEffect::None);
        assert_eq!(key_effect("enter", false, 5, None, true), KeyEffect::Activate(0), "Return opens the first match");
        assert_eq!(key_effect("enter", false, 0, None, true), KeyEffect::None);
        assert_eq!(key_effect("down", false, 0, None, true), KeyEffect::None);
        assert_eq!(key_effect("escape", false, 5, Some(1), true), KeyEffect::ClearText);
        assert_eq!(key_effect("escape", false, 5, None, false), KeyEffect::None, "Escape is left to the window");
        assert_eq!(key_effect("up", true, 5, Some(2), false), KeyEffect::Parent);
        assert_eq!(key_effect("a", false, 5, Some(2), true), KeyEffect::None, "letters go to the filter");
    }

    #[test]
    fn the_header_says_what_is_listed_and_when_it_was_checked() {
        assert_eq!(status_line(0, 0, true, 0, ""), "Looking for documents…");
        assert_eq!(status_line(0, 0, true, 1204, ""), "Looking for documents… 1,204 so far");
        assert_eq!(status_line(1204, 96, true, 300, "2h ago"), "1,204 documents in 96 folders · Checking for changes…");
        assert_eq!(status_line(1204, 96, false, 0, "20m ago"), "1,204 documents in 96 folders · Checked 20m ago");
        assert_eq!(status_line(1, 1, false, 0, "just now"), "1 document in 1 folder · Checked just now");
        assert_eq!(status_line(0, 0, false, 0, "just now"), "No documents found · Checked just now");
        assert_eq!(status_line(0, 0, false, 0, ""), "No documents found");
    }

    /// The page is rebuilt on every filter keystroke, so it has to stay far
    /// inside a frame's worth of typing on a large index (PERF.md). Run with
    /// `cargo test --release -p markie-app twenty_thousand -- --ignored --nocapture`.
    #[test]
    #[ignore = "a timing, for a quiet machine"]
    fn twenty_thousand_documents_rebuild_quickly() {
        let files: Vec<(String, f64)> = (0..20_000).map(|i| (format!("/Users/k/Area {}/Project {}/Topic {}/note-{i}.md", i % 20, i % 400, i % 2000), i as f64)).collect();
        let borrowed: Vec<(&str, f64)> = files.iter().map(|(p, m)| (p.as_str(), *m)).collect();
        let lib = entries(&borrowed);
        let ask = Ask { typed: true, narrowed: true, ..Default::default() };
        let started = std::time::Instant::now();
        let v = view(lib, &ask);
        let took = started.elapsed();
        println!("20,000 documents, {} matches listed: {took:?}", v.pane.len());
        assert_eq!(v.pane.len(), 20_000);
        assert!(took < std::time::Duration::from_millis(100), "{took:?}");
    }

    #[test]
    fn places_read_as_a_person_names_them() {
        let home = Path::new(HOME);
        assert_eq!(place_label(Path::new("/Users/k"), home), "Home");
        assert_eq!(place_label(Path::new("/Users/k/Documents/Work"), home), "~/Documents/Work");
        assert_eq!(place_label(Path::new("/Volumes/Disk"), home), "/Volumes/Disk");
    }
}
