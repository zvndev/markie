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
