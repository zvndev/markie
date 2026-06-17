# Markie Launch Phase 1 — Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the audit's two HIGH + several MED/LOW findings in the Markie app + MCP, harden the backend, and make the app/MCP surface OSS-ready — shipping the client fixes as 0.2.8.

**Architecture:** Pure, dependency-free helper modules (`electron/share-origin.js`) so security logic is unit-testable without booting Electron. The MCP `guardPath` gains filesystem canonicalization (`realpathSync`) to defeat symlink escapes. Backend auth fails closed + rate-limits per path. OSS-readiness is content/metadata. Repo split is a documented procedure run at Phase 4.

**Tech Stack:** Electron 41 (CJS `electron/`), Node ESM MCP (`mcp/`), Hono + better-auth + better-sqlite3 (`server/`), vitest (renderer + `electron/` `.ts` tests), `node:test` (`mcp/` `.mjs`, `server/` `.ts`).

**Spec:** `docs/superpowers/specs/2026-06-16-launch-phase1-hardening-design.md`

**Identity/commit note:** Work on branch `feat/launch-phase1-hardening`. Commits are LOCAL only — do NOT push, build, notarize, or publish without explicit user approval (the release + deploy steps carry env creds and are user-gated). Git identity is auto-resolved by `includeIf` (ZVN DEV) — never override.

---

## File Structure

**Create:**
- `electron/share-origin.js` — pure origin-pinning helpers (SSRF + token-exfil defense), shared by the deep-link handler and sync engine.
- `electron/share-origin.test.ts` — vitest unit tests for the above.
- `electron/terminal.test.ts` — vitest unit test for `isKnownApp`.
- `server/src/auth.test.ts` — `node:test` for `resolveAuthSecret`.
- `LICENSE` — MIT.

**Modify:**
- `electron/main.js` — use `shareBaseFromSrc` in `openSharedFromDeepLink` (SSRF); add `app://` CSP + protocol containment guard.
- `mcp/lib.mjs` — `guardPath` gains `realpathSync` canonicalization + write-mode allowlist-root denial.
- `mcp/markie-mcp.mjs` — pass `{ mode: "write" }` to the write tool's guard.
- `mcp/lib.test.mjs` — real-symlink escape tests.
- `electron/terminal.js` — validate `appName` against known apps.
- `electron/sync.js` — pin `serverURL` via `isAllowedServerOrigin` in `setConfig`.
- `server/src/auth.ts` — `resolveAuthSecret` fail-closed + `rateLimit` block.
- `server/package.json` — add `auth.test.ts` to the test script.
- `package.json`, `mcp/package.json` — version bump + public metadata.
- `README.md` — rewrite for a public audience.

---

## Task 0: Branch

- [ ] **Step 1: Create the feature branch**

Run:
```bash
cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/markdown-viewer-zvn
git checkout -b feat/launch-phase1-hardening
git config user.name && git config user.email   # verify ZVN DEV identity
```
Expected: on `feat/launch-phase1-hardening`; identity prints `ZVN DEV` / `78920650+zvndev@users.noreply.github.com`.

---

## Task 1: SSRF fix — pin the shared-doc fetch origin (HIGH)

**Files:**
- Create: `electron/share-origin.js`
- Create: `electron/share-origin.test.ts`
- Modify: `electron/main.js` (require at top; `openSharedFromDeepLink` line ~123)

- [ ] **Step 1: Write the failing test**

Create `electron/share-origin.test.ts`:
```ts
import { describe, it, expect } from "vitest";
// CJS interop: the module uses module.exports.
import mod from "./share-origin.js";
const { shareBaseFromSrc, isAllowedServerOrigin, DEFAULT_SERVER } = mod as typeof import("./share-origin.js");

describe("shareBaseFromSrc", () => {
  it("returns the allowlisted production origin when src matches", () => {
    expect(shareBaseFromSrc("https://api-production-602f.up.railway.app")).toBe(
      "https://api-production-602f.up.railway.app",
    );
  });
  it("falls back to DEFAULT_SERVER for an attacker host (no SSRF)", () => {
    expect(shareBaseFromSrc("evil.com")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("169.254.169.254")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("http://api-production-602f.up.railway.app")).toBe(DEFAULT_SERVER); // not https
    expect(shareBaseFromSrc("https://api-production-602f.up.railway.app.evil.com")).toBe(DEFAULT_SERVER);
  });
  it("falls back to DEFAULT_SERVER for empty/garbage src", () => {
    expect(shareBaseFromSrc("")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("::::")).toBe(DEFAULT_SERVER);
  });
  it("allows localhost only in dev mode", () => {
    expect(shareBaseFromSrc("http://localhost:8787", { allowDev: true })).toBe("http://localhost:8787");
    expect(shareBaseFromSrc("http://localhost:8787")).toBe(DEFAULT_SERVER);
  });
});

describe("isAllowedServerOrigin", () => {
  it("accepts the production origin, rejects others", () => {
    expect(isAllowedServerOrigin("https://api-production-602f.up.railway.app")).toBe(true);
    expect(isAllowedServerOrigin("https://evil.com")).toBe(false);
    expect(isAllowedServerOrigin("http://api-production-602f.up.railway.app")).toBe(false);
    expect(isAllowedServerOrigin(null as unknown as string)).toBe(false);
  });
  it("accepts localhost only in dev", () => {
    expect(isAllowedServerOrigin("http://localhost:8787", { allowDev: true })).toBe(true);
    expect(isAllowedServerOrigin("http://localhost:8787")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/share-origin.test.ts`
Expected: FAIL — `Cannot find module './share-origin.js'`.

- [ ] **Step 3: Create the implementation**

Create `electron/share-origin.js`:
```js
// Origin-pinning helpers, kept pure + dependency-free so they unit-test without
// booting Electron. Used by the markie://open deep-link handler and the sync
// engine to stop an attacker-controlled origin from receiving a fetch (SSRF) or
// the bearer token (token exfiltration).

// Canonical Markie production API. Update here if the backend moves.
const DEFAULT_SERVER = "https://api-production-602f.up.railway.app";

// Hosts we will talk to. Add the custom domain here when it ships.
const ALLOWED_HOSTS = new Set([
  "api-production-602f.up.railway.app",
  // "markie.zvndev.com",
]);

function isLocalhost(host) {
  const h = String(host).split(":")[0];
  return h === "localhost" || h === "127.0.0.1";
}

// Resolve the base origin to fetch a shared doc from. The deep link carries a
// `src`, but we NEVER trust it as a fetch target: honor it only when it is an
// explicitly allowlisted Markie https origin (or localhost in dev), otherwise
// fall back to the known production API. Defeats markie://open?src=<attacker>.
function shareBaseFromSrc(src, { allowDev = false } = {}) {
  if (src) {
    try {
      const u = new URL(/^https?:\/\//i.test(src) ? src : `https://${src}`);
      const okHost = ALLOWED_HOSTS.has(u.host) || (allowDev && isLocalhost(u.host));
      const okProto = u.protocol === "https:" || (allowDev && u.protocol === "http:");
      if (okHost && okProto) return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_SERVER;
}

// May we forward the bearer token / sync to this server URL? Pin to the known
// production origin (plus localhost in dev).
function isAllowedServerOrigin(serverURL, { allowDev = false } = {}) {
  if (!serverURL || typeof serverURL !== "string") return false;
  try {
    const u = new URL(serverURL);
    if (ALLOWED_HOSTS.has(u.host) && u.protocol === "https:") return true;
    if (allowDev && isLocalhost(u.host)) return true;
    return false;
  } catch {
    return false;
  }
}

module.exports = { DEFAULT_SERVER, ALLOWED_HOSTS, shareBaseFromSrc, isAllowedServerOrigin };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/share-origin.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Wire it into `electron/main.js`**

At the top requires (after line 14 `const { autoUpdater } = require("electron-updater");`), add:
```js
const { shareBaseFromSrc } = require("./share-origin");
```
In `openSharedFromDeepLink`, replace line ~123:
```js
    const base = (/^https?:\/\//i.test(src) ? src : `https://${src}`).replace(/\/$/, "");
```
with:
```js
    // SECURITY: never fetch from the deep link's raw `src` (SSRF). Pin to an
    // allowlisted Markie origin; unknown/attacker srcs fall back to production.
    const base = shareBaseFromSrc(src, { allowDev: isDev });
```
Also relax the early guard at line ~115 so a missing `src` no longer aborts (we now default it):
```js
  if (!token) return;
```
(was `if (!token || !src) return;`).

- [ ] **Step 6: Commit**

```bash
git add electron/share-origin.js electron/share-origin.test.ts electron/main.js
git commit -m "fix(security): pin markie://open fetch origin to defeat SSRF"
```

---

## Task 2: MCP symlink-escape fix — canonicalize in guardPath (HIGH)

**Files:**
- Modify: `mcp/lib.mjs` (`guardPath`)
- Modify: `mcp/markie-mcp.mjs` (write call site ~106)
- Modify: `mcp/lib.test.mjs` (add real-symlink tests)

- [ ] **Step 1: Write the failing tests**

Append to `mcp/lib.test.mjs` (add imports at top: the file currently imports from `./lib.mjs` only — extend it):
```js
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

test("guardPath denies a .md symlink that points outside home (read escape)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const outside = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-out-")));
  try {
    writeFileSync(pjoin(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(pjoin(outside, "secret.txt"), pjoin(home, "link.md"));
    const r = guardPath(pjoin(home, "link.md"), home);
    assert.equal(r.ok, false, "symlink to outside-home non-md must be denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("guardPath denies writing through a symlinked directory (write escape)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  const outside = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-out-")));
  try {
    symlinkSync(outside, pjoin(home, "escape")); // dir symlink under home
    const r = guardPath(pjoin(home, "escape", "implanted.md"), home, { mode: "write" });
    assert.equal(r.ok, false, "write through a symlinked dir must be denied");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("guardPath allows an ordinary real .md under a real home", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    mkdirSync(pjoin(home, "notes"));
    writeFileSync(pjoin(home, "notes", "a.md"), "# hi");
    const r = guardPath(pjoin(home, "notes", "a.md"), home);
    assert.equal(r.ok, true, r.error);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("guardPath write-mode denies the allowlist skill roots (no agent-file implant)", () => {
  const home = realpathSync(mkdtempSync(pjoin(tmpdir(), "markie-home-")));
  try {
    mkdirSync(pjoin(home, ".claude", "skills"), { recursive: true });
    const r = guardPath(pjoin(home, ".claude", "skills", "x.md"), home, { mode: "write" });
    assert.equal(r.ok, false, "writing under ~/.claude/skills must be denied");
    // but reading is still fine
    assert.equal(guardPath(pjoin(home, ".claude", "skills", "x.md"), home).ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test mcp/lib.test.mjs`
Expected: FAIL — the symlink-escape tests fail (current guard is lexical-only and allows them); the write-mode allowlist test fails (no mode support yet).

- [ ] **Step 3: Implement canonicalization in `mcp/lib.mjs`**

Add to the imports (line 4):
```js
import { resolve, join, sep, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";
```
(Replace the existing `import { resolve, join, sep } from "node:path";`.)

Add this helper above `guardPath`:
```js
// Canonicalize by realpath-ing the deepest EXISTING ancestor and re-appending
// the non-existent tail. This resolves any symlink in the path (file OR dir) so
// the caller's checks run against the real on-disk location, not the lexical
// string. New files (whose parents may not exist yet) still resolve correctly.
function canonicalize(full) {
  let existing = full;
  const tail = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = realpathSync(existing);
      return tail.length ? join(real, ...tail.slice().reverse()) : real;
    } catch (e) {
      if (e.code !== "ENOENT") throw e; // ELOOP/EACCES/… → caller rejects
      const parent = dirname(existing);
      if (parent === existing) return full; // hit the root; nothing existed
      tail.push(basename(existing));
      existing = parent;
    }
  }
}
```

Replace `guardPath` (lines 40-65) with:
```js
export function guardPath(input, home, { mode = "read" } = {}) {
  if (!input || typeof input !== "string") {
    return { ok: false, error: "path is required" };
  }
  let full = input;
  if (full === "~") full = home;
  else if (full.startsWith("~/")) full = join(home, full.slice(2));
  full = resolve(full);

  // Canonicalize home + target so symlinks can't dodge the checks below.
  let homeReal = home;
  try { homeReal = realpathSync(home); } catch { /* fake/non-existent home in tests */ }
  let real;
  try { real = canonicalize(full); } catch {
    return { ok: false, error: "path could not be resolved" };
  }

  if (!MD_RE.test(real)) {
    return { ok: false, error: "only .md, .markdown, or .mdx files are allowed" };
  }
  if (real !== homeReal && !real.startsWith(homeReal + sep)) {
    return { ok: false, error: "path must be inside your home folder" };
  }

  const root = allowRootFor(real, homeReal);
  if (mode === "write" && root) {
    return { ok: false, error: "writing agent/skill files is disabled" };
  }

  const dirSegs = relSegments(real, homeReal).slice(0, -1); // drop the filename
  const skip = root ? relSegments(root, homeReal).length : 0;
  for (const s of dirSegs.slice(skip)) {
    if (isExcludedDir(s)) {
      return { ok: false, error: `refused: "${s}" is an excluded directory` };
    }
  }
  return { ok: true, path: real };
}
```

- [ ] **Step 4: Pass write mode at the write call site — `mcp/markie-mcp.mjs`**

Line ~106, in `case "markie_write_md"`, change:
```js
      const g = guardPath(args.path, HOME);
```
to:
```js
      const g = guardPath(args.path, HOME, { mode: "write" });
```

- [ ] **Step 5: Run all MCP tests**

Run: `node --test mcp/lib.test.mjs`
Expected: PASS — new symlink/write tests pass AND all pre-existing guardPath tests still pass (fake `/home/u` paths: `canonicalize` returns the lexical path since nothing exists, so behavior is unchanged).

- [ ] **Step 6: Commit**

```bash
git add mcp/lib.mjs mcp/markie-mcp.mjs mcp/lib.test.mjs
git commit -m "fix(security): realpath-canonicalize MCP guardPath to block symlink escapes; deny writes to skill roots"
```

---

## Task 3: Validate external-terminal app name (MED)

**Files:**
- Modify: `electron/terminal.js`
- Create: `electron/terminal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/terminal.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import mod from "./terminal.js";
const { isKnownApp } = mod as unknown as { isKnownApp: (n: string) => boolean };

describe("isKnownApp", () => {
  it("accepts detected terminal ids and names", () => {
    expect(isKnownApp("ghostty")).toBe(true);
    expect(isKnownApp("iTerm")).toBe(true);
    expect(isKnownApp("terminal")).toBe(true);
    expect(isKnownApp("Terminal")).toBe(true);
  });
  it("rejects anything else (no arbitrary app launch)", () => {
    expect(isKnownApp("Calculator")).toBe(false);
    expect(isKnownApp("")).toBe(false);
    expect(isKnownApp("../../evil")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run electron/terminal.test.ts`
Expected: FAIL — `isKnownApp is not a function`.

- [ ] **Step 3: Implement in `electron/terminal.js`**

After the `CANDIDATES` array (line ~95) add:
```js
function isKnownApp(appName) {
  return CANDIDATES.some((c) => c.id === appName || c.name === appName);
}
```
In `openExternal` (line ~104), after the darwin check add the guard:
```js
function openExternal(appName, cwd) {
  if (process.platform !== "darwin") return { error: "macOS only" };
  if (!isKnownApp(appName)) return { error: "unknown terminal app" };
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  ...
```
Export it (line ~115 `module.exports`): add `isKnownApp,`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/terminal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/terminal.js electron/terminal.test.ts
git commit -m "fix(security): validate external terminal app name against detected apps"
```

---

## Task 4: Pin serverURL before forwarding the bearer token (LOW)

**Files:**
- Modify: `electron/sync.js` (`setConfig`, line 10)

- [ ] **Step 1: Implement (covered by Task 1's tested helper)**

At the top of `electron/sync.js` (after line 6 `const registry = require("./registry");`) add:
```js
const { isAllowedServerOrigin } = require("./share-origin");
```
Replace `setConfig` (lines 10-12):
```js
function setConfig(next) {
  const serverURL = next.serverURL ?? null;
  // SECURITY: only forward the bearer token to an allowlisted origin so a future
  // code path can't be tricked into exfiltrating the session token.
  const allowed = isAllowedServerOrigin(serverURL, {
    allowDev: process.env.NODE_ENV === "development",
  });
  config = { token: next.token ?? null, serverURL: allowed ? serverURL : null };
}
```

- [ ] **Step 2: Verify the helper tests still cover this**

Run: `npx vitest run electron/share-origin.test.ts`
Expected: PASS (the `isAllowedServerOrigin` cases already assert the production origin is accepted and others rejected).

- [ ] **Step 3: Commit**

```bash
git add electron/sync.js
git commit -m "fix(security): pin sync serverURL to allowlisted origin before sending token"
```

---

## Task 5: `app://` CSP + protocol containment guard (MED + LOW)

**Files:**
- Modify: `electron/main.js` (top require; `registerProtocol`; add `setupCSP`)

This task is verified by build + preflight + manual DevTools inspection (CSP is not unit-testable here). Iterate the policy until the app works.

- [ ] **Step 1: Add the containment guard to the `app://` handler**

In `protocol.handle("app", ...)` (line ~216), after `const fullPath = path.join(outDir, filePath);` (line ~223) insert:
```js
    // SECURITY: never serve outside the bundled out/ dir even if the path
    // contains traversal (defensive — renderer origin is app:// only).
    const resolvedOut = path.resolve(outDir);
    const resolvedFull = path.resolve(fullPath);
    if (resolvedFull !== resolvedOut && !resolvedFull.startsWith(resolvedOut + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
```

- [ ] **Step 2: Add a strict CSP for the packaged renderer**

Add `session` to the top require (line 1-10 destructure): add `session,`.
Add this function near `registerProtocol` (after line ~243):
```js
// Strict CSP for the packaged app:// renderer. A backstop behind the markdown
// sanitizer. Not applied in dev (Next HMR needs a looser policy).
function setupCSP() {
  if (isDev) return;
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // Next static export inlines a bootstrap
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://api-production-602f.up.railway.app wss://api-production-602f.up.railway.app",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] },
    });
  });
}
```
Call `setupCSP()` inside `app.whenReady().then(() => { ... })` (line ~896), BEFORE `registerProtocol()` / window creation.

- [ ] **Step 3: Build + run the preflight gate to confirm the app still loads**

Run:
```bash
npm run build
MARKIE_SKIP_PREFLIGHT=  npx electron-builder --mac --arm64 --dir   # --dir = unsigned, fast; preflight runs in afterPack
```
Expected: `[preflight] ✓ window loaded` (no CSP-induced blank screen / console errors). If the renderer breaks, open the packed app, check DevTools console for `Refused to … because it violates the … Content-Security-Policy`, and widen only the specific directive that broke (record the tradeoff in a code comment). Re-run until preflight passes.

- [ ] **Step 4: Manually verify core flows under CSP**

Launch the `--dir` build and confirm: editor renders, markdown preview shows (KaTeX + highlight styles), and signing in / sync works (connect-src reaches the API). 

- [ ] **Step 5: Commit**

```bash
git add electron/main.js
git commit -m "fix(security): add app:// CSP backstop + protocol path containment guard"
```

---

## Task 6: Backend — fail-closed auth secret + rate limits (WS2)

**Files:**
- Modify: `server/src/auth.ts`
- Create: `server/src/auth.test.ts`
- Modify: `server/package.json` (test script)

- [ ] **Step 1: Write the failing test**

Create `server/src/auth.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAuthSecret } from "./auth.ts";

test("resolveAuthSecret returns the provided secret", () => {
  assert.equal(resolveAuthSecret({ BETTER_AUTH_SECRET: "real" } as NodeJS.ProcessEnv), "real");
});

test("resolveAuthSecret throws in production when unset", () => {
  assert.throws(
    () => resolveAuthSecret({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    /BETTER_AUTH_SECRET is required/,
  );
});

test("resolveAuthSecret allows a dev fallback outside production", () => {
  const s = resolveAuthSecret({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.match(s, /dev-secret/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && node --experimental-strip-types --test src/auth.test.ts`
Expected: FAIL — `resolveAuthSecret` is not exported. (Importing `auth.ts` will currently also construct `betterAuth`; that's fine, it boots with the dev fallback.)

- [ ] **Step 3: Implement in `server/src/auth.ts`**

Add an exported helper above `export const auth` (after the `googleConfigured` const, line ~8):
```ts
// Fail closed: production MUST set BETTER_AUTH_SECRET (it signs session tokens).
// A hardcoded fallback in a public repo would let anyone forge sessions against
// a misconfigured deployment.
export function resolveAuthSecret(env: NodeJS.ProcessEnv): string {
  const s = env.BETTER_AUTH_SECRET;
  if (!s) {
    if (env.NODE_ENV === "production") {
      throw new Error("BETTER_AUTH_SECRET is required in production");
    }
    return "markie-dev-secret-not-for-prod";
  }
  return s;
}
```
Change the `secret:` line (13):
```ts
  secret: resolveAuthSecret(process.env),
```
Add a `rateLimit` block (after `trustedOrigins`, line ~18):
```ts
  rateLimit: {
    enabled: true, // default is prod-only; turn on everywhere
    window: 10,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 10 },
      "/email-otp/send-verification-otp": { window: 60, max: 5 },
    },
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && node --experimental-strip-types --test src/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the test to the server test script**

In `server/package.json`, append `src/auth.test.ts` to the existing `"test"` script's file list (match the existing pattern).
Run the full server suite: `cd server && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth.ts server/src/auth.test.ts server/package.json
git commit -m "fix(server): fail-closed auth secret in prod + per-path rate limits"
```

> **Deploy is user-gated.** Do NOT `railway up` without explicit approval. When approved: `railway up server --path-as-root --service api --ci`, then smoke-test: repeatedly POST `/api/auth/email-otp/send-verification-otp` and confirm a `429` after the limit; confirm the service boots (env secret is set).

---

## Task 7: OSS-readiness — LICENSE, README, package metadata (WS3)

**Files:**
- Create: `LICENSE`
- Modify: `README.md`
- Modify: `package.json`, `mcp/package.json`

- [ ] **Step 1: Add the MIT LICENSE**

Create `LICENSE` (standard MIT text):
```
MIT License

Copyright (c) 2026 ZVN

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Rewrite `README.md` for a public audience**

Replace the create-next-app boilerplate with a Markie README. Required sections (write real prose — no placeholders):
- **Title + one-liner:** "Markie — a fast, native markdown editor for macOS (Apple Silicon). Free."
- **Screenshot** placeholder line: `<!-- demo gif added in Phase 2 -->`
- **Features:** editor + live preview/split, device-wide Browse index, agent/skill file browsing, sharing via public links, and the **Markie MCP** (let Claude Code / Codex find/read/write your markdown).
- **Install:** "Download for Apple Silicon macOS" → (download link placeholder `https://<marketing-site>/download/mac`), note: Apple Silicon only, notarized.
- **Build from source:** `npm install`, `npm run build`, `npm run electron` (or the repo's actual scripts — confirm names in `package.json` before writing).
- **MCP setup:** `claude mcp add markie -- node <path>/mcp/markie-mcp.mjs` and the Codex `~/.codex/config.toml` snippet.
- **License:** MIT.
Keep it tight (React-docs concise). No internal infra, no Railway/B2/Apple-ID references.

- [ ] **Step 3: Fill `package.json` public metadata + bump version**

In `package.json`: bump `"version"` to `"0.2.8"`; add `"description"`, `"author": "ZVN"`, `"license": "MIT"`, `"repository": { "type": "git", "url": "<public repo URL — confirm at Phase 4>" }`, `"homepage": "<marketing site>"`, `"keywords": ["markdown", "editor", "macos", "electron", "mcp"]`. Keep `"private": true`.

- [ ] **Step 4: Fill `mcp/package.json` metadata**

Add `"license": "MIT"`, `"author": "ZVN"`, `"repository"` (same public URL). Keep its existing `description`.

- [ ] **Step 5: Commit**

```bash
git add LICENSE README.md package.json mcp/package.json
git commit -m "docs: add MIT LICENSE, public README, package metadata; bump 0.2.8"
```

---

## Task 8: Full regression + release prep (user-gated release)

- [ ] **Step 1: Run every test suite**

Run:
```bash
npx vitest run                              # renderer + electron .ts tests
node --test mcp/lib.test.mjs                # MCP
cd server && npm test && cd ..              # server node:test
```
Expected: all green.

- [ ] **Step 2: Re-confirm the two HIGH exploits are dead**

- SSRF: `shareBaseFromSrc("evil.com")` returns the production origin (covered by Task 1 test) — confirm green.
- Symlink: the Task 2 real-symlink tests DENY — confirm green.

- [ ] **Step 3: Lint + typecheck**

Run: `npm run lint && npx tsc --noEmit -p tsconfig.json`
Expected: clean (watch the pre-existing `leftViewRef` ref-during-render warning in `src/app/page.tsx` — do not regress it further).

- [ ] **Step 4: STOP — request approval to build/notarize/publish 0.2.8**

The release uses Apple + B2 env creds and publishes to users. Present the green test results and ask the user to approve the release. On approval, follow `docs/RELEASING.md` (notarize:true, do NOT set CSC_NAME, env creds inline) and verify the preflight gate passes before publish.

---

## Task 9 (Phase 4, documented now): Public repo split procedure

Run only at the Phase 4 flip — defined here so it isn't improvised.

1. Build the curated tree into a sibling dir:
```bash
SRC=/Users/macbookpro-kirby/Desktop/Coding/ZVN/markdown-viewer-zvn
DST=/tmp/markie-public
rm -rf "$DST" && mkdir -p "$DST"
rsync -a \
  --include='electron/***' --include='src/***' --include='mcp/***' \
  --include='build/***' --include='public/***' \
  --include='package.json' --include='package-lock.json' \
  --include='tsconfig.json' --include='next.config.ts' \
  --include='postcss.config.*' --include='tailwind.config.*' --include='vitest.config.ts' \
  --include='README.md' --include='LICENSE' \
  --exclude='*' "$SRC"/ "$DST"/
```
2. Write a public `.gitignore` (drop the `server/*` lines; keep `node_modules`, `.next`, `out`, `dist`, `*.tsbuildinfo`, `.DS_Store`).
3. Confirm EXCLUDED (must NOT be present in `$DST`): `server/ deploy/ docs/ scripts/ .claude/` and any session files.
4. Re-scan the curated tree before publishing:
```bash
cd "$DST" && git init -q && git add -A
gitleaks detect --no-banner --redact --source "$DST"
grep -rIn --exclude-dir=node_modules -E 'kirby@|/Users/macbookpro|3VU8SG5TD9|bfyj-|K005wF|005470bcb' "$DST" || echo "clean"
```
Expected: gitleaks `no leaks found`, grep `clean`.
5. Single initial commit + push to the new public repo:
```bash
cd "$DST" && git commit -q -m "Markie 0.2.8 — initial public release"
# create + push to the new public GitHub repo (name confirmed at Phase 4)
```

---

## Self-Review

- **Spec coverage:** WS1 → Tasks 1-5; WS2 → Task 6; WS3 → Task 7; WS4 → Task 9; release → Task 8. Every spec item maps to a task. ✔
- **Placeholders:** README has intentional `<marketing-site>` / repo-URL placeholders resolved at Phase 2/4 (flagged, not silent). No code-step placeholders. ✔
- **Type/name consistency:** `shareBaseFromSrc`/`isAllowedServerOrigin` (Tasks 1, 4), `isKnownApp` (Task 3), `canonicalize`/`guardPath({mode})` (Task 2), `resolveAuthSecret` (Task 6) used consistently across tasks. ✔
- **Test runner match:** `.test.ts` → vitest (electron/src), `.mjs` → `node --test` (mcp), server `.ts` → `node --experimental-strip-types --test`. ✔
