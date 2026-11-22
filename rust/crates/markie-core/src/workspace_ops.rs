//! Moving, renaming and unregistering in the Files workspace. A port of
//! `electron/workspace.js` (`move`, `rename`, `removeRoot`, `sanitizeName`,
//! `withinRoots`) plus the registry bookkeeping that follows a move
//! (`registry.movePath` / `movePrefix`): every path-keyed table follows the
//! file, so its recents, star, project pin and metadata stay attached.

use std::path::{Path, PathBuf};

use crate::registry::Registry;

#[derive(Debug, PartialEq, Eq)]
pub enum MoveError {
    OutsideWorkspace,
    Taken,
    InvalidName,
    Io(String),
}

impl std::fmt::Display for MoveError {
    /// Electron's wording.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OutsideWorkspace => write!(f, "Outside the workspace"),
            Self::Taken => write!(f, "Already a file with that name there"),
            Self::InvalidName => write!(f, "Invalid name"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

/// `sanitizeName`: separators and control characters dropped, `.`/`..`
/// refused, plus Windows' rules on Windows.
pub fn sanitize_name(name: &str) -> Option<String> {
    let mut safe: String = name.chars().filter(|c| !matches!(c, '/' | '\\') && (*c as u32) > 0x1f).collect();
    if cfg!(windows) {
        safe.retain(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    }
    let mut safe = safe.trim().to_string();
    if cfg!(windows) {
        safe = safe.trim_end_matches(['.', ' ']).to_string();
        let stem = safe.split('.').next().unwrap_or("").to_ascii_lowercase();
        let reserved = ["con", "prn", "aux", "nul"].contains(&stem.as_str())
            || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if reserved {
            return None;
        }
    }
    (!safe.is_empty() && safe != "." && safe != "..").then_some(safe)
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().trim_end_matches('/').to_string();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// Whether `target` is a registered root or inside one.
pub fn within_roots(target: &Path, roots: &[PathBuf]) -> bool {
    let t = norm(target);
    roots.iter().any(|r| {
        let r = norm(r);
        t == r || t.starts_with(&format!("{r}{}", std::path::MAIN_SEPARATOR))
    })
}

fn follow(reg: &Registry, from: &Path, to: &Path, is_dir: bool) -> anyhow::Result<()> {
    if is_dir {
        let sep = std::path::MAIN_SEPARATOR;
        reg.move_prefix(&format!("{}{sep}", from.display()), &format!("{}{sep}", to.display()))
    } else {
        reg.move_path(from, to)
    }
}

/// `ws-move`: `src` into `dest_dir`, keeping its name. Never overwrites.
pub fn move_into(src: &Path, dest_dir: &Path, roots: &[PathBuf], reg: &Registry) -> Result<PathBuf, MoveError> {
    if !within_roots(src, roots) || !within_roots(dest_dir, roots) {
        return Err(MoveError::OutsideWorkspace);
    }
    let name = src.file_name().ok_or(MoveError::InvalidName)?;
    let dest = dest_dir.join(name);
    if norm(src) == norm(&dest) {
        return Ok(dest);
    }
    if dest.exists() {
        return Err(MoveError::Taken);
    }
    let is_dir = src.is_dir();
    std::fs::rename(src, &dest).map_err(|e| MoveError::Io(e.to_string()))?;
    follow(reg, src, &dest, is_dir).map_err(|e| MoveError::Io(e.to_string()))?;
    Ok(dest)
}

/// `ws-rename`: a new name in the same folder. Never overwrites.
pub fn rename(target: &Path, new_name: &str, roots: &[PathBuf], reg: &Registry) -> Result<PathBuf, MoveError> {
    if !within_roots(target, roots) {
        return Err(MoveError::OutsideWorkspace);
    }
    let safe = sanitize_name(new_name).ok_or(MoveError::InvalidName)?;
    let dest = target.parent().unwrap_or(Path::new("")).join(safe);
    if dest.exists() {
        return Err(MoveError::Taken);
    }
    let is_dir = target.is_dir();
    std::fs::rename(target, &dest).map_err(|e| MoveError::Io(e.to_string()))?;
    follow(reg, target, &dest, is_dir).map_err(|e| MoveError::Io(e.to_string()))?;
    Ok(dest)
}

/// `ws-remove-root`: the folder leaves the Library. Nothing on disk changes.
pub fn remove_root(root: &Path, reg: &Registry) -> anyhow::Result<()> {
    reg.remove_root(root)
}

/// `workspace.roots()`: registered roots that still exist as folders.
pub fn live_roots(reg: &Registry) -> Vec<PathBuf> {
    reg.roots().unwrap_or_default().into_iter().filter(|p| p.is_dir()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize_name(" a/b\\c\u{7}.md "), Some("abc.md".into()));
        assert_eq!(sanitize_name(".."), None);
        assert_eq!(sanitize_name("  "), None);
    }

    #[test]
    fn moves_files_and_folders_with_their_registry_rows() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir_all(root.join("a/sub")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a/one.md"), "1").unwrap();
        std::fs::write(root.join("a/sub/two.md"), "2").unwrap();
        let reg = Registry::in_memory().unwrap();
        reg.add_root(&root).unwrap();
        reg.track_opened(&root.join("a/one.md")).unwrap();
        reg.toggle_star(&root.join("a/sub/two.md"), "file").unwrap();
        crate::projects::store::ensure_tables(reg.conn()).unwrap();
        crate::projects::store::pin_set(reg.conn(), &root.join("a/one.md").to_string_lossy(), "P", None).unwrap();
        let roots = live_roots(&reg);

        let moved = move_into(&root.join("a/one.md"), &root.join("b"), &roots, &reg).unwrap();
        assert_eq!(moved, root.join("b/one.md"));
        assert!(moved.exists());
        assert_eq!(reg.recent(5).unwrap()[0].path, moved);
        assert_eq!(crate::projects::store::pins_all(reg.conn()).unwrap()[0].path, moved.to_string_lossy());

        let folder = rename(&root.join("a/sub"), "renamed", &roots, &reg).unwrap();
        assert!(reg.is_starred(&folder.join("two.md")).unwrap(), "rows under a folder follow it");

        std::fs::write(root.join("a/one.md"), "again").unwrap();
        assert_eq!(move_into(&root.join("a/one.md"), &root.join("b"), &roots, &reg), Err(MoveError::Taken));
        assert_eq!(move_into(&root.join("a/one.md"), dir.path(), &roots, &reg), Err(MoveError::OutsideWorkspace));
        assert_eq!(rename(&root.join("b/one.md"), "..", &roots, &reg), Err(MoveError::InvalidName));

        remove_root(&root, &reg).unwrap();
        assert!(live_roots(&reg).is_empty());
        assert!(root.join("b/one.md").exists(), "removing a folder deletes nothing");
    }
}
