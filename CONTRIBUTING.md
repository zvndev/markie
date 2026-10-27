# Contributing to Markie

Thanks for looking at Markie. This page is everything you need to get from a
clone to a passing pull request.

## Requirements

- **Node 22 or newer** (`.nvmrc` pins the version this repo is developed on)
- **macOS or Windows** for running the desktop app; the tests, lint, and build run anywhere

## Setup

```sh
git clone https://github.com/zvndev/markie.git
cd markie
npm ci
(cd server && npm ci)   # only needed if you touch server/
```

## Running the app

```sh
npm run electron:dev    # Vite dev server + Electron
```

Two things to know before the first run:

- **Native modules are built for Node, not Electron.** `npm ci` compiles
  `better-sqlite3` against your Node ABI, but Electron uses its own. Run
  `npm run native:restore` before `electron:dev`, or the Library and Files
  panels fail on the first database call. Switching back to running the tests
  may require rebuilding for Node again.
- **`electron:dev` waits on port 3000.** If something else is already serving
  that port, Electron will load *that* instead. Free the port first.

On macOS the app writes to `~/Library/Application Support/markie`, the same directory the
installed Markie uses, so a from-source run shares your real library.

## Tests

`./init.sh` is the full gate and runs everything below. Run it before opening a
pull request.

```sh
npm test                        # renderer + Electron (vitest)
node --test mcp/lib.test.mjs    # MCP server
(cd server && npm test)         # Hono server
npm run lint
npm run typecheck               # tsc, no emit
npm run build                   # tsc again, then the Vite bundle
```

The whole suite takes a few seconds. CI runs the same checks on every pull
request.

Write a test with the change. New behavior gets a test that describes the
behavior; a bug fix gets a regression test that fails before the fix. Never
weaken or delete a test to make a build pass.

## Commit messages

Commits use a structured trailer format so the reasoning behind a change
survives. The first line says *why*, not *what*. Include only the trailers that
carry real information.

```text
Keep agent-loop run artifacts out of the published repository

Constraint: Screenshots taken during audit runs capture a real library.
Rejected: Publishing them as build-in-public material | 42MB of binaries.
Confidence: high
Scope-risk: narrow
Directive: Never track .autoloop/runs.
Tested: Full-tree diff against the pre-scrub backup.
Not-tested: None for this change.
```

## Where to start

Open work is tracked in Circular. `BACKLOG.md` is a scratch list of scoped
items with rationale and acceptance criteria. `VISION.md` is the best
orientation for how the product is meant to behave.

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/` | Vite renderer: app shell, components, markdown utilities |
| `electron/` | Main process, preload, local registry, sync, terminal |
| `server/` | Hono + better-auth server for sharing, sync, collab, comments |
| `mcp/` | Dependency-free MCP server and its filesystem guards |
| `apps/mobile/` | Capacitor iOS and Android app |
| `deploy/` | Self-hosting kit for the server (see `docs/SELF-HOSTING.md`) |
| `scripts/` | Release, packaging, and audit tooling |
| `docs/` | `RELEASING.md`, mobile store setup, plus historical plans and specs |

## Notes on some files

`AGENTS.md` and `CONSTITUTION.md` are written for the coding agents that do
much of the routine work on this repo. `PROGRESS.md` is the release and
operations log. They are context, not rules for human contributors. The parts
that do apply to everyone are the commit format above and the testing
expectations.

## Security

Please do not open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md).
