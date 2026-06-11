// Local file registry — tracks every file Markie opens, plus its sync state.
// Lives in the main process; files themselves never move.
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

let db = null;

function getDB() {
  if (db) return db;
  const Database = require("better-sqlite3");
  db = new Database(path.join(app.getPath("userData"), "registry.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content_hash TEXT,
      cloud_doc_id TEXT,
      cloud_version INTEGER DEFAULT 0,
      sync_state TEXT NOT NULL DEFAULT 'local-only',
      last_opened_at TEXT,
      last_synced_at TEXT
    );
  `);
  return db;
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function track(filePath, name, content) {
  getDB()
    .prepare(
      `INSERT INTO files (path, name, content_hash, last_opened_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         name = excluded.name,
         content_hash = excluded.content_hash,
         last_opened_at = excluded.last_opened_at`
    )
    .run(filePath, name, content != null ? hashContent(content) : null, new Date().toISOString());
}

function get(filePath) {
  return getDB().prepare("SELECT * FROM files WHERE path = ?").get(filePath);
}

function list() {
  return getDB()
    .prepare("SELECT * FROM files ORDER BY last_opened_at DESC")
    .all();
}

function update(filePath, fields) {
  const allowed = [
    "name",
    "content_hash",
    "cloud_doc_id",
    "cloud_version",
    "sync_state",
    "last_synced_at",
  ];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return;
  values.push(filePath);
  getDB()
    .prepare(`UPDATE files SET ${sets.join(", ")} WHERE path = ?`)
    .run(...values);
}

module.exports = { track, get, list, update, hashContent };
