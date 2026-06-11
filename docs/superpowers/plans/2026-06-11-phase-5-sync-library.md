# Phase 5: Sync, Backup, and the Library Browser

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in users get cloud backup and multi-device access: every file Markie opens is tracked locally; synced docs upload snapshots on save; a Library view shows local vs cloud state; removing a doc from cloud asks "delete cloud copy, or keep + pause syncing?"; docs from another device can be pulled down. Files never move from where they live on disk.

**Architecture:**
- **Local registry (D5):** better-sqlite3 in the Electron **main** process at `userData/registry.db`: `files(path PK, name, content_hash, cloud_doc_id, sync_state, last_opened_at, last_synced_at)`. `sync_state ∈ local-only | synced | paused | conflict`. IPC surface: `registry-list`, `registry-track`, `registry-set-sync`, plus sync ops.
- **Server doc endpoints** (bearer-authed, content in SQLite for now — B2 offload is a deploy-time concern, schema keeps `b2_key` nullable): `GET /api/docs` (list with hash+version), `PUT /api/docs/:id` (upsert snapshot {name, content, hash, baseVersion}; 409 on version mismatch → conflict), `GET /api/docs/:id` (content), `DELETE /api/docs/:id`. Version = monotonic int; history table keeps every snapshot.
- **Sync engine (D6, snapshot model):** in main process. On save of a tracked file with sync on: hash → if changed, PUT with baseVersion → update registry (or mark conflict on 409). On app start + Library open: pull remote list, diff against registry. Conflict = both changed since last_synced: keep both (cloud version saved as `<name> (cloud).md` next to local on explicit resolve), badge in Library.
- **Library UI:** overlay (⌘L / palette / menu): merged list of registry + remote docs with badges (*local-only*, *synced*, *cloud-only*, *paused*, *conflict*), actions per row: open, sync on/off (off on a synced doc triggers the keep-or-delete dialog), download (cloud-only → choose folder), resolve conflict.

---

### Task 1: Server doc endpoints + tests-by-curl
`server/src/docs.ts` — Hono routes, auth-gated via `auth.api.getSession`; tables `docs(id, owner_id, name, version, content, hash, updated_at, deleted_at)` + `doc_history(doc_id, version, content, hash, created_at)` created via idempotent `CREATE TABLE IF NOT EXISTS` on boot. Verify with curl: create, list, get, conflict 409, delete.

### Task 2: Local registry + sync engine in Electron main
`electron/registry.js` (better-sqlite3, CRUD + hash), `electron/sync.js` (push/pull/diff using fetch with the renderer-provided bearer token — token passed over IPC at sign-in, held in memory in main). IPC: `library-state` (merged local+remote view), `doc-sync-set`, `doc-push`, `doc-pull`, `doc-remove-cloud {deleteRemote}`. Hook into save path: after a successful save of a tracked synced file, push. Track every file open.

### Task 3: Library UI + remove-from-cloud flow
`src/components/library.tsx` (⌘L): list with badges + actions; sync-off dialog with the exact Kirby semantics: **"Delete the cloud copy"** vs **"Keep cloud copy, pause syncing"** (default). Cloud-only docs: "Download…" → save dialog → tracked as synced. Wire into menu/palette/shortcuts.

### Task 4: Verify + ship
Packaged CDP pass: sign in → open file → toggle sync → edit+save → server has v2 → simulate second device (delete local registry row, pull) → conflict path (server bumped while local edited → 409 → badge → resolve). PR + merge.
