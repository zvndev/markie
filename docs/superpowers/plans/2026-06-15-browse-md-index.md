# Browse — Device-wide Markdown Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Browse" tab to the Library that indexes every meaningful markdown file under `~` (excluding vendored/generated noise), grouped by folder, with star + filter + open-to-edit.

**Architecture:** A main-process module (`electron/mdindex.js`) walks the home directory asynchronously, pruning all dot-directories and a vendored-name set before descending, and re-including `~/.claude/skills`. Results cache in memory + `registry.db`. A new React view (`browse-view.tsx`) renders folders/all-files modes with stars, mounted as a 4th tab in `library.tsx`. IPC bridges the two.

**Tech Stack:** Electron (CommonJS main), Node `fs.promises`, better-sqlite3, React 19 + Tailwind, vitest.

---

## File structure

- **Create** `electron/mdindex.js` — pure exclusion constants + `isExcludedDir`, allowlist matcher, async `walk`, and `scan`/cache orchestration. No `require('electron')` at top level (keeps the pure logic vitest-importable).
- **Create** `electron/mdindex.test.ts` — vitest: exclusion cases, allowlist, and a temp-fixture walk.
- **Modify** `electron/registry.js` — add `md_stars` and `md_index_cache` tables + accessors.
- **Modify** `electron/main.js` — IPC handlers + focus-debounced rescan + `mdindex-updated` emit.
- **Modify** `electron/preload.js` — expose `mdIndex*` methods.
- **Modify** `src/lib/electron.ts` — `MdRow`, `MdStar`, `ElectronAPI` additions.
- **Create** `src/components/browse-view.tsx` — the Browse UI.
- **Modify** `src/components/library.tsx` — add `browse` to `LibView`, the tab, and the render branch.

Test command throughout: `npx vitest run electron/mdindex.test.ts`

---

## Task 1: Exclusion predicate (pure)

**Files:**
- Create: `electron/mdindex.js`
- Test: `electron/mdindex.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/mdindex.test.ts
import { describe, it, expect } from "vitest";
import { isExcludedDir } from "./mdindex.js";

describe("isExcludedDir", () => {
  it("excludes any dot-directory", () => {
    for (const n of [".git", ".next", ".venv", ".bun", ".cargo", ".scion", ".design", ".claude"])
      expect(isExcludedDir(n)).toBe(true);
  });
  it("excludes named vendored/build dirs", () => {
    for (const n of ["node_modules", "Library", "vendor", "bower_components", "dist", "build", "out", "target", "Pods", "venv", "site-packages", "DerivedData"])
      expect(isExcludedDir(n)).toBe(true);
  });
  it("keeps normal directories", () => {
    for (const n of ["Documents", "Coding", "skills", "docs", "notes", "src"])
      expect(isExcludedDir(n)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/mdindex.test.ts`
Expected: FAIL — cannot find `./mdindex.js` / `isExcludedDir is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// electron/mdindex.js
// Device-wide markdown index. Pure walk + exclusion logic lives here with no
// electron/registry imports at module load, so it is unit-testable under vitest.
const fs = require("fs");
const path = require("path");
const os = require("os");

// Non-dot directories that are vendored, generated, or system noise.
const EXCLUDED_NAMES = new Set([
  "node_modules", "Library", "vendor", "bower_components",
  "dist", "build", "out", "target", "Pods",
  "venv", "site-packages", "DerivedData",
]);

// A directory is excluded if it is hidden (dot-dir) or a known vendored name.
// Dot-dir pruning removes the bulk of noise (.git/.bun/.cargo/.scion/.claude/…)
// and keeps the walk fast by never descending into it.
function isExcludedDir(name) {
  if (!name) return false;
  if (name.startsWith(".")) return true;
  return EXCLUDED_NAMES.has(name);
}

module.exports = { isExcludedDir, EXCLUDED_NAMES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/mdindex.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/mdindex.js electron/mdindex.test.ts
git commit -m "feat(mdindex): dot-dir + vendored exclusion predicate"
```

---

## Task 2: Descend decision with allowlist + go/pkg

**Files:**
- Modify: `electron/mdindex.js`
- Test: `electron/mdindex.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { shouldDescend } from "./mdindex.js";
import os from "node:os";
import path from "node:path";

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
    expect(shouldDescend(path.join(home, ".claude"), ".claude", home)).toBe(true); // on the way to skills
    expect(shouldDescend(path.join(home, ".claude", "skills"), "skills", home)).toBe(true);
    expect(shouldDescend(path.join(home, ".claude", "skills", "kirby"), "kirby", home)).toBe(true);
  });
  it("still prunes other .claude subdirs", () => {
    expect(shouldDescend(path.join(home, ".claude", "sessions"), "sessions", home)).toBe(false);
    expect(shouldDescend(path.join(home, ".claude", "plugins"), "plugins", home)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/mdindex.test.ts`
Expected: FAIL — `shouldDescend is not a function`.

- [ ] **Step 3: Write minimal implementation** (add to `electron/mdindex.js`, export it)

```js
// Directories explicitly re-included even though the rules above would prune
// them (they live under a dot-dir). Absolute paths, resolved against home.
function allowlist(home) {
  return [path.join(home, ".claude", "skills")];
}

// Decide whether to descend into `full` (a directory named `name`).
// Order: allowlist wins, then go/pkg prune, then the name predicate.
function shouldDescend(full, name, home) {
  const allow = allowlist(home);
  for (const a of allow) {
    // Descend if `full` is the allowlisted dir, inside it, or an ancestor of it
    // (so the walk can reach it through an otherwise-excluded dot-dir).
    if (full === a || full.startsWith(a + path.sep) || a.startsWith(full + path.sep))
      return true;
  }
  if (name === "pkg" && path.basename(path.dirname(full)) === "go") return false;
  return !isExcludedDir(name);
}

module.exports = { isExcludedDir, EXCLUDED_NAMES, shouldDescend, allowlist };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/mdindex.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add electron/mdindex.js electron/mdindex.test.ts
git commit -m "feat(mdindex): descend decision with .claude/skills allowlist + go/pkg prune"
```

---

## Task 3: Async walk over a fixture tree

**Files:**
- Modify: `electron/mdindex.js`
- Test: `electron/mdindex.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { walk } from "./mdindex.js";
import fs from "node:fs";

describe("walk", () => {
  it("finds .md, skips excluded dirs, descends allowlisted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdwalk-"));
    const mk = (p: string, body = "x") => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), body);
    };
    mk("a.md");
    mk("notes/b.md");
    mk("notes/readme.txt");                 // non-md ignored
    mk("node_modules/pkg/c.md");            // excluded
    mk(".git/d.md");                        // excluded (dot-dir)
    mk(".claude/sessions/e.md");            // excluded
    mk(".claude/skills/kirby/skill.md");    // allowlisted -> included

    const rows = await walk(root, { home: root });
    const rel = rows.map((r) => r.path.slice(root.length + 1)).sort();
    expect(rel).toEqual([".claude/skills/kirby/skill.md", "a.md", "notes/b.md"].sort());
    const a = rows.find((r) => r.name === "a.md")!;
    expect(a.dir).toBe(root);
    expect(typeof a.mtimeMs).toBe("number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/mdindex.test.ts`
Expected: FAIL — `walk is not a function`.

- [ ] **Step 3: Write minimal implementation** (add to `electron/mdindex.js`, export it)

```js
const fsp = fs.promises;
const MD_RE = /\.(md|markdown|mdx)$/i;

// Recursively collect markdown files under rootDir, pruning excluded dirs.
// `home` is passed so the allowlist resolves correctly (tests pass a temp home).
async function walk(rootDir, { home = os.homedir() } = {}) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, vanished) — skip silently
    }
    const subdirs = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldDescend(full, ent.name, home)) subdirs.push(full);
      } else if (ent.isFile() && MD_RE.test(ent.name)) {
        let mtimeMs = 0;
        try { mtimeMs = (await fsp.stat(full)).mtimeMs; } catch { /* keep 0 */ }
        out.push({ path: full, name: ent.name, dir, mtimeMs });
      }
    }
    // Sequential descent keeps memory/FD pressure low on huge trees.
    for (const d of subdirs) await visit(d);
  }
  await visit(rootDir);
  return out;
}

module.exports = { isExcludedDir, EXCLUDED_NAMES, shouldDescend, allowlist, walk };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/mdindex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/mdindex.js electron/mdindex.test.ts
git commit -m "feat(mdindex): async home walk collecting markdown rows"
```

---

## Task 4: Scan orchestration + in-memory cache

**Files:**
- Modify: `electron/mdindex.js`

- [ ] **Step 1: Add scan + cache (no test — thin orchestration over tested walk)**

Append to `electron/mdindex.js` and update exports:

```js
let _cache = null;          // { files, scannedAt }
let _scanning = null;       // in-flight promise (dedupe concurrent scans)

// Run a fresh walk from home. Concurrent callers share one in-flight scan.
function rescan() {
  if (_scanning) return _scanning;
  const home = os.homedir();
  _scanning = walk(home, { home })
    .then((files) => {
      _cache = { files, scannedAt: new Date().toISOString() };
      return _cache;
    })
    .finally(() => { _scanning = null; });
  return _scanning;
}

// Return whatever is cached (may be null on first call).
function getCached() {
  return _cache;
}

// Seed the in-memory cache from a persisted snapshot (instant first paint).
function seed(files, scannedAt) {
  if (Array.isArray(files)) _cache = { files, scannedAt: scannedAt || null };
}

module.exports = {
  isExcludedDir, EXCLUDED_NAMES, shouldDescend, allowlist, walk,
  rescan, getCached, seed,
};
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx vitest run electron/mdindex.test.ts`
Expected: PASS (existing tests still green).

- [ ] **Step 3: Commit**

```bash
git add electron/mdindex.js
git commit -m "feat(mdindex): scan orchestration with in-memory cache + seed"
```

---

## Task 5: Registry — stars + index-cache tables

**Files:**
- Modify: `electron/registry.js`

- [ ] **Step 1: Add tables to the schema** in `getDB()` (inside the existing `db.exec(\`…\`)`), after `workspace_roots`:

```js
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
```

- [ ] **Step 2: Add accessor functions** (before `module.exports`):

```js
// ── Browse: stars (folders + files) ──
function listStars() {
  return getDB().prepare("SELECT path, kind FROM md_stars").all();
}

// Toggle a star; returns the new state. kind is 'folder' | 'file'.
function toggleStar(p, kind) {
  const db = getDB();
  const existing = db.prepare("SELECT path FROM md_stars WHERE path = ?").get(p);
  if (existing) {
    db.prepare("DELETE FROM md_stars WHERE path = ?").run(p);
    return { starred: false };
  }
  db.prepare("INSERT INTO md_stars (path, kind, added_at) VALUES (?, ?, ?)")
    .run(p, kind, new Date().toISOString());
  return { starred: true };
}

// ── Browse: persisted index snapshot (instant first paint) ──
function saveIndexCache(rows) {
  const db = getDB();
  const wipe = db.prepare("DELETE FROM md_index_cache");
  const ins = db.prepare("INSERT OR REPLACE INTO md_index_cache (path, name, mtime_ms) VALUES (?, ?, ?)");
  const tx = db.transaction((items) => {
    wipe.run();
    for (const r of items) ins.run(r.path, r.name, r.mtimeMs || 0);
  });
  tx(rows);
}

function loadIndexCache() {
  return getDB()
    .prepare("SELECT path, name, mtime_ms FROM md_index_cache")
    .all()
    .map((r) => ({ path: r.path, name: r.name, dir: require("path").dirname(r.path), mtimeMs: r.mtime_ms }));
}
```

- [ ] **Step 3: Export them** — add to the `module.exports = { … }` object:

```js
  listStars, toggleStar, saveIndexCache, loadIndexCache,
```

- [ ] **Step 4: Sanity check the file parses**

Run: `node -e "require('./electron/registry.js'); console.log('ok')"`
Expected: prints `ok` (no syntax error; better-sqlite3 loads lazily in getDB).

- [ ] **Step 5: Commit**

```bash
git add electron/registry.js
git commit -m "feat(registry): md_stars + md_index_cache tables and accessors"
```

---

## Task 6: Main-process IPC wiring

**Files:**
- Modify: `electron/main.js`

- [ ] **Step 1: Require the module** near the other requires (top of `main.js`, alongside `const registry = require("./registry")`):

```js
const mdindex = require("./mdindex");
```

- [ ] **Step 2: Add a helper that scans, persists, and notifies.** Place it near `setupAutoUpdate` (module scope):

```js
let _mdLastFocusScan = 0;

// Run a fresh index scan, persist the snapshot, and tell the renderer.
async function mdRescanAndNotify() {
  try {
    const result = await mdindex.rescan();
    try { registry.saveIndexCache(result.files); } catch { /* cache best-effort */ }
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("mdindex-updated", { scannedAt: result.scannedAt });
  } catch (err) {
    console.error("md index scan failed:", err == null ? "unknown" : String(err));
  }
}
```

- [ ] **Step 3: Add IPC handlers** near the other `ipcMain.handle` calls:

```js
// Browse: return cached rows immediately (seeding from the DB snapshot on the
// first call), and kick a background refresh.
ipcMain.handle("mdindex-scan", async () => {
  if (!mdindex.getCached()) {
    try { mdindex.seed(registry.loadIndexCache(), null); } catch { /* no snapshot yet */ }
  }
  const cached = mdindex.getCached();
  mdRescanAndNotify(); // fire-and-forget refresh
  return cached || { files: [], scannedAt: null };
});

ipcMain.handle("mdindex-refresh", async () => {
  const result = await mdindex.rescan();
  try { registry.saveIndexCache(result.files); } catch { /* best-effort */ }
  return result;
});

ipcMain.handle("mdindex-stars", () => registry.listStars());
ipcMain.handle("mdindex-star-toggle", (_e, { path: p, kind }) =>
  registry.toggleStar(p, kind)
);
```

- [ ] **Step 4: Add focus-debounced rescan.** Find where `mainWindow` is created (`new BrowserWindow`) and, after it exists, add:

```js
  mainWindow.on("focus", () => {
    const now = Date.now();
    if (now - _mdLastFocusScan < 20_000) return; // at most once per 20s
    _mdLastFocusScan = now;
    if (mdindex.getCached()) mdRescanAndNotify(); // only after first open
  });
```

(If `mainWindow` is created inside a function, place this right after the assignment there.)

- [ ] **Step 5: Verify main.js parses**

Run: `node -e "require('./electron/main.js')" 2>&1 | head -3`
Expected: It will error on Electron APIs at runtime, but **must not** print a `SyntaxError`. If the only errors mention `app`/`BrowserWindow` undefined, syntax is fine. (Alternatively just eyeball; do not run the app here.)

- [ ] **Step 6: Commit**

```bash
git add electron/main.js
git commit -m "feat(main): mdindex IPC (scan/refresh/stars/toggle) + focus rescan"
```

---

## Task 7: Preload bridge

**Files:**
- Modify: `electron/preload.js`

- [ ] **Step 1: Add methods** inside the `exposeInMainWorld("electronAPI", { … })` object (near the `ws*` group):

```js
  // Browse — device-wide markdown index
  mdIndexScan: () => ipcRenderer.invoke("mdindex-scan"),
  mdIndexRefresh: () => ipcRenderer.invoke("mdindex-refresh"),
  mdIndexStars: () => ipcRenderer.invoke("mdindex-stars"),
  mdIndexToggleStar: (path, kind) =>
    ipcRenderer.invoke("mdindex-star-toggle", { path, kind }),
  onMdIndexUpdated: (callback) =>
    subscribe("mdindex-updated", callback, (info) => info),
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "require('./electron/preload.js')" 2>&1 | head -3`
Expected: errors about `contextBridge`/`process` are fine; no `SyntaxError`.

- [ ] **Step 3: Commit**

```bash
git add electron/preload.js
git commit -m "feat(preload): expose mdIndex scan/refresh/stars/toggle/onUpdated"
```

---

## Task 8: Renderer types

**Files:**
- Modify: `src/lib/electron.ts`

- [ ] **Step 1: Add row/star types** near the other exported interfaces (e.g. after `WsListing`):

```ts
export interface MdRow {
  path: string;
  name: string;
  dir: string;
  mtimeMs: number;
}

export interface MdStar {
  path: string;
  kind: "folder" | "file";
}

export interface MdScanResult {
  files: MdRow[];
  scannedAt: string | null;
}
```

- [ ] **Step 2: Add methods to `interface ElectronAPI`** (anywhere inside it):

```ts
  mdIndexScan?(): Promise<MdScanResult>;
  mdIndexRefresh?(): Promise<MdScanResult>;
  mdIndexStars?(): Promise<MdStar[]>;
  mdIndexToggleStar?(path: string, kind: "folder" | "file"): Promise<{ starred: boolean }>;
  onMdIndexUpdated?(cb: (info: { scannedAt: string | null }) => void): Unsubscribe;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -5`
Expected: no new errors referencing `electron.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/electron.ts
git commit -m "feat(types): MdRow/MdStar/MdScanResult + ElectronAPI mdIndex methods"
```

---

## Task 9: Browse view component

**Files:**
- Create: `src/components/browse-view.tsx`

- [ ] **Step 1: Write the component** (full file):

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { getElectronAPI, type MdRow, type MdStar } from "@/lib/electron";

interface BrowseViewProps {
  onOpenPath: (path: string) => void;
  activePath: string | null;
}

type Mode = "folders" | "files";
const MODE_KEY = "markie.browse.mode.v1";
const STAR_KEY = "markie.browse.starred.v1";
const FULL_KEY = "markie.browse.fullpath.v1";
const FLAT_CAP = 300;

function homeShort(p: string, home: string, full: boolean) {
  if (full) return p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return p.startsWith(home) ? p.slice(home.length + 1) : p;
}

export function BrowseView({ onOpenPath, activePath }: BrowseViewProps) {
  const api = getElectronAPI();
  const [rows, setRows] = useState<MdRow[]>([]);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!api?.mdIndexScan);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<Mode>(
    () => (localStorage.getItem(MODE_KEY) as Mode) || "folders"
  );
  const [starredOnly, setStarredOnly] = useState(
    () => localStorage.getItem(STAR_KEY) === "1"
  );
  const [fullPath, setFullPath] = useState(
    () => localStorage.getItem(FULL_KEY) === "1"
  );
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const home = useMemo(() => {
    // Derive home from any row (dir) — avoids another IPC call.
    const r = rows[0];
    if (!r) return "";
    const i = r.path.indexOf("/", 1);
    return r.path.startsWith("/Users/") ? r.path.split("/").slice(0, 3).join("/") : "";
  }, [rows]);

  const loadStars = () =>
    api?.mdIndexStars?.().then((s: MdStar[]) => setStars(new Set(s.map((x) => x.path))));

  useEffect(() => {
    if (!api?.mdIndexScan) return;
    let alive = true;
    api.mdIndexScan().then((res) => {
      if (!alive) return;
      setRows(res.files);
      setScannedAt(res.scannedAt);
      setLoading(false);
    });
    loadStars();
    const off = api.onMdIndexUpdated?.(() => {
      api.mdIndexRefresh?.().then((res) => {
        if (!alive) return;
        setRows(res.files);
        setScannedAt(res.scannedAt);
      });
    });
    return () => {
      alive = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (k: string, v: string) => {
    try { localStorage.setItem(k, v); } catch { /* ignore */ }
  };

  const refresh = () => {
    if (!api?.mdIndexRefresh) return;
    setRefreshing(true);
    api.mdIndexRefresh().then((res) => {
      setRows(res.files);
      setScannedAt(res.scannedAt);
      setRefreshing(false);
    });
  };

  const toggleStar = (p: string, kind: "folder" | "file") => {
    api?.mdIndexToggleStar?.(p, kind).then(() => loadStars());
  };

  // Filter rows by name/path substring.
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? rows.filter((r) => r.path.toLowerCase().includes(q)) : rows),
    [rows, q]
  );

  // Group filtered rows by directory.
  const folders = useMemo(() => {
    const map = new Map<string, MdRow[]>();
    for (const r of filtered) {
      const arr = map.get(r.dir);
      if (arr) arr.push(r);
      else map.set(r.dir, [r]);
    }
    let entries = Array.from(map.entries());
    if (starredOnly)
      entries = entries.filter(
        ([dir, files]) => stars.has(dir) || files.some((f) => stars.has(f.path))
      );
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries;
  }, [filtered, starredOnly, stars]);

  // Flat newest-first list for "all files".
  const flat = useMemo(() => {
    let list = filtered;
    if (starredOnly) list = list.filter((r) => stars.has(r.path) || stars.has(r.dir));
    return [...list].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, FLAT_CAP);
  }, [filtered, starredOnly, stars]);

  if (!api?.mdIndexScan)
    return <div className="p-4 text-[12px] text-muted">Browse is available in the desktop app.</div>;

  const Star = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={on ? "Unstar" : "Star"}
      className={`shrink-0 px-1 text-[12px] ${on ? "text-yellow-400" : "text-muted hover:text-foreground"}`}
    >
      {on ? "★" : "☆"}
    </button>
  );

  return (
    <div className="flex flex-col h-full">
      {/* controls */}
      <div className="px-2 py-1.5 flex flex-col gap-1.5 border-b border-border">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or path…"
          className="w-full text-[12px] bg-background border border-border rounded-md px-2 py-1 text-foreground outline-none focus:border-foreground/40"
        />
        <div className="flex items-center gap-1 text-[11px]">
          <button
            onClick={() => { setMode("folders"); persist(MODE_KEY, "folders"); }}
            className={`px-2 py-0.5 rounded ${mode === "folders" ? "bg-accent text-foreground" : "text-muted hover:text-foreground"}`}
          >Folders</button>
          <button
            onClick={() => { setMode("files"); persist(MODE_KEY, "files"); }}
            className={`px-2 py-0.5 rounded ${mode === "files" ? "bg-accent text-foreground" : "text-muted hover:text-foreground"}`}
          >All files</button>
          <div className="flex-1" />
          <button
            onClick={() => { const v = !starredOnly; setStarredOnly(v); persist(STAR_KEY, v ? "1" : "0"); }}
            className={`px-1.5 py-0.5 rounded ${starredOnly ? "bg-accent text-yellow-400" : "text-muted hover:text-foreground"}`}
            title="Show starred only"
          >★</button>
          <button
            onClick={() => { const v = !fullPath; setFullPath(v); persist(FULL_KEY, v ? "1" : "0"); }}
            className={`px-1.5 py-0.5 rounded ${fullPath ? "bg-accent text-foreground" : "text-muted hover:text-foreground"}`}
            title="Show full ~ paths"
          >~/</button>
          <button onClick={refresh} className="px-1.5 py-0.5 rounded text-muted hover:text-foreground" title="Rescan">
            {refreshing ? "…" : "⟳"}
          </button>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-[12px] text-muted">Scanning your markdown…</div>
        ) : mode === "folders" ? (
          folders.length === 0 ? (
            <div className="p-4 text-[12px] text-muted">No markdown found{q ? " for this filter" : ""}.</div>
          ) : (
            folders.map(([dir, files]) => {
              const isOpen = open.has(dir);
              return (
                <div key={dir}>
                  <div
                    onClick={() => setOpen((s) => { const n = new Set(s); n.has(dir) ? n.delete(dir) : n.add(dir); return n; })}
                    className="group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-accent/30 text-[12px]"
                  >
                    <span className="text-muted w-3">{isOpen ? "▾" : "▸"}</span>
                    <span className="truncate flex-1 text-foreground/90">{homeShort(dir, home, fullPath)}</span>
                    <span className="text-[9px] text-muted">{files.length}</span>
                    <Star on={stars.has(dir)} onClick={() => toggleStar(dir, "folder")} />
                  </div>
                  {isOpen &&
                    files.map((f) => (
                      <div
                        key={f.path}
                        onClick={() => onOpenPath(f.path)}
                        className={`flex items-center gap-1 pl-7 pr-2 py-1 cursor-pointer hover:bg-accent/30 text-[12px] ${activePath === f.path ? "bg-accent/40" : ""}`}
                      >
                        <span className="truncate flex-1">{f.name}</span>
                        <Star on={stars.has(f.path)} onClick={() => toggleStar(f.path, "file")} />
                      </div>
                    ))}
                </div>
              );
            })
          )
        ) : flat.length === 0 ? (
          <div className="p-4 text-[12px] text-muted">No markdown found{q ? " for this filter" : ""}.</div>
        ) : (
          <>
            {flat.map((f) => (
              <div
                key={f.path}
                onClick={() => onOpenPath(f.path)}
                className={`flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-accent/30 ${activePath === f.path ? "bg-accent/40" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-foreground/90">{f.name}</div>
                  <div className="truncate text-[10px] text-muted">{homeShort(f.dir, home, fullPath)}</div>
                </div>
                <Star on={stars.has(f.path)} onClick={() => toggleStar(f.path, "file")} />
              </div>
            ))}
            {filtered.length > FLAT_CAP && (
              <div className="p-3 text-[11px] text-muted">
                Showing newest {FLAT_CAP} of {filtered.length}. Use the filter to narrow.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -8`
Expected: no errors in `browse-view.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/browse-view.tsx
git commit -m "feat(browse): Browse view — folders/all-files, stars, filter, full-path"
```

---

## Task 10: Wire Browse into the Library

**Files:**
- Modify: `src/components/library.tsx`

- [ ] **Step 1: Import + extend the view union.** At the top imports add:

```tsx
import { BrowseView } from "@/components/browse-view";
```

Change the union (line ~21):

```tsx
type LibView = "recent" | "files" | "shared" | "browse";
```

And the persisted-view guard (the `localStorage.getItem(VIEW_KEY)` line ~54):

```tsx
      return v === "files" || v === "shared" || v === "browse" ? v : "recent";
```

- [ ] **Step 2: Add the tab.** Find the tab row (`(["recent", "files", "shared"] as LibView[]).map(...)`, line ~320) and change the array to:

```tsx
        {(["recent", "files", "shared", "browse"] as LibView[]).map((v) => (
```

- [ ] **Step 3: Render the view.** Find the render chain that ends with the `<FilesView … />` branch (around line ~341–390). The current final `else` renders `FilesView`. Wrap so `browse` renders `BrowseView`. Locate:

```tsx
        ) : (
          <FilesView
```

and change it to:

```tsx
        ) : view === "browse" ? (
          <BrowseView onOpenPath={onOpenPath} activePath={activePath} />
        ) : (
          <FilesView
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -8 && npm run build 2>&1 | tail -5`
Expected: no type errors; Next build "Compiled successfully".

- [ ] **Step 5: Commit**

```bash
git add src/components/library.tsx
git commit -m "feat(library): add Browse tab wiring"
```

---

## Task 11: Manual verification in the desktop app

**Files:** none (verification)

- [ ] **Step 1: Launch the dev desktop app**

Run: `npm run electron:dev`

- [ ] **Step 2: Verify behavior**

- Open the Library (⌘L) → click the **Browse** tab.
- Folders view lists real folders (NO `node_modules`, NO `.git`/`.bun` noise); `~/.claude/skills` appears.
- Expand a folder → files open in the editor on click.
- Toggle **All files** → newest-first flat list with muted paths beneath.
- Star a folder and a file → toggle **★** → only starred remain.
- Toggle **~/** → paths switch to `~/…` absolute form.
- Type in the filter → list narrows.
- Hit **⟳** → list refreshes without error.

- [ ] **Step 3: Confirm no leakage**

In the running app's filter box, type `node_modules` → expect **no results** (hard exclusion).

- [ ] **Step 4: Run the full test + lint suite**

Run: `npm test && npx tsc --noEmit -p tsconfig.json`
Expected: vitest all green (including `mdindex.test.ts`); no type errors.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(browse): verification fixups"
```

---

## Self-review notes (for the implementer)

- The only TDD-critical logic (exclusion + allowlist + walk) is covered by `electron/mdindex.test.ts`. Star/cache SQL follows the existing untested `registry.js` pattern and is smoke-verified in Task 11.
- `home` derivation in `browse-view.tsx` assumes macOS `/Users/<name>` (the app is macOS-only); full-path toggle degrades to the absolute path if it can't match.
- Method/type names are consistent across tasks: `mdIndexScan` / `mdIndexRefresh` / `mdIndexStars` / `mdIndexToggleStar` / `onMdIndexUpdated`, returning `MdScanResult` / `MdStar[]` / `{ starred }`.
