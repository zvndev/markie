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
  // WAL survives an abrupt quit better and lets reads not block writes.
  db.pragma("journal_mode = WAL");
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
    CREATE TABLE IF NOT EXISTS workspace_roots (
      path TEXT PRIMARY KEY,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS md_stars (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,           -- 'folder' | 'file'
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS md_index_cache (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mtime_ms REAL NOT NULL
    );
  `);
  return db;
}

// ── Workspace roots (folders the Files view organizes) ──
function listRoots() {
  return getDB()
    .prepare("SELECT path FROM workspace_roots ORDER BY added_at ASC")
    .all()
    .map((r) => r.path);
}

function addRoot(rootPath) {
  getDB()
    .prepare(
      "INSERT INTO workspace_roots (path, added_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING"
    )
    .run(rootPath, new Date().toISOString());
}

function removeRoot(rootPath) {
  getDB().prepare("DELETE FROM workspace_roots WHERE path = ?").run(rootPath);
}

// Move/rename a tracked file's path (keeps cloud linkage). Returns silently if
// the old path wasn't tracked.
function movePath(oldPath, newPath) {
  getDB()
    .prepare("UPDATE files SET path = ? WHERE path = ?")
    .run(newPath, oldPath);
}

// Re-point any tracked file under an old directory prefix to a new prefix
// (used when a folder is renamed/moved).
function movePrefix(oldPrefix, newPrefix) {
  const rows = getDB()
    .prepare("SELECT path FROM files WHERE path LIKE ?")
    .all(`${oldPrefix}%`);
  const update = getDB().prepare("UPDATE files SET path = ? WHERE path = ?");
  const tx = getDB().transaction(() => {
    for (const { path: p } of rows) {
      update.run(newPrefix + p.slice(oldPrefix.length), p);
    }
  });
  tx();
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

// ── Browse: stars (folders + files) ──
function listStars() {
  return getDB().prepare("SELECT path, kind FROM md_stars").all();
}

// Toggle a star; returns the new state. kind is 'folder' | 'file'.
function toggleStar(p, kind) {
  const d = getDB();
  const existing = d.prepare("SELECT path FROM md_stars WHERE path = ?").get(p);
  if (existing) {
    d.prepare("DELETE FROM md_stars WHERE path = ?").run(p);
    return { starred: false };
  }
  d.prepare("INSERT INTO md_stars (path, kind, added_at) VALUES (?, ?, ?)")
    .run(p, kind, new Date().toISOString());
  return { starred: true };
}

// ── Browse: persisted index snapshot (instant first paint) ──
function saveIndexCache(rows) {
  const d = getDB();
  const wipe = d.prepare("DELETE FROM md_index_cache");
  const ins = d.prepare(
    "INSERT OR REPLACE INTO md_index_cache (path, name, mtime_ms) VALUES (?, ?, ?)"
  );
  const tx = d.transaction((items) => {
    wipe.run();
    for (const r of items) ins.run(r.path, r.name, r.mtimeMs || 0);
  });
  tx(rows);
}

function loadIndexCache() {
  return getDB()
    .prepare("SELECT path, name, mtime_ms FROM md_index_cache")
    .all()
    .map((r) => ({
      path: r.path,
      name: r.name,
      dir: path.dirname(r.path),
      mtimeMs: r.mtime_ms,
    }));
}

// Flush + close the handle deterministically on app quit (WAL checkpoint).
function close() {
  if (db) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // best effort
    }
    db.close();
    db = null;
  }
}

module.exports = {
  track,
  get,
  list,
  update,
  hashContent,
  close,
  listRoots,
  addRoot,
  removeRoot,
  movePath,
  movePrefix,
  listStars,
  toggleStar,
  saveIndexCache,
  loadIndexCache,
};
