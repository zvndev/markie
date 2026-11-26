//! One record per imported file, kept in Markie's registry database in a table
//! of its own (`rs_google_docs`), created on first use.
//!
//! This is the ground two-way sync builds on: the Doc ID, the `revisionId`
//! and Drive `version` last synced, and the Markdown last synced, which is
//! the merge base for a three-way diff later. Nothing here writes to Google.
use crate::error::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    pub doc_id: String,
    pub title: String,
    /// `revisionId` from the last `documents.get`. Opaque; Google honours it for 24 hours.
    #[serde(default)]
    pub revision_id: Option<String>,
    /// Drive's `version` at the last sync, as a decimal string.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    /// RFC 3339, local clock.
    pub synced_at: String,
    /// The Markdown written at the last sync: the merge base for two-way sync.
    pub base_markdown: String,
    #[serde(default)]
    pub tabs: usize,
    /// The last "Save as Word" copy beside the file.
    #[serde(default)]
    pub docx_path: Option<PathBuf>,
    /// The last refresh's problem, shown in Settings until a refresh works.
    #[serde(default)]
    pub error: Option<String>,
    /// Two-way sync: Markie's edits go back to Google. Off means Refresh only.
    #[serde(default)]
    pub two_way: bool,
    /// Markie's edits go to Google as suggestions (`writeMode: SUGGEST`).
    #[serde(default)]
    pub suggest: bool,
    /// Whether `suggest` was set by the person rather than by default.
    #[serde(default)]
    pub suggest_chosen: bool,
    /// What this account may do with the Doc, from Drive's `capabilities`.
    #[serde(default)]
    pub access: Option<Access>,
    /// Local edits that stay here, each reason once in plain words
    /// ("tables"), with the hash of the file they were found in.
    #[serde(default)]
    pub held: Vec<String>,
    #[serde(default)]
    pub held_hash: Option<String>,
    /// The last conflict's copy of Markie's version, until it is compared or dismissed.
    #[serde(default)]
    pub conflict: Option<PathBuf>,
    /// Sync stopped for good: the Doc was trashed or unshared, or the file
    /// was deleted here. The row says why; the file is kept.
    #[serde(default)]
    pub stopped: Option<Stopped>,
    /// When Markie last sent edits.
    #[serde(default)]
    pub pushed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub owned: bool,
    pub can_edit: bool,
    pub can_comment: bool,
}

impl Access {
    /// Markie can send edits at all: as edits, or as suggestions.
    pub fn writable(&self, suggest: bool) -> bool {
        self.can_edit || (suggest && self.can_comment)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stopped {
    Trashed,
    NoAccess,
    /// The file was deleted on this Mac.
    FileDeleted,
}

impl SyncRecord {
    /// Whether the file on disk still says what the last sync wrote.
    pub fn matches_base(&self, local: &str) -> bool {
        normalize(local) == normalize(&self.base_markdown)
    }
}

/// Line endings and a trailing newline never count as an edit.
fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n").trim_end().to_string()
}

pub fn ensure_table(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS rs_google_docs (
           path TEXT PRIMARY KEY,
           doc_id TEXT NOT NULL,
           record TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS rs_google_docs_doc ON rs_google_docs (doc_id);",
    )?;
    Ok(())
}

fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn decode(json: String) -> Option<SyncRecord> {
    serde_json::from_str(&json).ok()
}

pub fn get(db: &Connection, path: &Path) -> Result<Option<SyncRecord>> {
    ensure_table(db)?;
    let json: Option<String> = db.query_row("SELECT record FROM rs_google_docs WHERE path = ?1", [key(path)], |r| r.get(0)).optional()?;
    Ok(json.and_then(decode))
}

/// The file a Doc was imported to, if any.
pub fn by_doc(db: &Connection, doc_id: &str) -> Result<Option<(PathBuf, SyncRecord)>> {
    ensure_table(db)?;
    let row: Option<(String, String)> =
        db.query_row("SELECT path, record FROM rs_google_docs WHERE doc_id = ?1 ORDER BY path LIMIT 1", [doc_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    Ok(row.and_then(|(p, j)| decode(j).map(|r| (PathBuf::from(p), r))))
}

pub fn all(db: &Connection) -> Result<Vec<(PathBuf, SyncRecord)>> {
    ensure_table(db)?;
    let mut stmt = db.prepare("SELECT path, record FROM rs_google_docs ORDER BY path")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.filter_map(|r| r.ok()).filter_map(|(p, j)| decode(j).map(|rec| (PathBuf::from(p), rec))).collect())
}

pub fn put(db: &Connection, path: &Path, record: &SyncRecord) -> Result<()> {
    ensure_table(db)?;
    let json = serde_json::to_string(record).map_err(|e| crate::GoogleError::Store(e.to_string()))?;
    db.execute(
        "INSERT INTO rs_google_docs (path, doc_id, record) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET doc_id = excluded.doc_id, record = excluded.record",
        params![key(path), record.doc_id, json],
    )?;
    Ok(())
}

pub fn remove(db: &Connection, path: &Path) -> Result<()> {
    ensure_table(db)?;
    db.execute("DELETE FROM rs_google_docs WHERE path = ?1", [key(path)])?;
    Ok(())
}

/// A synced file was renamed or moved in Markie: its record follows.
pub fn move_path(db: &Connection, from: &Path, to: &Path) -> Result<()> {
    ensure_table(db)?;
    db.execute("UPDATE rs_google_docs SET path = ?2 WHERE path = ?1", [key(from), key(to)])?;
    Ok(())
}

/// A folder holding synced files was renamed or moved: every record under it follows.
pub fn move_folder(db: &Connection, from: &Path, to: &Path) -> Result<()> {
    ensure_table(db)?;
    let sep = std::path::MAIN_SEPARATOR;
    let (from, to) = (format!("{}{sep}", from.display()), format!("{}{sep}", to.display()));
    let rows: Vec<String> = {
        let mut stmt = db.prepare("SELECT path FROM rs_google_docs WHERE substr(path, 1, length(?1)) = ?1")?;
        let rows = stmt.query_map([&from], |r| r.get(0))?.filter_map(|r| r.ok()).collect();
        rows
    };
    for old in rows {
        let new = format!("{to}{}", &old[from.len()..]);
        db.execute("UPDATE rs_google_docs SET path = ?2 WHERE path = ?1", [&old, &new])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_by_path_and_by_doc() {
        let db = Connection::open_in_memory().unwrap();
        let rec = SyncRecord { doc_id: "doc1".into(), title: "Plan".into(), version: Some("7".into()), base_markdown: "# Plan\n".into(), synced_at: "2026-11-25T10:00:00Z".into(), ..Default::default() };
        put(&db, Path::new("/g/Plan.md"), &rec).unwrap();
        assert_eq!(get(&db, Path::new("/g/Plan.md")).unwrap(), Some(rec.clone()));
        assert_eq!(by_doc(&db, "doc1").unwrap().unwrap().0, PathBuf::from("/g/Plan.md"));
        move_path(&db, Path::new("/g/Plan.md"), Path::new("/g/Plan 2.md")).unwrap();
        assert_eq!(all(&db).unwrap().len(), 1);
        assert!(get(&db, Path::new("/g/Plan.md")).unwrap().is_none());
        move_folder(&db, Path::new("/g"), Path::new("/h/sub")).unwrap();
        assert_eq!(all(&db).unwrap()[0].0, PathBuf::from("/h/sub/Plan 2.md"));
        remove(&db, Path::new("/h/sub/Plan 2.md")).unwrap();
        assert!(all(&db).unwrap().is_empty());
    }

    #[test]
    fn records_from_step_one_read_as_refresh_only() {
        let old = r#"{"docId":"d","title":"T","syncedAt":"2026-11-25T10:00:00Z","baseMarkdown":"x"}"#;
        let rec: SyncRecord = serde_json::from_str(old).unwrap();
        assert!(!rec.two_way && !rec.suggest && rec.stopped.is_none() && rec.held.is_empty());
    }

    #[test]
    fn a_trailing_newline_or_crlf_is_not_an_edit() {
        let rec = SyncRecord { base_markdown: "a\nb\n".into(), ..Default::default() };
        assert!(rec.matches_base("a\r\nb"));
        assert!(!rec.matches_base("a\nb c\n"));
    }
}
