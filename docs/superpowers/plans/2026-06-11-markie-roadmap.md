# Markie Product Roadmap — Master Phased Plan

> **For agentic workers:** This is the MASTER ROADMAP. Each phase gets its own
> detailed implementation plan (written via superpowers:writing-plans) before
> execution. Phase 1's detailed plan already exists:
> `docs/superpowers/plans/2026-06-11-phase-1-local-polish.md`.

**Goal:** Evolve Marker (now **Markie**) from a local Mac markdown viewer into a
local-first markdown platform with a free cloud tier: account sync, Google-Docs-style
live collaboration, comments, and theming — at essentially flat hosting cost.

**Product positioning:** Local mode is fully functional with no account, forever.
Cloud is a free long-tail of features (backup, multi-device, sharing, live collab,
comments, synced themes). Architecture keeps marginal cost per user near zero so
"free mode" is sustainable; paid tiers are a later decision, not a dependency.

**Tech stack (current):** Next.js 16 (static export) + React 19 + Electron 41,
CodeMirror 6 (edit), react-markdown + remark/rehype (preview), Tailwind 4,
electron-builder (mac DMG).

---

## Architecture Decisions (locked in unless Kirby objects)

These are the opinionated calls. Each is flagged because it's hard to change later.

### D1. Cloud host: one cheap ARM VPS, not the ZVN home server
Single Hetzner CAX11 (ARM, 2 vCPU/4GB, ~€3.79/mo) running everything: API,
auth, WebSocket collab server, Postgres. Backblaze B2 for document
snapshots/version history. B2→Cloudflare egress is free (Bandwidth Alliance),
so cost = VPS (flat) + B2 storage (markdown is tiny: 1M docs × ~20KB ≈ 20GB ≈
$0.12/mo) + domain. **Total ≈ $5–6/mo flat.** The ZVN M3 Max stays out of the
serving path (availability risk for a product with other users' data); it comes
back in Phase 9 for AI features where downtime is acceptable.

### D2. Collab engine: custom server + presence, Yjs for the CRDT core
"Custom Google-Docs-style" = we build the server, protocol, presence,
permissions, cursors UI, and persistence ourselves — but the conflict-resolution
data structure is **Yjs** (CRDT). Hand-rolling a correct CRDT/OT engine is a
multi-month correctness project with brutal edge cases; Yjs is a small MIT
library with first-class CodeMirror 6 and ProseMirror bindings and is the
industry default in 2026. Everything user-visible is still custom. If Kirby
wants a fully hand-rolled CRDT anyway, that's a scope conversation before
Phase 6.

### D3. Rich "View" editor: ProseMirror (via TipTap) with markdown round-trip
Phase 2's WYSIWYG editing in the View pane uses TipTap (ProseMirror) with
markdown serialization — the markdown file on disk stays the source of truth.
CodeMirror remains the raw Edit mode. Chosen because ProseMirror is the only
battle-tested base for the later requirements: collaborative cursors
(y-prosemirror), range-anchored comments that survive edits, and themeable
rendering. react-markdown remains only for read-only contexts (PDF export
pipeline).

### D4. Auth: better-auth on our server
Google OAuth + email OTP + email/password are all first-class in better-auth
(self-hosted TypeScript, no per-user pricing — fits flat-cost). Desktop OAuth
flow: system browser → `markie://` deep link callback. Email delivery: Resend
free tier (3k/mo) to start, swap to SES if invite volume grows.

### D5. Local data: SQLite registry in the Electron main process
Files always live where they live on disk. A `better-sqlite3` database in
`app.getPath("userData")` tracks every file Markie has opened: path, content
hash, last opened, cloud doc id, sync state. This powers the library browser
(Phase 5), recents, and sync bookkeeping without ever moving user files.

### D6. Sync model: snapshot sync first (Phase 5), CRDT log second (Phase 6)
Phase 5 backup/multi-device sync is versioned snapshots (whole-doc upload on
change, hash-deduped, history kept in B2) — simple, debuggable, fine for
single-user. Phase 6 live collab upgrades shared docs to a Yjs update log on
the WebSocket server with periodic compacted snapshots to B2. A doc is either
"snapshot-synced" (private) or "live" (shared) — shared docs get migrated
one-way on first share.

### Proposed cloud schema (review before Phase 4 starts)

```
users          (id, email, name, image, created_at)            -- better-auth owns auth tables
devices        (id, user_id, name, platform, last_seen_at)
docs           (id, owner_id, title, kind: 'snapshot'|'live',
                head_version_id, b2_key_prefix, deleted_at, created_at, updated_at)
doc_versions   (id, doc_id, hash, size_bytes, b2_key, device_id, created_at)
shares         (id, doc_id, user_id, role: 'viewer'|'editor',
                enforce_owner_theme: bool, invited_by, created_at)
comments       (id, doc_id, parent_id, author_id, body,
                anchor: jsonb (Yjs relative positions), resolved_at, created_at)
theme_presets  (id, user_id, name, tokens: jsonb, created_at, updated_at)
doc_local_map  -- client-side SQLite only: (path, content_hash, cloud_doc_id,
                sync_state: 'local-only'|'synced'|'paused'|'conflict', last_opened_at)
```

---

## Phases

Ordering principle: Kirby uses this daily as a local tool — ship local value
first (Phases 0–3), then build the cloud platform (4–8), then AI (9). Each
phase is independently shippable.

### Phase 0 — Rename to Markie ✅ *(completed 2026-06-11, bundled into Phase 1)*
`package.json` name/productName/appId (`com.zvn.markie`), window title,
`layout.tsx` metadata, welcome sample, toolbar wordmark, `app://markie`
protocol URL. Pre-release, so no migration concerns. Spec item: **10**.

### Phase 1 — Local polish ✅ *(completed 2026-06-11 on branch feat/markie-phase-1)*

> Shipped with two additions beyond the plan: a no-flash boot sequence
> (renderer paints nothing until the initial file resolves; window hidden
> until ready-to-show) and a register-once IPC listener pattern fixing a
> latent duplicate-handler bug. Known gap: `public/icon.icns` is missing,
> so the packaged app uses the default Electron icon.
Spec items: **3, 8**.
1. **Cold-start file open fix** — queue `open-file` events that arrive before
   the renderer is ready; renderer pulls the pending file on mount via a
   `get-initial-file` IPC handshake. Also honor CLI args. Opening a .md from
   Finder lands directly on that file, rendered, first try.
2. **View-first UI** — default mode is preview, renamed **"View"** (Cmd+1).
   Edit (Cmd+2) and Split (Cmd+3) demoted to icon-only buttons.
3. **Stats out of the toolbar** — word/char counts move to a native View-menu
   item ("Statistics", Cmd+Shift+I) opening a panel with advanced stats
   (words, chars, chars-no-spaces, lines, headings, code blocks, links,
   reading time).
4. **Traffic-light overlap fix** — toolbar left padding clears the macOS
   close/minimize/zoom buttons in Electron.
5. **File lifecycle** — Save (Cmd+S), Save As (Cmd+Shift+S), inline Rename,
   Fork/Duplicate (Cmd+Shift+D), Export submenu (PDF dark/light, HTML,
   Markdown copy), dirty-state indicator.

### Phase 2 — Rich editing in View ✅ *(completed 2026-06-11)*

> Shipped per plan plus two Kirby-requested additions: a contextual table
> bar + table prettifier (Format Tables, Cmd+Alt+T; rich edits always emit
> aligned pipes), and native CSV support (.csv opens as an editable rich
> table, saves back as true RFC-4180 CSV). v1 tradeoffs as documented in
> the phase plan: math/footnotes insert raw syntax; code blocks unhighlighted
> in the rich surface.
Spec item: **4**.
- TipTap/ProseMirror editable surface replaces read-only preview in View mode;
  markdown round-trip (remark ↔ ProseMirror doc) keeps the .md file as truth.
- **Left vertical toolbar** (Photoshop-style): common tools always visible —
  headings, bold/italic/strike, code/code block, link, lists, task list,
  quote, table, image, hr. **Advanced toggle** discloses the long tail below:
  math blocks, footnotes, alignment, table row/col ops, frontmatter.
- Everything in markdown must be reachable through the toolbar (parity test:
  every GFM + math construct insertable and editable).
- Exit criteria: typing in View feels native; Edit/Split still work; PDF
  export unchanged.

### Phase 3 — Keyboard-first, performance, local theming ✅ *(completed 2026-06-11)*

> Command palette (⌘K) over a central registry, shortcut cheat-sheet (⌘/),
> theme engine (Dark/Light built-ins + custom presets, localStorage).
> Perf measured, not guessed: p50 3.2ms / p95 9.2ms typing latency on a
> 5,500-line doc (scripts/perf-check.mjs) — no optimization needed.
> Critical fix: app:// scheme registered as privileged; production
> localStorage was silently denied before this, which would have broken
> Phase 5 sync state too.
Spec items: **12, 13 (local half)**.
- **Command palette** (Cmd+K) exposing every action; complete keyboard
  navigation (panes, menus, toolbar, stats, dialogs — zero mouse required);
  shortcut cheat-sheet (Cmd+/).
- **Performance budget:** keystroke→paint < 16ms on a 5k-line doc. Memoized
  block-level preview rendering in Split, debounced markdown serialization,
  virtualized long docs if needed. Add a perf harness so regressions are
  measurable.
- **Theming engine:** design tokens (colors, fonts, sizes, spacing, code
  highlight theme) as JSON presets; settings UI to create/edit/apply; presets
  stored locally (cloud sync comes in Phase 8). Light theme ships here.

### Phase 4 — Cloud foundation: server + accounts ✅ *(completed 2026-06-11, locally verified)*

> Revision to D1: SQLite + Litestream→B2 instead of Postgres (one process,
> one file, backups included in flat cost). server/ = Hono + better-auth:
> email+password, email OTP (Resend/console), Google env-gated. Desktop
> Settings (⌘,) with full auth flows; sessions via bearer tokens (app://
> cross-origin cookies are unreliable). Deploy assets in deploy/ with
> DEPLOY.md checklist. Verified locally end-to-end in the packaged app;
> production go-live awaits Kirby's provisions (VPS, DNS, B2, Resend,
> Google OAuth keys). Google flow untestable until then.
Spec items: **1, 5**.
- Provision VPS (Docker Compose: API + Postgres + Caddy), domain, B2 bucket,
  Resend. Hono API server, better-auth with Google OAuth + email OTP +
  email/password; `markie://` deep-link OAuth callback.
- In-app **Settings page**: account (sign in/out, sessions/devices, linked
  providers), global "sync my docs" toggle, per-doc override default.
- No doc features yet — exit criteria is: create account, sign in from the
  app, see yourself in Settings, sign in from a second machine.

### Phase 5 — Sync, backup, and the library browser ✅ *(completed 2026-06-11, locally verified)*

> Snapshot sync per D6: versioned PUTs with 409 conflict detection +
> history on the server; local SQLite registry (D5) in Electron main;
> Library (⌘L) with full state machine (local-only/synced/paused/
> conflict/behind/cloud-only) and the keep-or-delete flow exactly as
> specced. Every state transition CDP-verified in the packaged app.
Spec items: **5 (sync half), 7**.
- Local SQLite registry (D5) starts tracking every opened file.
- **Library view** in-app: all known docs with state badges — *local-only*,
  *synced*, *cloud-only (other device)*, *paused*, *conflict*. Files never
  move; cloud-only docs can be pulled down to a chosen folder.
- Snapshot sync engine (D6): hash-on-save → upload → version history in B2;
  pull-down on login from another device.
- **Remove-from-cloud flow** exactly as specced: removing a synced doc asks
  "Delete the cloud copy, or keep it and just pause syncing?" — pause is the
  safe default.
- Conflict handling: never overwrite silently; keep both versions, badge the
  doc, side-by-side resolve UI.

### Phase 6 — Sharing and live collaboration ✅ *(completed 2026-06-11, two-client E2E verified)*

> Custom y-websocket-protocol server (hand-rolled on yjs 13 + y-protocols
> after @y/websocket-server proved version-broken): share-gated rooms at
> /collab/:docId, SQLite update log with compaction, awareness relay.
> Desktop: TipTap Collaboration + CollaborationCaret in View, first-peer
> seeds empty rooms from the local file, Share dialog + avatar stack +
> Live dot, source pane read-only while live. Verified packaged-app
> Alice ↔ headless Bob: both edit directions, presence both ways,
> invite email, bad-token rejection, persistence across room teardown.
Spec items: **6, 11 (presence half)**.
- Share dialog: add by email, viewer/editor roles; invitee gets an email
  ("you've been added to <doc>"); docs shared with you appear in your library.
- First share migrates the doc snapshot→live (Yjs log on our WebSocket server).
- Live editing in the rich View pane with named carets and a toolbar avatar
  stack. *(Deviation: Edit pane locks read-only during live sessions instead
  of y-codemirror.next — one collaborative surface for v1; snapshot push
  pauses while live so peer saves can't race the version counter.)*
- Server enforces share roles on every connection upgrade; viewer-role
  edit blocking is client-side for v1 (protocol-level guard noted as
  future hardening).

### Phase 7 — Comments ✅ *(completed 2026-06-11, E2E verified in packaged app)*

> Server: threads + comments tables with opaque relative-position anchors,
> role-gated routes (viewers read, editors+owner write), notification
> emails to owner + thread participants. Desktop: selection → Comment
> affordance, margin gutter bubbles via y-tiptap relative→absolute
> mapping, thread panel with replies/resolve/reopen/delete-own, resolved
> chip, 15s polling. Verified: thread created through the real composer
> UI, Bob's API reply appears, anchor selects the identical text after a
> concurrent insert above it, resolve/reopen round-trip, email logged.
> *(Deviation: library comment counts deferred — counts show in-doc.)*
Spec item: **11**.
- Range-anchored comments using Yjs relative positions (anchors survive
  concurrent edits), threads with replies, resolve/reopen, right-margin gutter
  UI Google-Docs style, email notification on new comment on your doc.

### Phase 8 — Shared theming
Spec item: **13 (cloud half)**.
- Theme presets sync to the account (theme_presets table).
- Per-share toggle: **"Viewers see my theme"** (enforced — doc opens locked to
  the owner's preset, which travels with the share) vs. recipients read in
  their own theme. Default: viewer's choice.

### Phase 9 — AI + MCP *(later, design sketch only)*
Spec item: **9**.
- **Markie MCP server** (stdio + streamable HTTP): tools to list/read/edit
  docs, insert at heading, add comments — so Claude Code & friends can drive
  Markie.
- Local AI via the ZVN inference gateway (`@zvndev/inference`): summarize doc,
  rewrite selection, outline → draft. Cloud-account-free; runs against the M3
  Max. This is where the home server enters, not the serving path.

---

## Cost model (free mode, item 1)

| Item | Cost | Shape |
|---|---|---|
| Hetzner CAX11 VPS (API+DB+WS) | ~€3.79/mo | flat |
| Backblaze B2 (doc snapshots) | $6/TB/mo | ~pennies (markdown) |
| B2 egress via Cloudflare | $0 | flat |
| Resend email | $0 (3k/mo tier) | flat until scale |
| Domain | ~$12/yr | flat |

Markdown is the cheapest possible payload to host. The only real scaling cost
is WebSocket fan-out for live collab, and one ARM core handles thousands of
concurrent Yjs rooms. Free mode is structurally safe.

## Decision points for Kirby (answer before the named phase)

1. **Now (D1):** VPS vs. ZVN home server for the product backend — plan assumes VPS.
2. **Phase 2 (D3):** TipTap/ProseMirror as the View editor base — plan assumes yes.
3. **Phase 4 (D4):** better-auth vs. hand-rolled auth — plan assumes better-auth.
4. **Phase 4:** schema review (above) before migrations are written.
5. **Phase 6 (D2):** Yjs CRDT core inside the custom collab server — plan assumes yes; fully hand-rolled CRDT is a big scope add.

## Spec coverage map

| Spec item | Phase |
|---|---|
| 1 free mode / flat-cost cloud | 4 + cost model |
| 2 local mode + cloud long tail | 1–3 local, 4–8 cloud |
| 3 cold start, View default, stats to menu, traffic lights | 1 |
| 4 rich editor w/ progressive disclosure, left toolbar | 2 |
| 5 auth (Google/OTP/password), settings, sync, multi-device | 4 + 5 |
| 6 sharing, live editing, presence, invite emails | 6 |
| 7 library browser, cloud-vs-local, remove-from-cloud confirm | 5 |
| 8 fork, save as, rename, export | 1 |
| 9 local AI / MCP | 9 |
| 10 rename to Markie | 0 (in Phase 1 plan) |
| 11 comments + threads | 7 |
| 12 native perf + keyboard navigation | 3 (budget enforced 6) |
| 13 theming, enforced share styles, cloud presets | 3 + 8 |
