# Markie Mobile and agent links: the shared contract

_Status: approved for build by Kirby on 2026-10-25. This file is the contract every workstream builds
against. Change it only through the PM, and say so in your PR._

## Goal

An agent makes a document. It lands in the user's Markie Cloud as a private document. The agent gets
back a link and pastes it into chat. The user taps the link on their phone and it opens in the
Markie mobile app, rendered as richly as on the desktop, Darkmown interactivity included. The app's
home screen lists recent cloud documents and marks the ones an agent made.

Agents also stop defaulting to plain markdown. The guide and skill teach the richer things Markie
renders, and Darkmown (`.wd`) for documents that benefit from live state.

## Decisions

1. **Mobile stack: Capacitor (TypeScript) for iOS and Android.** It renders documents with the
   desktop's own React renderer, Darkmown compiler and runtime, so a document looks the same on
   every device. This supersedes the fully native proposal in `docs/mobile/MOBILE-PLAN.md` §10.1.
   The app lives in `apps/mobile` with its own `package.json`, outside the root `npm test`, lint,
   tsconfig and electron-builder globs.
2. **App identity:** bundle ID and Android package `com.zvn.markie.mobile`. Display name "Markie".
   Apple team `3VU8SG5TD9`.
3. **Two agent paths, one result.**
   - Local agents with the Markie MCP (Claude Code, Cursor on this Mac) keep using the desktop
     bridge: `markie_cloud_sync`, now also for `.wd`.
   - Remote agents, with no desktop app nearby, use a per-user **agent token** against the server:
     a REST API and a hosted MCP endpoint at `https://api.markiedocs.com/mcp`.
   Both produce a private document with an agent origin, and both return the same link shape.
4. **Private by default.** Nothing in this work makes a document public. Public links keep their
   existing rule: an agent asks only when the user explicitly asked, and the user confirms each one.
5. **Deferred, not in this build:** OAuth for claude.ai custom connectors (bearer tokens first),
   push notifications, Google and Apple sign-in on mobile, App Store and Play Store submission,
   comments on mobile, editing on mobile.

## Link contract

- Private link: `https://api.markiedocs.com/d/<id>` (unchanged). Public link: `/s/<token>`
  (unchanged). Self-hosted servers use their own origin in place of `https://api.markiedocs.com`.
- Every API or tool result that names a document returns both:
  - `privateLink`: the URL above.
  - `markdownLink`: `[<name>](<privateLink>)`, ready to paste into chat.
- `markdownLink` escaping (desktop and server must produce identical output):
  - In the name, replace every run of CR, LF, U+2028 and U+2029 with one space.
  - Then put a backslash before each of these characters in the name: `\`, `[`, `]`, `<`, `>`
    and the backtick.
  - In the URL, encode `(` as `%28` and `)` as `%29`.
- Agent names, document names and server messages are always rendered as plain text, never as
  markdown or HTML, on desktop, web and mobile.
- **Universal and app links.** The app claims paths `/d/*` and `/s/*` on `api.markiedocs.com` and
  `markiedocs.com`.
  - iOS: Associated Domains `applinks:api.markiedocs.com` and `applinks:markiedocs.com`.
  - Android: intent filters with `android:autoVerify="true"` for both hosts.
- The server serves, with `Content-Type: application/json`, no redirect and no auth:
  - `GET /.well-known/apple-app-site-association`: `applinks.details` for appID
    `3VU8SG5TD9.com.zvn.markie.mobile`. Components, in order: exclude `/d/*/*`, exclude `/s/*/*`,
    then include `/d/*` and `/s/*`. Apple's `*` also matches `/`, so without the excludes the app
    would also claim raw, asset and download paths.
  - `GET /.well-known/assetlinks.json`: package `com.zvn.markie.mobile`, fingerprints from env
    `ANDROID_APP_CERT_SHA256` (comma-separated). An empty array when unset.
  - `markiedocs.com` is a separate website that proxies `/d`, `/s` and `/download` to this server.
    Proxying `/.well-known/*` there is an external configuration step the PM does with Kirby. It is
    not part of any workstream.
- **Custom scheme fallback:** the app also handles `markie-mobile://d/<id>` and
  `markie-mobile://s/<token>`. The desktop keeps `markie://`.
- When the app isn't installed, the link opens the existing web page, as today.

## Schema (additive only)

Use the existing guarded `ALTER TABLE ... ADD COLUMN` migration pattern. Never rewrite or drop
existing columns.

- `docs.format TEXT NOT NULL DEFAULT 'markdown'`, one of `markdown`, `darkmown`, `text`. It's derived
  from the name's extension on create: `.wd` gives `darkmown`; `.txt`, `.text` and `.log` give
  `text`; everything else gives `markdown`. It's updated if a rename changes the extension.
- `docs.origin_kind TEXT NOT NULL DEFAULT 'app'`, one of `app` or `agent`. It's set on the first
  version only and never changes after.
- `docs.origin_agent TEXT`, a display name for the agent. It's trimmed and limited to 64 printable
  characters. NULL for `app`.
- `docs.origin_token_id TEXT`: the `agent_tokens.id` that created the document. It's set only by
  `POST /api/agent/docs` and the hosted MCP's create tool, and it's NULL for everything else,
  including documents a local agent synced through the desktop bridge. It never changes after
  creation, and it's never returned to clients.
- `docs.created_at TEXT`, set on new rows only. It's read as `updated_at` when NULL. No migration
  may rewrite every row: backfill `format` only for names ending `.wd`, `.txt`, `.text` or `.log`.
- New table `agent_tokens`:
  - `id TEXT PRIMARY KEY`, `user_id TEXT NOT NULL` and `name TEXT NOT NULL` (at most 64 characters).
  - `token_hash TEXT UNIQUE NOT NULL`: the SHA-256 hex of the full token. The token itself is
    never stored.
  - `prefix TEXT NOT NULL`: the first 12 characters, for display.
  - `created_at INTEGER NOT NULL`, `last_used_at INTEGER` and `revoked_at INTEGER`.
- Token format: `mk_agent_` followed by 32 random bytes in base64url. It's compared by hash with
  `timingSafeEqual`.
- Minting a token sends the account's email a plain-text notice. It names the token by its prefix
  and the time it was created only; the token's name is never in it, because a mail client may turn
  a name like `evil.com/login` into a link. It ends with a fixed line: "Markie never creates agent
  tokens on its own. If you didn't make this one, revoke it in Markie and reset your password,
  which signs out every other device." A name containing `://` or `www.` is still refused with a
  400, since names show in the token list. The notice uses the existing `server/src/email.ts`, and
  a send failure never blocks the mint.
- A password reset or change revokes all of the user's agent tokens. As a backstop that cannot fail
  open, a token whose `created_at` is earlier than the `updatedAt` of the user's credential account
  row is refused. better-auth stamps that row on every password write and on nothing else.
- A password reset also ends every session the user has (`revokeSessionsOnPasswordReset`), so a
  stolen session cannot mint again; the client signs back in with the new password. A password
  change ends every session except the caller's: the one it came with, or the new one better-auth
  issues when the caller asks for `revokeOtherSessions`. Other devices sign in again.

## Server API

All new JSON routes follow the existing error shape and size limits in `server/src/docs.ts`.

### Recent documents, for the mobile home screen (session bearer)

`GET /api/docs/recent?limit=<1..100, default 50>&before=<ISO updated_at cursor>`

The response covers the user's owned and shared markdown documents, newest `updated_at` first. Each
item is:

```json
{ "id": "…", "name": "Plan.wd", "format": "darkmown",
  "createdAt": "…", "updatedAt": "…",
  "origin": { "kind": "agent", "agent": "Claude Code" },
  "shared": false, "role": "owner", "sharedBy": null,
  "privateLink": "https://api.markiedocs.com/d/…" }
```

Document-platform documents (Word, ODT and others in `dp_documents`) are out of scope for this
list in this build.

Existing `GET /api/docs/:id` returns content for the viewer. Add `format` and `origin` to its
response.

`GET /api/docs` reports `sharedOut: true` for every document with an `origin_token_id`, as well as
for shared ones. The desktop treats that text as written by someone else, so it never pulls local
files that the text references into the cloud (`electron/asset-sync.js`).

The desktop's `PUT /api/docs/:id` accepts an optional body field
`origin: { "kind": "agent", "agent": "<name>" }`. It's honored only when the request creates the
document. It's ignored on every later version.

### Agent tokens (session auth only; an agent token can never manage tokens)

- `POST /api/agent-tokens {name}` returns `201 {id, name, token, prefix, createdAt}`. The token is
  shown exactly once. A user can have at most 20 active tokens.
- A user can mint at most 5 tokens an hour and 20 a day, revoked ones included, because each mint
  sends an email. Over that returns 429 with `Retry-After`, checked before anything is inserted.
- `GET /api/agent-tokens` returns `{tokens: [{id, name, prefix, createdAt, lastUsedAt}]}`, never
  the token itself.
- `DELETE /api/agent-tokens/:id` revokes immediately. It returns 204, and also returns 204 for a
  token that is already revoked. It returns 404 for an id that never belonged to this user.

### Agent documents (`Authorization: Bearer mk_agent_…`)

An agent token can create documents, and read and update **only the documents that same token
created** (`origin_token_id` equals the token's id, the owner matches, and the document isn't
deleted). It can't reach documents made by the user's other tokens, documents a local agent synced
through the desktop (which carry `origin_kind='agent'` for the badge, but no `origin_token_id`), or
anything else. A leaked token exposes the documents it created, and edits the owner makes to them
while they stay private. Nothing shared, and nothing synced from the Mac. Revoking a token leaves
its documents in place, owned by the user, and unreachable by any token.

This was ruled on 2026-10-25, after review found that the earlier wording ("documents created
through agent tokens of the same user") let any token reach every bridge-synced document.

- `POST /api/agent/docs {name, content, agent?}` returns
  `201 {id, name, format, version, privateLink, markdownLink}`.
  - Allowed extensions: `.md`, `.markdown`, `.mdx`, `.wd`, `.txt`. Anything else is a 400.
  - Size limits: `.wd` at most 128,000 characters (the Darkmown limit); everything else at most
    2 MB.
  - The document counts against the storage quota.
  - `origin_agent` is `agent` when it's given and valid, otherwise the token's name.
- `PUT /api/agent/docs/:id {content, name?, baseVersion?}` returns
  `{id, version, privateLink, markdownLink}`. It returns 409 on a version conflict, and 404 for
  any document outside the rule above. That 404 looks exactly like "no such document".
- `GET /api/agent/docs?limit=` returns metadata for this token's documents that it can still read,
  newest first. A document with an audience (below) is left out of the list entirely.
- **Shared or public documents are closed to tokens.** Once a document has any share, pending
  invite or public link, a `PUT` from a token returns 409 `{error: "shared"}`, with a message
  telling the agent to create a new document instead. `GET /api/agent/docs/:id` returns the same
  404 as an unreachable document, and the list leaves it out. While a document has no audience,
  the token reads it in full, including edits the owner made; annotating for the agent is the
  intended workflow. Removing the last share or link makes it readable again.
- **Per-user budget for agent writes**, across all of the user's tokens: 200 writes an hour and
  50 MB of written content a day. Over budget returns 429 with a constant `Retry-After`: 3600 for
  the hourly writes, 86400 for the bytes, never the exact moment other tokens' usage ages out.
  Quota errors never reveal the account's total usage to a token holder.
- **Per-token byte share**: each token can write at most 20 MB of content a day inside the user's
  50 MB. Over that returns 429 with that token's exact `Retry-After`.
- Revoking a token removes its entries from the user's hourly write and daily byte windows, so the
  user's other tokens get that share back. A password reset or change, which revokes every token,
  empties the user's windows, so the first token minted after securing the account has the whole
  budget. Only a signed-in session can do either.
- `GET /api/agent/docs/:id` returns content, under the same rule.
- Rate limit: 60 writes per hour per token, answered with 429 and that token's exact
  `Retry-After`.
- `last_used_at` is updated at most once a minute.

### Hosted MCP: `POST /mcp`

- Streamable HTTP, JSON-RPC 2.0, protocol version `2025-06-18`. It answers with
  `application/json`; no SSE stream is needed. `GET /mcp` and `DELETE /mcp` return 405.
- Auth: `Authorization: Bearer mk_agent_…`. Without it, the answer is 401 with
  `WWW-Authenticate: Bearer realm="markie"`. On `/mcp` and `/api/agent/*`, the token is checked
  before any request body is read, including chunked bodies with no `Content-Length`.
- Protocol version `2025-06-18` only. Batches and `id: null` are rejected.
- It implements `initialize`, `notifications/initialized`, `tools/list`, `tools/call` and `ping`.
- Tools:
  - `markie_create_document {name, content}`
  - `markie_update_document {id, content}`
  - `markie_list_my_documents {limit?}`
  - `markie_read_my_document {id}`
  - `markie_guide {}`
- Results that name a document carry `privateLink` and `markdownLink`, and the text: "Paste
  markdownLink into your reply. It opens in Markie on the user's phone, or in a browser after they
  sign in."
- `markie_guide` returns the same guide text as the local MCP's `markie_guide`. The server keeps a
  generated copy of `mcp/markdown-guide.mjs`, with a test that fails when the two differ, and a
  script that regenerates it.
- No new dependencies. Write it in the style of the dependency-free `mcp/markie-mcp.mjs`.

### Web view of a Darkmown document

`/d/:id` for a `darkmown` document renders a safe static view. That's the compiled body with no
runtime, sanitized like every other render, or the source in a code block if static compile isn't
safe on the server. It also shows a line saying the document is interactive in the Markie app. It
must never execute document script on the web.

## Desktop and local MCP

- `electron/agent-cloud.js` `SYNCABLE` adds `.wd`. A sync started through the agent bridge sends
  `origin: {kind:"agent", agent:<MCP clientInfo.name, or "an agent">}` on creation.
- `markie_cloud_sync` and `markie_cloud_status` results add `markdownLink`.
- Desktop gets a **Remote agents** panel, reached from the existing Agents or Cloud settings. It can:
  - create a named token and show it once with a copy button;
  - list tokens and revoke one;
  - show the hosted MCP URL;
  - show copy-ready setup for Claude Code
    (`claude mcp add --transport http markie-cloud https://api.markiedocs.com/mcp --header "Authorization: Bearer <token>"`)
    and a generic JSON config.

## Mobile app (`apps/mobile`)

- Capacitor iOS and Android. A Vite build reuses `src/lib` and renderer components through the `@`
  alias. The app has its own `package.json` and lockfile, and its own tsconfig and test command.
- Screens:
  1. **Sign in:** email OTP, using the existing better-auth endpoints. The server origin is
     editable under "Advanced", for self-hosters.
  2. **Recent:** the home screen. It shows `/api/docs/recent` with pull to refresh and search by
     name. Each row has the format icon, name, relative time and a "from Claude Code" badge for
     agent origin. A "Shared with you" filter.
  3. **Document:** markdown rendered like the desktop reading view; `text` as text. Darkmown is
     compiled and run in the same sandbox the desktop uses, behind the same "Trust this document
     to enable its local controls" choice. It also has share-sheet export of the link, and opens
     links inside the document sensibly.
  4. **Settings:** account, server, sign out, theme (system, light or dark), and version.
- The session token is stored in the iOS Keychain or Android Keystore. Never in `localStorage` or
  `Preferences`.
- Deep links (universal, app and `markie-mobile://`) route to Document. A link that arrives before
  sign-in waits for sign-in, then opens. A document the user can't read shows the server's message,
  never a crash.
- Design follows `DESIGN.md`: the same tokens, type and flat graphite light mode as desktop, with
  native safe areas, large-title navigation feel, haptics on refresh, and dark mode.
- Verification: build for the iOS Simulator and an Android emulator. Screenshot every screen in
  light and dark against a local server seeded with an agent-made `.md` and `.wd`. Deep-link
  through `xcrun simctl openurl booted markie-mobile://d/<id>` and `adb shell am start`.

## Agent guidance

Rewrite `mcp/markdown-guide.mjs`, `mcp/skills/markie-conventions/SKILL.md` and the cloud-tool
descriptions so agents produce rich documents. That covers:

- headings and structure;
- tables, task lists and callouts, where supported;
- images and media cards, embeds and links between documents;
- **Darkmown** for anything that benefits from state: checklists that count, calculators,
  toggles and step-throughs.

The guidance should help an agent choose the format for the content, and show a worked `.wd`
example of each supported directive. It should also cover sending the user a link:
`markie_cloud_sync` locally, or the hosted tools remotely, then pasting `markdownLink`.

Every capability claimed must be checked against the actual renderer, compiler and
`docs/document-testing/`. Nothing aspirational.

## Out of bounds for every workstream

Agents in these workstreams must not:

- deploy, publish, notarize, or submit to any store;
- touch production data, or the auth provider config;
- change `markiedocs.com`'s website;
- make anything public;
- commit secrets;
- weaken or skip tests.

Each PR targets `feat/mobile-agent-links`, never `main`.
