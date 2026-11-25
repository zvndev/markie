//! Markie's own folders: the organization a person builds by hand in the
//! Projects tab. Folders nest to any depth; each holds subfolders, then files,
//! each in a manual order. A file sits in at most one folder.
//!
//! Nothing here ever moves, renames or deletes a file on disk. A folder is a
//! row in the registry, and a file "in" it is a row keyed by its path, so a
//! file inside a code repository never breaks. Deleting a folder sends its
//! files back to Unsorted.
//!
//! Hand placement always wins: when automatic grouping is on (Settings), the
//! rules and clustering of the older taxonomy see only the files no folder
//! holds.
//!
//! Every organize action is undoable: the app takes a [`Snapshot`] before it
//! and puts it back on ⌘Z. The tables are small, so a snapshot is cheap.
//!
//! Tables (registry schema v3, created idempotently):
//! - `folders`: id, parent (none at the top), name, position among siblings.
//! - `folder_items`: one row per placed file, keyed by `path` so the
//!   registry's move and rename follow it (`Registry::move_path`).
//! - `folder_released`: files that left a folder, so Unsorted can list them
//!   even when they were never opened here.

use std::collections::{HashMap, HashSet};

use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};

use super::store;

/// `projects_config` key: "on" when automatic grouping is on. Absent is off.
pub const AUTO_KEY: &str = "auto-organize";
/// `projects_config` key: set once the old groups became folders (or there were none).
pub const MIGRATED_KEY: &str = "folders-migrated";
const DEFAULT_NAME: &str = "Untitled Folder";

pub fn ensure_tables(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS folders (
           id         TEXT PRIMARY KEY,
           parent_id  TEXT,
           name       TEXT NOT NULL,
           position   INTEGER NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent_id);
         CREATE TABLE IF NOT EXISTS folder_items (
           path      TEXT PRIMARY KEY,
           folder_id TEXT NOT NULL,
           position  INTEGER NOT NULL,
           added_at  TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS folder_items_folder ON folder_items(folder_id);
         CREATE TABLE IF NOT EXISTS folder_released (
           path        TEXT PRIMARY KEY,
           released_at TEXT NOT NULL
         );",
    )?;
    Ok(())
}

fn now() -> String {
    super::iso_from_ms(super::now_ms())
}

fn canonical(p: &str) -> String {
    if cfg!(windows) { p.to_lowercase() } else { p.to_string() }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    pub id: String,
    pub parent: Option<String>,
    pub name: String,
    pub position: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
    pub path: String,
    pub folder: String,
    pub position: i64,
    pub added_at: String,
}

/// A folder with what it holds, in order: subfolders first, then files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderNode {
    pub id: String,
    pub name: String,
    pub children: Vec<FolderNode>,
    pub files: Vec<String>,
}

impl FolderNode {
    /// Files here and in every subfolder.
    pub fn file_count(&self) -> usize {
        self.files.len() + self.children.iter().map(FolderNode::file_count).sum::<usize>()
    }
    pub fn folder_count(&self) -> usize {
        self.children.len() + self.children.iter().map(FolderNode::folder_count).sum::<usize>()
    }
}

/// One thing a person picked up: a folder or a file.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Item {
    Folder(String),
    File(String),
}

/// Where a drop lands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// Inside a folder: folders go after its subfolders, files after its files.
    Into(String),
    /// Just above or below a row.
    Before(Item),
    After(Item),
    /// Out of every folder.
    Unsorted,
    /// The end of the top level (folders only; a file there goes to Unsorted).
    TopEnd,
}

pub fn folders_all(db: &Connection) -> Result<Vec<Folder>> {
    let mut stmt = db.prepare("SELECT id, parent_id, name, position, created_at FROM folders ORDER BY position, created_at")?;
    let rows = stmt
        .query_map([], |r| Ok(Folder { id: r.get(0)?, parent: r.get(1)?, name: r.get(2)?, position: r.get(3)?, created_at: r.get(4)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn placements_all(db: &Connection) -> Result<Vec<Placement>> {
    let mut stmt = db.prepare("SELECT path, folder_id, position, added_at FROM folder_items ORDER BY position, added_at")?;
    let rows = stmt
        .query_map([], |r| Ok(Placement { path: r.get(0)?, folder: r.get(1)?, position: r.get(2)?, added_at: r.get(3)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Files that left a folder, newest first, with when.
pub fn released_all(db: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = db.prepare("SELECT path, released_at FROM folder_released ORDER BY released_at DESC")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The folder a file is in, if any.
pub fn folder_of(db: &Connection, path: &str) -> Result<Option<String>> {
    Ok(db.query_row("SELECT folder_id FROM folder_items WHERE path = ?1", [canonical(path)], |r| r.get(0)).optional()?)
}

/// Every placed path, for excluding them from automatic grouping.
pub fn placed_paths(db: &Connection) -> Result<HashSet<String>> {
    let mut stmt = db.prepare("SELECT path FROM folder_items")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<HashSet<_>, _>>()?;
    Ok(rows)
}

/// The whole tree, top level first, in manual order.
pub fn tree(db: &Connection) -> Result<Vec<FolderNode>> {
    Ok(build_tree(&folders_all(db)?, &placements_all(db)?))
}

pub fn build_tree(folders: &[Folder], items: &[Placement]) -> Vec<FolderNode> {
    let ids: HashSet<&str> = folders.iter().map(|f| f.id.as_str()).collect();
    let mut kids: HashMap<Option<&str>, Vec<&Folder>> = HashMap::new();
    for f in folders {
        // A folder whose parent is gone shows at the top rather than vanishing.
        let parent = f.parent.as_deref().filter(|p| ids.contains(p));
        kids.entry(parent).or_default().push(f);
    }
    for list in kids.values_mut() {
        list.sort_by(|a, b| a.position.cmp(&b.position).then(a.created_at.cmp(&b.created_at)));
    }
    let mut files: HashMap<&str, Vec<&Placement>> = HashMap::new();
    for p in items {
        files.entry(p.folder.as_str()).or_default().push(p);
    }
    for list in files.values_mut() {
        list.sort_by(|a, b| a.position.cmp(&b.position).then(a.added_at.cmp(&b.added_at)));
    }
    fn node(f: &Folder, kids: &HashMap<Option<&str>, Vec<&Folder>>, files: &HashMap<&str, Vec<&Placement>>, guard: &mut HashSet<String>) -> FolderNode {
        guard.insert(f.id.clone());
        let mut children = Vec::new();
        for c in kids.get(&Some(f.id.as_str())).into_iter().flatten() {
            if !guard.contains(&c.id) {
                children.push(node(c, kids, files, guard));
            }
        }
        FolderNode {
            id: f.id.clone(),
            name: f.name.clone(),
            children,
            files: files.get(f.id.as_str()).into_iter().flatten().map(|p| p.path.clone()).collect(),
        }
    }
    let mut guard = HashSet::new();
    let mut out: Vec<FolderNode> = kids.get(&None).into_iter().flatten().map(|f| node(f, &kids, &files, &mut guard)).collect();
    // A cycle left by a bad write: show its folders at the top.
    for f in folders {
        if !guard.contains(&f.id) {
            out.push(node(f, &kids, &files, &mut guard));
        }
    }
    out
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!("fd_{:x}_{n:x}", super::now_ms() as u64)
}

fn sibling_folders(db: &Connection, parent: Option<&str>) -> Result<Vec<Folder>> {
    let mut all: Vec<Folder> = folders_all(db)?.into_iter().filter(|f| f.parent.as_deref() == parent).collect();
    all.sort_by(|a, b| a.position.cmp(&b.position).then(a.created_at.cmp(&b.created_at)));
    Ok(all)
}

fn folder_files(db: &Connection, folder: &str) -> Result<Vec<String>> {
    let mut stmt = db.prepare("SELECT path FROM folder_items WHERE folder_id = ?1 ORDER BY position, added_at")?;
    let rows = stmt.query_map([folder], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn folder(db: &Connection, id: &str) -> Result<Option<Folder>> {
    Ok(db
        .query_row("SELECT id, parent_id, name, position, created_at FROM folders WHERE id = ?1", [id], |r| {
            Ok(Folder { id: r.get(0)?, parent: r.get(1)?, name: r.get(2)?, position: r.get(3)?, created_at: r.get(4)? })
        })
        .optional()?)
}

/// Finder's way: "Name", then "Name 2", "Name 3" among the same siblings.
fn unique_name(db: &Connection, parent: Option<&str>, wanted: &str, except: Option<&str>) -> Result<String> {
    let taken: HashSet<String> = sibling_folders(db, parent)?
        .into_iter()
        .filter(|f| Some(f.id.as_str()) != except)
        .map(|f| f.name.to_lowercase())
        .collect();
    if !taken.contains(&wanted.to_lowercase()) {
        return Ok(wanted.to_string());
    }
    let mut n = 2;
    loop {
        let candidate = format!("{wanted} {n}");
        if !taken.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// New Folder: at the end of the top level or of `parent`'s subfolders.
pub fn create_folder(db: &Connection, parent: Option<&str>, name: &str) -> Result<String> {
    if let Some(p) = parent
        && folder(db, p)?.is_none()
    {
        bail!("That folder is gone.");
    }
    let wanted = name.trim();
    let name = unique_name(db, parent, if wanted.is_empty() { DEFAULT_NAME } else { wanted }, None)?;
    let id = new_id();
    let position = sibling_folders(db, parent)?.len() as i64;
    let at = now();
    db.execute(
        "INSERT INTO folders (id, parent_id, name, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, parent, name, position, at],
    )?;
    Ok(id)
}

/// Rename: a blank name keeps the old one. Returns the name it got.
pub fn rename_folder(db: &Connection, id: &str, name: &str) -> Result<String> {
    let Some(f) = folder(db, id)? else { bail!("That folder is gone.") };
    let wanted = name.trim();
    if wanted.is_empty() || wanted == f.name {
        return Ok(f.name);
    }
    let name = unique_name(db, f.parent.as_deref(), wanted, Some(id))?;
    db.execute("UPDATE folders SET name = ?1, updated_at = ?2 WHERE id = ?3", params![name, now(), id])?;
    Ok(name)
}

/// What deleting a folder would do, for the confirm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeleteImpact {
    pub files: usize,
    pub subfolders: usize,
}

fn descendants(folders: &[Folder], id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![id.to_string()];
    while let Some(at) = stack.pop() {
        for f in folders.iter().filter(|f| f.parent.as_deref() == Some(at.as_str())) {
            if !out.contains(&f.id) && f.id != id {
                out.push(f.id.clone());
                stack.push(f.id.clone());
            }
        }
    }
    out
}

pub fn delete_impact(db: &Connection, id: &str) -> Result<DeleteImpact> {
    let folders = folders_all(db)?;
    let mut all = descendants(&folders, id);
    let subfolders = all.len();
    all.push(id.to_string());
    let mut files = 0;
    for f in &all {
        files += folder_files(db, f)?.len();
    }
    Ok(DeleteImpact { files, subfolders })
}

/// Delete Folder: the folder and every subfolder in it go; every file in
/// them goes back to Unsorted. Nothing on disk is touched.
pub fn delete_folder(db: &Connection, id: &str) -> Result<DeleteImpact> {
    let impact = delete_impact(db, id)?;
    let folders = folders_all(db)?;
    let parent = folders.iter().find(|f| f.id == id).and_then(|f| f.parent.clone());
    let mut all = descendants(&folders, id);
    all.push(id.to_string());
    let tx = db.unchecked_transaction()?;
    let at = now();
    for f in &all {
        tx.execute(
            "INSERT INTO folder_released (path, released_at) SELECT path, ?1 FROM folder_items WHERE folder_id = ?2
             ON CONFLICT(path) DO UPDATE SET released_at = excluded.released_at",
            params![at, f],
        )?;
        tx.execute("DELETE FROM folder_items WHERE folder_id = ?1", [f])?;
        tx.execute("DELETE FROM folders WHERE id = ?1", [f])?;
    }
    tx.commit()?;
    renumber_folders(db, parent.as_deref())?;
    Ok(impact)
}

fn renumber_folders(db: &Connection, parent: Option<&str>) -> Result<()> {
    let ids: Vec<String> = sibling_folders(db, parent)?.into_iter().map(|f| f.id).collect();
    write_folder_order(db, parent, &ids)
}

fn write_folder_order(db: &Connection, parent: Option<&str>, ids: &[String]) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    let at = now();
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE folders SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
            params![parent, i as i64, at, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn write_file_order(db: &Connection, folder: &str, paths: &[String]) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    let at = now();
    for (i, path) in paths.iter().enumerate() {
        tx.execute(
            "INSERT INTO folder_items (path, folder_id, position, added_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET folder_id = excluded.folder_id, position = excluded.position",
            params![path, folder, i as i64, at],
        )?;
        tx.execute("DELETE FROM folder_released WHERE path = ?1", [path])?;
    }
    tx.commit()?;
    Ok(())
}

/// Is `id` the folder `inside` or one of its ancestors? Dropping a folder into
/// itself or its own subfolder would cut it off, so it is refused.
pub fn is_within(folders: &[Folder], inside: &str, id: &str) -> bool {
    let by_id: HashMap<&str, &Folder> = folders.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut at = Some(inside);
    let mut steps = 0;
    while let Some(cur) = at {
        if cur == id {
            return true;
        }
        at = by_id.get(cur).and_then(|f| f.parent.as_deref());
        steps += 1;
        if steps > folders.len() + 1 {
            break;
        }
    }
    false
}

/// Put folders under `parent` (None is the top level) starting at `index`
/// among its subfolders, in the order given.
pub fn move_folders(db: &Connection, ids: &[String], parent: Option<&str>, index: Option<usize>) -> Result<()> {
    let all = folders_all(db)?;
    if let Some(p) = parent
        && !all.iter().any(|f| f.id == p)
    {
        bail!("That folder is gone.");
    }
    let ids: Vec<String> = ids
        .iter()
        .filter(|id| all.iter().any(|f| &f.id == *id))
        .filter(|id| parent.is_none_or(|p| !is_within(&all, p, id)))
        .cloned()
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let old_parents: HashSet<Option<String>> =
        all.iter().filter(|f| ids.contains(&f.id)).map(|f| f.parent.clone()).collect();
    let mut order: Vec<String> = sibling_folders(db, parent)?.into_iter().map(|f| f.id).collect();
    // The index counts rows as they stand, the moved ones included.
    let mut at = index.unwrap_or(order.len()).min(order.len());
    at -= order[..at].iter().filter(|id| ids.contains(id)).count();
    order.retain(|id| !ids.contains(id));
    let at = at.min(order.len());
    for (k, id) in ids.iter().enumerate() {
        order.insert(at + k, id.clone());
    }
    // Names stay unique among their new siblings.
    for id in &ids {
        let f = all.iter().find(|f| &f.id == id).expect("filtered above");
        if f.parent.as_deref() != parent {
            let name = unique_name(db, parent, &f.name, Some(id))?;
            if name != f.name {
                db.execute("UPDATE folders SET name = ?1 WHERE id = ?2", params![name, id])?;
            }
        }
    }
    write_folder_order(db, parent, &order)?;
    for old in old_parents {
        if old.as_deref() != parent {
            renumber_folders(db, old.as_deref())?;
        }
    }
    Ok(())
}

/// Put files in `folder` at `index` among its files (the end when None), in
/// the order given. A file already in another folder leaves it.
pub fn place_files(db: &Connection, paths: &[String], folder_id: &str, index: Option<usize>) -> Result<()> {
    if folder(db, folder_id)?.is_none() {
        bail!("That folder is gone.");
    }
    let mut paths: Vec<String> = paths.iter().map(|p| canonical(p)).collect();
    let mut seen = HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    if paths.is_empty() {
        return Ok(());
    }
    let mut olds = HashSet::new();
    for p in &paths {
        if let Some(old) = folder_of(db, p)?
            && old != folder_id
        {
            olds.insert(old);
        }
    }
    let mut order = folder_files(db, folder_id)?;
    let mut at = index.unwrap_or(order.len()).min(order.len());
    at -= order[..at].iter().filter(|p| paths.contains(p)).count();
    order.retain(|p| !paths.contains(p));
    let at = at.min(order.len());
    for (k, p) in paths.iter().enumerate() {
        order.insert(at + k, p.clone());
    }
    write_file_order(db, folder_id, &order)?;
    for old in olds {
        let left = folder_files(db, &old)?;
        write_file_order(db, &old, &left)?;
    }
    Ok(())
}

/// Remove from Folder: the files go back to Unsorted.
pub fn unplace(db: &Connection, paths: &[String]) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    let at = now();
    for p in paths {
        let p = canonical(p);
        let n = tx.execute("DELETE FROM folder_items WHERE path = ?1", [&p])?;
        if n > 0 {
            tx.execute(
                "INSERT INTO folder_released (path, released_at) VALUES (?1, ?2)
                 ON CONFLICT(path) DO UPDATE SET released_at = excluded.released_at",
                params![p, at],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Remove for a file that is gone: it leaves its folder and Unsorted both.
pub fn forget(db: &Connection, paths: &[String]) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    for p in paths {
        let p = canonical(p);
        tx.execute("DELETE FROM folder_items WHERE path = ?1", [&p])?;
        tx.execute("DELETE FROM folder_released WHERE path = ?1", [&p])?;
    }
    tx.commit()?;
    Ok(())
}

/// Locate…: a missing file was found somewhere else. Its place is kept.
pub fn relocate(db: &Connection, from: &str, to: &str) -> Result<()> {
    let (from, to) = (canonical(from), canonical(to));
    if from == to {
        return Ok(());
    }
    let tx = db.unchecked_transaction()?;
    // The new path may already be placed elsewhere: the located row wins.
    if tx.query_row("SELECT 1 FROM folder_items WHERE path = ?1", [&from], |_| Ok(())).optional()?.is_some() {
        tx.execute("DELETE FROM folder_items WHERE path = ?1", [&to])?;
        tx.execute("UPDATE folder_items SET path = ?1 WHERE path = ?2", params![to, from])?;
    }
    tx.execute("UPDATE OR REPLACE folder_released SET path = ?1 WHERE path = ?2", params![to, from])?;
    tx.commit()?;
    Ok(())
}

/// Apply a drop of `items` on `target`. Folders and files each go where they
/// can: a file never sits at the top level (that is Unsorted), and a folder
/// dropped on a file goes into that file's folder.
pub fn drop_items(db: &Connection, items: &[Item], target: &Target) -> Result<()> {
    let folders: Vec<String> = items.iter().filter_map(|i| if let Item::Folder(id) = i { Some(id.clone()) } else { None }).collect();
    let files: Vec<String> = items.iter().filter_map(|i| if let Item::File(p) = i { Some(p.clone()) } else { None }).collect();
    // A folder dragged with its own subfolders or files: the parent carries them.
    let all = folders_all(db)?;
    let folders: Vec<String> = folders
        .iter()
        .filter(|id| !folders.iter().any(|other| other != *id && is_within(&all, id, other)))
        .cloned()
        .collect();
    let mut files: Vec<String> = files;
    if !folders.is_empty() {
        let mut keep = Vec::new();
        for p in files {
            let inside = folder_of(db, &p)?.is_some_and(|f| folders.iter().any(|id| is_within(&all, &f, id)));
            if !inside {
                keep.push(p);
            }
        }
        files = keep;
    }
    let parent_of = |id: &str| all.iter().find(|f| f.id == id).and_then(|f| f.parent.clone());
    let index_of_folder = |id: &str| -> Result<Option<usize>> {
        let parent = parent_of(id);
        Ok(sibling_folders(db, parent.as_deref())?.iter().position(|f| f.id == id))
    };
    let index_of_file = |folder: &str, path: &str| -> Result<Option<usize>> {
        Ok(folder_files(db, folder)?.iter().position(|p| *p == canonical(path)))
    };
    match target {
        Target::Into(id) => {
            move_folders(db, &folders, Some(id), None)?;
            place_files(db, &files, id, None)?;
        }
        Target::Unsorted => {
            if !folders.is_empty() {
                move_folders(db, &folders, None, None)?;
            }
            unplace(db, &files)?;
        }
        Target::TopEnd => {
            move_folders(db, &folders, None, None)?;
            unplace(db, &files)?;
        }
        Target::Before(Item::Folder(anchor)) | Target::After(Item::Folder(anchor)) => {
            let after = matches!(target, Target::After(_));
            let parent = parent_of(anchor);
            let at = index_of_folder(anchor)?.map(|i| i + usize::from(after));
            move_folders(db, &folders, parent.as_deref(), at)?;
            // A file dropped beside a folder goes into that folder's parent, first
            // among its files; beside a top-level folder it goes into the folder.
            match parent {
                Some(p) => place_files(db, &files, &p, Some(0))?,
                None => place_files(db, &files, anchor, None)?,
            }
        }
        Target::Before(Item::File(anchor)) | Target::After(Item::File(anchor)) => {
            let after = matches!(target, Target::After(_));
            match folder_of(db, anchor)? {
                Some(f) => {
                    move_folders(db, &folders, Some(&f), None)?;
                    let at = index_of_file(&f, anchor)?.map(|i| i + usize::from(after));
                    place_files(db, &files, &f, at)?;
                }
                // Beside an Unsorted file: out of every folder.
                None => {
                    move_folders(db, &folders, None, None)?;
                    unplace(db, &files)?;
                }
            }
        }
    }
    Ok(())
}

/// Everything the organize actions change, to put back on ⌘Z.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    folders: Vec<(String, Option<String>, String, i64, String)>,
    items: Vec<(String, String, i64, String)>,
    released: Vec<(String, String)>,
}

impl Snapshot {
    pub fn take(db: &Connection) -> Result<Self> {
        let mut stmt = db.prepare("SELECT id, parent_id, name, position, created_at FROM folders")?;
        let folders = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
        let mut stmt = db.prepare("SELECT path, folder_id, position, added_at FROM folder_items")?;
        let items = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
        Ok(Self { folders, items, released: released_all(db)? })
    }

    pub fn restore(&self, db: &Connection) -> Result<()> {
        let tx = db.unchecked_transaction()?;
        tx.execute_batch("DELETE FROM folders; DELETE FROM folder_items; DELETE FROM folder_released;")?;
        let at = now();
        for (id, parent, name, position, created) in &self.folders {
            tx.execute(
                "INSERT INTO folders (id, parent_id, name, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, parent, name, position, created, at],
            )?;
        }
        for (path, folder, position, added) in &self.items {
            tx.execute(
                "INSERT INTO folder_items (path, folder_id, position, added_at) VALUES (?1, ?2, ?3, ?4)",
                params![path, folder, position, added],
            )?;
        }
        for (path, released) in &self.released {
            tx.execute("INSERT INTO folder_released (path, released_at) VALUES (?1, ?2)", params![path, released])?;
        }
        tx.commit()?;
        Ok(())
    }
}

/// An undo and redo history of organize actions, each with its menu label.
#[derive(Default)]
pub struct History {
    undo: Vec<(String, Snapshot)>,
    redo: Vec<(String, Snapshot)>,
}

const HISTORY_LIMIT: usize = 100;

impl History {
    /// Run `action`, remembering the state before it. Nothing is remembered
    /// when it fails.
    pub fn record<T>(&mut self, db: &Connection, label: &str, action: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let before = Snapshot::take(db)?;
        let out = action(db);
        match &out {
            Ok(_) => {
                if Snapshot::take(db)? != before {
                    self.undo.push((label.to_string(), before));
                    if self.undo.len() > HISTORY_LIMIT {
                        self.undo.remove(0);
                    }
                    self.redo.clear();
                }
            }
            Err(_) => {
                before.restore(db)?;
            }
        }
        out
    }

    /// Remember an action the caller ran itself, in steps across several
    /// frames, from the state `before` it began: one ⌘Z for all of it.
    /// Nothing is remembered when it changed nothing.
    pub fn push(&mut self, db: &Connection, label: &str, before: Snapshot) -> Result<()> {
        if Snapshot::take(db)? != before {
            self.undo.push((label.to_string(), before));
            if self.undo.len() > HISTORY_LIMIT {
                self.undo.remove(0);
            }
            self.redo.clear();
        }
        Ok(())
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    /// How many actions can be undone: a caller compares it before and after
    /// to know whether an action it started was recorded.
    pub fn depth(&self) -> usize {
        self.undo.len()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    pub fn undo_label(&self) -> Option<&str> {
        self.undo.last().map(|(l, _)| l.as_str())
    }

    /// ⌘Z: the label of what was undone.
    pub fn undo(&mut self, db: &Connection) -> Result<Option<String>> {
        let Some((label, snap)) = self.undo.pop() else { return Ok(None) };
        let now = Snapshot::take(db)?;
        snap.restore(db)?;
        self.redo.push((label.clone(), now));
        Ok(Some(label))
    }

    /// ⇧⌘Z.
    pub fn redo(&mut self, db: &Connection) -> Result<Option<String>> {
        let Some((label, snap)) = self.redo.pop() else { return Ok(None) };
        let now = Snapshot::take(db)?;
        snap.restore(db)?;
        self.undo.push((label.clone(), now));
        Ok(Some(label))
    }
}

/// Is automatic grouping on? Off unless Settings turned it on.
pub fn auto_organize(db: &Connection) -> Result<bool> {
    store::ensure_tables(db)?;
    Ok(store::config_get(db, AUTO_KEY)?.as_deref() == Some("on"))
}

pub fn set_auto_organize(db: &Connection, on: bool) -> Result<()> {
    store::ensure_tables(db)?;
    store::config_set(db, AUTO_KEY, if on { "on" } else { "off" })
}

/// Does this install have groups from before folders: pins, named or
/// hand-made projects, renamed or merged blocks, or a saved assignment of
/// any file to a real project?
pub fn has_old_groups(db: &Connection) -> Result<bool> {
    let count = |sql: &str| -> Result<i64> { Ok(db.query_row(sql, [], |r| r.get(0))?) };
    Ok(count("SELECT count(*) FROM project_pins")? > 0
        || count("SELECT count(*) FROM projects")? > 0
        || count("SELECT count(*) FROM project_blocks WHERE custom_name IS NOT NULL OR merged_into IS NOT NULL")? > 0
        || count("SELECT count(*) FROM project_assignments WHERE project <> 'Unfiled'")? > 0)
}

pub fn migrated(db: &Connection) -> Result<bool> {
    Ok(store::config_get(db, MIGRATED_KEY)?.is_some())
}

/// What the one-time conversion did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Migration {
    pub folders: usize,
    pub files: usize,
}

/// Turn the groups an install already had into folders, once: each project
/// becomes a top-level folder with its name, each block of two or more files
/// a subfolder, and every file is placed where it showed. A project that is
/// a single block keeps its files directly. Unfiled stays Unsorted. Then
/// automatic grouping is switched off. A new install, with no groups, only
/// records that the conversion is done.
pub fn migrate_from_taxonomy(db: &Connection, taxonomy: &super::Taxonomy) -> Result<Migration> {
    ensure_tables(db)?;
    let mut done = Migration::default();
    // Each step writes in its own transaction; the done mark is written last,
    // so an interrupted conversion runs again from the start.
    let tx_guard = db;
    for project in taxonomy.projects.iter().filter(|p| !p.is_unfiled) {
        let top = create_folder(tx_guard, None, &project.name)?;
        done.folders += 1;
        let single = project.blocks.len() == 1 && project.loose_files.is_empty();
        let mut placed: HashSet<String> = HashSet::new();
        for block in &project.blocks {
            let paths: Vec<String> = block.files.iter().map(|f| f.path.clone()).filter(|p| placed.insert(p.clone())).collect();
            if paths.is_empty() {
                continue;
            }
            let into = if single {
                top.clone()
            } else {
                done.folders += 1;
                create_folder(tx_guard, Some(&top), &block.name)?
            };
            done.files += paths.len();
            place_files(tx_guard, &paths, &into, None)?;
        }
        let loose: Vec<String> = project.loose_files.iter().map(|f| f.path.clone()).filter(|p| placed.insert(p.clone())).collect();
        done.files += loose.len();
        place_files(tx_guard, &loose, &top, None)?;
    }
    store::config_set(tx_guard, AUTO_KEY, "off")?;
    store::config_set(tx_guard, MIGRATED_KEY, &now())?;
    Ok(done)
}

/// A new install: nothing to convert, automatic grouping stays off.
pub fn mark_migrated(db: &Connection) -> Result<()> {
    store::config_set(db, MIGRATED_KEY, &now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        store::ensure_tables(&db).unwrap();
        ensure_tables(&db).unwrap();
        db
    }

    fn names(nodes: &[FolderNode]) -> Vec<String> {
        nodes.iter().map(|n| n.name.clone()).collect()
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn folders_nest_and_names_stay_unique_among_siblings() {
        let db = db();
        let a = create_folder(&db, None, "Trips").unwrap();
        let b = create_folder(&db, None, "trips").unwrap();
        let c = create_folder(&db, None, "  ").unwrap();
        let d = create_folder(&db, Some(&a), "Trips").unwrap();
        let e = create_folder(&db, Some(&d), "Lisbon").unwrap();
        let t = tree(&db).unwrap();
        assert_eq!(names(&t), s(&["Trips", "trips 2", "Untitled Folder"]));
        assert_eq!(t[0].children[0].name, "Trips", "the same name is fine one level down");
        assert_eq!(t[0].children[0].children[0].id, e);
        assert_eq!(rename_folder(&db, &c, "Trips").unwrap(), "Trips 3");
        assert_eq!(rename_folder(&db, &c, "   ").unwrap(), "Trips 3", "a blank rename keeps the name");
        assert_eq!(rename_folder(&db, &b, "Work").unwrap(), "Work");
        assert!(create_folder(&db, Some("fd_gone"), "x").is_err());
        let _ = d;
    }

    #[test]
    fn a_file_lives_in_one_folder_in_a_manual_order() {
        let db = db();
        let a = create_folder(&db, None, "A").unwrap();
        let b = create_folder(&db, None, "B").unwrap();
        place_files(&db, &s(&["/n/1.md", "/n/2.md", "/n/3.md"]), &a, None).unwrap();
        place_files(&db, &s(&["/n/3.md"]), &a, Some(0)).unwrap();
        assert_eq!(tree(&db).unwrap()[0].files, s(&["/n/3.md", "/n/1.md", "/n/2.md"]));
        // Index counts rows as they stand: dropping 3 just before 2.
        place_files(&db, &s(&["/n/3.md"]), &a, Some(2)).unwrap();
        assert_eq!(tree(&db).unwrap()[0].files, s(&["/n/1.md", "/n/3.md", "/n/2.md"]));
        place_files(&db, &s(&["/n/1.md"]), &b, None).unwrap();
        let t = tree(&db).unwrap();
        assert_eq!(t[0].files, s(&["/n/3.md", "/n/2.md"]));
        assert_eq!(t[1].files, s(&["/n/1.md"]));
        assert_eq!(folder_of(&db, "/n/1.md").unwrap().as_deref(), Some(b.as_str()));
        unplace(&db, &s(&["/n/1.md"])).unwrap();
        assert!(tree(&db).unwrap()[1].files.is_empty());
        assert_eq!(released_all(&db).unwrap()[0].0, "/n/1.md", "it goes back to Unsorted");
        place_files(&db, &s(&["/n/1.md"]), &b, None).unwrap();
        assert!(released_all(&db).unwrap().is_empty(), "placing it again takes it off Unsorted");
    }

    #[test]
    fn deleting_a_folder_releases_every_file_and_takes_its_subfolders() {
        let db = db();
        let a = create_folder(&db, None, "A").unwrap();
        let sub = create_folder(&db, Some(&a), "Sub").unwrap();
        let deep = create_folder(&db, Some(&sub), "Deep").unwrap();
        let keep = create_folder(&db, None, "Keep").unwrap();
        place_files(&db, &s(&["/n/a.md"]), &a, None).unwrap();
        place_files(&db, &s(&["/n/s.md", "/n/t.md"]), &deep, None).unwrap();
        place_files(&db, &s(&["/n/k.md"]), &keep, None).unwrap();
        assert_eq!(delete_impact(&db, &a).unwrap(), DeleteImpact { files: 3, subfolders: 2 });
        delete_folder(&db, &a).unwrap();
        let t = tree(&db).unwrap();
        assert_eq!(names(&t), s(&["Keep"]));
        assert_eq!(folders_all(&db).unwrap()[0].position, 0, "siblings close the gap");
        let released: HashSet<String> = released_all(&db).unwrap().into_iter().map(|r| r.0).collect();
        assert_eq!(released, ["/n/a.md", "/n/s.md", "/n/t.md"].iter().map(|x| x.to_string()).collect());
        assert_eq!(placed_paths(&db).unwrap().len(), 1);
    }

    #[test]
    fn folders_move_into_each_other_but_never_into_themselves() {
        let db = db();
        let a = create_folder(&db, None, "A").unwrap();
        let b = create_folder(&db, None, "B").unwrap();
        let c = create_folder(&db, None, "C").unwrap();
        drop_items(&db, &[Item::Folder(b.clone())], &Target::Into(a.clone())).unwrap();
        assert_eq!(names(&tree(&db).unwrap()), s(&["A", "C"]));
        assert_eq!(names(&tree(&db).unwrap()[0].children), s(&["B"]));
        // A into its own child B: refused, nothing moves.
        drop_items(&db, &[Item::Folder(a.clone())], &Target::Into(b.clone())).unwrap();
        assert_eq!(names(&tree(&db).unwrap()), s(&["A", "C"]));
        drop_items(&db, &[Item::Folder(a.clone())], &Target::Into(a.clone())).unwrap();
        assert_eq!(names(&tree(&db).unwrap()), s(&["A", "C"]));
        // Reorder at the top: C before A.
        drop_items(&db, &[Item::Folder(c.clone())], &Target::Before(Item::Folder(a.clone()))).unwrap();
        assert_eq!(names(&tree(&db).unwrap()), s(&["C", "A"]));
        // B out to the top level, after C.
        drop_items(&db, &[Item::Folder(b.clone())], &Target::After(Item::Folder(c.clone()))).unwrap();
        assert_eq!(names(&tree(&db).unwrap()), s(&["C", "B", "A"]));
        // Same name follows a folder into new siblings: rename on arrival.
        let a2 = create_folder(&db, Some(&a), "B").unwrap();
        drop_items(&db, &[Item::Folder(a2)], &Target::TopEnd).unwrap();
        assert_eq!(names(&tree(&db).unwrap()), s(&["C", "B", "A", "B 2"]));
    }

    #[test]
    fn drops_beside_rows_and_back_to_unsorted() {
        let db = db();
        let a = create_folder(&db, None, "A").unwrap();
        let sub = create_folder(&db, Some(&a), "Sub").unwrap();
        place_files(&db, &s(&["/n/1.md", "/n/2.md"]), &a, None).unwrap();
        // A file after 1: between 1 and 2.
        drop_items(&db, &[Item::File("/n/3.md".into())], &Target::After(Item::File("/n/1.md".into()))).unwrap();
        assert_eq!(tree(&db).unwrap()[0].files, s(&["/n/1.md", "/n/3.md", "/n/2.md"]));
        // Several at once, in the order given, before 1.
        drop_items(&db, &[Item::File("/n/2.md".into()), Item::File("/n/4.md".into())], &Target::Before(Item::File("/n/1.md".into())))
            .unwrap();
        assert_eq!(tree(&db).unwrap()[0].files, s(&["/n/2.md", "/n/4.md", "/n/1.md", "/n/3.md"]));
        // A file beside a subfolder goes into that subfolder's parent, first.
        drop_items(&db, &[Item::File("/n/5.md".into())], &Target::Before(Item::Folder(sub.clone()))).unwrap();
        assert_eq!(tree(&db).unwrap()[0].files[0], "/n/5.md");
        // A file beside a top-level folder goes into it.
        drop_items(&db, &[Item::File("/n/6.md".into())], &Target::After(Item::Folder(a.clone()))).unwrap();
        assert_eq!(folder_of(&db, "/n/6.md").unwrap().as_deref(), Some(a.as_str()));
        // A folder dropped on a file goes into that file's folder.
        let b = create_folder(&db, None, "B").unwrap();
        drop_items(&db, &[Item::Folder(b.clone())], &Target::After(Item::File("/n/1.md".into()))).unwrap();
        assert_eq!(names(&tree(&db).unwrap()[0].children), s(&["Sub", "B"]));
        // Out to Unsorted: files leave; a folder goes to the top level.
        drop_items(&db, &[Item::File("/n/1.md".into()), Item::Folder(b.clone())], &Target::Unsorted).unwrap();
        assert_eq!(folder_of(&db, "/n/1.md").unwrap(), None);
        assert_eq!(names(&tree(&db).unwrap()), s(&["A", "B"]));
        // A folder dragged with its own file: the file stays inside it.
        place_files(&db, &s(&["/n/b.md"]), &b, None).unwrap();
        drop_items(&db, &[Item::Folder(b.clone()), Item::File("/n/b.md".into())], &Target::Into(sub.clone())).unwrap();
        assert_eq!(folder_of(&db, "/n/b.md").unwrap().as_deref(), Some(b.as_str()));
        assert_eq!(names(&tree(&db).unwrap()[0].children[0].children), s(&["B"]));
    }

    #[test]
    fn undo_and_redo_every_organize_action() {
        let db = db();
        let mut h = History::default();
        let a = h.record(&db, "New Folder", |db| create_folder(db, None, "A")).unwrap();
        h.record(&db, "Move", |db| place_files(db, &s(&["/n/1.md", "/n/2.md"]), &a, None)).unwrap();
        h.record(&db, "Rename", |db| rename_folder(db, &a, "Alpha")).unwrap();
        let sub = h.record(&db, "New Folder", |db| create_folder(db, Some(&a), "Sub")).unwrap();
        h.record(&db, "Move", |db| drop_items(db, &[Item::File("/n/2.md".into())], &Target::Into(sub.clone()))).unwrap();
        h.record(&db, "Remove from Folder", |db| unplace(db, &s(&["/n/1.md"]))).unwrap();
        h.record(&db, "Delete Folder", |db| delete_folder(db, &a)).unwrap();
        // Nothing changed: nothing to undo.
        h.record(&db, "Rename", |db| rename_folder(db, &sub, "x").or(Ok("".into()))).ok();
        assert!(tree(&db).unwrap().is_empty());
        let labels: Vec<_> = (0..7).map(|_| h.undo(&db).unwrap().unwrap()).collect();
        assert_eq!(labels, s(&["Delete Folder", "Remove from Folder", "Move", "New Folder", "Rename", "Move", "New Folder"]));
        assert!(tree(&db).unwrap().is_empty());
        assert_eq!(h.undo(&db).unwrap(), None);
        for _ in 0..5 {
            h.redo(&db).unwrap();
        }
        let t = tree(&db).unwrap();
        assert_eq!(t[0].name, "Alpha");
        assert_eq!(t[0].children[0].files, s(&["/n/2.md"]));
        assert_eq!(t[0].files, s(&["/n/1.md"]));
        // A new action after undo drops the redo history.
        h.undo(&db).unwrap();
        h.record(&db, "New Folder", |db| create_folder(db, None, "Z")).unwrap();
        assert!(!h.can_redo());
        // A failed action changes nothing and is not remembered.
        let before = Snapshot::take(&db).unwrap();
        let undo_len = h.undo_label().map(str::to_string);
        assert!(h.record(&db, "Move", |db| place_files(db, &s(&["/n/9.md"]), "fd_gone", None)).is_err());
        assert_eq!(Snapshot::take(&db).unwrap(), before);
        assert_eq!(h.undo_label().map(str::to_string), undo_len);
    }

    #[test]
    fn locate_keeps_the_place_and_forget_drops_it() {
        let db = db();
        let a = create_folder(&db, None, "A").unwrap();
        place_files(&db, &s(&["/n/1.md", "/gone/2.md", "/n/3.md"]), &a, None).unwrap();
        relocate(&db, "/gone/2.md", "/found/2.md").unwrap();
        assert_eq!(tree(&db).unwrap()[0].files, s(&["/n/1.md", "/found/2.md", "/n/3.md"]));
        forget(&db, &s(&["/n/3.md"])).unwrap();
        assert_eq!(tree(&db).unwrap()[0].files.len(), 2);
        assert!(released_all(&db).unwrap().is_empty());
    }

    #[test]
    fn automatic_grouping_is_off_until_turned_on() {
        let db = db();
        assert!(!auto_organize(&db).unwrap());
        set_auto_organize(&db, true).unwrap();
        assert!(auto_organize(&db).unwrap());
        set_auto_organize(&db, false).unwrap();
        assert!(!auto_organize(&db).unwrap());
    }

    #[test]
    fn a_cycle_or_a_lost_parent_still_shows_every_folder() {
        let f = |id: &str, parent: Option<&str>| Folder { id: id.into(), parent: parent.map(Into::into), name: id.into(), position: 0, created_at: String::new() };
        let t = build_tree(&[f("a", Some("b")), f("b", Some("a")), f("c", Some("gone"))], &[]);
        let mut all: Vec<String> = Vec::new();
        fn walk(n: &[FolderNode], out: &mut Vec<String>) {
            for x in n {
                out.push(x.id.clone());
                walk(&x.children, out);
            }
        }
        walk(&t, &mut all);
        all.sort();
        assert_eq!(all, s(&["a", "b", "c"]));
    }
}
