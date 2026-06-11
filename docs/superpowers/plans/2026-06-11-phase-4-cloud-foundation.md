# Phase 4: Cloud Foundation — Server + Accounts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markie accounts exist: sign up / sign in with Google OAuth, email OTP, or email+password from inside the desktop app; a Settings page manages the account and the global sync toggle. Fully verifiable locally (server on localhost); production deploy is a documented checklist.

**Architecture (revision to roadmap D1):** Single Node service (`server/` in this repo) — Hono + better-auth + **SQLite (better-sqlite3) with Litestream replication to Backblaze B2** instead of Postgres. One process, one DB file, streaming backups included in the flat-cost story; no database container. Email via Resend when `RESEND_API_KEY` is set, console-logged locally. Desktop auth: better-auth's REST endpoints called from the renderer; Google OAuth opens the system browser and returns via `markie://` deep link.

**Tech Stack:** Hono, better-auth, better-sqlite3, (deploy: Docker + Caddy + Litestream on a Hetzner CAX11).

---

### Task 1: Server scaffold
- `server/package.json` (independent workspace; Node ≥22), `server/src/index.ts` (Hono app: `/health`, better-auth handler at `/api/auth/*`, `/api/me`), `server/src/auth.ts` (better-auth config: emailAndPassword, emailOTP, google provider env-gated, SQLite db), `server/src/email.ts` (Resend or console), `.env.example`.
- better-auth CLI generates its schema into the SQLite db on first run (`npx @better-auth/cli migrate`).
- Verify: `npm run dev` in server/, `curl /health`, sign-up via curl, `/api/me` with session cookie.

### Task 2: Desktop settings + auth client
- `src/lib/auth-client.ts`: server base URL config (localStorage `markie.server.v1`, default `http://localhost:8787`), thin fetch wrappers: signUpEmail, signInEmail, sendOTP, verifyOTP, getSession, signOut. Session cookie persists via Electron's session (privileged app:// origin + `credentials: "include"`; server CORS allows the app origin with credentials).
- `src/components/settings.tsx`: account section (signed-out: email+password form, OTP flow, "Continue with Google" → opens system browser; signed-in: email, sign out), sync toggle (persisted, consumed in Phase 5), server URL field (advanced).
- Menu: app menu "Settings…" (⌘,) + palette command; `markie://` protocol: `app.setAsDefaultProtocolClient("markie")` + `open-url` → forward to renderer (used by Google OAuth callback).
- Verify (local server running, packaged app via CDP): email+password sign-up from the app → settings shows the account → relaunch → still signed in → sign out works. OTP: code read from server console, entered in app. Google: flow opens browser (end verification deferred until Kirby provisions OAuth keys).

### Task 3: Deploy assets + checklist
- `server/Dockerfile`, `deploy/docker-compose.yml` (markie-api + caddy + litestream), `deploy/Caddyfile`, `deploy/litestream.yml`, `deploy/DEPLOY.md` — exact steps for Kirby: Hetzner CAX11, DNS A record, `.env` (BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID/SECRET, RESEND_API_KEY, B2 keys), `docker compose up -d`.

### Task 4: Verify, ship
- Full local CDP pass, tests/lint, roadmap update, PR, merge (standing approval).

**Kirby's provision checklist (needed for production go-live, not for this phase's verification):** Hetzner account+CAX11, a domain/subdomain (suggest `api.markie.zvndev.com` until the product domain is chosen), Backblaze B2 bucket + app key, Resend account + key + verified sender domain, Google OAuth client (desktop redirect to the server callback).
