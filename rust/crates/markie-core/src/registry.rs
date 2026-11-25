//! The local registry: recently opened files, workspace roots, stars, and a
//! cached copy of the device index for instant first paint.
//!
//! The tables match `electron/registry.js` column for column, so a later import
//! from the Electron app's `registry.db` is a straight copy. This build keeps
//! its own database under [`crate::paths::data_dir`] and never opens that one.

use std::path::{Path, PathBuf};

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

use crate::index::IndexSnapshot;

pub struct Registry {
    db: Connection,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RecentFile {
    pub path: PathBuf,
    pub name: String,
    pub last_opened_at: String,
}

fn now_iso() -> String {
    // RFC 3339 in UTC without pulling in a date crate.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs()) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Windows paths are case-insensitive: one canonical spelling per file.
fn key(path: &Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(windows) { s.to_lowercase() } else { s.into_owned() }
}

impl Registry {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let db = Connection::open(path)?;
        Self::init(db)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(db: Connection) -> Result<Self> {
        db.pragma_update(None, "journal_mode", "WAL")?;
        // The Library snapshot is saved from a background connection; the
        // window's own writes wait for it instead of failing.
        db.busy_timeout(std::time::Duration::from_secs(3))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
               path TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               content_hash TEXT,
               cloud_doc_id TEXT,
               cloud_version INTEGER DEFAULT 0,
               sync_state TEXT NOT NULL DEFAULT 'local-only',
               last_opened_at TEXT,
               last_synced_at TEXT,
               share_role TEXT
             );
             CREATE TABLE IF NOT EXISTS workspace_roots (
               path TEXT PRIMARY KEY,
               added_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS md_stars (
               path TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               added_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS rs_index_snapshot (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS rs_settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS rs_cloud_sync (
               path TEXT PRIMARY KEY,
               record TEXT NOT NULL
             );",
        )?;
        // registry.js's v1 (md_meta, project_*) and v2 (projects) tables,
        // created idempotently, and the PRAGMA they are guarded by.
        crate::projects::store::ensure_tables(&db)?;
        // v3: Markie's own folders (`projects::folders`).
        crate::projects::folders::ensure_tables(&db)?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version < 3 {
            db.pragma_update(None, "user_version", 3)?;
        }
        Ok(Self { db })
    }

    /// The underlying connection, for modules that keep their own tables here
    /// (Projects). They create their tables idempotently on first use.
    pub fn conn(&self) -> &Connection {
        &self.db
    }

    /// `trashFile` for a file that is already gone: the row leaves the
    /// Library, with its star.
    pub fn forget(&self, path: &Path) -> Result<()> {
        self.db.execute("DELETE FROM files WHERE path = ?1", params![key(path)])?;
        self.db.execute("DELETE FROM md_stars WHERE path = ?1", params![key(path)])?;
        Ok(())
    }

    /// Make Private: every row that names `path`, in every path-keyed table
    /// (Recents, stars, Projects pins and assignments, metadata, the cloud
    /// record), and its entry in the Library snapshot. Workspace roots are
    /// folders and stay. Secure delete zeroes the freed pages, and the WAL is
    /// checkpointed and truncated, so the old rows do not linger in the file.
    pub fn purge_path(&self, path: &Path) -> Result<()> {
        self.db.pragma_update(None, "secure_delete", "ON")?;
        let tx = self.db.unchecked_transaction()?;
        for table in self.path_keyed_tables()? {
            if table != "workspace_roots" {
                tx.execute(&format!("DELETE FROM \"{table}\" WHERE path = ?1"), params![key(path)])?;
            }
        }
        tx.commit()?;
        if let Some(mut snapshot) = self.load_snapshot()? {
            snapshot.files.retain(|f| f.path != path);
            self.save_snapshot(&snapshot)?;
        }
        self.db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    pub fn track_opened(&self, path: &Path) -> Result<()> {
        let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        self.db.execute(
            "INSERT INTO files (path, name, last_opened_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at",
            params![key(path), name, now_iso()],
        )?;
        Ok(())
    }

    /// Record an open with a known time, keeping whichever is newer.
    pub fn track_opened_at(&self, path: &Path, at: &str) -> Result<()> {
        let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        self.db.execute(
            "INSERT INTO files (path, name, last_opened_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET last_opened_at = max(coalesce(last_opened_at, ''), excluded.last_opened_at)",
            params![key(path), name, at],
        )?;
        Ok(())
    }

    /// When the file was last opened (or landed) on this device, if ever.
    pub fn last_opened(&self, path: &Path) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT last_opened_at FROM files WHERE path = ?1", params![key(path)], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    }

    /// Star without toggling. Returns true when the star is new.
    pub fn set_star(&self, path: &Path, kind: &str) -> Result<bool> {
        let added = self.db.execute(
            "INSERT OR IGNORE INTO md_stars (path, kind, added_at) VALUES (?1, ?2, ?3)",
            params![key(path), kind, now_iso()],
        )?;
        Ok(added > 0)
    }

    pub fn is_starred(&self, path: &Path) -> Result<bool> {
        Ok(self
            .db
            .query_row("SELECT 1 FROM md_stars WHERE path = ?1", [key(path)], |_| Ok(()))
            .optional()?
            .is_some())
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<RecentFile>> {
        let mut stmt = self.db.prepare(
            "SELECT path, name, last_opened_at FROM files
             WHERE last_opened_at IS NOT NULL ORDER BY last_opened_at DESC, rowid DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit as i64], |r| {
                Ok(RecentFile {
                    path: PathBuf::from(r.get::<_, String>(0)?),
                    name: r.get(1)?,
                    last_opened_at: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn roots(&self) -> Result<Vec<PathBuf>> {
        let mut stmt = self.db.prepare("SELECT path FROM workspace_roots ORDER BY added_at")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0).map(PathBuf::from))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn add_root(&self, path: &Path) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO workspace_roots (path, added_at) VALUES (?1, ?2)",
            params![key(path), now_iso()],
        )?;
        Ok(())
    }

    pub fn remove_root(&self, path: &Path) -> Result<()> {
        self.db.execute("DELETE FROM workspace_roots WHERE path = ?1", [key(path)])?;
        Ok(())
    }

    /// Every table with a `path` column: they all follow a moved file.
    fn path_keyed_tables(&self) -> Result<Vec<String>> {
        let mut stmt = self.db.prepare(
            "SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p
             WHERE m.type = 'table' AND p.name = 'path'",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// `registry.movePath`: a stale row at the destination loses.
    pub fn move_path(&self, from: &Path, to: &Path) -> Result<()> {
        let name = to.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let tx = self.db.unchecked_transaction()?;
        tx.execute("UPDATE OR REPLACE files SET path = ?1, name = ?2 WHERE path = ?3", params![key(to), name, key(from)])?;
        for table in self.path_keyed_tables()? {
            if table != "files" {
                tx.execute(&format!("UPDATE OR REPLACE \"{table}\" SET path = ?1 WHERE path = ?2"), params![key(to), key(from)])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// `registry.movePrefix`: everything under a moved folder.
    pub fn move_prefix(&self, from: &str, to: &str) -> Result<()> {
        let (from, to) = if cfg!(windows) { (from.to_lowercase(), to.to_lowercase()) } else { (from.to_string(), to.to_string()) };
        let tx = self.db.unchecked_transaction()?;
        for table in self.path_keyed_tables()? {
            let paths: Vec<String> = {
                let mut stmt = tx.prepare(&format!("SELECT path FROM \"{table}\" WHERE substr(path, 1, ?1) = ?2"))?;
                stmt.query_map(params![from.len() as i64, from], |r| r.get(0))?.collect::<Result<_, _>>()?
            };
            for p in paths {
                let next = format!("{to}{}", &p[from.len()..]);
                tx.execute(&format!("UPDATE OR REPLACE \"{table}\" SET path = ?1 WHERE path = ?2"), params![next, p])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn toggle_star(&self, path: &Path, kind: &str) -> Result<bool> {
        let k = key(path);
        let removed = self.db.execute("DELETE FROM md_stars WHERE path = ?1", [&k])?;
        if removed > 0 {
            return Ok(false);
        }
        self.db.execute(
            "INSERT INTO md_stars (path, kind, added_at) VALUES (?1, ?2, ?3)",
            params![k, kind, now_iso()],
        )?;
        Ok(true)
    }

    pub fn stars(&self) -> Result<Vec<PathBuf>> {
        let mut stmt = self.db.prepare("SELECT path FROM md_stars ORDER BY added_at")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0).map(PathBuf::from))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Persist the index for instant first paint. Body snippets are left out:
    /// they are what makes a snapshot large, and the rescan that follows every
    /// launch brings them back within seconds.
    pub fn save_snapshot(&self, snapshot: &IndexSnapshot) -> Result<()> {
        let mut slim = snapshot.clone();
        for file in &mut slim.files {
            file.snippet = None;
        }
        self.db.execute(
            "INSERT INTO rs_index_snapshot (id, json) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json",
            [serde_json::to_string(&slim)?],
        )?;
        Ok(())
    }

    pub fn load_snapshot(&self) -> Result<Option<IndexSnapshot>> {
        let json: Option<String> = self
            .db
            .query_row("SELECT json FROM rs_index_snapshot WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
    }

    pub fn setting(&self, name: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT value FROM rs_settings WHERE key = ?1", [name], |r| r.get(0))
            .optional()?)
    }

    pub fn set_setting(&self, name: &str, value: &str) -> Result<()> {
        self.db.execute(
            "INSERT INTO rs_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [name, value],
        )?;
        Ok(())
    }

    /// Cloud records live beside the local registry, with no networking dependency.
    pub fn cloud_record<T: serde::de::DeserializeOwned>(&self, path: &Path) -> Result<Option<T>> {
        let record: Option<String> = self.db
            .query_row("SELECT record FROM rs_cloud_sync WHERE path = ?1", [key(path)], |r| r.get(0))
            .optional()?;
        record.map(|json| serde_json::from_str(&json).map_err(Into::into)).transpose()
    }

    pub fn cloud_records<T: serde::de::DeserializeOwned>(&self) -> Result<Vec<(PathBuf, T)>> {
        let mut stmt = self.db.prepare("SELECT path, record FROM rs_cloud_sync ORDER BY path")?;
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .map(|row| {
                let (path, json) = row?;
                Ok((PathBuf::from(path), serde_json::from_str(&json)?))
            })
            .collect()
    }

    pub fn set_cloud_record(&self, path: &Path, record: &impl serde::Serialize) -> Result<()> {
        self.db.execute(
            "INSERT INTO rs_cloud_sync (path, record) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET record = excluded.record",
            params![key(path), serde_json::to_string(record)?],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purge_path_removes_every_row_but_roots() {
        let reg = Registry::in_memory().unwrap();
        let doc = Path::new("/fixture/secret plan.md");
        reg.track_opened(doc).unwrap();
        reg.track_opened(Path::new("/fixture/other.md")).unwrap();
        reg.set_star(doc, "star").unwrap();
        reg.add_root(Path::new("/fixture")).unwrap();
        crate::projects::store::pin_set(reg.conn(), &key(doc), "Plans", None).unwrap();
        reg.set_cloud_record(doc, &serde_json::json!({"cloudDocId": "fixture"})).unwrap();
        reg.purge_path(doc).unwrap();
        assert_eq!(reg.recent(10).unwrap().len(), 1);
        assert!(!reg.is_starred(doc).unwrap());
        assert!(crate::projects::store::pins_all(reg.conn()).unwrap().is_empty());
        assert!(reg.cloud_record::<serde_json::Value>(doc).unwrap().is_none());
        assert_eq!(reg.roots().unwrap(), vec![PathBuf::from("/fixture")]);
    }

    #[test]
    fn recents_roots_stars_settings() {
        let reg = Registry::in_memory().unwrap();
        reg.track_opened(Path::new("/a/one.md")).unwrap();
        reg.track_opened(Path::new("/a/two.md")).unwrap();
        reg.track_opened(Path::new("/a/one.md")).unwrap();
        let recent = reg.recent(10).unwrap();
        assert_eq!(recent.len(), 2);
        reg.add_root(Path::new("/a")).unwrap();
        reg.add_root(Path::new("/a")).unwrap();
        assert_eq!(reg.roots().unwrap(), vec![PathBuf::from("/a")]);
        assert!(reg.toggle_star(Path::new("/a/one.md"), "file").unwrap());
        assert!(!reg.toggle_star(Path::new("/a/one.md"), "file").unwrap());
        reg.set_setting("theme", "dark").unwrap();
        assert_eq!(reg.setting("theme").unwrap().as_deref(), Some("dark"));
        let snap = IndexSnapshot::default();
        reg.save_snapshot(&snap).unwrap();
        assert!(reg.load_snapshot().unwrap().is_some());
        reg.track_opened_at(Path::new("/a/three.md"), "2026-11-23T08:00:00Z").unwrap();
        assert_eq!(reg.last_opened(Path::new("/a/three.md")).unwrap().as_deref(), Some("2026-11-23T08:00:00Z"));
        assert_eq!(reg.last_opened(Path::new("/a/never.md")).unwrap(), None);
    }

    #[test]
    fn user_version_is_three_with_the_project_and_folder_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.db");
        for _ in 0..2 {
            let reg = Registry::open(&path).unwrap();
            let v: i64 = reg.conn().pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
            assert_eq!(v, 3);
            for table in ["md_meta", "project_pins", "project_blocks", "project_assignments", "projects_config", "projects", "folders", "folder_items", "folder_released"] {
                let n: i64 = reg.conn().query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1", [table], |r| r.get(0)).unwrap();
                assert_eq!(n, 1, "{table}");
            }
        }
    }

    #[test]
    fn forgetting_a_missing_file_drops_its_row() {
        let reg = Registry::in_memory().unwrap();
        let gone = Path::new("/nowhere/gone.md");
        reg.track_opened(gone).unwrap();
        reg.toggle_star(gone, "file").unwrap();
        reg.forget(gone).unwrap();
        assert!(reg.recent(10).unwrap().is_empty());
        assert!(!reg.is_starred(gone).unwrap());
    }

    #[test]
    fn iso_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_413), (2025, 11, 21));
        assert!(now_iso().ends_with('Z'));
    }

    #[test]
    fn cloud_records_survive_reopen_and_keep_recents() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("registry.db");
        let path = dir.path().join("sample.md");
        let record = serde_json::json!({
            "user": "scratch-principal",
            "record": {"cloud_doc_id": "sample", "cloud_version": 3, "state": "conflict"}
        });
        {
            let reg = Registry::open(&db).unwrap();
            reg.track_opened(&path).unwrap();
            reg.set_cloud_record(&path, &record).unwrap();
        }
        let reg = Registry::open(&db).unwrap();
        assert_eq!(reg.cloud_record::<serde_json::Value>(&path).unwrap(), Some(record.clone()));
        assert_eq!(reg.recent(1).unwrap()[0].path, path);
        assert_eq!(reg.cloud_records::<serde_json::Value>().unwrap(), vec![(path, record)]);
    }
}
