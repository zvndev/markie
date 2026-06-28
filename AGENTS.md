# Operating Manual — Markie

> Read by Codex natively and by Claude Code through `CLAUDE.md`. Keep this short and high-signal.

## What this project is
See `VISION.md` for the product north star and `CONSTITUTION.md` for non-negotiable rules. They
override task notes, backlog entries, and older progress logs.

## How to run / build / test
- Boot and smoke-test the repo: `./init.sh`
- Renderer/Electron unit tests: `npm test`
- Renderer/static build: `npm run build`
- Lint: `npm run lint`
- MCP tests: `node --test mcp/lib.test.mjs`
- Server tests: `(cd server && npm test)`

## Layout
- `src/app`, `src/components`, `src/lib`: Next/React renderer, editor surfaces, markdown utilities.
- `electron`: Electron main/preload, local registry, terminal, sync, app integrations.
- `server`: Hono/better-auth server for sharing, public links, sync, collaboration, comments.
- `mcp`: dependency-free Markie MCP server and filesystem guards.
- `docs/superpowers`: roadmap, specs, and historical implementation plans.
- `.autoloop`: long-agent-loop config, run logs, and schemas.

## Commit Protocol
Every commit must follow the Lore protocol:

```text
<intent line: why the change was made, not what changed>

Constraint: <external constraint that shaped the decision>
Rejected: <alternative considered> | <reason for rejection>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Directive: <forward-looking warning for future modifiers>
Tested: <what was verified>
Not-tested: <known gaps in verification>
```

Use only trailers that add real decision context.

## The Loop Protocol
This project is driven by the `long-agent-loop` skill. Each wakeup, in order:
1. Re-ground on `VISION.md`, `CONSTITUTION.md`, the tail of `PROGRESS.md`, and `git log`; run
   `./init.sh`. If broken, repair-only this run.
2. Select one task: the highest-priority unfinished `feature_list.json` entry or the top open
   `BACKLOG.md` item. If build work is exhausted, run the next scheduled review pass.
3. Write that one task to `CURRENT_TASK.md`, plan only that task, and escalate if it touches a
   human checkpoint.
4. Implement only that task. Adjacent discoveries go to `BACKLOG.md`, not into the current diff.
5. Verify against acceptance criteria as a real user; flip `passes` only with evidence.
6. Commit, append `PROGRESS.md` with terminal state, leave a clean tree, and stop.
