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
- Typecheck: `npm run typecheck`
- MCP tests: `node --test mcp/lib.test.mjs`
- Server tests: `(cd server && npm test)`

## Layout
- `src/app`, `src/components`, `src/lib`: Vite/React renderer, editor surfaces, markdown utilities.
- `electron`: Electron main/preload, local registry, terminal, sync, app integrations.
- `server`: Hono/better-auth server for sharing, public links, sync, collaboration, comments.
- `mcp`: dependency-free Markie MCP server and filesystem guards.
- `apps/mobile`: Capacitor iOS and Android app ("Markie Docs").
- `scripts`: release, packaging, and check scripts.
- `deploy`: self-hosting kit for the server (see `docs/SELF-HOSTING.md`), not the Markie Cloud deploy.
- `docs/mobile`: mobile store setup and the agent links contract.
- `docs/superpowers`: the document platform plan and the product specs it builds on.
- `.autoloop/runs`: gitignored evidence output from check scripts.

## Work tracking and hosting
- Open work is tracked in Circular (gocircular.dev). `BACKLOG.md` is a scratch list.
- Markie Cloud (`https://api.markiedocs.com`) deploys from the private `ZVN-DEV/zvn-infra` repo
  with Kamal. Never deploy it to Railway or Fly.

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

## Release Protocol

- `docs/RELEASING.md` is the authoritative full-release runbook.
- `server/download-manifest.json` is the sole stable-channel source for storage, updater feed paths,
  platform publication status, and permanent website/email routes. Electron Builder consumes it
  through `electron-builder.config.cjs`.
- Use `npm run release:version -- <semver>`; do not hand-edit version files independently.
- Prepare with `npm run release:prepare:mac` or `release:prepare:win`. Preparing must pass full
  preflight, launch smoke, signing (notarization and stapling on macOS), feed, size, and SHA-512
  checks before upload.
- Publishing is a human checkpoint. After explicit approval, publish to early access with
  `npm run release:publish:early:mac` or `release:publish:early:win`, each with
  `-- --confirm-public-release=<semver>`. Stable comes from `npm run release:promote-due` after the
  soak, or `release:promote` by hand. Never call Electron Builder with `--publish always` directly,
  and never use its standalone `publish` command as a dry run.
- A release is not complete until `npm run release:verify:public -- --version=<semver> --deep`
  passes and the previous app version visibly receives, downloads, installs, and relaunches through
  **Check for Updates**.
- Websites and emails link to `https://markiedocs.com/download` or a stable manifest route,
  never a versioned artifact URL.
