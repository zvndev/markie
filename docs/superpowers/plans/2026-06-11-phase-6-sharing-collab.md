# Phase 6: Sharing + Live Collaboration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share a synced doc with another Markie user by email (they get an invite email and the doc appears in their Library); shared docs become *live*: Google-Docs-style realtime co-editing in the View pane with named presence carets. Desktop-only, low-latency.

**Architecture (per roadmap D2):** Custom collab server — our auth, our persistence, our rooms — speaking the y-websocket wire protocol (y-protocols sync + awareness), so the battle-tested Yjs CRDT handles merge correctness. Rooms are share-gated on upgrade (bearer token + share/owner check). Updates append to a SQLite log (`doc_updates`), compacted past 500 rows; a debounced bridge keeps `docs.content` (the Phase 5 snapshot) in sync so the Library and pulls still work. Desktop: TipTap `Collaboration` + `CollaborationCaret` over `y-websocket`'s `WebsocketProvider`. First client into an empty room seeds the Y.Doc from the local file content.

---

### Task 1: Server — shares + invite emails
`server/src/shares.ts`: `shares(doc_id, user_id, role, invited_by, created_at)`; `POST /api/docs/:id/shares {email, role}` (owner-only; recipient must have an account — otherwise 404 with a clear message; sends "you've been added" email), `GET /api/docs/:id/shares`, `DELETE /api/docs/:id/shares/:userId`. Extend `GET /api/docs` + `GET /api/docs/:id` to include docs shared *with* the caller (annotated `shared: true, role`), and let `requireAccess` (owner-or-share) gate doc reads; writes stay owner+editor.

### Task 2: Server — Yjs collab endpoint
Deps: `yjs`, `y-protocols`, `ws`, `y-websocket` (server utils). Attach a `WebSocketServer` to the @hono/node-server http server on path `/collab/:docId?token=…`; on upgrade: resolve session from token, check owner/share, else destroy. `setupWSConnection` with persistence: load = apply all `doc_updates` rows (seq order); store = append update row; compact at 500; debounced (2s) markdown bridge: serialize Y.Doc XmlFragment is prosemirror-shaped — instead store the latest content pushed by clients via a lightweight `content-sync` message? **Decision:** bridge by having the server snapshot the Yjs update log only (source of truth for live docs); `docs.content` refreshes when any client saves (existing Phase 5 push path). Simpler, no server-side prosemirror.

### Task 3: Desktop — live editing + presence
Deps: `yjs`, `y-websocket`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret`. RichView gains an optional `collab` prop `{docId, wsURL, token, user: {name, color}}`: when set, editor uses Collaboration (history disabled) + CollaborationCaret with the provider; on first sync, if the shared fragment is empty, seed from `value`. Caret styles in globals.css. Page decides collab-mode: current file is synced + has shares (fetched on open) → connect. Toolbar avatar stack (connected peers from awareness).

### Task 4: Desktop — Share dialog
Toolbar "Share" button (visible when signed in and the file is synced): member list with roles, add-by-email (viewer/editor), remove. Errors surfaced ("No Markie account with that email yet").

### Task 5: Verify + ship
Two packaged instances can't run as one app bundle — verify with packaged app + a headless second client (Node script speaking y-websocket protocol, or a second Electron user-data dir via `--user-data-dir`? Electron supports `--user-data-dir` flag on chromium; mac single-instance is per user-data). Plan: packaged app (user A) + Node yjs client (user B over WebsocketProvider in a node script with ws polyfill) — assert both directions: B's insert appears in A's editor DOM; A's typing reaches B's Y.Doc; awareness shows both peers. Share flow: A shares to B's email → email logged on server console → doc listed for B via API. PR + merge.
