//! The device-wide document index: a bounded walk that finds every file Markie
//! can open, pruning the folders that are vendored, generated, synced by a
//! cloud provider, or bundles.
//!
//! A port of `electron/mdindex.js`. The rules and their reasons are the same;
//! read the comments there before changing one here.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::formats::{FormatKind, Representation, classify};

const SNIPPET_BYTES: usize = 8192;
const SNIPPET_MAX_FILE_BYTES: u64 = 256 * 1024;

const EXCLUDED_NAMES: &[&str] = &[
    "node_modules", "Library", "vendor", "bower_components", "dist", "build", "out", "target",
    "Pods", "venv", "site-packages", "DerivedData", "tmp", "temp", "Dropbox", "Google Drive",
    "OneDrive", "Applications", "Pictures", "Movies", "Music", "AppData", "Application Data",
    "Local Settings", "$Recycle.Bin",
];

const BUNDLE_EXTS: &[&str] = &[
    "app", "photoslibrary", "musiclibrary", "tvlibrary", "aplibrary", "fcpbundle",
    "imovielibrary", "logicx", "band", "rcproject", "xcodeproj", "xcworkspace", "playground",
    "pvm", "vmwarevm", "utm", "sparsebundle", "download", "lproj", "framework", "bundle", "kext",
    "pkg", "appex", "plugin", "qlgenerator", "prefpane", "wdgt",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IndexedDoc {
    pub path: PathBuf,
    pub name: String,
    pub dir: PathBuf,
    pub mtime_ms: f64,
    pub size: u64,
    pub format: FormatKind,
    /// Bounded head of a text document, for search. Office files never get one:
    /// their bytes are a package, not text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct Budget {
    pub max_files: usize,
    /// Data formats (JSON, YAML, XML, CSV) across the whole walk. A data dump
    /// must never use up the budget that Markdown and Office files need.
    pub max_data_files: usize,
    /// Data files kept from any one folder. A folder with thousands of JSON
    /// files is a dataset, not documents someone reads.
    pub max_data_per_dir: usize,
    pub max_time: Duration,
    pub max_depth: usize,
    pub max_snippets: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            max_files: 200_000,
            max_data_files: 20_000,
            max_data_per_dir: 64,
            max_time: Duration::from_secs(30),
            max_depth: 24,
            max_snippets: 4000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Truncation {
    Files,
    Time,
    Depth,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct IndexSnapshot {
    pub files: Vec<IndexedDoc>,
    pub scanned_at_ms: u128,
    pub truncated: Option<Truncation>,
    pub dirs: usize,
    pub elapsed_ms: u128,
}

#[derive(Clone, Debug)]
pub struct ScanOptions {
    pub home: PathBuf,
    /// Folders the user registered as workspaces. They outrank every name rule.
    pub roots: Vec<PathBuf>,
    /// Walk the whole home folder too, not only the roots.
    pub include_home: bool,
    /// Moved agent skills folders, each walked as its own target.
    pub configured_skill_dirs: Vec<PathBuf>,
    pub budget: Budget,
}

impl ScanOptions {
    pub fn for_home(home: impl Into<PathBuf>) -> Self {
        Self {
            home: home.into(),
            roots: Vec::new(),
            include_home: true,
            configured_skill_dirs: Vec::new(),
            budget: Budget::default(),
        }
    }

    /// The options the app uses: home plus whatever the environment configures.
    pub fn from_env(home: impl Into<PathBuf>, roots: Vec<PathBuf>) -> Self {
        Self {
            roots,
            configured_skill_dirs: configured_skill_dirs_from_env(),
            ..Self::for_home(home)
        }
    }
}

pub fn is_bundle_dir(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| BUNDLE_EXTS.iter().any(|b| b.eq_ignore_ascii_case(ext)))
}

pub fn is_excluded_dir(name: &str) -> bool {
    !name.is_empty() && (name.starts_with('.') || is_bundle_dir(name) || EXCLUDED_NAMES.contains(&name))
}

/// Re-included even though they sit under a dot folder: the agent tool folders
/// whose skills and instructions Markie shows.
pub fn allowlist(home: &Path, configured_skill_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".claude").join("skills"),
        home.join(".codex"),
        home.join(".agents").join("skills"),
        home.join(".cursor").join("skills"),
        home.join(".gemini").join("skills"),
    ];
    dirs.extend(configured_skill_dirs.iter().cloned());
    dirs.dedup();
    dirs
}

/// The skills folder of each agent config folder the user moved
/// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
pub fn configured_skill_dirs_from_env() -> Vec<PathBuf> {
    ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .filter(|v| !v.trim().is_empty())
        .map(|v| PathBuf::from(v.trim()).join("skills"))
        .collect()
}

/// macOS "Desktop & Documents" iCloud sync makes every readdir a file-provider
/// round trip. Skip a provider-backed one unless the user registered it.
fn skipped_dirs(home: &Path, roots: &[PathBuf]) -> HashSet<PathBuf> {
    let mut skip = HashSet::new();
    if !cfg!(target_os = "macos") {
        return skip;
    }
    for dir in [home.join("Desktop"), home.join("Documents")] {
        let backed = fs::canonicalize(&dir)
            .map(|real| real.to_string_lossy().contains("/Library/Mobile Documents/"))
            .unwrap_or(false);
        if backed && !roots.iter().any(|r| r == &dir || r.starts_with(&dir)) {
            skip.insert(dir);
        }
    }
    skip
}

fn has_excluded_segment(full: &Path, base: &Path) -> bool {
    let rel = full.strip_prefix(base).unwrap_or(full);
    rel.components()
        .any(|c| is_excluded_dir(&c.as_os_str().to_string_lossy()))
}

fn nearest_root<'a>(full: &Path, roots: &'a [PathBuf]) -> Option<&'a PathBuf> {
    roots
        .iter()
        .filter(|r| full.starts_with(r))
        .max_by_key(|r| r.as_os_str().len())
}

fn is_go_pkg(full: &Path, name: &str) -> bool {
    name == "pkg"
        && full
            .parent()
            .and_then(|p| p.file_name())
            .is_some_and(|n| n == "go")
}

fn strictly_inside(child: &Path, parent: &Path) -> bool {
    child != parent && child.starts_with(parent)
}

/// Whether the walk should enter `full`, a directory called `name`.
pub fn should_descend(
    full: &Path,
    name: &str,
    home: &Path,
    allow: &[PathBuf],
    skip: &HashSet<PathBuf>,
    roots: &[PathBuf],
) -> bool {
    if skip.contains(full) {
        return false;
    }
    let base = nearest_root(full, roots);
    if base.is_some_and(|b| b == full) {
        return true;
    }
    if is_bundle_dir(name) {
        return false;
    }
    if let Some(base) = base {
        return !is_go_pkg(full, name) && !has_excluded_segment(full, base);
    }
    if roots.iter().any(|r| strictly_inside(r, full)) {
        return true;
    }
    if allow.iter().any(|a| a == full || strictly_inside(a, full)) {
        return true;
    }
    if allow.iter().any(|a| strictly_inside(full, a)) {
        return !is_go_pkg(full, name) && !name.starts_with('.') && !EXCLUDED_NAMES.contains(&name);
    }
    !is_go_pkg(full, name) && !has_excluded_segment(full, home)
}

fn is_data_format(format: FormatKind) -> bool {
    matches!(format, FormatKind::Json | FormatKind::Yaml | FormatKind::Xml | FormatKind::Csv)
}

fn text_snippet(path: &Path, size: u64) -> Option<String> {
    if size > SNIPPET_MAX_FILE_BYTES {
        return None;
    }
    let mut buf = vec![0u8; SNIPPET_BYTES];
    let mut file = fs::File::open(path).ok()?;
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    // A cut in the middle of a UTF-8 sequence is expected at the 8 KB edge.
    let text = String::from_utf8_lossy(&buf).into_owned();
    (!text.contains('\0')).then_some(text)
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

struct Walker<'a> {
    opts: &'a ScanOptions,
    allow: Vec<PathBuf>,
    skip: HashSet<PathBuf>,
    roots: Vec<PathBuf>,
    started: Instant,
    out: Vec<IndexedDoc>,
    seen: HashSet<PathBuf>,
    snippets: usize,
    data_files: usize,
    dirs: usize,
    stopped: Option<Truncation>,
    depth_capped: bool,
    /// Documents found so far, for whoever is watching the walk.
    found: Option<&'a AtomicUsize>,
}

impl Walker<'_> {
    fn visit(&mut self, dir: &Path, depth: usize) {
        if self.stopped.is_some() {
            return;
        }
        if depth > self.opts.budget.max_depth {
            self.depth_capped = true;
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else { return };
        self.dirs += 1;
        let mut subdirs = Vec::new();
        let mut data_here = 0usize;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = entry.path();
            if file_type.is_dir() {
                if should_descend(&full, &name, &self.opts.home, &self.allow, &self.skip, &self.roots) {
                    subdirs.push(full);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let format = classify(&name);
            if format == FormatKind::Unsupported || self.seen.contains(&full) {
                continue;
            }
            if is_data_format(format) {
                if data_here >= self.opts.budget.max_data_per_dir
                    || self.data_files >= self.opts.budget.max_data_files
                {
                    continue;
                }
                data_here += 1;
                self.data_files += 1;
            }
            if self.out.len() >= self.opts.budget.max_files {
                self.stopped = Some(Truncation::Files);
                return;
            }
            let meta = entry.metadata().ok();
            let size = meta.as_ref().map_or(0, |m| m.len());
            let snippet = if format.representation() == Representation::Text
                && self.snippets < self.opts.budget.max_snippets
            {
                text_snippet(&full, size)
            } else {
                None
            };
            if snippet.is_some() {
                self.snippets += 1;
            }
            self.seen.insert(full.clone());
            self.out.push(IndexedDoc {
                name,
                dir: dir.to_path_buf(),
                mtime_ms: meta.as_ref().map_or(0.0, mtime_ms),
                size,
                format,
                snippet,
                path: full,
            });
        }
        if let Some(found) = self.found {
            found.store(self.out.len(), Ordering::Relaxed);
        }
        if self.started.elapsed() > self.opts.budget.max_time {
            self.stopped = Some(Truncation::Time);
            return;
        }
        subdirs.sort();
        for sub in subdirs {
            if self.stopped.is_some() {
                return;
            }
            self.visit(&sub, depth + 1);
        }
    }
}

/// Targets with any one already inside another dropped, except registered
/// roots, which are always walked as their own target.
fn scan_targets(opts: &ScanOptions) -> Vec<PathBuf> {
    let mut targets: Vec<PathBuf> = Vec::new();
    if opts.include_home || opts.roots.is_empty() {
        targets.push(opts.home.clone());
    }
    targets.extend(opts.roots.iter().cloned());
    targets.extend(opts.configured_skill_dirs.iter().cloned());
    let mut unique: Vec<PathBuf> = Vec::new();
    for t in targets {
        if !unique.contains(&t) {
            unique.push(t);
        }
    }
    unique
        .iter()
        .filter(|t| opts.roots.contains(t) || !unique.iter().any(|o| o != *t && strictly_inside(t, o)))
        .cloned()
        .collect()
}

/// One bounded scan. Runs on the calling thread; call it from a background task.
pub fn scan(opts: &ScanOptions) -> IndexSnapshot {
    scan_counting(opts, None)
}

/// [`scan`], storing the number of documents found so far in `found` after
/// each folder, so a view can show the walk moving.
pub fn scan_counting(opts: &ScanOptions, found: Option<&AtomicUsize>) -> IndexSnapshot {
    let roots: Vec<PathBuf> = opts.roots.clone();
    let mut walker = Walker {
        opts,
        allow: allowlist(&opts.home, &opts.configured_skill_dirs),
        skip: skipped_dirs(&opts.home, &roots),
        roots,
        started: Instant::now(),
        out: Vec::new(),
        seen: HashSet::new(),
        snippets: 0,
        data_files: 0,
        dirs: 0,
        stopped: None,
        depth_capped: false,
        found,
    };
    for target in scan_targets(opts) {
        if walker.stopped.is_some() {
            break;
        }
        walker.visit(&target, 0);
    }
    IndexSnapshot {
        truncated: walker
            .stopped
            .or(walker.depth_capped.then_some(Truncation::Depth)),
        dirs: walker.dirs,
        elapsed_ms: walker.started.elapsed().as_millis(),
        scanned_at_ms: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis()),
        files: walker.out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn finds_every_openable_type_and_prunes_noise() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        touch(&h.join("Notes/plan.md"), "# Plan\nship it");
        touch(&h.join("Notes/letter.docx"), "PK\x03\x04");
        touch(&h.join("Notes/data.csv"), "a,b");
        touch(&h.join("Notes/photo.png"), "x");
        touch(&h.join("code/node_modules/pkg/README.md"), "vendored");
        touch(&h.join(".hidden/secret.md"), "hidden");
        touch(&h.join("Thing.app/Contents/info.md"), "bundle");
        touch(&h.join(".claude/skills/demo/SKILL.md"), "---\ndescription: demo\n---");
        touch(&h.join(".claude/sessions/log.md"), "not a skill");

        let snap = scan(&ScanOptions::for_home(h));
        let mut names: Vec<_> = snap.files.iter().map(|f| f.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["SKILL.md", "data.csv", "letter.docx", "plan.md"]);
        let plan = snap.files.iter().find(|f| f.name == "plan.md").unwrap();
        assert_eq!(plan.snippet.as_deref(), Some("# Plan\nship it"));
        let docx = snap.files.iter().find(|f| f.name == "letter.docx").unwrap();
        assert!(docx.snippet.is_none(), "office bytes never become a snippet");
    }

    #[test]
    fn the_walk_reports_what_it_has_found() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        touch(&h.join("a/one.md"), "1");
        touch(&h.join("b/two.md"), "2");
        touch(&h.join("b/c/three.txt"), "3");
        let found = AtomicUsize::new(0);
        let snap = scan_counting(&ScanOptions::for_home(h), Some(&found));
        assert_eq!(snap.files.len(), 3);
        assert_eq!(found.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn a_registered_root_outranks_name_rules() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        touch(&h.join("Pictures/Screenshots/notes.md"), "kept");
        touch(&h.join("Pictures/Screenshots/node_modules/x.md"), "still pruned");
        let mut opts = ScanOptions::for_home(h);
        opts.roots = vec![h.join("Pictures/Screenshots")];
        let snap = scan(&opts);
        let names: Vec<_> = snap.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["notes.md"]);
    }

    #[test]
    fn a_data_dump_cannot_crowd_out_documents() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        for i in 0..100 {
            touch(&h.join(format!("dump/rows-{i:03}.json")), "{}");
        }
        touch(&h.join("zz-notes/plan.md"), "# kept");
        let mut opts = ScanOptions::for_home(h);
        opts.budget.max_data_per_dir = 10;
        let snap = scan(&opts);
        let json = snap.files.iter().filter(|f| f.format == FormatKind::Json).count();
        assert_eq!(json, 10);
        assert!(snap.files.iter().any(|f| f.name == "plan.md"));
    }

    #[test]
    fn stops_at_the_file_budget() {
        let home = tempfile::tempdir().unwrap();
        for i in 0..10 {
            touch(&home.path().join(format!("n{i}.md")), "x");
        }
        let mut opts = ScanOptions::for_home(home.path());
        opts.budget.max_files = 3;
        let snap = scan(&opts);
        assert_eq!(snap.files.len(), 3);
        assert_eq!(snap.truncated, Some(Truncation::Files));
    }
}
