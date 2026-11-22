//! Telling Markie's own writes apart from changes made by something else.
//! Mirrors `electron/disk-memory.js`: remember the hash of what we last read
//! or wrote, plus size and mtime of our own writes.
//!
//! The poll runs every second on the main thread, so it reads and hashes the
//! file only when its size or mtime moved since the last check that matched.
//! The hash is in memory only, so it is a fast one, not SHA-256: hashing a
//! 10 MB file with SHA-256 every second cost 76 ms of main thread a second.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Debug)]
struct Seen {
    hash: u64,
    own_write: Option<(u64, SystemTime)>,
    /// Size and mtime when the bytes last matched `hash`.
    verified: Option<(u64, SystemTime)>,
}

fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

fn stamp(meta: &fs::Metadata) -> Option<(u64, SystemTime)> {
    Some((meta.len(), meta.modified().ok()?))
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
            .and_then(|m| stamp(&m));
        self.seen.insert(
            path.to_path_buf(),
            Seen { hash: content_hash(content.as_bytes()), own_write: stamp, verified: None },
        );
    }

    pub fn forget(&mut self, path: &Path) {
        self.seen.remove(path);
    }

    /// What changed on disk since we last saw `path`, or `None` when it matches
    /// or is unknown.
    pub fn changed_since(&mut self, path: &Path) -> Option<DiskChange> {
        let known = self.seen.get_mut(path)?;
        let Ok(meta) = fs::metadata(path) else { return Some(DiskChange::Missing) };
        let now = stamp(&meta);
        if now.is_some() && (known.own_write == now || known.verified == now) {
            return None;
        }
        let bytes = fs::read(path).ok()?;
        if content_hash(&bytes) == known.hash {
            // The stamp was taken before the read, so a write after it moves
            // the stamp again and is checked next time.
            known.verified = now;
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
        // Same bytes rewritten by someone else: quiet, and quiet again on the
        // next poll without a read.
        fs::write(&p, "three, from an agent").unwrap();
        mem.remember(&p, "three, from an agent", false);
        assert_eq!(mem.changed_since(&p), None);
        assert!(mem.seen[&p].verified.is_some());
        assert_eq!(mem.changed_since(&p), None);
        fs::write(&p, "four").unwrap();
        assert_eq!(mem.changed_since(&p), Some(DiskChange::Changed("four".into())));
        fs::remove_file(&p).unwrap();
        assert_eq!(mem.changed_since(&p), Some(DiskChange::Missing));
    }
}
