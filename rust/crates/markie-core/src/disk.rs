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

#[cfg(test)]
mod tests {
    use super::*;

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
