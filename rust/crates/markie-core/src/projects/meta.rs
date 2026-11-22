//! Per-file metadata the taxonomy needs beyond the index row: creation time,
//! the `markie:` front matter declaration, and the containing repository.
//! A port of `electron/mdmeta.js`. Incremental: only Markdown rows whose mtime
//! moved since the stored extraction are read again.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::frontmatter::extract_markie_meta;
use super::store::MetaRow;
use crate::formats::FormatKind;
use crate::index::IndexedDoc;

pub const HEAD_BYTES: usize = 4096;

fn read_head(path: &Path) -> String {
    let mut buf = vec![0u8; HEAD_BYTES];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

fn birthtime_ms(path: &Path) -> Option<f64> {
    let t = std::fs::metadata(path).ok()?.created().ok()?;
    let ms = t.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
    (ms > 0.0).then_some(ms)
}

/// `gitdir: <path>` in a worktree's or submodule's `.git` file.
pub fn parse_gitdir_pointer(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:").map(|r| r.trim().to_string()))
        .filter(|s| !s.is_empty())
}

/// The parent repository a worktree pointer names (`<common>/worktrees/<n>`),
/// or None for a submodule or anything else.
pub fn worktree_parent_root(gitdir: &str, worktree_dir: &Path) -> Option<PathBuf> {
    let abs = if Path::new(gitdir).is_absolute() { PathBuf::from(gitdir) } else { worktree_dir.join(gitdir) };
    let parts: Vec<String> = abs
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let at = parts.iter().rposition(|p| p == "worktrees")?;
    if at == 0 || at != parts.len() - 2 {
        return None;
    }
    let common: PathBuf = std::iter::once("/".to_string()).chain(parts[..at].iter().cloned()).collect();
    if common.file_name().is_some_and(|n| n == ".git") { common.parent().map(Path::to_path_buf) } else { Some(common) }
}

fn repo_name_of(root: &Path) -> String {
    let base = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stripped = base.strip_suffix(".git").unwrap_or(&base);
    if stripped.is_empty() { base } else { stripped.to_string() }
}

/// The nearest repository at or above `dir`, never climbing past `home`.
/// The cache covers every folder walked, hits and misses alike.
pub fn find_repo_name(dir: &Path, home: &Path, cache: &mut HashMap<PathBuf, Option<String>>) -> Option<String> {
    let mut walked = Vec::new();
    let mut found = None;
    let mut d = dir.to_path_buf();
    while d.starts_with(home) {
        if let Some(hit) = cache.get(&d) {
            found = hit.clone();
            break;
        }
        walked.push(d.clone());
        let entry = d.join(".git");
        if let Ok(meta) = std::fs::metadata(&entry) {
            let pointer = if meta.is_file() {
                std::fs::read_to_string(&entry).ok().and_then(|t| parse_gitdir_pointer(&t))
            } else {
                None
            };
            let parent = pointer.and_then(|p| worktree_parent_root(&p, &d));
            found = Some(match parent {
                Some(root) => repo_name_of(&root),
                None => d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            });
            break;
        }
        if !d.pop() {
            break;
        }
    }
    for w in walked {
        cache.insert(w, found.clone());
    }
    found
}

pub struct MetaRefresh {
    pub updated: Vec<MetaRow>,
    /// Rows left for a later slice because the time budget ran out.
    pub remaining: usize,
}

/// New or changed Markdown rows, re-read within `budget`.
pub fn refresh_meta(rows: &[IndexedDoc], known: &HashMap<String, MetaRow>, home: &Path, budget: Duration) -> MetaRefresh {
    let started = Instant::now();
    let mut repo_cache = HashMap::new();
    let mut updated = Vec::new();
    let mut remaining = 0;
    let mut spent = false;
    for row in rows {
        if row.format != FormatKind::Markdown {
            continue;
        }
        let key = row.path.to_string_lossy();
        if known.get(key.as_ref()).is_some_and(|m| m.mtime_ms == row.mtime_ms) {
            continue;
        }
        if spent || started.elapsed() >= budget {
            spent = true;
            remaining += 1;
            continue;
        }
        let meta = extract_markie_meta(&read_head(&row.path));
        updated.push(MetaRow {
            path: key.into_owned(),
            mtime_ms: row.mtime_ms,
            birthtime_ms: birthtime_ms(&row.path),
            fm_project: meta.project,
            fm_block: meta.block,
            repo_name: find_repo_name(&row.dir, home, &mut repo_cache),
        });
    }
    MetaRefresh { updated, remaining }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_pointers_resolve_to_the_parent_repo() {
        assert_eq!(parse_gitdir_pointer("gitdir: /r/app/.git/worktrees/sprint\n").as_deref(), Some("/r/app/.git/worktrees/sprint"));
        let wt = Path::new("/w/sprint");
        assert_eq!(worktree_parent_root("/r/app/.git/worktrees/sprint", wt), Some(PathBuf::from("/r/app")));
        assert_eq!(worktree_parent_root("/r/app.git/worktrees/s", wt), Some(PathBuf::from("/r/app.git")));
        assert_eq!(worktree_parent_root("/r/app/.git/modules/sub", wt), None, "a submodule is its own repo");
        assert_eq!(worktree_parent_root("/r/worktrees/x/y", wt), None);
        assert_eq!(repo_name_of(Path::new("/r/app.git")), "app");
    }

    #[test]
    fn finds_repos_and_reads_front_matter() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::create_dir_all(h.join("code/app/.git")).unwrap();
        std::fs::create_dir_all(h.join("code/app/docs")).unwrap();
        std::fs::create_dir_all(h.join("wt/sprint")).unwrap();
        std::fs::write(h.join("wt/sprint/.git"), format!("gitdir: {}\n", h.join("code/app/.git/worktrees/sprint").display())).unwrap();
        std::fs::write(h.join("code/app/docs/a.md"), "---\nmarkie:\n  project: Launch\n---\n").unwrap();
        std::fs::write(h.join("wt/sprint/b.md"), "x").unwrap();
        std::fs::write(h.join("loose.md"), "x").unwrap();
        let idx = |p: PathBuf, m: f64| IndexedDoc {
            name: p.file_name().unwrap().to_string_lossy().into(),
            dir: p.parent().unwrap().into(),
            path: p,
            mtime_ms: m,
            size: 1,
            format: FormatKind::Markdown,
            snippet: None,
        };
        let rows = vec![idx(h.join("code/app/docs/a.md"), 1.0), idx(h.join("wt/sprint/b.md"), 2.0), idx(h.join("loose.md"), 3.0)];
        let r = refresh_meta(&rows, &HashMap::new(), h, Duration::from_secs(5));
        assert_eq!(r.updated.len(), 3);
        assert_eq!(r.updated[0].repo_name.as_deref(), Some("app"));
        assert_eq!(r.updated[0].fm_project.as_deref(), Some("Launch"));
        assert_eq!(r.updated[1].repo_name.as_deref(), Some("app"), "a worktree joins its parent repo");
        assert_eq!(r.updated[2].repo_name, None);
        let known: HashMap<_, _> = r.updated.into_iter().map(|m| (m.path.clone(), m)).collect();
        assert!(refresh_meta(&rows, &known, h, Duration::from_secs(5)).updated.is_empty(), "incremental");
        assert_eq!(refresh_meta(&rows, &HashMap::new(), h, Duration::ZERO).remaining, 3);
    }
}
