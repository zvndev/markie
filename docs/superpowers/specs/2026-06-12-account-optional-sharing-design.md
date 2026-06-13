# Account-optional sharing — design

Date: 2026-06-12
Status: Draft for review
Owner: Kirby (ZVN)

## Problem

Today, sharing a Markie doc requires the recipient to **already have a Markie
account**. `POST /api/docs/:id/shares` looks the email up in the users table and
returns `No Markie account with that email yet` when it misses. That contradicts
the dialog's own promise ("They get an email, and the doc appears in their
Library. Everyone in it edits live, together.") and blocks the most common real
case: sharing with someone who has never heard of Markie.

We want sharing to feel like tossing someone a file — no account required to
**receive and read** it, with a gentle, playful nudge to join because Markie is
simply the nicest way to work with `.md`.

## Goals

1. Invite **any** email address. Never error on "not a user yet."
2. The recipient gets an email. If/when they make an account, the shared doc
   **appears in their Library's Shared-with-me / Invites list** — whether they
   signed up before or after the invite.
3. **Default share role is viewer.** Editors can be invited explicitly and need
   an account to edit live. Viewers can read + download.
4. **A dedicated Invites / "Shared with me" list in the app** — every doc shared
   with you is visible there with who shared it and your role, distinct from
   your own cloud files.
5. **Cloud stays optional.** Opening a shared cloud doc auto-joins its live
   session (viewers read-only, editors read-write) — zero clicks. But a viewer
   can also pull a **copy down to disk** and work on it offline like any local
   file, with no account or connection needed.
6. A **public, account-free** way to view + download the doc: an unguessable,
   revocable link that opens a beautiful rendered preview with a `Download .md`
   button and a lighthearted "get Markie" CTA.
7. Tone throughout is fun and a little cheeky — not corporate tech.

## Non-goals

- Public **editing** without an account. Public link = read + download only.
  Editing/live-collab still requires an account (membership).
- Granular per-link permissions, password-protected links, analytics. (Later.)
- Changing the existing Yjs/y-websocket live-collab transport. It already works
  for members; we only widen *who becomes a member*.

## Decisions already made (from brainstorming)

- **Public link access model:** anyone-with-link (no email gate). Revocable.
- **Landing page:** rich rendered preview + download (not download-only).
- **Hosting:** the pretty public page waits for an upcoming **custom domain**
  (Kirby is setting domains up now). Until the domain exists we ship the
  account-flow half and the email points people at "get Markie / sign in."

## Open decisions (resolve during review)

- **OD-1 — Domain.** What domain hosts public links (e.g. `markie.zvndev.com`,
  or a marketing domain)? Public URLs are `https://<domain>/s/:token`.
- **OD-2 — Markie-fw coupling.** The public preview page renders Markdown. We
  have `markie-framework` (`Markie-fw`, v0.3.0): Markdown-native, `.wd`
  directives, `.skin` styling, **zero-JS static output**. Options:
  - **(A, recommended) Render public pages with markie-framework.** The shared
    `.md` is rendered by the framework's renderer; the surrounding landing
    page + marketing pages are authored as `.wd`/`.skin`. One rendering brain,
    zero-JS output, dogfoods the framework. Coupling: Markie's server (or a
    small static build step) depends on markie-framework's renderer.
  - **(B) Keep Markie's existing renderer** (`src/lib/markdown-html.ts`) for the
    public page now; revisit unifying on markie-framework later. Faster, but two
    renderers to keep visually consistent.
  Recommendation: **A**, because the public page is exactly the framework's
  sweet spot (static, gorgeous, zero-JS) and it's the moment to dogfood.
- **OD-3 — Framework naming.** `markie-framework` may be renamed **darkmown** or
  **darkmound**. Affects branding/package name, not this spec's mechanics. Pick
  before we hard-link package names in the build.

## Architecture

Three share "kinds" over one doc:

| Kind            | Who                          | Capability        | Account? |
|-----------------|------------------------------|-------------------|----------|
| Member share    | a specific Markie user       | view/edit + live  | required |
| Pending invite  | an email with no account yet | becomes a member  | on join  |
| Public link     | anyone with the token        | view + download   | never    |

### Data model (server, better-sqlite3)

New table:

```sql
CREATE TABLE IF NOT EXISTS pending_shares (
  doc_id      TEXT NOT NULL,
  email       TEXT NOT NULL,           -- lower-cased
  role        TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  invited_by  TEXT NOT NULL,
  token       TEXT NOT NULL,           -- unguessable; used by the invite email
  created_at  TEXT NOT NULL,
  PRIMARY KEY (doc_id, email)
);
CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_shares(email);
```

Public link token on the doc (own table so it's revocable independently):

```sql
CREATE TABLE IF NOT EXISTS public_links (
  doc_id     TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,     -- unguessable (crypto.randomUUID x2 / base58)
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### API

- `POST /api/docs/:id/shares` (owner only) — body `{ email, role }`:
  - normalize email; if it maps to an existing user → insert `shares` row
    (today's behavior) and send a "you've been added" email.
  - else → upsert `pending_shares` + send an **invite** email. Respond
    `{ status: "invited" }` (never an error for unknown email).
- `GET /api/docs/:id/shares` (owner) — returns members **and** pending invites
  (so the dialog shows "Invited (pending)" rows).
- `DELETE /api/docs/:id/shares/:idOrEmail` — revoke a member or a pending invite.
- `POST /api/docs/:id/public-link` (owner) — create-or-return the public token.
- `DELETE /api/docs/:id/public-link` (owner) — revoke (rotate) it.
- `GET /s/:token` — **public, no auth.** Renders the preview page (deferred to
  OD-1 domain). Resolves token → doc; 404 if revoked/missing.
- `GET /s/:token/raw` — **public.** Streams the raw `.md` with
  `Content-Disposition: attachment; filename="<name>.md"`.

### Auto-claim (the "appears in their Library" magic)

When a pending-invited email becomes a real user, materialize their invites:

1. **On signup** — better-auth `databaseHooks.user.create.after`: look up
   `pending_shares` by the new user's (lower-cased) email, insert matching
   `shares` rows, delete the claimed pending rows.
2. **Sweep on read** — when a user fetches their shared docs (the Library cloud
   list / `sharedDocsFor`), also claim any `pending_shares` for their email
   first. This covers "invited *after* they already had an account" and is
   idempotent.

Because claimed invites become ordinary `shares`, live-collab eligibility
(`refreshCollab`) lights up automatically. The client changes below make the
shared docs show in their own **Invites** list rather than being lumped into
"In your cloud."

### Client app: Invites list, roles, and opt-in collab

The server already returns shared docs from `GET /api/docs` tagged
`{ shared: true, role }` alongside owned docs — but `electron/sync.js`
`libraryState()` currently drops both flags and files every remote doc under a
generic `cloud-only` item. Fixes:

- **Pass `shared` + `role` through.** `libraryState()` maps a remote doc with
  `shared === true` to a new item kind `shared` (carrying `role` and, ideally,
  the inviter's name/email from `sharedDocsFor`). Owned remote docs stay
  `cloud-only`.
- **`LibraryItem` type** gains `kind: "shared"`, `role?: "viewer" | "editor"`,
  and `sharedBy?: string`.
- **Library UI** grows a third section, **"Shared with you"** (the invite list),
  separate from "On this device" and "In your cloud". Each row shows the doc,
  who shared it, and a role badge (Viewer/Editor). Actions: **Open** (opens the
  cloud doc and auto-joins the live session — read-only for viewers), and
  **Download a copy** (pulls the `.md` to disk to work on offline, solo).
- **Default role = viewer.** `share-dialog.tsx` role state defaults to
  `"viewer"` (currently `"editor"`); the role `<select>` lists "Can view" first.
- **Collab stays auto-join.** Opening a shared cloud doc connects the live
  session automatically via the existing `refreshCollab` path (viewers
  read-only, editors read-write). The offline path is the separate "Download a
  copy" action, which needs no connection — preserving "cloud is optional."

### Email (Resend, via `src/email.ts`)

Extend `sendEmail` to accept an optional `html` body. Two templates, playful
voice:

- **Invite (no account yet):** subject e.g. `📄 Kirby tossed you a doc`.
  Body: "<name> shared **<doc>** with you. Reading raw markdown in a browser is
  a small tragedy — Markie fixes that. [Open it in Markie →]" The button points
  to the public link (preview/download) once OD-1 lands; until then, to a
  get-Markie / sign-in flow. A secondary "just download the .md" link uses
  `/s/:token/raw`.
- **Added (existing user):** subject e.g. `You're in: <doc>`. "<name> added you
  to **<doc>**. It's waiting in your Library — and you're both editing live."

### Public preview page (Phase 2 — needs OD-1 + OD-2)

`GET /s/:token` renders: the doc title, a gorgeous read-only render of the
content (per OD-2, via markie-framework for zero-JS output), a prominent
`Download .md`, and a lighthearted Markie CTA ("These look even better in
Markie. It's free, it's fast, your markdown will thank you."). "Open in Markie"
attempts the `markie://` deep link (installed users), falling back to the
download/app page.

## Phasing

- **Phase 1 (build now, no domain needed):** `pending_shares`, invite-any-email
  endpoint, auto-claim (signup hook + read sweep), updated `GET shares`
  (members + pending), revoke, the two emails (link target = get-Markie/sign-in
  for now), ShareDialog updates (accept any email, show pending rows, success
  state instead of the error, **default role = viewer**). Client: `libraryState`
  passes `shared`/`role` through, `LibraryItem` gains `shared` kind, Library
  grows a **"Shared with you" invites list**, and live collab becomes an
  explicit **Join live** action. Solo/offline viewing of a pulled copy needs no
  account or connection.
- **Phase 2 (on domain, OD-1 + OD-2):** `public_links`, `/s/:token` preview page
  rendered via markie-framework, `/s/:token/raw` download, swap the email button
  to the public link.

## Error handling

- Unknown email → `invited`, never an error.
- Inviting an email that's already a member or already invited → idempotent
  no-op success ("already shared").
- Owner-only guards on all share/public-link mutations (reuse `isOwner`).
- Revoked/missing public token → 404 page (Phase 2).
- Resend failure → logged; the pending/member row still persists so the invite
  isn't lost (owner can resend).

## Testing

- Unit: invite existing-user → member row + "added" email; invite unknown →
  pending row + invite email; duplicate invite idempotent; revoke removes
  pending/member; claim-on-signup materializes + deletes pending; read-sweep
  claims post-signup invites; non-owner blocked.
- Integration: end-to-end "invite stranger → they sign up → doc in Library →
  both edit live."
- Phase 2: public token resolves to preview + raw download; revoked token 404s;
  raw sets attachment headers.

## Security notes

- Tokens are unguessable (≥128 bits) and revocable. Public link exposes
  read+download of that one doc only.
- Emails are lower-cased/normalized before lookup and storage to avoid
  duplicate/missed claims.
- Pending invites carry no privileges until claimed by an authenticated user
  whose verified email matches.
