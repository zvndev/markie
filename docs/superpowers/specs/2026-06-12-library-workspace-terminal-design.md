# Library workspace, organization, quick actions & terminal — design

Date: 2026-06-12
Status: Draft for review
Owner: Kirby (ZVN)
Companion spec: `2026-06-12-account-optional-sharing-design.md` (the "Shared"
view + invite list live there; this spec covers the rest of the Library).

## Problem / vision

The current Library is really a **Recent** list. Kirby wants the Library to also
tell the truth about **where files live on disk** and let him **organize** them
(create folders, move files), plus fast utilities (copy a file's path for
terminal/coding, copy a file's contents), drag-anywhere-to-open, and an
integrated **tabbed terminal** so he can code alongside his markdown — using
whatever terminal apps exist on the machine.

Cloud stays optional throughout: the workspace is just folders on the Mac; sync
is layered per-file on top.

## The Library becomes multi-view

A small view switcher at the top of the Library panel:

**`Recent` · `Files` · `Shared`**

- **Recent** — today's Library: flat, recency-ordered, everything you've touched
  (local + cloud-only + shared), with sync/badge info. "Get me back to what I
  was doing."
- **Files** — a real folder tree of your **workspace** (see below). Organize:
  new folder, new file, move (drag), rename, delete→Trash, reveal in Finder.
- **Shared** — the invite list (defined in the sharing spec).

The view choice persists. Activity-bar Library icon still toggles the panel.

## Files view = Workspace model

Markie gets a **workspace**: one or more real folders on disk that are your
organized home for markdown.

- **Default root:** `~/Documents/Markie`, created on first use of the Files view.
  Never forced — if absent, Files shows a friendly empty state ("Pick a folder
  to organize your markdown") and Recent still works fully.
- **Multiple roots:** user can add additional folders as roots (e.g. an existing
  `~/notes`). Each root is a top-level collapsible in the tree.
- Roots persisted in the registry DB (new `workspace_roots` table) or a small
  JSON in `userData`. (Use a table for consistency with the registry.)

### Tree + operations (Electron main, real FS)

The tree reads the disk lazily (per-folder `readdir` on expand), showing folders
and openable files (`.md/.markdown/.mdx/.txt/.csv`). Rows join with the registry
by path to show sync/shared badges. Optional `fs.watch` per expanded root to
live-update on external changes (debounced; off by default if noisy).

New IPC (main process), all guarded to stay within known roots:

- `workspace:roots` → list roots; `workspace:addRoot` (dialog) / `removeRoot`.
- `fs:listDir(path)` → `{ folders:[{name,path}], files:[{name,path,ext}] }`.
- `fs:mkdir(parent, name)` → create folder.
- `fs:newFile(parent, name)` → create empty `.md`.
- `fs:move(src, destDir)` → `fs.rename`; if the file is registry-tracked, update
  its `path` (cloud doc id untouched, so sync keeps working).
- `fs:rename(path, newName)` → rename file/folder (recurse path updates in
  registry for contained tracked files).
- `fs:trash(path)` → `shell.trashItem` (macOS Trash; never hard-delete).
- `fs:reveal(path)` → `shell.showItemInFolder`.

### How cloud / shared fit

Cloud-only and shared docs have **no local path**, so they don't appear in the
Files tree until pulled down. They live in Recent / Shared. Pulling a copy down
(existing `docPull`, defaulting the save dialog to a workspace folder) lands them
in the tree, where they show their sync badge. "Add to workspace" on an
outside/Recent local file moves it into a chosen workspace folder.

## Quick actions (per file)

Available from the Library row ⋯ menu, the Files tree context menu, and the
editor toolbar for the open doc:

- **Copy path** ("link to file") — copies the absolute path to the clipboard
  (`navigator.clipboard.writeText`), for pasting into a terminal / coding agent.
  Cloud-only files (no path) hide this.
- **Copy contents** — copies the file's markdown text. For the open doc, copy
  current editor content; for any other file, read it via `openFilePath` then
  copy.
- (Existing) Reveal in Finder, Rename, sync actions.

## Drag-anywhere-to-open

Today a window-level drop reads `file.text()` with `path: null` (untracked).
Improve: the global drop handler resolves the real path via
`webUtils.getPathForFile` (already exposed as `pathForFile`) and loads with the
true path so it tracks in the registry and can be organized. Dropping multiple
files opens the last and tracks the rest (same as Library drop). The drop zone
is the whole window (already wired) — just upgrade path resolution. Non-openable
files are ignored.

## Integrated terminal (tabbed) + external launcher

Two complementary capabilities. (You can't embed Ghostty/iTerm2/Terminal — they
are standalone GUI apps — so the in-app terminal runs your shell directly, and
we add a launcher into the external app of your choice.)

### A) Built-in tabbed terminal

- A bottom (or right) dock panel toggled from the activity bar / `⌃\``.
- **Renderer:** `@xterm/xterm` + `@xterm/addon-fit` for rendering/resize.
- **Main:** `node-pty` spawns the user's login shell (`$SHELL`, e.g. `zsh`) with
  a PTY; data piped both ways over IPC. (Native module — add to the
  `@electron/rebuild` set alongside `better-sqlite3`.)
- **Tabs:** multiple PTY sessions; each tab = one pty. New/close/switch tab.
  cwd defaults to the open file's folder, else the workspace root.
- **Lifecycle:** kill all PTYs on window close / app quit (no orphaned shells);
  resize PTY on panel/tab resize; cap scrollback.
- **Security:** PTYs run with the user's own shell + env; no remote input. Keep
  it local-only.

### B) "Open in…" external terminal

- Detect installed terminal apps by bundle id / `/Applications` presence:
  Ghostty (`com.mitchellh.ghostty`), iTerm2 (`com.googlecode.iterm2`), Terminal
  (`com.apple.Terminal`), Warp (`dev.warp.Warp-Stable`), others if found.
- A menu "Open folder in →" lists the detected apps; launches via
  `open -a "<App>" "<dir>"` (or the app's CLI when available, e.g. `ghostty`).
- Default target dir = current file's folder or selected Files-tree folder.

## Phasing / build order ("everything together," sequenced to avoid rework)

The Library and activity bar are touched by several features, so build the shell
once, then fill views.

1. **Quick wins (now):** Copy path, Copy contents, drag-anywhere-to-open with
   real path. Low risk, immediately useful, no new deps.
2. **Sharing Phase 1 backend** (from sharing spec): pending invites, invite-any-
   email, auto-claim, emails. Independent of Library UI.
3. **Multi-view Library shell:** `Recent · Files · Shared` switcher; move current
   list under Recent; wire the Shared invite list (sharing spec) + viewer
   default.
4. **Files view + workspace:** roots (default `~/Documents/Markie`), tree,
   FS ops (mkdir/newFile/move/rename/trash/reveal), drag-to-move, badges,
   "Add to workspace".
5. **Integrated terminal:** xterm + node-pty tabbed panel + external "Open in…"
   launcher.
6. **Sharing Phase 2** (needs domain + Markie-fw): public `/s/:token` preview +
   download.

## Error handling

- FS ops guarded to stay within known workspace roots; reject path traversal.
- Move/rename onto an existing name → conflict error surfaced inline.
- Delete = Trash (recoverable). Never hard-delete user files.
- Terminal: if `node-pty` fails to load, the in-app terminal degrades to the
  external launcher with a clear message.
- Copy actions: clipboard failures surface a small toast; cloud-only files hide
  Copy path.

## Testing

- FS ops: mkdir/newFile/move/rename/trash within a temp root; registry path
  updates on move/rename; traversal attempts rejected.
- Quick actions: copy path/content for local + open doc; cloud-only hides path.
- Drag-anywhere: dropped file resolves real path + tracks.
- Terminal: pty spawns, echoes, resizes, and is killed on window close; tab
  open/close lifecycle; external app detection returns installed apps only.

## Open decisions

- **OD-A — Terminal dock position:** bottom panel (IDE-style) vs right panel.
  Recommend bottom.
- **OD-B — `fs.watch` live updates:** on by default (nice, slightly noisy) vs
  manual refresh. Recommend on, debounced.
