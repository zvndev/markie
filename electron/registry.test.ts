import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Module, { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// registry.js opens a real SQLite database at `app.getPath("userData")` through
// better-sqlite3. Two things stop that from running here, and neither is worth
// weakening the module for:
//   * `require("electron")` throws outside the app;
//   * the installed better_sqlite3.node is built against Electron's ABI, so
//     plain Node refuses to load it (that is exactly the failure `available()`
//     was added to survive).
// So: poison the module loader — the same require cache registry.js uses — to
// hand back an Electron stub and a thin better-sqlite3-shaped adapter over
// Node's built-in SQLite. The SQL itself still runs for real, which is the
// whole point: LIKE-escaping and COLLATE NOCASE are SQL behaviour, not ours.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-registry-"));
// Which directory the Electron stub hands back as userData. Mutable so the
// v0-to-v1 migration case can point registry.js at a database it built by
// hand at the old schema.
let userDataDir = tmpDir;

interface Loader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
type Row = Record<string, unknown>;
interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

// node:sqlite is built in from Node 22.5. If a runner predates it, skip the
// suite rather than fail the build on an unrelated runtime detail.
let DatabaseSync: (new (p: string) => {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}) | null = null;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function makeAdapter() {
  return class Adapter {
    private db: InstanceType<NonNullable<typeof DatabaseSync>>;
    constructor(file: string) {
      this.db = new DatabaseSync!(file);
    }
    pragma(statement: string, options?: { simple?: boolean }) {
      // better-sqlite3 takes the pragma body; node:sqlite takes whole SQL.
      // `{ simple: true }` asks for the first column of the first row, which
      // is how registry.js reads `user_version`; without it the pragma is a
      // statement to run, not a question to answer.
      if (!options?.simple) {
        this.db.exec(`PRAGMA ${statement}`);
        return undefined;
      }
      const rows = this.db.prepare(`PRAGMA ${statement}`).all() as Row[];
      return rows.length ? Object.values(rows[0])[0] : undefined;
    }
    exec(sql: string) {
      this.db.exec(sql);
    }
    prepare(sql: string): Statement {
      return this.db.prepare(sql);
    }
    transaction(fn: (...args: unknown[]) => unknown) {
      return (...args: unknown[]) => {
        this.db.exec("BEGIN");
        try {
          const out = fn(...args);
          this.db.exec("COMMIT");
          return out;
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
      };
    }
    close() {
      this.db.close();
    }
  };
}

const loader = Module as unknown as Loader;
const realLoad = loader._load;
const Adapter = DatabaseSync ? makeAdapter() : null;
loader._load = function patched(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") return { app: { getPath: () => userDataDir } };
  if (request === "better-sqlite3" && Adapter) return Adapter;
  return realLoad.call(this, request, parent, isMain);
};

const registry = createRequire(import.meta.url)("./registry.js");

interface FileRow {
  path: string;
  name: string;
  sync_state: string;
  cloud_doc_id: string | null;
  share_role: string | null;
}

function wipe() {
  for (const row of registry.list() as FileRow[]) {
    registry.update(row.path, { cloud_doc_id: null });
  }
  registry.pruneMissing(() => false);
  for (const root of registry.listRoots() as string[]) registry.removeRoot(root);
  for (const star of registry.listStars() as Array<{ path: string }>) {
    registry.toggleStar(star.path, "file");
  }
}

beforeAll(() => {
  // Fails here, once, rather than in every test if the driver never loaded.
  registry.listRoots();
});

afterAll(() => {
  registry.close();
  loader._load = realLoad;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => wipe());

describe.skipIf(!DatabaseSync)("availability", () => {
  it("reports the database as usable and gives no error to show", () => {
    expect(registry.available()).toBe(true);
    expect(registry.unavailableReason()).toBe(null);
  });
});

describe("tracking files", () => {
  it("records a file and reads it back with a content hash", () => {
    registry.track("/tmp/a.md", "a.md", "hello");
    const row = registry.get("/tmp/a.md") as FileRow & { content_hash: string };
    expect(row.name).toBe("a.md");
    expect(row.sync_state).toBe("local-only");
    expect(row.content_hash).toBe(registry.hashContent("hello"));
  });

  it("updates the row instead of duplicating it when the file is reopened", () => {
    registry.track("/tmp/a.md", "a.md", "one");
    registry.track("/tmp/a.md", "a.md", "two");
    expect((registry.list() as FileRow[]).filter((r) => r.path === "/tmp/a.md")).toHaveLength(1);
  });

  it("stores the last confirmed share role so an offline session can honour it", () => {
    registry.track("/tmp/a.md", "a.md", "x");
    registry.update("/tmp/a.md", { share_role: "owner", sync_state: "synced" });
    const row = registry.get("/tmp/a.md") as FileRow;
    expect(row.share_role).toBe("owner");
    expect(row.sync_state).toBe("synced");
  });

  it("ignores fields that are not on the allowlist", () => {
    registry.track("/tmp/a.md", "a.md", "x");
    registry.update("/tmp/a.md", { path: "/tmp/hijacked.md" });
    expect(registry.get("/tmp/a.md")).toBeTruthy();
  });
});

describe("stars", () => {
  it("toggles on and back off", () => {
    expect(registry.toggleStar("/tmp/notes", "folder")).toEqual({ starred: true });
    expect(registry.listStars()).toEqual([{ path: "/tmp/notes", kind: "folder" }]);
    expect(registry.toggleStar("/tmp/notes", "folder")).toEqual({ starred: false });
    expect(registry.listStars()).toEqual([]);
  });
});

describe("movePrefix", () => {
  it("moves every tracked file under a renamed folder", () => {
    registry.track("/tmp/old/a.md", "a.md", "x");
    registry.track("/tmp/old/deep/b.md", "b.md", "x");
    registry.track("/tmp/other/c.md", "c.md", "x");

    registry.movePrefix("/tmp/old/", "/tmp/new/");

    expect(registry.get("/tmp/new/a.md")).toBeTruthy();
    expect(registry.get("/tmp/new/deep/b.md")).toBeTruthy();
    expect(registry.get("/tmp/other/c.md")).toBeTruthy();
    expect(registry.get("/tmp/old/a.md")).toBeFalsy();
  });

  it("does not treat `_` in a folder name as a LIKE wildcard", () => {
    registry.track("/tmp/my_notes/a.md", "a.md", "x");
    registry.track("/tmp/myXnotes/b.md", "b.md", "x");

    registry.movePrefix("/tmp/my_notes/", "/tmp/renamed/");

    expect(registry.get("/tmp/renamed/a.md")).toBeTruthy();
    // The bug: `my_notes` matched `myXnotes` too, silently repointing a file
    // that lives in a completely different folder.
    expect(registry.get("/tmp/myXnotes/b.md")).toBeTruthy();
    expect(registry.get("/tmp/renamed/b.md")).toBeFalsy();
  });

  it("moves only the folder whose case actually matches (LIKE folded them together)", () => {
    registry.track("/tmp/Old/a.md", "a.md", "x");
    registry.track("/tmp/old/b.md", "b.md", "x");

    registry.movePrefix("/tmp/Old/", "/tmp/New/", "darwin");

    expect(registry.get("/tmp/New/a.md")).toBeTruthy();
    // The bug: SQLite's LIKE is case-insensitive for ASCII, so renaming
    // `/tmp/Old` silently repointed every row under `/tmp/old` too.
    expect(registry.get("/tmp/old/b.md")).toBeTruthy();
    expect(registry.get("/tmp/New/b.md")).toBeFalsy();
  });

  it("does not treat `%` in a folder name as a LIKE wildcard", () => {
    registry.track("/tmp/100%/a.md", "a.md", "x");
    registry.track("/tmp/100pct/b.md", "b.md", "x");

    registry.movePrefix("/tmp/100%/", "/tmp/full/");

    expect(registry.get("/tmp/full/a.md")).toBeTruthy();
    expect(registry.get("/tmp/100pct/b.md")).toBeTruthy();
  });
});

describe("canonicalPath", () => {
  it("folds case on Windows, where two spellings are one file", () => {
    expect(registry.canonicalPath("C:\\Users\\Kirby\\A.md", "win32")).toBe(
      "c:\\users\\kirby\\a.md"
    );
  });

  it("leaves paths untouched where the filesystem is case-sensitive", () => {
    expect(registry.canonicalPath("/tmp/Old/A.md", "darwin")).toBe("/tmp/Old/A.md");
    expect(registry.canonicalPath("/tmp/Old/A.md", "linux")).toBe("/tmp/Old/A.md");
  });

  it("passes null through rather than inventing a path", () => {
    expect(registry.canonicalPath(null, "win32")).toBe(null);
  });
});

describe("saveIndexCache", () => {
  const rows = [
    { path: "/tmp/a.md", name: "a.md", mtimeMs: 1 },
    { path: "/tmp/b.md", name: "b.md", mtimeMs: 2 },
  ];

  it("round-trips the snapshot", () => {
    registry.saveIndexCache(rows);
    const loaded = registry.loadIndexCache() as Array<{ path: string; dir: string; mtimeMs: number }>;
    expect(loaded.map((r) => r.path).sort()).toEqual(["/tmp/a.md", "/tmp/b.md"]);
    expect(loaded[0].dir).toBe("/tmp");
  });

  it("skips the rewrite when nothing changed — the scan runs far more often than the tree does", () => {
    // Start from a known-different snapshot: the skip is module state that
    // survives between tests, exactly as it does between scans.
    registry.saveIndexCache([{ path: "/tmp/sentinel.md", name: "sentinel.md", mtimeMs: 0 }]);
    expect(registry.saveIndexCache(rows)).toEqual({ written: true });
    expect(registry.saveIndexCache(rows)).toEqual({ written: false });
    expect(registry.saveIndexCache(rows)).toEqual({ written: false });
  });

  it("writes again when a file's mtime or the set of files changes", () => {
    registry.saveIndexCache([{ path: "/tmp/sentinel.md", name: "sentinel.md", mtimeMs: 0 }]);
    registry.saveIndexCache(rows);
    expect(registry.saveIndexCache([{ ...rows[0], mtimeMs: 99 }, rows[1]])).toEqual({
      written: true,
    });
    expect(registry.saveIndexCache(rows.slice(0, 1))).toEqual({ written: true });
  });

  it("fingerprints on path and mtime", () => {
    expect(registry.indexCacheFingerprint(rows)).toBe(registry.indexCacheFingerprint([...rows]));
    expect(registry.indexCacheFingerprint(rows)).not.toBe(
      registry.indexCacheFingerprint([{ ...rows[0], mtimeMs: 7 }, rows[1]])
    );
    expect(registry.indexCacheFingerprint(rows)).not.toBe(
      registry.indexCacheFingerprint(rows.slice(0, 1))
    );
  });
});

describe("workspace roots", () => {
  it("adds without duplicating and removes", () => {
    registry.addRoot("/tmp/root");
    registry.addRoot("/tmp/root");
    expect(registry.listRoots()).toEqual(["/tmp/root"]);
    registry.removeRoot("/tmp/root");
    expect(registry.listRoots()).toEqual([]);
  });
});

describe("pruneMissing", () => {
  it("drops local-only rows whose file is gone but keeps cloud-linked ones", () => {
    registry.track("/tmp/gone.md", "gone.md", "x");
    registry.track("/tmp/cloud.md", "cloud.md", "x");
    registry.update("/tmp/cloud.md", { cloud_doc_id: "doc_1" });

    expect(registry.pruneMissing(() => false)).toBe(1);
    expect(registry.get("/tmp/gone.md")).toBeFalsy();
    expect(registry.get("/tmp/cloud.md")).toBeTruthy();
  });
});

// ── Schema v1: the projects tables (Spec 5.7) ──
//
// Isolation note: the shared `wipe()` above only knows the pre-v1 tables, and
// the v1 DDL deliberately ships no delete helper for blocks or meta (user
// decisions are precious by contract). So these cases clear what they can
// through the real API and otherwise key on ids unique to each test.
interface BlockRow {
  block_id: string;
  project: string;
  auto_name: string;
  custom_name: string | null;
  merged_into: string | null;
}

describe("schema v1 migration", () => {
  beforeEach(() => {
    for (const pin of registry.pinsAll() as Array<{ path: string }>) {
      registry.pinClear(pin.path);
    }
    registry.assignmentsSave("", []);
  });

  const block = (id: string, over: Partial<BlockRow> = {}) => ({
    block_id: id,
    project: "P",
    auto_name: "auto",
    custom_name: null,
    merged_into: null,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    ...over,
  });
  const findBlock = (id: string) =>
    (registry.blocksAll() as BlockRow[]).find((b) => b.block_id === id);

  it("stamps the current user_version and creates the projects tables", () => {
    expect(registry.schemaVersion()).toBe(2);

    registry.metaUpsertMany([
      {
        path: "/meta-a.md",
        mtimeMs: 5,
        birthtimeMs: 1,
        fmProject: "P",
        fmBlock: null,
        repoName: "repo",
      },
    ]);
    const meta = (registry.metaAll() as Array<{ path: string; fm_project: string | null }>).find(
      (m) => m.path === "/meta-a.md"
    );
    expect(meta?.fm_project).toBe("P");

    registry.pinSet({ path: "/a.md", project: "P2", blockId: null });
    expect(registry.pinsAll()).toHaveLength(1);
    registry.pinClear("/a.md");
    expect(registry.pinsAll()).toHaveLength(0);
  });

  it("re-extracted metadata replaces the old row rather than duplicating it", () => {
    const row = {
      path: "/meta-b.md",
      mtimeMs: 5,
      birthtimeMs: 1,
      fmProject: "Old",
      fmBlock: null,
      repoName: null,
    };
    registry.metaUpsertMany([row]);
    registry.metaUpsertMany([{ ...row, mtimeMs: 9, fmProject: "New" }]);
    const rows = (registry.metaAll() as Array<{ path: string; fm_project: string }>).filter(
      (m) => m.path === "/meta-b.md"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fm_project).toBe("New");
  });

  it("is idempotent: reopening an already-migrated database changes nothing", () => {
    registry.blockUpsert(block("reopen-1", { custom_name: "Kept" }));
    registry.close();
    expect(registry.schemaVersion()).toBe(2);
    expect(findBlock("reopen-1")?.custom_name).toBe("Kept");
  });

  it("keeps user decisions when derived tables are dropped", () => {
    registry.blockUpsert(block("b1", { custom_name: "My Block" }));
    registry.assignmentsSave("fp1", [
      { path: "/a.md", project: "P", blockId: "b1", source: "derived", mtimeMs: 5 },
    ]);
    expect(registry.assignmentsGet("fp1")).toHaveLength(1);
    // A different fingerprint invalidates the cache but not the decisions.
    expect(registry.assignmentsGet("fp2")).toEqual([]);
    expect(findBlock("b1")?.custom_name).toBe("My Block");
  });

  it("a fresh cache write never resurrects rows from the previous index", () => {
    registry.assignmentsSave("fp1", [
      { path: "/old.md", project: "P", blockId: null, source: "derived", mtimeMs: 1 },
    ]);
    registry.assignmentsSave("fp2", [
      { path: "/new.md", project: "P", blockId: null, source: "derived", mtimeMs: 2 },
    ]);
    expect(
      (registry.assignmentsGet("fp2") as Array<{ path: string }>).map((r) => r.path)
    ).toEqual(["/new.md"]);
  });

  it("an upsert of a known block never clobbers the rename on it", () => {
    registry.blockUpsert(block("rename-1"));
    registry.blockSetName("rename-1", "Release planning");
    registry.blockUpsert(block("rename-1", { auto_name: "auto-2" }));
    const row = findBlock("rename-1");
    expect(row?.custom_name).toBe("Release planning");
    expect(row?.auto_name).toBe("auto-2");
  });

  it("merge records survive and chain", () => {
    registry.blockUpsert(block("m1"));
    registry.blockUpsert(block("m2"));
    registry.blockMerge("m1", "m2");
    expect(findBlock("m1")?.merged_into).toBe("m2");
    registry.blockUpsert(block("m1", { auto_name: "auto-again" }));
    expect(findBlock("m1")?.merged_into).toBe("m2");
  });

  it("stores and replaces the known-good rules blob", () => {
    expect(registry.projectsConfigGet("rules-known-good")).toBeNull();
    registry.projectsConfigSet("rules-known-good", "first");
    registry.projectsConfigSet("rules-known-good", "second");
    expect(registry.projectsConfigGet("rules-known-good")).toBe("second");
  });
});

describe("schema v2: project names and user-made projects", () => {
  const names = () => registry.projectsAll() as Array<{
    project: string;
    custom_name: string | null;
    user_created: number;
  }>;
  const find = (key: string) => names().find((r) => r.project === key);

  it("records a rename against the derived key, not against a new project", () => {
    registry.projectSetName("markdown-viewer-zvn", "Markie");
    expect(find("markdown-viewer-zvn")?.custom_name).toBe("Markie");
    // The key is the identity. A pin written before the rename still resolves,
    // because nothing about the pin's project changed.
    registry.pinSet({ path: "/repo/a.md", project: "markdown-viewer-zvn", blockId: null });
    registry.projectSetName("markdown-viewer-zvn", "Markie app");
    expect(
      (registry.pinsAll() as Array<{ path: string; project: string }>).find(
        (r) => r.path === "/repo/a.md"
      )?.project
    ).toBe("markdown-viewer-zvn");
    expect(find("markdown-viewer-zvn")?.custom_name).toBe("Markie app");
    registry.pinClear("/repo/a.md");
  });

  it("clearing the name hands the project back to the derived one", () => {
    registry.projectSetName("clearing", "Temporary");
    registry.projectSetName("clearing", null);
    expect(find("clearing")?.custom_name).toBeNull();
    registry.projectSetName("clearing", "   ");
    expect(find("clearing")?.custom_name).toBeNull();
  });

  it("makes a project that has no files, and keeps it across reopens", () => {
    registry.projectCreate("Q4 planning");
    expect(find("Q4 planning")?.user_created).toBe(1);
    registry.close();
    expect(find("Q4 planning")?.user_created).toBe(1);
  });

  it("renaming a user-made project leaves it user-made", () => {
    registry.projectCreate("Ideas");
    registry.projectSetName("Ideas", "Someday");
    const row = find("Ideas");
    expect(row?.custom_name).toBe("Someday");
    expect(row?.user_created).toBe(1);
  });
});

// A database that already made it to 0.5.0 and holds real decisions. The v2
// migration adds a table and touches nothing else, and that has to be provable
// rather than asserted: build the v1 database by hand, with a pin, a renamed
// block and a merge in it, and open it.
describe("upgrading a populated version 1 database", () => {
  const v1Dir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-registry-v1-"));

  beforeAll(() => {
    if (!Adapter) return;
    const legacy = new Adapter(path.join(v1Dir, "registry.db"));
    legacy.exec(`
      CREATE TABLE files (
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
      CREATE TABLE workspace_roots (path TEXT PRIMARY KEY, added_at TEXT NOT NULL);
      CREATE TABLE md_stars (path TEXT PRIMARY KEY, kind TEXT NOT NULL, added_at TEXT NOT NULL);
      CREATE TABLE md_index_cache (path TEXT PRIMARY KEY, name TEXT NOT NULL, mtime_ms REAL NOT NULL);
      CREATE TABLE md_meta (
        path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, birthtime_ms REAL,
        fm_project TEXT, fm_block TEXT, repo_name TEXT, scanned_at TEXT NOT NULL
      );
      CREATE TABLE project_pins (
        path TEXT PRIMARY KEY, project TEXT NOT NULL, block_id TEXT, pinned_at TEXT NOT NULL
      );
      CREATE TABLE project_blocks (
        block_id TEXT PRIMARY KEY, project TEXT NOT NULL, auto_name TEXT NOT NULL,
        custom_name TEXT, merged_into TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_assignments (
        path TEXT PRIMARY KEY, project TEXT NOT NULL, block_id TEXT,
        source TEXT NOT NULL, mtime_ms REAL NOT NULL, fingerprint TEXT NOT NULL
      );
      CREATE TABLE projects_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO files (path, name, sync_state, cloud_doc_id, share_role)
        VALUES ('/v1/notes.md', 'notes.md', 'synced', 'doc_v1', 'editor');
      INSERT INTO project_pins (path, project, block_id, pinned_at)
        VALUES ('/v1/notes.md', 'Thesis', 'blk-1', '2026-08-26');
      INSERT INTO project_blocks (block_id, project, auto_name, custom_name, merged_into, created_at, updated_at)
        VALUES ('blk-1', 'Thesis', 'auto', 'Chapter one', NULL, '2026-08-26', '2026-08-26');
      INSERT INTO project_blocks (block_id, project, auto_name, custom_name, merged_into, created_at, updated_at)
        VALUES ('blk-2', 'Thesis', 'auto-2', NULL, 'blk-1', '2026-08-26', '2026-08-26');
      INSERT INTO projects_config (key, value, updated_at) VALUES ('rules-known-good', 'kept', '2026-08-26');
      PRAGMA user_version = 1;
    `);
    legacy.close();
  });

  afterAll(() => {
    registry.close();
    userDataDir = tmpDir;
    fs.rmSync(v1Dir, { recursive: true, force: true });
  });

  it("stamps version 2, loses no decision, and can name projects immediately", () => {
    registry.close();
    userDataDir = v1Dir;

    expect(registry.schemaVersion()).toBe(2);
    // Every user decision the v1 database held.
    const pin = (registry.pinsAll() as Array<{ path: string; project: string; block_id: string }>)[0];
    expect(pin.path).toBe("/v1/notes.md");
    expect(pin.project).toBe("Thesis");
    expect(pin.block_id).toBe("blk-1");
    const blocks = registry.blocksAll() as Array<{
      block_id: string;
      custom_name: string | null;
      merged_into: string | null;
    }>;
    expect(blocks.find((b) => b.block_id === "blk-1")?.custom_name).toBe("Chapter one");
    expect(blocks.find((b) => b.block_id === "blk-2")?.merged_into).toBe("blk-1");
    expect(registry.projectsConfigGet("rules-known-good")).toBe("kept");
    expect((registry.get("/v1/notes.md") as { cloud_doc_id: string }).cloud_doc_id).toBe("doc_v1");

    // The new table exists on the same open, and the project the pin points at
    // can be renamed without the pin noticing.
    registry.projectSetName("Thesis", "Dissertation");
    registry.projectCreate("Reading list");
    expect(
      (registry.projectsAll() as Array<{ project: string; custom_name: string | null }>)
        .find((r) => r.project === "Thesis")?.custom_name
    ).toBe("Dissertation");
    expect((registry.pinsAll() as Array<{ project: string }>)[0].project).toBe("Thesis");

    // Reopen: nothing re-runs, and nothing is lost.
    registry.close();
    expect(registry.schemaVersion()).toBe(2);
    expect(
      (registry.projectsAll() as Array<{ project: string; user_created: number }>)
        .find((r) => r.project === "Reading list")?.user_created
    ).toBe(1);
    expect((registry.pinsAll() as Array<{ block_id: string }>)[0].block_id).toBe("blk-1");
  });
});

// The migration a real user actually runs: their database exists, holds their
// files, roots, stars, and index cache, and has never heard of user_version.
// Losing anything here is a release blocker, so this builds that database by
// hand rather than trusting a fresh one to represent it.
describe("upgrading a populated version 0 database", () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-registry-v0-"));

  beforeAll(() => {
    if (!Adapter) return;
    const legacy = new Adapter(path.join(legacyDir, "registry.db"));
    // The 0.4.x schema, share_role column included but no user_version.
    legacy.exec(`
      CREATE TABLE files (
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
      CREATE TABLE workspace_roots (path TEXT PRIMARY KEY, added_at TEXT NOT NULL);
      CREATE TABLE md_stars (path TEXT PRIMARY KEY, kind TEXT NOT NULL, added_at TEXT NOT NULL);
      CREATE TABLE md_index_cache (path TEXT PRIMARY KEY, name TEXT NOT NULL, mtime_ms REAL NOT NULL);
      INSERT INTO files (path, name, sync_state, cloud_doc_id, share_role)
        VALUES ('/legacy/notes.md', 'notes.md', 'synced', 'doc_legacy', 'editor');
      INSERT INTO workspace_roots (path, added_at) VALUES ('/legacy/root', '2026-01-01');
      INSERT INTO md_stars (path, kind, added_at) VALUES ('/legacy/star.md', 'file', '2026-01-01');
      INSERT INTO md_index_cache (path, name, mtime_ms) VALUES ('/legacy/notes.md', 'notes.md', 42);
    `);
    legacy.close();
  });

  afterAll(() => {
    registry.close();
    userDataDir = tmpDir;
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  // One arc, not two cases: the shared beforeEach wipe() above is written
  // against the pre-v1 tables and would clear the legacy file row between
  // tests, which would prove nothing about the migration.
  it("stamps the current version, keeps every row the user had, and stays put on reopen", () => {
    registry.close();
    userDataDir = legacyDir;

    expect(registry.schemaVersion()).toBe(2);
    expect(registry.listRoots()).toEqual(["/legacy/root"]);
    expect(
      (registry.listStars() as Array<{ path: string }>).map((star) => star.path)
    ).toEqual(["/legacy/star.md"]);
    expect(registry.loadIndexCache()).toHaveLength(1);
    const file = registry.get("/legacy/notes.md") as {
      cloud_doc_id: string;
      share_role: string;
      sync_state: string;
    };
    expect(file.cloud_doc_id).toBe("doc_legacy");
    expect(file.share_role).toBe("editor");
    expect(file.sync_state).toBe("synced");

    // The new tables are usable on the same database, in the same open.
    registry.pinSet({ path: "/legacy/notes.md", project: "Legacy", blockId: null });
    registry.blockUpsert({
      block_id: "legacy-b1",
      project: "Legacy",
      auto_name: "auto",
      custom_name: "Named by hand",
      merged_into: null,
      created_at: "2026-08-26",
      updated_at: "2026-08-26",
    });

    // Reopen: nothing re-runs, and no decision is lost.
    registry.close();
    expect(registry.schemaVersion()).toBe(2);
    expect((registry.pinsAll() as Array<{ project: string }>)[0].project).toBe("Legacy");
    expect(
      (registry.blocksAll() as Array<{ custom_name: string }>)[0].custom_name
    ).toBe("Named by hand");
    expect(registry.get("/legacy/notes.md")).toBeTruthy();
    expect(registry.listRoots()).toEqual(["/legacy/root"]);
  });
});
