# Phase 1: Markie Local Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the app to Markie and fix the local-mode experience: files open directly on cold start, View (preview) is the default and primary mode, stats move to the native menu bar, the toolbar clears the macOS traffic lights, and the app gains Save / Save As / Rename / Fork / Export.

**Architecture:** All changes stay within the existing Electron (main + preload) ↔ Next.js renderer split. New IPC channels follow the existing `ipcMain.handle` / `contextBridge` pattern. A typed `ElectronAPI` interface replaces the `(window as any)` casts, and IPC event listeners are registered exactly once with a ref-based handler indirection (the current code stacks duplicate listeners on every dependency change — `src/app/page.tsx:195-206`).

**Tech Stack:** Electron 41, Next.js 16 static export, React 19, TypeScript, Tailwind 4, vitest (new, for pure logic).

**Parent roadmap:** `docs/superpowers/plans/2026-06-11-markie-roadmap.md`

**Testing approach:** Pure logic (stats computation) is TDD with vitest. Electron main/IPC behavior is covered by explicit manual verification steps with exact commands and expected results — there is no Electron test harness in this repo and adding one is out of scope for this phase.

---

### Task 1: Rename Marker → Markie

**Files:**
- Modify: `package.json` (name, appId, productName)
- Modify: `electron/main.js:38`
- Modify: `src/app/layout.tsx:15-18`
- Modify: `src/app/page.tsx:9-11`
- Modify: `src/components/toolbar.tsx:47-49`

- [ ] **Step 1: Update package.json identity fields**

In `package.json`, change:

```json
  "name": "marker",
```
to
```json
  "name": "markie",
```

and in the `build` block change:

```json
    "appId": "com.zvn.marker",
    "productName": "Marker",
```
to
```json
    "appId": "com.zvn.markie",
    "productName": "Markie",
```

- [ ] **Step 2: Update the production protocol URL**

In `electron/main.js` line 38, change:

```js
    mainWindow.loadURL("app://marker/index.html");
```
to
```js
    mainWindow.loadURL("app://markie/index.html");
```

(The protocol handler ignores the host, so this is cosmetic consistency — but it must match nothing else, so it's safe.)

- [ ] **Step 3: Update renderer metadata and wordmark**

In `src/app/layout.tsx`, change:

```ts
export const metadata: Metadata = {
  title: "Marker — Markdown Viewer",
  description: "A beautiful markdown viewer and editor",
};
```
to
```ts
export const metadata: Metadata = {
  title: "Markie — Markdown Viewer",
  description: "A beautiful markdown viewer and editor",
};
```

In `src/app/page.tsx`, change the sample's first lines:

```ts
const SAMPLE = `# Welcome to Marker

A beautiful markdown viewer and editor. Start writing, paste content, or open a file.
```
to
```ts
const SAMPLE = `# Welcome to Markie

A beautiful markdown viewer and editor. Start writing, paste content, or open a file.
```

In `src/components/toolbar.tsx`, change:

```tsx
        <span className="text-[13px] font-semibold tracking-tight text-foreground/90">
          Marker
        </span>
```
to
```tsx
        <span className="text-[13px] font-semibold tracking-tight text-foreground/90">
          Markie
        </span>
```

- [ ] **Step 4: Verify**

Run: `npm run electron:dev`
Expected: window opens, toolbar reads "Markie", welcome doc reads "Welcome to Markie". Quit the app.

- [ ] **Step 5: Commit**

```bash
git add package.json electron/main.js src/app/layout.tsx src/app/page.tsx src/components/toolbar.tsx
git commit -m "feat: rename app from Marker to Markie"
```

---

### Task 2: Typed ElectronAPI + register-once IPC listeners

The current renderer registers `ipcRenderer.on` callbacks inside a `useEffect` with dependencies (`src/app/page.tsx:195-206`) and never removes them — every dependency change stacks another listener. Before adding Save and more menu events, fix the pattern: register listeners exactly once, dispatch through a ref that always points at the latest handlers. Also add a typed API so later tasks stop casting `window as any`.

**Files:**
- Create: `src/lib/electron.ts`
- Modify: `src/app/page.tsx`
- Modify: `electron/preload.js`

- [ ] **Step 1: Create the typed API module**

Create `src/lib/electron.ts`:

```ts
export interface FilePayload {
  name: string;
  content: string;
  path: string;
}

export interface SaveResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  name?: string;
  error?: string;
}

export type ViewMode = "edit" | "preview" | "split";

export interface ElectronAPI {
  platform: string;
  openFile(): Promise<FilePayload | null>;
  openFilePath(path: string): Promise<FilePayload | null>;
  getInitialFile(): Promise<FilePayload | null>;
  exportPDF(html: string): Promise<{ success: boolean; path?: string }>;
  exportHTML(args: { defaultName: string; html: string }): Promise<SaveResult>;
  saveFile(args: { filePath: string; content: string }): Promise<SaveResult>;
  saveFileAs(args: { defaultName: string; content: string }): Promise<SaveResult>;
  renameFile(args: { oldPath: string; newName: string }): Promise<SaveResult>;
  onMenuOpenFile(cb: () => void): void;
  onMenuExportPDF(cb: (theme: "dark" | "light") => void): void;
  onMenuExportHTML(cb: () => void): void;
  onMenuSave(cb: () => void): void;
  onMenuSaveAs(cb: () => void): void;
  onMenuFork(cb: () => void): void;
  onSetMode(cb: (mode: ViewMode) => void): void;
  onToggleStats(cb: () => void): void;
  onFileOpened(cb: (data: FilePayload) => void): void;
}

export function getElectronAPI(): ElectronAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}
```

(Methods not yet implemented in preload are typed now so later tasks don't touch this file again; the renderer always optional-chains them.)

- [ ] **Step 2: Expose platform in preload**

In `electron/preload.js`, add `platform` as the first property of the exposed object:

```js
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  openFile: () => ipcRenderer.invoke("open-file"),
```

- [ ] **Step 3: Rewrite the renderer's IPC wiring as register-once**

In `src/app/page.tsx`, add the import:

```ts
import { getElectronAPI, type FilePayload } from "@/lib/electron";
```

Replace the existing Electron IPC effect (`page.tsx:194-206`):

```ts
  // Listen for Electron IPC events
  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).electronAPI) return;

    const api = (window as any).electronAPI;
    api.onMenuOpenFile?.(() => handleOpenFile());
    api.onMenuExportPDF?.(() => handleExportPDF("dark"));
    api.onSetMode?.((m: ViewMode) => setMode(m));
    api.onFileOpened?.((data: { name: string; content: string }) => {
      setContent(data.content);
      setFileName(data.name);
    });
  }, [handleOpenFile, handleExportPDF]);
```

with a ref-dispatched, mount-once registration:

```ts
  // Latest handlers, readable from once-registered IPC listeners
  const handlersRef = useRef({
    openFile: handleOpenFile,
    exportPDF: handleExportPDF,
    fileOpened: (data: FilePayload) => {
      setContent(data.content);
      setFileName(data.name);
    },
  });
  handlersRef.current.openFile = handleOpenFile;
  handlersRef.current.exportPDF = handleExportPDF;

  // Listen for Electron IPC events — registered exactly once
  useEffect(() => {
    const api = getElectronAPI();
    if (!api) return;
    api.onMenuOpenFile?.(() => handlersRef.current.openFile());
    api.onMenuExportPDF?.((theme) => handlersRef.current.exportPDF(theme ?? "dark"));
    api.onSetMode?.((m) => setMode(m));
    api.onFileOpened?.((data) => handlersRef.current.fileOpened(data));
  }, []);
```

Also replace the two remaining `(window as any).electronAPI` usages in `handleOpenFile` (line 70) and `handleExportPDF` (line 106) with `getElectronAPI()`:

```ts
  const handleOpenFile = useCallback(() => {
    const api = getElectronAPI();
    if (api) {
      api.openFile().then((result) => {
        if (result) {
          setContent(result.content);
          setFileName(result.name);
        }
      });
      return;
    }
    // ... web fallback unchanged
```

```ts
    // In Electron, send HTML to main process for printToPDF
    const api = getElectronAPI();
    if (api) {
      api.exportPDF(fullHTML);
      return;
    }
```

- [ ] **Step 4: Verify no regression**

Run: `npm run electron:dev`
Expected: Cmd+O menu item opens the dialog once (set a `console.log` breakpoint mentally: open a file, content swaps once). File > Export PDF still works. Quit.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/electron.ts src/app/page.tsx electron/preload.js
git commit -m "refactor: typed ElectronAPI and register-once IPC listeners"
```

---

### Task 3: Cold-start file open fix

The bug: `app.on("open-file")` (`electron/main.js:247`) drops the event when `mainWindow` doesn't exist yet — exactly the cold-start case — so double-clicking a .md in Finder launches Markie onto the welcome sample and you must open the file again. Fix: queue the path in main, and have the renderer pull it on mount via a `get-initial-file` handshake (this also closes the race where the window exists but React hasn't registered `onFileOpened` yet).

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Queue pending opens in main**

In `electron/main.js`, after `let mainWindow;` (line 16), add:

```js
let rendererReady = false;
let pendingFilePath = null;

const OPENABLE = /\.(md|markdown|mdx|txt)$/i;

function readFilePayload(filePath) {
  try {
    return {
      name: path.basename(filePath),
      content: fs.readFileSync(filePath, "utf-8"),
      path: filePath,
    };
  } catch {
    return null;
  }
}

// File passed as a CLI argument (dev runs, Windows/Linux double-click)
const argFile = process.argv
  .slice(1)
  .find((a) => OPENABLE.test(a) && fs.existsSync(a));
if (argFile) pendingFilePath = path.resolve(argFile);
```

- [ ] **Step 2: Replace the open-file handler**

Replace the existing handler at the bottom of `electron/main.js`:

```js
// Handle file open via command line args or "open with"
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    const content = fs.readFileSync(filePath, "utf-8");
    const name = path.basename(filePath);
    mainWindow.webContents.send("file-opened", {
      name,
      content,
      path: filePath,
    });
  }
});
```

with:

```js
// Handle file open via Finder "open with" / double-click.
// Before the renderer is ready, queue the path; it is delivered via
// the get-initial-file handshake when the renderer mounts.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    const payload = readFilePayload(filePath);
    if (payload) mainWindow.webContents.send("file-opened", payload);
  } else {
    pendingFilePath = filePath;
    if (mainWindow === null || mainWindow === undefined) {
      // Cold start after all windows closed (macOS dock-alive state)
      if (app.isReady()) createWindow();
    }
  }
});
```

- [ ] **Step 3: Add the handshake IPC and reset on window close**

In `electron/main.js`, next to the other `ipcMain.handle` calls, add:

```js
// IPC: renderer signals it has mounted and asks for any queued file
ipcMain.handle("get-initial-file", () => {
  rendererReady = true;
  if (!pendingFilePath) return null;
  const payload = readFilePayload(pendingFilePath);
  pendingFilePath = null;
  return payload;
});
```

In `createWindow()`, after the `mainWindow = new BrowserWindow({...})` statement, add:

```js
  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
  });
```

- [ ] **Step 4: Expose in preload**

In `electron/preload.js`, add below `openFilePath`:

```js
  getInitialFile: () => ipcRenderer.invoke("get-initial-file"),
```

- [ ] **Step 5: Pull the initial file in the renderer**

In `src/app/page.tsx`, add a mount effect (place it directly above the IPC-listeners effect from Task 2):

```ts
  // Cold start: pull any file the OS asked us to open before React mounted
  useEffect(() => {
    const api = getElectronAPI();
    api?.getInitialFile?.().then((file) => {
      if (file) {
        setContent(file.content);
        setFileName(file.name);
      }
    });
  }, []);
```

- [ ] **Step 6: Verify cold start in the packaged app**

```bash
echo "# Cold start works" > /tmp/markie-coldstart.md
npm run electron:pack
open -a "$(pwd)/dist/mac-arm64/Markie.app" /tmp/markie-coldstart.md
```

Expected: the app launches **directly showing "Cold start works" rendered** — no welcome sample, no second open needed.

Then, with the app still running:

```bash
echo "# Warm open works" > /tmp/markie-warm.md
open -a "$(pwd)/dist/mac-arm64/Markie.app" /tmp/markie-warm.md
```

Expected: the running window swaps to "Warm open works". Quit the app.

- [ ] **Step 7: Commit**

```bash
git add electron/main.js electron/preload.js src/app/page.tsx
git commit -m "fix: open files directly on cold start instead of welcome screen"
```

---

### Task 4: View-first — preview is default, named "View", Edit/Split demoted to icons

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/toolbar.tsx`
- Modify: `electron/main.js` (View menu)

- [ ] **Step 1: Default mode and shortcut remap in the renderer**

In `src/app/page.tsx`, change the mode default (line 59):

```ts
  const [mode, setMode] = useState<ViewMode>("split");
```
to
```ts
  const [mode, setMode] = useState<ViewMode>("preview");
```

In the keyboard shortcut handler (lines 170-181), remap so 1=View, 2=Edit, 3=Split:

```ts
          case "1":
            e.preventDefault();
            setMode("preview");
            break;
          case "2":
            e.preventDefault();
            setMode("edit");
            break;
          case "3":
            e.preventDefault();
            setMode("split");
            break;
```

- [ ] **Step 2: Update the native View menu to match**

In `electron/main.js`, replace the three mode items in the View menu template:

```js
      {
        label: "Edit Mode",
        accelerator: "CmdOrCtrl+1",
        click: () => mainWindow?.webContents.send("set-mode", "edit"),
      },
      {
        label: "Split Mode",
        accelerator: "CmdOrCtrl+2",
        click: () => mainWindow?.webContents.send("set-mode", "split"),
      },
      {
        label: "Preview Mode",
        accelerator: "CmdOrCtrl+3",
        click: () => mainWindow?.webContents.send("set-mode", "preview"),
      },
```

with:

```js
      {
        label: "View",
        accelerator: "CmdOrCtrl+1",
        click: () => mainWindow?.webContents.send("set-mode", "preview"),
      },
      {
        label: "Edit",
        accelerator: "CmdOrCtrl+2",
        click: () => mainWindow?.webContents.send("set-mode", "edit"),
      },
      {
        label: "Split",
        accelerator: "CmdOrCtrl+3",
        click: () => mainWindow?.webContents.send("set-mode", "split"),
      },
```

- [ ] **Step 3: Redesign the toolbar mode switcher**

In `src/components/toolbar.tsx`, replace the center mode toggle block (lines 102-120):

```tsx
      {/* Center: Mode toggle */}
      <div
        className="flex items-center bg-background rounded-md p-0.5 gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {(["edit", "split", "preview"] as ViewMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            className={`px-3 py-1 text-[11px] font-medium rounded transition-all ${
              mode === m
                ? "bg-accent text-foreground"
                : "text-muted hover:text-foreground"
            }`}
          >
            {m === "edit" ? "Edit" : m === "split" ? "Split" : "Preview"}
          </button>
        ))}
      </div>
```

with a labeled View button plus two icon buttons:

```tsx
      {/* Center: Mode toggle — View is primary, Edit/Split are icons */}
      <div
        className="flex items-center bg-background rounded-md p-0.5 gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          onClick={() => onModeChange("preview")}
          title="View (⌘1)"
          className={`px-3 py-1 text-[11px] font-medium rounded transition-all ${
            mode === "preview"
              ? "bg-accent text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          View
        </button>
        <button
          onClick={() => onModeChange("edit")}
          title="Edit (⌘2)"
          aria-label="Edit mode"
          className={`px-2 py-1 rounded transition-all ${
            mode === "edit"
              ? "bg-accent text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        </button>
        <button
          onClick={() => onModeChange("split")}
          title="Split (⌘3)"
          aria-label="Split mode"
          className={`px-2 py-1 rounded transition-all ${
            mode === "split"
              ? "bg-accent text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="12" y1="3" x2="12" y2="21" />
          </svg>
        </button>
      </div>
```

- [ ] **Step 4: Verify**

Run: `npm run electron:dev`
Expected: app opens in View (rendered preview) by default. Cmd+1/2/3 = View/Edit/Split, matching the View menu. Center switcher shows "View" + pencil + columns icons with hover tooltips. Quit.

- [ ] **Step 5: Commit**

```bash
git add src/app/page.tsx src/components/toolbar.tsx electron/main.js
git commit -m "feat: View-first mode — preview default, Edit/Split as icons"
```

---

### Task 5: Clear the macOS traffic lights

With `titleBarStyle: "hiddenInset"` and `trafficLightPosition: { x: 14, y: 14 }` (`electron/main.js:24-25`), the window buttons occupy roughly the first 70px of the toolbar row, and the toolbar's `px-4` (16px) puts the "Markie" wordmark and filename underneath them.

**Files:**
- Modify: `src/components/toolbar.tsx`

- [ ] **Step 1: Add platform-aware left padding**

In `src/components/toolbar.tsx`, add the import:

```tsx
import { getElectronAPI } from "@/lib/electron";
```

Inside the `Toolbar` component, before the return, add (state + effect so static-export hydration stays consistent):

```tsx
  const [trafficLightPad, setTrafficLightPad] = useState(false);
  useEffect(() => {
    setTrafficLightPad(getElectronAPI()?.platform === "darwin");
  }, []);
```

Change the root div (line 42):

```tsx
    <div className="h-11 border-b border-border bg-surface flex items-center justify-between px-4 select-none shrink-0"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
```
to
```tsx
    <div
      className={`h-11 border-b border-border bg-surface flex items-center justify-between pr-4 select-none shrink-0 ${
        trafficLightPad ? "pl-[84px]" : "pl-4"
      }`}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
```

- [ ] **Step 2: Verify**

Run: `npm run electron:dev`
Expected: "Markie" wordmark and filename start clearly right of the close/minimize/zoom buttons; nothing overlaps at any window width down to minWidth 600. In a regular browser (`npm run dev`, open http://localhost:3000) the padding stays 16px. Quit.

- [ ] **Step 3: Commit**

```bash
git add src/components/toolbar.tsx
git commit -m "fix: toolbar no longer overlaps macOS traffic lights"
```

---

### Task 6: Stats move to the menu bar (with advanced stats panel)

Word/char counts leave the toolbar. A native menu item View → Statistics (Cmd+Shift+I) toggles a floating panel with advanced stats. The stats computation is pure logic — TDD with vitest (new dev dependency, zero-config).

**Files:**
- Create: `src/lib/stats.ts`
- Create: `src/lib/stats.test.ts`
- Create: `src/components/stats-panel.tsx`
- Modify: `package.json` (vitest)
- Modify: `electron/main.js` (menu item)
- Modify: `electron/preload.js`
- Modify: `src/app/page.tsx`
- Modify: `src/components/toolbar.tsx` (remove stats)

- [ ] **Step 1: Install vitest and add the test script**

```bash
npm install -D vitest
```

In `package.json` scripts, add:

```json
    "test": "vitest run",
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/stats.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeStats } from "./stats";

describe("computeStats", () => {
  it("returns all zeros for empty content", () => {
    expect(computeStats("")).toEqual({
      words: 0,
      chars: 0,
      charsNoSpaces: 0,
      lines: 0,
      headings: 0,
      codeBlocks: 0,
      links: 0,
      readingTimeMin: 0,
    });
  });

  it("counts words, chars, and lines", () => {
    const s = computeStats("hello world\nsecond line");
    expect(s.words).toBe(4);
    expect(s.chars).toBe(23);
    expect(s.charsNoSpaces).toBe(20);
    expect(s.lines).toBe(2);
  });

  it("counts markdown structures", () => {
    const md = [
      "# Title",
      "## Sub",
      "a [link](https://x.com) and [two](https://y.com)",
      "```js",
      "code();",
      "```",
    ].join("\n");
    const s = computeStats(md);
    expect(s.headings).toBe(2);
    expect(s.links).toBe(2);
    expect(s.codeBlocks).toBe(1);
  });

  it("reading time is at least 1 minute for any non-empty text", () => {
    expect(computeStats("one two three").readingTimeMin).toBe(1);
  });

  it("reading time scales at 200 wpm", () => {
    const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    expect(computeStats(words).readingTimeMin).toBe(3);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './stats'` (or equivalent resolve error).

- [ ] **Step 4: Implement computeStats**

Create `src/lib/stats.ts`:

```ts
export interface DocStats {
  words: number;
  chars: number;
  charsNoSpaces: number;
  lines: number;
  headings: number;
  codeBlocks: number;
  links: number;
  readingTimeMin: number;
}

export function computeStats(content: string): DocStats {
  const trimmed = content.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  return {
    words,
    chars: content.length,
    charsNoSpaces: content.replace(/\s/g, "").length,
    lines: content === "" ? 0 : content.split("\n").length,
    headings: (content.match(/^#{1,6}\s/gm) ?? []).length,
    codeBlocks: Math.floor((content.match(/^```/gm) ?? []).length / 2),
    links: (content.match(/\[[^\]]*\]\([^)]+\)/g) ?? []).length,
    readingTimeMin: words === 0 ? 0 : Math.max(1, Math.round(words / 200)),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: 5 passed.

- [ ] **Step 6: Build the stats panel component**

Create `src/components/stats-panel.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { computeStats } from "@/lib/stats";

interface StatsPanelProps {
  content: string;
  onClose: () => void;
}

export function StatsPanel({ content, onClose }: StatsPanelProps) {
  const stats = computeStats(content);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows: Array<[string, string]> = [
    ["Words", stats.words.toLocaleString()],
    ["Characters", stats.chars.toLocaleString()],
    ["Characters (no spaces)", stats.charsNoSpaces.toLocaleString()],
    ["Lines", stats.lines.toLocaleString()],
    ["Headings", stats.headings.toLocaleString()],
    ["Code blocks", stats.codeBlocks.toLocaleString()],
    ["Links", stats.links.toLocaleString()],
    ["Reading time", stats.readingTimeMin ? `${stats.readingTimeMin} min` : "—"],
  ];

  return (
    <div className="absolute top-12 right-4 z-50 w-60 bg-surface-2 border border-border rounded-lg shadow-xl py-2"
      style={{ background: "#1c1c20" }}
    >
      <div className="flex items-center justify-between px-3 pb-1.5 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Statistics
        </span>
        <button
          onClick={onClose}
          aria-label="Close statistics"
          className="text-muted hover:text-foreground text-[13px] leading-none"
        >
          ×
        </button>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between px-3 py-1">
          <span className="text-[12px] text-muted">{label}</span>
          <span className="text-[12px] text-foreground tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Menu item + preload + renderer wiring**

In `electron/main.js`, in the View menu template, add after the Split item (before the first `{ type: "separator" }`):

```js
      { type: "separator" },
      {
        label: "Statistics",
        accelerator: "CmdOrCtrl+Shift+I",
        click: () => mainWindow?.webContents.send("toggle-stats"),
      },
```

In `electron/preload.js`, add:

```js
  onToggleStats: (callback) =>
    ipcRenderer.on("toggle-stats", () => callback()),
```

In `src/app/page.tsx`:

Add the import:

```ts
import { StatsPanel } from "@/components/stats-panel";
```

Add state next to the other useState calls:

```ts
  const [showStats, setShowStats] = useState(false);
```

In the register-once IPC effect (Task 2), add:

```ts
    api.onToggleStats?.(() => setShowStats((s) => !s));
```

In the JSX, render the panel inside the root div, after the mode panes `<div className="flex-1 ...">` block:

```tsx
      {showStats && (
        <StatsPanel content={content} onClose={() => setShowStats(false)} />
      )}
```

The root div needs `relative` for the absolute panel — change:

```tsx
    <div className="h-screen flex flex-col bg-background">
```
to
```tsx
    <div className="h-screen flex flex-col bg-background relative">
```

- [ ] **Step 8: Remove stats from the toolbar**

In `src/components/toolbar.tsx`, delete the right stats block:

```tsx
      {/* Right: Stats */}
      <div className="flex items-center gap-3 text-[11px] text-muted tabular-nums">
        <span>{wordCount} words</span>
        <span>{charCount} chars</span>
      </div>
```

Remove `charCount` and `wordCount` from `ToolbarProps` and the destructured props. In `src/app/page.tsx`, remove the `charCount={charCount}` and `wordCount={wordCount}` props from `<Toolbar />` and delete the now-unused `wordCount`/`charCount` computations (lines 64-67).

With the right-side stats gone, `justify-between` now has two children (left group + mode switcher), which pushes the switcher to the far right. Add an empty right spacer to keep the switcher visually centered:

```tsx
      {/* Right: spacer (stats moved to the menu bar) */}
      <div className="w-24" aria-hidden="true" />
```

- [ ] **Step 9: Verify**

Run: `npm test` → all pass. `npm run lint` → clean.
Run: `npm run electron:dev`
Expected: no word/char counts in the toolbar. View → Statistics (Cmd+Shift+I) toggles the panel; values change as you type in Edit mode; Esc closes it. Quit.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/lib/stats.ts src/lib/stats.test.ts src/components/stats-panel.tsx electron/main.js electron/preload.js src/app/page.tsx src/components/toolbar.tsx
git commit -m "feat: move stats to menu bar with advanced statistics panel"
```

---

### Task 7: File lifecycle — Save, Save As, Rename, Fork, Export

Adds real file writing. The renderer starts tracking `filePath` and dirty state (`content !== savedContent`, shown as a dot next to the filename). Fork = "Duplicate": saves a copy (default `<name> copy.md`) and switches to it. Rename is inline in the toolbar. Export submenu: PDF Dark, PDF Light, HTML.

**Files:**
- Modify: `electron/main.js` (IPC handlers + File menu)
- Modify: `electron/preload.js`
- Modify: `src/app/page.tsx`
- Modify: `src/components/toolbar.tsx`

- [ ] **Step 1: Add write IPC handlers in main**

In `electron/main.js`, next to the other handlers, add:

```js
// IPC: write content to a known path
ipcMain.handle("save-file", async (_event, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, "utf-8");
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: write content to a user-chosen path (Save As / Fork)
ipcMain.handle("save-file-as", async (_event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || "untitled.md",
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx"] },
      { name: "Text", extensions: ["txt"] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }
  try {
    fs.writeFileSync(result.filePath, content, "utf-8");
    return {
      success: true,
      path: result.filePath,
      name: path.basename(result.filePath),
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: rename the file on disk, same directory
ipcMain.handle("rename-file", async (_event, { oldPath, newName }) => {
  try {
    const newPath = path.join(path.dirname(oldPath), newName);
    if (fs.existsSync(newPath)) {
      return { success: false, error: "A file with that name already exists" };
    }
    fs.renameSync(oldPath, newPath);
    return { success: true, path: newPath, name: newName };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: export rendered HTML to a file
ipcMain.handle("export-html", async (_event, { defaultName, html }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || "document.html",
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }
  try {
    fs.writeFileSync(result.filePath, html, "utf-8");
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});
```

- [ ] **Step 2: Rebuild the File menu**

In `electron/main.js`, replace the File submenu:

```js
  {
    label: "File",
    submenu: [
      {
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        click: () => {
          mainWindow?.webContents.send("menu-open-file");
        },
      },
      { type: "separator" },
      {
        label: "Export PDF…",
        accelerator: "CmdOrCtrl+Shift+E",
        click: () => {
          mainWindow?.webContents.send("menu-export-pdf");
        },
      },
      { type: "separator" },
      { role: "close" },
    ],
  },
```

with:

```js
  {
    label: "File",
    submenu: [
      {
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        click: () => mainWindow?.webContents.send("menu-open-file"),
      },
      { type: "separator" },
      {
        label: "Save",
        accelerator: "CmdOrCtrl+S",
        click: () => mainWindow?.webContents.send("menu-save"),
      },
      {
        label: "Save As…",
        accelerator: "CmdOrCtrl+Shift+S",
        click: () => mainWindow?.webContents.send("menu-save-as"),
      },
      {
        label: "Duplicate (Fork)",
        accelerator: "CmdOrCtrl+Shift+D",
        click: () => mainWindow?.webContents.send("menu-fork"),
      },
      { type: "separator" },
      {
        label: "Export",
        submenu: [
          {
            label: "PDF (Dark)…",
            accelerator: "CmdOrCtrl+Shift+E",
            click: () => mainWindow?.webContents.send("menu-export-pdf", "dark"),
          },
          {
            label: "PDF (Light)…",
            click: () => mainWindow?.webContents.send("menu-export-pdf", "light"),
          },
          {
            label: "HTML…",
            click: () => mainWindow?.webContents.send("menu-export-html"),
          },
        ],
      },
      { type: "separator" },
      { role: "close" },
    ],
  },
```

- [ ] **Step 3: Extend preload**

In `electron/preload.js`, add:

```js
  saveFile: (args) => ipcRenderer.invoke("save-file", args),
  saveFileAs: (args) => ipcRenderer.invoke("save-file-as", args),
  renameFile: (args) => ipcRenderer.invoke("rename-file", args),
  exportHTML: (args) => ipcRenderer.invoke("export-html", args),
  onMenuSave: (callback) => ipcRenderer.on("menu-save", () => callback()),
  onMenuSaveAs: (callback) => ipcRenderer.on("menu-save-as", () => callback()),
  onMenuFork: (callback) => ipcRenderer.on("menu-fork", () => callback()),
  onMenuExportHTML: (callback) =>
    ipcRenderer.on("menu-export-html", () => callback()),
```

and change the existing PDF listener to pass the theme through:

```js
  onMenuExportPDF: (callback) =>
    ipcRenderer.on("menu-export-pdf", (_event, theme) => callback(theme)),
```

- [ ] **Step 4: Renderer state + handlers**

In `src/app/page.tsx`:

Add state next to `fileName`:

```ts
  const [filePath, setFilePath] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string>(SAMPLE);
  const isDirty = content !== savedContent;
```

Everywhere a file is loaded, also set `filePath` and `savedContent`. Update:

`handleOpenFile` Electron branch:

```ts
      api.openFile().then((result) => {
        if (result) {
          setContent(result.content);
          setFileName(result.name);
          setFilePath(result.path);
          setSavedContent(result.content);
        }
      });
```

The web-fallback `input.onchange` and the drag-drop `handleDrop` (no real path available outside Electron):

```ts
      setContent(text);
      setFileName(file.name);
      setFilePath(null);
      setSavedContent(text);
```

The `fileOpened` handler in `handlersRef` (Task 2) and the `getInitialFile` mount effect (Task 3):

```ts
    fileOpened: (data: FilePayload) => {
      setContent(data.content);
      setFileName(data.name);
      setFilePath(data.path);
      setSavedContent(data.content);
    },
```

```ts
      if (file) {
        setContent(file.content);
        setFileName(file.name);
        setFilePath(file.path);
        setSavedContent(file.content);
      }
```

Add the lifecycle handlers after `handleExportPDF`:

```ts
  const handleSaveAs = useCallback(async (defaultName?: string) => {
    const api = getElectronAPI();
    if (!api) return;
    const res = await api.saveFileAs({
      defaultName: defaultName ?? fileName ?? "untitled.md",
      content,
    });
    if (res.success && res.path && res.name) {
      setFilePath(res.path);
      setFileName(res.name);
      setSavedContent(content);
    }
  }, [fileName, content]);

  const handleSave = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    if (!filePath) {
      await handleSaveAs();
      return;
    }
    const res = await api.saveFile({ filePath, content });
    if (res.success) setSavedContent(content);
  }, [filePath, content, handleSaveAs]);

  const handleFork = useCallback(async () => {
    const base = fileName ?? "untitled.md";
    const forkName = base.includes(".")
      ? base.replace(/(\.[^.]+)$/, " copy$1")
      : `${base} copy`;
    await handleSaveAs(forkName);
  }, [fileName, handleSaveAs]);

  const handleExportHTML = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    const html = buildPDFHTML(getPreviewHTML(), "light");
    const base = (fileName ?? "document").replace(/\.[^.]+$/, "");
    await api.exportHTML({ defaultName: `${base}.html`, html });
  }, [fileName, getPreviewHTML]);

  const handleRename = useCallback(async (newName: string) => {
    const api = getElectronAPI();
    if (!api || !filePath || !newName.trim()) return;
    const res = await api.renameFile({ oldPath: filePath, newName: newName.trim() });
    if (res.success && res.path && res.name) {
      setFilePath(res.path);
      setFileName(res.name);
    }
  }, [filePath]);
```

Extend `handlersRef` with the new handlers — the initial object from Task 2 must declare the new keys too, or TypeScript rejects the reassignments. Replace the whole `handlersRef` block from Task 2 with:

```ts
  // Latest handlers, readable from once-registered IPC listeners
  const handlersRef = useRef({
    openFile: handleOpenFile,
    exportPDF: handleExportPDF,
    save: handleSave,
    saveAs: handleSaveAs,
    fork: handleFork,
    exportHTML: handleExportHTML,
    fileOpened: (data: FilePayload) => {
      setContent(data.content);
      setFileName(data.name);
      setFilePath(data.path);
      setSavedContent(data.content);
    },
  });
  handlersRef.current.openFile = handleOpenFile;
  handlersRef.current.exportPDF = handleExportPDF;
  handlersRef.current.save = handleSave;
  handlersRef.current.saveAs = handleSaveAs;
  handlersRef.current.fork = handleFork;
  handlersRef.current.exportHTML = handleExportHTML;
```

(`fileOpened` is stable — it only calls state setters — so it needs no per-render reassignment. The handler definitions must therefore appear above this block in the file.)

and register once in the IPC effect:

```ts
    api.onMenuSave?.(() => handlersRef.current.save());
    api.onMenuSaveAs?.(() => handlersRef.current.saveAs());
    api.onMenuFork?.(() => handlersRef.current.fork());
    api.onMenuExportHTML?.(() => handlersRef.current.exportHTML());
```

Add `"s"` handling to the renderer keydown switch (covers the web build; in Electron the menu accelerator fires first):

```ts
          case "s":
            e.preventDefault();
            if (e.shiftKey) {
              handleSaveAs();
            } else {
              handleSave();
            }
            break;
```

(and add `handleSave, handleSaveAs` to that effect's dependency array).

Set the document title to track file + dirty state:

```ts
  useEffect(() => {
    document.title = fileName
      ? `${isDirty ? "• " : ""}${fileName} — Markie`
      : "Markie";
  }, [fileName, isDirty]);
```

Pass new props to the toolbar:

```tsx
      <Toolbar
        mode={mode}
        onModeChange={setMode}
        onOpenFile={handleOpenFile}
        onExportPDF={handleExportPDF}
        fileName={fileName}
        isDirty={isDirty}
        canRename={filePath !== null}
        onRename={handleRename}
      />
```

- [ ] **Step 5: Toolbar — dirty dot + inline rename**

In `src/components/toolbar.tsx`, update the props interface (charCount/wordCount were removed in Task 6):

```tsx
interface ToolbarProps {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onOpenFile: () => void;
  onExportPDF: (theme: PDFTheme) => void;
  fileName: string | null;
  isDirty: boolean;
  canRename: boolean;
  onRename: (newName: string) => void;
}
```

Replace the filename button (the `onClick={onOpenFile}` button showing `{fileName || "Open file…"}`) with an open button plus a separate filename element supporting inline rename:

```tsx
        <button
          onClick={onOpenFile}
          className="text-[12px] text-muted hover:text-foreground transition-colors flex items-center gap-1.5"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          {fileName ? "Open" : "Open file…"}
        </button>
        {fileName && (
          renaming ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRename(draftName);
                  setRenaming(false);
                } else if (e.key === "Escape") {
                  setRenaming(false);
                }
              }}
              className="text-[12px] bg-background border border-border rounded px-1.5 py-0.5 w-44 text-foreground outline-none"
            />
          ) : (
            <button
              onClick={() => {
                if (!canRename) return;
                setDraftName(fileName);
                setRenaming(true);
              }}
              title={canRename ? "Click to rename" : undefined}
              className="text-[12px] text-foreground/80 hover:text-foreground transition-colors"
            >
              {fileName}
              {isDirty && <span className="text-muted ml-1.5">•</span>}
            </button>
          )
        )}
```

with the supporting state at the top of the component:

```tsx
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
```

- [ ] **Step 6: Verify the full lifecycle**

Run: `npm run lint` → clean. Then `npm run electron:dev` and walk through:

1. Open `/tmp/markie-warm.md` (Cmd+O). Type a character in Edit mode → dot appears next to the filename and in the title bar.
2. Cmd+S → dot disappears. `cat /tmp/markie-warm.md` in a terminal shows the edit.
3. Cmd+Shift+S → save dialog defaults to the current name; save to `/tmp/markie-saveas.md` → toolbar now shows the new name, edits target the new file.
4. File → Duplicate (Cmd+Shift+D) → dialog defaults to `markie-saveas copy.md`; saving switches to the copy.
5. Click the filename → inline input; rename to `renamed.md`, Enter → `ls /tmp` shows the rename on disk.
6. File → Export → HTML… → saved file opens in a browser with rendered styling.
7. File → Export → PDF (Dark)… and PDF (Light)… both still work.

Quit the app.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test` → all pass.

```bash
git add electron/main.js electron/preload.js src/app/page.tsx src/components/toolbar.tsx
git commit -m "feat: save, save as, rename, fork, and export menu with dirty tracking"
```

---

### Task 8: Final verification pass

- [ ] **Step 1: Full packaged-app smoke test**

```bash
npm test && npm run lint
npm run electron:pack
echo "# Final check" > /tmp/markie-final.md
open -a "$(pwd)/dist/mac-arm64/Markie.app" /tmp/markie-final.md
```

Expected, in order:
1. App cold-starts directly into `# Final check`, rendered, in View mode.
2. Toolbar reads Markie, no traffic-light overlap, no stats in toolbar.
3. Cmd+1/2/3 switch View/Edit/Split; Cmd+Shift+I shows statistics.
4. Edit → dirty dot → Cmd+S persists.

- [ ] **Step 2: Commit any final fixes, then update the roadmap**

Mark Phase 0 and Phase 1 complete in `docs/superpowers/plans/2026-06-11-markie-roadmap.md`.

```bash
git add -A
git commit -m "chore: phase 1 complete — Markie local polish"
```
