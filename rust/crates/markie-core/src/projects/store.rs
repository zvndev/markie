//! The Projects tables, column for column the same as `electron/registry.js`
//! (schema v1 and v2): `md_meta`, `project_pins`, `project_blocks`,
//! `project_assignments`, `projects_config` and `projects`. They live in
//! Markie RS's own registry database, never in Electron's.
//!
//! Decisions (pins, block names and merges, project names) are precious. The
//! metadata and the assignment cache are derived and rebuildable.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::assign::Pin;
#[cfg(test)]
use super::assign::AssignmentSource;
use super::cluster::{BlockRecord, PriorAssignment};
use super::taxonomy::{AssignmentRow, ProjectNameRecord};

pub fn ensure_tables(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS md_meta (
           path         TEXT PRIMARY KEY,
           mtime_ms     REAL NOT NULL,
           birthtime_ms REAL,
           fm_project   TEXT,
           fm_block     TEXT,
           repo_name    TEXT,
           scanned_at   TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS project_pins (
           path       TEXT PRIMARY KEY,
           project    TEXT NOT NULL,
           block_id   TEXT,
           pinned_at  TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS project_blocks (
           block_id    TEXT PRIMARY KEY,
           project     TEXT NOT NULL,
           auto_name   TEXT NOT NULL,
           custom_name TEXT,
           merged_into TEXT,
           created_at  TEXT NOT NULL,
           updated_at  TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS project_assignments (
           path        TEXT PRIMARY KEY,
           project     TEXT NOT NULL,
           block_id    TEXT,
           source      TEXT NOT NULL,
           mtime_ms    REAL NOT NULL,
           fingerprint TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS projects_config (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS projects (
           project      TEXT PRIMARY KEY,
           custom_name  TEXT,
           user_created INTEGER NOT NULL DEFAULT 0,
           created_at   TEXT NOT NULL,
           updated_at   TEXT NOT NULL
         );",
    )?;
    Ok(())
}

fn now() -> String {
    super::iso_from_ms(super::now_ms())
}

/// Windows paths are case-insensitive: one spelling per file.
fn canonical(p: &str) -> String {
    if cfg!(windows) { p.to_lowercase() } else { p.to_string() }
}

/// `indexCacheFingerprint`: sha256 over `path|mtime` lines and the row count.
pub fn index_fingerprint<'a>(rows: impl IntoIterator<Item = (&'a str, f64)>) -> String {
    let mut h = Sha256::new();
    let mut n = 0usize;
    for (path, mtime) in rows {
        h.update(format!("{path}|{}\n", js_num(mtime)));
        n += 1;
    }
    h.update(format!("#{n}"));
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn js_num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e21 { format!("{}", x as i64) } else { format!("{x}") }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MetaRow {
    pub path: String,
    pub mtime_ms: f64,
    pub birthtime_ms: Option<f64>,
    pub fm_project: Option<String>,
    pub fm_block: Option<String>,
    pub repo_name: Option<String>,
}

pub fn meta_all(db: &Connection) -> Result<HashMap<String, MetaRow>> {
    let mut stmt =
        db.prepare("SELECT path, mtime_ms, birthtime_ms, fm_project, fm_block, repo_name FROM md_meta")?;
    let rows = stmt.query_map([], |r| {
        Ok(MetaRow {
            path: r.get(0)?,
            mtime_ms: r.get(1)?,
            birthtime_ms: r.get(2)?,
            fm_project: r.get(3)?,
            fm_block: r.get(4)?,
            repo_name: r.get(5)?,
        })
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let row = row?;
        out.insert(row.path.clone(), row);
    }
    Ok(out)
}

pub fn meta_upsert_many(db: &Connection, rows: &[MetaRow]) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    {
        let mut up = tx.prepare(
            "INSERT INTO md_meta (path, mtime_ms, birthtime_ms, fm_project, fm_block, repo_name, scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(path) DO UPDATE SET
               mtime_ms = excluded.mtime_ms, birthtime_ms = excluded.birthtime_ms,
               fm_project = excluded.fm_project, fm_block = excluded.fm_block,
               repo_name = excluded.repo_name, scanned_at = excluded.scanned_at",
        )?;
        let at = now();
        for r in rows {
            up.execute(params![canonical(&r.path), r.mtime_ms, r.birthtime_ms, r.fm_project, r.fm_block, r.repo_name, at])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn pins_all(db: &Connection) -> Result<Vec<Pin>> {
    let mut stmt = db.prepare("SELECT path, project, block_id FROM project_pins")?;
    let rows = stmt
        .query_map([], |r| Ok(Pin { path: r.get(0)?, project: r.get(1)?, block_id: r.get(2)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn pin_set(db: &Connection, path: &str, project: &str, block_id: Option<&str>) -> Result<()> {
    db.execute(
        "INSERT INTO project_pins (path, project, block_id, pinned_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET project = excluded.project, block_id = excluded.block_id,
           pinned_at = excluded.pinned_at",
        params![canonical(path), project, block_id, now()],
    )?;
    Ok(())
}

pub fn pin_clear(db: &Connection, path: &str) -> Result<()> {
    db.execute("DELETE FROM project_pins WHERE path = ?1", [canonical(path)])?;
    Ok(())
}

pub fn blocks_all(db: &Connection) -> Result<Vec<BlockRecord>> {
    let mut stmt = db.prepare(
        "SELECT block_id, project, auto_name, custom_name, merged_into, created_at, updated_at FROM project_blocks",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(BlockRecord {
                block_id: r.get(0)?,
                project: r.get(1)?,
                auto_name: r.get(2)?,
                custom_name: r.get(3)?,
                merged_into: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Never overwrites `custom_name` or `merged_into`: those are the user's.
pub fn block_upsert_many(db: &Connection, rows: &[BlockRecord]) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    {
        let mut up = tx.prepare(
            "INSERT INTO project_blocks (block_id, project, auto_name, custom_name, merged_into, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(block_id) DO UPDATE SET project = excluded.project,
               auto_name = excluded.auto_name, updated_at = excluded.updated_at",
        )?;
        for b in rows {
            up.execute(params![b.block_id, b.project, b.auto_name, b.custom_name, b.merged_into, b.created_at, b.updated_at])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn block_set_name(db: &Connection, block_id: &str, custom_name: Option<&str>) -> Result<()> {
    db.execute(
        "UPDATE project_blocks SET custom_name = ?1, updated_at = ?2 WHERE block_id = ?3",
        params![custom_name, now(), block_id],
    )?;
    Ok(())
}

pub fn block_merge(db: &Connection, block_id: &str, into: &str) -> Result<()> {
    db.execute(
        "UPDATE project_blocks SET merged_into = ?1, updated_at = ?2 WHERE block_id = ?3",
        params![into, now(), block_id],
    )?;
    Ok(())
}

pub fn projects_all(db: &Connection) -> Result<Vec<ProjectNameRecord>> {
    let mut stmt = db.prepare("SELECT project, custom_name, user_created, created_at, updated_at FROM projects")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProjectNameRecord {
                project: r.get(0)?,
                custom_name: r.get(1)?,
                user_created: r.get::<_, i64>(2)? != 0,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A blank name clears the rename.
pub fn project_set_name(db: &Connection, project: &str, custom_name: Option<&str>) -> Result<()> {
    let name = custom_name.map(str::trim).filter(|s| !s.is_empty());
    let at = now();
    db.execute(
        "INSERT INTO projects (project, custom_name, user_created, created_at, updated_at) VALUES (?1, ?2, 0, ?3, ?3)
         ON CONFLICT(project) DO UPDATE SET custom_name = excluded.custom_name, updated_at = excluded.updated_at",
        params![project, name, at],
    )?;
    Ok(())
}

/// `projects-create`: the trimmed name, or an error for a blank one.
pub fn project_create(db: &Connection, name: &str) -> Result<String, String> {
    let project = name.trim();
    if project.is_empty() {
        return Err("A project needs a name.".into());
    }
    let at = now();
    db.execute(
        "INSERT INTO projects (project, custom_name, user_created, created_at, updated_at) VALUES (?1, NULL, 1, ?2, ?2)
         ON CONFLICT(project) DO UPDATE SET user_created = 1, updated_at = excluded.updated_at",
        params![project, at],
    )
    .map_err(|e| e.to_string())?;
    Ok(project.to_string())
}

/// Rows written against a different index are stale: a mismatch reads as none.
pub fn assignments_get(db: &Connection, fingerprint: &str) -> Result<Vec<PriorAssignment>> {
    let mut stmt = db.prepare("SELECT path, block_id, mtime_ms FROM project_assignments WHERE fingerprint = ?1")?;
    let rows = stmt
        .query_map([fingerprint], |r| Ok(PriorAssignment { path: r.get(0)?, block_id: r.get(1)?, mtime_ms: r.get(2)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn assignments_save(db: &Connection, fingerprint: &str, rows: &[AssignmentRow]) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    tx.execute("DELETE FROM project_assignments", [])?;
    {
        let mut ins = tx.prepare(
            "INSERT OR REPLACE INTO project_assignments (path, project, block_id, source, mtime_ms, fingerprint)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for r in rows {
            ins.execute(params![canonical(&r.path), r.project, r.block_id, r.source.as_str(), r.mtime_ms, fingerprint])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn config_get(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db.query_row("SELECT value FROM projects_config WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn config_set(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute(
        "INSERT INTO projects_config (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions_round_trip_and_survive_upserts() {
        let db = Connection::open_in_memory().unwrap();
        ensure_tables(&db).unwrap();
        ensure_tables(&db).unwrap();
        pin_set(&db, "/a.md", "P", Some("b_1")).unwrap();
        pin_set(&db, "/a.md", "Q", None).unwrap();
        assert_eq!(pins_all(&db).unwrap(), vec![Pin { path: "/a.md".into(), project: "Q".into(), block_id: None }]);
        pin_clear(&db, "/a.md").unwrap();
        assert!(pins_all(&db).unwrap().is_empty());

        let b = BlockRecord {
            block_id: "b_1".into(),
            project: "P".into(),
            auto_name: "docs".into(),
            custom_name: None,
            merged_into: None,
            created_at: "x".into(),
            updated_at: "y".into(),
        };
        block_upsert_many(&db, std::slice::from_ref(&b)).unwrap();
        block_set_name(&db, "b_1", Some("Mine")).unwrap();
        block_merge(&db, "b_1", "b_2").unwrap();
        block_upsert_many(&db, &[BlockRecord { auto_name: "renamed".into(), ..b }]).unwrap();
        let got = &blocks_all(&db).unwrap()[0];
        assert_eq!(got.auto_name, "renamed");
        assert_eq!(got.custom_name.as_deref(), Some("Mine"));
        assert_eq!(got.merged_into.as_deref(), Some("b_2"));

        project_set_name(&db, "app", Some("  Markie ")).unwrap();
        assert_eq!(project_create(&db, "  New "), Ok("New".into()));
        assert!(project_create(&db, "   ").is_err());
        project_set_name(&db, "app", Some("")).unwrap();
        let mut names = projects_all(&db).unwrap();
        names.sort_by(|a, b| a.project.cmp(&b.project));
        assert_eq!(names[0].project, "New");
        assert!(names[0].user_created);
        assert_eq!(names[1].custom_name, None, "a blank rename clears it");

        let rows = vec![AssignmentRow {
            path: "/a.md".into(),
            project: "P".into(),
            block_id: Some("b_1".into()),
            source: AssignmentSource::Derived,
            mtime_ms: 5.5,
        }];
        assignments_save(&db, "fp1", &rows).unwrap();
        assert_eq!(assignments_get(&db, "fp1").unwrap().len(), 1);
        assert!(assignments_get(&db, "fp2").unwrap().is_empty());
        config_set(&db, "rules-known-good", "doc").unwrap();
        assert_eq!(config_get(&db, "rules-known-good").unwrap().as_deref(), Some("doc"));
        meta_upsert_many(
            &db,
            &[MetaRow { path: "/a.md".into(), mtime_ms: 1.0, birthtime_ms: None, fm_project: Some("X".into()), fm_block: None, repo_name: None }],
        )
        .unwrap();
        assert_eq!(meta_all(&db).unwrap()["/a.md"].fm_project.as_deref(), Some("X"));
    }

    #[test]
    fn fingerprint_matches_electron() {
        // Computed with registry.indexCacheFingerprint in node.
        assert_eq!(
            index_fingerprint([("/a.md", 1700000000123.0), ("/b.md", 1.5)]),
            "ada0faa32f0cd3291d142260d960a987e6eb65214981dfcbdce0afc94f105fe9"
        );
    }
}
