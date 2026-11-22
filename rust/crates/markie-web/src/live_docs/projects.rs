//! Live Docs projects (`electron/live-docs-projects.cjs`): the list of
//! Darkmown site folders, the open project's tree, and reading and writing
//! its files with revision checks. Same store shape (`{version: 1,
//! projects: [...]}`), kept in Markie RS's own data folder.
//!
//! Refusals match Electron's codes and wording: nothing inside `.git` or
//! `node_modules`, no symbolic or hard links, text files up to 2 MB, and a
//! write only lands when the file on disk still has the revision it was read at.

use std::fs;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::runner::check_project_folder;
use crate::json::{self, Json};

pub const MAX_PROJECTS: usize = 50;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_TREE_ENTRIES: usize = 5000;
const MAX_TREE_DEPTH: usize = 24;
const MAX_RELATIVE_PATH: usize = 1024;
const MAX_SEGMENTS: usize = 32;
const MAX_STORE_BYTES: u64 = 256 * 1024;
const HIDDEN_NAMES: &[&str] = &[".git", "node_modules", ".husky", ".githooks", ".npmrc", ".yarnrc", ".yarnrc.yml", ".yarnrc.yaml", ".vscode", ".idea"];

const OUTSIDE: &str = "Only files inside the open project can be opened.";
const HIDDEN: &str = "Markie does not open or change anything inside .git or node_modules.";
const SYMLINK: &str = "Markie does not follow symbolic links inside a project.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn refuse<T>(code: &'static str, message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal { code, message: message.into() })
}

fn io_refusal(e: std::io::Error) -> Refusal {
    match e.kind() {
        std::io::ErrorKind::NotFound => Refusal { code: "missing", message: "That file or folder no longer exists.".into() },
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem => Refusal { code: "denied", message: "macOS refused access to that file.".into() },
        _ => Refusal { code: "io-error", message: "The file operation failed.".into() },
    }
}

fn is_hidden_name(name: &str) -> bool {
    let folded = name.to_lowercase();
    HIDDEN_NAMES.contains(&folded.as_str()) || folded.starts_with(".yarnrc")
}

fn junk(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".ds_store" || (lower.starts_with(".markie-") && lower.ends_with(".tmp"))
}

fn unaddressable(s: &str) -> bool {
    s.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}' || c == '\\')
}

/// `parseRelativePath`: checked segments, never joined until all pass.
pub fn parse_relative_path(value: &str) -> Result<Vec<String>, Refusal> {
    if value.is_empty() || value.len() > MAX_RELATIVE_PATH || unaddressable(value) {
        return refuse("invalid-path", "That is not a file in this project.");
    }
    if value.starts_with('/') || (value.len() >= 2 && value.as_bytes()[1] == b':' && value.as_bytes()[0].is_ascii_alphabetic()) {
        return refuse("outside", OUTSIDE);
    }
    let segments: Vec<String> = value.split('/').map(str::to_string).collect();
    if segments.len() > MAX_SEGMENTS || segments.iter().any(|s| s.is_empty() || s == "." || s == "..") {
        return refuse("outside", OUTSIDE);
    }
    if segments.iter().any(|s| is_hidden_name(s)) {
        return refuse("hidden", HIDDEN);
    }
    Ok(segments)
}

pub fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn random_uuid() -> String {
    let mut b = [0u8; 16];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

fn valid_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub root: PathBuf,
    pub name: String,
    pub added_at: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PublicEntry {
    pub id: String,
    pub name: String,
    /// `~/…` under the home folder.
    pub location: String,
    pub available: bool,
    pub open: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TreeKind {
    File,
    Dir,
    Link,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileRead {
    pub path: String,
    pub text: String,
    pub revision: String,
    pub size: usize,
}

struct Open {
    id: String,
    name: String,
    root: PathBuf,
    identity: (u64, u64),
}

pub struct Projects {
    store: PathBuf,
    home: PathBuf,
    projects: Option<Vec<Entry>>,
    open: Option<Open>,
}

fn identity(path: &Path) -> Option<(u64, u64)> {
    let m = fs::metadata(path).ok()?;
    Some((m.dev(), m.ino()))
}

impl Projects {
    pub fn new(store: PathBuf, home: PathBuf) -> Self {
        Self { store, home, projects: None, open: None }
    }

    fn load(&mut self) -> &mut Vec<Entry> {
        if self.projects.is_none() {
            let mut list = Vec::new();
            let ok = fs::metadata(&self.store).is_ok_and(|m| m.is_file() && m.len() <= MAX_STORE_BYTES);
            if ok && let Some(parsed) = fs::read_to_string(&self.store).ok().and_then(|t| json::parse(&t)) {
                let is_v1 = matches!(parsed.get("version"), Some(Json::Num(n)) if *n == 1.0);
                if is_v1 && let Some(items) = parsed.get("projects").and_then(Json::as_arr) {
                    for item in items {
                        if list.len() >= MAX_PROJECTS {
                            break;
                        }
                        let Some(id) = item.get("id").and_then(Json::as_str).filter(|i| valid_id(i)) else { continue };
                        let Some(root) = item.get("root").and_then(Json::as_str) else { continue };
                        if root.len() > 4096 || !root.starts_with('/') || root.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
                            continue;
                        }
                        if list.iter().any(|e: &Entry| e.id == id || e.root == Path::new(root)) {
                            continue;
                        }
                        let name = item.get("name").and_then(Json::as_str).filter(|n| !n.is_empty()).map(|n| n.chars().take(256).collect()).unwrap_or_else(|| Path::new(root).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default());
                        let added_at = match item.get("addedAt") {
                            Some(Json::Num(n)) if n.is_finite() => *n,
                            _ => 0.0,
                        };
                        list.push(Entry { id: id.to_string(), root: PathBuf::from(root), name, added_at });
                    }
                }
            }
            self.projects = Some(list);
        }
        self.projects.as_mut().unwrap()
    }

    fn save(&mut self) -> Result<(), Refusal> {
        let list = self.load().clone();
        let items: Vec<Json> = list
            .iter()
            .map(|e| Json::Obj(vec![("id".into(), Json::Str(e.id.clone())), ("root".into(), Json::Str(e.root.to_string_lossy().into_owned())), ("name".into(), Json::Str(e.name.clone())), ("addedAt".into(), Json::Num(e.added_at))]))
            .collect();
        let body = Json::Obj(vec![("version".into(), Json::Num(1.0)), ("projects".into(), Json::Arr(items))]);
        if let Some(dir) = self.store.parent() {
            fs::create_dir_all(dir).map_err(io_refusal)?;
        }
        let tmp = self.store.with_extension(format!("markie-{}.tmp", &random_uuid()[..8]));
        fs::write(&tmp, format!("{}\n", json::stringify(&body))).map_err(io_refusal)?;
        fs::rename(&tmp, &self.store).map_err(io_refusal)
    }

    fn location(&self, root: &Path) -> String {
        let home = fs::canonicalize(&self.home).unwrap_or_else(|_| self.home.clone());
        match root.strip_prefix(&home) {
            Ok(rest) if !rest.as_os_str().is_empty() => format!("~/{}", rest.to_string_lossy()),
            _ => root.to_string_lossy().into_owned(),
        }
    }

    fn public(&self, e: &Entry) -> PublicEntry {
        let available = check_project_folder(&e.root, &self.home).is_ok_and(|c| c.root == e.root);
        PublicEntry { id: e.id.clone(), name: e.name.clone(), location: self.location(&e.root), available, open: self.open.as_ref().is_some_and(|o| o.id == e.id) }
    }

    pub fn list(&mut self) -> Vec<PublicEntry> {
        let list = self.load().clone();
        list.iter().map(|e| self.public(e)).collect()
    }

    /// A folder the native picker answered. Returns the entry and whether it existed.
    pub fn add(&mut self, chosen: &Path) -> Result<(PublicEntry, bool), Refusal> {
        let checked = check_project_folder(chosen, &self.home).map_err(|(code, message)| Refusal { code, message })?;
        if let Some(known) = self.load().iter().find(|e| e.root == checked.root).cloned() {
            return Ok((self.public(&known), true));
        }
        if self.load().len() >= MAX_PROJECTS {
            return refuse("limit", format!("The Live Docs list holds up to {MAX_PROJECTS} projects. Remove one first."));
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let entry = Entry { id: random_uuid(), root: checked.root, name: checked.name, added_at: now };
        self.load().push(entry.clone());
        if let Err(e) = self.save() {
            self.load().pop();
            return Err(e);
        }
        Ok((self.public(&entry), false))
    }

    /// Takes the project off the list. The folder itself is never touched.
    pub fn remove(&mut self, id: &str) -> Result<(), Refusal> {
        let Some(at) = self.load().iter().position(|e| e.id == id) else {
            return refuse("unknown-project", "That project is no longer in the Live Docs list.");
        };
        if self.open.as_ref().is_some_and(|o| o.id == id) {
            self.open = None;
        }
        let removed = self.load().remove(at);
        if let Err(e) = self.save() {
            self.load().insert(at, removed);
            return Err(e);
        }
        Ok(())
    }

    pub fn open(&mut self, id: &str) -> Result<String, Refusal> {
        let Some(entry) = self.load().iter().find(|e| e.id == id).cloned() else {
            return refuse("unknown-project", "That project is no longer in the Live Docs list.");
        };
        let checked = check_project_folder(&entry.root, &self.home).map_err(|(code, message)| Refusal { code, message })?;
        if checked.root != entry.root {
            return refuse("moved", format!("{} was moved or replaced. Remove it and add the folder again.", entry.name));
        }
        let identity = identity(&checked.root).ok_or(Refusal { code: "missing", message: "That folder no longer exists.".into() })?;
        self.open = Some(Open { id: entry.id.clone(), name: entry.name.clone(), root: checked.root, identity });
        Ok(entry.name)
    }

    pub fn close(&mut self) {
        self.open = None;
    }

    pub fn open_id(&self) -> Option<&str> {
        self.open.as_ref().map(|o| o.id.as_str())
    }

    pub fn open_root(&self) -> Option<&Path> {
        self.open.as_ref().map(|o| o.root.as_path())
    }

    fn require_open(&self) -> Result<&Open, Refusal> {
        let o = self.open.as_ref().ok_or(Refusal { code: "no-project", message: "Open a Live Docs project first.".into() })?;
        if identity(&o.root) != Some(o.identity) || fs::canonicalize(&o.root).ok().as_deref() != Some(o.root.as_path()) {
            return refuse("moved", format!("{} was moved, renamed or replaced after it was opened. Open it again from the Live Docs list.", o.name));
        }
        Ok(o)
    }

    /// Every file and folder of the open project, by project-relative path.
    pub fn tree(&self) -> Result<(Vec<(String, TreeKind)>, bool), Refusal> {
        let o = self.require_open()?;
        let mut entries = Vec::new();
        let mut truncated = false;
        fn walk(folder: &Path, prefix: &str, depth: usize, entries: &mut Vec<(String, TreeKind)>, truncated: &mut bool) {
            let Ok(items) = fs::read_dir(folder) else { return };
            let mut items: Vec<_> = items.flatten().collect();
            items.sort_by_key(|i| i.file_name());
            for item in items {
                if entries.len() >= MAX_TREE_ENTRIES {
                    *truncated = true;
                    return;
                }
                let name = item.file_name().to_string_lossy().into_owned();
                if is_hidden_name(&name) || junk(&name) || unaddressable(&name) {
                    continue;
                }
                let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
                let Ok(ft) = item.file_type() else { continue };
                if ft.is_symlink() {
                    entries.push((rel, TreeKind::Link));
                } else if ft.is_dir() {
                    entries.push((rel.clone(), TreeKind::Dir));
                    if depth + 1 < MAX_TREE_DEPTH {
                        walk(&item.path(), &rel, depth + 1, entries, truncated);
                    } else {
                        *truncated = true;
                    }
                } else if ft.is_file() {
                    entries.push((rel, TreeKind::File));
                }
            }
        }
        walk(&o.root, "", 0, &mut entries, &mut truncated);
        Ok((entries, truncated))
    }

    fn resolve(&self, relative: &str) -> Result<(String, PathBuf, fs::Metadata), Refusal> {
        let segments = parse_relative_path(relative)?;
        let o = self.require_open()?;
        let joined = segments.iter().fold(o.root.clone(), |p, s| p.join(s));
        let parent = joined.parent().unwrap();
        let real_parent = fs::canonicalize(parent).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { Refusal { code: "missing", message: "That file no longer exists.".into() } } else { Refusal { code: "outside", message: OUTSIDE.into() } })?;
        let Ok(inside) = real_parent.strip_prefix(&o.root) else { return refuse("outside", OUTSIDE) };
        if inside.components().any(|c| is_hidden_name(&c.as_os_str().to_string_lossy())) {
            return refuse("hidden", HIDDEN);
        }
        let target = real_parent.join(segments.last().unwrap());
        let meta = fs::symlink_metadata(&target).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { Refusal { code: "missing", message: "That file no longer exists.".into() } } else { io_refusal(e) })?;
        if meta.file_type().is_symlink() {
            return refuse("symlink", SYMLINK);
        }
        if !meta.is_file() {
            return refuse("not-a-file", "That is not a regular file.");
        }
        if meta.nlink() > 1 {
            return refuse("hard-link", "Markie edits files with one name only. This one is a hard link; open it in another editor.");
        }
        Ok((segments.join("/"), target, meta))
    }

    fn too_large<T>() -> Result<T, Refusal> {
        refuse("too-large", "Markie edits project files up to 2 MB. Open larger files in another editor.")
    }

    fn read_target(target: &Path, meta: &fs::Metadata) -> Result<(String, String, usize), Refusal> {
        if meta.len() > MAX_FILE_BYTES {
            return Self::too_large();
        }
        let bytes = fs::read(target).map_err(io_refusal)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Self::too_large();
        }
        if bytes.contains(&0) {
            return refuse("binary", "Markie edits text files only. This one is binary.");
        }
        let text = String::from_utf8(bytes.clone()).map_err(|_| Refusal { code: "binary", message: "Markie edits text files only. This one is not UTF-8 text.".into() })?;
        Ok((text, sha_hex(&bytes), bytes.len()))
    }

    pub fn read(&self, relative: &str) -> Result<FileRead, Refusal> {
        let (path, target, meta) = self.resolve(relative)?;
        let (text, revision, size) = Self::read_target(&target, &meta)?;
        Ok(FileRead { path, text, revision, size })
    }

    /// Writes only when the file still has `base_revision`; returns the new revision.
    pub fn write(&self, relative: &str, text: &str, base_revision: &str) -> Result<(String, usize), Refusal> {
        if base_revision.len() != 64 || !base_revision.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return refuse("invalid-request", "Invalid Live Docs request.");
        }
        if text.len() as u64 > MAX_FILE_BYTES {
            return Self::too_large();
        }
        if text.as_bytes().contains(&0) {
            return refuse("binary", "Markie writes text files only.");
        }
        let (path, target, meta) = self.resolve(relative)?;
        let (_, current, _) = Self::read_target(&target, &meta)?;
        if current != base_revision {
            return refuse("conflict", "This file changed on disk since it was opened.");
        }
        let dir = target.parent().unwrap();
        let tmp = dir.join(format!(".markie-{}.tmp", &random_uuid()[..8]));
        {
            use std::io::Write;
            let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(io_refusal)?;
            f.write_all(text.as_bytes()).map_err(io_refusal)?;
            f.sync_all().ok();
        }
        // The file must still be the one that was read, right before the swap.
        let again = fs::symlink_metadata(&target).map_err(|_| Refusal { code: "conflict", message: "This file was deleted or renamed outside Markie.".into() });
        let same = again.as_ref().is_ok_and(|m| m.ino() == meta.ino() && m.dev() == meta.dev());
        if !same {
            let _ = fs::remove_file(&tmp);
            return refuse("conflict", "This file was replaced on disk since it was opened.");
        }
        let (_, latest, _) = Self::read_target(&target, again.as_ref().unwrap()).inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })?;
        if latest != base_revision {
            let _ = fs::remove_file(&tmp);
            return refuse("conflict", "This file changed on disk since it was opened.");
        }
        let _ = fs::set_permissions(&tmp, fs::Permissions::from(meta.permissions()));
        fs::rename(&tmp, &target).map_err(io_refusal)?;
        let saved = self.read(&path)?;
        Ok((saved.revision, saved.size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(dir: &Path) -> PathBuf {
        let root = dir.join("site-project");
        fs::create_dir_all(root.join("site/pages")).unwrap();
        fs::write(root.join("site/pages/index.wd"), "# Home\n").unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("node_modules/x/a.js"), "x").unwrap();
        fs::canonicalize(root).unwrap()
    }

    #[test]
    fn add_open_read_write_with_revisions() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let root = project(&home);
        let store = tmp.path().join("data/live-docs-projects.json");
        let mut p = Projects::new(store.clone(), home.clone());
        let (entry, existed) = p.add(&root).unwrap();
        assert!(!existed && entry.available && entry.location == "~/site-project");
        assert!(p.add(&root).unwrap().1, "adding twice keeps one");
        // A second instance reads the same store.
        let mut again = Projects::new(store, home);
        assert_eq!(again.list().len(), 1);
        p.open(&entry.id).unwrap();
        let (tree, truncated) = p.tree().unwrap();
        assert!(!truncated);
        assert!(tree.contains(&("site/pages/index.wd".into(), TreeKind::File)));
        assert!(!tree.iter().any(|(p, _)| p.starts_with("node_modules")));
        let file = p.read("site/pages/index.wd").unwrap();
        assert_eq!(file.text, "# Home\n");
        let (rev, _) = p.write("site/pages/index.wd", "# Home!\n", &file.revision).unwrap();
        assert_eq!(rev, sha_hex(b"# Home!\n"));
        assert_eq!(p.write("site/pages/index.wd", "stale\n", &file.revision).unwrap_err().code, "conflict");
        assert_eq!(p.read("node_modules/x/a.js").unwrap_err().code, "hidden");
        assert_eq!(p.read("../x").unwrap_err().code, "outside");
        std::os::unix::fs::symlink(root.join("site/pages/index.wd"), root.join("link.wd")).unwrap();
        assert_eq!(p.read("link.wd").unwrap_err().code, "symlink");
        p.remove(&entry.id).unwrap();
        assert!(p.list().is_empty());
        assert!(root.exists(), "removing never touches the folder");
    }

    #[test]
    fn refuses_folders_that_are_not_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        fs::create_dir_all(home.join("plain")).unwrap();
        let mut p = Projects::new(tmp.path().join("s.json"), home.clone());
        assert_eq!(p.add(&home.join("plain")).unwrap_err().code, "not-a-project");
        assert_eq!(p.add(&home).unwrap_err().code, "too-broad");
    }
}
