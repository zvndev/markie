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
  `{ signedIn:false, items:[] }`, `wsCreateDefault` returning `~/Documents/Markie`,
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
  `ok: true`, `roots: ["~/Documents/Markie"]`, and dark/light screenshots
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

## 2026-07-04 23:29 EDT — terminal: progressed
- did: Tightened the first visible editor surface. Replaced the generic `Welcome to Markie` sample
  with a product-neutral sprint brief that still exercises headings, strong text, links, inline
  code, fenced code, tables, task lists, blockquotes, and math contrast targets. Reworked the rich
  editor format rail from raw mixed glyph labels toward stable icon-like controls with explicit
  accessible labels, while keeping the existing TipTap commands unchanged.
- evidence: Actual Electron app inspected through Computer Use at `app://markie/index.html` in both
  dark and light mode. `npm run lint` passed. `npm test -- src/lib/color-mode.test.ts
  src/lib/theme.test.ts` passed 2 files / 12 tests. `npm run build` passed. `npm run
  visual:guard:theme` passed with zero findings and all shell/content/overlay guard categories
  passing. `npm run release:preflight` passed, including renderer/Electron tests 22 files / 135
  tests, MCP tests 19 tests, server tests 35 tests, lint, static build, Windows workflow checks,
  Electron desktop support checks, and release docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:19 EDT — terminal: progressed
- did: Added a host-native packaged desktop launch smoke for mac artifacts. The script reuses the
  package layout verifier, rejects structure-only host mismatches, launches a compatible unpacked
  Electron app with a temporary profile and CDP port, probes the renderer for real Markie UI, and
  writes a launch evidence artifact. Release preflight and release docs now require the mac launch
  smoke alongside the existing Windows launch smoke path.
- evidence: `npm test -- electron/desktop-launch-smoke.test.ts electron/package-smoke.test.ts
  electron/release-preflight.test.ts` passed 3 files / 18 tests. `npm run
  electron:pack:mac:arm64` built a fresh unsigned `dist/mac-arm64/Markie.app` and its afterPack
  window smoke loaded `Markie — Markdown Viewer`. `npm run electron:smoke:mac:arm64` passed with
  host mode `host-native`. `npm run electron:smoke:mac:launch` launched
  `dist/mac-arm64/Markie.app/Contents/MacOS/Markie`, connected over CDP, and validated
  `Markie — Markdown Viewer` at `document.readyState=complete` with editor content present.
  `npm run release:preflight` passed, including renderer/Electron tests 23 files / 138 tests, MCP
  tests 19 tests, server tests 35 tests, lint, static build, Windows workflow checks, Electron
  desktop support checks, and release docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:24 EDT — terminal: progressed
- did: Added visual proof to packaged desktop launch evidence. Both the generic desktop launch smoke
  and the Windows launch smoke now capture `screenshot.png` through CDP after the renderer probe
  passes, persist it beside `launch-smoke.json`, and include screenshot metadata in the JSON
  artifact. The Windows GitHub workflow now uploads both files, and release preflight requires the
  screenshot path in the workflow/docs contract. README and release docs now list the mac launch
  smoke and explain that native launch evidence includes the screenshot.
- evidence: `node --check scripts/windows-launch-smoke.mjs` passed. `node --check
  scripts/desktop-launch-smoke.mjs` passed. `npm test -- electron/desktop-launch-smoke.test.ts
  electron/windows-launch-smoke.test.ts electron/release-preflight.test.ts` passed 3 files / 16
  tests. `npm run electron:smoke:mac:launch` launched
  `dist/mac-arm64/Markie.app/Contents/MacOS/Markie`, validated `Markie — Markdown Viewer` at
  `document.readyState=complete`, and wrote a 2560x1640 PNG screenshot with the polished
  Northstar Sprint Brief editor visible. `npm run release:preflight` passed, including
  renderer/Electron tests 23 files / 138 tests, MCP tests 19 tests, server tests 35 tests, lint,
  static build, Windows workflow checks, Electron desktop support checks, and release docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:31 EDT — terminal: progressed
- did: Hardened cross-platform desktop launch intent handling and fixed a real local Windows
  packaging regression. Extracted side-effect-free desktop intent helpers for Markie deep links,
  openable file argv/file-URL inputs, and macOS-only default Markdown registration support.
  `electron/main.js` now uses those helpers for cold-start and second-instance open handoff while
  preserving Darwin `open-url`/`open-file` events and non-Darwin quit behavior. The local
  electron-builder wrapper now passes `-c.npmRebuild=false` for Windows targets so macOS hosts do
  not try to cross-compile `node-pty` from source; Windows native payload correctness remains
  enforced by `install-win-native-prebuild.mjs` and `electron:smoke:win`.
- evidence: `node --check electron/main.js`, `node --check electron/desktop-intents.js`, and
  `node --check scripts/local-electron-builder.mjs` passed. `npm test --
  electron/desktop-intents.test.ts electron/release-preflight.test.ts` passed 2 files / 13 tests.
  `npm test -- electron/local-electron-builder.test.ts electron/desktop-intents.test.ts` passed
  2 files / 12 tests. `npm run electron:pack:mac:arm64` built a fresh unsigned
  `dist/mac-arm64/Markie.app` and its afterPack window smoke loaded `Markie — Markdown Viewer`.
  `npm run electron:smoke:mac:launch` launched the packaged mac app and wrote
  `launch-smoke.json` plus a 2560x1640 `screenshot.png`. The first retry of
  `npm run electron:pack:win` failed because electron-builder attempted to cross-rebuild
  `node-pty`; after adding the Windows `npmRebuild=false` guard, `npm run electron:pack:win`
  passed, skipped dependency rebuilds, restored the host native module, and installed the Windows
  x64 `better-sqlite3` PE prebuild. `npm run electron:smoke:win` passed against
  `dist/win-unpacked` with structure-only host mode. `npm run release:preflight` passed, including
  renderer/Electron tests 24 files / 145 tests, MCP tests 19 tests, server tests 35 tests, lint,
  static build, Windows workflow checks, Electron desktop support checks, and release docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:35 EDT — terminal: progressed
- did: Made desktop update checks platform-scoped instead of generic packaged behavior. Extracted
  `electron/update-policy.js` so packaged macOS remains the only updater-supported platform,
  packaged Windows/Linux manual checks return an explicit `unsupported-platform` message, and
  `setupAutoUpdate` cannot point local non-macOS builds at the macOS production feed. Updated
  release preflight, release docs, and the cross-platform audit checklist to require and document
  that runtime boundary.
- evidence: `node --check electron/main.js` passed. `node --check electron/update-policy.js`
  passed. `npm test -- electron/update-policy.test.ts electron/release-preflight.test.ts` passed
  2 files / 11 tests. `npm run release:preflight` passed, including renderer/Electron tests
  25 files / 149 tests, MCP tests 19 tests, server tests 35 tests, lint, static build, Windows
  workflow checks, Electron desktop support checks, and release docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:41 EDT — terminal: progressed
- did: Tightened theme-control consistency across the renderer. Built-in theme commands now route
  through `applyColorMode`, the color-mode helper emits a renderer event with the chosen and
  resolved mode, and the toolbar subscribes so its active System/Light/Dark state follows theme
  changes triggered outside the toolbar. This keeps stored color mode, active built-in theme,
  document CSS variables, toolbar state, and command-palette theme actions aligned.
- evidence: Actual Electron app inspected through Computer Use at `app://markie/index.html` after
  rebuilding and reloading the static bundle. The editor and Library were visible in light mode, and
  the Library showed the default `~/Documents/Markie` workspace as ready. CDP reported
  `markie.colormode.v1=light`, `activeId=markie-light`, no `dark` class, and light CSS variables
  (`--background: #f8fafc`, `--surface: #eef2f6`, `--foreground: #18181b`). `npm test --
  src/lib/color-mode.test.ts src/lib/theme.test.ts` passed 2 files / 13 tests. `npm run lint`
  passed. `npm run build` passed. `npm run visual:guard:theme` passed with zero findings across
  shell, content, and overlay/panel samples. `npm run release:preflight` passed, including
  renderer/Electron tests 25 files / 150 tests, MCP tests 19 tests, server tests 35 tests, lint,
  static build, Windows workflow checks, Electron desktop support checks, and release docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:45 EDT — terminal: progressed
- did: Removed the broad packaged app inline-script allowance while preserving the Next static
  export bootstrap. Added `electron/csp.js` to scan built `out/*.html` files, hash each exact
  inline script with SHA-256, and build `script-src 'self' <hash...>` without script
  `unsafe-inline`. `electron/main.js` now uses the shared CSP helper for packaged `app://`
  responses, release preflight requires the helper/wiring, and the CSP backlog item is closed with
  evidence.
- evidence: `node --check electron/main.js` passed. `node --check electron/csp.js` passed.
  `npm test -- electron/csp.test.ts electron/release-preflight.test.ts` passed 2 files / 11 tests.
  A direct CSP probe over the built `out/` found 10 inline bootstrap hashes and `hasScriptUnsafeInline=false`.
  `npm run electron:pack:mac:arm64` passed, including the afterPack window smoke loading
  `Markie — Markdown Viewer` under the new CSP. `npm run electron:smoke:mac:launch` launched
  `dist/mac-arm64/Markie.app/Contents/MacOS/Markie`, validated the packaged renderer at
  `document.readyState=complete`, and wrote screenshot evidence. `npm run release:preflight`
  passed, including renderer/Electron tests 26 files / 154 tests, MCP tests 19 tests, server tests
  35 tests, lint, static build, Windows workflow checks, Electron desktop support checks, and
  release docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:49 EDT — terminal: progressed
- did: Made the Library list organization deterministic and product-oriented. Added a shared
  organizer that separates local, personal cloud-only, and shared documents; promotes conflict,
  behind, and missing local files ahead of ordinary docs; then sorts by last known activity and
  natural filename order. The Library panel now uses that organizer and shows section counts or
  alert counts instead of exposing raw main-process order.
- evidence: `npm test -- src/lib/library-overview.test.ts src/lib/library-startup.test.ts
  src/lib/library-state.test.ts` passed 3 files / 11 tests. `npm run lint` passed. `npm run build`
  passed. `npm run visual:guard:theme` passed with zero findings across shell, content, and
  overlay/panel samples. The live Electron app was inspected through Computer Use at
  `app://markie/index.html`: light mode showed the Library, default `~/Documents/Markie`
  workspace, metrics, editor content, and controls; dark mode was toggled and rendered the Library
  metrics, workspace card, editor, code block, toolbar, and rail legibly before restoring light
  mode. `npm run release:preflight` passed, including renderer/Electron tests 26 files / 157
  tests, MCP tests 19 tests, server tests 35 tests, lint, static build, Windows workflow checks,
  Electron desktop support checks, and release docs checks.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:54 EDT — terminal: progressed
- did: Tightened share-member visibility so pending invite emails are owner-only management state.
  `GET /api/docs/:id/shares` still lets owners, editors, and viewers read joined collaborators for
  a doc they can read, but only owners receive pending invite rows. This prevents viewers/editors
  from inferring not-yet-joined invite emails while preserving the collaborator list and owner
  management UI.
- evidence: `node --experimental-strip-types --test server/src/share-access.test.ts
  server/src/share-routes.test.ts server/src/shared-by-me.test.ts` passed 9 tests. `npm run
  release:preflight` passed, including renderer/Electron tests 26 files / 157 tests, MCP tests 19
  tests, server tests 35 tests, lint, static build, Windows workflow checks, Electron desktop
  support checks, and release docs checks. The live Electron app was inspected through Computer Use
  at `app://markie/index.html` after the build; the Library, default `~/Documents/Markie`
  workspace, toolbar, and editor content were visible.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-05 21:58 EDT — terminal: progressed
- did: Made Share dialog permission state explicit and server-derived. Access copy now separates
  "checking" from "unavailable", empty people/public-link copy is role-aware, and owner-only
  handlers for invites, removals, public links, and theme pinning refuse to run unless `canManage`
  is confirmed. This prevents the sharing UI from implying ownership or firing management actions
  when access failed to load.
- evidence: `npm test -- src/lib/share-access-view.test.ts` passed 1 file / 7 tests.
  `node --experimental-strip-types --test server/src/share-access.test.ts
  server/src/share-routes.test.ts server/src/shared-by-me.test.ts` passed 9 tests. `npm run
  release:preflight` passed, including renderer/Electron tests 26 files / 160 tests, MCP tests 19
  tests, server tests 35 tests, lint, static build, Windows workflow checks, Electron desktop
  support checks, and release docs checks. `npm run visual:guard:theme` passed with zero findings
  across shell, content, and overlay/panel samples. The live Electron app was inspected through
  Computer Use at `app://markie/index.html`; the Library, default `~/Documents/Markie` workspace,
  toolbar, and editor content were visible in light mode.
- next: Continue native Windows workflow execution only after the ahead commits are pushed with
  approval, and continue signed/notarized update feed plus public release work only with explicit
  release approval.
- blockers: Native Windows launch still needs a Windows host/workflow run after the ahead commits
  are pushed. Signed/notarized production update feeds, public URLs, deploy, upload, and release
  approval remain human-gated.

## 2026-07-06 18:06 EDT — terminal: progressed
- did: Made the Library Recent view surface cloud-only documents shared with the user instead of
  the empty workspace card. `organizeLibraryItems` now exposes `sharedCloudOnly` (shared docs
  without a local path) alongside the full `sharedItems` rail list, and Recent renders it as a
  distinct "Shared with me" section. Shared docs already on disk stay in the local list, so
  nothing duplicates. Rows reuse the existing shared open path (`docOpenShared`), badge, and
  shared-by subline.
- evidence: `npx vitest run src/lib/library-overview.test.ts` passed 1 file / 5 tests and
  `src/lib/library-startup.test.ts` passed 1 file / 3 tests. Codex (gpt-5.5 high) verification run
  passed renderer/Electron tests 26 files / 160 tests, MCP tests 19 tests, server tests 35 tests,
  and lint; its sandbox blocked port binding, so `npm run build` and `npm run visual:guard:theme`
  were re-run outside the sandbox and passed — build produced the static routes and the visual
  theme guard reported zero findings with live Electron screenshots of shell, source editor,
  Library, side panels, command palette, settings, and share/comments probes
  (`.autoloop/runs/light-mode-audit-20260706180239/`).
- next: Push the ahead commits to origin with approval and confirm the Windows launch smoke
  workflow on main; signed/notarized update feed and public release work remain human-gated.
- blockers: None for this task. Native Windows launch evidence still requires the GitHub-hosted
  Windows workflow run after push.

## 2026-07-06 18:20 EDT — terminal: progressed
- did: Repaired the Windows launch smoke pipeline. Five build scripts guarded their CLI entry with
  `import.meta.url === `file://${process.argv[1]}``, which never matches Windows backslash paths,
  so `local-electron-builder.mjs`, `package-smoke.mjs`, and `install-win-native-prebuild.mjs`
  silently no-oped on the windows-latest runner — the package was never built and the launch step
  failed with "missing Windows executable" (run 28812608464, first run after push). Replaced all
  five guards with the `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])` pattern
  already proven in `windows-launch-smoke.mjs`. Also fixed in `release-preflight.mjs` and
  `restore-host-native-prebuild.mjs`, which shared the latent bug.
- evidence: `npx vitest run electron/package-smoke.test.ts electron/release-preflight.test.ts
  electron/local-electron-builder.test.ts` passed 3 files / 21 tests. `npm run lint` passed.
  Direct CLI invocation prints usage; import-only probe confirms CLI bodies stay dormant.
  Implemented via Codex (gpt-5.5 high) and reviewed.
- next: Confirm the Windows launch smoke workflow goes green on this push and capture the launch
  evidence artifact.
- blockers: None; workflow result pending.

## 2026-07-08 22:40 EDT — terminal: progressed
- did: Confirmed `main` was already pushed to `origin/main`, verified the public `0.2.9` macOS
  update feed and all four macOS artifacts were live on Backblaze, pushed the missing `v0.2.9`
  release tag, then built fresh Windows x64 artifacts. The first `electron:build:win` run exposed
  that installer/zip builds created a Windows executable but bundled the macOS
  `better_sqlite3.node`; moved the Windows native prebuild install into the shared
  electron-builder `afterPack` hook so the unpacked app is repaired before zip/NSIS artifacts are
  created.
- evidence: `./init.sh` passed renderer/Electron tests 26 files / 160 tests, MCP tests 19 tests,
  server tests 35 tests, lint, and static build. `npm run release:preflight` passed after the fix
  with renderer/Electron tests 27 files / 162 tests, MCP tests 19 tests, server tests 35 tests,
  lint, static build, Windows workflow checks, Electron desktop support checks, and release docs
  checks. `npx vitest run electron/preflight-hook.test.ts electron/release-preflight.test.ts
  electron/package-smoke.test.ts` passed 3 files / 17 tests. `npm run electron:build:win` produced
  `dist/Markie-0.2.9-x64.exe`, `dist/Markie-0.2.9-x64.zip`, `dist/Markie-0.2.9-x64.exe.blockmap`,
  and `dist/latest.yml`; `npm run electron:smoke:win` passed, and direct header checks showed
  `dist/win-unpacked/Markie.exe`, the unpacked `better_sqlite3.node`, and the zipped
  `better_sqlite3.node` are PE payloads (`4d5a...`). Existing GitHub Windows launch-smoke run
  28815970012 for commit `8601100` was already green before this fix.
- next: Push the Windows artifact fix to `main` and confirm the new GitHub Windows launch-smoke
  workflow run on the pushed commit. Keep Windows public download/release work gated until signing,
  feed, and distribution decisions are explicit.
- blockers: Local macOS cannot run the Windows executable; native launch evidence must come from
  the Windows GitHub Actions runner or a Windows host. Windows artifacts are local and unsigned,
  not public release downloads.

## 2026-07-08 22:43 EDT — terminal: blocked
- did: Pushed commit `85e5549` to `origin/main`, which triggered Windows launch-smoke run
  28990253547. Reran the workflow once after the first immediate failure.
- evidence: Both workflow attempts failed before checkout with no runner assigned and zero billed
  Windows runtime. The GitHub check-run annotation says: "The job was not started because recent
  account payments have failed or your spending limit needs to be increased. Please check the
  'Billing & plans' section in your settings." The previous Windows launch-smoke run 28815970012
  for commit `8601100` remains green, but this new commit still needs native Windows launch
  confirmation after billing/spend is fixed.
- next: Fix GitHub billing/spend limit, then rerun
  https://github.com/zvndev/markie-dev/actions/runs/28990253547 or push another desktop-path
  change to retrigger the Windows runner.
- blockers: Native Windows launch evidence for `85e5549` is blocked by GitHub account billing or
  Actions spending limit. No repo code failure was reached because the job had no steps.

## 2026-07-10 16:45 EDT — terminal: progressed
- did: Repaired the desktop interaction regressions and hardened the Windows renderer path. Files
  created from the workspace now open immediately, document navigation dismisses stale panels and
  overlays, row/PDF menus dismiss on Escape and outside navigation, and File > New File now reaches
  the renderer. Replaced slash-only path parsing with macOS/Windows-safe helpers, including terminal
  working-directory resolution. Reshaped the toolbar so the Markie handle and 650px of unused top
  bar are native drag regions while file, mode, and document controls remain clickable no-drag
  islands.
- evidence: `npm run release:preflight` passed renderer/Electron tests 28 files / 166 tests, MCP 19,
  server 35, lint, and static build. `npm run visual:check:overlays` passed an isolated real Electron
  flow that created and opened `window-flow.md`, collapsed the Files panel, dismissed action/PDF
  menus with Escape/outside click, navigated to Browse without a stale menu, verified light/dark
  overlays, and measured a 649.7px drag gap. `npm run electron:build:win` rebuilt the x64 NSIS and
  zip artifacts; `npm run electron:smoke:win` passed. The unpacked executable and SQLite native
  module, plus the zipped native module, all have PE `4d5a` headers.
- next: Push the hardening commit and require a native Windows launch-smoke result for that exact
  commit. If the repository billing gate still prevents runner allocation, use an approved alternate
  Windows runner or private validation mirror rather than treating the billing failure as app proof.
- blockers: Native Windows execution remains pending until a Windows runner accepts the final pushed
  commit. Windows artifacts remain unsigned local outputs and are not public release downloads.

## 2026-07-10 16:47 EDT — terminal: blocked
- did: Pushed desktop hardening commit `c245ab6` to `origin/main`, which triggered Windows
  launch-smoke run `29122498553`. Audited local bypasses after the run failed: Microsoft Windows App
  has no configured Devices or Apps, no Wine/UTM/Parallels/VMware/VirtualBox runtime is installed,
  no self-hosted GitHub runner exists, and no authenticated Azure/AWS/GCP or mesh Windows host is
  available from this Mac.
- evidence: Run `29122498553` failed in three seconds with no runner name and no workflow steps. Its
  sole check annotation says the job was not started because recent account payments failed or the
  Actions spending limit must be increased. The final commit remains locally verified by release
  preflight, isolated Electron interaction QA, a fresh Windows installer/zip build, package smoke,
  and PE payload checks.
- next: Either repair Actions billing for `zvndev/markie-dev`, provide a Windows host, or explicitly
  choose an alternate authenticated GitHub owner for a private validation mirror. Do not copy the
  private repository into other GitHub accounts configured on this machine without that explicit choice.
- blockers: Native Windows launch proof for `c245ab6` is externally blocked before runner allocation.

## 2026-07-12 20:27 EDT — terminal: complete
- did: Made the stable desktop release process repo-owned and two-phase. The server download
  manifest now owns the canonical site, Backblaze storage, updater feed path, publication status,
  and permanent download routes; Electron Builder reads the same manifest. Added a guarded release
  runner for one-command version updates, exact-commit signed/notarized preparation, local evidence,
  artifact-first/feed-last publication, full public SHA-512 verification, stable website checks,
  and previous-feed rollback. Added `/download/latest.json` and `/download/latest`, moved website
  and share-email install CTAs to stable routes, documented the full release and updater-notice
  procedure in `AGENTS.md` and `docs/RELEASING.md`, and fixed the server image so it includes the
  manifest and boots with its default `/data` database path.
- evidence: `npm run release:preflight` passed under Node 22 with 29 renderer/Electron test files / 175
  tests, MCP 19 tests, server 40 tests, lint, and static build. Focused release/package tests passed
  3 files / 24 tests. `npm run electron:pack:mac:arm64` loaded
  `electron-builder.config.cjs`, built the unpacked app, and passed the packaged-window preflight;
  `npm run electron:smoke:mac:arm64` passed. A production-shaped Node 22 Docker image built, booted
  without a mounted data volume, and returned stable-channel `0.2.9` data from
  `/download/latest.json`. Public-feed verification confirmed all four `0.2.9` macOS feed entries
  and the primary DMG. `npm run electron:build:win` loaded the same canonical config and rebuilt the
  x64 ZIP/NSIS artifacts; `npm run electron:smoke:win` passed package and PE-native-module checks.
  Two review passes closed findings for untracked build inputs, evidence/artifact binding, remote
  blockmap verification, rollback cache convergence, and production URL/feed drift; the final
  review reported no findings.
- next: Deploy the server route before the next app release, then use `npm run release:version --
  <semver>`, commit/push, `npm run release:prepare:mac`, and the explicitly approved
  `npm run release:publish:mac -- --confirm-public-release=<semver>` flow. Finish with a real updater
  notice/install smoke from the previous public app version.
- blockers: Windows publication remains gated on exact-commit native Windows launch evidence and
  production Authenticode signing. The existing GitHub-hosted Windows runner remains blocked by
  account billing before job allocation.

## 2026-08-23 13:05 EDT — terminal: progressed
- did: Product sprint on a fresh clone (main @ f9c3f4a, 0.4.0). Six audits → docs/superpowers/plans/2026-08-23-crash-hardening-sprint-plan.md → six
  dev tracks → five reviews → three fix passes. Shipped in the working tree (uncommitted): crash
  log + render-process-gone recovery + navigation guards; universal IPC failure shapes with
  explicit `onFailure`; PDF export rebuilt (temp file, readiness wait, timeout, busy guard);
  home-folder rescan gated to 5 min/panel-open and cloud/bundle/Windows exclusions with a global
  budget; shared-doc open/sync/collab silent-failure and data-loss fixes (collab teardown on file
  switch, 4403 → read-only, viewer seeding, unreadable responses, conflict dialog keyed per file,
  Save As single write); drag-resizable library panel (200–520px, persisted, keyboard, e2e);
  top-level ErrorBoundary + render fallback + print CSS + KaTeX in exports (lazy chunk) +
  rehype-sanitize; PTY kill on real unmount; Windows path/name/case fixes; mcp open via
  explorer.exe; jsdom vitest project + bridge mock + IPC contract test + server route tests;
  Intel Mac download published in the manifest; docs/WINDOWS-TESTING.md; docs/mobile/MOBILE-PLAN.md.
- evidence: `npm test` 74 files / 871 tests (was 49 / 492); `(cd server && npm test)` 122 (was
  66); `node --test mcp/lib.test.mjs` 24; `npm run lint` clean; `npm run build` clean;
  `npm run release:preflight` passed; `npm run visual:check:panel-resize` passed (widths
  252→372→200→520→252→316, survives relaunch); `npm run ui:check` 26/26.
  `npm run visual:check:overlays` fails on a pre-existing stale expectation (BACKLOG).
- next: Owner pushes the unpushed 0.4.1–0.4.3 work from the other machine, rebases this tree,
  commits, then `npm run release:version -- 0.4.x` and the mac release flow; test the Windows
  build on the real PC per docs/WINDOWS-TESTING.md.
- blockers: Windows public download still gated on Authenticode signing + updater feed
  (BACKLOG). Atomic user-file writes (tmp+rename) recommended as the next trust item.

## 2026-08-24 12:55 EDT — terminal: progressed
- did: Follow-up sprint per docs/superpowers/plans/2026-08-24-followup-sprint-plan.md, five
  parallel tracks on the working tree (no worktrees, disjoint file ownership). Shipped
  (uncommitted, on top of the 2026-08-23 sprint): atomic user-file writes
  (electron/atomic-write.js — temp beside the original, fsync file and directory, rename;
  darwin xattr/Finder-tag preservation; readable EACCES/EROFS message) routed through save,
  save-as, and every sync write; per-save snapshots (electron/snapshots.js, 20/file, 200 MB
  total, same-millisecond suffix) with File → Revert to Snapshot… loading as unsaved changes;
  viewers can start threads and reply (server canCommentLevel + UI gates, revoked hides the
  composer); exports embed local images (electron/inline-images.js, containment-checked,
  10/30 MB caps) and ⌘P prints the rendered document through the export pipeline with the
  system sheet left untimed; server-side collab seed lock (first editor seeds an empty room,
  metadata-only updates do not release the lock, hand-off on disconnect) paired with a client
  settle delay and a schemaVersion stamp written in the same transaction as the content;
  87 new component tests (conflict-dialog, shared-view, library, browse truncated notice,
  page save/conflict/menu/shortcuts/drop), electron test fixtures typed, `npm run typecheck`
  as a CI gate, overlay-interaction-check assertion fixed and green. A combined re-review
  agent confirmed all 20 plan tasks and raised two P1s (stamp-before-content releasing the
  seed lock early; the 30 s export deadline killing an open print sheet) — both fixed with
  regression tests, plus five weakened tests rewritten to assert outcomes.
- evidence: `npm test` 86 files / 1029 tests; `(cd server && npm test)` 131;
  `node --test mcp/lib.test.mjs` 24; `npm run lint` clean; `npm run typecheck` exit 0;
  `npm run build` clean; `npm run release:preflight` passed;
  `npm run visual:check:overlays` runs to the end (artifact
  .autoloop/runs/overlay-interaction-check-20260824122306/).
- next: Owner pushes 0.4.1–0.4.3 from the other machine, rebases, commits this tree (Lore
  message drafted in the session recap), then the mac release flow. Real-PC Windows pass per
  docs/WINDOWS-TESTING.md still owed.
- blockers: Windows signing/publication unchanged (BACKLOG). New BACKLOG items: seed-lock
  force-resync for the dropped racer, shortcuts firing behind modals (owner decision),
  page print/export handler tests, owner comment-moderation unreachable from the UI.

## 2026-08-24 15:35 EDT — terminal: progressed
- did: Merged the unique work from origin/feat/onboarding-auth-pass (9 commits, same base
  f9c3f4a) into the working tree, adapted to this tree's conventions. Ported: sign-in
  surfaces (auth-store useSyncExternalStore, auth-errors, sign-in.tsx with Google/OTP/
  password/reset; Settings and Share gate now sign in in place; comments/activity-bar read
  the shared store), first-run welcome document, server OTP recovery (otp-email, rate limits,
  invite address on the share page, expiresIn/allowedAttempts pinned), beta update channel
  (update-channel.js through the handle() wrapper + Settings toggle + release.mjs channel
  awareness), disk-change watcher (fs.watchFile on the open doc, in-app conflict dialog,
  save force flag, refreshDiskMemory after cloud pulls), and opt-in Sentry crash reporting
  (sentry-envelope with the NUL sentinels removed, file:// path leak and greedy-username
  scrubs fixed; consent-gated, DSN-gated). Skipped the branch's sidebar (our panel-width is a
  superset) and its text-format crash log (ours is a superset); took only the CrashProbe and
  the reduced-motion CSS rule.
  SEPARATELY: root-caused and fixed a SECOND Finder crash. The e2e window-check scripts spawned
  Electron `detached` and cleaned up with `process.kill(-pid)` group kills; on macOS the app
  re-launches via LaunchServices and the recycled launcher pid's group hit session services
  (uiagent, cli-llm-bridge), taking Finder down. Added scripts/lib/safe-kill.mjs (direct-child
  only) across the 5 offenders, removed `detached`, and added scripts/lib/e2e-consent.mjs so no
  window-check boots without MARKIE_ALLOW_E2E=1 (import-safe; the 3 ported checks isolate $HOME).
- evidence: `npm test` 95 files / 1143 tests; `(cd server && npm test)` 142; `node --test
  mcp/lib.test.mjs` 24; `npm run typecheck` exit 0; `npm run lint` clean; `npm run build` clean;
  `npm run release:preflight` exit 0. Crash root-cause confirmed in the unified log
  (node[runner] SIGKILL → coreservices.uiagent + cli-llm-bridge at 14:24:55, Finder relaunch).
  Consent gate exits 2 on direct run; safeKill proven to never issue a negative-pid kill;
  importing a guarded script does not exit.
- next: Owner commits (Lore message drafted in the recap). Real-window checks are now safe to
  run with MARKIE_ALLOW_E2E=1; wiring them into CI is a new BACKLOG item. 0.4.1–0.4.3 push +
  rebase from the other Mac and the Windows real-device pass still stand.
- blockers: Windows signing/publication unchanged.

## 2026-10-14 Original document platform foundation

Kirby authorized a shared web/desktop document platform, an original DOC/DOCX engine, broader plain text and encrypted protected storage. The complete requested plan is saved at docs/superpowers/plans/2026-10-14-document-platform.md; provenance is recorded at docs/decisions/2026-10-14-original-document-engine.md. Circular ENG-6886 through ENG-6889 own the bounded foundation tasks and review evidence.

Implemented dependency-free original ZIP/XML/OOXML package inspection and safe plain-run editing, a bounded original CFB/Word97-2003 text reader, explicit format/browser file utilities, and isolated Web Crypto vault primitives. Plain .txt/.text/.log files now stay literal in the existing app. The development-only ?documents=1 workbench exports copies and never overwrites originals. Independent review findings were fixed with regression tests, including package protection/XML validation, Buffer ownership, directory-name validation, text collaboration gating, drop routing and unsaved-copy replacement.

Verification: 193 test files passed, 2,749 tests passed, one existing skipped test; 72 MCP tests passed; typecheck, lint, build and diff checks passed. A real Chromium workbench flow created/edited/exported DOCX; unzip validation and the independent platform text consumer read the expected Unicode/XML-sensitive text. Desktop/mobile-width browser checks had no framework overlay or console errors. Existing test-environment and large-bundle warnings remain.

This is a verified initial foundation, not completed Word compatibility or a shipped vault. Microsoft Word corpus/fidelity, native/browser trusted unlock, encrypted persistence/search/recovery, Office multiplayer/sharing, full web hosting/offline support and release remain outside this milestone. No dependencies added, no release/deploy performed, and human-maintained VISION.md/CONSTITUTION.md remain unchanged.

## 2026-10-17 — terminal: progressed (Word theme fidelity)

Resolved supported DOCX Latin theme fonts and mapped theme colors through validated internal package relationships, document settings and the existing style cascade. Theme lookup is cached per snapshot. Unsupported script/language contexts, ambiguous dependencies and transformed palette entries stay unresolved instead of guessing. Original theme/settings/styles/unknown parts remain intact; simply viewing or opening the Font dialog does not bake display styles into the file. Explicit formatting still intentionally overrides the selected raw attributes.

The existing Markie shell, shared Font control and native Format menu are unchanged. Added original specification-shaped fixtures, adversarial package/cascade tests and shared-control integration tests; no third-party document engine or dependency was introduced. Independent architecture and adversarial reviewers approved the bounded implementation after script-slot isolation and repeated-lookup performance fixes.

Verification: 3,591 renderer/Electron tests passed with one existing skip; global lint, typecheck and diff checks passed. The packaged Apple Silicon preview exercised theme CSS, the shared font picker, native Font dialog, byte-identical view-only/dialog-neutral exports, explicit override/export/reopen and retained unsaved Markdown in the same shell, with no page errors. Light/dark visual review and clean-commit desktop packaging evidence are attached to Circular ENG-6981 through ENG-6985.

This is a bounded fidelity improvement, not completion of the full roadmap. Full Word pagination/layout, complex-script/font-language inference, exact Word color quantization, legacy DOC writing, broader indexing, Office multiplayer, biometric vault keys, production cloud verification and release remain unclaimed. Windows execution and physical Intel Mac verification require their respective devices; local preview packages are not a public release.

## 2026-10-17 — terminal: progressed (supported Word print/PDF)

Added a bounded model-derived DOCX print projection and routed it through Markie's actual shared Export menu and existing native File Print/PDF commands. The native menu items are merged with their Markdown fallbacks, not duplicated. No new shell, document engine, dependency, persisted model or export IPC payload was introduced. White printed paper retains supported document typography, page geometry, lists, basic tables, raster pictures, links and explicit breaks independently of the app theme. Pending revisions and unsupported/unrepresentable content are rejected; excluded comments and font/printer limitations are disclosed.

Current immutable model capture precedes asynchronous work. Synchronous guards cover overlapping output, IME composition, private/modal/inert scopes, edits, navigation and close; output never clears document dirty/file generations. Hidden-renderer readiness now decodes pictures and aborts visibly on a failed readiness probe instead of printing partial content. Independent architecture and cross-model adversarial reviews approved the repaired implementation. Native PDF probes exposed a lost terminal blank page; a glyph-free terminal fragment fixes it without modifying Word bytes.

Verification: 3,654 renderer/Electron tests passed with one existing skip; typecheck, global lint and diff checks passed. Packaged Apple Silicon QA exercised shared/native Word PDF, native Print cancellation without sending a physical job, immediate unsaved edits, source neutrality, modal/revision guards, retained Markdown and its native PDF fallback. Actual PDFs prove A4 and landscape Letter geometry, all five explicit-break edge cases, complete 50-row and oversized-row table content, embedded decoded pictures and no app chrome. Text bounds remain inside the requested margins across 22 stress/sample pages. Light/dark shell and rendered sample-page visual review passed at 91/100. Circular ENG-6991 through ENG-6995 hold the detailed proof and clean-commit packaging acceptance.

This supports Chromium print fragmentation of the supported view, not Word-equivalent on-screen pagination, mixed-section/merged-table fidelity or physical printer certification. Installed fonts and printer settings can alter output. Windows runtime, physical Intel hardware, non-Chromium browser print, Office multiplayer, native DOC writing, all-files body indexing, OS-protected biometric vault keys and public release remain outside this milestone. Existing installed Markie and user documents were not modified.

## 2026-10-17 — terminal: progressed (native RTF and ODT)

Kirby approved additive local RTF/ODT recovery formats and a private format-aware rich-editor adapter. Implemented separate original codecs and source ownership, preserving record fields/version and the real DOCX engine. Supported native RTF/ODT text, font/color/emphasis and paragraph alignment/spacing now use the existing canvas and actual shared controls; unsupported operations are withheld and rejected rather than converted behind the scenes. Untouched exports are byte-exact. Modified output must reopen faithfully within the codec budgets before returning save bytes. Native file grants retain owner/revision/conflict protection for same-format writes, and Library filters distinguish RTF/ODT. Cloud/server formats remain unchanged; new-format cloud upload is explicitly unavailable.

Architecture and cross-model adversarial reviews found and separate writers repaired Buffer aliasing, empty RTF paragraphs, inherited/default style resets, structural text loss, cumulative ODT expansion limits, mutation/export budget mismatch and foreign-session ownership. Default rebasing is linear and preserves IDs/undo; unsupported source formatting fails on import instead of during an unrelated edit. No other document-engine source, sample reader or dependency was used.

Verification: 3,785 renderer/Electron tests passed with one existing skip; global lint/typecheck and diff checks passed. Independent review ran 204 focused tests and concrete hostile probes. Packaged Apple Silicon flows passed exact view/dialog exports, edited same-format save/reopen, Unicode, retained source metadata/parts, native capability gates, actual format filters, unsupported RTF original export and retained unsaved Markdown in one shell. Settled light/dark visual review passed at 94/100; initial screenshots captured CSS transitions and were replaced with measured settled-state captures, without changing shared styling. An independent platform RTF consumer read the edited Unicode text correctly.

The requested linked local test guide is at docs/document-testing/README.md, with document-type, editing/recovery and pending-connected-document checks. The approved Darkmown direction is genuinely interactive after explicit trust, with media/state controls/API connections; it is not implemented or replaced by a static-only preview in this milestone. Cleaner cloud/people filtering, previous-collaborator autocomplete, in-app cross-format document links, README/text aliases and remaining fidelity/security/release work stay explicitly pending in the guide and Circular. Clean-commit native/package proof is attached to ENG-7000 through ENG-7003 and ENG-7009. No public release, deployment, installed-app replacement or user-source overwrite occurred.

## 2026-10-18 Document finish-out: explorer, cloud, search, new-file modal, dark mode, text multiplayer

Kirby asked to close the gaps Codex left after the document-platform work and cut a new super-nightly. The device index (electron/mdindex.js) now walks every supported document extension with a per-row format and a budget-capped body snippet for text-representation formats, so Browse finds DOCX/DOC/RTF/ODT/TXT/CSV/JSON/YAML/XML/HTML/Darkmown as well as Markdown, filters by each type (persisted), and searches inside small text files. Projects keep their Markdown-only taxonomy (use-projects + mdmeta guards), and the MCP scan budget mirror gained maxSnippets without widening the MCP API. HTML is its own Library/Cloud/Browse filter bucket instead of "other".

Cloud snapshots now accept RTF, ODT, and Darkmown on both the client allowlist and the byte-snapshot server store; the cloud dialog opens RTF/ODT in the existing rich editor and exports through exportRichDocument, keeping the original format and digest checks. New-file creation is a centered modal (Library action, Cmd+N, native menu, command palette) listing all ten creatable types; the documents-disabled fallback still starts blank Markdown directly. The on-screen Word canvas no longer forces white paper in dark mode (theme tokens on screen, white only in docx-print output), with hyperlink color on the status-blue token and a CSS guard test.

Multiplayer: shared plain text (.txt/.text/.log) now enters a live Y.Text session in its own source pane (src/lib/text-collab.ts binding with surrogate-safe single-span diffs, seeded like Markdown, presence names but no remote carets). The server seed lock now recognizes Y.Text content (roomHasCollabContent) so text rooms do not stay locked to the seeder. DOCX/RTF/ODT remain snapshot-shared with version conflicts, not live co-edited; that is still pending and is not claimed here.

Verification: focused suites for every area above; full renderer/Electron run 4,301 passed with 1 existing skip (two timing-bound tests in untouched files flaked once under load and pass standalone); MCP 72 passed; server 387 passed, 1 skipped; lint and typecheck clean; production build clean.

## 2026-10-19 Documents everywhere: search, recents, default apps, style templates, real-world DOCX

Kirby asked for default-app offers for every fully supported type, working type filters, complete recents, a global search with filters, deeper styling with templates, light/dark for text/RTF/DOCX, and a straight answer on whether RTF and DOCX were fixed. Terminal state: shipped as super-nightly 10.

Opens and recents: clicking a DOCX/RTF/ODT/JSON/YAML/XML/Darkmown/HTML row in Browse or Recent did nothing (rich opens required a drag-drop grant); advertised index/registry paths now queue like a Finder open. Every granted document is recorded in the registry (trackOpened keeps any sync hash) and the macOS Recent Documents list; Library rows show a type tag and no longer offer Markdown-only copy/sync on rich files, and the open retained document filters by its real type.

Global search (⇧⌘F, rail button, File menu, palette): main-process doc-text.js extracts bounded body text from Markdown/text/CSV/JSON/YAML/XML, DOCX and ODT (ZIP part with an inflate ceiling), RTF and HTML (legacy DOC stays name-only), caches by path+mtime+size, searches newest first within a time budget, and supersedes stale queries. The modal filters by type (persisted), highlights hits and excerpts, and opens with the keyboard.

Default apps: Settings > Files offers Markdown, plain text (+log), Darkmown, CSV, JSON, YAML and XML individually or all at once through LaunchServices, and lists DOCX/RTF/ODT as not offered yet with reasons. The packaged app now declares those content types (Alternate rank for generic text types so installing never steals them; Darkmown exported and owned); the desktop preview declares none.

Styling: eight style templates (Markie, Paper, Nord, Solarized, Ink, Rosé, Forest, Studio), each with light and dark variants and typography; color mode now picks the template's tone instead of resetting to Markie; custom colors fork a per-tone preset; a redesigned Appearance gallery with typography controls and specimen.

Document theming: authored run colors adapt for display only when they would be unreadable on the current page (neutral to foreground, other hues mirrored to 4.5:1), live on theme change; native controls follow the tone.

DOCX: measured on the owner's real Word files (local, read-only, aggregate only) only 29 of 103 opened editable. Inert parts, external hyperlinks, unknown properties, common page breaks and UTF-16 parts now pass through opaquely with per-run locks for tabs/breaks/fields: 94 of 103 editable, all untouched exports byte-identical, all one-word edits round-trip. Remaining locks: pending tracked changes, protection, OLE, local-file links, nested tables, content controls.

Also fixed: isolated dev Electron profiles were always refused because Chromium applies --user-data-dir before the guard compared against it.

Verification: full renderer/Electron suite, lint, typecheck, build; isolated real-Electron CDP check (temp HOME and profile) passed 8/8: index finds every type, search IPC body hits in DOCX/RTF/MD, type filter, ⇧⌘F modal, result opens editable DOCX, DOCX lands in Recent, indexed RTF opens from a path. LaunchServices status script verified read-only against the real system. Not verified: clicking "Use Markie" in the installed app (changes the owner's real associations; left for Kirby).

## 2026-10-19 Zoom for every text format, and a way to find default apps

Zoom: the classic source editor (every .txt/.log/.csv file and Markdown Source) hard-coded 14px, so ⌘+/⌘- changed nothing visible there; it now scales with the document zoom through --doc-zoom. The documents text editor (CSV/JSON/YAML/XML/Darkmown source) now answers the menu's zoom commands, read-only included, and zooms its CSV table preview. Text, Word, RTF and ODT editors share one remembered zoom (markie.documents.zoom.v1) on the toolbar's steps. A trackpad pinch or ctrl+scroll zooms Markdown and every document editor.

Default apps: Markie menu > Default Apps for File Types… opens Settings > Files directly (Settings remounts on the requested tab). When Markdown is already Markie's, the Library footer now offers "Open text, CSV, JSON and more in Markie…" while any offered type still opens elsewhere; dismissible, and it re-checks when Settings changes an association.

Verification: targeted suites, full suite (one known load-flake in scripts/private-release.test.ts that passes alone and on the clean tree), lint, typecheck, build; isolated real-Electron CDP check: pinch zooms a .txt 14px -> 15.4px and back, and an RTF to 110% with the zoom remembered. Not verified live: the native menu items themselves (CDP cannot click native menus; routing is unit-tested).

## 2026-10-20 Word editor: no paragraph boxes, page setup on the toolbar

The faint blue frame around the paragraph holding the caret (.docs-word-paragraph.is-selected, plus a 2px focus-visible ring that contenteditable always matches) is gone; the caret is the focus indicator, as in every word processor. Page Setup and Paragraph Spacing, previously only in the Layout menu and ⌘K, now have toolbar buttons for DOCX, RTF and ODT. Page Setup is laid out as Paper (current size highlighted, dimensions shown), Orientation and Margins rows.

Verification: full suite 4434 passed, lint, typecheck, build; isolated live Electron DOCX check: focused paragraph computes outline none, the toolbar button opens Page Setup, screenshot reviewed.

## 2026-10-20 Vault in the rail with env keys, one Cloud list, scannable rows, honest save status

Vault: a lock button in the left rail opens the vault page (the Library row, the in-vault "Close vault" button and the Cloud page's "Back to document" button are gone; the rail navigates). The vault page groups Environment keys and Files; .env files open in a structured editor (masked values, per-row reveal and copy with a 30s fingerprint-checked clipboard clear, add/remove, duplicate and key validation, comments, Raw view) over a dotenv parser whose unedited round-trip is byte-identical (33 named cases plus 300 generated files). The vault's import picker accepts any file so .env/.env.local can be imported; .env is still not a document type elsewhere in Markie, on purpose.

Cloud: one list of every cloud file with toggle chips (Only me, Shared by me, Shared with me; counts, multi-select, persisted), no Snapshots/Sync tabs; snapshots follow the list on the same page.

Library rows: a per-type colored page icon and type badge (light and dark tone values) replace the text type tag, and small status icons replace the Local/Synced/... text badges (each labelled for hover and assistive tech). Recent is ordered purely by when files were opened; sync state no longer lifts rows (shared files someone edited were pinned to the top), and rows that arrive after the first snapshot are placed by recency instead of on top.

Save status: the documents footer says "Not saved to a file yet", "Edited" or "Saved" instead of recovery jargon, and the redundant "Recover now" button is gone (recovery already runs 600ms after typing). A recovery copy that matches its file on disk is now marked saved, so the Library lists only real drafts and unsaved edits ("Not saved to a file" section with Draft/Unsaved badges) instead of every opened file as "Recovered". Copies made before this change still show until their file is next edited and saved.

Examples: Markie seeds "Welcome to Darkmown.wd" (counter, slider estimate, form) into ~/Documents/Markie once per install, never overwriting and never re-creating after deletion; the pinned compiler accepts it with no warnings.

Also: palette "Connect an Agent (MCP)…".

Verification: full suite (4528 passed), lint, typecheck, build; live isolated Electron: Library row with CSV icon, badge and status icon; vault created, unlocked, and New environment keys opens the env editor; Darkmown example seeded into the temp workspace.

Held for owner sign-off (CONSTITUTION: MCP tool shape is a human checkpoint): MCP support for every document type (markie_find_documents, markie_search_documents, markie_read_document, markie_write_document; shared search core in mcp/doc-text.cjs) and the matching Connect an agent dialog copy. Uncommitted in the working tree.

## 2026-10-20 Desktop security fixes from the read-only production audit

A read-only audit (no deploys, no variable changes, no database access, no secret values printed) found nothing critical. Fixed on the desktop side here:
- Vault secrets are copied and cleared by the main process (electron/secret-clipboard.js). The renderer could not read the clipboard back after Markie lost focus, so the 30-second clear never ran in real use. The clear compares a SHA-256 fingerprint, leaves anything copied since alone, and also runs on vault lock and app quit.
- Document links no longer launch scripts, apps or installers: only documents, PDFs, images, audio and video open; anything else (including bundles such as .app/.pkg) is shown in Finder with a note.
- The CSP now rides on every app:// response, not only through the webRequest hook; verified live on the page's response headers.

Server findings (public-link token leak via document links, unthrottled share-invite email, unbounded WebSocket payload and history, localhost CORS in production, unencrypted Litestream replica in B2) are being prepared as code for owner review; nothing is deployed. Production api runs a 2026-10-08 CLI upload, so any redeploy also ships every later server change.

## 2026-10-20 Production hardened with owner approval

Approved by Kirby: encrypt the backup, redeploy the api, delete the detached volume, commit the MCP tools (2FA skipped).
- Litestream replicates age-encrypted to `markie-db-age/`. This was proven locally with v0.3.13 (encrypt, restore, resume after restart). In production the objects carry the age header, and a test restore inside the live container passed integrity with all 43 docs. Every plaintext replica version under `markie-db/` was permanently deleted from B2. A lifecycle rule now purges retired encrypted files a day after they are hidden. The replica key is already scoped to the Markie bucket.
- The age identity is in Railway variables; its offline copy was handed to Kirby.
- The api was redeployed from a clean `git archive` of the server directory at d659415, after a snapshot (`/data/pre-deploy-2026-10-20.db`, integrity ok). Before deploying, the migration was rehearsed: the Sep 14 image ran on seeded data, then the new image booted on that same data, carrying over the session, access control, public links, shares and history pruning. Live checks after the deploy passed. There were no errors in the logs.
- The detached volume `api-volume-a5Kl` was kept. The CLI delete never ran (the account has 2FA), and it may hold original data, so it stays until someone inspects it.
- Private packaging allowed only `electron/`, `out/` and production `node_modules/`, so the shared `mcp/doc-text.cjs` failed the nightly build. It is now a named exception, and a test pins it.

## 2026-10-20 Vault: Touch ID, real backups, calm copy

Kirby asked to drop the vault's warning paragraphs and make the vault tight with biometrics. He dropped CI/CD secret delivery.
- **Touch ID as a second key slot.** The passphrase stays the master key. Turning Touch ID on stores the vault key encrypted under a random 32-byte device secret in IndexedDB (AES-GCM, bound to the vault id). The device secret lives in the main process under safeStorage (Keychain) in `userData/vault-touch-id/<vaultId>.bin` (0600). It is released only after `systemPreferences.promptTouchID`. Turning Touch ID off deletes both halves. Vaults without a slot open unchanged.
- **No Keychain access on open.** Opening the vault no longer touches the Keychain. A live check found that a status query reaching safeStorage could raise a macOS keychain password sheet that froze the main process. Only enroll and unlock use the Keychain now.
- **Backup and restore.** "Back up vault…" writes one encrypted `.markievault` file holding the header and records, without the device slot. "Restore from backup…" validates the file strictly and writes only after the backup's passphrase unlocks it. `navigator.storage.persist()` runs on every create and unlock.
- **Passphrase help and copy.** "Suggest a passphrase" picks 6 EFF words through crypto.getRandomValues, and an entropy meter rates it. The warning paragraphs are gone; one line remains on the create screen.

Verification: the full suite passed (4586) along with lint and typecheck. In a live isolated Electron run, the create screen, passphrase suggestion, unlock and settings all render with no main-process stall.
Not verified: the real Touch ID sheet and Keychain storage in the signed build.

## 2026-10-20 Release pipeline, self-hosting, public repo hardening

Kirby asked for a super nightly, early access, then timed stable pipeline, self-hosted servers that can still share, and a secure public repo.
- Public repo: gitleaks over all history and the unpushed commits found only fixtures. Actions hold no secrets; Azure signing trusts only `main`. Pinned the signing workflow's actions to SHAs with Dependabot for the pins, turned on Dependabot alerts and security fixes, required CI approval for all outside contributors, and protected `main` (PR plus unit, lint-build, server, mcp, version-consistency; admins can bypass).
- Release pipeline: `release:publish:early:*`, `release:promote`, `release:promote-due`, `release:hold`/`unhold`, `release:rollback:early`/`:win`. Early builds carry stable numbers and the same files are promoted after a 3-day soak. The CONSTITUTION amendment that lets one "release" approve the timed promotion is drafted for Kirby; nothing schedules `promote-due` yet.
- Self-hosted server: `/api/server-info`, `MARKIE_OFFICIAL` (unset keeps Markie Cloud's guards), any S3 storage, encrypted backups required, `deploy/init.sh`, invite-only sign-up by default (`MARKIE_SIGNUP`, `MARKIE_ADMIN_EMAIL`), optional quotas, `docs/SELF-HOSTING.md`. Docker end to end with MinIO passed, including restore after losing the volume. Production needs no new variables.
- Desktop: trusted servers list, a native prompt before opening links from unknown servers, a session per server, per-doc `cloud_origin` registry column, server badges, invite-only messaging. Private builds stay on Markie Cloud.
- Security review of the multi-server code found a high-severity token mix-up through Google sign-in; fixed with an `iss` on the desktop deep link, plus seven smaller fixes (explicit sync destination, look-alike names, bounded bodies, encoded path checks with origin-bound tokens, loopback, landing extensions, private-build lock).
- Fixed test flakes: vault clipboard clear race, MCP tests inheriting the developer's CLAUDE_CONFIG_DIR.

Verification: npm test 4789 passed, server 453 passed, MCP 81, lint, typecheck, build. 0.8.1-super-nightly.16 published at d5bd85c; the unauthenticated feed returns 404.
Not verified: a real self-hosted server on the internet, real Google sign-in against one, live editing across servers, B2 with the new empty `region` line (lands at the next api deploy).

## 2026-10-21 Production: api.markiedocs.com, linked sign-ins, key rotation, nightly.17

Kirby approved the production steps.
- **Domain.** Railway custom domain `api.markiedocs.com` on service `api`; Vercel DNS `CNAME api -> 3ghxt5sn.up.railway.app`. Certificate was still validating at the time of writing.
- **API deploy.** `a101c56` from a clean `git archive`, after snapshot `/data/pre-deploy-2026-10-21.db` (integrity ok) and a check that no two accounts' emails differ only by case (18 users, 0 collisions). `/health` 200, `/api/docs` 401, Litestream writing to `markie-db-age`.
- **Linked sign-ins.** `MARKIE_ACCOUNT_IDENTITIES=1`; `/api/account/identities` answers 401 without a session.
- **Litestream key rotated.** New age identity in `~/.markie-secrets/litestream-age-identity-2026-10-21.txt`; Railway identity and recipient both match it. A full restore from B2 inside the container decrypted with the new key (18 users, integrity ok).
- **Nightly.** `0.8.1-super-nightly.17` published at `a101c56` (nightly.16 had already shipped at d5bd85c). Unauthenticated feed 404.

- **Certificate.** Stuck at `VALIDATING_OWNERSHIP` until the `_railway-verify.api` TXT record was added; the CLI never printed it.
- **Google redirect URI.** Added through Codex computer use in Arc on project `markie-499114`; the Railway callback stays.
- **Flip.** `BETTER_AUTH_URL=https://api.markiedocs.com`. Both names report that origin in `/api/server-info`; `/auth/google-start` on the Railway name answers 308 to the new name; Google receives `redirect_uri=https://api.markiedocs.com/api/auth/callback/google` and shows its sign-in page with no mismatch.

Not verified: a full Google and email sign-in by a real released app after the flip.

## 2026-10-21 Locked private builds finish Google sign-in (nightly.18, .19)

A real sign-out test on nightly.17 stranded Kirby on the private-build screen: it offered only email codes. Two causes, fixed in turn:
- **nightly.18 (1a5bb99).** The gate hid Google because main dropped every deep link while locked and only the document shell listened for `markie://auth`. Main now lets `markie://auth` through while locked, and the gate takes it while locked.
- **nightly.19 (8c025ae).** Google still did not unlock: locking reloads the window and clears `rendererReady`, which only the document shell sets, so main queued the link forever. Main now keeps it as `pendingAuthLink` for the gate to collect, and also sends it live.

Verification: full suite 4826, lint, typecheck. Live, through Codex computer use in Markie and Arc: nightly.19 signed out, Continue with Google, the gate cleared on its own, same account, synced docs and the 9 local drafts intact. Email-code sign-in through `api.markiedocs.com` also passed on nightly.17.

## 2026-10-21 Agent cloud links (nightly.20, a7eec0f)

Kirby asked that an agent can make him "a hosted private Markie" and hand back a link he can open away from the computer; public links only when he says so.
- **App:** `electron/agent-bridge.js` listens on `~/.markie/agent-<id>.sock` (0600, dir 0700) with a token in `agent-bridge-<id>.json` (0600). `electron/agent-cloud.js` decides: Markdown and text under home only; consent on an agent's first upload with "always allow" (Agents dialog toggle); every public link confirmed; locked private builds refuse.
- **MCP:** `markie_cloud_status`, `markie_cloud_sync`, `markie_cloud_public_link` (create only when asked), `markie_cloud_revoke_public_link`, via `mcp/agent-client.mjs`. Instructions tell agents to hand back the private link.
- **Server:** `/auth/web-signin` and `/auth/web-google`, and the `/d/<id>` access page offers Sign in. Not deployed yet: Railway paused builds in all regions during a major outage on 2026-10-21.
- **Library:** Copy private link.

Verification: app suite 4842, server 480, MCP 85, lint, typecheck. Live on nightly.20: the repo MCP server synced `~/Documents/Markie/agent-cloud-link-test.md` after one consent click (driven through Codex computer use), returned `https://api.markiedocs.com/d/be41f999-…`, which is 403 anonymously, has no public link, and opens in Arc with Kirby's session.
Not verified: web sign-in on the live server (pending deploy), a public link made live, an agent registered in Claude Code or Codex using the tools on its own.

## 2026-10-22 Markie Cloud moved from Railway to Fly.io

Railway disclosed on 2026-10-21 that customer environment variables may have been read, and paused deploys. Kirby chose to leave Railway.
- **Secrets rotated in the move:** new Backblaze backup key (`markie-backup-fly-20261022`) and media key (`markie-assets-fly-20261022`), new age identity (saved to `~/.markie-secrets/litestream-age-identity-2026-10-22.txt`), new `BETTER_AUTH_SECRET`. The leaked `Markie-key` and `markie-assets-api` keys are deleted. Google and Resend/justemail secrets still carry the leaked values until Kirby makes new ones.
- **Cutover (03:27–03:31 UTC):** consistent snapshot of the Railway database (integrity ok, two identical snapshots, so no writes lost), Railway `api` deployment removed at 03:29:12, database seeded onto the Fly volume through a temporary machine (sha256 matched), app started with a new Litestream generation, `api.markiedocs.com` CNAME flipped to Fly at 03:30:35. Certificate was issued before the flip.
- **Website:** markiedocs.com's `/download`, `/d/` and `/s/` rewrites now proxy to `api.markiedocs.com` (markie-site 723a86b).
- **Verified on Fly:** 18 users, 45 docs, integrity ok; `/health` 200, `/api/docs` 401, server-info origin `api.markiedocs.com`, Google start uses the `api.markiedocs.com` callback, web sign-in page 200, Litestream writing to `markie-db-age`, new media key lists the bucket.
- **Consequence:** released v0.8.0 apps call the Railway hostname, which now answers 404, so their Cloud features stop until they update to a build that knows `api.markiedocs.com`.

Still to do: new Google and email secrets; move the super-nightly gateway (still on Railway, publish key leaked) and ship a nightly that points at it; stable v0.8.1; delete the Railway `markie` project (its volume still holds database copies); purge Litestream generations written under the leaked age keys.

## 2026-10-22 Nightly channel on Fly, Railway markie project deleted, 0.8.1 hotfix prepared

- **Lockout found and fixed.** Stopping the Railway API locked the installed nightly: it re-authorizes every 30 s through the gateway, which verified sessions against the dead Railway API, and Railway's paused deploys blocked changing that. The gateway now runs on Fly as `markie-nightly` (`server/fly.nightly.toml`, new publish key in `~/.markie-secrets/fly-2026-10-22/`), `PRIVATE_GATEWAY_ORIGIN` is `https://markie-nightly.fly.dev` (57a8b8b), and `0.8.1-super-nightly.21` was published there and installed by hand into /Applications (signed, notarized, Gatekeeper accepted; nightly.20 kept at /tmp/Markie-nightly20-fallback.app). It opened already unlocked; account, synced docs and the 9 drafts intact (checked through Codex computer use).
- **Railway `markie` project deleted**, with the stopped API, its volume of database copies, and the old gateway with the leaked publish key. zvndev's Railway workspace is empty.
- **0.8.1 hotfix** on branch `hotfix/0.8.1-cloud-origin` (worktree `../markie-wt-hotfix-081`, 2427055): v0.8.0 plus the Cloud address change only. Default server `api.markiedocs.com`, the Railway host removed from the allowlist and the CSP, a saved Railway server migrated on read. v0.8.0's own suite on its own lockfile: 2528 passed, lint clean. Who it fixes: every released build; 4 non-ZVN accounts, one active on Oct 20.

## 2026-10-22 Google and email secrets rotated; per-client rate limits on Fly; 0.8.1 prepared

- **JustEmail:** new key `markie-api-fly-2026-10-22b` (id 301480317f6f5efa57f6a8080a1f7fc8, sending only, markiedocs.com only) set on Fly from the clipboard; a sign-in code to kirby@zvndev.com was accepted with no send errors. A first attempt made a key with all domains and an uncopied secret; it was revoked. The old `markie-api` key is still active until Kirby confirms delivery.
- **Google:** the OAuth client had two secrets (the cap). `yCIl` was unused and deleted; new secret `JxK-` set on Fly; a real web Google sign-in landed on the private test document; the leaked `v_8J` was disabled and is gone. The client now holds only `JxK-`.
- **Rate limits:** better-auth could not resolve the client IP on Fly and used one shared bucket. `MARKIE_CLIENT_IP_HEADER=fly-client-ip` on Fly only (618ce8a); warning gone after deploy.
- **0.8.1:** PR #13 merged to main (84cb5a5); `release:prepare:mac` passed (preflight, arm64 and x64 launch smoke, codesign, Gatekeeper, notarization stapled on apps and DMGs). The packaged app names `api.markiedocs.com`; the one Railway string left is the saved-address migration. Preflight needs `CLAUDE_CONFIG_DIR` unset on main until the MCP test isolation fix lands there. Not published: waiting for Kirby.
