# Markie Mobile — Native iOS + Android Plan

_Status: proposal. Nothing here is ratified._
_Written: 2026-08-23. Grounded in `VISION.md`, `CONSTITUTION.md`, `SPEC.md`, `server/src/*`, `electron/sync.js`, `src/lib/*`, `src/components/rich-view.tsx`._

> **Stack checkpoint.** `CONSTITUTION.md` fixes the stack (TypeScript/Electron/Next/Hono) and lists
> "Public API shape, including MCP tools, server routes, deep-link contracts" and "Schema / data-model
> changes" as human checkpoints. Everything in §3 and §8 is a server-route or deep-link change, and
> adding Swift and Kotlin app targets is a stack change. This document is the escalation, not the
> approval. The existing roadmap
> (`docs/superpowers/plans/2026-06-28-style-platform-react-native-roadmap.md`) already gates native
> mobile scaffolding behind exactly this checkpoint — and note it assumed *React Native*; this plan
> proposes fully native instead, which is itself a decision to ratify (§10.1).

---

## Table of contents

1. [Product scope for v1 mobile](#1-product-scope-for-v1-mobile)
2. [Files & sync model on mobile](#2-files--sync-model-on-mobile)
3. [Auth](#3-auth)
4. [Realtime collab + comments on mobile](#4-realtime-collab--comments-on-mobile)
5. [Editor: rendering and editing](#5-editor-rendering-and-editing)
6. [Architecture per platform](#6-architecture-per-platform)
7. [Repo strategy, CI, distribution](#7-repo-strategy-ci-distribution)
8. [Server/API changes required for mobile](#8-serverapi-changes-required-for-mobile)
9. [Milestones](#9-milestones)
10. [Open decisions for the owner](#10-open-decisions-for-the-owner)

Appendix: [A. Server surface as it exists today](#appendix-a-server-surface-as-it-exists-today)

---

## 1. Product scope for v1 mobile

### The wedge

`VISION.md` says Markie is "the Google Docs of Markdown while keeping the user's files on their
machine and making cloud features optional," and names its non-goal: "Do not turn Markie into a
proprietary cloud-first document silo; local mode must remain useful without an account."

That sentence decides the mobile product. **Desktop Markie is where markdown is written. Mobile
Markie is where shared markdown is received.** Today the receiving end of every share is a web page:
`shares.ts` emails a link to `${SITE}/d/:id?k=<token>` (`docLink()` in `server/src/shares.ts`) or a
public `${SITE}/s/:token` (`server/src/public.ts`), and `server/src/render.ts` renders it as a
read-only HTML page. The person who gets "📄 Kirby tossed you a doc" in Slack or email opens it on a
phone, reads it in a browser tab, and cannot reply, comment, or fix a typo. That is the wedge: the
recipient half of the Google-Docs loop has no first-class mobile surface, and the recipient is the
person most likely to be on a phone.

So v1 mobile is **the reading, annotating, and quick-fixing end of a share** — not a second authoring
app. It is also the cheapest possible acquisition surface for the desktop app, because every invite
email already carries a "get the app" CTA (`primaryDownloadCta()`, `server/src/downloads.ts`).

### 1.1 — In scope for v1

1. **Open a share link natively.** A tap on `markiedocs.com/d/:id?k=…` or `markiedocs.com/s/:token`
   from Mail, Slack, or Messages opens the app (universal links / app links, §3), not Safari/Chrome.
2. **Sign in.** Email + password, email OTP code, and Google — all three already exist on the server
   (`server/src/auth.ts`). See §3.
3. **Library.** The signed-in user's docs and docs shared with them: `GET /api/docs` returns both in
   one list (owned rows plus `sharedDocsFor()` rows tagged `shared: true` with `role` and `shared_by`
   — `server/src/docs.ts`). Plus a "Shared by me" tab from `GET /api/docs/shared-by-me`.
4. **Read.** Native GFM rendering: tables, task lists, fenced code with highlighting, KaTeX math,
   images — parity with the plugin chain in `src/lib/markdown-html.ts`
   (remark-parse → gfm → math → rehype-highlight → katex).
5. **Comment.** Read threads, reply, resolve/reopen, and create a new thread on a text selection.
   Backed by `server/src/comments.ts`. Anchoring on mobile has a real constraint — see §4.
6. **Quick edit.** Markdown source editing with a formatting accessory bar, for a typo fix or a
   paragraph, on docs where the user's role is `owner` or `editor`
   (`accessLevel`/`canEditLevel`, `server/src/shares.ts`). Saved as a snapshot `PUT /api/docs/:id`
   with `baseVersion`, exactly as `electron/sync.js` does.
7. **Local files.** Open a `.md`/`.markdown`/`.mdx`/`.txt` from Files.app or the Android document
   picker, edit it, save it back in place, without an account. This is what keeps `VISION.md`'s
   "local mode must remain useful without an account" true on mobile. (§2)
8. **Share out.** Add a collaborator by email (`POST /api/docs/:id/shares`), create/copy/revoke the
   public link (`/api/docs/:id/public-link`), and hand off the doc via the system share sheet.
9. **Offline read.** Every doc the user has opened stays readable on a plane. Edits queue.
10. **Light and dark.** `CONSTITUTION.md` makes both-mode legibility a standing requirement; on
    mobile that means semantic system colors on iOS and Material 3 dynamic color on Android, and
    respecting a doc's pinned theme where it is cheap (`GET /api/docs/:id/theme`, `server/src/themes.ts`).

### 1.2 — Explicitly out of v1

11. **No MCP server.** `mcp/markie-mcp.mjs` exists to give a *local* agent a filesystem. iOS and
    Android have no local agent and no whole-filesystem to give it. Out.
12. **No terminal.** `electron/terminal.js` / `src/components/terminal-panel.tsx` depend on
    `node-pty`. There is no phone equivalent and no phone use case. Out.
13. **No device-wide markdown index.** `electron/mdindex.js` walks `$HOME`. Both mobile OSes
    sandbox apps out of exactly that. "Browse" as a feature does not port; the Library replaces it.
14. **No rich WYSIWYG parity.** The desktop rich view is a full TipTap stack (`src/components/rich-view.tsx`:
    StarterKit, TableKit, TaskList, Image, TextAlign, TextStyle/Color/FontFamily/FontSize, Highlight,
    tiptap-markdown). Reproducing that on a phone keyboard is a year of work for a surface nobody
    asked for. Mobile edits markdown source. (§5)
15. **No live collaborative editing in v1.** It lands in M4 (§9) and carries the plan's largest
    technical risk (§4).
16. **No agent/skill file browsing** (`src/components/skills-view.tsx`, `src/lib/agent-files.ts`) —
    those surfaces read `~/.claude/skills`, `~/.codex`, Cursor rules. No phone equivalent.
17. **No desktop-app installer/download surface**, no updater, no theme *editor* (theme *reading* only).
18. **No new paid tier, no billing.** `VISION.md` non-goal, restated because "mobile app" is where
    that pressure usually shows up.

---

## 2. Files & sync model on mobile

Markie has two document worlds and they must stay distinct on mobile exactly as they are on desktop:
a **local file** (a path on disk, tracked in `electron/registry.js`) and a **cloud doc** (a row in
`docs`, addressed by uuid). A local file becomes a cloud doc when the user turns sync on
(`syncOn()` in `electron/sync.js` mints `crypto.randomUUID()` and PUTs it). Mobile keeps that
two-world model — it does not silently upload the user's files.

### iOS

19. **Document picker for one-off opens.** `.fileImporter` / `UIDocumentPickerViewController` in
    `.open` mode. Register the markdown UTIs in `Info.plist` — import `net.daringfireball.markdown`
    (conforms to `public.plain-text`) and declare handling for `.md`, `.markdown`, `.mdx`, `.txt`,
    `.csv`, mirroring the desktop's `OPENABLE` regex in `electron/file-grants.js`.
20. **Security-scoped bookmarks for persistence.** On pick, call
    `url.startAccessingSecurityScopedResource()`, immediately create
    `url.bookmarkData(options: .minimalBookmark)` and store the blob in the app's DB. On relaunch,
    resolve with `URL(resolvingBookmarkData:bookmarkDataIsStale:)`, handle `isStale` by re-minting.
    Always pair `start…` with a `defer { url.stopAccessingSecurityScopedResource() }`. This is the
    direct analogue of `electron/file-grants.js`'s grant set.
21. **Folder grants, Working Copy style.** `.fileImporter(allowedContentTypes: [.folder])` returns a
    directory URL; the bookmark for that directory covers its descendants, so the user can grant
    "my Obsidian vault in iCloud Drive" once and browse it in-app forever. Enumerate with
    `FileManager.default.enumerator(at:includingPropertiesForKeys:options:)`, filtered to markdown
    extensions. This is Markie's honest local-first story on iOS, and it is one screen of work.
22. **`FileDocument` vs. raw reads.** Use `ReferenceFileDocument` (not `FileDocument`) for the
    editor: markdown docs can be large, `ReferenceFileDocument` is a class so it plays with
    `@Observable`, and it gives autosave + document-conflict UI for free through `DocumentGroup`.
    For read-only previews of a doc the user just tapped, skip the document machinery and read the
    bytes. **Do not** build the whole app inside `DocumentGroup` — the Library and shared docs are
    not documents, and `DocumentGroup` fights `TabView`. Use `DocumentGroup` only if a document
    browser tab is added later.
23. **iCloud Drive.** Ship an iCloud Documents container so Markie has a home folder in Files.app
    (`NSUbiquitousContainers` in `Info.plist`). Files placed there are visible to Files.app, other
    apps, and the Mac. Treat it as just another folder — do not build iCloud-based sync between
    devices; Markie already has a sync server, and two competing sync systems is how documents get
    eaten.
24. **Coordinated access.** All reads/writes to picked URLs go through `NSFileCoordinator`, because
    the file may be an iCloud placeholder or open in another app. Non-negotiable; skipping it is the
    classic cause of "my file reverted."

### Android

25. **Storage Access Framework, no legacy paths.** `ACTION_OPEN_DOCUMENT` for single files
    (`ActivityResultContracts.OpenDocument`) and `ACTION_OPEN_DOCUMENT_TREE`
    (`OpenDocumentTree`) for folder grants. No `READ_EXTERNAL_STORAGE`, no
    `MANAGE_EXTERNAL_STORAGE` — the latter is a Play policy fight Markie does not need to have.
26. **Persist the grant.**
    `contentResolver.takePersistableUriPermission(uri, FLAG_GRANT_READ_URI_PERMISSION or FLAG_GRANT_WRITE_URI_PERMISSION)`
    at pick time; store the `content://` URI string in Room. On startup, reconcile against
    `contentResolver.persistedUriPermissions` and drop grants the system revoked (app data cleared,
    provider uninstalled, SD card removed). Grants are capped (~128 per app) — evict least-recently-used.
27. **Enumerate trees cheaply.** `DocumentFile.fromTreeUri(...).listFiles()` is notoriously slow;
    query `DocumentsContract.buildChildDocumentsUriUsingTree()` directly with a projection of
    `DOCUMENT_ID, DISPLAY_NAME, MIME_TYPE, LAST_MODIFIED, SIZE` and walk it yourself on `Dispatchers.IO`.
28. **Write safely.** `contentResolver.openOutputStream(uri, "rwt")` (truncate) — the default `"w"`
    does *not* truncate and leaves trailing garbage when the new content is shorter than the old.
    This bug ships in a lot of Android markdown editors; do not ship it.
29. **App-private mirror.** Anything the app fetched from the server lives in
    `context.filesDir` (or the iOS app container), never in a user-visible folder, so cloud docs and
    local files never blur.

### Server-synced docs

30. **The sync unit is a whole snapshot.** `PUT /api/docs/:id` with `{ name, content, hash, baseVersion }`
    (`server/src/docs.ts`); the server bumps `version`, writes `doc_history`, and returns
    `{ id, version, updated_at }`. `409 { error: "conflict", serverVersion }` when `baseVersion`
    does not match. Mobile does exactly this; there is no mobile-specific write path.
31. **Mirror the desktop's `sync_state` machine.** `electron/sync.js` + `electron/registry.js` use:
    `local-only`, `synced`, `unpushed`, `conflict`, `paused`, plus derived `behind` (server version
    higher) and `cloud-only` (server row with no local file), computed in `libraryState()`. Port the
    same names and the same transitions. Anything else guarantees the two clients disagree about
    what a badge means.
32. **`unpushed` is load-bearing.** In `push()`, a failed push sets `sync_state: "unpushed"` rather
    than leaving `synced`, precisely so "Take cloud" cannot later overwrite work the server never
    received. Mobile must do the same or it will lose data that desktop protects.
33. **Poll, don't stream, for the Library.** `checkUpdates()` does one `GET /api/docs` and diffs
    versions client-side — no per-doc fetch. Mobile does the same on foreground and on pull-to-refresh.
34. **Offline queue.** Edits to a cloud doc while offline write to the local mirror and mark
    `unpushed`. On reconnect, replay in order; a 409 moves the doc to `conflict` and surfaces the
    dialog below. `electron/sync.js` returns status `0` (`NO_RESPONSE`) for "never reached the
    server" and reports it as "(offline)" — keep that distinction in the mobile error copy.

### Conflicts — mirror `src/components/conflict-dialog.tsx` exactly

The desktop behaviour, which mobile must reproduce:

35. **It leads with the option that cannot lose work.** The dialog fetches the server copy
    (`docRemoteContent` → `remoteContent()`), runs `lineDiff()`/`describeDiff()` from
    `src/lib/line-diff.ts`, and *states the cost in lines* before the user chooses. Mobile shows the
    same summary sentence.
36. **Keep both (default, focused button).** `resolveKeepBoth()` writes the local buffer to
    `notes (my version).md` (`keepBothPath()` suffixes, never overwrites, up to `(my version 1000)`),
    tracks the copy as `local-only` with `cloud_doc_id: null`, *then* overwrites the original with
    the server copy. The order matters: a failure at any earlier step leaves the user with what they
    had. On mobile: same order, and the rescued copy goes to the same folder as the original
    (or the app container for a cloud-only doc).
37. **Take cloud is refused when `sync_state === "unpushed"`,** with the exact desktop reasoning:
    "This file has changes that never reached the cloud. Taking the cloud copy would delete them.
    Save again to retry the backup first."
38. **Keep local re-reads the server version and pushes on top of it** — it does not blind-force a
    stale `baseVersion`.
39. **The local side of the diff is the editor buffer, not the file on disk.** `resolveKeepBoth()`
    takes `localContent` from the renderer for exactly this reason. Mobile passes its in-memory
    buffer too.
40. **No auto-merge, ever.** Snapshot sync has no merge; inventing one on mobile would diverge from
    desktop semantics on the one operation where divergence destroys documents.

---

## 3. Auth

### What the server actually does today

`server/src/auth.ts` configures better-auth with:

- `emailAndPassword: { enabled: true }` → `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`
- `emailOTP` plugin → `POST /api/auth/email-otp/send-verification-otp` (type `sign-in`) then
  `POST /api/auth/sign-in/email-otp` — this is Markie's passwordless path
- `bearer()` plugin → auth responses carry a **`set-auth-token`** response header; every subsequent
  request sends `Authorization: Bearer <token>` (see `src/lib/auth-client.ts` and `electron/sync.js`)
- `socialProviders.google`, **only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set**
- `trustedOrigins: ["app://markie", "http://localhost:3000", "markie://"]`
- rate limits: 100/10s globally; `/sign-in/email` and `/sign-up/email` 10/60s;
  `/email-otp/send-verification-otp` 5/60s
- `databaseHooks.user.create.after` → `claimPendingInvites(email, id)`: **docs shared with an email
  before that person had an account land in their Library the moment they sign up.** This makes
  "tap invite link → sign up on phone → doc is already there" work with zero extra plumbing.

The desktop Google flow, which mobile must generalise rather than copy:
`src/lib/auth-client.ts` `googleSignInURL()` mints a nonce (`createAuthState()` in
`src/lib/auth-state.ts`) and opens `${SERVER}/auth/google-start?state=…` **in the system browser**.
`server/src/index.ts` starts the social flow server-side, forwards better-auth's `Set-Cookie` (the
OAuth `state` cookie) to the browser, and redirects to Google. Google returns to
`/auth/desktop-bridge`, which reads the session and redirects the browser to
`markie://auth?token=…&state=…` (`desktopAuthDeepLink()` in `server/src/desktop-auth.ts`). The nonce
must match `/^[0-9a-f]{8,128}$/` (`STATE_PATTERN`) and the app rejects a deep link whose state it did
not mint — because any web page can fire a `markie://` URL.

### Recommended mobile auth

41. **Primary: email OTP.** Two screens, no password manager, no Google dependency, and it already
    works: `POST /api/auth/email-otp/send-verification-otp` → `POST /api/auth/sign-in/email-otp`.
    Take the `set-auth-token` header, store it, done. This should be the big button.
42. **Secondary: Google,** via `ASWebAuthenticationSession` (iOS) and Chrome Custom Tabs +
    `androidx.browser` (Android) pointed at `${SERVER}/auth/google-start?state=<nonce>&client=ios`.
    Both APIs share the system cookie jar, which is what makes the server-side `state` cookie in
    `/auth/google-start` survive the round trip — a plain in-app `WKWebView` would break it. The
    server change needed to make `client=` work is §8.3.
43. **Tertiary: email + password**, because it exists and some users have accounts that way.
44. **Sign in with Apple is not optional if Google ships.** App Store Review Guideline 4.8: an app
    offering third-party social login must also offer an equivalent private option. Email OTP
    arguably satisfies it, but reviewers are inconsistent. Cheapest safe path: **ship v1 with email
    OTP + email/password only, no Google**, and add Google + Sign in with Apple together later.
    Adding Apple means a new better-auth social provider in `server/src/auth.ts` (§8.4).
45. **Token storage.** iOS: Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (needs to
    work for a background refresh, must not sync to another device). Android: `EncryptedSharedPreferences`
    / `androidx.security.crypto` with the master key in the Keystore. Never `UserDefaults`, never
    plain `SharedPreferences`, never in the WebView's `localStorage`.
46. **Token refresh — a gap to close.** better-auth issues a session token with a fixed expiry and
    refreshes it on use (`updateAge`), but neither `server/src/auth.ts` nor `src/lib/auth-client.ts`
    pins `session.expiresIn`/`updateAge` explicitly, so the app is running on defaults (7-day
    expiry, 1-day refresh window). A phone that sits unopened for two weeks logs the user out. Two
    things: (a) set `session: { expiresIn, updateAge }` explicitly in `server/src/auth.ts` so the
    contract is written down; (b) mobile treats **any 401** as "session gone" → clear Keychain,
    return to sign-in, and *preserve the pending destination* so a tapped share link resumes after
    re-auth. Also re-read `set-auth-token` on every response and re-store it when it changes —
    `src/lib/auth-client.ts` already does this and mobile must too, or refreshed tokens are dropped.
47. **Account-free reading must survive.** A tapped `/s/:token` public link, or a `/d/:id?k=<token>`
    invite link for a pending (not-yet-registered) invite, opens and renders **without any account**.
    `resolveViewer()` in `server/src/doc-view.ts` honours `?k=` via `memberForToken()` and
    `pendingForToken()`. On mobile this is the single most important flow: link from Slack →
    readable doc → *then* an inline "sign in to comment" prompt. Demanding sign-up at the door
    throws away the wedge.

### Universal links / app links

The real routes (all on `https://markiedocs.com` — `siteUrl` in `server/download-manifest.json`,
read by `markieSiteUrl()` in `server/src/downloads.ts`):

| Route | Source | Meaning |
|---|---|---|
| `/d/:id?k=<token>` | `server/src/doc-view.ts`, minted by `docLink()` in `shares.ts` | per-recipient invite link |
| `/d/:id/raw?k=<token>` | `server/src/doc-view.ts` | `.md` download |
| `/s/:token` | `server/src/public.ts`, minted by `createOrGetPublicLink()` | account-free public link |
| `/s/:token/raw` | `server/src/public.ts` | public `.md` download |
| `/download`, `/download/:platform`, `/download/latest.json` | `server/src/public.ts` | must **not** be claimed by the app |

48. **`apple-app-site-association`** served from `https://markiedocs.com/.well-known/apple-app-site-association`,
    `Content-Type: application/json`, no redirect, no auth:
    ```json
    { "applinks": { "details": [ { "appIDs": ["TEAMID.com.zvndev.markie"],
        "components": [ { "/": "/d/*" }, { "/": "/s/*" },
                        { "/": "/download*", "exclude": true },
                        { "/": "*", "exclude": true } ] } ] } }
    ```
    Entitlement `applinks:markiedocs.com`. Exclude `/download*` explicitly — otherwise tapping the
    download CTA in an invite email opens the phone app instead of the download page.
49. **`assetlinks.json`** at `https://markiedocs.com/.well-known/assetlinks.json` with
    `delegate_permission/common.handle_all_urls`, the package name, and the **Play App Signing**
    SHA-256 fingerprint (not the local upload key — the single most common app-links failure).
    Intent filter: `android:autoVerify="true"`, `https`, host `markiedocs.com`, `pathPrefix`
    `/d/` and `/s/`.
50. **Where these files get served.** `/d/` and `/s/` are Hono routes, but `server/src/doc-view.ts`
    notes the page "is served through a rewrite" — the site is a Next static export
    (`next.config.ts: output: "export"`) fronting the API. So the `.well-known` files must be served
    by whatever terminates `markiedocs.com` (the static site / its rewrite config, or
    `deploy/Caddyfile`). Safest belt-and-braces: also add two literal routes to
    `server/src/public.ts` so the JSON exists whichever layer answers.
51. **Custom schemes stay, as fallback and for OAuth.** Register `markie://` on both platforms
    (`CFBundleURLTypes` / an intent filter) so the existing
    `markie://auth`, `markie://open?token=…&src=…`, `markie://doc?id=…&src=…` contracts from
    `electron/deep-links.js` work identically. Port `classifyDeepLink`/`cloudDocId`/`sourceHint`
    verbatim — including the security property the file spells out: `open` carries authority in the
    URL, `doc` carries none. And port the `src=` allowlist check
    (`isAllowedServerOrigin`, `electron/share-origin.js`) so a hostile link cannot point the app at
    an attacker's server with the user's bearer token.
52. **Cold-start routing.** A link tapped before the app has ever launched must survive the
    sign-in detour. Hold the pending destination in a small router object (iOS: an `@Observable`
    `DeepLinkRouter` read by the root `NavigationStack` path; Android: `onNewIntent` → a
    `SharedFlow` consumed by the nav host), and replay it after auth resolves.

---

## 4. Realtime collab + comments on mobile

### The exact protocol (from `server/src/collab.ts`)

53. `attachCollab(server)` (called at the bottom of `server/src/index.ts`) attaches a
    `WebSocketServer({ noServer: true })` and handles HTTP upgrades matching
    `^/collab/([^/]+)$` — so the URL is **`wss://<api-host>/collab/<docId>?token=<bearer>`**.
    The client base is built in `src/lib/auth-client.ts` `collabWsBase()` (`http`→`ws`, `+"/collab"`);
    `y-websocket` appends `/<docId>`.
54. **Upgrade auth:** the `token` query param is turned into `Authorization: Bearer …` and passed to
    `auth.api.getSession()`; then `accessLevel(docId, user.id)` must pass `canReadLevel`. Otherwise
    the server writes a raw `HTTP/1.1 401` and destroys the socket.
55. **Wire format:** the y-websocket protocol. Each frame is `lib0` varuint-prefixed:
    `0` = `MESSAGE_SYNC` (payload handled by `y-protocols/sync`),
    `1` = `MESSAGE_AWARENESS` (payload is a `y-protocols/awareness` update).
    `binaryType = "arraybuffer"`.
56. **Handshake:** on connect the server sends `MESSAGE_SYNC` + `writeSyncStep1`, then a
    `MESSAGE_AWARENESS` frame with all current states.
57. **Role enforcement is per-message, not per-connection.** Every inbound frame re-reads
    `accessLevel` (`readLevel()`); `ACCESS_CACHE_MS = 1000` caches it only on the broadcast fan-out.
    A **viewer** gets `readAccessControlledSyncMessage()`, which answers `messageYjsSyncStep1` and
    **silently drops everything else** — viewers see edits and presence, and their updates are
    ignored rather than rejected. A mobile client that shows a viewer an editable surface will
    silently eat their typing.
58. **Presence identity is stamped server-side.** `stampPresenceIdentity()` rewrites the `user`
    field of every awareness update to `presenceIdentity(session.user)` — name + a colour picked by
    the same hash as `colorForName()` in `src/lib/collab.ts` from the same 8-colour palette. Mobile
    sends its cursor freely; it must not expect its own `user` field to be honoured, and it should
    reuse the same palette/hash so avatars match across clients.
59. **Close code 4403** (`CLOSE_ACCESS_REVOKED`) means *permanently* out — access revoked or doc
    deleted (`disconnectUser()`, `closeRoom()`). The mobile client must not reconnect on 4403;
    it should drop to read-only and refresh access. Every other close is a normal reconnect-with-backoff.
60. **Persistence:** Yjs updates append to a `doc_updates` table, compacted to a single merged update
    past `COMPACT_THRESHOLD = 500`. Nothing on the client needs to know this, but it means room state
    survives everyone disconnecting.
61. **A room's Y document is ProseMirror-shaped.** `src/components/rich-view.tsx` uses
    `@tiptap/extension-collaboration`, so the shared type is the default `Y.XmlFragment` holding a
    ProseMirror document in TipTap's schema — *not* a `Y.Text` of markdown. Anything joining the room
    must speak that schema. This is the crux of the whole section.

### Comment anchors (from `server/src/comments.ts` and `src/lib/comments.ts`)

62. Routes: `GET /api/docs/:id/threads` (threads with nested comments), `POST /api/docs/:id/threads`
    (`{ anchor, body }`), `POST /api/docs/:id/threads/:threadId/comments` (`{ body }`),
    `POST /api/docs/:id/threads/:threadId/status` (`{ status: "open"|"resolved" }`),
    `DELETE /api/docs/:id/threads/:threadId/comments/:commentId` (own comment, or any if doc owner;
    deleting the last comment deletes the thread).
63. **The server treats `anchor` as opaque JSON** — it stores `JSON.stringify(anchor)` and
    `JSON.parse`s it back. The *client* decides its shape. Today that shape is
    `{ from, to }` where each side is a **Yjs relative position** produced by
    `absolutePositionToRelativePosition()` from `@tiptap/y-tiptap` (`src/lib/comments.ts`) — i.e. a
    position into the ProseMirror/Yjs document, not a character offset into markdown.
64. **Therefore a native markdown-source editor cannot mint a desktop-compatible anchor.** Positions
    in "the markdown text" and positions in "the ProseMirror doc" are different coordinate systems,
    and only a client holding the live Y doc can convert. This is the single most important finding
    in this document, and it shapes M2.
65. **Recommended fix: a second, client-resolved anchor shape.** Because the server is opaque, add a
    tagged variant — a W3C-style text-quote selector:
    `{ kind: "quote", exact, prefix, suffix, approxIndex }` — with the existing shape implicitly
    `{ kind: "yrel", from, to }`. Mobile mints `quote` anchors; desktop learns to resolve them
    (search the rendered text for `prefix+exact+suffix`, fall back to `exact`, fall back to
    "unanchored" pill at the top of the thread list). **Zero server change**; the change is in
    `src/lib/comments.ts` + `src/components/comments.tsx` on desktop, and the same logic in mobile.
    Optionally the desktop upgrades a `quote` anchor to a `yrel` one the first time it resolves it.
66. **Viewers currently cannot comment.** `canWrite()` in `server/src/comments.ts` is
    `canEditLevel(accessLevel(...))` — so `viewer` role gets 403 on thread create *and* on reply.
    For the mobile wedge ("read someone's doc on your phone and leave a note") that is the wrong
    default. Recommend a `canCommentLevel(level) = level !== null` used by the two POST routes,
    keeping `resolve` and cross-user delete as editor/owner powers. **This is a public-API-shape
    change → human checkpoint** (§8.6).
67. **Notifications are email-only today.** `notify()` in `server/src/comments.ts` emails the doc
    owner plus every prior participant in the thread, minus the author. Push is additive to this,
    not a replacement (§6.32).

### Client library choice — evaluated

- **`yrs` / y-crdt via UniFFI (`y-uniffi`) — Swift + Kotlin bindings.** Genuinely correct CRDT, one
  Rust core for both platforms, no JS runtime. But: the room holds a **ProseMirror-schema
  `Y.XmlFragment`** (§61). Using yrs means reimplementing, twice, (a) the TipTap/ProseMirror schema
  as XML nodes/attrs, (b) ProseMirror↔markdown conversion equivalent to `tiptap-markdown`,
  (c) relative-position mapping for comment anchors. Any drift silently corrupts other people's
  documents. y-uniffi is also thinly maintained and its Swift package story is rough (xcframework
  builds, no SwiftPM binary target you can just add). High risk, high cost, deferred value.
- **Server-side OT.** Would mean rewriting `server/src/collab.ts` and breaking the desktop, which is
  the only shipped client. Non-starter.
- **JS bridge — a WebView running the existing editor bundle.** Reuses TipTap + Yjs + `y-websocket`
  + `@tiptap/y-tiptap` unchanged, so the schema, the anchors, and the wire protocol are correct
  *by construction*. Costs a WebView on screen for collab docs, and a JS↔native message channel
  (`WKScriptMessageHandler` / `@JavascriptInterface`).

68. **Recommendation: the WebView bridge, scoped to live-collab documents only.** Native rendering
    and native source editing (§5) cover v1 and every non-collab doc; when a doc is open in a live
    room (M4), the editor surface swaps to a `WKWebView`/`WebView` hosting a small purpose-built
    bundle (TipTap + Collaboration + CollaborationCaret + comment marks, no desktop chrome) that
    connects to `wss://…/collab/<docId>?token=…` itself and posts markdown/selection/thread events
    back to native. Rationale: the CRDT document is ProseMirror-shaped and the comment anchors are
    ProseMirror relative positions, so anything other than a real ProseMirror client is a
    reimplementation of two schemas in two languages against a live protocol where mistakes damage
    other people's documents. Revisit `yrs` only if mobile collab becomes a primary use case — the
    seam (a `CollabSession` protocol/interface with one WebView implementation) makes that swappable.
69. **Bridge hygiene:** the bearer token must reach the WebView without landing in `localStorage` or
    a URL the WebView might log — inject it via `WKUserScript` at document start / `evaluateJavascript`
    into a closure, from Keychain, per session. Lock the WebView's CSP and navigation delegate to the
    bundled origin (`electron/csp.js` is the precedent). Note `server/src/index.ts` CORS currently
    allows `app://markie` and `http://localhost:3000` only — the WebView origin needs adding if the
    bundle makes REST calls rather than proxying them through native (§8.7). Prefer proxying through
    native: fewer origins, one token holder.

---

## 5. Editor: rendering and editing

### What the desktop has, for reference

- **Rich view:** TipTap v3 / ProseMirror (`src/components/rich-view.tsx`) — StarterKit, TableKit,
  TaskList/TaskItem, Image, Placeholder, Highlight, TextAlign, TextStyle+Color+FontFamily+FontSize,
  `tiptap-markdown` for round-tripping, `Collaboration` + `CollaborationCaret` for live editing,
  plus a find-highlight ProseMirror plugin (`src/lib/rich-find.ts`).
- **Source view:** CodeMirror 6 (`src/components/editor.tsx`, keymap in `src/lib/editor-keymap.ts`).
- **Static render:** `src/lib/markdown-html.ts` — unified: remark-parse → remark-gfm → remark-math →
  remark-rehype → rehype-highlight → rehype-katex → rehype-stringify. `server/src/render.ts` mirrors
  the same chain for the web share pages.

### Recommendation

70. **v1: native rendering + native markdown-source editing on both platforms.** Not a WebView.
    Rationale: the mobile wedge is *reading* (§1), and reading is where a WebView is most obviously
    not-an-app — momentum scrolling, text selection callouts, Dynamic Type, VoiceOver/TalkBack,
    system find, dark mode, and the share sheet all come free natively and all have to be faked in a
    WebView. A phone-sized markdown edit is a typo fix or a paragraph, which a good text view with a
    formatting accessory bar handles better than a WYSIWYG surface fighting the software keyboard.
    The WebView is reserved for exactly the one case that genuinely requires it (§68).
71. **iOS rendering.** Parse with Apple's **`swift-markdown`** (swift-cmark, GFM: tables, task lists,
    strikethrough) and render block-by-block into SwiftUI: paragraphs/headings as `Text` built from
    `AttributedString`, code blocks as a monospaced view with a horizontal `ScrollView` and a copy
    button, tables as a `Grid` inside a horizontal `ScrollView`, task lists as real toggles,
    images via `AsyncImage`. Put the blocks in a `LazyVStack` so a 5,000-line doc scrolls.
    Alternative considered: `swift-markdown-ui` (fast to adopt, good theming) — reasonable for the
    M1 spike, but its Markdown dialect and theming layer become the thing you fight later; own the
    renderer.
72. **iOS syntax highlighting + math.** Code highlighting: `Splash` (Swift-only) or a small
    tree-sitter/Highlightr integration; accept a smaller language set than `rehype-highlight` and
    fall back to plain monospace. Math: no credible native KaTeX. Render `$…$`/`$$…$$` blocks in a
    tiny inline `WKWebView` with the KaTeX CSS/JS bundled locally, or ship them as unstyled code and
    fix it in M3. Do not block M1 on math.
73. **iOS editing.** `TextEditor` is too limited (no attributed text pre-iOS-18, no selection
    control). Wrap `UITextView` (TextKit 2 — the default since iOS 16) in `UIViewRepresentable`, with
    a `NSTextContentStorageDelegate`/custom layout pass applying *lightweight* markdown styling to
    the source: bold headings, monospace code spans, dimmed markers. Add a `inputAccessoryView`
    formatting bar (bold, italic, link, `#`, list, checkbox, code) and reuse the desktop's command
    vocabulary (`src/lib/toolbar-shortcuts.ts`, `src/lib/commands.ts`) so the two apps agree on what
    "toggle bold" means at the markdown level.
74. **Android rendering.** Parse with **commonmark-java** + its GFM extensions (tables, strikethrough,
    task lists, autolink) and render to Compose: build `AnnotatedString` for inline runs, emit real
    composables per block inside a `LazyColumn`. Do **not** route through `HtmlCompat.fromHtml` — it
    loses tables and code fences and is a dead end. Math: same call as iOS.
75. **Android editing.** `BasicTextField` (the Compose Foundation one, with `TextFieldState`) plus an
    `OutputTransformation`/`VisualTransformation` that styles markdown markers without changing the
    underlying text. Long documents: keep the whole doc in one field but debounce the styling pass
    off the main thread; if it stalls, fall back to an `AndroidView`-wrapped `EditText`.
76. **One markdown-command core per platform, shared with nothing.** The list-continuation,
    checkbox-toggle, and wrap-selection behaviours are ~300 lines each. Port from
    `src/lib/rich-keymap.ts` / `src/lib/editor-keymap.ts` semantics; do not try to share the code.
77. **Rendering must stay faithful to `src/lib/markdown-html.ts`.** Build a fixture corpus (a folder
    of `.md` files + expected block structure) checked into `apps/shared-fixtures/`, and run it in
    all three test suites (vitest, XCTest, JUnit). This is the only cheap defence against three
    renderers drifting.

### Exports

The desktop supports (from `electron/main.js`):

- **PDF** — `export-pdf` IPC renders standalone HTML in a hidden `BrowserWindow` and calls
  `printToPDF`; the menu offers **dark** and **light** variants (`menu-export-pdf`, `"dark"`/`"light"`),
  styles from `src/lib/pdf-styles.ts`.
- **HTML** — `export-html` IPC writes the rendered HTML (`renderMarkdownHTML()`).
- **Raw `.md`** — via the web routes `/d/:id/raw` and `/s/:token/raw` (`Content-Disposition: attachment`).

78. **Bring to mobile v1: the system share sheet with three items — `.md`, PDF, and rendered HTML.**
    Raw `.md` is trivial (`UIActivityViewController` / `Intent.ACTION_SEND` with a `FileProvider`
    URI). PDF is the one people actually want on a phone (AirDrop a doc to someone in a meeting):
    iOS `UIGraphicsPDFRenderer` over the rendered views, or `WKWebView.createPDF()` over the HTML —
    prefer the WebView route so PDF output matches desktop; Android `PrintedPdfDocument` /
    `PdfDocument`, or the print framework with a WebView. Reuse `src/lib/pdf-styles.ts` verbatim as a
    bundled CSS asset so mobile PDFs look like desktop PDFs, and keep the dark/light choice.
79. **Not on mobile:** DOCX, `.csv` viewing (`src/lib/csv.ts` is a desktop surface), and printing
    beyond the OS print sheet.

---

## 6. Architecture per platform

### iOS

80. **Project:** XcodeGen `project.yml` at `apps/ios/project.yml`, `.xcodeproj` gitignored, generated
    by `xcodegen generate` in a `Makefile`/`mise` task and in CI. Swift 6 language mode, strict
    concurrency, iOS 17 deployment target. Dependencies via SwiftPM only, pinned in `Package.resolved`
    (committed).
81. **Modules** (local SwiftPM packages under `apps/ios/Packages/`, so they compile and test without
    the app target):
    - `MarkieCore` — models (`Doc`, `ShareRole`, `SyncState`, `Thread`, `Comment`), pure logic:
      the sync-state machine, conflict decisions, the `lineDiff`/`describeDiff` port, anchor
      resolution. No UIKit, no networking. Highest test density.
    - `MarkieAPI` — `URLSession` + `Codable` client for the routes in Appendix A; token handling;
      `set-auth-token` capture; typed errors incl. `.conflict(serverVersion:)` for 409 and
      `.offline` for a transport failure (the `NO_RESPONSE` distinction from `electron/sync.js`).
    - `MarkieMarkdown` — parse + render + the source-editing commands.
    - `MarkieStore` — persistence + file access (bookmarks, coordination).
    - `MarkieUI` — design tokens, shared components.
    - App target — composition, navigation, deep links.
82. **State:** `@Observable` model objects (`LibraryModel`, `DocumentModel`, `AuthModel`,
    `CommentsModel`), injected with `.environment(...)` and read via `@Environment`. `@MainActor` on
    the models; `actor`s for the token store and the sync engine. No Combine, no third-party
    architecture framework, no `ObservableObject`.
83. **Navigation:** phone — `TabView` (Library · Shared · Files · Settings) with a `NavigationStack`
    per tab driven by a `[Route]` path array so deep links push deterministically. iPad —
    `NavigationSplitView` three-column (sidebar: sections · content: doc list · detail: document),
    with the comment thread list as an inspector (`.inspector` on iPadOS 17+). Same `Route` enum
    feeds both.
84. **Persistence: SwiftData** for metadata — docs, sync state, threads cache, folder bookmarks,
    pending outbound edits. iOS 17+, pairs with `@Observable`, no schema-migration ceremony for a
    cache. Document *content* is files in the app container (or the user's own file), never a
    `String` column. GRDB is the better tool only if you later want literal parity with
    `electron/registry.js`'s SQL; you do not — the mobile registry is a subset. **Recommendation:
    SwiftData.**
85. **Colors:** semantic system colors (`.primary`, `.secondary`, `Color(.systemBackground)`,
    `.tint`) as the base, with the Markie amber (`#f59e0b`, the accent throughout
    `server/src/render.ts` and the invite emails) as the tint. Any custom color goes in an asset
    catalog with light + dark + increased-contrast variants — no hex literals in views. Markie's
    both-modes rule from `CONSTITUTION.md` applies.
86. **Background:** `BGAppRefreshTaskRequest` for an opportunistic `GET /api/docs` version sweep;
    `BGProcessingTask` for draining a queue of unpushed edits (requires network, not battery). No
    background WebSocket — iOS kills it; a doc leaving the foreground closes its collab socket and
    reconnects on return. `URLSession` background upload only if a snapshot push must survive
    app termination (probably not worth it in v1).

### Android

87. **Project:** `apps/android/`, Gradle Kotlin DSL, version catalog (`gradle/libs.versions.toml`),
    `minSdk 26`, `targetSdk` current, Compose BOM, Material 3, Kotlin 2.x with K2.
88. **Modules:** `:core:model`, `:core:data` (Room + SAF + files), `:core:network` (OkHttp +
    kotlinx.serialization; Retrofit optional and probably unnecessary for ~15 endpoints),
    `:core:markdown`, `:core:designsystem`, `:feature:library`, `:feature:document`,
    `:feature:comments`, `:feature:auth`, `:app`. Mirrors the iOS split so a change lands in the same
    place on both sides.
89. **State:** `ViewModel` + `StateFlow<UiState>` (immutable data classes), `collectAsStateWithLifecycle()`,
    events as one-shot `Channel`/`SharedFlow`. Coroutines everywhere; `Dispatchers.IO` for SAF and
    file work. DI: Hilt (or manual constructor injection given the size — Hilt is fine and standard).
90. **Persistence: Room** for the same metadata as SwiftData, DataStore(Proto) for settings, files for
    content.
91. **Navigation:** Navigation Compose with type-safe routes; adaptive layout via
    `androidx.compose.material3.adaptive` (`NavigableListDetailPaneScaffold`) so tablets/foldables get
    list-detail without a second navigation graph.
92. **Background:** `WorkManager` — a periodic (≥15 min) constrained `SyncWorker` for the version
    sweep and an expedited one-shot for draining unpushed edits. FCM data messages wake it for
    "doc changed"/"new comment". No foreground service.

### Push notifications (both)

93. **What's worth notifying:** a new comment or reply on a doc you own or participate in, a mention,
    a doc newly shared with you, and (quietly) "the server copy of an open doc moved."
94. **Server work** (all new, see §8.9): a `device_tokens` table (`user_id`, `platform`, `token`,
    `created_at`, `last_seen_at`), `POST /api/me/devices` + `DELETE /api/me/devices/:token`, and a
    fan-out in `notify()` in `server/src/comments.ts` alongside the existing `sendEmail()`.
95. **Delivery:** APNs over HTTP/2 with a `.p8` auth key (a token-based key avoids certificate
    rotation), FCM HTTP v1 with a service account. Both need a new server dependency →
    `CONSTITUTION.md` "Never add a new external dependency without escalating first". Escalate as one
    item. Silent/data pushes (`content-available` / data-only) for the sync sweep, alert pushes for
    comments, with a per-user preference so Markie does not become noisy.
96. **Do not attach document content to a push payload.** Comment bodies and doc names go through a
    third party; send an ID and a neutral title (`"New comment on a document"`) unless the user opts
    in to richer previews. `CONSTITUTION.md`: never commit or leak user document contents.

---

## 7. Repo strategy, CI, distribution

97. **Recommendation: monorepo folders in this repo — `apps/ios/` and `apps/android/`.** Rationale:
    the mobile clients' entire contract is `server/src/*` in this tree, `CONSTITUTION.md` makes route
    and deep-link changes a human checkpoint, and the hourly agent loop reads `feature_list.json` and
    `PROGRESS.md` here — a server change and its two client consequences should be reviewable in one
    diff. Separate repos guarantee the contract drifts and the ledger stops seeing mobile.
98. **Fence them off so they cost nothing.** Add `apps/ios/` and `apps/android/` to `.eslintignore`
    scope and keep them out of `tsconfig.json` `include`, `vitest.config.ts`, and the electron-builder
    `files` globs. `npm test` must not get slower or noisier. Gitignore `apps/ios/*.xcodeproj`,
    `apps/ios/DerivedData/`, `apps/android/.gradle/`, `apps/android/**/build/`,
    `local.properties`, `*.keystore`, `*.p8`, `*.p12`.
99. **CI: GitHub Actions,** extending `.github/workflows/` (which already has `ci.yml` and
    `windows-launch-smoke.yml`) with `ios.yml` and `android.yml`, both `on: pull_request` with
    `paths:` filters so a server-only PR does not spin a macOS runner (they are ~10× the minutes).
    - `ios.yml`: `macos-15`, `xcodegen generate`, `xcodebuild test -scheme Markie -destination
      'platform=iOS Simulator,name=iPhone 16'`, plus `swift test` on the local packages (fast, runs on
      every PR; the simulator job can be `paths`-gated harder if minutes bite).
    - `android.yml`: `ubuntu-latest`, `./gradlew testDebugUnitTest lintDebug assembleDebug`, Gradle
      cache action. Instrumented tests on a Gradle Managed Device only nightly.
    - **Xcode Cloud is the wrong choice here** — it is repo-root-oriented, awkward with XcodeGen's
      generated project, and splits CI across two systems for a repo that already lives in Actions.
100. **Distribution.** TestFlight via `xcrun altool`/`app-store-connect` with an App Store Connect API
     key, and Play Console **internal testing** via the Play Developer API — but per
     `CONSTITUTION.md` ("Never … publish, notarize, or deploy" unattended, and release is a human
     checkpoint), wire these as **manually dispatched** workflows (`workflow_dispatch`), never on
     push. Same posture as `npm run electron:release` being the only signing path today.
101. **Code signing.** iOS: an App Store Connect API key (`.p8`) in Actions secrets +
     `-allowProvisioningUpdates`, or `fastlane match` with a private certs repo if more than one
     person builds. Never commit provisioning profiles or the `.p8`. Android: Play App Signing (Google
     holds the release key); the upload keystore lives in a base64 Actions secret, decoded to a temp
     file at build time and deleted after. **Remember: `assetlinks.json` must carry the Play App
     Signing fingerprint, not the upload key's** (§49).
102. **Bundle IDs / package names:** `com.zvndev.markie` on both, matching the desktop's existing
     identifier convention (see `electron-builder.config.cjs`). Reserve both stores' listings early —
     the name "Markie" on the App Store is the kind of thing that gets taken while you plan.
103. **Version scheme:** track the desktop's semver from `package.json` for the marketing version,
     with an independent monotonic build number. `npm run release:version` already exists as the
     source of truth for the desktop version — read it, don't fork it.

---

## 8. Server/API changes required for mobile

Every item here touches `CONSTITUTION.md`'s "public API shape" or "schema/data-model" checkpoints and
needs sign-off before implementation. Ordered by milestone need.

| # | Change | File(s) | Needed by |
|---|---|---|---|
| 8.1 | Serve `/.well-known/apple-app-site-association` (JSON, no redirect, no auth) | site/rewrite layer for `markiedocs.com`; belt-and-braces route in `server/src/public.ts` | M1 |
| 8.2 | Serve `/.well-known/assetlinks.json` with the Play App Signing SHA-256 | same as 8.1 | M1 |
| 8.3 | Generalise the OAuth bridge: accept a validated `client` (`desktop`\|`ios`\|`android`) on `/auth/google-start`, carry it to `/auth/desktop-bridge`, and have `desktopAuthDeepLink()` emit the matching scheme | `server/src/index.ts`, `server/src/desktop-auth.ts` (keep `STATE_PATTERN` as-is; allowlist the scheme, never reflect a client-supplied URL) | M1 (only if Google ships in M1) |
| 8.4 | Add the mobile schemes to `trustedOrigins`; add `apple` to `socialProviders` if Google ships (Guideline 4.8, §44) | `server/src/auth.ts` | M1 |
| 8.5 | Pin `session: { expiresIn, updateAge }` explicitly so token lifetime is a written contract, not a library default | `server/src/auth.ts` | M1 |
| 8.6 | `canCommentLevel(level) = level !== null` — let **viewers** create threads and reply; keep resolve/reopen and cross-user delete at editor/owner | `server/src/shares.ts` (new helper), `server/src/comments.ts` (`canWrite` at the two POST routes) | M2 |
| 8.7 | If the M4 WebView bundle makes its own REST calls, add its origin to the CORS allowlist. Prefer proxying through native and changing nothing | `server/src/index.ts` | M4 |
| 8.8 | `GET /api/docs?since=<iso>` and/or `ETag`/`If-None-Match` on `GET /api/docs` and `GET /api/docs/:id`. Today the list is unpaginated and `GET /api/docs/:id` always returns full content — fine on wifi, wasteful on cellular and on a 15-minute background worker | `server/src/docs.ts` | M1 (nice) / M3 (needed) |
| 8.9 | Device-token table + `POST /api/me/devices`, `DELETE /api/me/devices/:token`; APNs/FCM fan-out beside `sendEmail()` in `notify()`. New external dependency → escalate | new `server/src/devices.ts`, `server/src/push.ts`; wire in `server/src/index.ts`; call from `server/src/comments.ts` | M2 |
| 8.10 | Rate limits: confirm the mobile OTP flow fits `"/email-otp/send-verification-otp": { window: 60, max: 5 }` and that the global 100/10s does not throttle a cold Library load (list + N doc fetches + threads). Consider a `customRules` entry for `/api/docs` | `server/src/auth.ts` | M1 |
| 8.11 | `Retry-After` / structured JSON on 429 so mobile can back off instead of showing "something went wrong" | `server/src/auth.ts` (better-auth rate-limit response), Hono middleware | M1 |
| 8.12 | Collab token is in the query string (`?token=` in `attachCollab`, `server/src/collab.ts`). Fine for the desktop; on mobile it may reach proxy/access logs. Consider accepting `Sec-WebSocket-Protocol` as an alternative carrier | `server/src/collab.ts` | M4 |
| 8.13 | A tiny `GET /api/mobile/config` returning minimum supported build + a maintenance flag, so a broken client can be told to update instead of failing opaquely | new route in `server/src/index.ts` | M1 |
| 8.14 | Nothing needed for comment anchors — the server already stores `anchor` opaquely (`JSON.stringify`/`JSON.parse`, `server/src/comments.ts`). The `{kind:"quote",…}` variant (§65) is a **client-side** change in `src/lib/comments.ts` + `src/components/comments.tsx` | desktop only | M2 |
| 8.15 | Confirm `/d/:id` and `/s/:token` keep working in a browser after app-links claim them — a desktop user clicking the same email link must still get the web page. (They will; universal links only affect the phone.) No change, just a test | `server/src/doc-view.test.ts`, `server/src/public.test.ts` | M1 |

---

## 9. Milestones

Each milestone is a shippable state. Acceptance criteria are written as reproducible user steps, in
the style `feature_list.json` uses, because the same verification rule applies:
`CONSTITUTION.md` — "Verify a feature by reproducing its `steps[]` as a real user."

### M0 — Spike (1 week, iOS only, throwaway)

**Goal:** kill the unknowns before committing to a stack.

- 9.1 Point a bare SwiftUI app at the running server; sign in with email OTP; list `GET /api/docs`.
- 9.2 Render three real markdown documents (a README with tables, a doc with fenced code, a doc with
  math) with `swift-markdown` → SwiftUI, and screenshot them next to the desktop rich view.
- 9.3 Open a `.md` from Files.app via `.fileImporter`, edit a line, save it back, confirm the change
  on disk from the Mac.
- 9.4 Connect a raw `URLSessionWebSocketTask` to `wss://…/collab/<docId>?token=…` and log the frames;
  confirm the `MESSAGE_SYNC`/`MESSAGE_AWARENESS` framing matches §55 and that a viewer's frames are
  dropped.
- 9.5 Written go/no-go on §68 (WebView-for-collab) and §84 (SwiftData) with evidence.

**Acceptance:** the spike is deleted, and a one-page findings note updates §4, §5, and §10 of this
document with what was actually observed.

### M1 — Read-only shared-doc viewer, auth, universal links (~4 weeks per platform)

- 9.6 Sign in with email OTP; token in Keychain / EncryptedSharedPreferences; survives relaunch;
  401 → sign-in screen with the pending destination preserved.
- 9.7 Library lists owned + shared docs from `GET /api/docs`, badged by `role` and `shared_by`;
  "Shared by me" from `GET /api/docs/shared-by-me`.
- 9.8 Tapping `https://markiedocs.com/d/:id?k=…` in Mail opens the app to that document. Tapping
  `https://markiedocs.com/s/:token` opens it **without an account**. Tapping
  `https://markiedocs.com/download` still opens the browser.
- 9.9 Native GFM rendering with tables, task lists, highlighted code, images; light and dark both
  legible; Dynamic Type / font-scale respected.
- 9.10 Offline: an opened doc reopens with no network; the UI says "offline", not "failed".
- 9.11 Share sheet exports `.md`.
- 9.12 Server: 8.1, 8.2, 8.4, 8.5, 8.10, 8.11, 8.13, 8.15 merged and tested.

**Acceptance:** on a factory-reset device with the app installed from TestFlight/internal track, a
person who has never used Markie taps an invite link in Gmail and reads the document, correctly
rendered, in the app, in under 10 seconds — and if they were a pending invite, signing up with that
email makes the doc appear in their Library automatically (`claimPendingInvites`,
`server/src/auth.ts`).

### M2 — Comments (~3 weeks per platform)

- 9.13 Thread list + inline anchor highlights for existing `{from,to}` anchors received from the
  server, resolved best-effort; unresolvable anchors show as an "unanchored" pill rather than
  vanishing.
- 9.14 Reply to a thread, resolve/reopen (role permitting), delete own comment.
- 9.15 Create a new thread from a text selection, minting a `{kind:"quote",…}` anchor (§65); the
  desktop resolves it correctly. Round-trip verified on a doc concurrently edited on desktop.
- 9.16 Push notification on a new comment opens the app directly to that thread.
- 9.17 Server: 8.6 (viewers may comment) and 8.9 (device tokens + push) merged; desktop 8.14 merged
  with a regression test in `src/lib/comments.test.ts` style.

**Acceptance:** a viewer-role user on a phone leaves a comment on a selected sentence; the desktop
owner sees it anchored to the same sentence, is emailed *and* pushed, and replies; the phone shows
the reply. Removing that user's share (`DELETE /api/docs/:id/shares/:idOrEmail`) makes their next
comment attempt fail cleanly with a "you no longer have access" state, not a crash.

### M3 — Local files + editing (~4 weeks per platform)

- 9.18 Open a single `.md` from Files.app / SAF, edit, save in place; verify the bytes changed from
  a desktop. Android write uses `"rwt"` (§28); iOS write is `NSFileCoordinator`-wrapped (§24).
- 9.19 Grant a folder; browse it; the grant survives relaunch (security-scoped bookmark /
  persisted URI permission) and degrades gracefully when revoked.
- 9.20 Markdown source editing with the formatting accessory bar; list continuation and checkbox
  toggling match the desktop's behaviour on the same input.
- 9.21 Edit a synced cloud doc → `PUT /api/docs/:id` with the correct `baseVersion`; offline edits
  queue as `unpushed` and drain on reconnect.
- 9.22 The conflict dialog (§35–§40) ships with all three options, the line-count summary, "Keep
  both" as the default, and "Take cloud" refused while `unpushed`.
- 9.23 PDF + HTML export through the share sheet, styled from `src/lib/pdf-styles.ts`, dark and light.
- 9.24 Server: 8.8 (`since`/ETag) merged.

**Acceptance:** with airplane mode on, edit a synced doc on the phone and the same doc on the
desktop; reconnect; the phone shows the conflict dialog with an accurate line summary, "Keep both"
produces `<name> (my version).md` alongside the original, and **no version of the text is lost** —
verified by diffing all three copies.

### M4 — Live collaboration (~4 weeks per platform)

- 9.25 A doc opened while another client is in the room switches to the collab surface (the WebView
  bundle, §68), connects to `wss://…/collab/<docId>?token=…`, and shows remote cursors with the
  server-stamped names/colours (§58).
- 9.26 Viewers get presence and live updates but no editing, and the UI *says so* rather than
  silently discarding keystrokes (§57).
- 9.27 Close code 4403 → immediate read-only + "your access changed", no reconnect loop (§59).
- 9.28 Comment anchors minted in the collab surface are native `{from,to}` Yjs relative positions,
  identical to desktop.
- 9.29 Reconnect after a tunnel/backgrounding with no duplicated or lost text.
- 9.30 Server: 8.7 and 8.12 as needed.

**Acceptance:** desktop and phone edit the same paragraph simultaneously for 60 seconds; both
converge to identical text; a third client joining cold sees the same document; revoking the phone
user's share mid-session hangs up the socket within a second and the phone drops to read-only.

---

## 10. Open decisions for the owner

Five, each with the default I would take if you say nothing.

10.1 **Two fully native codebases, or Kotlin Multiplatform for the shared core?**
&nbsp;&nbsp;&nbsp;&nbsp;**Recommended default: two fully native codebases, no KMP** — the genuinely shareable
logic is ~1–2k lines of REST client and sync-state machine, which does not repay putting a Kotlin
toolchain, a Gradle build, and an xcframework in the middle of every iOS build, and the parts that
are actually hard (file access, editing, rendering, collab) are irreducibly platform-specific
anyway. (This also supersedes the React Native assumption in
`docs/superpowers/plans/2026-06-28-style-platform-react-native-roadmap.md` — that supersession needs
your explicit ratification.)

10.2 **Does v1 ship Google sign-in?**
&nbsp;&nbsp;&nbsp;&nbsp;**Recommended default: no.** Email OTP only in M1 — it removes server change 8.3
from the critical path and removes the App Store Guideline 4.8 obligation to also implement Sign in
with Apple. Add Google + Apple together in M2.

10.3 **Should viewers be allowed to comment (server change 8.6)?**
&nbsp;&nbsp;&nbsp;&nbsp;**Recommended default: yes.** "Read a doc someone sent you and leave a note" is
the mobile wedge, and today `canWrite()` in `server/src/comments.ts` 403s a viewer on both thread
creation and reply. It is a real permission-model change and it changes desktop behaviour too, so it
is yours to call.

10.4 **`apps/ios` + `apps/android` in this repo, or separate repos?**
&nbsp;&nbsp;&nbsp;&nbsp;**Recommended default: this repo**, fenced off from `npm test`, tsconfig, lint,
and electron-builder globs, with `paths`-filtered CI workflows. The contract lives here and
`CONSTITUTION.md` treats it as a checkpoint; splitting the repo splits the checkpoint.

10.5 **iOS first, or both platforms in lockstep?**
&nbsp;&nbsp;&nbsp;&nbsp;**Recommended default: iOS first through M1, then Android starts M1 while iOS
starts M2.** Markie's current public build is Apple Silicon macOS (`README.md`), so the existing user
base is disproportionately Apple; and a one-milestone lag lets Android inherit M1's server changes
and design decisions instead of discovering them twice.

---

## Appendix A: server surface as it exists today

Compiled from `server/src/index.ts` and the route modules. Mobile should treat this as the contract;
nothing outside this list exists.

**Public / unauthenticated**
- `GET /health` → `{ ok, service, version }`
- `GET /s/:token` → rendered public share page (`server/src/public.ts`)
- `GET /s/:token/raw` → `text/markdown` attachment
- `GET /d/:id?k=<token>` → rendered personal share page; `403` (deliberately indistinguishable from
  "no such doc") otherwise (`server/src/doc-view.ts`)
- `GET /d/:id/raw?k=<token>` → `text/markdown` attachment
- `GET /download`, `GET /download/:platform`, `GET /download/latest.json`, `GET /download/latest`
  (`server/src/public.ts`, `server/src/downloads.ts`) — **not** for mobile to claim

**Auth** (`server/src/auth.ts`, better-auth mounted at `/api/auth/*` in `server/src/index.ts`)
- `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`
- `POST /api/auth/email-otp/send-verification-otp` (`{ email, type: "sign-in" }`)
- `POST /api/auth/sign-in/email-otp` (`{ email, otp }`)
- `POST /api/auth/sign-out`
- `GET /auth/google-start?state=<nonce>` → 302 to Google (`server/src/index.ts`)
- `GET /auth/desktop-bridge?state=<nonce>` → HTML that redirects to `markie://auth?token=…&state=…`
- `GET /api/me` → `{ user: { id, email, name } | null }`
- Responses carry `set-auth-token`; requests carry `Authorization: Bearer <token>`

**Documents** (`server/src/docs.ts`)
- `GET /api/docs` → `{ docs: [...owned, ...shared] }`; shared rows add `shared: true`, `role`, `shared_by`
- `GET /api/docs/shared-by-me` → `{ docs: [{ id, name, updated_at, memberCount, pendingCount }] }`
- `GET /api/docs/:id` → `{ doc: { id, name, version, content, hash, updated_at } }`
- `PUT /api/docs/:id` `{ name, content, hash, baseVersion }` → `{ id, version, updated_at }` or
  `409 { error: "conflict", serverVersion }`
- `DELETE /api/docs/:id` → soft-delete (owner only); also closes the collab room

**Sharing** (`server/src/shares.ts`)
- `GET /api/docs/:id/access` → `{ access: { role, canRead, canEdit, canManage } }`
- `GET /api/docs/:id/shares` → members (+ pending invites, owner only)
- `POST /api/docs/:id/shares` `{ email, role: "viewer"|"editor" }` → `{ status: "member"|"invited" }`
- `DELETE /api/docs/:id/shares/:idOrEmail` (owner only; also hangs up that user's collab socket)
- `GET|POST|DELETE /api/docs/:id/public-link` → `{ url: "https://markiedocs.com/s/<token>" | null }`

**Comments** (`server/src/comments.ts`)
- `GET /api/docs/:id/threads` → threads with parsed `anchor` + nested comments
- `POST /api/docs/:id/threads` `{ anchor, body }` → `{ id, commentId }` — **editor+ only today**
- `POST /api/docs/:id/threads/:threadId/comments` `{ body }` — **editor+ only today**
- `POST /api/docs/:id/threads/:threadId/status` `{ status: "open"|"resolved" }`
- `DELETE /api/docs/:id/threads/:threadId/comments/:commentId`

**Themes** (`server/src/themes.ts`)
- `GET|PUT /api/me/themes` — opaque per-user theme store, last-write-wins
- `GET|PUT /api/docs/:id/theme` — owner-pinned theme tokens for a doc

**Collab** (`server/src/collab.ts`)
- `WS wss://<api-host>/collab/:docId?token=<bearer>` — y-websocket wire protocol
  (`0` sync / `1` awareness), close `4403` = access revoked

**Client config note:** `src/lib/auth-client.ts` defaults `SERVER` to
`https://api-production-602f.up.railway.app` (overridable via `localStorage`), while share links use
`https://markiedocs.com` (`server/download-manifest.json` → `markieSiteUrl()`). Mobile needs both:
an API base URL and a site base URL, and the `src=` origin allowlist from `electron/share-origin.js`
applies to both.
