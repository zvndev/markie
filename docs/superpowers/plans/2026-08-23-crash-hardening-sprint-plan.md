# Sprint Plan — Markie
Generated: 2026-08-23
Based on: six parallel audit agents (shared-doc crash paths, export crash paths, main-process/indexer
stability, sidebar resize brief, test-coverage map, Windows build readiness). Full findings are
summarised per track below; AUDIT notes live in the session scratchpad and are folded into the
task descriptions so this file is self-contained.

## Sprint Goal
Markie stops crashing or going dead-silent on shared-doc opens and exports, stops hammering the
Mac's filesystem (the Finder-crash suspect), gains a drag-resizable library panel, gets a crash
log so the next failure is diagnosable, and gains the test infrastructure + first component/IPC/
server tests so regressions are caught automatically.

## Success Criteria
- [ ] All P0 issues resolved (data loss, white-window crashes, Finder-pressure)
- [ ] All P1 issues resolved (silent failures, hangs, leaks, Windows path bugs)
- [ ] Left panel drag-resizable 200–520px, persisted, keyboard accessible, e2e-proven
- [ ] jsdom component test project + bridge mock + IPC contract test + server route tests exist
- [ ] `npm test`, `(cd server && npm test)`, `node --test mcp/lib.test.mjs`, `npm run lint`,
      `npm run build` all green
- [ ] Windows x64 installer + zip built from the fixed tree, with `docs/WINDOWS-TESTING.md`
- [ ] `docs/mobile/MOBILE-PLAN.md` written (iOS Swift + Android Kotlin)

## Ground rules for every dev agent
- Work directly in the tree on `main`. **No git worktrees, no branches, no commits.** Leave the
  changes in the working tree; the lead stages and the owner commits.
- Edit only files listed under your track. Never touch `CHANGELOG.md`, `PROGRESS.md`,
  `BACKLOG.md`, `CURRENT_TASK.md`, `package.json` (except Track 4's one script line),
  `package-lock.json` — the lead consolidates those.
- Read a file before editing it. Use targeted edits, not whole-file rewrites (other agents are
  editing other files in the same tree concurrently).
- Match existing code style (no new deps without saying so; the test deps are already installed).
- Finish by running `npm test` (and the server/mcp suites if you touched them) and
  `npx eslint <your files>`; report results honestly.

---

## Track 1 — Electron main process hardening (owns `electron/main.js` exclusively)
**Files:** `electron/main.js`, NEW `electron/crash-log.js` (+ `.test.ts`), NEW `electron/export-pdf.js`
(+ `.test.ts`), NEW `electron/ipc-result.js` (+ `.test.ts`)
- [ ] T1-01 (P0) Crash log + recovery: `crashReporter.start({uploadToServer:false})`; `logCrash(kind, detail)`
      appends to `userData/markie-crash.log` (cap ~1 MB, rotate); hook `uncaughtException`,
      `unhandledRejection`, `app child-process-gone`; in `createWindow`: `render-process-gone` → log +
      dialog Reload/Quit; `unresponsive` → log; `setWindowOpenHandler` deny + `shell.openExternal` for
      http(s); `will-navigate` preventDefault away from app:// / dev URL; Help menu "Reveal Crash Log".
- [ ] T1-02 (P0) Stop the `$HOME` re-walk on focus (`main.js:349-355`): only rescan on focus when the
      Browse/Skills panel is actually open (renderer tells main via the existing scan IPC or a flag set
      when `mdindex-scan` was called) and raise the debounce to ≥ 5 min; `mdindex-updated` payload must
      carry the files so the renderer never has to call `mdindex-refresh` in response.
- [ ] T1-03 (P0) `export-pdf` (`main.js:452-493`): move to `electron/export-pdf.js`; write HTML to a
      temp file and `loadFile` it (no data: URL); wait for `document.fonts.ready` + double rAF (timeout)
      instead of 500 ms sleep; `Promise.race` 30 s timeout; module-level in-flight guard returning
      `{success:false, error:"busy"}`; `isDestroyed` guards; always destroy the window and delete the
      temp file in `finally`; normalise `.pdf` extension; move `showSaveDialog` inside the try.
      `export-html` (`:576`): normalise `.html` extension, dialog inside try.
- [ ] T1-04 (P1) Universal IPC safety: `handle(ch, fn)` wrapper (like `wsTry` at `:600-606`) that
      try/catches, logs via crash-log, and returns `{error}` — apply to every sync/doc/mdindex/registry/
      term/dialog handler listed in the audit (`doc-*`, `library-state`, `sync-config`, `sync-doc-role`,
      `mdindex-*`, `reveal-file`, `open-file`, `save-file-as`, `ws-add-root`, `term-*`,
      `default-md-status`, `set-default-md`, `get-initial-file`, `mcp-info`).
- [ ] T1-05 (P1) `deliverDeepLink` (`:83-85`): `void openCloudDocFromDeepLink(link).catch(show dialog)`.
- [ ] T1-06 (P1) `default-md-status` (`:1043`, `runSwift :1012`): cache the result for the session;
      5 s timeout that kills the child and resolves `{error:"timeout"}`.
- [ ] T1-07 (P1) Windows chrome: gate `titleBarStyle: "hiddenInset"`/`trafficLightPosition` on darwin;
      darwin-gate the app-name menu (`hide/hideOthers/unhide`) and Window `zoom/front`; use
      `app.getPath("documents")` when passing the default workspace root if main computes it (else leave
      to Track 2).
- [ ] T1-08 (P2) `lastSeenOnDisk` (`:245`) LRU cap 500; `isAdvertisedPath` (`:1126`) use a Set;
      `shell.showItemInFolder` debounce 500 ms; `downloadsUniquePath` (`:101`) cap iterations.
- [ ] T1-09 tests: `crash-log.test.ts` (append/rotate), `export-pdf.test.ts` (temp-file lifecycle,
      timeout, busy guard — mock electron like `electron/sync.test.ts`), `ipc-result.test.ts`.

## Track 2 — Electron modules, indexer & Windows path fixes
**Files:** `electron/mdindex.js`, `electron/registry.js`, `electron/workspace.js`, `electron/terminal.js`,
`src/components/terminal-panel.tsx`, `src/components/browse-view.tsx`, `src/components/skills-view.tsx`,
`mcp/scan.mjs`, `mcp/lib.mjs`, `electron-builder.config.cjs`, tests: `electron/mdindex.test.ts`,
NEW `electron/workspace.test.ts`, NEW `electron/registry.test.ts`, `electron/terminal.test.ts`,
`mcp/lib.test.mjs`
- [ ] T2-01 (P0) `mdindex.js` exclusions: add `Dropbox`, `Google Drive`, `OneDrive`, `Applications`,
      `Pictures`, `Movies`, `Music`, `AppData`, `Application Data`, `Local Settings`, `$Recycle.Bin`;
      prune macOS bundle dirs by extension regex (`.app .photoslibrary .musiclibrary .fcpbundle
      .xcodeproj .xcworkspace .pvm .vmwarevm .utm .sparsebundle .framework .bundle .pkg` etc.);
      skip `~/Desktop` and `~/Documents` descent when iCloud Desktop&Documents sync marker
      `~/Library/Mobile Documents/com~apple~CloudDocs/Documents` exists (walk them only if they're
      registered workspace roots); drop the per-file `stat` where `withFileTypes` suffices; add a
      budget (max 200k files / 30 s wall / depth 24) that returns a partial result. Mirror the
      exclusion list in `mcp/scan.mjs`. Hoist `allowlist(home)` out of the per-dir loop.
- [ ] T2-02 (P0) Break notify→refresh amplification: `browse-view.tsx:149-153` and
      `skills-view.tsx:52-56` must consume the files from the `mdindex-updated` payload (Track 1 sends
      them) instead of calling `mdIndexRefresh()`; keep a fallback if payload lacks files. Add `.catch`
      to every `mdIndexRefresh/mdIndexScan/mdIndexStars` call so a failure leaves an error row, not an
      infinite spinner.
- [ ] T2-03 (P0) `terminal-panel.tsx:39-54`: on unmount `termKill` every tab; if `termCreate` resolves
      after unmount, kill it immediately. `terminal.js`: cap sessions at 12; idle reaper optional.
- [ ] T2-04 (P1) `registry.js`: wrap `require("better-sqlite3")` in try/catch exposing
      `registry.available()` + descriptive error; `saveIndexCache` (`:199-210`) skip the rewrite when
      the `path|mtimeMs` hash is unchanged; `movePrefix` (`:92-95`) escape `_`/`%` with `ESCAPE '\'`;
      path comparisons case-insensitive on win32.
- [ ] T2-05 (P1) `workspace.js`: `withinRoots` case-insensitive on win32 (match `file-grants.js`);
      sanitize names for Windows (`: * ? " < > |`, trailing dots/spaces, reserved `CON/NUL/COM1…`) —
      reuse the stricter rule in `file-grants.js:90-92`; default root via `app.getPath("documents")`
      when electron is available (lazy require, fallback to homedir/Documents).
- [ ] T2-06 (P2) `mcp/lib.mjs:175-182` win32 open: use `spawn("cmd.exe", ["/c","start","",path])` or
      `powershell -File`-style arg binding that actually opens Markie (markie:// or the exe), not the
      system .md handler.
- [ ] T2-07 (P2) `electron-builder.config.cjs`: add `protocols: [{name:"Markie", schemes:["markie"]}]`
      and explicit `asarUnpack` for `node_modules/node-pty/**` and `node_modules/better-sqlite3/**`.
- [ ] T2-08 tests: mdindex exclusion/bundle/iCloud/budget cases; `workspace.test.ts` on a tmpdir
      (listDir/mkdir/newFile/move/rename/trash, `..` refusal, case-insensitive roots on win32 via
      injected platform, Windows name sanitizing); `registry.test.ts` on a temp sqlite
      (track/get/setRole/stars, movePrefix with `_`, saveIndexCache no-op when unchanged);
      terminal session cap.

## Track 3 — Renderer: shared-doc / sync / export handlers
**Files:** `src/app/page.tsx`, `src/components/rich-view.tsx`, `src/components/conflict-dialog.tsx`,
`src/components/shared-view.tsx`, `electron/sync.js` (+ `electron/sync.test.ts`), `src/lib/auth-client.ts`,
`src/lib/electron.ts`
- [ ] T3-01 (P0) `page.tsx` `resetDocAccess` (`:463-466`): also `setCollabCfg(null)`,
      `setEnforcedTheme(null)`, `setPeers([])` so opening file B tears down file A's live session
      synchronously (prevents A's content being saved into B).
- [ ] T3-02 (P0) `electron/sync.js`: in `api()` treat a 2xx with unparseable body as failure; guard
      every `res.data.doc` / `.version` (`:105,111,144,151,191-192,218,236,304,358`) returning
      `{error:"The server sent an unreadable copy of this document."}`; wrap `resolve('cloud'|'local')`
      read/write (`:218,:237`) in try/catch like `resolveKeepBoth`; add tests for `pull()` and
      `remoteContent()` covering 404/403/null-body/ENOENT.
- [ ] T3-03 (P0) `page.tsx:998-1007` boot: `.catch(()=>{}).finally(()=>setBooted(true))`.
- [ ] T3-04 (P1) `rich-view.tsx`: handle collab close code 4403 (stop reconnect, disconnect, report
      "access removed"); `trySeed` (`:208-221`) must not seed when `collab.readonly` and must not mark
      seeded when the local value is empty; wrap the Yjs binding creation in try/catch → surface error
      and fall back to non-collab editing; expose a `flush()` (via ref/callback) that flushes the 250 ms
      debounce; RichView `key` in `page.tsx:1390-1394` includes a token hash.
- [ ] T3-05 (P1) Export handlers in `page.tsx`: `handleExportPDF` (`:610`) and `handleExportHTML`
      (`:749`) call rich-view flush first, `await` the IPC, and surface `res.error` via the existing
      notice/error channel (e.g. the one `setForkError` uses); disable while an export is in flight.
- [ ] T3-06 (P1) `handleSaveAs` (`:631-636`): compute `toDisk` from the path the dialog returned — send
      raw content + let main's `save-file-as` return the chosen path, then re-encode and write; or
      simplest: pass both `markdownContent` and `csvContent` and let the extension decide. Coordinate
      via the existing IPC shape only (Track 1 owns main.js — if main needs a change, document it in
      your report and implement the renderer side defensively).
- [ ] T3-07 (P1) `conflict-dialog.tsx:81`: freeze `localContent` with `useState` on open; deps
      `[filePath]`.
- [ ] T3-08 (P2) `auth-client.ts` `sharedByMe` return `null` on `!res.ok`; `shared-view.tsx:63-65`
      render an error state instead of "You haven't shared anything yet"; add `.catch`.
- [ ] T3-09 (P2) `src/lib/electron.ts`: add `safeApi()` helper (Proxy) that catches every rejected
      promise into `{error}` and logs to console; switch the call sites you touch to it.

## Track 4 — Library panel: drag-resize + `act()` error handling
**Files:** `src/components/library.tsx`, NEW `src/lib/panel-width.ts` (+ `.test.ts`),
NEW `src/components/panel-resizer.tsx`, `src/app/globals.css` (append only), NEW
`scripts/panel-resize-check.mjs`, `package.json` (one script line only)
- [ ] T4-01 (P1) Implement the resize feature exactly per the brief (constants 252/200/520/0.45,
      localStorage key `markie.leftpanel.width.v1`, pointer capture, Esc cancel, dbl-click reset,
      keyboard separator semantics, window-resize re-clamp, clamp-not-collapse).
- [ ] T4-02 (P0) `library.tsx:228-232` `act()`: try/catch/finally; read `r.error` and show it via the
      library's notice mechanism; never leave the menu stuck.
- [ ] T4-03 tests: `panel-width.test.ts` (cases from brief); `scripts/panel-resize-check.mjs` copied
      from `overlay-interaction-check.mjs`; npm script `visual:check:panel-resize`. Run it.

## Track 5 — Markdown/export libs + error boundary
**Files:** `src/lib/markdown-html.ts` (+ test), `src/lib/pdf-styles.ts` (+ NEW test), `src/lib/csv.ts`
(+ test), `src/app/layout.tsx`, NEW `src/components/error-boundary.tsx` (+ `.test.tsx`), NEW
`src/app/print.css`
- [ ] T5-01 (P0) Top-level `ErrorBoundary` in `layout.tsx`: shows the error message, "Reload" and
      "Copy details", keeps the window usable; plus `window.addEventListener('error'|'unhandledrejection')`
      logging to console with a visible toast-free fallback (no new deps).
- [ ] T5-02 (P0) `renderMarkdownHTML`: try/catch → escaped `<pre>` fallback + console.error; tests for
      unknown fence language, unterminated fence, malformed table, invalid LaTeX, raw HTML, 5k-line doc.
- [ ] T5-03 (P1) `csv.ts`: `csvDropsContent(markdown)` helper that reports whether content outside the
      first table would be lost; test it. (Track 3 may wire a warning later; keep it pure.)
- [ ] T5-04 (P1) `pdf-styles.ts`: include KaTeX CSS if feasible without a network/bundler trick
      (e.g. import `katex/dist/katex.min.css` text via a small generated TS constant committed to the
      repo with a script, or drop `rehypeKatex` from the *export* pipeline and render math as code);
      pick one, justify in report. Add `pdf-styles.test.ts`: both themes produce a full HTML document,
      body inserted at the slot, `</style><script>` in body can't break out of the template.
- [ ] T5-05 (P2) `print.css` imported from `layout.tsx`: `@media print` hides activity bar, side
      panel, toolbar, terminal, find bar; document canvas full-width.

## Track 6 — Test infrastructure, component tests (untouched components), server tests
**Files:** `vitest.config.ts`, NEW `src/test/setup.ts`, NEW `src/test/mock-bridge.ts` (+ `.test.ts`),
NEW `electron/ipc-contract.test.ts`, NEW `src/lib/comments.test.ts`, NEW `src/lib/collab.test.ts`,
NEW `src/lib/theme-sync.test.ts`, NEW component tests for: `find-bar`, `share-dialog`, `files-view`,
`comments`, `share-gate`, `share-banner`, `activity-bar`, `command-palette`, `update-toast`,
`settings`; server: NEW `server/src/comments.test.ts`, `themes.test.ts`, `link-token.test.ts`,
`index.test.ts`, `shares-revoke.test.ts`, `server/src/index.ts` (JSON `onError`/`notFound`),
`server/package.json` (test list), `server/download-manifest.json` + `server/src/public.test.ts` +
`server/src/render.test.ts` (mac-x64 flip), `docs/RELEASING.md` (one line), `.github/workflows/ci.yml`
- [ ] T6-01 (P0) vitest `projects`: `node` (`{src,electron}/**/*.test.ts`) + `dom`
      (`src/**/*.test.tsx`, jsdom, `setupFiles: src/test/setup.ts`, globals), esbuild jsx automatic,
      `@` alias. Existing 492 tests must stay green and fast.
- [ ] T6-02 (P0) `src/test/mock-bridge.ts` (`makeBridge/installBridge/emit/listenerCount` over
      `window.electronAPI`), `setup.ts` polyfills (matchMedia, ResizeObserver, print,
      Range.getClientRects), contract test that the mock covers every `ElectronAPI` key.
- [ ] T6-03 (P0) `electron/ipc-contract.test.ts`: `ipcMain.handle` channels in `main.js` ==
      `contextBridge` surface in `preload.js` == `ElectronAPI` members (text/AST; tolerate Track 1's
      `handle()` wrapper by matching `handle("name"` too).
- [ ] T6-04 (P1) Pure-lib tests: `comments.test.ts` (`selectionToAnchor`/`anchorToAbsolute` round-trip
      + boundaries), `collab.test.ts`, `theme-sync.test.ts` (mock fetch).
- [ ] T6-05 (P1) Component tests (jsdom) for the listed untouched components — happy path + error/empty
      state + a11y basics each.
- [ ] T6-06 (P1) Server: `comments.test.ts` (authz on all 5 routes) and add it to `server/package.json`
      test list; `themes`, `link-token`, `index` (/health, /api/me, CORS), `shares-revoke`;
      `index.ts` add `app.onError`/`app.notFound` returning JSON `{error}` so clients never get
      text/plain on an API route (the desktop sync client depends on it).
- [ ] T6-07 (P1) Publish the Intel Mac download: `server/download-manifest.json` mac-x64 → `status:
      "public"`, `feed: {type:"electron-builder-mac-yml", path:"mac/latest-mac.yml"}`, description
      "Current signed public download."; update `public.test.ts`/`render.test.ts` expectations; grep
      `scripts/release*.mjs` + `electron/release-*.test.ts` for assumptions about mac-x64 being planned
      and report (do not edit scripts/).
- [ ] T6-08 (P2) `ci.yml`: ensure `npm test` runs both vitest projects; add coverage artifact
      (`npx vitest run --coverage`) without failing on thresholds yet.

---

## Intentionally deferred (recorded for BACKLOG)
- Playwright-for-Electron migration of the 12 CDP scripts (large refactor; not this sprint).
- Server-side seeding of collab rooms from `docs.content` (`server/src/collab.ts:113`) — needs a
  schema/ops decision; client-side guard shipped instead.
- Windows auto-update feed + signed Windows release runner (needs Authenticode cert).
- Inline images as data URIs in PDF/HTML export.
- Windows Actions billing / GitHub runner.

## Phase 6+ (after merge): tests on edited components
`conflict-dialog`, `shared-view`, `library` (8 states), `page` save/export/conflict/update/menu/
shortcuts/drop tests (A1, A2, A3, A10–A14, E1, E2, D2) — written once Tracks 3/4 land.

## Manual actions for the owner
- Push the unpushed 0.4.1–0.4.3 work (and `v0.4.0` tag) from the other computer; this tree is on
  `f9c3f4a` (0.4.0).
- Copy the `product-team` skill from the other machine (not present here).
- Run the Windows checklist in `docs/WINDOWS-TESTING.md` on the Windows PC.
- Decide on a Windows code-signing route (OV/EV cert or Azure Trusted Signing).
