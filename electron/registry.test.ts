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
    pragma(statement: string) {
      // better-sqlite3 takes the pragma body; node:sqlite takes whole SQL.
      this.db.exec(`PRAGMA ${statement}`);
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
  if (request === "electron") return { app: { getPath: () => tmpDir } };
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
