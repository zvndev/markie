import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  getCached,
  isBundleDir,
  allowlist,
  isExcludedDir,
  moved,
  noteFile,
  rescan,
  scanTargets,
  seed,
  shouldDescend,
  skippedDirs,
  walk,
} from "./mdindex.js";

// The walk's injectable seams are typed loosely on the JS side; these keep the
// fakes honest without pulling a .d.ts in for a CommonJS module.
type WalkOptions = {
  home?: string;
  platform?: NodeJS.Platform;
  realpath?: (p: fs.PathLike) => string;
  roots?: string[];
  budget?: { maxFiles?: number; maxMs?: number; maxDepth?: number };
  now?: () => number;
  stats?: Record<string, unknown>;
};
const skipWith = (opts: {
  home?: string;
  platform?: string;
  realpath?: (p: fs.PathLike) => string;
  roots?: string[];
}) => skippedDirs(opts as never) as Set<string>;
const descendWith = (
  full: string,
  name: string,
  home: string,
  opts: { roots?: string[]; allow?: string[]; skip?: Set<string> | null }
) => shouldDescend(full, name, home, opts as never) as boolean;
const walkWith = (dir: string, opts: WalkOptions) =>
  walk(dir, opts as never) as Promise<
    Array<{ path: string; name: string; dir: string; mtimeMs: number }>
  >;

describe("isExcludedDir", () => {
  it("excludes any dot-directory", () => {
    for (const n of [".git", ".next", ".venv", ".bun", ".cargo", ".scion", ".design", ".claude"])
      expect(isExcludedDir(n)).toBe(true);
  });
  it("excludes named vendored/build dirs", () => {
    for (const n of ["node_modules", "Library", "vendor", "bower_components", "dist", "build", "out", "target", "Pods", "venv", "site-packages", "DerivedData"])
      expect(isExcludedDir(n)).toBe(true);
  });
  it("excludes tmp and temp dirs", () => {
    for (const n of ["tmp", "temp"]) expect(isExcludedDir(n)).toBe(true);
  });
  it("keeps normal directories", () => {
    for (const n of ["Documents", "Coding", "skills", "docs", "notes", "src"])
      expect(isExcludedDir(n)).toBe(false);
  });
});

describe("shouldDescend", () => {
  const home = os.homedir();
  it("descends normal dirs", () => {
    expect(shouldDescend(path.join(home, "Documents"), "Documents", home)).toBe(true);
  });
  it("prunes excluded dirs", () => {
    expect(shouldDescend(path.join(home, "p", "node_modules"), "node_modules", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".git"), ".git", home)).toBe(false);
  });
  it("prunes go/pkg specifically", () => {
    expect(shouldDescend(path.join(home, "go", "pkg"), "pkg", home)).toBe(false);
  });
  it("re-includes ~/.claude/skills and its path", () => {
    expect(shouldDescend(path.join(home, ".claude"), ".claude", home)).toBe(true);
    expect(shouldDescend(path.join(home, ".claude", "skills"), "skills", home)).toBe(true);
    expect(shouldDescend(path.join(home, ".claude", "skills", "kirby"), "kirby", home)).toBe(true);
  });
  it("still prunes other .claude subdirs", () => {
    expect(shouldDescend(path.join(home, ".claude", "sessions"), "sessions", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".claude", "plugins"), "plugins", home)).toBe(false);
  });
  it("re-includes ~/.codex (OpenAI Codex agent files)", () => {
    expect(shouldDescend(path.join(home, ".codex"), ".codex", home)).toBe(true);
    expect(shouldDescend(path.join(home, ".codex", "sub"), "sub", home)).toBe(true);
  });
  it("re-includes the other tools Markie installs skills into", () => {
    for (const tool of [".agents", ".cursor", ".gemini"]) {
      expect(shouldDescend(path.join(home, tool), tool, home)).toBe(true);
      expect(shouldDescend(path.join(home, tool, "skills"), "skills", home)).toBe(true);
      expect(shouldDescend(path.join(home, tool, "skills", "pdf"), "pdf", home)).toBe(true);
    }
    // Only the skills folder: the rest of a tool's dot-dir stays out.
    expect(shouldDescend(path.join(home, ".cursor", "extensions"), "extensions", home)).toBe(false);
  });
  it("re-includes a Claude or Codex config folder the user has moved", () => {
    // The realistic case: a config folder tucked inside ~/.config, which the
    // dot-dir rule prunes unless the allowlist names it.
    const env = {
      CLAUDE_CONFIG_DIR: path.join(home, ".config", "claude"),
      CODEX_HOME: path.join(home, ".config", "codex"),
    };
    const allow = allowlist(home, env);
    for (const configured of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) {
      const skills = path.join(configured, "skills");
      expect(allow).toContain(skills);
      expect(shouldDescend(path.join(home, ".config"), ".config", home, { allow })).toBe(true);
      expect(shouldDescend(configured, path.basename(configured), home, { allow })).toBe(true);
      expect(shouldDescend(skills, "skills", home, { allow })).toBe(true);
      expect(shouldDescend(path.join(skills, "pdf"), "pdf", home, { allow })).toBe(true);
    }
    // Only the skills folder inside it, as for every other tool.
    expect(
      shouldDescend(path.join(env.CODEX_HOME, "sessions"), "sessions", home, { allow })
    ).toBe(false);
    // An unset pair leaves the list exactly as it was.
    expect(allowlist(home, {})).toEqual(allowlist(home, { CLAUDE_CONFIG_DIR: "" }));
  });
  it("still prunes node_modules and nested dot-dirs INSIDE an allowlisted root", () => {
    // allowlisting ~/.codex must not drag in its node_modules / nested .git
    expect(shouldDescend(path.join(home, ".codex", "node_modules"), "node_modules", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".codex", ".git"), ".git", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".claude", "skills", "node_modules"), "node_modules", home)).toBe(false);
  });
});

describe("walk", () => {
  it("finds .md, skips excluded dirs, descends allowlisted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdwalk-"));
    const mk = (p: string, body = "x") => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), body);
    };
    mk("a.md");
    mk("notes/b.md");
    mk("notes/readme.txt");
    mk("node_modules/pkg/c.md");
    mk(".git/d.md");
    mk(".claude/sessions/e.md");
    mk(".claude/skills/kirby/skill.md");

    const rows = await walkWith(root, { home: root });
    const rel = rows.map((r) => r.path.slice(root.length + 1)).sort();
    expect(rel).toEqual([".claude/skills/kirby/skill.md", "a.md", "notes/b.md"].sort());
    const a = rows.find((r) => r.name === "a.md")!;
    expect(a.dir).toBe(root);
    expect(typeof a.mtimeMs).toBe("number");
  });
});

describe("cloud, bundle, and Windows exclusions", () => {
  it("prunes cloud-sync mounts, whose every readdir is a daemon round trip", () => {
    for (const n of ["Dropbox", "Google Drive", "OneDrive"])
      expect(isExcludedDir(n)).toBe(true);
  });
  it("prunes macOS bundle farms and Windows profile dirs", () => {
    for (const n of ["Applications", "Pictures", "Movies", "Music", "AppData", "Application Data", "Local Settings", "$Recycle.Bin"])
      expect(isExcludedDir(n)).toBe(true);
  });
  it("treats a package directory as an opaque document, not a folder", () => {
    for (const n of ["Photos Library.photoslibrary", "Markie.app", "Markie.xcodeproj", "win.vmwarevm", "Base.lproj", "Foo.framework", "Thing.bundle"])
      expect(isBundleDir(n)).toBe(true);
    expect(isBundleDir("notes")).toBe(false);
    expect(isBundleDir("app")).toBe(false);
  });
  it("does not descend into a bundle even when nothing else excludes it", () => {
    const home = os.homedir();
    expect(shouldDescend(path.join(home, "Coding", "Markie.app"), "Markie.app", home)).toBe(false);
  });
});

describe("iCloud Desktop & Documents", () => {
  const home = "/Users/u";
  const desktop = path.join(home, "Desktop");
  const documents = path.join(home, "Documents");
  // What macOS actually does when Desktop & Documents sync is on: the folder
  // resolves into the file provider's tree.
  const backed = (p: fs.PathLike) =>
    String(p) === documents
      ? `${home}/Library/Mobile Documents/com~apple~CloudDocs/Documents`
      : String(p);
  const identity = (p: fs.PathLike) => String(p);

  it("leaves a folder alone only when that folder is really provider-backed", () => {
    const skip = skipWith({ home, platform: "darwin", realpath: backed });
    expect(skip.has(documents)).toBe(true);
    // Desktop is an ordinary local folder here — the old marker-file test
    // skipped it anyway, purely because some iCloud app was installed.
    expect(skip.has(desktop)).toBe(false);
  });

  it("walks both normally when neither is synced", () => {
    expect(skipWith({ home, platform: "darwin", realpath: identity }).size).toBe(0);
  });

  it("treats an unreadable folder as ordinary rather than skipping it", () => {
    const throwing = () => {
      throw new Error("ENOENT");
    };
    expect(skipWith({ home, platform: "darwin", realpath: throwing }).size).toBe(0);
  });

  it("does nothing off macOS — there is no fileproviderd to spare", () => {
    expect(skipWith({ home, platform: "win32", realpath: backed }).size).toBe(0);
  });

  it("still walks a synced folder the user explicitly registered as a root", () => {
    const skip = skipWith({
      home,
      platform: "darwin",
      realpath: backed,
      roots: [documents],
    });
    expect(skip.has(documents)).toBe(false);
  });

  it("counts a root nested inside the synced tree as an explicit choice", () => {
    const skip = skipWith({
      home,
      platform: "darwin",
      realpath: backed,
      roots: [path.join(documents, "Notes")],
    });
    expect(skip.has(documents)).toBe(false);
  });
});

describe("registered workspace roots outrank the exclusion names", () => {
  const home = "/Users/u";

  it("descends a root that lives under an excluded name", () => {
    const roots = [path.join(home, "Dropbox", "Notes")];
    // …and everything on the way down to it.
    expect(descendWith(path.join(home, "Dropbox"), "Dropbox", home, { roots })).toBe(true);
    expect(
      descendWith(path.join(home, "Dropbox", "Notes"), "Notes", home, { roots })
    ).toBe(true);
    expect(
      descendWith(path.join(home, "Dropbox", "Notes", "work"), "work", home, { roots })
    ).toBe(true);
    // A sibling under the same excluded name is still pruned.
    expect(descendWith(path.join(home, "Dropbox", "Photos"), "Photos", home, { roots })).toBe(
      false
    );
  });

  it("keeps pruning vendored dirs inside a root", () => {
    const roots = [path.join(home, "Pictures", "shots")];
    expect(
      descendWith(path.join(home, "Pictures", "shots", "node_modules"), "node_modules", home, { roots })
    ).toBe(false);
    expect(
      descendWith(path.join(home, "Pictures", "shots", "Album.photoslibrary"), "Album.photoslibrary", home, { roots })
    ).toBe(false);
  });

  it("indexes markdown under a root whose name would otherwise be excluded", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdroots-"));
    const mk = (p: string) => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), "x");
    };
    mk("Dropbox/Notes/keep.md");
    mk("Dropbox/Other/skip.md");
    mk("Pictures/Shots/keep2.md");
    mk("Pictures/Camera/skip2.md");

    const rows = await walkWith(root, {
      home: root,
      roots: [path.join(root, "Dropbox", "Notes"), path.join(root, "Pictures", "Shots")],
    });
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["keep.md", "keep2.md"]);
  });
});

describe("walk budget", () => {
  const mkTree = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdbudget-"));
    const mk = (p: string) => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), "x");
    };
    mk("a.md");
    mk("one/b.md");
    mk("one/two/c.md");
    mk("one/two/three/d.md");
    return { root, mk };
  };

  it("stops descending past the depth cap and says so", async () => {
    const { root } = mkTree();
    const stats: Record<string, unknown> = {};
    const rows = await walkWith(root, { home: root, budget: { maxDepth: 1 }, stats });
    const rel = rows.map((r) => r.path.slice(root.length + 1)).sort();
    expect(rel).toEqual(["a.md", "one/b.md"]);
    expect(stats.truncated).toBe(true);
    expect(stats.reason).toBe("depth");
  });

  it("returns a partial result instead of an unbounded one at the file cap", async () => {
    const { root } = mkTree();
    const stats: Record<string, unknown> = {};
    const rows = await walkWith(root, { home: root, budget: { maxFiles: 2 }, stats });
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(stats.truncated).toBe(true);
    expect(stats.reason).toBe("files");
  });

  it("gives up on wall-clock time rather than walking a pathological tree forever", async () => {
    const { root } = mkTree();
    const stats: Record<string, unknown> = {};
    let clock = 0;
    await walkWith(root, {
      home: root,
      budget: { maxMs: 5 },
      now: () => (clock += 10),
      stats,
    });
    expect(stats.truncated).toBe(true);
    expect(stats.reason).toBe("time");
  });

  it("reports an untruncated walk as complete", async () => {
    const { root } = mkTree();
    const stats: Record<string, unknown> = {};
    await walkWith(root, { home: root, stats });
    expect(stats.truncated).toBe(false);
    expect(stats.reason).toBe(null);
  });

  it("leaves a provider-backed Desktop and Documents unread", async () => {
    const { root, mk } = mkTree();
    mk("Desktop/desk.md");
    mk("Documents/doc.md");
    // Both folders resolve into the file provider's tree, as they do on a Mac
    // with Desktop & Documents sync switched on.
    const backed = (p: fs.PathLike) =>
      String(p).endsWith("Desktop") || String(p).endsWith("Documents")
        ? `/Users/u/Library/Mobile Documents/com~apple~CloudDocs/${path.basename(String(p))}`
        : String(p);

    const synced = await walkWith(root, { home: root, platform: "darwin", realpath: backed });
    expect(synced.map((r) => r.name)).not.toContain("desk.md");
    expect(synced.map((r) => r.name)).not.toContain("doc.md");

    // …but a registered workspace root is the user's explicit instruction.
    const registered = await walkWith(root, {
      home: root,
      platform: "darwin",
      realpath: backed,
      roots: [path.join(root, "Documents")],
    });
    expect(registered.map((r) => r.name)).toContain("doc.md");
    expect(registered.map((r) => r.name)).not.toContain("desk.md");
  });
});

describe("scanTargets", () => {
  it("drops a target that already sits inside another", () => {
    expect(scanTargets(["/Users/u", "/Users/u/Notes", "/data"])).toEqual(["/Users/u", "/data"]);
  });
  it("de-duplicates and ignores empties", () => {
    expect(scanTargets(["/a", "/a", "", null as unknown as string])).toEqual(["/a"]);
  });

  it("keeps a registered root as its own target even when nested in another", () => {
    expect(scanTargets(["/Users/u", "/Users/u/Dropbox/Notes"], ["/Users/u/Dropbox/Notes"])).toEqual(
      ["/Users/u", "/Users/u/Dropbox/Notes"]
    );
  });
});

describe("rescan budget", () => {
  it("spends one budget across every target, not one budget each", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "mdrescan-"));
    const mk = (p: string) => {
      fs.mkdirSync(path.dirname(path.join(base, p)), { recursive: true });
      fs.writeFileSync(path.join(base, p), "x");
    };
    mk("one/a.md");
    mk("one/b.md");
    mk("two/c.md");
    mk("two/d.md");

    const res = (await rescan({
      home: path.join(base, "one"),
      roots: [path.join(base, "one"), path.join(base, "two")],
      includeHome: false,
      budget: { maxFiles: 3 },
    })) as { files: unknown[]; truncated: boolean; truncatedReason: string | null };

    expect(res.files.length).toBeLessThanOrEqual(3);
    expect(res.truncated).toBe(true);
    expect(res.truncatedReason).toBe("files");
  });
});

describe("a rename Markie made itself", () => {
  type Row = { path: string; name: string; dir: string; mtimeMs: number };
  const rows = () => (getCached() as { files: Row[] }).files;
  const seedRows = (...paths: string[]) =>
    seed(
      paths.map((p) => ({ path: p, name: path.basename(p), dir: path.dirname(p), mtimeMs: 5 })),
      "2026-09-01T00:00:00.000Z"
    );

  it("patches the row in place rather than walking the disk again", () => {
    seedRows("/h/notes/a.md", "/h/notes/b.md");
    const patched = moved("/h/notes/a.md", "/h/notes/renamed.md");
    expect(patched).not.toBeNull();
    expect(rows().map((r) => r.path)).toEqual(["/h/notes/renamed.md", "/h/notes/b.md"]);
    expect(rows()[0]).toMatchObject({ name: "renamed.md", dir: "/h/notes", mtimeMs: 5 });
  });

  it("carries everything under a renamed folder", () => {
    seedRows("/h/old/a.md", "/h/old/deep/b.md", "/h/other/c.md");
    moved("/h/old", "/h/new", { isDir: true });
    expect(rows().map((r) => r.path)).toEqual(["/h/new/a.md", "/h/new/deep/b.md", "/h/other/c.md"]);
    expect(rows()[1].dir).toBe("/h/new/deep");
  });

  it("drops a file renamed out of markdown, and says nothing when nothing changed", () => {
    seedRows("/h/a.md", "/h/b.md");
    expect(moved("/h/a.md", "/h/a.txt")).not.toBeNull();
    expect(rows().map((r) => r.path)).toEqual(["/h/b.md"]);
    expect(moved("/h/nowhere.txt", "/h/elsewhere.txt")).toBeNull();
  });

  it("adds a file renamed into markdown", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdmoved-"));
    const target = path.join(dir, "now.md");
    fs.writeFileSync(target, "x");
    seedRows("/h/b.md");
    moved(path.join(dir, "was.txt"), target);
    expect(rows().map((r) => r.path)).toEqual(["/h/b.md", target]);
    expect(rows()[1].mtimeMs).toBeGreaterThan(0);
  });
});

describe("a file Markie wrote itself", () => {
  type Row = { path: string; name: string; dir: string };
  const rows = () => (getCached() as { files: Row[] }).files;

  it("joins the index at once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdnote-"));
    const landed = path.join(dir, "from-the-laptop.md");
    fs.writeFileSync(landed, "x");
    seed([{ path: "/h/a.md", name: "a.md", dir: "/h", mtimeMs: 1 }], null);
    expect(noteFile(landed)).not.toBeNull();
    expect(rows().map((r) => r.path)).toEqual(["/h/a.md", landed]);
    expect(rows()[1]).toMatchObject({ name: "from-the-laptop.md", dir });
    // Once is enough, and a text file is not markdown.
    expect(noteFile(landed)).toBeNull();
    expect(noteFile(path.join(dir, "notes.txt"))).toBeNull();
  });
});
