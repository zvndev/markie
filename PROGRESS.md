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
