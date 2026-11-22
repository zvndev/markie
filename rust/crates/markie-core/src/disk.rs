//! Telling Markie's own writes apart from changes made by something else.
//! Mirrors `electron/disk-memory.js`: remember the hash of what we last read
//! or wrote, plus size and mtime of our own writes.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::clock::sha256_hex;

#[derive(Clone, Debug)]
struct Seen {
    hash: String,
    own_write: Option<(u64, SystemTime)>,
}

#[derive(Default)]
pub struct DiskMemory {
    seen: HashMap<PathBuf, Seen>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiskChange {
    /// Someone else changed the file; here is what it says now.
    Changed(String),
    /// The file is gone or unreadable.
    Missing,
}

impl DiskMemory {
    pub fn remember(&mut self, path: &Path, content: &str, own_write: bool) {
        let stamp = own_write
            .then(|| fs::metadata(path).ok())
            .flatten()
            .and_then(|m| Some((m.len(), m.modified().ok()?)));
        self.seen.insert(path.to_path_buf(), Seen { hash: sha256_hex(content.as_bytes()), own_write: stamp });
    }

    pub fn forget(&mut self, path: &Path) {
        self.seen.remove(path);
    }

    /// What changed on disk since we last saw `path`, or `None` when it matches
    /// or is unknown.
    pub fn changed_since(&self, path: &Path) -> Option<DiskChange> {
        let known = self.seen.get(path)?;
        let Ok(meta) = fs::metadata(path) else { return Some(DiskChange::Missing) };
        if let (Some((size, mtime)), Ok(now_mtime)) = (known.own_write, meta.modified()) {
            if size == meta.len() && mtime == now_mtime {
                return None;
            }
        }
        let bytes = fs::read(path).ok()?;
        if sha256_hex(&bytes) == known.hash {
            return None;
        }
        Some(DiskChange::Changed(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

impl DiskMemory {
    /// The file's size when it is at or over the open cap and is not the
    /// file Markie wrote (`overCapOnDisk`). A save then writes nothing.
    pub fn over_cap(&self, path: &Path) -> Option<u64> {
        let meta = fs::metadata(path).ok()?;
        if meta.len() < crate::document::MAX_DOC_BYTES {
            return None;
        }
        let own = self.seen.get(path).and_then(|s| s.own_write);
        match (own, meta.modified()) {
            (Some((size, mtime)), Ok(now)) if size == meta.len() && mtime == now => None,
            _ => Some(meta.len()),
        }
    }
}

/// `formatMegabytes` in `electron/doc-tiers.js`.
pub fn format_megabytes(bytes: u64) -> String {
    let mb = bytes as f64 / 1_000_000.0;
    if mb < 10.0 { format!("{mb:.1} MB") } else { format!("{} MB", mb.round() as u64) }
}

/// The refusal `save-file` returns for a file that outgrew the cap.
pub fn over_cap_message(name: &str, size: u64) -> String {
    format!(
        "{name} on disk is now {}, more than Markie opens ({}). Save your copy under another name.",
        format_megabytes(size),
        format_megabytes(crate::document::MAX_DOC_BYTES)
    )
}

/// What a save may do when the file changed underneath us. A port of
/// `electron/save-conflict.js`: a forced save (the conflict dialog already
/// asked) or an unchanged file proceeds; an autosave refuses, so it never
/// opens a dialog and never writes over another writer's work; a save the
/// user asked for asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveAction {
    Proceed,
    Refuse,
    Ask,
}

pub fn save_conflict_action(autosave: bool, force: bool, changed: bool) -> SaveAction {
    if force || !changed {
        SaveAction::Proceed
    } else if autosave {
        SaveAction::Refuse
    } else {
        SaveAction::Ask
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // electron/save-conflict.test.ts, case for case.
    #[test]
    fn save_conflict_rules_match_electron() {
        assert_eq!(save_conflict_action(false, false, false), SaveAction::Proceed);
        assert_eq!(save_conflict_action(true, false, false), SaveAction::Proceed);
        assert_eq!(save_conflict_action(true, false, true), SaveAction::Refuse);
        assert_eq!(save_conflict_action(false, false, true), SaveAction::Ask);
        assert_eq!(save_conflict_action(false, true, true), SaveAction::Proceed);
        assert_eq!(save_conflict_action(true, true, true), SaveAction::Proceed);
    }

    #[test]
    fn megabytes_read_as_electron_writes_them() {
        assert_eq!(format_megabytes(100_000_000), "100 MB");
        assert_eq!(format_megabytes(2_500_000), "2.5 MB");
        assert_eq!(over_cap_message("a.md", 120_000_000), "a.md on disk is now 120 MB, more than Markie opens (100 MB). Save your copy under another name.");
    }

    #[test]
    fn an_emptied_file_is_still_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, "mine").unwrap();
        let mut mem = DiskMemory::default();
        mem.remember(&p, "mine", false);
        fs::write(&p, "").unwrap();
        assert_eq!(mem.changed_since(&p), Some(DiskChange::Changed(String::new())));
    }

    #[test]
    fn own_writes_are_quiet_and_others_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, "one").unwrap();
        let mut mem = DiskMemory::default();
        mem.remember(&p, "one", false);
        assert_eq!(mem.changed_since(&p), None);
        fs::write(&p, "two").unwrap();
        mem.remember(&p, "two", true);
        assert_eq!(mem.changed_since(&p), None);
        fs::write(&p, "three, from an agent").unwrap();
        assert_eq!(mem.changed_since(&p), Some(DiskChange::Changed("three, from an agent".into())));
        fs::remove_file(&p).unwrap();
        assert_eq!(mem.changed_since(&p), Some(DiskChange::Missing));
    }
}
