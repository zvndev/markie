//! A read-only import from the Electron app's registry: recently opened
//! files, workspace folders and stars.
//!
//! The Electron database is never opened in place. It may be live (WAL mode,
//! another process writing), so the database and its WAL are copied to a
//! temporary folder and the copy is read. Nothing is ever written back.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use rusqlite::{Connection, OpenFlags};

use crate::registry::Registry;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportSummary {
    pub recents: usize,
    pub roots: usize,
    pub stars: usize,
}

/// Where the shipping Electron app keeps its registry on this platform.
pub fn electron_registry_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("Markie").join("registry.db"))
}

pub fn import_from_electron(source: &Path, into: &Registry) -> Result<ImportSummary> {
    // A folder of this call's own: two imports at once must never read each
    // other's copy.
    static CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let call = CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!("markie-rs-import-{}-{call}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let copy = tmp.join("registry.db");
    std::fs::copy(source, &copy).context("copying the Markie registry")?;
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", source.display()));
        if side.exists() {
            let _ = std::fs::copy(&side, tmp.join(format!("registry.db{suffix}")));
        }
    }
    let result = (|| {
        let db = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let mut summary = ImportSummary::default();
        {
            let mut stmt = db.prepare(
                "SELECT path, last_opened_at FROM files WHERE last_opened_at IS NOT NULL ORDER BY last_opened_at",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows.flatten() {
                if Path::new(&row.0).exists() {
                    into.track_opened_at(Path::new(&row.0), &row.1)?;
                    summary.recents += 1;
                }
            }
        }
        {
            let mut stmt = db.prepare("SELECT path FROM workspace_roots ORDER BY added_at")?;
            for path in stmt.query_map([], |r| r.get::<_, String>(0))?.flatten() {
                if Path::new(&path).is_dir() {
                    into.add_root(Path::new(&path))?;
                    summary.roots += 1;
                }
            }
        }
        {
            let mut stmt = db.prepare("SELECT path, kind FROM md_stars ORDER BY added_at")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for (path, kind) in rows.flatten() {
                if Path::new(&path).exists() && into.set_star(Path::new(&path), &kind)? {
                    summary.stars += 1;
                }
            }
        }
        Ok(summary)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_recents_roots_and_stars_without_touching_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        std::fs::write(&note, "x").unwrap();
        let src = dir.path().join("registry.db");
        {
            let db = Connection::open(&src).unwrap();
            db.execute_batch(&format!(
                "CREATE TABLE files (path TEXT PRIMARY KEY, name TEXT, last_opened_at TEXT);
                 CREATE TABLE workspace_roots (path TEXT PRIMARY KEY, added_at TEXT);
                 CREATE TABLE md_stars (path TEXT PRIMARY KEY, kind TEXT, added_at TEXT);
                 INSERT INTO files VALUES ('{n}', 'note.md', '2026-11-20T10:00:00.000Z');
                 INSERT INTO files VALUES ('/gone/old.md', 'old.md', '2026-01-01T00:00:00.000Z');
                 INSERT INTO workspace_roots VALUES ('{d}', '2026-11-01T00:00:00.000Z');
                 INSERT INTO md_stars VALUES ('{n}', 'file', '2026-11-02T00:00:00.000Z');",
                n = note.display(),
                d = dir.path().display()
            ))
            .unwrap();
        }
        let before = std::fs::read(&src).unwrap();
        let reg = Registry::in_memory().unwrap();
        let summary = import_from_electron(&src, &reg).unwrap();
        assert_eq!(summary, ImportSummary { recents: 1, roots: 1, stars: 1 });
        assert_eq!(reg.recent(10).unwrap()[0].last_opened_at, "2026-11-20T10:00:00.000Z");
        assert_eq!(std::fs::read(&src).unwrap(), before, "the source is never written");
    }
}
