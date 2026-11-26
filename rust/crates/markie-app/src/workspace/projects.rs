//! The Library's Projects tab and the ⇧⌘F body search.
//!
//! Projects is Markie's own organization over the user's files: folders a
//! person makes by hand (`markie_core::projects::folders`), nested to any
//! depth, each holding files in an order they choose. Nothing on disk moves.
//! Below the folders sits Unsorted: recent files no folder holds, to drag
//! from. Automatic grouping by rules and time (`markie_core::projects`) is
//! off until Settings turns it on; then its groups show under the folders
//! for the files nobody placed.
//!
//! This module keeps the tab's state, turns it into rows (pure, so it is
//! tested without a window), and runs every organize action through the
//! folder history so ⌘Z puts it back. `projects_view.rs` draws it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui_kit::component::WindowExt as _;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;

use markie_core::doc_text::{SHARED_CACHE, SearchOptions, search_documents};
use markie_core::paths;
use markie_core::projects::folders::{self, FolderNode, History, Item, Target};
use markie_core::projects::{ProjectsState, filter_taxonomy};
use markie_core::registry::Registry;

use super::Workspace;
use crate::themes::Palette;

/// The setting that remembers which folders are open.
const OPEN_KEY: &str = "projects_open_folders_v1";
/// How many recent files Unsorted offers at most.
const UNSORTED_RECENT: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SectionKind {
    /// Automatic groups, when Settings turned them on.
    Automatic,
    Unsorted,
}

/// One line of the Projects outline.
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Folder { id: String, name: String, depth: usize, open: bool, files: usize, has_children: bool },
    /// `folder` is the folder holding it, None in Unsorted or an automatic group.
    File { path: PathBuf, name: String, depth: usize, folder: Option<String>, missing: bool },
    Section { kind: SectionKind, count: usize, open: bool },
    AutoProject { key: String, name: String, files: usize, open: bool },
}

impl Row {
    /// What selecting or dragging this row picks up.
    pub fn item(&self) -> Option<Item> {
        match self {
            Row::Folder { id, .. } => Some(Item::Folder(id.clone())),
            Row::File { path, .. } => Some(Item::File(path.to_string_lossy().into_owned())),
            _ => None,
        }
    }
    pub fn depth(&self) -> usize {
        match self {
            Row::Folder { depth, .. } | Row::File { depth, .. } => *depth,
            Row::AutoProject { .. } => 0,
            Row::Section { .. } => 0,
        }
    }
}

/// Everything the rows are drawn from.
pub struct RowInputs<'a> {
    pub folders: &'a [FolderNode],
    pub open: &'a HashSet<String>,
    pub missing: &'a HashSet<String>,
    pub unsorted: &'a [PathBuf],
    pub unsorted_open: bool,
    pub state: Option<&'a ProjectsState>,
    pub toggled: &'a HashMap<String, bool>,
    pub auto_open: bool,
    pub query: &'a str,
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

fn hit(path: &str, q: &str) -> bool {
    file_name(path).to_lowercase().contains(q) || path.to_lowercase().contains(q)
}

/// Does this folder, or anything in it, match the search?
fn folder_matches(node: &FolderNode, q: &str) -> bool {
    node.name.to_lowercase().contains(q) || node.files.iter().any(|f| hit(f, q)) || node.children.iter().any(|c| folder_matches(c, q))
}

fn push_folder(rows: &mut Vec<Row>, node: &FolderNode, depth: usize, i: &RowInputs, q: &str, whole: bool) {
    let searching = !q.is_empty();
    if searching && !whole && !folder_matches(node, q) {
        return;
    }
    // A folder whose name matches shows all of itself.
    let whole = whole || (searching && node.name.to_lowercase().contains(q));
    let open = searching || i.open.contains(&node.id);
    rows.push(Row::Folder {
        id: node.id.clone(),
        name: node.name.clone(),
        depth,
        open,
        files: node.file_count(),
        has_children: !node.children.is_empty() || !node.files.is_empty(),
    });
    if !open {
        return;
    }
    for c in &node.children {
        push_folder(rows, c, depth + 1, i, q, whole);
    }
    for f in &node.files {
        if searching && !whole && !hit(f, q) {
            continue;
        }
        rows.push(Row::File {
            path: PathBuf::from(f),
            name: file_name(f),
            depth: depth + 1,
            folder: Some(node.id.clone()),
            missing: i.missing.contains(f),
        });
    }
}

/// The outline: folders, then automatic groups (when on), then Unsorted.
pub fn tree_rows(i: &RowInputs) -> Vec<Row> {
    let q = i.query.trim().to_lowercase();
    let searching = !q.is_empty();
    let mut rows = Vec::new();
    for node in i.folders {
        push_folder(&mut rows, node, 0, i, &q, false);
    }
    if let Some(state) = i.state.filter(|s| s.auto) {
        let projects: Vec<_> = filter_taxonomy(&state.taxonomy.projects, i.query).into_iter().filter(|p| !p.is_unfiled).collect();
        if !projects.is_empty() {
            let open = searching || i.auto_open;
            rows.push(Row::Section { kind: SectionKind::Automatic, count: projects.len(), open });
            if open {
                for p in projects {
                    let open = searching || i.toggled.get(&p.key).copied().unwrap_or(false);
                    rows.push(Row::AutoProject { key: p.key.clone(), name: p.name.clone(), files: p.file_count, open });
                    if open {
                        for f in p.files() {
                            rows.push(Row::File { path: PathBuf::from(&f.path), name: f.name.clone(), depth: 1, folder: None, missing: false });
                        }
                    }
                }
            }
        }
    }
    let unsorted: Vec<&PathBuf> = i.unsorted.iter().filter(|p| !searching || hit(&p.to_string_lossy(), &q)).collect();
    if !searching || !unsorted.is_empty() {
        let open = searching || i.unsorted_open;
        rows.push(Row::Section { kind: SectionKind::Unsorted, count: unsorted.len(), open });
        if open {
            for p in unsorted {
                let s = p.to_string_lossy().into_owned();
                rows.push(Row::File { path: p.clone(), name: file_name(&s), depth: 0, folder: None, missing: i.missing.contains(&s) });
            }
        }
    }
    rows
}

/// Unsorted: recent files and files that left a folder, newest first, minus
/// anything a folder holds or an automatic group shows.
pub fn unsorted_list(recent: &[(PathBuf, String)], released: &[(String, String)], placed: &HashSet<String>, grouped: &HashSet<String>) -> Vec<PathBuf> {
    let mut all: Vec<(String, &str)> = Vec::new();
    let mut seen = HashSet::new();
    let mut by_time: Vec<(&str, String)> = recent.iter().map(|(p, at)| (at.as_str(), p.to_string_lossy().into_owned())).collect();
    by_time.extend(released.iter().map(|(p, at)| (at.as_str(), p.clone())));
    // ISO times sort as text; ties keep recent before released.
    by_time.sort_by(|a, b| b.0.cmp(a.0));
    for (at, p) in by_time {
        if placed.contains(&p) || grouped.contains(&p) || !seen.insert(p.clone()) {
            continue;
        }
        all.push((p, at));
    }
    all.into_iter().map(|(p, _)| PathBuf::from(p)).collect()
}

/// What a press with modifiers does to the selection, as Finder does it.
/// The Projects outline selects folders and files; the Recent and Cloud
/// grids select cards by id.
#[derive(Clone, Debug, PartialEq)]
pub struct Selection<T = Item> {
    pub items: Vec<T>,
    /// Where a ⇧-click range starts.
    pub anchor: Option<T>,
    /// The keyboard's row: drawn with a focus ring while the outline has focus.
    pub cursor: Option<T>,
}

impl<T> Default for Selection<T> {
    fn default() -> Self {
        Self { items: Vec::new(), anchor: None, cursor: None }
    }
}

impl<T: Clone + PartialEq> Selection<T> {
    pub fn contains(&self, item: &T) -> bool {
        self.items.contains(item)
    }

    /// A press on `item`. `order` is every selectable row as drawn.
    pub fn press(&mut self, item: &T, cmd: bool, shift: bool, order: &[T]) {
        if shift {
            let anchor = self.anchor.clone().unwrap_or_else(|| item.clone());
            let (a, b) = (order.iter().position(|x| *x == anchor), order.iter().position(|x| x == item));
            if let (Some(a), Some(b)) = (a, b) {
                let (lo, hi) = (a.min(b), a.max(b));
                let range: Vec<T> = order[lo..=hi].to_vec();
                if cmd {
                    for r in range {
                        if !self.items.contains(&r) {
                            self.items.push(r);
                        }
                    }
                } else {
                    self.items = range;
                }
                self.anchor = Some(anchor);
            } else {
                self.items = vec![item.clone()];
                self.anchor = Some(item.clone());
            }
        } else if cmd {
            if let Some(i) = self.items.iter().position(|x| x == item) {
                self.items.remove(i);
            } else {
                self.items.push(item.clone());
            }
            self.anchor = Some(item.clone());
        } else {
            self.items = vec![item.clone()];
            self.anchor = Some(item.clone());
        }
        self.cursor = Some(item.clone());
    }

    /// Up or down: the cursor moves; ⇧ extends from the anchor.
    pub fn step(&mut self, down: bool, shift: bool, order: &[T]) {
        if order.is_empty() {
            return;
        }
        let at = self.cursor.as_ref().and_then(|c| order.iter().position(|x| x == c));
        let next = match at {
            None => if down { 0 } else { order.len() - 1 },
            Some(i) if down => (i + 1).min(order.len() - 1),
            Some(i) => i.saturating_sub(1),
        };
        let item = order[next].clone();
        if shift {
            self.press(&item, false, true, order);
        } else {
            self.press(&item, false, false, order);
        }
    }

    pub fn select_all(&mut self, order: &[T]) {
        self.items = order.to_vec();
        self.anchor = order.first().cloned();
        if self.cursor.is_none() {
            self.cursor = order.first().cloned();
        }
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.anchor = None;
    }

    /// What a drag of `item` carries: the whole selection when it is part of it.
    pub fn drag_set(&self, item: &T, order: &[T]) -> Vec<T> {
        if self.items.contains(item) && self.items.len() > 1 {
            // In the order they are drawn, so they land in that order.
            order.iter().filter(|x| self.items.contains(x)).cloned().collect()
        } else {
            vec![item.clone()]
        }
    }

    /// Drop what is no longer drawn.
    pub fn retain(&mut self, order: &[T]) {
        self.items.retain(|x| order.contains(x));
        if self.anchor.as_ref().is_some_and(|a| !order.contains(a)) {
            self.anchor = None;
        }
        if self.cursor.as_ref().is_some_and(|a| !order.contains(a)) {
            self.cursor = None;
        }
    }
}

/// Where in a row the pointer is during a drag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Zone {
    Before,
    Into,
    After,
}

/// A folder row: the top and bottom quarters insert beside it, the middle
/// drops into it. A file row: the halves insert above or below.
pub fn zone_for(row: &Row, top: f32, height: f32, y: f32) -> Zone {
    let t = ((y - top) / height.max(1.)).clamp(0., 1.);
    match row {
        Row::Folder { .. } if t < 0.25 => Zone::Before,
        Row::Folder { .. } if t > 0.75 => Zone::After,
        Row::Folder { .. } => Zone::Into,
        _ if t < 0.5 => Zone::Before,
        _ => Zone::After,
    }
}

/// The drop that row and zone mean, or None where nothing can land.
pub fn target_for(row: &Row, zone: Zone) -> Option<Target> {
    match (row, zone) {
        (Row::Folder { id, .. }, Zone::Into) => Some(Target::Into(id.clone())),
        (Row::Folder { id, .. }, Zone::Before) => Some(Target::Before(Item::Folder(id.clone()))),
        (Row::Folder { id, .. }, Zone::After) => Some(Target::After(Item::Folder(id.clone()))),
        (Row::File { folder: Some(_), path, .. }, Zone::Before) => Some(Target::Before(Item::File(path.to_string_lossy().into_owned()))),
        (Row::File { folder: Some(_), path, .. }, _) => Some(Target::After(Item::File(path.to_string_lossy().into_owned()))),
        (Row::File { folder: None, .. }, _) | (Row::Section { kind: SectionKind::Unsorted, .. }, _) => Some(Target::Unsorted),
        _ => None,
    }
}

fn parents(nodes: &[FolderNode], parent: Option<&str>, out: &mut HashMap<String, Option<String>>) {
    for n in nodes {
        out.insert(n.id.clone(), parent.map(str::to_string));
        parents(&n.children, Some(&n.id), out);
    }
}

/// Would this drop do anything sensible? A folder cannot go into itself or
/// its own subfolder, and dropping only folders on Unsorted means nothing.
pub fn drop_allowed(items: &[Item], target: &Target, tree: &[FolderNode]) -> bool {
    let mut up = HashMap::new();
    parents(tree, None, &mut up);
    let within = |inside: &str, id: &str| {
        let mut at = Some(inside.to_string());
        let mut guard = 0;
        while let Some(cur) = at {
            if cur == id {
                return true;
            }
            at = up.get(&cur).cloned().flatten();
            guard += 1;
            if guard > up.len() + 1 {
                break;
            }
        }
        false
    };
    let inside_of = |t: &Target| -> Option<String> {
        match t {
            Target::Into(id) => Some(id.clone()),
            Target::Before(Item::Folder(id)) | Target::After(Item::Folder(id)) => up.get(id).cloned().flatten(),
            _ => None,
        }
    };
    let dest = inside_of(target);
    for item in items {
        match item {
            Item::Folder(id) => {
                if let Some(d) = &dest
                    && within(d, id)
                {
                    return false;
                }
                if matches!(target, Target::Before(Item::Folder(a)) | Target::After(Item::Folder(a)) if a == id) {
                    return false;
                }
            }
            Item::File(p) => {
                if matches!(target, Target::Before(Item::File(a)) | Target::After(Item::File(a)) if a == p) && items.len() == 1 {
                    return false;
                }
            }
        }
    }
    !(matches!(target, Target::Unsorted) && items.iter().all(|i| matches!(i, Item::Folder(_))))
}

/// What a drag carries: the items, and the paths for the platform when it
/// leaves the window.
#[derive(Clone, Debug)]
pub struct DragItems {
    pub items: Vec<Item>,
    pub label: String,
}

impl DragItems {
    pub fn new(items: Vec<Item>, names: &dyn Fn(&Item) -> String) -> Self {
        let label = match items.as_slice() {
            [one] => names(one),
            many => format!("{} items", many.len()),
        };
        Self { items, label }
    }
}

/// The little tag under the pointer during a drag.
pub struct DragPreview {
    pub label: String,
    pub count: usize,
    pub palette: Palette,
}

impl Render for DragPreview {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let p = self.palette;
        gpui_kit::component::h_flex()
            .gap(px(6.))
            .px(px(8.))
            .py(px(4.))
            .rounded(px(6.))
            .bg(p.surface2)
            .border_1()
            .border_color(p.blue.opacity(0.6))
            .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.18), offset: point(px(0.), px(4.)), blur_radius: px(12.), spread_radius: px(0.), inset: false }])
            .text_size(px(12.))
            .text_color(p.foreground)
            .child(div().max_w(px(200.)).truncate().child(self.label.clone()))
            .when(self.count > 1, |el| {
                el.child(div().px(px(6.)).rounded_full().bg(p.blue).text_color(gpui_kit::white()).text_size(px(10.5)).child(self.count.to_string()))
            })
    }
}

use gpui_kit::prelude::FluentBuilder as _;

/// A row's right-click menu entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Open,
    Reveal,
    MoveTo,
    RemoveFromFolder,
    Locate,
    Forget,
    NewFolder,
    NewFolderInside,
    NewDocument,
    AddFiles,
    Rename,
    DeleteFolder,
    /// The vault's Make Private… (`vault.rs`), as every file menu offers it.
    MakePrivate,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MenuEntry {
    pub action: MenuAction,
    pub label: String,
    pub shortcut: Option<&'static str>,
    pub danger: bool,
    pub separated: bool,
}

fn entry(action: MenuAction, label: impl Into<String>, shortcut: Option<&'static str>) -> MenuEntry {
    MenuEntry { action, label: label.into(), shortcut, danger: false, separated: false }
}

/// The menu for what is selected (or the empty area, with nothing).
/// `in_folder` counts selected files a folder holds.
pub fn menu_entries(items: &[Item], in_folder: usize, missing: bool) -> Vec<MenuEntry> {
    let folders = items.iter().filter(|i| matches!(i, Item::Folder(_))).count();
    let files = items.len() - folders;
    let mut out = Vec::new();
    let sep = |mut e: MenuEntry| {
        e.separated = true;
        e
    };
    match (folders, files) {
        (0, 0) => {
            out.push(entry(MenuAction::NewFolder, "New Folder", Some("⇧⌘N")));
            out.push(entry(MenuAction::AddFiles, "Add Files…", None));
        }
        (1, 0) => {
            out.push(entry(MenuAction::NewFolderInside, "New Folder Inside", Some("⇧⌘N")));
            out.push(entry(MenuAction::NewDocument, "New Document Here", None));
            out.push(entry(MenuAction::AddFiles, "Add Files…", None));
            out.push(sep(entry(MenuAction::Rename, "Rename", Some("↩"))));
            out.push(entry(MenuAction::MoveTo, "Move to…", None));
            let mut d = sep(entry(MenuAction::DeleteFolder, "Delete Folder…", Some("⌘⌫")));
            d.danger = true;
            out.push(d);
        }
        (0, 1) if missing => {
            out.push(entry(MenuAction::Locate, "Locate…", None));
            let mut d = entry(MenuAction::Forget, "Remove", None);
            d.danger = true;
            out.push(d);
        }
        (0, 1) => {
            out.push(entry(MenuAction::Open, "Open", Some("⌘O")));
            out.push(entry(MenuAction::Reveal, crate::menus::reveal_label(), None));
            out.push(sep(entry(MenuAction::MoveTo, "Move to…", None)));
            if in_folder > 0 {
                out.push(entry(MenuAction::RemoveFromFolder, "Remove from Folder", Some("⌘⌫")));
            }
            out.push(sep(entry(MenuAction::MakePrivate, "Make Private…", None)));
        }
        _ => {
            let n = items.len();
            if folders == 0 {
                out.push(entry(MenuAction::Open, format!("Open {n} Documents"), Some("⌘O")));
                out.push(sep(entry(MenuAction::MoveTo, format!("Move {n} Documents to…"), None)));
            } else {
                out.push(entry(MenuAction::MoveTo, format!("Move {n} Items to…"), None));
            }
            if in_folder > 0 {
                out.push(entry(MenuAction::RemoveFromFolder, format!("Remove {in_folder} from Folder"), Some("⌘⌫")));
            }
        }
    }
    out
}

/// A folder as the Move to… list shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct Destination {
    /// None is "Unsorted (no folder)".
    pub id: Option<String>,
    pub name: String,
    pub depth: usize,
    /// It is one of the folders being moved, or inside one.
    pub disabled: bool,
}

/// Every folder, outline order, for Move to…; folders being moved and
/// their insides are shown but cannot be picked.
pub fn destinations(tree: &[FolderNode], moving: &[Item]) -> Vec<Destination> {
    fn walk(nodes: &[FolderNode], depth: usize, blocked: bool, moving: &[Item], out: &mut Vec<Destination>) {
        for n in nodes {
            let b = blocked || moving.contains(&Item::Folder(n.id.clone()));
            out.push(Destination { id: Some(n.id.clone()), name: n.name.clone(), depth, disabled: b });
            walk(&n.children, depth + 1, b, moving, out);
        }
    }
    let mut out = vec![Destination { id: None, name: "Unsorted (no folder)".into(), depth: 0, disabled: false }];
    walk(tree, 0, false, moving, &mut out);
    out
}

/// "N files go back to Unsorted…": what the delete confirm says.
pub fn delete_message(name: &str, impact: folders::DeleteImpact) -> (String, String) {
    let title = format!("Delete the folder \u{201c}{name}\u{201d}?");
    let inside = if impact.subfolders > 0 { " in it" } else { "" };
    let files = match impact.files {
        0 => "It holds no files.".to_string(),
        1 => format!("The 1 file{inside} goes back to Unsorted."),
        n => format!("All {n} files{inside} go back to Unsorted."),
    };
    let subs = match impact.subfolders {
        0 => String::new(),
        1 => " The folder inside it is deleted too.".to_string(),
        n => format!(" The {n} folders inside it are deleted too."),
    };
    (title, format!("{files}{subs} Nothing is deleted from your disk. You can undo this with \u{2318}Z."))
}

/// A unique "Untitled.md" in `dir`: "Untitled 2.md" and on when taken.
pub fn untitled_path(dir: &Path, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join("Untitled.md");
    if !exists(&first) {
        return first;
    }
    (2..).map(|n| dir.join(format!("Untitled {n}.md"))).find(|p| !exists(p)).expect("an unused name")
}

pub(super) struct Projects {
    pub state: Option<ProjectsState>,
    computing: bool,
    /// Automatic groups the user opened or shut.
    pub toggled: HashMap<String, bool>,
    pub filter: Entity<InputState>,
    pub query: String,
    _body_search: Task<()>,
    /// The folder tree as stored, read again after every change.
    pub tree: Vec<FolderNode>,
    pub unsorted: Vec<PathBuf>,
    /// Placed or Unsorted files that are gone from disk.
    pub missing: HashSet<String>,
    pub open: HashSet<String>,
    pub unsorted_open: bool,
    pub auto_open: bool,
    pub selection: Selection,
    pub history: History,
    /// The folder being renamed inline, and its field.
    pub renaming: Option<(String, Entity<InputState>)>,
    _rename_sub: Option<Subscription>,
    /// The right-click menu: for the selection (empty means the open area), where.
    pub menu: Option<(Vec<Item>, Point<Pixels>)>,
    pub menu_focus: usize,
    /// Where the current drag would land: the row, its zone, and the drop.
    pub drop: Option<(usize, Zone, Target)>,
    /// A Finder drag over a folder row.
    pub file_drop: Option<usize>,
    pub focus: FocusHandle,
    pub scroll: UniformListScrollHandle,
    /// The outline has the keyboard (read each frame).
    pub tree_focused: bool,
    loaded: bool,
}

impl Projects {
    pub(super) fn new(window: &mut Window, cx: &mut Context<Workspace>) -> (Self, Subscription) {
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Search folders and files"));
        let sub = cx.subscribe(&filter, |this: &mut Workspace, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.projects.query = state.read(cx).value().to_string();
                cx.notify();
            }
        });
        let me = Self {
            state: None,
            computing: false,
            toggled: HashMap::new(),
            filter,
            query: String::new(),
            _body_search: Task::ready(()),
            tree: Vec::new(),
            unsorted: Vec::new(),
            missing: HashSet::new(),
            open: HashSet::new(),
            unsorted_open: true,
            auto_open: true,
            selection: Selection::default(),
            history: History::default(),
            renaming: None,
            _rename_sub: None,
            menu: None,
            menu_focus: 0,
            drop: None,
            file_drop: None,
            focus: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
            tree_focused: false,
            loaded: false,
        };
        (me, sub)
    }

    pub fn rows(&self) -> Vec<Row> {
        tree_rows(&RowInputs {
            folders: &self.tree,
            open: &self.open,
            missing: &self.missing,
            unsorted: &self.unsorted,
            unsorted_open: self.unsorted_open,
            state: self.state.as_ref(),
            toggled: &self.toggled,
            auto_open: self.auto_open,
            query: &self.query,
        })
    }

    /// Every selectable row's item, in drawn order.
    pub fn order(rows: &[Row]) -> Vec<Item> {
        rows.iter().filter_map(Row::item).collect()
    }

    pub fn name_of(&self, item: &Item) -> String {
        match item {
            Item::File(p) => file_name(p),
            Item::Folder(id) => find(&self.tree, id).map_or_else(String::new, |n| n.name.clone()),
        }
    }

    /// The folder a placed file sits in.
    pub fn folder_of(&self, path: &str) -> Option<String> {
        fn walk(nodes: &[FolderNode], path: &str) -> Option<String> {
            for n in nodes {
                if n.files.iter().any(|f| f == path) {
                    return Some(n.id.clone());
                }
                if let Some(id) = walk(&n.children, path) {
                    return Some(id);
                }
            }
            None
        }
        walk(&self.tree, path)
    }
}

pub fn find<'a>(nodes: &'a [FolderNode], id: &str) -> Option<&'a FolderNode> {
    for n in nodes {
        if n.id == id {
            return Some(n);
        }
        if let Some(f) = find(&n.children, id) {
            return Some(f);
        }
    }
    None
}

fn all_paths(nodes: &[FolderNode], out: &mut Vec<String>) {
    for n in nodes {
        out.extend(n.files.iter().cloned());
        all_paths(&n.children, out);
    }
}

/// The ancestors of a folder, so a new or revealed one can be opened to.
fn ancestors(nodes: &[FolderNode], id: &str) -> Vec<String> {
    let mut up = HashMap::new();
    parents(nodes, None, &mut up);
    let mut out = Vec::new();
    let mut at = up.get(id).cloned().flatten();
    while let Some(p) = at {
        if out.contains(&p) {
            break;
        }
        out.push(p.clone());
        at = up.get(&p).cloned().flatten();
    }
    out
}

impl Workspace {
    /// Read the folders, Unsorted and which files are missing again.
    pub(super) fn reload_folders(&mut self, cx: &mut Context<Self>) {
        let Some(reg) = self.registry.clone() else { return };
        let db = reg.conn();
        if !self.projects.loaded {
            self.projects.loaded = true;
            if let Some(json) = reg.setting(OPEN_KEY).ok().flatten() {
                self.projects.open = serde_json::from_str::<Vec<String>>(&json).unwrap_or_default().into_iter().collect();
            }
        }
        self.projects.tree = folders::tree(db).unwrap_or_default();
        let placed = folders::placed_paths(db).unwrap_or_default();
        let released = folders::released_all(db).unwrap_or_default();
        let recent: Vec<(PathBuf, String)> =
            reg.recent(UNSORTED_RECENT).unwrap_or_default().into_iter().map(|r| (r.path, r.last_opened_at)).collect();
        let grouped: HashSet<String> = self
            .projects
            .state
            .as_ref()
            .filter(|s| s.auto)
            .map(|s| {
                s.taxonomy.projects.iter().filter(|p| !p.is_unfiled).flat_map(|p| p.files().into_iter().map(|f| f.path.clone())).collect()
            })
            .unwrap_or_default();
        self.projects.unsorted = unsorted_list(&recent, &released, &placed, &grouped);
        let mut check = Vec::new();
        all_paths(&self.projects.tree, &mut check);
        check.extend(self.projects.unsorted.iter().map(|p| p.to_string_lossy().into_owned()));
        self.projects.missing = check.into_iter().filter(|p| !Path::new(p).exists()).collect();
        let order = Projects::order(&self.projects.rows());
        self.projects.selection.retain(&order);
        cx.notify();
    }

    fn save_open_folders(&self) {
        if let Some(reg) = &self.registry {
            let mut ids: Vec<&String> = self.projects.open.iter().collect();
            ids.sort();
            let _ = reg.set_setting(OPEN_KEY, &serde_json::to_string(&ids).unwrap_or_default());
        }
    }

    pub(super) fn set_folder_open(&mut self, id: &str, open: bool, cx: &mut Context<Self>) {
        let changed = if open { self.projects.open.insert(id.to_string()) } else { self.projects.open.remove(id) };
        if changed {
            self.save_open_folders();
            cx.notify();
        }
    }

    /// Run one organize action through the history, then redraw.
    pub(super) fn organize<T>(
        &mut self,
        label: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
        action: impl FnOnce(&rusqlite::Connection) -> anyhow::Result<T>,
    ) -> Option<T> {
        let reg = self.registry.clone()?;
        let out = self.projects.history.record(reg.conn(), label, action);
        self.reload_folders(cx);
        match out {
            Ok(v) => Some(v),
            Err(e) => {
                window.push_notification(format!("Markie could not do that: {e}"), cx);
                None
            }
        }
    }

    pub(super) fn projects_undo(&mut self, redo: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(reg) = self.registry.clone() else { return };
        let done = if redo { self.projects.history.redo(reg.conn()) } else { self.projects.history.undo(reg.conn()) };
        self.projects.renaming = None;
        self.reload_folders(cx);
        match done {
            Ok(Some(label)) => window.push_notification(format!("{} {label}", if redo { "Redid" } else { "Undid" }), cx),
            Ok(None) => {}
            Err(e) => window.push_notification(format!("Markie could not undo that: {e}"), cx),
        }
    }

    /// New Folder at the top level, or inside `parent`, then rename it inline.
    pub(super) fn new_folder(&mut self, parent: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.organize("New Folder", window, cx, |db| folders::create_folder(db, parent.as_deref(), "")) else { return };
        let id: String = id;
        if let Some(p) = &parent {
            self.set_folder_open(p, true, cx);
        }
        for a in ancestors(&self.projects.tree, &id) {
            self.set_folder_open(&a, true, cx);
        }
        let item = Item::Folder(id.clone());
        let order = Projects::order(&self.projects.rows());
        self.projects.selection.press(&item, false, false, &order);
        self.start_folder_rename(&id, window, cx);
    }

    pub(super) fn start_folder_rename(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(node) = find(&self.projects.tree, id) else { return };
        let name = node.name.clone();
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(name.clone(), window, cx);
            state
        });
        let sub = cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| match ev {
            InputEvent::PressEnter { .. } | InputEvent::Blur => this.commit_folder_rename(window, cx),
            _ => {}
        });
        let handle = input.read(cx).focus_handle(cx);
        input.update(cx, |s, cx| s.select_all(window, cx));
        self.projects.renaming = Some((id.to_string(), input));
        self._set_rename_sub(sub);
        handle.focus(window, cx);
        cx.notify();
    }

    fn _set_rename_sub(&mut self, sub: Subscription) {
        self.projects._rename_sub = Some(sub);
    }

    pub(super) fn commit_folder_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((id, input)) = self.projects.renaming.take() else { return };
        self.projects._rename_sub = None;
        let name = input.read(cx).value().to_string();
        self.organize("Rename", window, cx, |db| folders::rename_folder(db, &id, &name));
        self.projects.focus.focus(window, cx);
    }

    pub(super) fn cancel_folder_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.projects.renaming.take().is_some() {
            self.projects._rename_sub = None;
            self.projects.focus.focus(window, cx);
            cx.notify();
        }
    }

    /// Apply a drop and select what moved.
    pub(super) fn drop_items(&mut self, items: Vec<Item>, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        self.projects.drop = None;
        if !drop_allowed(&items, &target, &self.projects.tree) {
            cx.notify();
            return;
        }
        let label = if matches!(target, Target::Unsorted) { "Remove from Folder" } else { "Move" };
        if self.organize(label, window, cx, |db| folders::drop_items(db, &items, &target)).is_some() {
            if let Target::Into(id) = &target {
                self.set_folder_open(id, true, cx);
            }
            self.projects.selection.items = items;
            cx.notify();
        }
    }

    /// Files from Finder dropped on a folder: added where they are, never moved.
    pub(super) fn add_paths_to_folder(&mut self, paths: Vec<PathBuf>, folder: String, window: &mut Window, cx: &mut Context<Self>) {
        let files: Vec<String> = paths.iter().filter(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned()).collect();
        if files.is_empty() {
            window.push_notification("Folders hold files. Drop files, not folders.", cx);
            return;
        }
        if self.organize("Add Files", window, cx, |db| folders::place_files(db, &files, &folder, None)).is_some() {
            self.set_folder_open(&folder, true, cx);
        }
    }

    pub(super) fn prompt_add_files(&mut self, folder: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let folder = match folder.or_else(|| self.projects.tree.first().map(|n| n.id.clone())) {
            Some(f) => f,
            None => match self.organize("New Folder", window, cx, |db| folders::create_folder(db, None, "")) {
                Some(id) => id,
                None => return,
            },
        };
        let rx = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: Some("Add".into()) });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                this.update_in(cx, |this, window, cx| this.add_paths_to_folder(paths, folder, window, cx)).ok();
            }
        })
        .detach();
    }

    /// New Document Here: a real file in the documents folder, placed in the
    /// folder and opened.
    pub(super) fn new_document_in(&mut self, folder: String, window: &mut Window, cx: &mut Context<Self>) {
        let dir = paths::default_root();
        let path = untitled_path(&dir, |p| p.exists());
        let made = std::fs::create_dir_all(&dir).and_then(|_| std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ()));
        if let Err(e) = made {
            window.push_notification(format!("Markie could not create it: {e}"), cx);
            return;
        }
        let s = path.to_string_lossy().into_owned();
        self.organize("New Document", window, cx, |db| folders::place_files(db, &[s], &folder, None));
        self.set_folder_open(&folder, true, cx);
        self.open_path(&path, window, cx);
    }

    pub(super) fn ask_delete_folder(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(reg) = self.registry.clone() else { return };
        let Ok(impact) = folders::delete_impact(reg.conn(), &id) else { return };
        let name = self.projects.name_of(&Item::Folder(id.clone()));
        self.show_dialog(super::overlay::Overlay::DeleteFolder { id, name, impact }, window, cx);
    }

    pub(super) fn confirm_delete_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let super::overlay::Overlay::DeleteFolder { id, .. } = &self.dialogs.open else { return };
        let id = id.clone();
        self.close_dialog(window, cx);
        self.organize("Delete Folder", window, cx, |db| folders::delete_folder(db, &id));
        self.projects.focus.focus(window, cx);
    }

    pub(super) fn ask_move_to(&mut self, items: Vec<Item>, window: &mut Window, cx: &mut Context<Self>) {
        if items.is_empty() {
            return;
        }
        // Move to… is also how Recents files reach a folder, from any page.
        self.reload_folders(cx);
        let rows = destinations(&self.projects.tree, &items);
        let focused = rows.iter().position(|d| d.id.is_some() && !d.disabled).unwrap_or(0);
        self.show_dialog(super::overlay::Overlay::MoveToFolder { items, focused }, window, cx);
    }

    pub(super) fn confirm_move_to(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let super::overlay::Overlay::MoveToFolder { items, .. } = &self.dialogs.open else { return };
        let items = items.clone();
        let rows = destinations(&self.projects.tree, &items);
        let Some(dest) = rows.get(index).filter(|d| !d.disabled).cloned() else { return };
        self.close_dialog(window, cx);
        let target = match dest.id {
            Some(id) => Target::Into(id),
            None => Target::Unsorted,
        };
        self.drop_items(items, target, window, cx);
        self.bulk_move_done();
        self.shell.recent_grid.selection.clear();
        cx.notify();
    }

    /// Files placed in any folder, of those given.
    pub(super) fn placed_among(&self, paths: &[String]) -> usize {
        let Some(reg) = &self.registry else { return 0 };
        let placed = folders::placed_paths(reg.conn()).unwrap_or_default();
        paths.iter().filter(|p| placed.contains(*p)).count()
    }

    pub(super) fn remove_from_folder(&mut self, paths: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        self.organize("Remove from Folder", window, cx, |db| folders::unplace(db, &paths));
    }

    /// Locate…: pick where a missing file went; its place in the folder stays.
    pub(super) fn locate_missing(&mut self, path: String, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Locate".into()) });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await
                && let Some(found) = paths.into_iter().next()
            {
                this.update_in(cx, |this, window, cx| {
                    let to = found.to_string_lossy().into_owned();
                    this.organize("Locate", window, cx, |db| folders::relocate(db, &path, &to));
                    if let Some(reg) = &this.registry {
                        let _ = reg.move_path(Path::new(&path), &found);
                    }
                    this.reload_folders(cx);
                })
                .ok();
            }
        })
        .detach();
    }

    pub(super) fn forget_missing(&mut self, paths: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.organize("Remove", window, cx, |db| folders::forget(db, &paths));
        if let Some(reg) = &self.registry {
            for p in &paths {
                let _ = reg.forget(Path::new(p));
            }
        }
        self.refresh_lists(cx);
        self.reload_folders(cx);
    }

    /// Open every selected file; folders are skipped.
    pub(super) fn open_items(&mut self, items: &[Item], window: &mut Window, cx: &mut Context<Self>) {
        let files: Vec<PathBuf> = items
            .iter()
            .filter_map(|i| if let Item::File(p) = i { Some(PathBuf::from(p)) } else { None })
            .filter(|p| p.exists())
            .collect();
        if let Some((last, rest)) = files.split_last() {
            if let Some(reg) = &self.registry {
                for p in rest {
                    let _ = reg.track_opened(p);
                }
            }
            self.open_path(last, window, cx);
        }
    }

    /// Rebuild the taxonomy off the UI thread on its own registry connection.
    /// It also runs the one-time conversion of older groups into folders.
    pub(super) fn compute_projects(&mut self, cx: &mut Context<Self>) {
        self.reload_folders(cx);
        if self.projects.computing || self.library.docs().is_empty() {
            return;
        }
        self.projects.computing = true;
        let index = self.library.docs().to_vec();
        let db_path = paths::data_dir().join("registry.db");
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let reg = Registry::open(&db_path)?;
                    markie_core::projects::compute(reg.conn(), &index, &paths::default_root(), &paths::home_dir(), Duration::from_secs(20))
                })
                .await;
            this.update(cx, |this, cx| {
                this.projects.computing = false;
                match result {
                    Ok(state) => {
                        let again = state.preparing;
                        if let Some(m) = &state.migration
                            && m.folders > 0
                        {
                            // The converted folders are new history: nothing to undo into.
                            this.projects.history = History::default();
                        }
                        this.projects.state = Some(state);
                        if again {
                            // Metadata is still being read: try again shortly.
                            cx.spawn(async move |this, cx| {
                                cx.background_executor().timer(Duration::from_secs(2)).await;
                                this.update(cx, |this, cx| this.compute_projects(cx)).ok();
                            })
                            .detach();
                        }
                    }
                    Err(e) => eprintln!("markie-rs: projects unavailable: {e:#}"),
                }
                this.reload_folders(cx);
            })
            .ok();
        })
        .detach();
    }

    /// Settings: "Organize files into projects automatically".
    pub(super) fn auto_organize(&self) -> bool {
        self.registry.as_ref().is_some_and(|r| folders::auto_organize(r.conn()).unwrap_or(false))
    }

    pub(super) fn set_auto_organize(&mut self, on: bool, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let _ = folders::set_auto_organize(reg.conn(), on);
        }
        if let Some(s) = self.projects.state.as_mut() {
            s.auto = on;
            if !on {
                s.taxonomy = Default::default();
            }
        }
        self.compute_projects(cx);
        cx.notify();
    }

    /// What follows a file the app renamed or moved, as Electron's
    /// `afterWorkspaceMove` does: every path-keyed registry row (recent, star,
    /// folder placement, project pin and assignment, metadata), the office
    /// recovery history and local comments. Text version history stays keyed
    /// to the old path, as in Electron, whose snapshots are not moved either.
    pub(super) fn follow_move(&mut self, from: &std::path::Path, to: &std::path::Path, cx: &mut Context<Self>) {
        if let Some(reg) = &self.registry {
            let moved = if to.is_dir() {
                let sep = std::path::MAIN_SEPARATOR;
                reg.move_prefix(&format!("{}{sep}", from.display()), &format!("{}{sep}", to.display()))
            } else {
                reg.move_path(from, to)
            };
            if let Err(e) = moved {
                eprintln!("markie-rs: registry move failed: {e:#}");
            }
        }
        let _ = self.recovery.moved(from, to);
        markie_cloud::comments::local::LocalComments::new(&paths::data_dir()).move_records(from, to);
        // A synced Google Doc's record follows its file.
        self.google_follow_move(from, to, cx);
        self.refresh_lists(cx);
        self.compute_projects(cx);
    }

    /// `Projects.md`, the rules automatic grouping follows: open it, writing
    /// the template only now if it does not exist. Reached from
    /// Settings › Agents › "Organizing rules for Projects".
    pub(super) fn open_projects_config(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match markie_core::projects::config::ensure_config(&paths::default_root()) {
            Ok(cfg) => self.open_path(&cfg.path, window, cx),
            Err(e) => eprintln!("markie-rs: Projects.md unavailable: {e}"),
        }
    }

    /// Run Electron's global search over the whole index once typing pauses.
    /// A newer query drops this task; the core's generation counter stops a
    /// search already running.
    pub(super) fn schedule_body_search(&mut self, cx: &mut Context<Self>) {
        let req = self.shell.search.body_search().filter(|r| !r.text.trim().is_empty());
        let Some(req) = req else {
            self.projects._body_search = Task::ready(());
            return;
        };
        self.projects._body_search = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(120)).await;
            let (text, formats) = (req.text.clone(), req.formats.clone());
            let resp = cx
                .background_spawn(async move {
                    let opts = SearchOptions { formats: req.formats, ..Default::default() };
                    search_documents(&req.pool, &req.text, &opts, &SHARED_CACHE)
                })
                .await;
            this.update(cx, |this, cx| {
                this.shell.search.set_body_results(&text, &formats, resp);
                cx.notify();
            })
            .ok();
        });
    }

    /// The body-search pool: the index plus recent files the walk missed.
    pub(super) fn build_search_pool(&mut self) {
        let recent: Vec<PathBuf> = self
            .registry
            .as_ref()
            .and_then(|r| r.recent(200).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.path)
            .collect();
        self.library.build_pool(&recent);
    }
}

/// `.markie-search-mark`: the status yellow at 30 % behind the words, and a
/// 70 % line under them (Chromium's inset box shadow).
pub(super) fn marked(text: &str, ranges: &[(usize, usize)], p: &Palette) -> StyledText {
    let style = HighlightStyle {
        background_color: Some(p.yellow.opacity(0.3)),
        underline: Some(UnderlineStyle { color: Some(p.yellow.opacity(0.7)), thickness: px(1.), wavy: false }),
        ..Default::default()
    };
    let highlights: Vec<_> = markie_core::doc_text::merge_marks(ranges.to_vec())
        .into_iter()
        .filter(|(a, b)| a < b && *b <= text.len() && text.is_char_boundary(*a) && text.is_char_boundary(*b))
        .map(|(a, b)| (a..b, style))
        .collect();
    StyledText::new(text.to_string()).with_highlights(highlights)
}

#[cfg(test)]
mod tests {
    use super::{
        FolderNode, HashMap, HashSet, Item, MenuAction, MenuEntry, Path, PathBuf, ProjectsState, Row, RowInputs, SectionKind, Selection, Target, Zone, delete_message,
        destinations, drop_allowed, folders, menu_entries, target_for, tree_rows, unsorted_list, untitled_path, zone_for,
    };
    use markie_core::projects::{ProjectNode, Taxonomy, assign::EngineFile};

    fn node(id: &str, name: &str, children: Vec<FolderNode>, files: &[&str]) -> FolderNode {
        FolderNode { id: id.into(), name: name.into(), children, files: files.iter().map(|f| f.to_string()).collect() }
    }

    fn sample() -> Vec<FolderNode> {
        vec![
            node("trips", "Trips", vec![node("lisbon", "Lisbon", vec![], &["/n/tram.md"])], &["/n/packing.md", "/n/visa.md"]),
            node("garden", "Garden", vec![], &["/n/seeds.md"]),
        ]
    }

    fn inputs<'a>(tree: &'a [FolderNode], open: &'a HashSet<String>, unsorted: &'a [PathBuf], q: &'a str, missing: &'a HashSet<String>, toggled: &'a HashMap<String, bool>) -> RowInputs<'a> {
        RowInputs { folders: tree, open, missing, unsorted, unsorted_open: true, state: None, toggled, auto_open: true, query: q }
    }

    fn labels(rows: &[Row]) -> Vec<String> {
        rows.iter()
            .map(|r| match r {
                Row::Folder { name, depth, open, .. } => format!("{}{}{name}", "  ".repeat(*depth), if *open { "▾" } else { "▸" }),
                Row::File { name, depth, missing, .. } => format!("{}{name}{}", "  ".repeat(*depth), if *missing { " (missing)" } else { "" }),
                Row::Section { kind, count, .. } => format!("[{kind:?} {count}]"),
                Row::AutoProject { name, .. } => format!("<{name}>"),
            })
            .collect()
    }

    #[test]
    fn the_outline_nests_folders_then_files_then_unsorted() {
        let tree = sample();
        let unsorted = vec![PathBuf::from("/n/loose.md")];
        let (missing, toggled) = (HashSet::from(["/n/visa.md".to_string()]), HashMap::new());
        let shut = HashSet::new();
        assert_eq!(labels(&tree_rows(&inputs(&tree, &shut, &unsorted, "", &missing, &toggled))), vec!["▸Trips", "▸Garden", "[Unsorted 1]", "loose.md"]);
        let open: HashSet<String> = ["trips".into(), "lisbon".into()].into();
        assert_eq!(
            labels(&tree_rows(&inputs(&tree, &open, &unsorted, "", &missing, &toggled))),
            vec!["▾Trips", "  ▾Lisbon", "    tram.md", "  packing.md", "  visa.md (missing)", "▸Garden", "[Unsorted 1]", "loose.md"]
        );
        let empty: Vec<FolderNode> = Vec::new();
        assert_eq!(labels(&tree_rows(&inputs(&empty, &shut, &[], "", &missing, &toggled))), vec!["[Unsorted 0]"]);
    }

    #[test]
    fn search_filters_folders_and_files_and_opens_the_way() {
        let tree = sample();
        let unsorted = vec![PathBuf::from("/n/tramline.md"), PathBuf::from("/n/other.md")];
        let (missing, toggled, shut) = (HashSet::new(), HashMap::new(), HashSet::new());
        assert_eq!(
            labels(&tree_rows(&inputs(&tree, &shut, &unsorted, "tram", &missing, &toggled))),
            vec!["▾Trips", "  ▾Lisbon", "    tram.md", "[Unsorted 1]", "tramline.md"]
        );
        // A matching folder shows everything in it.
        assert_eq!(labels(&tree_rows(&inputs(&tree, &shut, &unsorted, "GARDEN", &missing, &toggled))), vec!["▾Garden", "  seeds.md"]);
        assert!(tree_rows(&inputs(&tree, &shut, &unsorted, "zzz", &missing, &toggled)).is_empty());
    }

    #[test]
    fn automatic_groups_show_only_when_on() {
        let f = |p: &str| {
            let (dir, name) = p.rsplit_once('/').unwrap();
            EngineFile { path: p.into(), name: name.into(), dir: dir.into(), mtime_ms: 1.0, birthtime_ms: None, fm_project: None, fm_block: None, repo_name: None }
        };
        let mut state = ProjectsState {
            taxonomy: Taxonomy {
                projects: vec![ProjectNode { key: "orchard".into(), name: "orchard".into(), made: 0., updated: 0., file_count: 1, blocks: vec![], loose_files: vec![f("/c/orchard/a.md")], is_unfiled: false }],
                ..Default::default()
            },
            ..Default::default()
        };
        let (missing, shut) = (HashSet::new(), HashSet::new());
        let toggled: HashMap<String, bool> = [("orchard".to_string(), true)].into();
        let mut i = inputs(&[], &shut, &[], "", &missing, &toggled);
        i.state = Some(&state);
        assert_eq!(labels(&tree_rows(&i)), vec!["[Unsorted 0]"], "off: no automatic groups");
        state.auto = true;
        let mut i = inputs(&[], &shut, &[], "", &missing, &toggled);
        i.state = Some(&state);
        assert_eq!(labels(&tree_rows(&i)), vec!["[Automatic 1]", "<orchard>", "  a.md", "[Unsorted 0]"]);
    }

    #[test]
    fn unsorted_is_recent_and_released_files_no_folder_holds() {
        let recent = vec![(PathBuf::from("/n/a.md"), "2026-11-20T10:00:00Z".to_string()), (PathBuf::from("/n/b.md"), "2026-11-19T10:00:00Z".to_string())];
        let released = vec![("/n/c.md".to_string(), "2026-11-21T10:00:00.000Z".to_string()), ("/n/a.md".to_string(), "2026-11-01T00:00:00.000Z".to_string())];
        let placed: HashSet<String> = ["/n/b.md".to_string()].into();
        let got = unsorted_list(&recent, &released, &placed, &HashSet::new());
        assert_eq!(got, vec![PathBuf::from("/n/c.md"), PathBuf::from("/n/a.md")]);
    }

    fn items(v: &[&str]) -> Vec<Item> {
        v.iter().map(|s| Item::File((*s).into())).collect()
    }

    #[test]
    fn cmd_and_shift_clicks_select_like_finder() {
        let order = items(&["a", "b", "c", "d", "e"]);
        let mut s = Selection::default();
        s.press(&order[1], false, false, &order);
        assert_eq!(s.items, items(&["b"]));
        s.press(&order[3], false, true, &order);
        assert_eq!(s.items, items(&["b", "c", "d"]), "⇧ selects the range from the anchor");
        s.press(&order[0], false, true, &order);
        assert_eq!(s.items, items(&["a", "b"]), "⇧ again re-ranges from the same anchor");
        s.press(&order[4], true, false, &order);
        assert_eq!(s.items, items(&["a", "b", "e"]), "⌘ adds");
        s.press(&order[0], true, false, &order);
        assert_eq!(s.items, items(&["b", "e"]), "⌘ on a selected row takes it out");
        s.press(&order[2], true, true, &order);
        assert_eq!(s.items, items(&["b", "e", "a", "c"]), "⌘⇧ adds the range from the last ⌘-click");
        assert_eq!(s.drag_set(&order[1], &order), items(&["a", "b", "c", "e"]), "a drag carries the selection in drawn order");
        assert_eq!(s.drag_set(&order[3], &order), items(&["d"]), "dragging an unselected row carries only it");
        s.select_all(&order);
        assert_eq!(s.items.len(), 5);
        s.retain(&order[..2]);
        assert_eq!(s.items, items(&["a", "b"]));
        s.clear();
        assert!(s.items.is_empty());
    }

    #[test]
    fn arrows_move_the_cursor_and_shift_extends() {
        let order = items(&["a", "b", "c"]);
        let mut s = Selection::default();
        s.step(true, false, &order);
        assert_eq!(s.cursor, Some(order[0].clone()));
        s.step(true, true, &order);
        s.step(true, true, &order);
        assert_eq!(s.items, items(&["a", "b", "c"]));
        s.step(true, false, &order);
        assert_eq!(s.items, items(&["c"]), "the bottom edge holds");
        s.step(false, false, &order);
        assert_eq!(s.cursor, Some(order[1].clone()));
    }

    #[test]
    fn drop_zones_and_targets() {
        let folder = Row::Folder { id: "f".into(), name: "F".into(), depth: 0, open: false, files: 0, has_children: false };
        let placed = Row::File { path: "/n/a.md".into(), name: "a.md".into(), depth: 1, folder: Some("f".into()), missing: false };
        let loose = Row::File { path: "/n/b.md".into(), name: "b.md".into(), depth: 0, folder: None, missing: false };
        assert_eq!(zone_for(&folder, 100., 26., 101.), Zone::Before);
        assert_eq!(zone_for(&folder, 100., 26., 113.), Zone::Into);
        assert_eq!(zone_for(&folder, 100., 26., 125.), Zone::After);
        assert_eq!(zone_for(&placed, 100., 26., 110.), Zone::Before);
        assert_eq!(zone_for(&placed, 100., 26., 120.), Zone::After);
        assert_eq!(target_for(&folder, Zone::Into), Some(Target::Into("f".into())));
        assert_eq!(target_for(&placed, Zone::Before), Some(Target::Before(Item::File("/n/a.md".into()))));
        assert_eq!(target_for(&loose, Zone::After), Some(Target::Unsorted));
        let section = Row::Section { kind: SectionKind::Automatic, count: 1, open: true };
        assert_eq!(target_for(&section, Zone::Into), None);
    }

    #[test]
    fn a_folder_never_drops_into_itself_or_its_insides() {
        let tree = sample();
        let trips = vec![Item::Folder("trips".into())];
        assert!(!drop_allowed(&trips, &Target::Into("trips".into()), &tree));
        assert!(!drop_allowed(&trips, &Target::Into("lisbon".into()), &tree));
        assert!(!drop_allowed(&trips, &Target::Before(Item::Folder("trips".into())), &tree));
        assert!(drop_allowed(&trips, &Target::Into("garden".into()), &tree));
        assert!(drop_allowed(&[Item::Folder("lisbon".into())], &Target::After(Item::Folder("garden".into())), &tree));
        assert!(!drop_allowed(&trips, &Target::Unsorted, &tree), "a folder alone cannot be unsorted");
        assert!(drop_allowed(&items(&["/n/tram.md"]), &Target::Unsorted, &tree));
        assert!(!drop_allowed(&items(&["/n/tram.md"]), &Target::Before(Item::File("/n/tram.md".into())), &tree));
    }

    #[test]
    fn menus_fit_what_is_selected() {
        let acts = |v: Vec<MenuEntry>| v.into_iter().map(|e| e.action).collect::<Vec<_>>();
        use MenuAction::*;
        assert_eq!(acts(menu_entries(&[], 0, false)), vec![NewFolder, AddFiles]);
        assert_eq!(acts(menu_entries(&[Item::Folder("f".into())], 0, false)), vec![NewFolderInside, NewDocument, AddFiles, Rename, MoveTo, DeleteFolder]);
        assert_eq!(acts(menu_entries(&items(&["a"]), 1, false)), vec![Open, Reveal, MoveTo, RemoveFromFolder, MakePrivate]);
        assert_eq!(acts(menu_entries(&items(&["a"]), 0, false)), vec![Open, Reveal, MoveTo, MakePrivate], "an Unsorted file has no folder to leave");
        assert_eq!(acts(menu_entries(&items(&["a"]), 1, true)), vec![Locate, Forget]);
        let many = menu_entries(&items(&["a", "b", "c"]), 2, false);
        assert_eq!(many[0].label, "Open 3 Documents");
        assert_eq!(many[2].label, "Remove 2 from Folder");
        assert!(menu_entries(&[Item::Folder("f".into())], 0, false).iter().any(|e| e.danger && e.action == DeleteFolder));
    }

    #[test]
    fn move_to_lists_every_folder_and_blocks_the_moving_ones() {
        let tree = sample();
        let d = destinations(&tree, &[Item::Folder("trips".into())]);
        let got: Vec<(String, usize, bool)> = d.iter().map(|x| (x.name.clone(), x.depth, x.disabled)).collect();
        assert_eq!(
            got,
            vec![("Unsorted (no folder)".into(), 0, false), ("Trips".into(), 0, true), ("Lisbon".into(), 1, true), ("Garden".into(), 0, false)]
        );
    }

    #[test]
    fn the_delete_confirm_says_what_happens() {
        let (title, body) = delete_message("Trips", folders::DeleteImpact { files: 3, subfolders: 1 });
        assert_eq!(title, "Delete the folder \u{201c}Trips\u{201d}?");
        assert!(body.starts_with("All 3 files in it go back to Unsorted. The folder inside it is deleted too."));
        assert!(body.contains("Nothing is deleted from your disk."));
        let (_, body) = delete_message("X", folders::DeleteImpact { files: 0, subfolders: 0 });
        assert!(body.starts_with("It holds no files. Nothing"));
    }

    #[test]
    fn new_documents_get_an_unused_untitled_name() {
        let taken: HashSet<PathBuf> = [PathBuf::from("/d/Untitled.md"), PathBuf::from("/d/Untitled 2.md")].into();
        assert_eq!(untitled_path(Path::new("/d"), |p| taken.contains(p)), PathBuf::from("/d/Untitled 3.md"));
        assert_eq!(untitled_path(Path::new("/e"), |_| false), PathBuf::from("/e/Untitled.md"));
    }

    /// The pieces `follow_move` calls, on fixtures: one rename carries the
    /// recent, the star, the folder placement, the project pin, office
    /// recovery and comments.
    #[test]
    fn a_move_carries_every_record() {
        use markie_cloud::comments::local::LocalComments;
        use markie_core::office_recovery::RecoveryStore;
        use markie_core::registry::Registry;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let (from, to) = (dir.path().join("a.docx"), dir.path().join("b.docx"));
        let notes = (dir.path().join("n.md"), dir.path().join("m.md"));
        std::fs::write(&from, b"x").unwrap();
        std::fs::write(&notes.0, "hello world").unwrap();
        let reg = Registry::in_memory().unwrap();
        reg.track_opened(&from).unwrap();
        reg.toggle_star(&from, "file").unwrap();
        markie_core::projects::store::ensure_tables(reg.conn()).unwrap();
        markie_core::projects::store::pin_set(reg.conn(), &from.to_string_lossy(), "P", None).unwrap();
        let folder = folders::create_folder(reg.conn(), None, "Trips").unwrap();
        folders::place_files(reg.conn(), &[from.to_string_lossy().into_owned()], &folder, None).unwrap();
        let recovery = RecoveryStore::new(&data);
        recovery.put(&from, "docx", b"x").unwrap();
        let comments = LocalComments::new(&data);
        comments.add_from_agent(&notes.0, "hello world", "world", "a note", None, None, None, "agent").unwrap();

        std::fs::rename(&from, &to).unwrap();
        std::fs::rename(&notes.0, &notes.1).unwrap();
        reg.move_path(&from, &to).unwrap();
        recovery.moved(&from, &to).unwrap();
        assert_eq!(comments.move_records(&notes.0, &notes.1), 1);

        assert_eq!(reg.recent(5).unwrap()[0].path, to);
        assert!(reg.is_starred(&to).unwrap());
        assert_eq!(markie_core::projects::store::pins_all(reg.conn()).unwrap()[0].path, to.to_string_lossy());
        assert_eq!(folders::tree(reg.conn()).unwrap()[0].files, vec![to.to_string_lossy().into_owned()], "the folder follows the rename");
        assert_eq!(recovery.list(&to).len(), 1);
        assert!(recovery.list(&from).is_empty());
        assert_eq!(comments.threads(&notes.1).len(), 1);
    }
}
