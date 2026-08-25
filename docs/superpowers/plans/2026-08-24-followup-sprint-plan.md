# Follow-up sprint plan, 2026-08-24

Continues docs/superpowers/plans/2026-08-23-crash-hardening-sprint-plan.md. That sprint is staged
and green (vitest 871, server 122, mcp 24, lint, build, release:preflight). This one takes the
items the reviews left open.

## Goal

Markie stops being able to eat a file (atomic writes plus snapshots), viewers can comment,
exports carry their images and print goes through the real pipeline, a collab room can't be
double-seeded, the components edited last sprint get tests, and `tsc --noEmit` becomes a CI gate.

## Out of scope, blocked on the owner

- Windows code signing. Needs a purchased cert or Azure Trusted Signing account.
- Real-device Windows pass. Needs the physical PC. Artifacts are ready in dist/.

## Success criteria

- [ ] Every write to a user's file goes through one atomic helper. Crash mid-write leaves the
      original intact. Finder tags survive on macOS.
- [ ] Every save keeps a snapshot. File menu can revert to one.
- [ ] A viewer can start a thread and reply. Resolve and cross-user delete stay editor/owner.
- [ ] PDF and HTML exports include local images. ⌘P prints the rendered document, not the app.
- [ ] Two clients opening a snapshot-backed doc can't both seed the room.
- [ ] Component tests exist for conflict-dialog, shared-view, library states, and the page
      save/conflict/menu/shortcut/drop handlers.
- [ ] `npx tsc --noEmit` exits 0 and runs in CI.
- [ ] All suites, lint, build, release:preflight stay green.

## Tracks

### Track 1: atomic writes, snapshots, main-process wiring
Owner of electron/main.js. Files: electron/main.js, NEW electron/atomic-write.js (+test),
NEW electron/snapshots.js (+test), electron/sync.js (write sites only), electron/preload.js and
src/lib/electron.ts (additive), scripts/release-preflight.mjs (update-channel assertion only).

- T1-01 atomic-write.js: `writeFileAtomic(filePath, data, { fs, platform })`. Temp file in the
  same directory (mode copied from the original when present), write, fsync, rename over the
  original. On darwin, capture `com.apple.metadata:_kMDItemUserTags` and other xattrs with
  `/usr/bin/xattr` before the rename and restore them after, best effort in try/catch. Injectable
  for tests. Known tradeoff, accepted by the owner: rename breaks hard links.
- T1-02 route every user-file write through it: save-file, save-file-as, rename-file content
  writes in main.js; pull, resolve('cloud'), resolveKeepBoth in sync.js. Registry/db and crash
  log writes stay as they are, they are not user files.
- T1-03 snapshots.js: before each successful save over an existing file, copy the previous
  content to `userData/snapshots/<slug>/<ISO>.md` (slug from the absolute path, hashed plus
  basename). Caps: 20 per file, 200 MB total, oldest pruned. Injectable, tested.
- T1-04 File menu "Revert to Snapshot…": native open dialog with defaultPath at that file's
  snapshot folder, filtered to .md. Picking one sends the content through the existing
  file-opened flow flagged as unsaved changes on the current path, it does not write to disk.
  Menu item disabled when no snapshots exist.
- T1-05 export channel contract for Track 3: `export-pdf` accepts
  `{ html, theme?, docPath?, mode?: "pdf" | "print" }`. Pass docPath and mode through to the
  exporter. No save dialog when mode is "print". `export-html` handler lazy-requires
  `./inline-images` in try/catch and, when present and docPath given, runs
  `inlineLocalImages(html, dirname(docPath))` before writing. Track 3 creates that module.
- T1-06 bring update-status, check-for-updates, quit-and-install under the `handle()` wrapper
  with onFailure shapes, and update the release-preflight assertion that pinned the old
  `ipcMain.handle("check-for-updates"` string so preflight still passes.

### Track 2: viewers can comment
Files: server/src/shares.ts, server/src/comments.ts, server tests, src/lib/comments.ts,
src/components/comments.tsx.

- T2-01 `canCommentLevel(level) = level !== null` in shares.ts. The two POST routes in
  comments.ts use it. Resolve/reopen and cross-user delete keep canEditLevel/owner.
- T2-02 server tests: viewer creates a thread, viewer replies, viewer cannot resolve, viewer
  cannot delete another's comment, non-member still 403.
- T2-03 renderer: comments UI no longer hides composer/reply for viewers. Check how
  comments.tsx gates on access and loosen exactly that. Resolve/delete affordances stay gated.

### Track 3: export images and real print
Files: NEW electron/inline-images.js (+test), electron/export-pdf.js (+test), src/app/page.tsx
(print and export handlers only), src/lib/toolbar-shortcuts.ts or menu wiring if ⌘P routing
needs it.

- T3-01 inline-images.js: `inlineLocalImages(html, docDir, { fs })`. Rewrites `<img src>` that
  are relative or file:// paths inside docDir (subdirs ok, `..` escapes refused) to data: URIs.
  png/jpg/jpeg/gif/webp/svg. Per-image cap 10 MB, total cap 30 MB, over-cap images left as-is.
  Injectable, tested against traversal.
- T3-02 export-pdf.js: call inlineLocalImages when docPath present. Implement
  `mode: "print"`: same hidden window and readiness wait, then `webContents.print()` with the
  system dialog instead of printToPDF, no save dialog, same in-flight guard and cleanup.
- T3-03 page.tsx: handlePrint builds the same export HTML (async buildPDFHTML) and calls
  exportPDF with mode "print" and docPath; window.print() remains only as the non-electron
  fallback. Export handlers send docPath. Keep the print.css path for the fallback.

### Track 4: collab room seed lock
Files: server/src/collab.ts (+tests), src/components/rich-view.tsx (small), src/lib/collab.ts
if a constant belongs there.

- T4-01 server: when a room loads with zero stored updates and the backing doc has non-empty
  content, the first editor connection becomes the designated seeder. Sync update messages from
  other connections are dropped (viewer-style) until the room holds at least one stored update
  or the seeder disconnects, then the next editor inherits. Log a line when a non-seeder's
  update is dropped.
- T4-02 server tests: two editors join an empty room, only the first's update lands; seeder
  disconnect hands off; viewer never seeds; non-empty room unaffected.
- T4-03 client: before trySeed runs, require the first sync to have completed and the fragment
  to still be empty after a 150 ms delay, which pairs with the server lock instead of racing it.
  Write a `schemaVersion` into the ydoc meta map on seed; log a console warning on mismatch.

### Track 5: tests, fixtures, gates
Files: NEW component tests (conflict-dialog, shared-view, library, page.*), electron/*.test.ts
fixture typing, scripts/overlay-interaction-check.mjs, src/components/browse-view.tsx
(truncated notice only), .github/workflows/ci.yml.

- T5-01 component tests: conflict-dialog (three resolutions, Escape, frozen content),
  shared-view (tabs, error, retry), library (all 8 item states plus exists:false render
  distinct rows; act() failure shows an error notice), page.save (reloaded branch, error
  surfaced), page.conflict (409 opens dialog keyed to file), page.menu (emit onMenuSave etc.,
  unsubscribe on unmount), page.shortcuts, page.drop. Skip print/export page tests this round,
  Track 3 is editing those handlers.
- T5-02 type the electron test fixtures so `npx tsc --noEmit -p tsconfig.json` exits 0
  (terminal.test.ts, desktop-intents, desktop-launch-smoke, file-grants,
  local-electron-builder, package-smoke, release-workflow, windows-launch-smoke). No `any`
  blankets; type the fake param shapes.
- T5-03 add a `typecheck` npm script and a CI step running it as a gate.
- T5-04 overlay-interaction-check.mjs: the panel-stays-open behavior is deliberate
  (page.tsx documents it), so update the stale assertion to expect the panel present after
  opening a file from Files, and re-run the script to the end. Report anything else it finds.
- T5-05 browse-view: when a scan result has `truncated`, show a one-line note ("Index is
  incomplete: <reason>") above the list.

## Sequencing

All five tracks run in parallel. main.js belongs to Track 1 alone. page.tsx print/export
handlers belong to Track 3; Track 5 tests page.tsx but not those handlers. The export channel
contract in T1-05/T3-02 is fixed above so both sides build against it.

## After merge

Full verify (vitest, server, mcp, lint, build, typecheck, release:preflight), one combined
re-review agent, CHANGELOG and BACKLOG updates, restage. No commits, the owner commits.
