// Local file registry — tracks every file Markie opens, plus its sync state.
// Lives in the main process; files themselves never move.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let db = null;
let driverError = null;

// better-sqlite3 is a native module. A packaged build whose prebuild did not
// match the platform (the Windows install path is rebuilt at pack time) used to
// take the whole main process down at the first Library render with an opaque
// "Cannot find module" — every caller of this file assumed the require worked.
// Load it through here instead, so callers can ask whether the registry is
// usable and show that rather than crashing.
function loadDriver() {
  try {
    return require("better-sqlite3");
  } catch (err) {
    driverError = new Error(
      `Markie's local database could not be loaded (${err && err.message ? err.message : err}). ` +
        "Reinstalling Markie usually fixes this."
    );
    return null;
  }
}

// True when the local registry can actually be opened. Callers that can degrade
// (the Library, the index cache) should check this instead of throwing.
function available() {
  try {
    getDB();
    return true;
  } catch {
    return false;
  }
}

// The reason available() is false, as a user-facing sentence, or null.
function unavailableReason() {
  return driverError ? driverError.message : null;
}

// SQLite's `=` is case-sensitive but Windows paths are not: the same file
// reached as C:\Users\… and c:\users\… must be one row, not two.
//
// A `COLLATE NOCASE` clause used to do this at query time. It was worse in two
// ways: it dropped the primary-key index (every lookup became a table scan),
// and it was only ever attached to *some* of the queries, so the same file
// could still be inserted twice and then be found by only one of them. Doing
// it at the boundary instead means one canonical spelling per file goes into
// the table, and every query is an indexed equality again.
function canonicalPath(p, platform = process.platform) {
  if (p == null) return p;
  return platform === "win32" ? String(p).toLowerCase() : p;
}

function getDB() {
  if (db) return db;
  // Both of these are required lazily, and for the same reason: requiring
  // "electron" from plain Node throws unless the binary has been downloaded,
  // and CI installs with --ignore-scripts. Anything that pulls this module in
  // for its pure functions would fail at import time. Nothing here touches the
  // database until a caller actually asks for it.
  const { app } = require("electron");
  const Database = loadDriver();
  if (!Database) throw driverError;
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
    CREATE TABLE IF NOT EXISTS skill_sources (
      id TEXT PRIMARY KEY,          -- "owner/repo"
      added_at TEXT
    );
    CREATE TABLE IF NOT EXISTS skill_installs (
      path TEXT PRIMARY KEY,        -- the folder Markie wrote
      target TEXT NOT NULL,         -- "claude" … or "project:<root>"
      name TEXT NOT NULL,
      source TEXT,                  -- "owner/repo" it came from
      skill_path TEXT,              -- where it sits inside that repository
      folder_hash TEXT,             -- git tree id of the folder it copied
      root TEXT,                    -- the folder it was allowed to write under
      installed_at TEXT NOT NULL
    );
  `);

  // A skill installed into a project outside the home folder was only ever
  // Markie's to update or remove while that project stayed a workspace root:
  // unregister it and the recorded folder was outside every folder Markie
  // may write to. The row now remembers the root the install was made under.
  // Added after the table shipped, so older databases need the column too;
  // their rows have no root, and the current roots are all they can rely on.
  const installCols = db.prepare("PRAGMA table_info(skill_installs)").all();
  if (!installCols.some((c) => c.name === "root")) {
    db.exec("ALTER TABLE skill_installs ADD COLUMN root TEXT");
  }

  // Markie is local-first, so being offline is an ordinary state, not an error.
  // Without a remembered role, an unreachable server means we cannot prove the
  // right to edit, and failing closed would lock every synced document the user
  // owns behind a "view only" banner the moment their wifi drops. Remembering
  // the last role the server confirmed lets us keep honouring it while offline
  // and fail closed only for a document whose role we have never learned.
  // Added after the initial schema, so existing databases need the column too.
  const fileCols = db.prepare("PRAGMA table_info(files)").all();
  if (!fileCols.some((c) => c.name === "share_role")) {
    db.exec("ALTER TABLE files ADD COLUMN share_role TEXT");
  }

  // Who the remembered role was granted to. A role is evidence about one
  // account and no other: without this, signing into a second account on the
  // same machine let the first account's "owner" answer speak for it. Existing
  // rows get a null principal, which counts as nobody having said, so a role
  // learned before this column existed can no longer claim ownership on its
  // own. The next time the server confirms it, it is written back with a name.
  if (!fileCols.some((c) => c.name === "share_role_user")) {
    db.exec("ALTER TABLE files ADD COLUMN share_role_user TEXT");
  }

  // Media that travels with the document. "synced" when the server holds
  // every reference at the fingerprint; "pending" when a push is owed and the
  // reconciliation pass will make it. assets_skipped is a JSON list of refs
  // that did not travel and why, for the Cloud page to show.
  for (const col of ["assets_state", "assets_fingerprint", "assets_skipped"]) {
    if (!fileCols.some((c) => c.name === col)) db.exec(`ALTER TABLE files ADD COLUMN ${col} TEXT`);
  }

  // Schema versioning starts at 0.5.0. Version 0 is every database that
  // predates it; the PRAGMA-guarded share_role ALTER above predates versioning
  // and stays as-is so any skipped-version database still heals.
  const version = db.pragma("user_version", { simple: true });
  if (version < 1) {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS md_meta (
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
      `);
      db.pragma("user_version = 1");
    });
    migrate();
  }

  // v2 adds the one thing 0.5.0 could not express: a project the user named,
  // or made. A project used to exist only as whatever the engine derived, so
  // there was nowhere to record "I call this one Markie" and no way at all to
  // have a project before it has files. Both are user decisions and belong
  // beside pins and block renames, not in the disposable cache.
  if (version < 2) {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          project      TEXT PRIMARY KEY,
          custom_name  TEXT,
          user_created INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
      `);
      db.pragma("user_version = 2");
    });
    migrate();
  }

  return db;
}

function schemaVersion() {
  return getDB().pragma("user_version", { simple: true });
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
// Every table keyed by path follows a file when it moves. Leaving the pin, the
// star, or the extracted metadata behind at the old path is how a renamed file
// used to change project on its own, and how the Library kept calling it by
// its old name until it was opened again.
// `skill_installs` is keyed by a path too and is deliberately absent: that
// path is a skill folder Markie created, not a document the user might move,
// and a rename of some unrelated file must never drag it anywhere.
const PATH_KEYED_TABLES = [
  "files",
  "md_stars",
  "md_meta",
  "project_pins",
  "project_assignments",
];

// The derived tables are rebuildable and may be missing on a database whose
// migration has not run; a move must not fail on their account.
function pathKeyedTables(d) {
  const present = new Set(
    d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
  );
  return PATH_KEYED_TABLES.filter((t) => present.has(t));
}

function movePath(oldPath, newPath) {
  const d = getDB();
  const from = canonicalPath(oldPath);
  const to = canonicalPath(newPath);
  const tx = d.transaction(() => {
    // The name column is what the Library shows; a rename is the one move
    // where it changes. OR REPLACE lets a stale row at the destination lose.
    d.prepare("UPDATE OR REPLACE files SET path = ?, name = ? WHERE path = ?").run(
      to,
      path.basename(newPath),
      from
    );
    for (const table of pathKeyedTables(d)) {
      if (table === "files") continue;
      d.prepare(`UPDATE OR REPLACE ${table} SET path = ? WHERE path = ?`).run(to, from);
    }
  });
  tx();
}

// Re-point any tracked file under an old directory prefix to a new prefix
// (used when a folder is renamed/moved).
//
// LIKE is the wrong operator here twice over: it treats `_` and `%` as
// wildcards (so `my_notes` also matched `myXnotes`), and SQLite's LIKE is
// case-insensitive for ASCII by default, so renaming `/tmp/Old` also dragged
// `/tmp/old` along with it. `substr(path, 1, n) = ?` is a plain BINARY compare
// of exactly the prefix — no wildcards to escape, no folding — and only on
// Windows, where the filesystem itself folds case, do we fold too.
function movePrefix(oldPrefix, newPrefix, platform = process.platform) {
  const oldP = canonicalPath(oldPrefix, platform);
  const newP = canonicalPath(newPrefix, platform);
  const clause =
    platform === "win32"
      ? "lower(substr(path, 1, ?)) = lower(?)"
      : "substr(path, 1, ?) = ?";
  const d = getDB();
  const tx = d.transaction(() => {
    for (const table of pathKeyedTables(d)) {
      const rows = d.prepare(`SELECT path FROM ${table} WHERE ${clause}`).all(oldP.length, oldP);
      const update = d.prepare(`UPDATE OR REPLACE ${table} SET path = ? WHERE path = ?`);
      for (const { path: p } of rows) {
        update.run(newP + p.slice(oldP.length), p);
      }
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
    .run(
      canonicalPath(filePath),
      name,
      content != null ? hashContent(content) : null,
      new Date().toISOString()
    );
}

function get(filePath) {
  return getDB().prepare("SELECT * FROM files WHERE path = ?").get(canonicalPath(filePath));
}

// Drop local-only rows whose file no longer exists on disk. Agent worktrees
// and other scratch locations create files that get opened here and then
// deleted; without this the Library fills with permanent "Missing on disk"
// rows. Cloud-linked rows are kept — they still carry the cloud copy.
// Returns the number of rows removed.
function pruneMissing(fileExists = fs.existsSync) {
  const rows = getDB()
    .prepare("SELECT path FROM files WHERE cloud_doc_id IS NULL")
    .all();
  const gone = rows.map((r) => r.path).filter((p) => !fileExists(p));
  if (gone.length) {
    const del = getDB().prepare("DELETE FROM files WHERE path = ?");
    const tx = getDB().transaction((paths) => {
      for (const p of paths) del.run(p);
    });
    tx(gone);
  }
  return gone.length;
}

// Drop one row by path. pruneMissing lets go only of rows the cloud never
// heard of; a cloud-linked row whose file is gone stays, on purpose, so the
// Cloud page can offer the copy back. Once a pull has brought the document
// back at some other path, that row is a second file on one cloud document,
// and this is how the pull lets go of it.
function forget(filePath) {
  getDB().prepare("DELETE FROM files WHERE path = ?").run(canonicalPath(filePath));
}

function list() {
  return getDB()
    .prepare("SELECT * FROM files ORDER BY last_opened_at DESC")
    .all();
}

// The cloud-linked rows whose file sits directly inside `dir`, most recently
// opened first. Used to answer "does a cloud document live in this folder"
// for a library that can hold 200,000 rows, where a full table scan through
// list() on every picture request is not something to do per request.
//
// `path` is the primary key, so a half-open range on it is an index scan
// rather than a table scan; ? and ? + "\u{10FFFF}" (U+10FFFF, the highest
// Unicode code point there is) bound "the prefix, plus anything". SQLite
// compares TEXT as raw UTF-8 bytes, and U+10FFFF's encoding (F4 8F BF BF) is
// the largest a real character's bytes can start with; U+FFFF (EF BF BF)
// was tried first and is not: any astral character - an emoji among them -
// encodes with a leading byte of F0 or above, which sorts past it, so a
// filename starting with one was never found. That range alone would also
// match a sibling folder whose name happens to start with this one
// ("/tmp/report" matching "/tmp/report-extra"), so the dirname check after it
// is what actually decides.
//
// The order matters to the caller, which takes the first row as the answer:
// several documents can share a folder, and the one most recently opened is
// the one that answer should be about.
function cloudDocsInDir(dir) {
  const resolved = path.resolve(dir);
  const canonicalDir = canonicalPath(resolved);
  const prefix = canonicalDir.endsWith(path.sep) ? canonicalDir : canonicalDir + path.sep;
  const rows = getDB()
    .prepare(
      "SELECT * FROM files WHERE cloud_doc_id IS NOT NULL AND path >= ? AND path < ? ORDER BY last_opened_at DESC"
    )
    .all(prefix, prefix + "\u{10FFFF}");
  return rows.filter((r) => canonicalPath(path.dirname(r.path)) === canonicalDir);
}

function update(filePath, fields) {
  const allowed = [
    "name",
    "content_hash",
    "cloud_doc_id",
    "cloud_version",
    "sync_state",
    "last_synced_at",
    // Last role the server confirmed for this doc, so an offline session can
    // keep honouring it instead of locking the owner out of their own file,
    // and the account it confirmed it for.
    "share_role",
    "share_role_user",
    "assets_state",
    "assets_fingerprint",
    "assets_skipped",
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
  values.push(canonicalPath(filePath));
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
  const key = canonicalPath(p);
  const existing = d.prepare("SELECT path FROM md_stars WHERE path = ?").get(key);
  if (existing) {
    d.prepare("DELETE FROM md_stars WHERE path = ?").run(key);
    return { starred: false };
  }
  d.prepare("INSERT INTO md_stars (path, kind, added_at) VALUES (?, ?, ?)")
    .run(key, kind, new Date().toISOString());
  return { starred: true };
}

// ── Browse: persisted index snapshot (instant first paint) ──
// The snapshot the index writes back after every scan. Rewriting 20-50k rows
// (DELETE + re-INSERT, synchronously, on the main process) stalled the UI for
// hundreds of milliseconds — and the scan that triggers it usually finds
// nothing new. Hash what would be written and skip the write when it matches
// what is already stored. Returns whether the table was actually rewritten.
let indexCacheHash = null;

function indexCacheFingerprint(rows) {
  const h = crypto.createHash("sha256");
  for (const r of rows) h.update(`${r.path}|${r.mtimeMs || 0}\n`);
  h.update(`#${rows.length}`);
  return h.digest("hex");
}

function saveIndexCache(rows) {
  const items = Array.isArray(rows) ? rows : [];
  const fingerprint = indexCacheFingerprint(items);
  if (fingerprint === indexCacheHash) return { written: false };
  const d = getDB();
  const wipe = d.prepare("DELETE FROM md_index_cache");
  const ins = d.prepare(
    "INSERT OR REPLACE INTO md_index_cache (path, name, mtime_ms) VALUES (?, ?, ?)"
  );
  const tx = d.transaction((list) => {
    wipe.run();
    for (const r of list) ins.run(r.path, r.name, r.mtimeMs || 0);
  });
  tx(items);
  indexCacheHash = fingerprint;
  return { written: true };
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

// ── Projects: per-file metadata extracted from the index ──
// Derived and rebuildable. Dropping this table costs one slow rescan, never a
// user decision.
function metaUpsertMany(rows) {
  const d = getDB();
  const up = d.prepare(
    `INSERT INTO md_meta (path, mtime_ms, birthtime_ms, fm_project, fm_block, repo_name, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       birthtime_ms = excluded.birthtime_ms,
       fm_project = excluded.fm_project,
       fm_block = excluded.fm_block,
       repo_name = excluded.repo_name,
       scanned_at = excluded.scanned_at`
  );
  const now = new Date().toISOString();
  const tx = d.transaction((list) => {
    for (const r of list) {
      up.run(
        canonicalPath(r.path),
        r.mtimeMs || 0,
        r.birthtimeMs ?? null,
        r.fmProject ?? null,
        r.fmBlock ?? null,
        r.repoName ?? null,
        now
      );
    }
  });
  tx(rows);
}

function metaAll() {
  return getDB().prepare("SELECT * FROM md_meta").all();
}

// ── Projects: user decisions (precious) ──
// A pin is the top of the assignment ladder: the user said where this file
// belongs, and nothing derived may argue with it.
function pinsAll() {
  return getDB().prepare("SELECT * FROM project_pins").all();
}

function pinSet({ path: p, project, blockId }) {
  getDB()
    .prepare(
      `INSERT INTO project_pins (path, project, block_id, pinned_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         project = excluded.project,
         block_id = excluded.block_id,
         pinned_at = excluded.pinned_at`
    )
    .run(canonicalPath(p), project, blockId ?? null, new Date().toISOString());
}

function pinClear(p) {
  getDB().prepare("DELETE FROM project_pins WHERE path = ?").run(canonicalPath(p));
}

function blocksAll() {
  return getDB().prepare("SELECT * FROM project_blocks").all();
}

// Re-derivation upserts every block it still sees, so this deliberately does
// NOT overwrite custom_name or merged_into: those are the user's, and the
// engine has no opinion worth more than theirs.
function blockUpsert(row) {
  getDB()
    .prepare(
      `INSERT INTO project_blocks (block_id, project, auto_name, custom_name, merged_into, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(block_id) DO UPDATE SET
         project = excluded.project,
         auto_name = excluded.auto_name,
         updated_at = excluded.updated_at`
    )
    .run(
      row.block_id,
      row.project,
      row.auto_name,
      row.custom_name ?? null,
      row.merged_into ?? null,
      row.created_at,
      row.updated_at
    );
}

function blockSetName(blockId, customName) {
  getDB()
    .prepare("UPDATE project_blocks SET custom_name = ?, updated_at = ? WHERE block_id = ?")
    .run(customName ?? null, new Date().toISOString(), blockId);
}

function blockMerge(blockId, intoBlockId) {
  getDB()
    .prepare("UPDATE project_blocks SET merged_into = ?, updated_at = ? WHERE block_id = ?")
    .run(intoBlockId, new Date().toISOString(), blockId);
}

// ── Projects: project identity (precious) ──
// The derived key stays the project's identity forever; only the display name
// changes. Renaming therefore cannot orphan a pin, a block, or an assignment,
// and it cannot touch a single byte on disk.
function projectsAll() {
  return getDB().prepare("SELECT * FROM projects").all();
}

function projectSetName(project, customName) {
  const now = new Date().toISOString();
  const name = customName == null || String(customName).trim() === "" ? null : String(customName).trim();
  getDB()
    .prepare(
      `INSERT INTO projects (project, custom_name, user_created, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(project) DO UPDATE SET
         custom_name = excluded.custom_name,
         updated_at = excluded.updated_at`
    )
    .run(String(project), name, now, now);
}

// A project with nothing in it yet. Re-derivation cannot produce one of these
// (there are no files to derive it from), so the row is the only thing keeping
// it alive until files are pinned into it.
function projectCreate(project) {
  const now = new Date().toISOString();
  const info = getDB()
    .prepare(
      `INSERT INTO projects (project, custom_name, user_created, created_at, updated_at)
       VALUES (?, NULL, 1, ?, ?)
       ON CONFLICT(project) DO UPDATE SET
         user_created = 1,
         updated_at = excluded.updated_at`
    )
    .run(String(project), now, now);
  return { project: String(project), changes: info.changes };
}

// ── Projects: derived assignment cache (disposable) ──
// Keyed by the index fingerprint: rows written against a different index are
// stale by definition, so a mismatch reads as "no cache" rather than as data.
function assignmentsGet(fingerprint) {
  return getDB()
    .prepare("SELECT * FROM project_assignments WHERE fingerprint = ?")
    .all(fingerprint);
}

function assignmentsSave(fingerprint, rows) {
  const d = getDB();
  const wipe = d.prepare("DELETE FROM project_assignments");
  const ins = d.prepare(
    `INSERT OR REPLACE INTO project_assignments (path, project, block_id, source, mtime_ms, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = d.transaction((list) => {
    wipe.run();
    for (const r of list) {
      ins.run(
        canonicalPath(r.path),
        r.project,
        r.blockId ?? null,
        r.source,
        r.mtimeMs || 0,
        fingerprint
      );
    }
  });
  tx(Array.isArray(rows) ? rows : []);
}

function projectsConfigGet(key) {
  const row = getDB().prepare("SELECT value FROM projects_config WHERE key = ?").get(key);
  return row ? row.value : null;
}

function projectsConfigSet(key, value) {
  getDB()
    .prepare(
      `INSERT INTO projects_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, String(value), new Date().toISOString());
}

// ── Skills: sources the user added, and folders Markie installed ──
// The install row is what makes an install reversible: without it, a folder in
// ~/.claude/skills is indistinguishable from one the user put there by hand,
// and Markie will not delete or replace something it cannot prove it wrote.
function skillSourcesAll() {
  return getDB().prepare("SELECT id, added_at FROM skill_sources ORDER BY added_at ASC").all();
}

function skillSourceAdd(id) {
  getDB()
    .prepare(
      "INSERT INTO skill_sources (id, added_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING"
    )
    .run(String(id), new Date().toISOString());
}

function skillSourceRemove(id) {
  getDB().prepare("DELETE FROM skill_sources WHERE id = ?").run(String(id));
}

function skillInstallsAll() {
  return getDB().prepare("SELECT * FROM skill_installs ORDER BY installed_at DESC").all();
}

function skillInstallGet(p) {
  return getDB().prepare("SELECT * FROM skill_installs WHERE path = ?").get(canonicalPath(p));
}

function skillInstallSet(row) {
  getDB()
    .prepare(
      `INSERT INTO skill_installs (path, target, name, source, skill_path, folder_hash, root, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         target = excluded.target,
         name = excluded.name,
         source = excluded.source,
         skill_path = excluded.skill_path,
         folder_hash = excluded.folder_hash,
         root = excluded.root,
         installed_at = excluded.installed_at`
    )
    .run(
      canonicalPath(row.path),
      String(row.target),
      String(row.name),
      row.source ?? null,
      row.skill_path ?? null,
      row.folder_hash ?? null,
      row.root ?? null,
      row.installed_at || new Date().toISOString()
    );
}

function skillInstallDelete(p) {
  getDB().prepare("DELETE FROM skill_installs WHERE path = ?").run(canonicalPath(p));
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
    indexCacheHash = null;
  }
}

module.exports = {
  available,
  unavailableReason,
  canonicalPath,
  indexCacheFingerprint,
  track,
  get,
  list,
  cloudDocsInDir,
  forget,
  pruneMissing,
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
  schemaVersion,
  metaUpsertMany,
  metaAll,
  pinsAll,
  pinSet,
  pinClear,
  blocksAll,
  blockUpsert,
  projectsAll,
  projectSetName,
  projectCreate,
  blockSetName,
  blockMerge,
  assignmentsGet,
  assignmentsSave,
  projectsConfigGet,
  projectsConfigSet,
  skillSourcesAll,
  skillSourceAdd,
  skillSourceRemove,
  skillInstallsAll,
  skillInstallGet,
  skillInstallSet,
  skillInstallDelete,
};
