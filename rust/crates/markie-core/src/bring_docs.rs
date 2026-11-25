//! "Bring your documents": the folders a new person already keeps documents
//! in, counted, then made Library roots and Projects folders.
//!
//! Nothing here moves, copies or writes a file on disk. A folder that is
//! brought in becomes a registered root (Browse and Search see it) and one
//! Projects folder, with a subfolder for each of its folders that holds
//! documents. The whole import is one ⌘Z (`folders::History::push`).
//!
//! Three rules shape it:
//!
//! - **Never suggest `~/Downloads`**, and never pre-tick anything outside
//!   Documents and the folders Markie already knew.
//! - **Never look inside a protected folder before the person asks.** macOS
//!   asks permission the first time an app reads Desktop, Documents or iCloud
//!   Drive. Discovery only checks that those folders exist; their counting
//!   starts when the person taps them, so the prompt follows a tap.
//! - **Counting is the index walk** (`index.rs`) with the folder as its only
//!   root, inside the index's budgets, stopped at [`COUNT_CAP`] documents.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use anyhow::Result;
use rusqlite::Connection;

use crate::formats::FormatKind;
use crate::index::{self, Budget, ScanOptions, Truncation};
use crate::projects::{folders, store};

/// Past this many documents a folder shows "10,000+", and an import places
/// this many in Projects. The rest are still in Browse and Search.
pub const COUNT_CAP: usize = 10_000;
/// Projects subfolders go this deep below the imported folder. Files deeper
/// down land in the deepest one.
pub const FOLDER_DEPTH: usize = 4;
/// How deep discovery looks for Obsidian vaults and Notion exports.
const SPECIAL_DEPTH: usize = 3;
/// Which Projects folder each imported folder became: `{path: folder id}`.
pub const ROOTS_KEY: &str = "rs.bring_docs.roots.v1";
/// The first-run step has been shown (or skipped) on this install.
pub const SHOWN_KEY: &str = "markie.bring_docs.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CandidateKind {
    Documents,
    Desktop,
    ICloudDrive,
    Obsidian,
    Notion,
    /// A folder Markie already knew: a root brought over from the Electron
    /// app (`import.rs`) or registered before.
    Markie,
    /// Picked in the folder panel.
    Chosen,
}

impl CandidateKind {
    /// The line under the folder's name.
    pub fn detail(self) -> &'static str {
        match self {
            CandidateKind::Documents => "Your Documents folder",
            CandidateKind::Desktop => "Files on your Desktop",
            CandidateKind::ICloudDrive => "iCloud Drive",
            CandidateKind::Obsidian => "Obsidian vault",
            CandidateKind::Notion => "Notion export",
            CandidateKind::Markie => "A folder Markie already knows",
            CandidateKind::Chosen => "A folder you chose",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub kind: CandidateKind,
    pub name: String,
    /// macOS asks before Markie can read it: count only after a tap.
    pub protected: bool,
    pub preticked: bool,
    /// Already brought in: its Projects folder is there.
    pub imported: bool,
}

fn display_name(path: &Path, kind: CandidateKind) -> String {
    match kind {
        CandidateKind::ICloudDrive => "iCloud Drive".into(),
        _ => path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string()),
    }
}

pub fn icloud_drive(home: &Path) -> PathBuf {
    home.join("Library").join("Mobile Documents").join("com~apple~CloudDocs")
}

/// `~/Downloads`, or anything inside it.
pub fn is_downloads(home: &Path, path: &Path) -> bool {
    let downloads = home.join("Downloads");
    path.starts_with(&downloads)
        || fs::canonicalize(path).ok().zip(fs::canonicalize(&downloads).ok()).is_some_and(|(p, d)| p.starts_with(d))
}

/// Inside a folder macOS guards with a permission prompt.
pub fn is_protected(home: &Path, path: &Path) -> bool {
    [home.join("Desktop"), home.join("Documents"), home.join("Downloads"), home.join("Library").join("Mobile Documents")]
        .iter()
        .any(|p| path.starts_with(p))
}

fn candidate(home: &Path, path: PathBuf, kind: CandidateKind, imported: &HashSet<PathBuf>) -> Candidate {
    let done = imported.contains(&path);
    Candidate {
        name: display_name(&path, kind),
        protected: is_protected(home, &path),
        // Documents and the folders Markie already knew, and nothing else.
        preticked: !done && matches!(kind, CandidateKind::Documents | CandidateKind::Markie),
        imported: done,
        kind,
        path,
    }
}

/// The step's list, in order: Documents, Desktop, iCloud Drive, the folders
/// Markie knew, then vaults and exports found outside the protected folders.
/// Never Downloads. Reads no protected folder's contents.
pub fn discover(home: &Path, known_roots: &[PathBuf], imported: &HashSet<PathBuf>, cancel: &AtomicBool) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    let push = |c: Candidate, out: &mut Vec<Candidate>| {
        if !is_downloads(home, &c.path) && !out.iter().any(|o| o.path == c.path) {
            out.push(c);
        }
    };
    for (path, kind) in [
        (home.join("Documents"), CandidateKind::Documents),
        (home.join("Desktop"), CandidateKind::Desktop),
        (icloud_drive(home), CandidateKind::ICloudDrive),
    ] {
        if path.is_dir() {
            push(candidate(home, path, kind, imported), &mut out);
        }
    }
    for root in known_roots {
        if root.is_dir() && root != home {
            push(candidate(home, root.clone(), CandidateKind::Markie, imported), &mut out);
        }
    }
    // Vaults and exports in the places that need no permission: home's own
    // folders and the roots Markie knew, when they are not protected.
    let mut places: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(home) {
        let mut kids: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                !index::is_excluded_dir(&name) && !is_protected(home, p)
            })
            .collect();
        kids.sort();
        places.extend(kids);
    }
    places.extend(known_roots.iter().filter(|r| !is_protected(home, r)).cloned());
    let known: Vec<PathBuf> = out.iter().filter(|c| c.kind == CandidateKind::Markie).map(|c| c.path.clone()).collect();
    let mut specials = Vec::new();
    for place in places {
        specials.extend(find_specials(&place, SPECIAL_DEPTH, cancel));
    }
    for (path, kind) in specials {
        // Inside a folder Markie knew: that folder already brings it.
        if known.iter().any(|k| path.starts_with(k) && path != *k) {
            continue;
        }
        push(candidate(home, path, kind, imported), &mut out);
    }
    out
}

/// A Notion export names pages "Title <32 hex>.md" and databases
/// "Title <32 hex>.csv" (or "_all.csv").
pub fn is_notion_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    if !(ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("csv")) {
        return false;
    }
    let stem = stem.strip_suffix("_all").unwrap_or(stem);
    let Some(id) = stem.get(stem.len().saturating_sub(32)..) else { return false };
    let before = &stem[..stem.len() - id.len()];
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) && (before.is_empty() || before.ends_with(' '))
}

/// Obsidian vaults (a `.obsidian` folder) and Notion exports at or below
/// `dir`, at most `depth` folders down. A vault or export is not searched
/// further. Symbolic links are never followed.
pub fn find_specials(dir: &Path, depth: usize, cancel: &AtomicBool) -> Vec<(PathBuf, CandidateKind)> {
    let mut out = Vec::new();
    walk_specials(dir, depth, cancel, &mut out);
    out
}

fn walk_specials(dir: &Path, depth: usize, cancel: &AtomicBool, out: &mut Vec<(PathBuf, CandidateKind)>) {
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut subdirs = Vec::new();
    let mut notion = false;
    for entry in entries.flatten() {
        let Ok(t) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if t.is_dir() {
            if name == ".obsidian" {
                out.push((dir.to_path_buf(), CandidateKind::Obsidian));
                return;
            }
            if !index::is_excluded_dir(&name) {
                subdirs.push(entry.path());
            }
        } else if t.is_file() && is_notion_name(&name) {
            notion = true;
        }
    }
    if notion {
        out.push((dir.to_path_buf(), CandidateKind::Notion));
        return;
    }
    if depth == 0 {
        return;
    }
    subdirs.sort();
    for sub in subdirs {
        walk_specials(&sub, depth - 1, cancel, out);
    }
}

// ------------------------------------------------------------------ counting

/// Documents by the four kinds the step shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TypeCounts {
    pub markdown: usize,
    pub word: usize,
    pub text: usize,
    pub csv: usize,
}

impl TypeCounts {
    pub fn total(&self) -> usize {
        self.markdown + self.word + self.text + self.csv
    }

    /// Count one file. False for a kind the step does not bring in.
    pub fn add(&mut self, format: FormatKind) -> bool {
        let slot = match format {
            FormatKind::Markdown | FormatKind::Darkmown => &mut self.markdown,
            FormatKind::Docx | FormatKind::Doc | FormatKind::Rtf | FormatKind::Odt => &mut self.word,
            FormatKind::Text => &mut self.text,
            FormatKind::Csv => &mut self.csv,
            _ => return false,
        };
        *slot += 1;
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CountOutcome {
    Done,
    /// More than [`COUNT_CAP`], or the index budget ran out first.
    Capped,
    /// macOS or the folder's permissions said no.
    NoAccess,
    Missing,
    Cancelled,
}

#[derive(Clone, Debug)]
pub struct FolderCount {
    pub counts: TypeCounts,
    pub outcome: CountOutcome,
    /// The documents found, at most [`COUNT_CAP`]: what an import places.
    pub files: Vec<PathBuf>,
    /// Vaults and exports inside the folder, for the list.
    pub specials: Vec<(PathBuf, CandidateKind)>,
}

impl FolderCount {
    fn empty(outcome: CountOutcome) -> Self {
        Self { counts: TypeCounts::default(), outcome, files: Vec::new(), specials: Vec::new() }
    }
}

/// Count the documents in `root`. Runs on the calling thread: call it from a
/// background task. `found` moves as the walk goes; `cancel` stops it at the
/// next folder.
pub fn count_folder(root: &Path, home: &Path, cancel: &AtomicBool, found: &AtomicUsize) -> FolderCount {
    match fs::read_dir(root) {
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return FolderCount::empty(CountOutcome::Missing),
        Err(_) => return FolderCount::empty(CountOutcome::NoAccess),
    }
    let opts = ScanOptions {
        home: home.to_path_buf(),
        roots: vec![root.to_path_buf()],
        include_home: false,
        configured_skill_dirs: Vec::new(),
        budget: Budget { max_files: COUNT_CAP + 1, ..Budget::default() },
    };
    let snap = index::scan_cancellable(&opts, Some(found), Some(cancel));
    if cancel.load(Ordering::Relaxed) {
        return FolderCount::empty(CountOutcome::Cancelled);
    }
    let mut counts = TypeCounts::default();
    let mut files = Vec::new();
    for doc in &snap.files {
        if counts.add(doc.format) && files.len() < COUNT_CAP {
            files.push(doc.path.clone());
        }
    }
    let capped = counts.total() > COUNT_CAP || matches!(snap.truncated, Some(Truncation::Files | Truncation::Time));
    let specials = find_specials(root, SPECIAL_DEPTH, cancel).into_iter().filter(|(p, _)| p != root).collect();
    FolderCount { counts, outcome: if capped { CountOutcome::Capped } else { CountOutcome::Done }, files, specials }
}

/// 1234 as "1,234".
pub fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// "1,204 documents", "10,000+ documents", "1 document".
pub fn total_label(n: usize, capped: bool) -> String {
    if capped || n > COUNT_CAP {
        return format!("{}+ documents", thousands(COUNT_CAP));
    }
    format!("{} document{}", thousands(n), if n == 1 { "" } else { "s" })
}

/// "1,204 Markdown · 32 Word · 2 CSV": the kinds there are, in order.
pub fn kinds_line(c: &TypeCounts, capped: bool) -> String {
    let plus = if capped { "+" } else { "" };
    [(c.markdown, "Markdown"), (c.word, "Word"), (c.text, "text"), (c.csv, "CSV")]
        .iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, k)| format!("{}{plus} {k}", thousands(*n)))
        .collect::<Vec<_>>()
        .join(" · ")
}

// ---------------------------------------------------------------- the import

/// One Projects folder to make, mirroring a folder on disk that holds documents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanNode {
    pub name: String,
    pub files: Vec<PathBuf>,
    pub children: Vec<PlanNode>,
}

impl PlanNode {
    pub fn file_count(&self) -> usize {
        self.files.len() + self.children.iter().map(PlanNode::file_count).sum::<usize>()
    }
}

/// The Projects folder `root` becomes, named `name`: a subfolder for each
/// folder under it that holds documents, at most [`FOLDER_DEPTH`] deep.
/// Files outside `root` are ignored.
pub fn plan(root: &Path, name: &str, files: &[PathBuf]) -> PlanNode {
    let mut top = PlanNode { name: name.to_string(), files: Vec::new(), children: Vec::new() };
    for file in files {
        let Ok(rel) = file.strip_prefix(root) else { continue };
        let dirs: Vec<String> = rel
            .parent()
            .into_iter()
            .flat_map(|p| p.components())
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .take(FOLDER_DEPTH)
            .collect();
        let mut at = &mut top;
        for d in dirs {
            let i = match at.children.iter().position(|c| c.name == d) {
                Some(i) => i,
                None => {
                    at.children.push(PlanNode { name: d, files: Vec::new(), children: Vec::new() });
                    at.children.len() - 1
                }
            };
            at = &mut at.children[i];
        }
        at.files.push(file.clone());
    }
    fn sort(n: &mut PlanNode) {
        n.children.sort_by_key(|c| c.name.to_lowercase());
        n.files.sort_by_key(|f| f.file_name().map(|s| s.to_string_lossy().to_lowercase()));
        n.children.iter_mut().for_each(sort);
    }
    sort(&mut top);
    top
}

/// The folders to import, with any already inside another dropped: the
/// outer folder brings it, as one of its subfolders.
pub fn outermost(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for r in roots {
        if !out.contains(r) && !roots.iter().any(|o| o != r && r.starts_with(o)) {
            out.push(r.clone());
        }
    }
    out
}

/// Imported folders whose Projects folder is still there, by path.
pub fn imported_roots(db: &Connection) -> Result<HashMap<PathBuf, String>> {
    let map = read_map(db)?;
    let mut out = HashMap::new();
    for (path, id) in map {
        if folders::folder(db, &id)?.is_some() {
            out.insert(PathBuf::from(path), id);
        }
    }
    Ok(out)
}

fn read_map(db: &Connection) -> Result<HashMap<String, String>> {
    store::ensure_tables(db)?;
    Ok(store::config_get(db, ROOTS_KEY)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

enum Op {
    /// Make (or find) folder `slot`. `parent: None` is an imported folder's
    /// own top-level folder, kept for `root`.
    Folder { slot: usize, parent: Option<usize>, name: String, root: Option<PathBuf> },
    Files { slot: usize, paths: Vec<String> },
}

/// An import run a few hundred files at a time, so a large one can show its
/// progress and leave the window free between steps.
///
/// Running it again over the same folder adds only what is new: its Projects
/// folder and subfolders are found again by name, and a file already in any
/// folder stays where it is, so nothing is duplicated and a file the person
/// moved is not taken back.
pub struct Importer {
    ops: VecDeque<Op>,
    ids: Vec<Option<String>>,
    placed: HashSet<String>,
    map: HashMap<String, String>,
    pub total: usize,
    pub done: usize,
    /// Files placed: `done` less those already in a folder.
    pub added: usize,
    /// Top-level Projects folders this import made or filled, in order.
    pub folders: Vec<String>,
}

const CHUNK: usize = 400;

impl Importer {
    pub fn new(db: &Connection, roots: Vec<(PathBuf, PlanNode)>) -> Result<Self> {
        folders::ensure_tables(db)?;
        let mut ops = VecDeque::new();
        let mut slots = 0usize;
        let mut total = 0usize;
        fn push(node: &PlanNode, parent: Option<usize>, root: Option<PathBuf>, slots: &mut usize, total: &mut usize, ops: &mut VecDeque<Op>) {
            let slot = *slots;
            *slots += 1;
            ops.push_back(Op::Folder { slot, parent, name: node.name.clone(), root });
            for chunk in node.files.chunks(CHUNK) {
                *total += chunk.len();
                ops.push_back(Op::Files { slot, paths: chunk.iter().map(|p| p.to_string_lossy().into_owned()).collect() });
            }
            for child in &node.children {
                push(child, Some(slot), None, slots, total, ops);
            }
        }
        for (root, node) in &roots {
            push(node, None, Some(root.clone()), &mut slots, &mut total, &mut ops);
        }
        Ok(Self {
            ops,
            ids: vec![None; slots],
            placed: folders::placed_paths(db)?,
            map: read_map(db)?,
            total,
            done: 0,
            added: 0,
            folders: Vec::new(),
        })
    }

    pub fn finished(&self) -> bool {
        self.ops.is_empty()
    }

    /// Run until about `budget` files are placed. True when the import is done.
    pub fn step(&mut self, db: &Connection, budget: usize) -> Result<bool> {
        let mut spent = 0usize;
        while spent < budget.max(1) {
            let Some(op) = self.ops.pop_front() else { break };
            match op {
                Op::Folder { slot, parent, name, root } => {
                    let id = match (parent, root) {
                        (None, Some(root)) => self.root_folder(db, &root, &name)?,
                        (Some(p), _) => {
                            let parent = self.ids[p].clone().unwrap_or_default();
                            child_named(db, &parent, &name)?.map_or_else(|| folders::create_folder(db, Some(&parent), &name), Ok)?
                        }
                        (None, None) => folders::create_folder(db, None, &name)?,
                    };
                    self.ids[slot] = Some(id);
                    spent += 1;
                }
                Op::Files { slot, paths } => {
                    let n = paths.len();
                    let fresh: Vec<String> = paths.into_iter().filter(|p| self.placed.insert(p.clone())).collect();
                    if let Some(id) = &self.ids[slot]
                        && !fresh.is_empty()
                    {
                        folders::place_files(db, &fresh, id, None)?;
                    }
                    self.added += fresh.len();
                    self.done += n;
                    spent += n;
                }
            }
        }
        if self.ops.is_empty() {
            store::config_set(db, ROOTS_KEY, &serde_json::to_string(&self.map)?)?;
        }
        Ok(self.ops.is_empty())
    }

    /// Run to the end in one go: for small imports.
    pub fn run(&mut self, db: &Connection) -> Result<()> {
        while !self.step(db, usize::MAX)? {}
        Ok(())
    }

    fn root_folder(&mut self, db: &Connection, root: &Path, name: &str) -> Result<String> {
        let key = root.to_string_lossy().into_owned();
        let id = match self.map.get(&key) {
            Some(id) if folders::folder(db, id)?.is_some() => id.clone(),
            _ => folders::create_folder(db, None, name)?,
        };
        self.map.insert(key, id.clone());
        self.folders.push(id.clone());
        Ok(id)
    }
}

/// One folder's documents into its Projects folder, in one go: for an
/// import that already knows its files, such as Google Docs. Returns how
/// many were placed. Safe to call after every import of the same folder.
pub fn bring_folder(db: &Connection, root: &Path, name: &str, files: &[PathBuf]) -> Result<usize> {
    let mut job = Importer::new(db, vec![(root.to_path_buf(), plan(root, name, files))])?;
    job.run(db)?;
    Ok(job.added)
}

fn child_named(db: &Connection, parent: &str, name: &str) -> Result<Option<String>> {
    Ok(folders::folders_all(db)?
        .into_iter()
        .find(|f| f.parent.as_deref() == Some(parent) && f.name.to_lowercase() == name.to_lowercase())
        .map(|f| f.id))
}

#[cfg(test)]
mod tests;
