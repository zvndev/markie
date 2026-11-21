//! Finding, copying and guarding the Electron profile.
//!
//! The rule: the live profile is only ever read by `copy_profile`, which reads
//! file bytes and nothing else. Every decoder runs on the copy, and refuses a
//! path inside a live profile.
use crate::error::{MigrateError, Result};
use std::path::{Path, PathBuf};

/// The Electron app's userData folder: `<config dir>/Markie`, which is
/// `~/Library/Application Support/Markie` on macOS.
pub fn electron_user_data() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("Markie"))
}

pub const LOCAL_STORAGE_DIR: &str = "Local Storage/leveldb";
/// The renderer's origin is `app://markie`; Chromium names its IndexedDB folders after it.
pub const IDB_LEVELDB_DIR: &str = "IndexedDB/app_markie_0.indexeddb.leveldb";
pub const IDB_BLOB_DIR: &str = "IndexedDB/app_markie_0.indexeddb.blob";
pub const ELECTRON_ORIGIN: &str = "app://markie";

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Refuses any path inside a live Electron profile.
pub fn ensure_not_live(path: &Path, live: Option<&Path>) -> Result<()> {
    let Some(live) = live else { return Ok(()) };
    let (path, live) = (canonical(path), canonical(live));
    if path.starts_with(&live) {
        return Err(MigrateError::LiveProfile(path.display().to_string()));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopiedProfile {
    pub root: PathBuf,
    pub files: usize,
    pub bytes: u64,
    /// Chromium's `SingletonLock` was present: Electron Markie was probably running,
    /// so a store could have changed mid-copy. The app should ask the user to quit it.
    pub electron_was_running: bool,
}

fn copy_tree(from: &Path, to: &Path, files: &mut usize, bytes: &mut u64) -> Result<()> {
    let io = |p: &Path, e| MigrateError::Io(p.display().to_string(), e);
    std::fs::create_dir_all(to).map_err(|e| io(to, e))?;
    for entry in std::fs::read_dir(from).map_err(|e| io(from, e))? {
        let entry = entry.map_err(|e| io(from, e))?;
        let name = entry.file_name();
        // The LOCK file is LevelDB's lock: copying it is pointless, and it is never opened.
        if name == "LOCK" {
            continue;
        }
        let kind = entry.file_type().map_err(|e| io(&entry.path(), e))?;
        if kind.is_symlink() {
            continue;
        }
        let target = to.join(&name);
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, files, bytes)?;
        } else if kind.is_file() {
            // A plain read of the source; nothing is opened for writing there.
            let data = std::fs::read(entry.path()).map_err(|e| io(&entry.path(), e))?;
            std::fs::write(&target, &data).map_err(|e| io(&target, e))?;
            *files += 1;
            *bytes += data.len() as u64;
        }
    }
    Ok(())
}

/// Copies only the stores the migration reads into `scratch`, which must be
/// empty or missing and outside the profile. Missing stores are skipped.
pub fn copy_profile(user_data: &Path, scratch: &Path) -> Result<CopiedProfile> {
    ensure_not_live(scratch, Some(user_data))?;
    if scratch.exists() && std::fs::read_dir(scratch).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(MigrateError::LiveProfile(format!("{} is not an empty scratch folder", scratch.display())));
    }
    let mut copied = CopiedProfile {
        root: scratch.to_path_buf(),
        files: 0,
        bytes: 0,
        electron_was_running: std::fs::symlink_metadata(user_data.join("SingletonLock")).is_ok(),
    };
    for dir in [LOCAL_STORAGE_DIR, IDB_LEVELDB_DIR, IDB_BLOB_DIR] {
        let from = user_data.join(dir);
        if from.is_dir() {
            copy_tree(&from, &scratch.join(dir), &mut copied.files, &mut copied.bytes)?;
        }
    }
    Ok(copied)
}
