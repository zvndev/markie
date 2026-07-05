# Progress journal — Markie

> Append-only. One block per wakeup. The next run reads the tail of this to orient. Never rewrite
> history; only append.

<!-- entry template:
## {{YYYY-MM-DD HH:MM}} — terminal: <progressed|repaired|idle|escalated>
- did: <the one task; the feature/finding id>
- evidence: <how it was verified>
- next: <the recommended next task for the following run>
- blockers: <none | description + what's needed>
-->

## 2026-06-28 00:33 — terminal: progressed
- did: Environment initialized.
- next: First wakeup selects the highest-priority unfinished item.

## 2026-06-28 00:39 — terminal: progressed
- did: Initialized the long-agent-loop scaffold for build mode, seeded Markie's vision,
  constitution, spec, backlog, feature ledger, and operating manual; repaired an existing React
  refs lint error so future wakeups start from a clean verification baseline.
- evidence: `./init.sh > .autoloop/runs/init-20260628.log 2>&1` passed. It ran `npm test`,
  `node --test mcp/lib.test.mjs`, `(cd server && npm test)`, `npm run lint`, and `npm run build`.
- next: First product wakeup should select `F-001` from `feature_list.json` and implement only the
  context-aware terminal env/cwd injection slice.
- blockers: none. Lint still reports warnings for pre-existing hook dependency cleanup and an
  unused eslint-disable directive, but there are zero lint errors.

## 2026-06-28 01:51 — terminal: progressed
- did: Completed `F-001` by passing active document terminal context through the hidden embedded
  terminal path and injecting `MARKIE_FILE`, `MARKIE_DIR`, and `MARKIE_WORKSPACE` into new PTY
  shells while preserving cwd behavior.
- evidence: `PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$HOME/.nvm/versions/node/v22.17.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" npm test -- electron/terminal.test.ts`
  passed 5 tests. `./init.sh > .autoloop/runs/init-20260628-015021-post-f001.log 2>&1` passed
  renderer tests, MCP tests, server tests, lint, and build. The terminal UI remains hidden by
  `TERMINAL_ENABLED = false`, so this hidden slice was verified by focused Electron regression.
- next: Select `F-002` to verify future embedded terminal sessions receive updated context after
  the active document changes.
- blockers: none. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 02:50 — terminal: progressed
- did: Completed `F-002` by keeping the terminal panel's new-session action pointed at the latest
  active document context, so future embedded terminal sessions after a document switch inherit the
  new file and folder instead of stale values.
- evidence: `PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$HOME/.nvm/versions/node/v22.17.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" npm test -- electron/terminal.test.ts`
  passed 6 tests, including the document A to document B future-shell context regression.
  `./init.sh > .autoloop/runs/init-20260628-automated-f002-post.log 2>&1` passed renderer tests,
  MCP tests, server tests, lint, and build.
- next: Select `F-003` to add the safe release preflight command that stops before any publish,
  notarize, upload, deploy, or credentialed network action.
- blockers: none. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 03:52 — terminal: progressed
- did: Completed `F-003` by adding `npm run release:preflight`, a local-only release readiness
  command that checks package metadata, required release files, renderer/Electron tests, MCP tests,
  server tests, lint, and static build while explicitly stopping before signing, notarization,
  upload, publish, deploy, or credentialed network actions. Fixed the root `package-lock.json`
  version metadata to match `package.json`.
- evidence: `npm test -- electron/release-preflight.test.ts` passed 3 tests.
  `npm run release:preflight > .autoloop/runs/release-preflight-20260628-035123.log 2>&1` passed
  and ended with the credentialed-release stop message. `./init.sh > .autoloop/runs/init-20260628-035139-post-f003.log 2>&1`
  passed renderer tests, MCP tests, server tests, lint, and build.
- next: Select `F-004` to add the MCP safe markdown write/read regression without widening the MCP
  public API shape.
- blockers: none. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 04:51 — terminal: progressed
- did: Completed `F-004` by adding a stdio MCP regression that drives the existing
  `tools/call` path to write an allowed markdown file under a temporary safe home, read it back,
  and reject unsafe extension plus symlink escape writes without widening the MCP public API shape.
- evidence: `node --test mcp/lib.test.mjs > .autoloop/runs/mcp-lib-f004-20260628.log 2>&1`
  passed 15 tests. `./init.sh > .autoloop/runs/init-20260628-automated-f004-post.log 2>&1`
  passed renderer tests, MCP tests, server tests, lint, and build.
- next: Select `F-005` to run or repair the real-user comments verification journey for create,
  reply, resolve, reopen, and anchor survival.
- blockers: none. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 06:00 — terminal: progressed
- did: Completed `F-005` by making the comments verification journey repeatable from a local temp
  database, adding explicit reopen coverage to the API verifier, and adding an E2E-only Electron
  launch path that drives the existing comments UI verifier without depending on the user's running
  Markie instance.
- evidence: `npm run comments:verify:e2e > .autoloop/runs/comments-verify-e2e-20260628.log 2>&1`
  passed API checks for create, reply, list shape, resolve, reopen, access gating, and deletion,
  then passed Electron/CDP UI checks for comment creation, Bob's reply, reply count, anchor survival
  after an edit above the selection, panel authors, resolve, and reopen. `./init.sh > .autoloop/runs/init-20260628-automated-f005-post.log 2>&1`
  passed renderer tests, MCP tests, server tests, lint, and build.
- next: With all current feature ledger entries passing, the next run should handle the top open
  backlog item by escalating the human checkpoint for terminal API shape approval, or run the next
  scheduled review pass if that item is deferred.
- blockers: none for `F-005`. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 06:49 — terminal: escalated
- did: Selected the top open backlog item, "Approve or revise the context-aware terminal API shape
  before implementing bundled `markie` CLI commands or new MCP current-document tools," and wrote
  it to `CURRENT_TASK.md`.
- evidence: `./init.sh > .autoloop/runs/init-20260628-automated-wakeup.log 2>&1` passed renderer
  tests, MCP tests, server tests, lint, and build. The selected backlog item requires a public API
  shape decision, which `CONSTITUTION.md` marks as a human checkpoint.
- next: Human should approve or revise the terminal command/tool surface in an ADR; then a future
  wakeup can split the first implementable slice into `feature_list.json`.
- blockers: Human approval is required before implementing bundled `markie` CLI commands or new MCP
  current-document tools.

## 2026-06-28 07:50 — terminal: escalated
- did: Ran one loop wakeup, re-grounded on the product vision and constitution, and selected the
  only open backlog item, "Approve or revise the context-aware terminal API shape before
  implementing bundled `markie` CLI commands or new MCP current-document tools." No product code was
  changed because public local API shape is a human checkpoint.
- evidence: `./init.sh > .autoloop/runs/init-20260628-automated-wakeup-1100.log 2>&1` passed
  renderer tests, MCP tests, server tests, lint, and build. Lint still reports the known 4 warnings
  and zero errors.
- next: Human should approve or revise the terminal command/tool surface in an ADR; then a future
  wakeup can split the first implementable slice into `feature_list.json`.
- blockers: Human approval is required before implementing bundled `markie` CLI commands or new MCP
  current-document tools. No other eligible unattended feature or backlog task is currently open.

## 2026-06-28 08:50 — terminal: escalated
- did: Ran one loop wakeup, re-grounded on the product vision and constitution, confirmed all
  current feature ledger entries still pass, and selected the only open backlog item, "Approve or
  revise the context-aware terminal API shape before implementing bundled `markie` CLI commands or
  new MCP current-document tools." No product code was changed because public local API shape is a
  human checkpoint.
- evidence: `./init.sh > .autoloop/runs/init-20260628-automated-wakeup-084954.log 2>&1` passed
  renderer tests, MCP tests, server tests, lint, and build. Lint still reports the known 4 warnings
  and zero errors.
- next: Human should approve or revise the terminal command/tool surface in an ADR; then a future
  wakeup can split the first implementable slice into `feature_list.json`.
- blockers: Human approval is required before implementing bundled `markie` CLI commands or new MCP
  current-document tools. No other eligible unattended feature or backlog task is currently open.

## 2026-06-28 09:51 — terminal: escalated
- did: Ran one loop wakeup, re-grounded on the product vision and constitution, confirmed all
  current feature ledger entries still pass, and selected the only open backlog item, "Approve or
  revise the context-aware terminal API shape before implementing bundled `markie` CLI commands or
  new MCP current-document tools." No product code was changed because public local API shape is a
  human checkpoint.
- evidence: `./init.sh > .autoloop/runs/init-20260628-automated-wakeup-095114.log 2>&1` passed
  renderer tests, MCP tests, server tests, lint, and build. Lint still reports the known 4 warnings
  and zero errors.
- next: Human should approve or revise the terminal command/tool surface in an ADR; then a future
  wakeup can split the first implementable slice into `feature_list.json`.
- blockers: Human approval is required before implementing bundled `markie` CLI commands or new MCP
  current-document tools. No other eligible unattended feature or backlog task is currently open.

## 2026-06-28 10:18 — terminal: progressed
- did: Added the user-requested roadmap lane for fixing Markie style issues, especially invisible
  light-mode UI, improving the desktop layout to feel more refined/native, enabling Apple Silicon
  Mac, Intel Mac, Windows, and Linux desktop builds/downloads, and preparing for a later React
  Native version. Split the lane into `F-006` through `F-022`, each intended as one roughly
  30-minute wakeup.
- evidence: `feature_list.json` parsed successfully with 22 entries. `./init.sh >
  .autoloop/runs/init-20260628-plan-update.log 2>&1` passed. Added
  `docs/superpowers/plans/2026-06-28-style-platform-react-native-roadmap.md`, updated
  `VISION.md`, `CONSTITUTION.md`, `SPEC.md`, and reset `CURRENT_TASK.md` so the next wakeup selects
  `F-006`.
- next: Select `F-006` and create the repeatable light-mode visual audit before fixing individual
  style clusters.
- blockers: none for the new lane. The terminal API approval item remains open but is no longer the
  only eligible work because the feature ledger now contains the new style/platform/RN sequence.

## 2026-06-28 11:07 — terminal: progressed
- did: Selected `F-006` and added a repeatable local light-mode visual audit command that starts the
  renderer/Electron app, forces the built-in light theme, captures screenshots, and writes computed
  contrast findings for the primary shell plus representative gated surfaces.
- evidence: `./init.sh > .autoloop/runs/init-20260628-f006-pre.log 2>&1` passed before selection.
  `npm run visual:audit:light > .autoloop/runs/light-mode-audit-20260628-focused.log 2>&1` passed
  and wrote `.autoloop/runs/light-mode-audit-20260628150614/audit.json` with screenshots for shell,
  PDF menu, Library, command palette, settings, share, and comments surfaces. The audit recorded
  three concrete contrast findings: PDF menu options at 2.2:1 and markdown strong text at 1.04:1.
  `./init.sh > .autoloop/runs/init-20260628-f006-post.log 2>&1` passed after the change.
- next: Select `F-007` to fix top toolbar/header/PDF menu light-mode contrast using the audit
  evidence.
- blockers: none for `F-006`. The terminal API approval item remains human-gated and deferred
  behind the active `F-006` through `F-022` lane.

## 2026-06-28 11:54 — terminal: progressed
- did: Completed `F-007` by removing the hardcoded dark PDF/export menu background from the top
  toolbar and keeping both the real menu and audit probe on theme-aware surface tokens. Added a
  focused built-in theme contrast regression for muted top-chrome controls in dark and light mode.
- evidence: `./init.sh > .autoloop/runs/init-20260628-f007-pre.log 2>&1` passed before selection.
  `npm run visual:audit:light > .autoloop/runs/light-mode-audit-f007-20260628.log 2>&1` passed and
  wrote `.autoloop/runs/light-mode-audit-20260628155223/audit.json`; toolbar, file control, and PDF
  menu samples passed AA contrast, with PDF menu options improving from 2.2:1 to 6.38:1 in light
  mode. `npm test -- src/lib/theme.test.ts > .autoloop/runs/theme-test-f007-20260628.log 2>&1`
  passed 6 tests, including built-in dark/light top-chrome token contrast. `./init.sh >
  .autoloop/runs/init-20260628-f007-post.log 2>&1` passed renderer tests, MCP tests, server tests,
  lint, and build.
- next: Select `F-008` to fix side-panel light-mode legibility for Library, Browse, Skills/Agents,
  Shared, and file lists.
- blockers: none for `F-007`. The audit still records the editor strong-text light-mode finding
  reserved for `F-010`; lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 13:03 — terminal: progressed
- did: Completed `F-008` by making side-panel status/action colors follow active Markie theme
  variables instead of Tailwind dark-biased variants, ensuring light mode remains legible even when
  OS dark preference is active. Fixed color-mode application so the root `dark` class tracks the
  resolved mode, and expanded the light visual audit to cover Library, Browse, Files, Shared, and
  Skills/Agents side-panel samples at normal and narrow widths.
- evidence: `./init.sh > .autoloop/runs/init-20260628-f008-pre.log 2>&1` passed before selection.
  `npm run visual:audit:light > .autoloop/runs/light-mode-audit-f008-20260628.log 2>&1` passed and
  wrote `.autoloop/runs/light-mode-audit-20260628170137/audit.json`; `sidePanelFindings` is empty
  and side-panel samples pass AA contrast in light mode, with representative contrast from 5.94:1
  to 15.71:1. `npm test -- src/lib/color-mode.test.ts src/lib/theme.test.ts >
  .autoloop/runs/theme-tests-f008-20260628.log 2>&1` passed 9 tests. In-app browser sanity loaded
  `http://localhost:3000`, opened Library, and reported zero console warnings/errors. `./init.sh >
  .autoloop/runs/init-20260628-f008-post.log 2>&1` passed renderer tests, MCP tests, server tests,
  lint, and build.
- next: Select `F-009` to fix modal and popover light-mode legibility for command palette,
  settings, theme settings, stats, share, agents, and comments.
- blockers: none for `F-008`. The audit still records the known editor strong-text light-mode
  finding reserved for `F-010`; lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 13:55 — terminal: progressed
- did: Completed `F-009` by making modal/popover status and warning colors use built-in Markie
  status tokens, removing hardcoded dark surfaces from the stats popover and table toolbar, and
  expanding the light visual audit to cover stats, theme settings, agents, share feedback, and
  comments resolved/delete states alongside the existing command palette, settings, share, and
  comments probes.
- evidence: `./init.sh > .autoloop/runs/init-20260628-f009-pre.log 2>&1` passed before selection.
  `npm run visual:audit:light > .autoloop/runs/light-mode-audit-f009-20260628.log 2>&1` passed and
  wrote `.autoloop/runs/light-mode-audit-20260628175435/audit.json` plus screenshots. All sampled
  `F-009` overlay targets passed AA contrast in built-in light mode; examples include stats at
  6.38:1 to 14.62:1, agents warning at 5.85:1, share success/error/revoke at 5.88:1 to 6.86:1,
  and comments resolved/delete at 5.88:1 to 6.86:1. `npm test -- src/lib/theme.test.ts >
  .autoloop/runs/theme-test-f009-20260628.log 2>&1` passed 7 tests. `./init.sh >
  .autoloop/runs/init-20260628-f009-post.log 2>&1` passed renderer tests, MCP tests, server tests,
  lint, and build.
- next: Select `F-010` to fix markdown/rich editor content light-mode contrast, including the
  known strong-text finding still reported by the audit.
- blockers: none for `F-009`. The audit still records the known editor strong-text light-mode
  finding reserved for `F-010`; lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 14:58 — terminal: progressed
- did: Completed `F-010` by removing dark-only document content colors from strong text, inline
  code, and checked task controls, then expanded the welcome sample and light-mode audit so document
  content contrast is measured across headings, links, inline code, code blocks, blockquotes,
  tables, task controls, and math text.
- evidence: `./init.sh > .autoloop/runs/init-20260628-f010-pre.log 2>&1` passed before selection.
  `npm test -- src/lib/theme.test.ts > .autoloop/runs/theme-test-f010-20260628.log 2>&1` passed
  8 tests covering built-in dark/light document token contrast. `npm run visual:audit:light >
  .autoloop/runs/light-mode-audit-f010-20260628.log 2>&1` passed and wrote
  `.autoloop/runs/light-mode-audit-20260628185757/audit.json`; `contentFindings` is empty and
  content samples pass AA contrast in built-in light mode, including strong text at 16.97:1, links
  at 4.95:1, inline code at 6.29:1, code blocks at 15.71:1, blockquotes at 6.85:1, checked task
  controls at 4.95:1, tables, headings, and math text. `./init.sh >
  .autoloop/runs/init-20260628-f010-post.log 2>&1` passed renderer tests, MCP tests, server tests,
  lint, and build.
- next: Select `F-011` to turn the visual audit workflow into a regression guard for representative
  shell, editor/content, and modal/panel surfaces.
- blockers: none for `F-010`. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 15:55 — terminal: progressed
- did: Completed `F-011` by adding `npm run visual:guard:theme`, a dependency-free guard mode
  around the existing light-mode audit. Guard mode records required shell, content, and
  overlay/panel coverage in `audit.json` and fails when any required sample is missing or below AA
  contrast. While tightening the guard, fixed the live ProseMirror checked task checkbox so its
  check glyph uses the readable theme background color on the blue checked state.
- evidence: `./init.sh > .autoloop/runs/init-20260628-f011-pre.log 2>&1` passed before selection.
  `npm run visual:guard:theme > .autoloop/runs/theme-visual-guard-f011-20260628-final.log 2>&1`
  passed and wrote `.autoloop/runs/light-mode-audit-20260628195511/audit.json` plus screenshots;
  the guard sampled 6 shell, 11 content, and 16 overlay/panel targets at a 4.5 AA threshold with
  zero findings, and the checked task checkbox measured 4.95:1. `./init.sh >
  .autoloop/runs/init-20260628-f011-post.log 2>&1` passed renderer tests, MCP tests, server tests,
  lint, and build.
- next: Select `F-012` for one native-feeling refinement pass on the primary desktop shell spacing,
  density, window chrome, and panel boundaries.
- blockers: none for `F-011`. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 17:01 — terminal: progressed
- did: Completed `F-012` with one narrow native-feeling desktop shell refinement pass. The toolbar now uses stable grid columns at a denser 40px height, the activity rail is 48px wide with tighter icon affordances, the docked side panel has clearer header/subtab boundaries, and document/source panes use responsive spacing. Kept navigation and document behavior unchanged. While verifying, made the visual audit allocate its own local Next dev port and attach through Electron's fixed dev bootstrap URL so unrelated apps on port 3000 cannot contaminate screenshot evidence.
- evidence: `./init.sh > .autoloop/runs/init-20260628-f012-pre.log 2>&1` passed before selection. In-app browser QA loaded `http://localhost:3002/`, found zero console warnings/errors, clicked the real Light theme toolbar control at 760x720, and wrote `.autoloop/runs/shell-layout-browser-f012-20260628.json`; normal dark mode measured a 40px toolbar, 48px rail, and no sampled overflow, while compact 760x720 dark and light modes also reported no sampled overflow. `npm run visual:guard:theme > .autoloop/runs/theme-visual-guard-f012-20260628-rerun.log 2>&1` passed and wrote `.autoloop/runs/light-mode-audit-20260628210028/audit.json` plus shell, PDF menu, library, narrow side-panel, command palette, settings, and gated surface screenshots with zero findings across 6 shell, 11 content, and 16 overlay/panel guard samples. `npm test -- src/lib/theme.test.ts src/lib/color-mode.test.ts > .autoloop/runs/theme-tests-f012-20260628.log 2>&1` passed. `./init.sh > .autoloop/runs/init-20260628-f012-post.log 2>&1` passed renderer tests, MCP tests, server tests, lint, and build.
- next: Select `F-013` for a focused editor/document canvas refinement pass covering reading width, split-mode balance, empty states, and responsive behavior.
- blockers: none for `F-012`. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 18:00 — terminal: progressed
- did: Completed `F-013` with one focused editor/document canvas refinement pass. The document work area now has explicit single-pane and split-pane layout modes, View/Edit panes fill the available canvas, split mode uses a stable source/rich grid balance, and rich/source content wraps long headings and common markdown examples inside the document area without changing editor behavior.
- evidence: `./init.sh > .autoloop/runs/init-20260628-current-pre.log 2>&1` passed before selection. `npm run visual:check:document > .autoloop/runs/document-layout-check-f013-20260628-final.log 2>&1` passed and wrote `.autoloop/runs/document-layout-check-20260628215931/document-layout.json` plus screenshots for normal preview, normal split, compact split, compact edit, and compact empty states. The final metrics reported zero document-node overflows, no source/rich pane overlap, 0px split gaps, bounded rich canvases, and usable pane widths. `npm run visual:guard:theme > .autoloop/runs/theme-visual-guard-f013-20260628.log 2>&1` passed with zero findings across required shell, content, and overlay/panel samples and wrote `.autoloop/runs/light-mode-audit-20260628215943/audit.json`. `./init.sh > .autoloop/runs/init-20260628-f013-post.log 2>&1` passed renderer tests, MCP tests, server tests, lint, and build.
- next: Select `F-014` for a focused keyboard-first overlays and menus refinement pass covering focus, hover, spacing, and hierarchy.
- blockers: none for `F-013`. Lint still reports the pre-existing 4 warnings and zero errors.

## 2026-06-28 19:11 EDT — terminal: progressed
- did: Completed `F-014` with one focused keyboard-first overlay/menu polish pass. Existing command palette, PDF menu, stats, settings, theme settings, share, agents, and shortcuts overlays now share native-feeling panel depth, hover states, close/button/input focus rings, section hierarchy, and ARIA dialog/listbox affordances without adding new product surface.
- evidence: `./init.sh > .autoloop/runs/init-20260628-f014-pre.log 2>&1` passed before selection. `npm run visual:check:overlays > .autoloop/runs/overlay-interaction-check-f014-20260628.log 2>&1` passed and wrote `.autoloop/runs/overlay-interaction-check-20260628230923/overlay-interaction.json` with 10 screenshots and 14 focus/selection metrics across light and dark mode. `npm run visual:guard:theme > .autoloop/runs/theme-visual-guard-f014-20260628.log 2>&1` passed and wrote `.autoloop/runs/light-mode-audit-20260628230952/audit.json` with 68 samples, zero findings, and passing shell/content/overlay guard categories. `./init.sh > .autoloop/runs/init-20260628-f014-post.log 2>&1` passed renderer tests, MCP tests, server tests, lint, and build.
- next: Select `F-015` for a cross-platform desktop audit that maps macOS-only assumptions and creates the Windows, Intel Mac, and Linux support checklist without changing runtime behavior.
- blockers: none for `F-014`. Lint still reports the pre-existing 4 warnings and zero errors. The pre-existing local `electron/main.js` updater/menu diff was not part of this task and was left untouched.

## 2026-06-28 19:57 EDT — terminal: progressed
- did: Completed `F-015` by auditing Electron runtime code, renderer copy/layout assumptions, MCP
  behavior, release packaging config, release preflight, server download routes, README, and release
  docs for macOS-only and Apple-Silicon-only assumptions. Added
  `docs/superpowers/plans/2026-06-28-cross-platform-desktop-audit.md` with findings classified as
  runtime behavior, packaging config, docs/download page, test/preflight, and human-gated
  release/deploy work, then linked it from the style/platform/RN roadmap.
- evidence: `./init.sh > .autoloop/runs/init-20260628-current-pre.log 2>&1` passed before
  selection. `rg ... > .autoloop/runs/cross-platform-audit-f015-20260628.log 2>&1` captured the
  source scan. `./init.sh > .autoloop/runs/init-20260628-f015-post.log 2>&1` passed renderer tests,
  MCP tests, server tests, lint, and build.
- next: Select `F-016`; use the audit to fix one high-impact runtime platform fallback, preferably
  `mcp/markie-mcp.mjs` `markie_open_in_markie` or `electron/terminal.js` shell selection, with
  darwin/win32/linux tests.
- blockers: none for `F-015`. The pre-existing local `electron/main.js` updater/menu diff was not
  part of this task and was left untouched.

## 2026-07-03 23:22 EDT — terminal: progressed
- did: Completed a user-directed polish/review pass over default workspace setup, active theming,
  light-mode source editing, and review-driven security hardening. Files view now creates/registers
  the default `~/Documents/Markie` workspace on first use, CodeMirror follows the active theme tone
  instead of staying dark, the built-in light palette has clearer control hierarchy, modal scrims are
  theme-aware, side-panel actions reveal on keyboard focus, workspace reveal is root-guarded, and
  viewer live-collab clients can no longer apply Yjs document updates.
- evidence: `npm test` passed 13 files / 76 tests, including the new default workspace bootstrap
  tests and theme CSS-variable/source-editor theme tests. `node --experimental-strip-types --test
  server/src/collab.test.ts` passed 3 viewer/editor sync authorization tests. `npm run
  visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260704031946/audit.json`, sampling shell, rendered content,
  source editor, and overlay/panel surfaces. `./init.sh` passed renderer tests, MCP tests, server
  tests, lint, and build.
- next: Tackle the medium-severity Electron file IPC grant model from `BACKLOG.md`, or continue with
  first-run empty-state/product polish after the default workspace path has been verified in normal
  use.
- blockers: none for this pass. Lint still reports the pre-existing 4 warnings and zero errors.
  The pre-existing local `electron/main.js` updater/menu diff was not part of this task and was
  left untouched.

## 2026-07-03 23:47 EDT — terminal: progressed
- did: Completed a focused cross-platform runtime/share-scope pass. The in-app terminal now picks
  platform-aware shells for macOS, Windows, and Linux instead of assuming `/bin/zsh`; MCP
  `markie_open_in_markie` now chooses platform-specific open commands instead of hardcoding
  `open -a Markie`; Browse and Skills share a cross-platform home-path display helper for macOS,
  Linux, and Windows user homes; the live agent/MCP copy no longer says "this Mac"; and sharing
  access now has explicit read/edit/manage helpers while soft-deleted docs lose owner/share access.
  Also tightened CodeMirror gutter overrides after the visual guard caught a light-mode contrast
  regression.
- evidence: `npm test` passed 14 files / 86 tests. `node --test mcp/lib.test.mjs` passed 19 MCP
  tests. `(cd server && npm test)` passed 28 server tests, including the new share-access policy
  tests. `npm run lint` passed with the same 4 pre-existing warnings and zero errors. `npm run
  build` passed. `npm run visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260704034415/audit.json` plus screenshots. `./init.sh`
  passed renderer tests, MCP tests, server tests, lint, and build. For user inspection, a Markie
  Electron dev window was booted against this checkout via `http://localhost:3027` with CDP on
  `9224`.
- next: Continue toward full Windows/macOS support by adding local packaging matrix scripts/config,
  release-preflight checks for macOS arm64/x64 and Windows artifacts, updater/download manifest
  support, and the remaining medium-severity Electron file IPC grant hardening from `BACKLOG.md`.
- blockers: none for this pass. Full Windows/macOS release support is not complete until packaging,
  signing/notarization/code-signing, updater feeds, and download-page evidence exist. The
  pre-existing local `electron/main.js` updater/menu diff was not part of this task and was left
  untouched.

## 2026-07-04 00:01 EDT — terminal: progressed
- did: Completed a local-only desktop packaging matrix pass. Added generated Windows/Linux icon
  assets from the existing macOS `.icns`, introduced no-publish local packaging/build scripts for
  macOS arm64, macOS x64, Windows x64, and Linux x64, expanded electron-builder targets for that
  matrix, and taught `release:preflight` to validate required icons, scripts, and target coverage.
  `build/preflight.cjs` now logs explicit non-macOS smoke-check skip reporting instead of silently
  returning. README and release docs now describe current Apple Silicon public release status
  separately from source-level local platform readiness.
- evidence: `npm run icons:generate` regenerated `build/icon.ico` and `build/icons/*.png`.
  `npm test -- electron/release-preflight.test.ts` passed 4 preflight tests. `npm run
  release:preflight` passed and explicitly stopped before signing, notarization, upload, publish,
  deploy, or credential checks while validating `mac=2 win=2 linux=2` package targets. `npm run
  visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260704040031/audit.json` plus screenshots. `./init.sh`
  passed renderer tests, MCP tests, server tests, lint, and build.
- next: Add a repo-local download/platform manifest and update server download tests/routes to be
  manifest-driven, then harden the remaining medium-severity Electron file IPC grant model from
  `BACKLOG.md`.
- blockers: none for this pass. Full Windows/macOS release support is still not complete until
  native-host packaging is exercised, macOS Intel notarization, Windows code signing, updater feeds,
  and public download URLs are verified. The pre-existing local `electron/main.js` updater/menu diff
  was not part of this task and was left untouched.

## 2026-07-04 05:16 EDT — terminal: progressed
- did: Completed a local-only download manifest pass. Added `server/download-manifest.json` as the
  source of truth for public and planned desktop downloads, moved public artifact parsing into
  manifest-backed helpers, added `/download` and planned-platform unavailable pages, and updated
  public share pages plus invite email CTAs to read the primary download route/copy from the
  manifest. The server-rendered public pages now use light/dark CSS variables and matching
  highlight.js styles instead of a dark-only surface. `release:preflight` now requires the manifest.
- evidence: `(cd server && npm test)` passed 32 server tests, including manifest coverage for the
  public Apple Silicon macOS redirect and planned Windows route. `npm test --
  electron/release-preflight.test.ts` passed 4 release-preflight tests. `npm run
  release:preflight` passed renderer/electron tests, MCP tests, server tests, lint, and build while
  stopping before signing, notarization, upload, publish, deploy, or credential checks. `npm run
  visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260704041142/audit.json` plus screenshots. `./init.sh` passed
  renderer tests, MCP tests, server tests, lint, and build. `git diff --check` passed.
- next: Harden the remaining medium-severity Electron file IPC grant model from `BACKLOG.md`, then
  exercise native-host packaging on macOS Intel and Windows hosts before any public release claim.
- blockers: none for this pass. Full Windows/macOS release support is still blocked on native-host
  artifact verification, macOS Intel notarization, Windows code signing, updater feeds, approved
  public download URLs, and human-gated publishing/deploy work. The pre-existing local
  `electron/main.js` updater/menu diff was not part of this task and was left untouched.

## 2026-07-04 12:56 EDT — terminal: progressed
- did: Completed the medium-severity Electron file IPC grant hardening pass. Added a main-owned
  file grant helper for dialog, OS-open, dropped-file, shared/cloud-download, and workspace-root
  grants. `open-file-path`, `save-file`, `rename-file`, and `registry-track` now validate renderer
  paths against those grants, reject unsupported extensions, refuse rename traversal, canonicalize
  symlinks, and preserve grants across Save As / cloud pull / same-directory rename flows. Closed
  the corresponding `BACKLOG.md` security item with evidence.
- evidence: `node --check electron/main.js`, `node --check electron/preload.js`, and
  `node --check electron/file-grants.js` passed. `npm test -- electron/file-grants.test.ts` passed
  7 focused grant tests. `npm test` passed 15 renderer/Electron test files / 94 tests. `./init.sh`
  passed renderer/Electron tests, MCP tests, server tests, lint, and build. `npm run
  visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260704165637/audit.json` plus screenshots.
- next: Continue the full-goal audit by exercising native-host packaging on supported platforms
  when available, and keep polishing the library/default workspace UX only where real-user flow
  evidence shows friction.
- blockers: none for this pass. Full Windows/macOS release support is still not complete until
  native-host artifacts, macOS Intel notarization, Windows code signing, updater feeds, approved
  public download URLs, and human-gated publishing/deploy work are verified. The pre-existing
  updater/menu edits in `electron/main.js` were preserved and not intentionally included in this
  security change.

## 2026-07-04 13:27 EDT — terminal: progressed
- did: Completed a local package smoke evidence pass. Added a cross-platform unpacked package smoke
  checker for macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64 layouts, plus local
  `electron:smoke:*` scripts and focused tests. Added a credential-stripping
  `scripts/local-electron-builder.mjs` wrapper so local package/build scripts use
  `CSC_IDENTITY_AUTO_DISCOVERY=false` and `-c.mac.identity=null` for macOS instead of silently
  selecting the Developer ID certificate. Updated release docs, README, perf-check usage, and the
  cross-platform audit plan to use the package smoke contract.
- evidence: `node --check scripts/local-electron-builder.mjs`,
  `node --check scripts/package-smoke.mjs`, `node --check scripts/release-preflight.mjs`, and
  `node --check scripts/perf-check.mjs` passed. `npm test --
  electron/local-electron-builder.test.ts electron/package-smoke.test.ts
  electron/release-preflight.test.ts` passed 3 files / 12 tests. `npm run release:preflight` passed
  17 renderer/Electron test files / 102 tests, 19 MCP tests, 32 server tests, lint with the same 4
  warnings and zero errors, and static build. `npm run electron:pack:mac:arm64` passed with the
  macOS window smoke gate loading `Markie — Markdown Viewer` and skipped Developer ID signing due
  `mac.identity=null`. `npm run electron:smoke:mac:arm64` passed against
  `dist/mac-arm64/Markie.app` and reported host-native `mac/arm64`. `codesign -dv
  dist/mac-arm64/Markie.app` reported `Signature=adhoc` and `TeamIdentifier=not set`, confirming it
  is not a Developer ID release build. `npm run visual:guard:theme` passed with zero findings and
  wrote `.autoloop/runs/light-mode-audit-20260704172441/audit.json` plus screenshots. `./init.sh`
  passed renderer/Electron tests, MCP tests, server tests, lint, and build. `git diff --check`
  passed.
- next: Exercise macOS Intel packaging on a matching host or Rosetta-verified path, then Windows x64
  and Linux x64 package/smoke checks on matching hosts. Keep public Windows/Intel Mac/Linux download
  routes planned until signing, updater feeds, public URLs, and human-gated release approval are
  complete.
- blockers: none for local Apple Silicon package evidence. Full Windows/macOS release support is
  still not complete until native-host artifacts, macOS Intel notarization, Windows code signing,
  updater feeds, approved public download URLs, and human-gated publishing/deploy work are verified.
  The pre-existing updater/menu edits in `electron/main.js` were preserved and not intentionally
  included in this package-smoke change.

## 2026-07-04 13:50 EDT — terminal: progressed
- did: Completed a macOS Intel package evidence pass on the Apple Silicon host. Taught
  `scripts/package-smoke.mjs` to report macOS x64 artifacts as host-compatible when Rosetta is
  available, then built the Intel unpacked app through the certificate-free local wrapper. Updated
  release docs and the cross-platform audit plan to reflect that Intel macOS can be locally
  launch-smoked through Rosetta, while Windows/Linux still require matching host launch evidence.
- evidence: `arch -x86_64 /usr/bin/true` passed and `rosetta-oahd-running` was present.
  `node --check scripts/package-smoke.mjs` passed. `npm test --
  electron/package-smoke.test.ts electron/release-preflight.test.ts` passed 2 files / 10 tests.
  `npm run electron:pack:mac:x64` passed after downloading `electron-v41.0.2-darwin-x64.zip`;
  the local wrapper printed `CSC_IDENTITY_AUTO_DISCOVERY=false` and `mac.identity=null`, the
  `build/preflight.cjs` window smoke gate loaded `Markie — Markdown Viewer`, and electron-builder
  skipped macOS code signing because identity was explicitly null. `npm run electron:smoke:mac:x64`
  passed against `dist/mac/Markie.app` and reported host-compatible Rosetta execution. `file` and
  `lipo -archs dist/mac/Markie.app/Contents/MacOS/Markie` reported `x86_64`. `codesign -dv
  dist/mac/Markie.app` reported `code object is not signed at all`. `npm run release:preflight`
  passed 17 renderer/Electron test files / 103 tests, 19 MCP tests, 32 server tests, lint with the
  same 4 warnings and zero errors, and static build.
- next: Exercise Windows x64 and Linux x64 package/smoke checks on matching hosts or CI runners.
  Keep public Windows/Linux routes planned until signing, updater feeds, public URLs, and
  human-gated release approval are complete.
- blockers: none for local macOS Intel package evidence. Full Windows support is still not complete
  until Windows x64 native-host package evidence, code signing, updater feeds, public download URLs,
  and human-gated release work are verified. The pre-existing updater/menu edits in
  `electron/main.js` were preserved and not intentionally included in this macOS Intel pass.

## 2026-07-04 14:31 EDT — terminal: progressed
- did: Completed a Windows x64 unpacked package structure/native-payload evidence pass. Strengthened
  `scripts/package-smoke.mjs` so Windows artifacts must include `Markie.exe`, `app.asar`, bundled
  MCP files, `better-sqlite3`, and Windows x64 `node-pty` native payloads, and those executable
  payloads must be Windows PE/MZ binaries. Added `scripts/install-win-native-prebuild.mjs` to fetch
  the Electron 41 `better-sqlite3` Windows x64 prebuild into a temporary package copy and install
  only the resulting PE `.node` file into `dist/win-unpacked`, leaving the Mac development
  `node_modules` intact. Updated local Windows package scripts/docs/preflight expectations.
- evidence: `node --check scripts/install-win-native-prebuild.mjs scripts/local-electron-builder.mjs
  scripts/package-smoke.mjs scripts/release-preflight.mjs` passed. `npm test --
  electron/local-electron-builder.test.ts electron/package-smoke.test.ts
  electron/release-preflight.test.ts` passed 3 files / 16 tests. The stricter smoke initially caught
  the cross-package bug: `dist/win-unpacked/.../better_sqlite3.node` was `Mach-O 64-bit bundle
  x86_64` instead of PE. After adding the prebuild installer, `npm run electron:pack:win` passed
  with `CSC_IDENTITY_AUTO_DISCOVERY=false`, `win.signAndEditExecutable=false`, `--publish never`,
  and no signtool step; it installed the Electron 41.0.2 win32-x64 `better-sqlite3` prebuild.
  `npm run electron:smoke:win` passed against `dist/win-unpacked` and reported structure-only host
  mode because the current host is `mac/arm64`. `file` reported `Markie.exe`, `better_sqlite3.node`,
  and the Windows x64 `node-pty` `.node` files as PE32+ x86-64 Windows payloads. `dist/win-unpacked`
  is 690M and contains the expected MCP files. `npm run release:preflight` passed 17
  renderer/Electron test files / 106 tests, 19 MCP tests, 32 server tests, lint with the same 4
  warnings and zero errors, and static build. `./init.sh` passed the same renderer/Electron test
  suite, MCP tests, server tests, lint, and build.
- next: Run the Windows x64 unpacked app on a Windows host/CI runner to prove OS-level launch and
  renderer load, then add code signing, update feed, public download URLs, and human-gated release
  approval before changing public Windows status from planned.
- blockers: none for local Windows package structure evidence. Full Windows support remains
  incomplete until native Windows launch evidence, code signing, updater feeds, public download URLs,
  and human-gated release work are verified. The pre-existing updater/menu edits in
  `electron/main.js` were preserved and not intentionally included in this Windows package pass.

## 2026-07-04 14:56 EDT — terminal: progressed
- did: Added a Windows-host native launch smoke path without changing signing, publishing, upload,
  deploy, or release credentials. `scripts/windows-launch-smoke.mjs` runs only on `win32`, resolves
  `dist/win-unpacked/Markie.exe`, launches it with an isolated profile and CDP port, and validates
  the packaged renderer title/readiness/visible Markie UI. Added `electron:smoke:win:launch`,
  focused launch-smoke tests, release-preflight requirements, docs, and
  `.github/workflows/windows-launch-smoke.yml` so `windows-latest` can build, structure-smoke, and
  launch-smoke the unsigned Windows x64 unpacked package.
- evidence: `node --check scripts/windows-launch-smoke.mjs` and
  `node --check scripts/release-preflight.mjs` passed. `npm test --
  electron/windows-launch-smoke.test.ts electron/release-preflight.test.ts` passed 2 files / 9
  tests. `npm run release:preflight` passed 18 renderer/Electron test files / 111 tests, 19 MCP
  tests, 32 server tests, lint with the same 4 warnings and zero errors, and static build.
  `npm run electron:smoke:win` passed against `dist/win-unpacked` and correctly reported
  structure-only host mode on this Mac. `git diff --check` passed. `./init.sh` passed renderer /
  Electron tests, MCP tests, server tests, lint, and build.
- next: Run the `Windows launch smoke` workflow or `npm run electron:smoke:win:launch` on an actual
  Windows host to collect native launch evidence, then keep Windows public release work behind code
  signing, updater feed, public URL, and human approval gates.
- blockers: Native Windows launch has a repo-owned host-runner path but was not executed on this
  Mac because the command is intentionally `win32`-only. Full Windows support remains incomplete
  until that Windows-host launch run, code signing, updater feeds, public download URLs, and
  human-gated release work are verified. The pre-existing updater/menu edits in `electron/main.js`
  were preserved and not intentionally included in this pass.

## 2026-07-04 15:44 EDT — terminal: progressed
- did: Completed the remaining `F-016` external-terminal runtime platform slice. Replaced the
  macOS-only external terminal discovery/launch path with platform-aware candidates for macOS,
  Windows, and Linux while preserving the renderer-supplied app-name allowlist. Windows now exposes
  detected Windows Terminal plus PowerShell and Command Prompt, Linux exposes `$TERMINAL` plus
  detected common terminal emulators, and launch commands use `spawn` argument arrays with
  `shell:false`. The hidden terminal renderer tab label now says `Shell` instead of hardcoded `zsh`.
- evidence: `node --check electron/terminal.js` passed. `npm test -- electron/terminal.test.ts`
  passed 1 file / 18 tests, including shell selection, Markie context, command detection,
  Windows/Linux external terminal choices, guarded renderer-supplied app names, unavailable terminal
  handling, and neutral shell labels. `git diff --check` passed. `./init.sh` passed 18
  renderer/Electron test files / 118 tests, 19 MCP tests, 32 server tests, lint with the same 4
  warnings and zero errors, and static build.
- next: Continue `F-017`/release readiness or the remaining goal surfaces: Windows-host launch
  evidence, signing/feed/public URL gates, library organization, sharing permission UX, and live UI
  verification.
- blockers: none for this runtime slice. Full Windows support remains incomplete until the
  Windows-host launch smoke actually runs and human-gated signing, updater feeds, public URLs, and
  release approval are complete. The pre-existing updater/menu edits in `electron/main.js` were
  preserved and not intentionally included in this pass.

## 2026-07-04 15:54 EDT — terminal: progressed
- did: Fixed the live Library/default-workspace blocker caused by cross-architecture local packaging
  leaving root `node_modules/better-sqlite3` as an x86_64 native module on the arm64 Electron host.
  Added `scripts/restore-host-native-prebuild.mjs`, exposed `npm run native:restore`, and wired
  `scripts/local-electron-builder.mjs` to restore the host Electron native prebuild after
  cross-platform or cross-arch package/build commands. Added Library load error handling so IPC
  failures no longer leave the panel stuck on `Loading...`; they settle to an empty state with a
  readable notice.
- evidence: Live Electron/CDP initially showed `libraryState` and `wsRoots` failing with
  `better_sqlite3.node` as `x86_64` while the app needed `arm64`. `npm run native:restore` restored
  the Electron 41.0.2 `darwin-arm64` prebuild, and `file
  node_modules/better-sqlite3/build/Release/better_sqlite3.node` reported `Mach-O 64-bit bundle
  arm64`. Focused tests `npm test -- electron/local-electron-builder.test.ts
  electron/release-preflight.test.ts src/lib/library-state.test.ts src/lib/workspace-default.test.ts`
  passed 4 files / 15 tests. Live Electron/CDP then showed `libraryState` returning
  `{ signedIn:false, items:[] }`, `wsCreateDefault` returning `/Users/macbookpro-kirby/Documents/Markie`,
  `wsRoots` containing that default path, and the real Files tab displaying `MARKIE`, `empty`, and no
  `Loading...`.
- next: Run full verification and commit this bugfix. Continue toward Windows-host launch evidence,
  sharing permission UX, and broader library organization once this regression is locked.
- blockers: none for this bugfix. The pre-existing updater/menu edits in `electron/main.js` were
  preserved and not intentionally included in this pass.

## 2026-07-04 20:12 EDT — terminal: progressed
- did: Completed the server-truth share permission gating slice. Added a read-gated
  `/api/docs/:id/access` summary backed by the same share permission helpers used across docs,
  comments, themes, and collaboration. The renderer now fetches that access summary separately from
  the share list, and `ShareDialog` gates invite, remove, public-link create/revoke, and theme-pin
  management UI from `access.canManage` instead of inferring ownership from share-list membership.
  Non-managers see their current access role and lose owner-only controls.
- evidence: `node --experimental-strip-types --test server/src/share-access.test.ts` passed 4 tests
  covering owner, editor, viewer, stranger, and deleted-doc summaries. `npm run build`, `npm run
  lint`, and `./init.sh` passed; lint still reports the existing 4 warnings in `mcp/lib.mjs` and
  `src/app/page.tsx`. `npm run visual:guard:theme` passed with zero findings across shell, content,
  and overlay/panel categories. Live Electron/CDP showed `Markie — Markdown Viewer`, complete
  readiness, no loading state, visible editor chrome, the Library panel showing the default `MARKIE`
  root with `empty`, and light/dark theme buttons changing renderer colors from `rgb(248, 250,
  252)`/`rgb(24, 24, 27)` to `rgb(9, 9, 11)`/`rgb(250, 250, 250)`.
- next: Continue the larger goal with real authenticated owner/editor/viewer share-dialog sessions,
  broader Library organization polish, Windows-host launch evidence, signing/feed/public URL gates,
  and the remaining premium UI passes.
- blockers: none for this permission-gating slice. Real multi-user browser sessions were not run in
  this pass. The pre-existing updater/menu edits in `electron/main.js` were preserved and not
  intentionally included.

## 2026-07-04 20:17 EDT — terminal: progressed
- did: Completed a narrow main-page cleanup pass. Added the missing stable dependencies to the
  keyboard, Electron IPC, and command palette hook arrays in `src/app/page.tsx`, preserving the
  once-registered handler-ref pattern for Electron menu callbacks. Removed a stale MCP
  `eslint-disable` that no longer suppressed an actual constant-condition warning.
- evidence: `npm run lint` exits cleanly with zero warnings. `node --test mcp/lib.test.mjs` passed
  19 MCP tests. `npm run build` passed. `./init.sh` passed 19 renderer/Electron test files / 122
  tests, 19 MCP tests, 33 server tests, lint, and static build. Live Electron/CDP after the cleanup
  showed `Markie — Markdown Viewer`, complete readiness, no loading state, a visible Library
  button, and the active dark theme class.
- next: Continue premium UI/product work with authenticated share-dialog sessions, Library
  organization polish, and remaining desktop release evidence that does not require human-gated
  signing or publishing.
- blockers: none for this cleanup. The pre-existing updater/menu edits in `electron/main.js` were
  preserved and not intentionally included.

## 2026-07-04 20:26 EDT — terminal: progressed
- did: Polished the Files workspace empty state. The default workspace root now shows a small
  `Default` badge when it matches the default path, and an empty top-level workspace renders a
  compact theme-aware panel with `New file` and `New folder` actions instead of a bare `empty`
  label. Nested empty folders still stay compact.
- evidence: `npm run lint` passed with zero warnings. `npm run build` passed. Live Electron/CDP on
  the actual Library panel showed the `Default` badge, `New file`, `New folder`, and no loading
  state. `npm run visual:guard:theme` passed with zero findings across shell, content, and
  overlay/panel categories. `./init.sh` passed 19 renderer/Electron test files / 122 tests, 19 MCP
  tests, 33 server tests, lint, and static build.
- next: Continue premium UI/product work with authenticated share-dialog sessions, broader Library
  organization polish, and remaining desktop release evidence that does not require signing or
  publishing.
- blockers: none for this UI pass. The pre-existing updater/menu edits in `electron/main.js` were
  preserved and not intentionally included.

## 2026-07-04 20:45 EDT — terminal: progressed
- did: Closed `F-017` with fresh platform-packaging evidence. Confirmed the existing local-only
  packaging matrix covers Apple Silicon macOS, Intel macOS, Windows x64, and Linux x64 dry-run
  targets through `scripts/local-electron-builder.mjs`, with publishing disabled by default and
  release actions still human-gated.
- evidence: `npm test -- electron/local-electron-builder.test.ts electron/release-preflight.test.ts
  electron/package-smoke.test.ts` passed 3 files / 17 tests. `npm run release:preflight` passed,
  validated required release files, reported packaging matrix `mac=2 win=2 linux=2`, ran
  renderer/Electron tests, MCP tests, server tests, lint, and static build, and ended with the
  explicit stop before signing, notarization, upload, publish, deploy, or credential checks.
  `./init.sh` passed 19 renderer/Electron test files / 122 tests, 19 MCP tests, 33 server tests,
  lint, and static build. `feature_list.json` now marks `F-017` passing with this evidence.
- next: Continue `F-018` release-doc/preflight clarity, authenticated share-dialog sessions,
  broader Library organization polish, and native Windows launch/signing/feed/public URL gates.
- blockers: none for local dry-run packaging config. Full public platform support still requires
  native Windows launch evidence and human-gated signing, notarization, update-feed, download URL,
  and release approval work. The pre-existing updater/menu edits in `electron/main.js` were
  preserved and not intentionally included.

## 2026-07-04 20:50 EDT — terminal: progressed
- did: Closed `F-018` by turning release-doc clarity into a preflight-checked contract. Expanded
  `docs/RELEASING.md` with a per-platform local artifact table covering Apple Silicon macOS, Intel
  macOS, Windows x64, and Linux x64 pack/build commands, expected artifact patterns, and required
  verification commands. `scripts/release-preflight.mjs` now validates that the release guide keeps
  those platform commands, artifact patterns, smoke commands, and local-only release gates visible.
- evidence: `npm test -- electron/release-preflight.test.ts` passed 1 file / 5 tests. `npm run
  release:preflight` passed, reporting required files ok, packaging matrix `mac=2 win=2 linux=2`,
  release docs ok with 15 required snippets, renderer/Electron tests 19 files / 123 tests, MCP
  tests 19 tests, server tests 33 tests, lint, static build, and the explicit stop before signing,
  notarization, upload, publish, deploy, or credential checks. `./init.sh` passed 19
  renderer/Electron test files / 123 tests, 19 MCP tests, 33 server tests, lint, and static build.
  `feature_list.json` now marks `F-018` passing with this evidence.
- next: Continue `F-019`/`F-020` download manifest and public-facing download copy, authenticated
  share-dialog sessions, broader Library organization polish, and native Windows launch/signing/feed
  gates.
- blockers: none for docs/preflight clarity. Public platform support still requires native Windows
  launch evidence and human-gated signing, notarization, update-feed, public URL, and release
  approval work. The pre-existing updater/menu edits in `electron/main.js` were preserved and not
  intentionally included.

## 2026-07-04 20:53 EDT — terminal: progressed
- did: Closed `F-019` by completing the repo-local download manifest contract. Planned Intel Mac,
  Windows x64, and Linux x64 entries now include artifact filename patterns alongside labels,
  routes, status, and descriptions. The manifest loader now rejects any platform missing an artifact
  pattern while still requiring live feeds only for public platforms.
- evidence: `node --experimental-strip-types --test server/src/public.test.ts` passed 6 tests,
  covering all four desktop manifest entries, public macOS feed redirect, and honest planned-route
  placeholders. An initial parallel `release:preflight`/`./init.sh` run collided at the Next static
  build lock; rerunning sequentially fixed the command-shape issue. `npm run release:preflight`
  then passed renderer/Electron tests 19 files / 123 tests, MCP tests 19 tests, server tests 33
  tests, lint, static build, and the explicit local-only release stop. `./init.sh` passed 19
  renderer/Electron test files / 123 tests, 19 MCP tests, 33 server tests, lint, and static build.
  `feature_list.json` now marks `F-019` passing with this evidence.
- next: Continue `F-020` public-facing download copy, authenticated share-dialog sessions, broader
  Library organization polish, and native Windows launch/signing/feed gates.
- blockers: none for the manifest source of truth. Public planned routes still intentionally remain
  unavailable until human-gated signed artifacts, update feeds, public URLs, and release approval are
  complete. The pre-existing updater/menu edits in `electron/main.js` were preserved and not
  intentionally included.

## 2026-07-04 20:58 EDT — terminal: progressed
- did: Closed `F-020` by updating the repo-owned public download page renderer. `server/src/render.ts`
  now presents all manifest-backed desktop platforms with visible artifact patterns and route
  details, while planned Intel Mac, Windows, and Linux cards remain unavailable placeholders instead
  of links to unpublished files.
- evidence: `node --experimental-strip-types --test server/src/render.test.ts server/src/public.test.ts`
  passed 16 tests covering platform names, routes, artifact patterns, planned placeholders, and the
  public macOS feed redirect. `npm run release:preflight` passed renderer/Electron tests 19 files /
  123 tests, MCP tests 19 tests, server tests 33 tests, lint, static build, and the explicit
  local-only release stop. `./init.sh` passed 19 renderer/Electron test files / 123 tests, 19 MCP
  tests, 33 server tests, lint, and static build. `feature_list.json` now marks `F-020` passing with
  this evidence.
- next: Continue authenticated share-dialog sessions, broader Library organization polish, native
  Windows launch evidence, and human-gated signing/feed/public URL release work.
- blockers: none for repo-owned download-page copy. No production deploy was performed. Public
  planned platform downloads intentionally remain unavailable until release approval and artifacts
  exist. The pre-existing updater/menu edits in `electron/main.js` were preserved and not
  intentionally included.

## 2026-07-04 21:26 EDT — terminal: progressed
- did: Hardened the Windows packaged launch evidence and removed the renderer build's remote font
  dependency. `scripts/windows-launch-smoke.mjs` now writes self-contained `launch-smoke.json`
  evidence with host, package, app, CDP target, renderer probe, and validation metadata while
  preserving the existing top-level compatibility fields. The Next renderer now uses repo-owned
  native font variables instead of `next/font/google`, so production builds no longer need a live
  Google Fonts fetch.
- evidence: `node --check scripts/windows-launch-smoke.mjs` passed.
  `npm test -- electron/windows-launch-smoke.test.ts electron/release-preflight.test.ts` passed 2
  files / 11 tests. `npm run release:preflight` passed renderer/Electron tests 19 files / 124
  tests, MCP tests 19 tests, server tests 33 tests, lint, static build, and the explicit local-only
  release stop. `./init.sh` passed 19 renderer/Electron test files / 124 tests, 19 MCP tests, 33
  server tests, lint, and static build. Live Electron CDP verification captured dark and light theme
  screenshots, confirmed `Markie — Markdown Viewer`, complete ready state, no loading text, and the
  native font stack in computed styles.
- next: Continue authenticated share-dialog sessions, broader Library organization polish, native
  Windows workflow execution evidence, and human-gated signing/feed/public URL release work.
- blockers: The richer Windows launch artifact is ready for the GitHub/Windows host, but native
  Windows workflow evidence was not executed from this Mac. Signing, notarization, update feeds,
  public URLs, deploy, upload, and release approval remain human-gated. The pre-existing
  updater/menu edits in `electron/main.js` were preserved and not intentionally included.

## 2026-07-04 22:22 EDT — terminal: progressed
- did: Polished the Library Recent view with a compact document-status overview. The panel now
  summarizes device-local, synced, shared, cloud-only, and attention-needed documents without
  affecting the Files workspace, and the empty Recent state now offers direct `Open file` and
  `Files` actions instead of a paragraph.
- evidence: `npm test -- src/lib/library-overview.test.ts src/lib/library-state.test.ts
  src/lib/workspace-default.test.ts` passed 3 files / 8 tests. `npm run lint` passed. `npm run
  build` passed. `npm run visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260705022006/audit.json`. `./init.sh` passed 20
  renderer/Electron test files / 126 tests, 19 MCP tests, 33 server tests, lint, and static build.
  Live Electron/CDP after restarting the preview confirmed `DOCUMENTS`, `DEVICE`, `SYNCED`,
  `SHARED`, `No recent files`, complete ready state, dark theme, and no loading/error text.
- next: Continue authenticated share-dialog sessions, native Windows workflow execution evidence,
  and human-gated signing/feed/public URL release work.
- blockers: none for this Library polish. Native Windows launch still needs a Windows host/workflow
  run, and signing, notarization, update feeds, public URLs, deploy, upload, and release approval
  remain human-gated. The pre-existing updater/menu edits in `electron/main.js` were preserved and
  not intentionally included.

## 2026-07-04 22:30 EDT — terminal: progressed
- did: Tightened Share dialog permission clarity. The dialog now shows a server-derived `Your
  access` summary with role plus Read/Edit/Manage capability chips, using `/api/docs/:id/access`
  truth instead of inferring from the member list. Owner-only controls remain gated by
  `access.canManage`.
- evidence: `npm test -- src/lib/share-access-view.test.ts` passed 1 file / 4 tests.
  `node --experimental-strip-types --test server/src/share-access.test.ts
  server/src/shared-by-me.test.ts` passed 7 server share tests. `npm run lint` passed. `npm run
  build` passed. `npm run visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260705022844/audit.json`. `./init.sh` passed 21
  renderer/Electron test files / 130 tests, 19 MCP tests, 33 server tests, lint, and static build.
- next: Continue native Windows workflow execution evidence and human-gated signing/feed/public URL
  release work.
- blockers: Authenticated real-account invite/remove sessions still require valid local auth state,
  and native Windows launch still needs a Windows host/workflow run. Signing, notarization, update
  feeds, public URLs, deploy, upload, and release approval remain human-gated. The pre-existing
  updater/menu edits in `electron/main.js` were preserved and not intentionally included.

## 2026-07-04 22:36 EDT — terminal: progressed
- did: Made the Windows launch-smoke workflow automatic once release-relevant changes reach `main`.
  `.github/workflows/windows-launch-smoke.yml` now keeps manual dispatch and PR coverage while also
  running on `push` to `main` for the same desktop/release paths. `release:preflight` now validates
  that the workflow remains dispatchable, push-triggered, path-filtered, Windows-hosted, and runs
  pack, structure smoke, launch smoke, and evidence upload steps.
- evidence: `node --check scripts/release-preflight.mjs` passed. `npm test --
  electron/release-preflight.test.ts` passed 1 file / 6 tests. `npm run release:preflight` passed
  renderer/Electron tests 21 files / 131 tests, MCP tests 19 tests, server tests 33 tests, lint,
  static build, and reported `Windows launch workflow ok: 10 watched paths`.
- next: Continue native Windows workflow execution after the branch is published, and human-gated
  signing/feed/public URL release work.
- blockers: This Mac still cannot produce native Windows launch evidence locally, and the workflow
  will not run on GitHub until the ahead local commits are pushed. Signing, notarization, update
  feeds, public URLs, deploy, upload, and release approval remain human-gated. The pre-existing
  updater/menu edits in `electron/main.js` were preserved and not intentionally included.

## 2026-07-04 22:53 EDT — terminal: progressed
- did: Fixed the default Library bootstrap gap. The Library startup path now creates the default
  `~/Documents/Markie` workspace before the user visits Files, records the workspace result beside
  the library snapshot, and renders an empty Recent state as `Workspace ready` with the compact
  default path when the root is available. Existing local Library items still render if workspace
  creation fails.
- evidence: `npm test -- src/lib/library-startup.test.ts src/lib/workspace-default.test.ts
  src/lib/library-state.test.ts` passed 3 files / 9 tests. `npm run lint` passed. `npm run build`
  passed. `npm run visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260705024544/audit.json`. Live Electron/CDP against the real
  desktop app wrote `.autoloop/runs/library-startup-check-20260704224634/actual-check.json` with
  `ok: true`, `roots: ["/Users/macbookpro-kirby/Documents/Markie"]`, and dark/light screenshots
  showing `Workspace ready`. A detached built Electron preview remains open at `app://markie/index.html`
  with the Library panel visible.
- next: Continue native Windows workflow execution after the branch is published, authenticated
  real-account share invite/remove sessions, and human-gated signing/feed/public URL release work.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signing, notarization, update feeds, public URLs, deploy, upload, and release approval
  remain human-gated. Authenticated share management with real accounts still needs valid local auth
  state. The pre-existing updater/menu edits in `electron/main.js` were preserved and not
  intentionally included.

## 2026-07-04 22:59 EDT — terminal: progressed
- did: Tightened the Share dialog's visible permission contract so it matches server-scoped actions.
  The access summary now shows `Comment` as its own capability derived from the server's edit
  permission, and viewer copy now says viewers can view only while commenting, editing, and owner
  controls remain locked. Server coverage now records that comment writing follows edit permission,
  not read permission.
- evidence: `npm test -- src/lib/share-access-view.test.ts` passed 1 file / 4 tests.
  `node --experimental-strip-types --test server/src/share-access.test.ts server/src/collab.test.ts`
  passed 8 server permission/collab tests. `npm run lint` passed. `npm run build` passed.
  `npm run visual:guard:theme` passed with zero findings and wrote
  `.autoloop/runs/light-mode-audit-20260705025919/audit.json`.
- next: Continue native Windows workflow execution after the branch is published, authenticated
  real-account share invite/remove sessions, and human-gated signing/feed/public URL release work.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signing, notarization, update feeds, public URLs, deploy, upload, and release approval
  remain human-gated. Authenticated share invite/remove with real accounts still needs valid local
  auth state. The pre-existing updater/menu edits in `electron/main.js` were preserved and not
  intentionally included.

## 2026-07-04 23:05 EDT — terminal: progressed
- did: Took ownership of the Electron desktop update/menu lane. Manual `Check for Updates…` now
  routes through the same update state machine as automatic checks, dev/unpackaged builds explain
  that updates require a packaged release build, already-downloaded updates offer `Restart & Update`,
  and the View menu only exposes DevTools in development. Release preflight now validates these
  Electron main-process desktop-support invariants.
- evidence: `node --check scripts/release-preflight.mjs` passed. `npm test --
  electron/release-preflight.test.ts` passed 1 file / 7 tests. `node --check electron/main.js`
  passed. `npm run release:preflight` passed, including renderer/Electron tests 22 files / 135
  tests, MCP tests 19 tests, server tests 34 tests, lint, static build, and `Electron desktop
  support ok: 11 snippets`.
- next: Continue native Windows workflow execution after the branch is published, authenticated
  real-account share invite/remove sessions, and human-gated signing/feed/public URL release work.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated. Authenticated share invite/remove with real accounts still needs
  valid local auth state.

## 2026-07-04 23:13 EDT — terminal: progressed
- did: Converted the authenticated share invite/remove blocker into local route coverage. Added a
  temp-SQLite Hono route test that runs Better Auth migrations, signs up local users, creates a doc,
  adds and removes an existing viewer, creates/removes pending email invites, proves pending invites
  claim into editor access on signup, and verifies public-link management remains owner-scoped while
  members can only read the current link. Also set explicit test auth secrets in auth-importing
  server tests to keep local auth checks deterministic.
- evidence: `node --experimental-strip-types --test server/src/share-routes.test.ts` passed 1 test.
  `(cd server && npm test)` passed 35 tests. `npm run lint` passed. `npm test --
  src/lib/share-access-view.test.ts` passed 1 file / 4 tests. `npm run release:preflight` passed,
  including renderer/Electron tests 22 files / 135 tests, MCP tests 19 tests, server tests 35
  tests, lint, static build, Windows workflow checks, Electron desktop support checks, and release
  docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.
