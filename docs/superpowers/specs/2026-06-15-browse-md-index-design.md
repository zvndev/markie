# Markie Browse — device-wide markdown index

_Date: 2026-06-15 · Status: approved, ready for implementation plan_

## Goal

A new **Browse** tab in the Library that surfaces every markdown file on the
device that the user actually cares about — their notes, skills, and project
docs — so they can jump straight to an existing `.md` and edit it (e.g. Claude
skills in `~/.claude/skills`). It is for _discovery and quick-open_, distinct
from the manual-root **Files** finder tree.

## Why Spotlight is not the engine

`mdfind` is near-instant but **blind to dot-directories**: it returns 0 results
for `~/.claude` while there are 2,688 real `.md` files there. Since editing
skills (which live in `~/.claude/skills`) is the headline use case, Browse uses
a real Node directory walk instead.

## Scan engine

`electron/mdindex.js` (new, main process). Async recursive walk from
`os.homedir()` using `fs.promises.readdir(dir, { withFileTypes: true })`,
pruning excluded directories **before** descending. Measured ~0.5s over a full
home directory (≈4,000 files, ≈1,570 folders) — light enough to run often.

Each result row: `{ path, name, dir, mtimeMs }`.

### Exclusions (the core of the feature)

Pruned at the directory level, before descending:

1. **Every dot-directory** — any directory whose name starts with `.`
   (`.git`, `.next`, `.venv`, `.bun`, `.cargo`, `.rustup`, `.scion`, `.design`,
   `.claude/sessions`, `.claude/plugins`, …). This single rule removes the bulk
   of generated/vendored noise and is what makes the walk fast.
2. **Non-dot vendored / build dirs** by exact name: `node_modules`, `Library`,
   `vendor`, `bower_components`, `dist`, `build`, `out`, `target`, `Pods`,
   `venv`, `site-packages`, `DerivedData`, and the path `*/go/pkg`.

`node_modules` is a hard exclusion — never indexed.

### Allowlist re-include

Because rule (1) excludes all dot-dirs, the user's own skills would be hidden.
So `~/.claude/skills` is explicitly re-included: when the walk would prune a
directory, it first checks whether that directory is (or contains, on the path
to) an allowlisted root and descends if so. The allowlist is a single constant
(`[ '~/.claude/skills' ]`) — making it user-editable is a later nicety (YAGNI).

The exclusion name-set and the allowlist live as exported constants in
`mdindex.js` so they are unit-testable in isolation.

## Sync cadence ("often, but not heavy")

- **On first open** of the Browse tab: serve the persisted snapshot instantly
  (see caching), then kick a fresh background walk.
- **Manual Refresh** button in the Browse header.
- **On window focus**: re-scan, debounced to at most once per 20s.
- **No tight interval timer** — avoids constant disk churn.

A walk runs asynchronously in the main process and never blocks the UI. When a
background walk finishes and the result differs, the main process emits
`mdindex-updated` to the renderer.

### Caching

- In-memory: the latest scan result is held in `mdindex.js`.
- Persisted: a compact snapshot (path, name, mtimeMs) is written to
  `registry.db` (new table `md_index_cache`) after each successful scan, so the
  first paint on app start is instant while a fresh walk runs.

## Stars

New table in `registry.db`:

```
CREATE TABLE IF NOT EXISTS md_stars (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'folder' | 'file'
  added_at TEXT NOT NULL
);
```

Both folders and files can be starred. "★ Starred only" filters the view to
starred folders (and their files) plus starred loose files.

## IPC surface (preload `electronAPI`)

- `mdIndexScan()` → `{ files: Row[], scannedAt: string }` — returns cached
  immediately and triggers a background refresh if stale.
- `mdIndexRefresh()` → forces a fresh walk, resolves with the new result.
- `mdIndexStars()` → `{ path, kind }[]`.
- `mdIndexToggleStar({ path, kind })` → `{ starred: boolean }`.
- `onMdIndexUpdated(cb)` — subscribe to background-scan completion.

All guarded so the web/dev build (no `electronAPI`) degrades to an empty,
inert Browse tab.

## UI

A 4th Library view, **"Browse"**, alongside Recent · Files · Shared. New
component `src/components/browse-view.tsx`, mounted from `library.tsx` (extend
the `LibView` union and the tab row; the existing `onOpenPath` wiring opens
files).

**Header controls:**
- Filter input — substring match on file name and path.
- View mode: **Folders** ⇄ **All files**.
- Toggle **★ Starred only**.
- Toggle **Full path** — show `~/abs/path` vs a short relative label.
- **Refresh** button + a subtle "scanned Xs ago" indicator.

**Folders view (default):** one row per folder that contains MDs, collapsed,
showing the folder label and an MD count badge and a star toggle. Expanding a
folder lazily renders its files (name + click-to-open + star). Only folders
containing MDs appear.

**All files view:** flat list, newest (mtime) first, each row showing the file
name with its folder path in small muted text beneath. Star toggle per row.

**Persistence:** view mode, starred-only, and full-path toggles persist in
`localStorage` (same pattern as the existing `markie.libview.v1` key).

**Performance:** folders are collapsed by default, so only ~1,570 header rows
render; files render on expand. The flat All-files view caps the rendered count
(e.g. first 300) and relies on the filter to narrow — simple windowing, no new
dependency.

## Testing

- `mdindex` exclusion logic: unit-test `isExcludedDir(name)` and the allowlist
  re-include against representative paths (node_modules, `.git`, `.scion`,
  `.claude/sessions` excluded; `.claude/skills` included; normal dirs kept).
- Stars: round-trip toggle/list against a temp `registry.db`.
- The walk itself is integration-tested against a small temp fixture tree
  (assert it finds the fixtures' `.md`, skips an excluded subdir, descends the
  allowlisted one).

## Out of scope (later)

- User-editable exclusion list / additional allowlist roots from settings.
- `fs.watch`-based live updates (current cadence is poll-on-focus + manual).
- Full-text search inside files (this is name/path discovery only).
- Non-macOS support.
