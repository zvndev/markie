# Markie 0.5.0 "Organized Workspace" Design

Date: 2026-08-26
Status: Draft for human review. Two sections require explicit sign-off before
implementation: the SQLite schema (Section 4.6) and the MCP surface additions
(Section 6.4). Both are CONSTITUTION human checkpoints.
Companion plan: `docs/superpowers/plans/2026-08-26-organized-workspace-plan.md`

Baseline verified on branch `feat/organized-workspace-0.5.0` at 0.4.2:
vitest 98 files / 1,175 tests green (3.4s), plus 148 server cases and 24 MCP
cases per CI. Everything in this design must keep that green at every step.

---

## 1. Release overview

0.5.0 ships four workstreams:

- **A. Virtual project/block organization** (headline): a purely organizational
  layer over the files Markie already indexes. Projects contain blocks of work,
  blocks contain files. Nothing moves on disk.
- **B. Save, drafts, and internal file history**: fixes a verified P0 (unsaved
  edits silently discarded on file switch, New File, close, quit) with
  Google-Docs-style debounced autosave, a crash-safe draft journal, and
  per-document version history. Blocked by a rich-editor round-trip fix.
- **C. Share-takeover fix (server, CRITICAL)**: require email verification so
  registering someone else's address can no longer inherit their pending
  shares. Plus better-auth and hono security upgrades.
- **D. Windows auto-update**: the signed Windows build exists and is served
  publicly, but `electron/update-policy.js` refuses to update anything that is
  not darwin. Implement the Windows update path end to end (code and docs; no
  publishing).

Cross-cutting: the MCP server and the Claude Code plugin teach agents how to
use Markie and how to organize (declare `project` and `block` in front matter),
and two known MCP drift bugs are fixed via a shared module.

Sequencing (hard dependency first):

1. Rich-mode round-trip integrity (blocks autosave; nothing else may enable
   autosave before this lands).
2. Save, drafts, history (B).
3. Organization engine, then Files tab, then full-width Projects view (A).
4. MCP instructions and shared-module fixes.
5. C and D are independent and can run in parallel at any point.

---

## 2. Current state, verified in code

Facts this design builds on, checked against the tree on 2026-08-26:

- `src/app/page.tsx` is 1,899 lines. `isDirty` is derived at line 257
  (`content !== savedContent`) and drives only the window-title dot
  (lines 972-976). `handleNewFile` (578-586) and `loadFile` (594-620) reset the
  buffer unconditionally with no flush. There is no `beforeunload` anywhere in
  `src/` or `electron/`; `electron/main.js` has `mainWindow.on("closed")`
  (682, cleanup only) and `before-quit` (2179, stops the file watcher only).
  Nothing saves or preserves a dirty buffer on any exit path.
- The rich editor debounces serialization 250ms (`rich-view.tsx:249-255`) and
  the open path is guarded with `emitUpdate: false` (451-461), but the first
  real edit serializes the whole document and `page.tsx` writes that
  serialization to disk on save (818-820). The extension list at
  `rich-view.tsx:208-241` is inline in the component; there is no round-trip
  test anywhere in the repo.
- `electron/snapshots.js` writes a pre-save copy of the previous disk content
  to `userData/snapshots/<hash8>-<basename>/<timestamp>.md`, capped at 20 per
  file and 200MB total, with `revertToSnapshot` wired to a File menu item in
  `main.js` (1814+).
- External-modification detection: `main.js` keeps a 500-entry hash LRU
  (`lastSeenOnDisk`, 444-475), polls the open file via `fs.watchFile` at 1s
  (499-523), and `save-file` (835-877) shows a native three-button dialog when
  the disk changed since last seen, unless `force` is passed.
  `src/components/disk-change.tsx` renders the in-app strip and conflict
  dialog.
- The Library panel (`library.tsx`) has a Recent/Files sub-toggle stored under
  `TAB_KEY = "markie.libtab.v1"` (line 55) defaulting to `recent` (159-165).
  The Files tab renders `files-view.tsx`, a literal workspace-roots tree
  backed by `electron/workspace.js` with real disk operations (mkdir, new
  file, rename, move, trash).
- The device index is `electron/mdindex.js`: budgeted walk
  (`DEFAULT_BUDGET = { maxFiles: 200000, maxMs: 30000, maxDepth: 24 }`),
  persisted snapshot in the `md_index_cache` SQLite table
  (`registry.js:91-95`), fingerprint-skipped rewrites
  (`indexCacheFingerprint`, 275-280). Rows carry `{ path, name, dir,
  mtimeMs }` only; no creation time, no content-derived metadata.
- `electron/registry.js` has no schema-version mechanism. The only migration
  is a PRAGMA-guarded `ALTER TABLE files ADD COLUMN share_role` (105-108).
- `src/lib/left-rail.ts` (66 lines, pure, fully tested):
  `PanelView = "library" | "browse" | "shared" | "skills"`,
  `LeftView = PanelView | "edit"`. Every `LeftView` today is either a side
  panel or the formatting rail; nothing occupies the document area.
- `server/src/auth.ts:37-39` enables `emailAndPassword` with no
  `requireEmailVerification`. The `user.create.after` hook (40-54) calls
  `claimPendingInvites` unconditionally. `server/src/docs.ts:60-65` claims
  again on every doc listing. `server/src/doc-view.ts:84` grants read access
  by pending-invite token possession. better-auth is `^1.6.16`
  (GHSA-qq9h-g4jm-xgf3, fixed in 1.6.22); hono is `^4.12.25`.
- `electron/update-policy.js:24-32` returns `supported: false` for every
  platform except darwin. `server/download-manifest.json` marks `windows-x64`
  `status: "public"` with feed `windows/latest.yml`, and
  `electron-builder.config.cjs` already derives a Windows publish path from
  it. `README.md:27-38` says Windows is not published;
  `docs/RELEASING.md` (artifact matrix around line 96, and the Windows
  release gate section at 297-310) says Windows is private until signing is
  configured. These three sources contradict each other; the manifest plus
  the signed 0.4.2 exe served from `/download` are the current truth.
- `mcp/markie-mcp.mjs` returns `capabilities` and `serverInfo` in the
  initialize result (178-187) with no `instructions` field.
  `mcp/lib.mjs:136-144` `classifyAgentFile` lacks the `isCachedAgentPath`
  filter that `src/lib/agent-files.ts:79-96` applies, so `markie_list_skills`
  returns plugin-cache noise the app hides. `mcp/scan.mjs` re-implements the
  walk with no budget at all (73-99).
- `electron/ipc-contract.test.ts` asserts channel parity across `main.js`,
  `preload.js`, and `src/lib/electron.ts` by text analysis. Every new channel
  must appear in all three.
- Test layout: vitest "node" project runs `{src,electron}/**/*.test.ts` in a
  plain node environment; the "dom" project runs `src/**/*.test.tsx` under
  jsdom with `src/test/setup.ts` and `src/test/mock-bridge.ts`. Anything that
  needs a DOM (TipTap) must be a `.test.tsx` in `src/`.
  `electron/registry.test.ts` shows the pattern for testing registry SQL
  without Electron: poison the module loader with an Electron stub and a
  better-sqlite3-shaped adapter over `node:sqlite`.
- `tsconfig.json` has `allowJs: true` and excludes `server/`; `js-yaml@^4.1.1`
  is already a devDependency (used by `scripts/release.mjs`). Packaged
  Electron main-process code can only require the three production
  dependencies (`better-sqlite3`, `electron-updater`, `node-pty`), so main
  code must not require js-yaml.

### 2.1 Where the briefing collides with the code

Called out per instructions, with the smallest adjustment proposed:

1. **"Config lives at `~/Documents/Markie/Projects.md`."**
   `electron/workspace.js` `documentsDir()` resolves Documents through
   Electron on Windows because OneDrive Known Folder Move relocates it. The
   config document therefore lives at `<defaultRootPath()>/Projects.md`,
   which is `~/Documents/Markie/Projects.md` on macOS and Linux and the
   OneDrive-aware equivalent on Windows. Adjustment: spec the path as "the
   default workspace root" rather than a literal home-relative string.
2. **"workspace-default.ts already establishes this root."** The renderer-side
   `src/lib/workspace-default.ts` bootstraps the root by calling
   `wsCreateDefault`; the path logic itself lives in `electron/workspace.js`.
   No behavior change needed, just an ownership correction: Projects.md
   creation belongs in the main process next to `defaultRootPath()`.
3. **"Extract a shared module both import" (MCP drift).** `mcp/scan.mjs`
   carries an explicit header: the MCP server must have NO dependency outside
   `mcp/` because extraResource packaging once reached into the asar and broke
   the app. The shared module therefore must live inside `mcp/` and be
   imported by `src/` (legal: `allowJs: true`, Next bundles it), never the
   other way round. Section 6.3 specifies this direction.
4. **"A draft is at worst a keystroke old."** In Rich mode the serializer runs
   on a 250ms debounce (`rich-view.tsx:250`), so no journal can be fresher
   than 250ms after a keystroke without reworking the serializer. Adjustment:
   the draft journal targets "at worst one serializer tick (250ms) old" in
   Rich mode and per-keystroke freshness in Source mode. This still satisfies
   the crash-safety intent.
5. **"14 of 20 probe inputs change bytes."** Not independently re-verified;
   the plan's first task writes the round-trip suite, which empirically
   documents the real number on this dependency set. If the suite disagrees
   with the briefing, the suite wins.
6. **Construct frequency on real data** (measured by the plan review against
   3,866 real markdown files on the owner's machine): hand-wrapped
   paragraphs 76.5%, front matter 56.2%, raw HTML 29.2%, footnotes 1.2%,
   table alignment 0.4%, display math 0.0%. Any design that refuses rich
   editing on wrapped paragraphs or raw HTML refuses most of the corpus;
   the genuinely hard constructs are statistically negligible. Section 3 is
   built around these numbers.

---

## 3. Workstream 1: Rich-mode round-trip integrity (prerequisite)

### 3.1 Problem, sized against real data

TipTap parse-then-serialize is lossy for at least: YAML front matter (becomes
a setext H2), footnotes (escaped to `\[^1\]`), raw HTML blocks (flattened) and
HTML comments (deleted), display math (doubled backslashes, dropped `\,`), GFM
table alignment markers, and soft line breaks (hand-wrapped paragraphs joined
into one line). Today a human pressing save is the only gate between that
damage and the file. Debounced autosave removes the gate, so autosave is
forbidden until Rich mode either round-trips a document losslessly or refuses
to edit it.

Measured construct frequency on 3,866 real markdown files (Section 2.1 point
6): wrapped paragraphs 76.5%, front matter 56.2%, raw HTML 29.2%, footnotes
1.2%, table alignment 0.4%, display math 0.0%. A gate that refuses rich
editing whenever the serializer would change bytes therefore refuses roughly
80% of real documents, which fails the product bar for the default mode. The
design is inverted: instead of detecting loss and refusing, Markie prevents
the loss for the overwhelmingly common cases and refuses only for the
statistically negligible residue. Three layers, in order of application.

### 3.2 Layer 0: shared extension list (foundation)

Extract the inline extension array from `rich-view.tsx:208-241` into
`src/lib/rich-extensions.ts` (`richBaseExtensions(): AnyExtension[]`,
everything except the Collaboration pair, which stays session-specific in the
component). The component, the normalizer in layer 2, the probe in layer 3,
and the test suite all import the same list, so none of them can drift from
the real editor.

### 3.3 Layer 1: hold-aside for constructs TipTap destroys entirely

Some constructs do not survive `setContent` at all: YAML front matter, HTML
comments on their own lines, raw HTML blocks, and footnote definitions.
Because the editor destroys them on parse, no serialization-side fix can
recover them. They are extracted from the source before `setContent` and
restored verbatim at serialization time.

- `src/lib/front-matter.ts` provides `splitFrontMatter(md)` and
  `joinFrontMatter(fm, body)` (front matter also matters independently:
  Workstream A's `markie: {project, block}` declaration and the config
  document both parse it).
- `src/lib/rich-hold-aside.ts` generalizes the same idea to the other three
  construct classes: `extractHoldAsides(body)` scans line by line (skipping
  fenced code), lifts each block-level HTML comment, raw HTML block, and
  footnote definition out of the text, and substitutes an opaque single-line
  placeholder token (plain alphanumeric text such as `markie-hold-1-a3f9c2d1`,
  chosen because plain words survive TipTap round trip unchanged).
  `restoreHoldAsides(serialized, holds)` replaces each placeholder with the
  original bytes on the way back out. Unmatched or duplicated placeholders
  (the user deleted or copied one in the editor) restore what can be matched
  and drop the rest; a deleted placeholder deletes the held block, which is
  the user's visible intent.

In solo (non-collab) mode, `RichView` runs front matter split plus hold-aside
extraction before `setContent` and the inverse in `serializeMarkdown` and
`flush`. Collab mode is unchanged in 0.5.0 (the Yjs room already holds parsed
content; noted as a known limitation).

Visible consequence, flagged for review: a held-aside raw HTML block renders
in the rich pane as its placeholder token instead of TipTap's flattened text.
Preservation is the release's point (agents and git watch these files), so
the trade is accepted; an optional polish step may style the placeholder as a
neutral chip via a ProseMirror decoration, but nothing depends on it.

### 3.4 Layer 2: block-preserving serialization (kills rewrapping loss)

The dominant loss class is reformatting of blocks the user never touched:
hand-wrapped paragraphs joined, list markers normalized, table alignment
rewritten. Layer 2 makes serialization a block-level diff against the
original source instead of a wholesale rewrite:

1. `src/lib/rich-block-preserve.ts` provides `splitTopLevelBlocks(md)`: split
   the document into top-level blocks on blank lines, treating fenced code
   (``` and ~~~) as opaque so a blank line inside a fence never splits.
   Blocks carry their exact source bytes including trailing blank lines, and
   `blocks.join("") === md` always holds.
2. `preserveBlocks(originalBody, serializedBody, normalize)` splits both
   sides and aligns them by normalized equivalence: `normalize(block)` runs
   the block through the same parse-then-serialize path as the editor (the
   shared extension list, one reused headless Editor). Alignment is a
   longest-common-subsequence over `normalize(originalBlock) ===
   serializedBlock`. For every aligned pair, the original source bytes are
   emitted verbatim; only genuinely changed blocks (and insertions) get the
   serializer's output. A coalescing pass extends the same exact-equality
   test to runs the serializer merges: when a run of consecutive unmatched
   source blocks normalizes, as one unit, to exactly one output block (a
   loose list tightened by `tightLists`, an adjacent reference definition
   inlined), the run is emitted verbatim too. When a block cannot be
   confidently matched, the serializer's output for it is used; the code
   never guesses.
3. Performance: `normalize` results are memoized per block content in an LRU
   shared across saves, and the cache is warmed once at document load in an
   idle callback, so steady-state autosave flushes only normalize blocks
   that actually changed.

Net effect: an edit to one paragraph rewrites that paragraph only; the other
few hundred blocks, wrapped paragraphs, aligned tables and all, are emitted
byte for byte. With no edits at all, the output is byte-identical to the
input by construction. This is what turns the 76.5% wrapped-paragraph corpus
from "read-only" into "safe".

### 3.5 Layer 3: probe gate, read-only rich, explicit override (last resort)

The probe and refusal machinery survives, but demoted to the residue layers
1 and 2 cannot save:

- `src/lib/rich-roundtrip.ts` keeps `probeRoundTrip(md)` (raw serializer
  fidelity, used by the normalizer tests and loss diagnostics) and
  `describeLossRisks(md)` (names constructs for banner copy). New
  `probeReconstruction(md)` runs the full zero-edit pipeline: front matter
  split, hold-aside extraction, parse, serialize, block preservation,
  restore, and compares the result to the original bytes. By construction it
  should be byte-identical; where it is not (block-splitter edge cases,
  exotic nesting, mixed line endings), the pipeline cannot promise fidelity
  for this document.
- `RichView` runs `probeReconstruction` when it applies an external value in
  solo mode. Only on failure does the document fall back to the original
  design: rich pane mounted but **read-only**, banner "Rich editing is off
  for this file: it uses formatting the rich editor would rewrite
  (`<construct list>`). Edit in Source to keep it intact.", actions **Edit
  in Source** and **Edit rich anyway** (per-document override in
  `localStorage` under `markie.richoverride.v1:<path>`; explicit consent to
  normalization).
- Known residue inside editable documents: constructs that live inline in a
  block the user edits (an inline footnote reference in an edited paragraph,
  alignment markers in an edited table) take the serializer's rewrite for
  that block only. The damage is confined to a block the user deliberately
  changed, and `describeLossRisks` still names these constructs so the UI
  can warn without refusing.

Expected fallback share: with zero edits, layer 2 preserves even footnote,
alignment, and math documents (untouched blocks come back verbatim), so
what actually gates is structural: reference-style link definitions the
parser consumes with unrelated content in between, held-aside placeholders
that cannot keep their position (a comment inside a list item), inline HTML
whose parse bleeds across blocks, and splitter edge cases. Every one of
these is rarer than the rarest measured construct (footnotes, 1.2%). The
plan requires measuring against the real corpus after layers 1 and 2 land
(Section 3.7); the target is well under 5% of documents read-only in rich,
the planner's estimate is 1 to 3%, and the measured number is reported to
the human reviewer. If it lands materially above target, that is stated
plainly, not papered over.

### 3.6 Autosave gate

Autosave (Section 4) is enabled for a document only when one of:
- the active editing surface is Source (CodeMirror is byte-faithful), or
- `probeReconstruction` passed for this document, or
- the user recorded the explicit rich override.

While rich is read-only due to a failed reconstruction probe, `onChange`
never fires from the rich pane, so no corruption path exists even with
autosave armed for source edits.

### 3.7 Tests and corpus measurement

A real vitest suite (`src/lib/rich-roundtrip.test.tsx` plus per-layer suites,
jsdom project because TipTap needs a DOM) with concrete fixtures for every
construct listed in 3.1 and the safe cases. Required assertions:

- Per-construct fixtures through the full pipeline: front matter, HTML
  comments, raw HTML blocks, footnote definitions, wrapped paragraphs,
  aligned tables each survive a zero-edit open/serialize byte for byte.
- Byte-identity for untouched blocks: edit one block programmatically,
  serialize, assert every other block's source bytes are unchanged in the
  output.
- Hold-aside edge cases: placeholder deleted in the editor, fences containing
  comment-looking text, footnote definitions adjacent to references.
- Splitter invariants: `splitTopLevelBlocks(md).join("") === md` on every
  fixture, fences never split.
- Raw probe fixtures (`probeRoundTrip`) still document serializer behavior so
  a dependency upgrade that changes fidelity fails loudly.
- Corpus measurement: an opt-in test walks a local directory of real files
  (env-gated, owner-run) and reports the share of documents failing
  `probeReconstruction`; it asserts the under-5% target when enabled.

This workstream is the first phase of the release and the regression net for
everything after it.

---

## 4. Workstream 2: Save, drafts, and internal file history

### 4.1 Locked save model (restated)

| Trigger | Behavior |
|---|---|
| Typing | Debounced write to the real file (1s idle, 5s max-wait so a long burst still lands) |
| Cmd+S / save button | Flush the pending write now; same code path, not a parallel one |
| Switch file, new file, close, quit | Flush before the transition; nothing in flight is dropped |
| Crash mid-burst | Draft journal in userData, written ahead of the file debounce |
| Every committed write | One history version per burst, not per keystroke |

### 4.2 Autosave engine

`src/lib/autosave.ts`: a pure scheduler, no React, injected clock.

```ts
createAutosave(opts: {
  idleMs?: number;        // default 1000
  maxWaitMs?: number;     // default 5000
  save: () => Promise<boolean>;  // true = committed, false = refused/failed
}): {
  noteChange(): void;     // call on every buffer change
  flush(): Promise<boolean>; // run pending save now (no-op when clean)
  cancel(): void;         // drop pending without saving (file switch after explicit discard)
  isPending(): boolean;
}
```

Wiring lives in a new hook extracted from `page.tsx` (Section 4.7). The hook
computes `autosaveEligible` from: `filePath !== null`, `docEditable`,
rich-safety (Section 3.6), no pending disk conflict, and not currently showing
the disk conflict dialog. `noteChange` is called from `setContent` paths that
represent edits (not from loads, pulls, or reloads, which set content and
savedContent together).

The save executed by the scheduler is `handleSave({ autosave: true })`, the
same function ⌘S uses. It flushes the rich serializer first
(`currentMarkdown()`), exactly as today.

### 4.3 Autosave and the main-process save handler

`save-file` gains an additive `autosave?: boolean` argument (same channel, IPC
contract unchanged in shape):

- Manual save (`autosave` absent/false): current behavior, including the
  native "changed on disk" dialog.
- Autosave (`autosave: true`): **never** show a native dialog. If
  `diskChangedSince` reports a change, return
  `{ success: false, code: "disk-changed", content: <disk content> }` without
  writing. The renderer routes that into the existing `DiskChangeStrip` /
  `DiskConflictDialog` flow and suspends autosave for the document until the
  conflict is resolved. An autosave must never interrupt typing with a modal
  and must never blind-overwrite an agent's concurrent edit.

Watcher interaction is already safe by construction: `save-file` calls
`rememberDisk` immediately after `writeFileAtomic`, and the watcher's
`diskChangedSince` compares content hashes, so Markie's own autosaves do not
trigger the change strip. A page-level regression test pins this.

Collab interaction: during a live session `handleSave` already skips `docPush`
(`page.tsx:846-864`); autosave keeps writing the local file on the same cadence
and keeps skipping `docPush`. The sync path is unchanged.

CSV documents keep their existing `toDisk` encoding on every autosave; the
"saved as CSV drops N lines" warning only appears on manual saves (an autosave
repeating it every second would be noise; the manual-save warning and the
persistent badge still cover it).

### 4.4 Flush on transitions

- `loadFile`, `handleNewFile`, `openPath`, drag-drop open: `await flush()`
  before the buffer resets. If the flush fails (disk conflict, write error),
  the transition still proceeds but the draft journal retains the buffer and
  the banner reports the failed save (a blocked transition would trap the
  user; a preserved draft loses nothing).
- Window close / quit: `main.js` window `close` handler calls
  `event.preventDefault()`, sends `app-will-close` to the renderer, and waits
  (2s cap) for the renderer to flush autosave plus draft and invoke
  `app-close-ready`; then the window is destroyed and quit proceeds. A hung
  renderer cannot block quit past the cap; the draft journal covers whatever
  the cap cut off. Two new channels: `app-will-close` (main to renderer send)
  and `app-close-ready` (invoke); both go through the IPC contract test.
- Non-Electron (web) fallback: a `beforeunload` handler warns when dirty.
- A dirty buffer with **no path** (never-saved document) cannot be flushed to
  a file. It is preserved by the draft journal and restored via the recovery
  strip on next launch (Section 4.5). This is a design call (no blocking
  "Save your untitled document?" dialog); flagged for review in Section 9.

### 4.5 Draft journal

`electron/drafts.js` (pure, injected fs/clock, follows the `snapshots.js`
testability pattern):

- `userData/drafts/<hash8(path)>-<basename>.md` plus one `drafts/index.json`
  recording `{ key, path|null, name, savedAt }`. The untitled buffer uses key
  `untitled`.
- IPC: `draft-save` (write-behind, atomic), `draft-check` (list drafts newer
  than their file's mtime, or orphaned untitled drafts), `draft-discard`.
- Renderer writes the draft on a 250ms debounce whenever the buffer is dirty,
  and discards it after any committed save of that path.
- Pruning: drafts older than 7 days are dropped; total cap 50MB.
- Boot recovery: after the initial document resolves, `draft-check` runs; a
  matching draft raises a strip above the document: "Markie recovered unsaved
  changes from <relative time>. [Restore] [Discard]". Restore loads the draft
  content into the buffer as unsaved (`unsaved: true` path, same as snapshot
  revert); Discard deletes the draft.

### 4.6 History

Decision: **evolve `electron/snapshots.js` in place rather than supersede
it.** The existing store already forms a version chain: each entry is the
pre-save image of one committed write, so `snapshots + current disk content`
is exactly the version list the history UI needs. Reusing the store satisfies
"migrate existing snapshots rather than orphaning them" with zero migration:
existing snapshots appear as history versions with author "unknown".

New module `electron/history.js` wraps the snapshot store:

- `capture(filePath, nextContent, { author })` delegates to the snapshot
  capture and records `{ stamp, author, iso }` in a `meta.json` sidecar per
  document folder. Authors: `"user"` (Markie save paths), `"external"`
  (watcher-detected change; when the poll watcher reports a disk change, the
  new disk content is captured as an external version so agent/MCP writes to
  the open document enter history). Finer attribution (which agent) is out of
  scope for 0.5.0 and noted in the UI as "External edit".
- Retention replaces the flat caps: keep everything newer than 24h; thin to
  at most one version per hour for ages 1-7 days; at most one per day for
  7-30 days; drop versions older than 30 days. Floors and caps: always keep
  the newest 5 versions per file regardless of age; hard caps 200 versions
  per file and 500MB globally (oldest pruned first). The old constants
  (20/file, 200MB) are superseded because autosave commits far more versions.
- `list(filePath)` returns `[{ stamp, iso, author, bytes }]` newest first;
  `read(filePath, stamp)` returns one version's content.

IPC: `history-list`, `history-read` (both new channels through the contract
test). Restore reuses the existing revert mechanics: renderer loads the chosen
version into the buffer with `unsaved: true` so the user saves (or discards)
the restore explicitly.

UI: `src/components/history-dialog.tsx`, a modal in the Settings style.
Version rows newest first: relative timestamp, author chip ("You" /
"External edit" / "Unknown"), and a per-version line-diff summary computed
with the existing `src/lib/line-diff.ts` (`+a  -r` against the previous
version, fetched lazily as rows render; initial render capped at 30 rows with
"Show older"). Row actions: Preview (read-only render) and Restore. Entry
points: File menu item "History…" (replaces "Revert to Snapshot…", reusing the
`REVERT_MENU_ID` enable logic), command palette entry, and a clock icon in
`DocToolbar`.

### 4.7 page.tsx extraction (do not make the god component worse)

Both A and B add state. The seams they touch are extracted as part of the
work, not after it:

- `src/lib/use-document.ts`: a hook owning `{ content, savedContent,
  fileName, filePath, isDirty }` plus the transition functions (`load`,
  `reset`, `markSaved`, `applyExternal`) and the autosave/draft wiring.
  `page.tsx` consumes it; the existing `page.*.test.tsx` suites must stay
  green through the refactor (they mount `Home` and exercise behavior, not
  internals).
- View routing for the new full-width view stays in `src/lib/left-rail.ts`
  (pure, tested), not in page state logic (Section 5.8).

Line-count guardrail: after B and A land, `page.tsx` must be no longer than it
is today (1,899 lines). The plan enforces this with an explicit check at the
end of each UI task.

---

## 5. Workstream 3: Virtual project/block organization

### 5.1 Model

- **Project**: a named group of files (typically "one repo" or "one topic").
- **Block**: a unit of work inside a project (a feature, an investigation, a
  work session). Tracks `made` (earliest known creation among members) and
  `updated` (latest mtime among members).
- **File**: an indexed markdown file, wherever it lives on disk. Files never
  move; the taxonomy is a view.
- Everything sorts most-recent-first: projects by `updated`, blocks by
  `updated`, files by `mtimeMs`.
- Files that no rule or heuristic can place land in **Unfiled** (a synthetic
  project, sorted by recency like any other but visually distinguished).

### 5.2 Assignment precedence (locked)

First match wins, per file:

1. **Manual pin**: the user dragged/assigned the file (persisted decision).
2. **Front matter**: the writing agent declared
   `markie: { project: X, block: Y }` in YAML front matter.
3. **Path rules** from the user-editable config document.
4. **Fallback**: project derived from repo/folder, block from work-session
   clustering.

### 5.3 Config document

`Projects.md` in the default workspace root (`electron/workspace.js`
`defaultRootPath()`; `~/Documents/Markie/Projects.md` on macOS). Created by
the main process on first use of the Projects feature if absent. It opens and
edits like any other Markie document.

Front matter schema, under the `markie_rules` key (YAML, parsed with the
already-vendored `js-yaml` in the renderer engine):

```yaml
---
markie_rules:
  version: 1
  clustering:
    gap_hours: 24          # session gap threshold
    min_files: 1           # smallest cluster kept as its own block
    max_blocks_per_project: 30
  rules:
    - match: "~/Desktop/Coding/ZVN/**"
      project: "{repo}"
    - match: "~/Documents/Markie/**"
      project: "Notes"
      block: "{folder}"
  ignore:
    - "~/Downloads/**"
---
```

- `rules` are evaluated in document order; first `match` wins (precedence
  step 3). `match` is a minimal glob over absolute paths (`~` expansion,
  `*` within a segment, `**` across segments; nothing else).
- `{repo}` substitutes the containing git repository's directory name;
  `{folder}` substitutes the file's parent directory name. A rule may set
  `project` alone (block still derived by clustering) or both.
- `ignore` hides files from the taxonomy entirely (they remain in Browse).
- Malformed YAML degrades to the **last known-good parsed rules** (persisted
  in the registry) with an inline warning banner in the Files tab and the
  Projects view naming the parse error and linking to the document. Never an
  empty view.
- The body below the front matter is a human-readable listing of projects and
  blocks. It is written at creation and refreshed **on demand** via an
  "Update listing in Projects.md" action in the Projects view (auto-rewriting
  a user-editable document in the background would fight the editor and the
  disk watcher; design call, flagged in Section 9).

### 5.4 Work-session clustering (default block derivation)

Applies to files whose block is not fixed by pin, front matter, or rule.
Within one project:

- Sort member files by `mtimeMs` descending.
- Walk the sorted list; a gap greater than `gap_hours` (default 24) between
  consecutive files closes the current cluster and starts the next. Files
  edited within one bout of work therefore share a block.
- **Adaptive cap**: if a project yields more than `max_blocks_per_project`
  (default 30) clusters, double the gap and re-cluster, repeating until under
  the cap. Keeps pathological histories navigable.
- **Naming**: a cluster is named by the dominant directory (the most common
  parent-folder name among members, relative to the project root) when one
  covers at least half the members; otherwise by the stem of the
  most-recently-edited file; otherwise "Work session <Mon D>". Duplicate
  names within a project get " (2)", " (3)" suffixes, oldest first.
- **Stability**: the first derivation of a cluster mints a stable `block_id`
  persisted in the registry with its membership. Re-derivation is
  incremental: an unchanged file keeps its block; a new or re-edited file
  joins the nearest existing block within the gap window or founds a new one.
  Blocks never silently vanish while they still have members.
- **User decisions win**: a rename sets `custom_name` (wins over auto-name
  forever); a merge records `merged_into` and every future derivation routes
  the merged block's members to the target. Decisions survive re-derivation,
  re-indexing, and restarts.
- **Bulk-write detection (degenerate-clustering guard)**: `git clone`,
  branch checkout, and archive extraction rewrite mtimes in bulk (and on
  those files birthtime is the checkout time too), so time signal is
  meaningless there and a naive pass collapses a fresh clone into one
  enormous block. Before accepting a cluster, check its mtime spread: when a
  cluster holds at least `bulk_min_files` files (default 50) whose mtimes
  all fall within `bulk_window_minutes` (default 15), treat it as a bulk
  event and split it into path-based blocks instead (group by top-level
  subdirectory under the project root, named by that directory). Files later
  edited individually migrate out of the path block into time clusters
  through normal incremental re-derivation.
- All thresholds (including the bulk-write pair) are tunable via
  `markie_rules.clustering` because the heuristic will need tuning against
  real data (Section 5.9).

Fallback **project** naming (precedence step 4): the containing git repo's
directory name when the file is inside a repo (detected main-side, cached per
directory); otherwise the name of the highest ancestor directory below a
"container" (home, `~/Desktop`, `~/Documents`, `~/Downloads`, or any
registered workspace root); files sitting directly in a container go to
Unfiled.

### 5.5 Engine architecture

Pure functions in `src/lib/projects/`, unit-testable under the vitest node
project with no Electron import (mirroring the `mdindex.js` pattern):

- `rules.ts`: `parseRules(frontMatterYaml)` (js-yaml, schema validation,
  known-good fallback semantics), `matchRule(rules, filePath)`, glob
  matcher, `{repo}`/`{folder}` substitution.
- `assign.ts`: the precedence ladder.
  `assignProjects(files, { pins, rules, meta })` where `meta` carries
  per-file `fmProject`, `fmBlock`, `repoName`, `birthtimeMs`.
- `cluster.ts`: `deriveBlocks(projectFiles, priorAssignments, decisions,
  tunables)` implementing 5.4, returning stable block ids.
- `taxonomy.ts`: assembles `Project[] > Block[] > FileRow[]` sorted
  most-recent-first with made/updated/counts; applies renames and merges.

The renderer computes the taxonomy from the index rows it already receives
(`mdindex-scan` / `mdindex-updated` deliver the full row set to Browse today,
so 12,370 rows over IPC is proven). The main process contributes: per-file
metadata (5.6), persisted decisions, and the derived cache.

### 5.6 Main process: metadata and cache

- `electron/frontmatter.js`: `extractMarkieMeta(text)` reads only a leading
  front matter block and only the `markie:` mapping (`project`, `block`,
  quoted or bare scalars). Hand-rolled and dependency-free because packaged
  main code cannot use devDependencies. Pure, heavily tested.
- `electron/mdmeta.js`: after each index rescan, incrementally refresh a
  registry table `md_meta` for rows whose `mtime_ms` changed: stat
  `birthtimeMs`, read the first 4KB for `extractMarkieMeta`, resolve the
  containing repo root (walk up to home looking for `.git`, per-directory
  cache). First run over ~12k files is a one-time ~50MB sequential read;
  subsequent runs touch only changed files. Wired into `mdRescanAndNotify`
  after `saveIndexCache`; the `mdindex-scan` response and `mdindex-updated`
  payload rows gain additive fields `birthtimeMs`, `fmProject`, `fmBlock`,
  `repoName` (joined from `md_meta`).
- **Derived cache**: the renderer persists computed assignments back through
  `projects-save-cache`, keyed by the index fingerprint
  (`registry.indexCacheFingerprint`). On boot, `projects-state` returns the
  cached taxonomy for instant paint; the renderer recomputes when fresh index
  rows arrive and rewrites the cache only when the fingerprint changed
  (mirroring the `md_index_cache` skip-on-match pattern).

### 5.7 SQLite schema (HUMAN CHECKPOINT: exact DDL for sign-off)

`registry.js` gains schema versioning via `PRAGMA user_version` (currently
always 0). On open: read `user_version`; if `< 1`, run the v1 migration below
inside a transaction, then `PRAGMA user_version = 1`. The existing
PRAGMA-guarded `share_role` ALTER stays as-is (it predates versioning and
must keep working for databases that skipped versions).

```sql
-- v1 migration (new tables only; no existing table is altered)

CREATE TABLE IF NOT EXISTS md_meta (
  path         TEXT PRIMARY KEY,
  mtime_ms     REAL NOT NULL,     -- mtime the metadata was extracted at
  birthtime_ms REAL,              -- NULL where the FS has no birthtime
  fm_project   TEXT,              -- markie: { project } from front matter
  fm_block     TEXT,              -- markie: { block }
  repo_name    TEXT,              -- containing git repo dir name, or NULL
  scanned_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_pins (   -- precedence 1: user pins
  path       TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  block_id   TEXT,                -- NULL = pinned to project only
  pinned_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_blocks ( -- durable block identity + decisions
  block_id    TEXT PRIMARY KEY,   -- minted at first derivation (or fm:<p>/<b>)
  project     TEXT NOT NULL,
  auto_name   TEXT NOT NULL,
  custom_name TEXT,               -- user rename; wins when set
  merged_into TEXT,               -- block_id this block was merged into
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_assignments ( -- derived cache, disposable
  path        TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  block_id    TEXT,
  source      TEXT NOT NULL,      -- 'pin' | 'frontmatter' | 'rule' | 'derived'
  mtime_ms    REAL NOT NULL,      -- file mtime at assignment time (stability check)
  fingerprint TEXT NOT NULL       -- registry.indexCacheFingerprint of the index
);

CREATE TABLE IF NOT EXISTS projects_config (  -- last known-good rules + misc
  key   TEXT PRIMARY KEY,         -- 'rules-known-good' | 'rules-error'
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Only user decisions (`project_pins`, `project_blocks` renames/merges) are
precious; `md_meta`, `project_assignments`, and `projects_config` are derived
and rebuildable. Dropping the derived tables must never lose a decision.

### 5.8 UI

**IPC additions** (all through the contract test): `projects-state`,
`projects-save-cache`, `projects-pin`, `projects-block-set` (rename/merge),
`projects-config` (read Projects.md, creating the default on first call),
`projects-write-overview` (the on-demand body refresh).

**Files tab (Library panel).**
- Files becomes the default tab; Recent stays second.
- Tab-key migration: new key `markie.libtab.v2`. On first read, migrate v1:
  a stored `"recent"` maps to `"recent"` (that user explicitly clicked Recent
  at some point, and Recent was already the default, so clicking it means
  they had left and come back to it deliberately); anything else, including
  absent (the user never switched tabs and was simply on the old default),
  maps to `"files"`. Justification: absence is not a choice; an explicit
  Recent click is.
- The Files tab renders the new `src/components/projects-tree.tsx`: the
  virtual taxonomy as a compact tree (project > block > file), counts and
  relative "updated" times, most-recent-first, filter box. A small segmented
  control at the top of the tab switches "Projects" (default) and "Folders"
  (the existing `FilesView`, unchanged, with its real file operations). The
  Folders view is kept because it is the only surface with mkdir / new file /
  rename / trash, and removing working functionality would violate the
  "upgrade, break nothing" bar. Design call, flagged in Section 9.

**Full-width Projects view.**
- `src/lib/left-rail.ts` gains a third kind of view:
  `export type FullView = "projects"`,
  `LeftView = PanelView | "edit" | FullView`, plus `isFullView()` and
  `showDocumentArea(state)` (false only while the full view is active).
  `selectLeftView` behavior: clicking Projects opens the full view (panel
  closes, document area is replaced); clicking it again returns to the
  document and restores the previous panel state. Pure and fully tested, as
  today.
- `activity-bar.tsx` gains a Projects button (grid icon) between Library and
  Browse. New shortcut ⇧⌘L and a command palette entry "Projects".
- `src/components/projects-view.tsx` occupies the document column:
  - Header: "Projects" title, search field (filters projects, blocks, and
    files by name/path), summary stats (N projects, N blocks, N files,
    Unfiled count).
  - Master-detail body: left column lists projects (name, file count,
    relative updated time), most-recent-first, Unfiled last-styled but
    recency-sorted; right pane shows the selected project's blocks as
    sections, most-recent-first, each with name (inline-editable), "made" and
    "updated" timestamps, file count, and its file rows (name, muted
    directory path, updated time). Clicking a file opens it and returns to
    the editor.
  - Organization actions: drag a file onto another block or project (records
    a pin); row menu with "Move to project…", "Move to block…", "Unpin
    (follow rules)"; block menu with "Rename" and "Merge into…"; header
    action "Update listing in Projects.md"; a link to open Projects.md
    itself.
  - Styling: existing design tokens only (`bg-surface`, `border-border`,
    `text-muted`, status colors, the documented 6/8/12px radius scale). Both
    color modes must be fully legible (CONSTITUTION); the visual audit
    scripts remain green.
- The Library side panel remains fully functional; the full view is
  additional navigation, not a replacement.

### 5.9 Verification against real data (required)

`scripts/projects-audit.mjs`: a read-only script (consent-gated like the
other check scripts, no window needed) that opens the real registry
(`~/Library/Application Support/markie/registry.db`) read-only, loads
`md_index_cache` + `md_meta`, runs the engine, and reports: project count,
block count, files per project (top 20), Unfiled count and percentage,
singleton-block percentage, the largest block per project (name, file
count, share of the project), and a sample rendered tree for the five most
recent projects. The
release is verified on the owner's machine (~12,370 indexed files).
Acceptance gates:

- Unfiled below 20% of files.
- No project over `max_blocks_per_project` after adaptation.
- **Concentration**: in any project with at least 10 files, no single block
  holds more than 40% of the project's files, and no block anywhere holds
  more than 500 files. This is the specific guard against the fresh-clone
  degenerate case (bulk-rewritten mtimes collapsing into one enormous
  block), which the earlier gates cannot see.
- The owner confirms the tree "reads like my actual work".

If the heuristic produces junk, the finding is fixed (tunables, naming rule,
bulk-write thresholds, container list), not papered over; the script is the
tuning loop.

---

## 6. Cross-cutting: MCP and agent instructions

### 6.1 `instructions` in InitializeResult

`mcp/markie-mcp.mjs` adds an `instructions` string to the initialize result
(client-agnostic per the MCP spec; Claude, Codex, and GPT apps surface it to
the model). Content: what Markie is, which tool to use when, and the
organization conventions: declare `markie: { project, block }` front matter
when writing; one block per unit of work; name blocks after the feature, not
the date; prefer `markie_find_md` before writing to avoid duplicates; open
results in Markie with `markie_open_in_markie`.

### 6.2 Write path declares project/block

`markie_write_md` gains optional `project` and `block` string parameters
(additive; existing calls unchanged). When provided, a pure helper merges a
`markie: { project, block }` mapping into the document's front matter
(creating the block if absent, preserving other keys byte-for-byte). The
declaration round-trips into the taxonomy through `md_meta` extraction
(Section 5.6) at precedence 2. Tool descriptions mention the convention.

### 6.3 Shared module and scan budget

- New `mcp/agent-classify.mjs` (inside `mcp/`, keeping the packaging
  invariant from the `scan.mjs` header): `CACHED_SEGMENTS`,
  `isCachedAgentPath`, `classifyAgentFile`. `mcp/lib.mjs` imports it (fixing
  `markie_list_skills` cache noise), and `src/lib/agent-files.ts` imports it
  too (`allowJs: true`; a small `mcp/agent-classify.d.mts` provides types).
  A vitest parity test imports both entry points and asserts identical
  classification over a fixture table, so drift cannot recur silently.
- `mcp/scan.mjs` `walk` gains the same budget shape as
  `electron/mdindex.js` (`maxFiles`/`maxMs`/`maxDepth`, defaults 200000 /
  30000 / 24) so `markie_find_md` can no longer walk unbounded. A vitest
  text-parity test (ipc-contract style) asserts `EXCLUDED_NAMES`,
  `BUNDLE_RE`, and the budget defaults match between the two files.

### 6.4 Tool-shape checkpoint (HUMAN CHECKPOINT)

Everything in 6.1-6.3 is additive: a new initialize field, two new optional
parameters, unchanged tool names and required arguments. No existing tool
contract breaks. Sign-off on this section covers the additions; anything
beyond it (renaming a tool, changing a required argument) is out of scope for
0.5.0.

### 6.5 Plugin skill and in-app copy

- The Claude Code plugin (`mcp/.claude-plugin/plugin.json`) ships a skill
  `skills/markie-conventions/SKILL.md`: when writing markdown documents for
  the user, declare `markie` front matter, follow the block conventions, and
  open deliverables in Markie. Marketplace metadata updated.
- `src/components/agents-dialog.tsx` copy gains a line that connected agents
  receive organization instructions automatically, plus the front matter
  convention example, and keeps the Claude Code and Codex setup blocks
  (covering non-Claude clients).

---

## 7. Workstream C: share-takeover fix (server, CRITICAL)

### 7.1 The flaw

Anyone can register any email (`server/src/auth.ts:37-39`, no
`requireEmailVerification`, default `autoSignIn`), and the create hook
(40-54) plus the listing sweep (`docs.ts:60-65`) convert every pending share
addressed to that email into a real share. Registering `alice@corp.com`
before Alice does inherits documents shared with her.

### 7.2 Fix: proof of email ownership gates every claim

- `emailAndPassword.requireEmailVerification: true`; verification codes go
  through the existing `emailOTP` plugin (`sendVerificationOTP` with type
  `email-verification`; `otp-email.ts` copy extended for that type).
  better-auth blocks credential sign-in for unverified accounts and the
  client flow completes verification with the OTP.
- **Claim paths audited** (complete list, from a repo-wide search):
  1. `auth.ts` `user.create.after` hook: **removed**. At creation the email
     is unproven.
  2. New claim trigger when verification completes: a
     `databaseHooks.user.update.after` hook that claims when
     `emailVerified` transitions to true (the exact better-auth 1.6.22+
     hook point is confirmed during implementation; the invariant is "claim
     fires exactly once ownership is proven").
  3. `docs.ts` claim-on-list: gated on `user.emailVerified === true`.
  4. `doc-view.ts:84` `pendingForToken`: unchanged by design. It grants
     read access by possession of a token that was emailed to the invited
     address, which is itself proof of receipt; it never converts the
     pending row into an account-bound share.
- Google OAuth accounts arrive with `emailVerified: true` from the provider
  and are unaffected.
- **Client flow**: the desktop app already has a complete email-OTP surface
  (`sign-in.tsx` `otp-code` view, `authClient.sendOTP` / `verifyOTP`), and an
  OTP sign-in proves the email. The only client change is routing: a password
  sign-in or sign-up that better-auth refuses with "email not verified" flips
  the dialog into the existing `otp-code` view instead of showing a dead
  error. Verifying by code both proves the address and signs the user in.
- **Existing accounts, auditable grandfathering**: a one-time migration
  script (`server/src/migrate-verified.ts`, documented in the deploy
  runbook) backfills `emailVerified = 1` for accounts created before the
  deploy. Rationale: breaking every existing sign-in fails the "must not
  break" requirement. The script is **dry-run by default** and prints an
  audit report for human review before anything is written:
  1. how many accounts it is about to grandfather (and their creation-date
     range);
  2. how many pending invites have already been claimed (converted to
     shares) versus still pending;
  3. **flagged rows**: every already-claimed share whose claiming account
     has `emailVerified = 0` and no OAuth provider account. That is the
     signature of the takeover vulnerability having actually been
     exercised. Zero rows are expected; any non-zero result is presented to
     the owner before grandfathering proceeds, because grandfathering such
     an account would launder a stolen claim into a legitimate one.
  Only an explicit `--commit` flag performs the UPDATE, and it re-prints the
  same report as part of the run. Any pending (unclaimed) invites remain
  protected from that point on because every future claim path requires
  verification.
- **Regression test is the attack itself**: attacker signs up with the
  victim's email (unverified), lists docs, and must NOT receive the pending
  share; the real owner of the address verifies and must receive it.
- Dependency upgrades: `better-auth` to `>= 1.6.22`
  (GHSA-qq9h-g4jm-xgf3) and `hono` to the CORS-ReDoS-fixed release; `npm
  audit` in `server/` must come back clean for those advisories, and all 148
  existing server cases (adjusted for the new verification requirement via a
  test helper that verifies test users) plus the new ones stay green.
- No deployment, no production data, no credential changes: code, tests, and
  a written runbook only (CONSTITUTION).

---

## 8. Workstream D: Windows updater

### 8.1 Fix scope

- `electron/update-policy.js`: `desktopUpdatePolicy` returns
  `supported: true` for `win32` packaged builds with
  `platform: "Windows"` and feed `latest.yml` (electron-updater's NSIS
  default; the published object lives at `windows/latest.yml` per the
  manifest, and `electron-builder.config.cjs` already writes the Windows
  publish path from the manifest, so a packaged Windows build's
  `app-update.yml` points at the right B2 prefix today). Linux stays
  unsupported with the existing message.
- `electron/update-channel.js`: the `FEEDS` map is macOS-named
  (`latest-mac.yml` / `beta-mac.yml`). Make feed naming platform-aware
  (`latest.yml` / `beta.yml` on win32) so the beta opt-in cannot point a
  Windows install at a mac feed. `setupAutoUpdate` itself needs no change:
  it is already gated on `shouldSetupAutoUpdate`, which flips with the
  policy.
- Docs reconciliation to current truth (a signed public 0.4.2 Windows exe is
  served from `/download`, the manifest says `public`): `README.md:27-38`
  stops saying Windows is unpublished; `docs/RELEASING.md` artifact matrix
  and the "Windows release gate" section are updated to describe the live
  state plus the updater-feed publication steps
  (`windows-release.yml` CI signing to the `windows-signed` prerelease, then
  the local `npm run release:publish:win`); `release-preflight.test.ts` /
  `release-windows.test.ts` snippet assertions are updated in the same
  change.
- Verification without publishing: unit tests for the policy and channel
  logic; `npm run electron:pack:win` + the existing packaged smoke; the
  update flow against the real feed is executed by the human at the next
  Windows release per the runbook (release and publish are human
  checkpoints).

---

## 9. Design calls made by the planner (not user-reviewed; catch these in review)

1. **Layered preservation, then gating** (Sections 3.2 to 3.5): hold-aside
   for parse-destroyed constructs, block-preserving serialization for
   reformat loss, and the read-only probe gate demoted to the residue.
   Consequence: nearly all documents stay rich-editable; the corpus-measured
   fallback share must land well under 5% (reviewed against the real number).
   This shape was directed by plan review after corpus measurement; the
   concrete mechanics (placeholder format, LCS alignment, normalize cache)
   are planner calls.
2. **Hold-aside layer (front matter, comments, raw HTML, footnote
   definitions) applies in solo mode only**; collab sessions keep today's
   (lossy) behavior in 0.5.0. Held raw HTML blocks display as a neutral
   placeholder token in the rich pane rather than flattened text; styling
   the token is optional polish.
3. **No blocking dialog for a dirty untitled buffer on close/new**; the draft
   journal plus the recovery strip carry it (Section 4.4).
4. **History evolves `snapshots.js` in place** (same store, sidecar metadata,
   new retention: 24h full, hourly to 7d, daily to 30d, keep-newest-5 floor,
   200/file and 500MB caps) instead of a parallel store (Section 4.6).
5. **Clustering defaults**: 24h gap, min cluster 1, 30-block adaptive cap,
   dominant-folder naming with latest-file fallback (Section 5.4).
6. **Files tab keeps the old folder tree behind a "Folders" sub-toggle**
   inside the Files tab (Section 5.8) so no working functionality is removed.
7. **Tab default migration**: v2 key; explicit Recent choice preserved,
   everything else defaults to Files (Section 5.8).
8. **Projects.md body refresh is on demand**, not automatic (Section 5.3).
9. **Full-width view layout**: master-detail with inline rename, drag-to-pin,
   ⇧⌘L shortcut (Section 5.8).
10. **Existing server accounts are grandfathered as verified** in the C
    migration (Section 7.2).
11. **js-yaml is used in the renderer engine** (existing devDependency, ~40KB
    against the 12MB bundle budget); the main process gets a hand-rolled
    minimal front matter extractor instead.
12. **Rich-lossy override persists in localStorage**, not the registry
    (per-machine is acceptable for an editing preference).

---

## 10. Risks, and how we will know we broke something

| Risk | Detection |
|---|---|
| Autosave writes a lossy rich serialization | Per-construct pipeline fixtures, untouched-block byte-identity tests, and the `probeReconstruction` gate; any regression fails the Phase 1 suites |
| Block preservation misaligns and emits stale bytes | Splitter invariant tests (`join === original`, fences opaque); alignment falls back to serializer output when unmatched, never guesses; corpus measurement reports reconstruction failures |
| Autosave fights the disk watcher (false conflict strips) | Page-level regression: autosave then watcher tick emits no `onFileChangedOnDisk` handling; `save-file` unit test that `rememberDisk` runs before return |
| Autosave overwrites an agent's concurrent edit | `save-file` autosave-mode test: disk changed → `code: "disk-changed"`, no write, no dialog |
| Flush-on-close blocks quit | 2s cap test on the close handshake; draft journal covers the remainder |
| page.tsx grows | Explicit line-count check in every UI task; extraction tasks land before feature tasks |
| Registry migration corrupts existing databases | `registry.test.ts` migration cases run v0 → v1 on a populated node:sqlite database; decisions-only-precious invariant tested (dropping derived tables loses nothing) |
| Taxonomy junk on real data | `scripts/projects-audit.mjs` gates (Unfiled < 20%, block caps, concentration: no block over 40% of a 10+ file project or over 500 files) on the owner's 12,370-file index before the release is called done |
| Fresh clone collapses into one giant block | Bulk-write mtime-spread detection splits it into path-based blocks (Section 5.4); the concentration gate and largest-block-per-project report catch any residue |
| Index/meta scan slows the app | Meta extraction is incremental (mtime-gated) and runs after the existing rescan; the audit script reports wall time; budgeting mirrors `mdindex.js` |
| New IPC breaks the contract | `electron/ipc-contract.test.ts` stays green; every task adding a channel updates all three files in one commit |
| Server verification locks out existing users | Migration backfill + regression tests for legacy sign-in; the attack test proves the fix |
| better-auth/hono upgrade changes behavior | All 148 server cases run against the upgraded versions before any new code lands (upgrade is its own task) |
| Windows feed misconfiguration bricks updates | Policy/channel unit tests; no publish in this release; runbook requires the previous-version update check before the manifest flips anything |
| Bundle budget exceeded (js-yaml, new views) | CI's 12MB `out/` gate; `npm run build` in every task's verify step |
| Dark/light regressions in new views | Token-only styling; `npm run visual:guard:theme` where applicable; CONSTITUTION legibility rule |

Standing gates for every task: `npm test` (vitest 98 files / 1,175 cases plus
the new ones), `npm run lint` (0 errors), `npm run build` (also the TS check),
`node --test mcp/lib.test.mjs`, `(cd server && npm test)`, and `./init.sh`
before any milestone is called complete.
