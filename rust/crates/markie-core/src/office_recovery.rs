//! Recovery history for office documents (DOCX, RTF, ODT, DOC copies).
//!
//! Electron keeps an office document's "Recovery history" in its document
//! library (`src/lib/document-library/repository.ts`, IndexedDB): each change
//! is serialized through the office engine into a new local revision about
//! 600 ms after the edit, at most five revisions per document, and restoring
//! one makes a newer revision while the file on disk stays as it is. This is
//! the same model on plain files under Markie RS's data folder:
//!
//! `<data>/document-recovery/<slug>/index.json` plus `<revision>.bin`.
//!
//! Limits are Electron's `DEFAULT_LIBRARY_LIMITS`: 5 per document, 32 MB per
//! document, 128 MB across every document. Eviction drops the oldest
//! recovery revisions first and never the one just written.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::{sha256_hex, slug_for};

pub const MAX_RECOVERY_PER_DOCUMENT: usize = 5;
pub const MAX_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
/// Electron debounces a recovery save this long after the last change.
pub const RECOVERY_DEBOUNCE_MS: u64 = 600;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub revision: u64,
    pub saved_at: i64,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryIndex {
    pub path: String,
    pub format: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// The newest revision number handed out (revisions never reuse numbers).
    pub revision: u64,
    /// The revision that matches the file on disk, when one does.
    pub exported_revision: Option<u64>,
    /// Oldest first.
    pub revisions: Vec<Revision>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryError {
    TooLarge,
    NotFound,
    Io(String),
}

impl std::fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge => write!(f, "Document and its recovery snapshot exceed the library payload budget."),
            Self::NotFound => write!(f, "This recovery revision is no longer available."),
            Self::Io(e) => write!(f, "Local recovery is unavailable. {e}"),
        }
    }
}

impl From<std::io::Error> for RecoveryError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

pub struct RecoveryStore {
    root: PathBuf,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl RecoveryStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("document-recovery"), now: Box::new(crate::clock::now_ms) }
    }

    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.now = Box::new(now);
        self
    }

    fn dir(&self, file: &Path) -> PathBuf {
        self.root.join(slug_for(file))
    }

    pub fn index(&self, file: &Path) -> Option<RecoveryIndex> {
        fs::read(self.dir(file).join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    fn write_index(&self, file: &Path, idx: &RecoveryIndex) -> std::io::Result<()> {
        let dir = self.dir(file);
        fs::create_dir_all(&dir)?;
        crate::save::atomic_write(&dir.join("index.json"), &serde_json::to_vec(idx).unwrap_or_default())
    }

    /// Revisions newest first, as the Recovery history list shows them.
    pub fn list(&self, file: &Path) -> Vec<Revision> {
        let mut v = self.index(file).map(|i| i.revisions).unwrap_or_default();
        v.reverse();
        v
    }

    pub fn read(&self, file: &Path, revision: u64) -> Option<Vec<u8>> {
        let idx = self.index(file)?;
        idx.revisions.iter().any(|r| r.revision == revision).then_some(())?;
        fs::read(self.dir(file).join(format!("{revision}.bin"))).ok()
    }

    /// Keep `bytes` as a new revision. Identical bytes to the newest revision
    /// are not stored twice (Electron skips a session whose generation did not
    /// move). Returns the newest revision either way.
    pub fn put(&self, file: &Path, format: &str, bytes: &[u8]) -> Result<Revision, RecoveryError> {
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(RecoveryError::TooLarge);
        }
        let hash = sha256_hex(bytes);
        let mut idx = self.index(file).unwrap_or_else(|| RecoveryIndex {
            path: file.to_string_lossy().into_owned(),
            format: format.into(),
            ..Default::default()
        });
        if let Some(last) = idx.revisions.last()
            && last.sha256 == hash
        {
            return Ok(last.clone());
        }
        // Electron's clock never runs backwards for one document.
        let now = (self.now)().max(idx.updated_at);
        if idx.created_at == 0 {
            idx.created_at = now;
        }
        idx.updated_at = now;
        idx.revision += 1;
        idx.format = format.into();
        let rev = Revision { revision: idx.revision, saved_at: now, size: bytes.len() as u64, sha256: hash };
        let dir = self.dir(file);
        fs::create_dir_all(&dir)?;
        crate::save::atomic_write(&dir.join(format!("{}.bin", rev.revision)), bytes)?;
        idx.revisions.push(rev.clone());
        while idx.revisions.len() > MAX_RECOVERY_PER_DOCUMENT {
            let old = idx.revisions.remove(0);
            let _ = fs::remove_file(dir.join(format!("{}.bin", old.revision)));
        }
        self.write_index(file, &idx)?;
        self.evict_over_budget(file, rev.revision)?;
        Ok(rev)
    }

    /// The file on disk now matches `revision` (a save or an open).
    pub fn mark_exported(&self, file: &Path, revision: u64) -> Result<(), RecoveryError> {
        let mut idx = self.index(file).ok_or(RecoveryError::NotFound)?;
        idx.exported_revision = Some(revision);
        Ok(self.write_index(file, &idx)?)
    }

    /// Whether the newest revision is the bytes on disk.
    pub fn newest_is_exported(&self, file: &Path) -> bool {
        self.index(file).is_some_and(|i| i.exported_revision.is_some() && i.exported_revision == i.revisions.last().map(|r| r.revision))
    }

    /// Restoring makes a new revision holding the old bytes. The file on disk
    /// is unchanged. Returns the bytes to load and the new revision.
    pub fn restore(&self, file: &Path, revision: u64) -> Result<(Vec<u8>, Revision), RecoveryError> {
        let bytes = self.read(file, revision).ok_or(RecoveryError::NotFound)?;
        let format = self.index(file).map(|i| i.format).unwrap_or_default();
        // A restore of the newest revision still records the decision.
        let rev = self.put_forced(file, &format, &bytes)?;
        Ok((bytes, rev))
    }

    fn put_forced(&self, file: &Path, format: &str, bytes: &[u8]) -> Result<Revision, RecoveryError> {
        if let Some(mut idx) = self.index(file)
            && idx.revisions.last().is_some_and(|r| r.sha256 == sha256_hex(bytes))
        {
            // Same bytes as the newest: give it a fresh number so the list
            // shows the restore, like Electron's planPut.
            let mut last = idx.revisions.pop().unwrap();
            let dir = self.dir(file);
            let now = (self.now)().max(idx.updated_at);
            idx.revision += 1;
            idx.updated_at = now;
            let old = dir.join(format!("{}.bin", last.revision));
            last.revision = idx.revision;
            last.saved_at = now;
            fs::rename(old, dir.join(format!("{}.bin", last.revision)))?;
            idx.revisions.push(last.clone());
            self.write_index(file, &idx)?;
            return Ok(last);
        }
        self.put(file, format, bytes)
    }

    /// Forget a document and its whole recovery history.
    pub fn remove(&self, file: &Path) -> std::io::Result<()> {
        match fs::remove_dir_all(self.dir(file)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// Follow a rename or move: the history travels with the document.
    pub fn moved(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        let (a, b) = (self.dir(from), self.dir(to));
        if !a.exists() {
            return Ok(());
        }
        let _ = fs::remove_dir_all(&b);
        fs::create_dir_all(&self.root)?;
        fs::rename(&a, &b)?;
        if let Some(mut idx) = self.index(to) {
            idx.path = to.to_string_lossy().into_owned();
            self.write_index(to, &idx)?;
        }
        Ok(())
    }

    fn evict_over_budget(&self, keep_file: &Path, keep_rev: u64) -> std::io::Result<()> {
        let Ok(rd) = fs::read_dir(&self.root) else { return Ok(()) };
        let mut all: Vec<(PathBuf, RecoveryIndex)> = rd
            .flatten()
            .filter_map(|e| {
                let idx: RecoveryIndex = serde_json::from_slice(&fs::read(e.path().join("index.json")).ok()?).ok()?;
                Some((e.path(), idx))
            })
            .collect();
        let mut total: u64 = all.iter().flat_map(|(_, i)| i.revisions.iter().map(|r| r.size)).sum();
        if total <= MAX_TOTAL_BYTES {
            return Ok(());
        }
        let keep_dir = self.dir(keep_file);
        let mut candidates: Vec<(i64, u64, usize)> = Vec::new();
        for (n, (dir, idx)) in all.iter().enumerate() {
            for r in &idx.revisions {
                if !(dir == &keep_dir && r.revision == keep_rev) {
                    candidates.push((r.saved_at, r.revision, n));
                }
            }
        }
        candidates.sort();
        for (_, rev, n) in candidates {
            if total <= MAX_TOTAL_BYTES {
                break;
            }
            let (dir, idx) = &mut all[n];
            if let Some(pos) = idx.revisions.iter().position(|r| r.revision == rev) {
                total -= idx.revisions[pos].size;
                idx.revisions.remove(pos);
                let _ = fs::remove_file(dir.join(format!("{rev}.bin")));
                let _ = crate::save::atomic_write(&dir.join("index.json"), &serde_json::to_vec(idx).unwrap_or_default());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn store(dir: &Path) -> (RecoveryStore, Arc<AtomicI64>) {
        let clock = Arc::new(AtomicI64::new(1_000));
        let c = clock.clone();
        (RecoveryStore::new(dir).with_clock(move || c.load(Ordering::SeqCst)), clock)
    }

    #[test]
    fn keeps_five_newest_and_skips_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let (s, clock) = store(dir.path());
        let f = Path::new("/docs/report.docx");
        for i in 0..7u8 {
            clock.fetch_add(10, Ordering::SeqCst);
            s.put(f, "docx", &[i]).unwrap();
        }
        assert_eq!(s.put(f, "docx", &[6]).unwrap().revision, 7, "same bytes, no new revision");
        let list = s.list(f);
        assert_eq!(list.iter().map(|r| r.revision).collect::<Vec<_>>(), vec![7, 6, 5, 4, 3]);
        assert_eq!(s.read(f, 3), Some(vec![2]));
        assert_eq!(s.read(f, 1), None, "pruned");
        assert!(list.windows(2).all(|w| w[0].saved_at >= w[1].saved_at));
    }

    #[test]
    fn restore_makes_a_newer_revision() {
        let dir = tempfile::tempdir().unwrap();
        let (s, clock) = store(dir.path());
        let f = Path::new("/docs/a.rtf");
        s.put(f, "rtf", b"one").unwrap();
        clock.fetch_add(5, Ordering::SeqCst);
        s.put(f, "rtf", b"two").unwrap();
        s.mark_exported(f, 2).unwrap();
        assert!(s.newest_is_exported(f));
        let (bytes, rev) = s.restore(f, 1).unwrap();
        assert_eq!((bytes.as_slice(), rev.revision), (&b"one"[..], 3));
        assert!(!s.newest_is_exported(f));
        let (_, again) = s.restore(f, 3).unwrap();
        assert_eq!(again.revision, 4, "restoring the newest still records it");
        assert_eq!(s.list(f).len(), 3);
        assert_eq!(s.restore(f, 99).unwrap_err(), RecoveryError::NotFound);
    }

    #[test]
    fn follows_moves_and_forgets_on_remove() {
        let dir = tempfile::tempdir().unwrap();
        let (s, _) = store(dir.path());
        let (a, b) = (Path::new("/d/a.odt"), Path::new("/d/b.odt"));
        s.put(a, "odt", b"x").unwrap();
        s.moved(a, b).unwrap();
        assert!(s.list(a).is_empty());
        assert_eq!(s.index(b).unwrap().path, "/d/b.odt");
        s.remove(b).unwrap();
        assert!(s.list(b).is_empty());
        assert_eq!(s.put(a, "odt", &vec![0; MAX_DOCUMENT_BYTES + 1]).unwrap_err(), RecoveryError::TooLarge);
    }
}
