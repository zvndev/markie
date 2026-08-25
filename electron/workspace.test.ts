import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Module, { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// workspace.js confines every operation to the registered workspace roots, and
// those live in the SQLite registry. Same loader trick as registry.test.ts: an
// Electron stub (so `app.getPath` and `shell` resolve) plus a thin adapter over
// Node's built-in SQLite, because the installed better-sqlite3 binary is built
// for Electron's ABI and will not load in plain Node.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-workspace-"));
const userData = path.join(tmpDir, "userData");
const documents = path.join(tmpDir, "Documents");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(documents, { recursive: true });

const trashed: string[] = [];
const revealed: string[] = [];

interface Loader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
type Row = Record<string, unknown>;
interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

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

const Adapter = DatabaseSync
  ? class {
      private db: InstanceType<NonNullable<typeof DatabaseSync>>;
      constructor(file: string) {
        this.db = new DatabaseSync!(file);
      }
      pragma(statement: string) {
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
    }
  : null;

const electronStub = {
  app: {
    getPath: (name: string) => (name === "documents" ? documents : userData),
  },
  shell: {
    trashItem: async (target: string) => {
      trashed.push(target);
      fs.rmSync(target, { recursive: true, force: true });
    },
    showItemInFolder: (target: string) => revealed.push(target),
  },
};

const loader = Module as unknown as Loader;
const realLoad = loader._load;
loader._load = function patched(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") return electronStub;
  if (request === "better-sqlite3" && Adapter) return Adapter;
  return realLoad.call(this, request, parent, isMain);
};

const load = createRequire(import.meta.url);
const registry = load("./registry.js");
const workspace = load("./workspace.js");

// A real folder on disk, registered as the one workspace root.
let root: string;

beforeAll(() => {
  registry.listRoots();
});

afterAll(() => {
  registry.close();
  loader._load = realLoad;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const existing of registry.listRoots() as string[]) registry.removeRoot(existing);
  root = fs.mkdtempSync(path.join(tmpDir, "root-"));
  registry.addRoot(root);
  trashed.length = 0;
  revealed.length = 0;
});

describe("sanitizeName", () => {
  it("always refuses path separators, control characters, and dot entries", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(workspace.sanitizeName("a/b", platform)).toBe("ab");
      expect(workspace.sanitizeName("..", platform)).toBe(null);
      expect(workspace.sanitizeName(".", platform)).toBe(null);
      expect(workspace.sanitizeName("   ", platform)).toBe(null);
      expect(workspace.sanitizeName("a\u0000b.md", platform)).toBe("ab.md");
    }
  });

  it("strips the characters Windows refuses in a file name", () => {
    expect(workspace.sanitizeName('re:port*?"<>|.md', "win32")).toBe("report.md");
  });

  it("strips trailing dots and spaces, which Windows silently drops anyway", () => {
    expect(workspace.sanitizeName("notes...", "win32")).toBe("notes");
    expect(workspace.sanitizeName("notes .", "win32")).toBe("notes");
  });

  it("refuses the reserved device names, with or without an extension", () => {
    for (const n of ["CON", "con.md", "PRN", "aux.txt", "NUL", "COM1", "lpt9.md"]) {
      expect(workspace.sanitizeName(n, "win32")).toBe(null);
    }
    // Only reserved on Windows — a Mac user may legitimately have notes/con.md.
    expect(workspace.sanitizeName("con.md", "darwin")).toBe("con.md");
  });
});

describe("withinRoots", () => {
  it("accepts the root itself and anything under it, and refuses a sibling", () => {
    expect(workspace.withinRoots(root)).toBe(true);
    expect(workspace.withinRoots(path.join(root, "notes", "a.md"))).toBe(true);
    expect(workspace.withinRoots(path.join(tmpDir, "elsewhere.md"))).toBe(false);
  });

  it("refuses an escape through `..` even when the prefix looks right", () => {
    expect(workspace.withinRoots(path.join(root, "..", "outside.md"))).toBe(false);
  });

  it("is case-sensitive off Windows", () => {
    expect(
      workspace.withinRoots("/Users/me/Notes/a.md", {
        platform: "darwin",
        rootList: ["/users/me/notes"],
      })
    ).toBe(false);
  });

  it("is case-insensitive on Windows, where those are the same folder", () => {
    // Shaped with POSIX separators so `path.resolve` behaves the same when the
    // test runs on a Mac; the rule under test is the case folding, not the
    // separator, which `path` already gets right on the real platform.
    expect(
      workspace.withinRoots("/Users/me/Notes/a.md", {
        platform: "win32",
        rootList: ["/users/ME/notes"],
      })
    ).toBe(true);
  });

  it("does not treat a same-prefixed sibling as inside the root", () => {
    expect(
      workspace.withinRoots("/Users/me/Notes-old/a.md", {
        platform: "darwin",
        rootList: ["/Users/me/Notes"],
      })
    ).toBe(false);
  });
});

describe("default root", () => {
  it("uses the OS Documents folder on Windows rather than a hard-coded ~/Documents", () => {
    // OneDrive Known Folder Move moves Documents out of the profile on Windows,
    // and a localised install never calls it "Documents" at all.
    expect(workspace.documentsDir("win32")).toBe(documents);
  });

  it("stays on the home-relative Documents folder elsewhere so a HOME override is honoured", () => {
    // The Electron e2e scripts run against a temporary HOME; getPath("documents")
    // ignores that and would write test files into the real ~/Documents.
    expect(workspace.documentsDir("darwin")).toBe(path.join(os.homedir(), "Documents"));
    expect(workspace.defaultRootPath()).toBe(path.join(workspace.documentsDir(), "Markie"));
  });

  it("creates and registers the default root", () => {
    const created = workspace.createDefaultRoot();
    expect(fs.existsSync(created)).toBe(true);
    expect(registry.listRoots()).toContain(created);
  });
});

describe("folder operations", () => {
  it("lists folders and openable files, hiding dotfiles and unsupported types", () => {
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "a.md"), "");
    fs.writeFileSync(path.join(root, "b.csv"), "");
    fs.writeFileSync(path.join(root, "c.png"), "");
    fs.writeFileSync(path.join(root, ".hidden.md"), "");

    const out = workspace.listDir(root);
    expect(out.folders.map((f: { name: string }) => f.name)).toEqual(["sub"]);
    expect(out.files.map((f: { name: string }) => f.name)).toEqual(["a.md", "b.csv"]);
    expect(out.files[0].ext).toBe("md");
  });

  it("refuses to read outside the workspace", () => {
    expect(() => workspace.listDir(tmpDir)).toThrow(/Outside the workspace/);
    expect(() => workspace.listDir(path.join(root, "..", ".."))).toThrow(/Outside the workspace/);
  });

  it("creates a folder and reports a name it cannot use", () => {
    expect(workspace.mkdir(root, "Notes")).toEqual({
      ok: true,
      path: path.join(root, "Notes"),
    });
    expect(workspace.mkdir(root, "Notes").error).toMatch(/exists/);
    expect(workspace.mkdir(root, "..").error).toBe("Invalid name");
    expect(workspace.mkdir(root, "CON", { platform: "win32" }).error).toBe("Invalid name");
  });

  it("creates a file, defaulting the extension to .md", () => {
    expect(workspace.newFile(root, "today").path).toBe(path.join(root, "today.md"));
    expect(fs.readFileSync(path.join(root, "today.md"), "utf-8")).toBe("");
    expect(workspace.newFile(root, "today").error).toMatch(/exists/);
  });

  it("does not let a new file escape its parent folder", () => {
    const created = workspace.newFile(root, "../escape.md");
    expect(created.path).toBe(path.join(root, "..escape.md"));
    expect(fs.existsSync(path.join(tmpDir, "escape.md"))).toBe(false);
  });

  it("moves a file and re-points its registry row", () => {
    const src = path.join(root, "a.md");
    fs.writeFileSync(src, "x");
    fs.mkdirSync(path.join(root, "dest"));
    registry.track(src, "a.md", "x");

    const out = workspace.move(src, path.join(root, "dest"));
    expect(out.path).toBe(path.join(root, "dest", "a.md"));
    expect(fs.existsSync(out.path)).toBe(true);
    expect(registry.get(out.path)).toBeTruthy();
    expect(registry.get(src)).toBeFalsy();
  });

  it("refuses a move onto an existing name instead of overwriting it", () => {
    fs.writeFileSync(path.join(root, "a.md"), "keep");
    fs.mkdirSync(path.join(root, "dest"));
    fs.writeFileSync(path.join(root, "dest", "a.md"), "existing");

    expect(workspace.move(path.join(root, "a.md"), path.join(root, "dest")).error).toMatch(
      /that name/
    );
    expect(fs.readFileSync(path.join(root, "dest", "a.md"), "utf-8")).toBe("existing");
  });

  it("refuses a move out of the workspace", () => {
    fs.writeFileSync(path.join(root, "a.md"), "x");
    expect(() => workspace.move(path.join(root, "a.md"), tmpDir)).toThrow(
      /Outside the workspace/
    );
  });

  it("renames a folder and re-points every tracked file beneath it", () => {
    fs.mkdirSync(path.join(root, "old", "deep"), { recursive: true });
    const deep = path.join(root, "old", "deep", "a.md");
    fs.writeFileSync(deep, "x");
    registry.track(deep, "a.md", "x");

    const out = workspace.rename(path.join(root, "old"), "new");
    expect(out.path).toBe(path.join(root, "new"));
    expect(registry.get(path.join(root, "new", "deep", "a.md"))).toBeTruthy();
  });

  it("refuses a rename that would leave the folder", () => {
    fs.writeFileSync(path.join(root, "a.md"), "x");
    const out = workspace.rename(path.join(root, "a.md"), "../b.md");
    expect(out.path).toBe(path.join(root, "..b.md"));
    expect(fs.existsSync(path.join(tmpDir, "b.md"))).toBe(false);
  });

  it("trashes and reveals only inside the workspace", async () => {
    const file = path.join(root, "a.md");
    fs.writeFileSync(file, "x");

    await workspace.trash(file);
    expect(trashed).toEqual([file]);

    workspace.reveal(root);
    expect(revealed).toEqual([root]);

    await expect(workspace.trash(path.join(tmpDir, "outside.md"))).rejects.toThrow(
      /Outside the workspace/
    );
    expect(() => workspace.reveal(tmpDir)).toThrow(/Outside the workspace/);
  });
});

describe("roots", () => {
  it("hides a root whose folder was deleted outside the app", () => {
    const gone = fs.mkdtempSync(path.join(tmpDir, "gone-"));
    registry.addRoot(gone);
    expect(workspace.roots()).toContain(gone);
    fs.rmSync(gone, { recursive: true, force: true });
    expect(workspace.roots()).not.toContain(gone);
  });

  it("refuses to add a folder that is not there", () => {
    expect(workspace.addRoot(path.join(tmpDir, "nope")).error).toBe("Folder not found");
  });
});
