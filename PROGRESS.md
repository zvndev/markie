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
