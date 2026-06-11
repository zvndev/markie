# Phase 7 — Comments with Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google-Docs-style comments on shared docs — select text, comment, thread replies, resolve/reopen, margin gutter, email notifications.

**Architecture:** Comments live server-side (SQLite, next to shares) keyed by doc id. Anchors are Yjs *relative positions* serialized to JSON, so they survive concurrent edits; the desktop converts them to absolute editor positions on render via y-prosemirror's sync-plugin binding. Comments are only available during live sessions (collab active) — that's exactly the set of docs with an identity, an audience, and a ydoc for anchoring. Updates poll every 15s plus refresh on mutate.

**Tech Stack:** Hono + better-sqlite3 (server), y-prosemirror relative positions via the `ySyncPluginKey` binding already inside TipTap's Collaboration extension, React gutter overlay.

---

### Task 1: Server — threads + comments endpoints

**Files:**
- Create: `server/src/comments.ts`
- Modify: `server/src/index.ts` (mount route)

Schema:
```sql
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  anchor TEXT NOT NULL,          -- JSON {from, to} of Yjs relative positions
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Routes (all under `/api/docs/:id/threads`, gated by `accessLevel` — viewers read, editors+owner write):
- `GET /` — threads with nested comments + author name/email, ordered by created_at
- `POST /` — `{anchor, body}` → creates thread + first comment (editor+)
- `POST /:threadId/comments` — `{body}` reply (editor+)
- `POST /:threadId/status` — `{status: open|resolved}` (editor+)
- `DELETE /:threadId/comments/:commentId` — author-only; deleting the last comment deletes the thread

Notifications via `sendEmail`: on new thread → doc owner (unless author); on reply → owner + thread participants minus author.

- [ ] Write comments.ts with schema + routes
- [ ] Mount in index.ts: `app.route("/api/docs", comments)`
- [ ] Verify with curl-style node script: thread create → reply → resolve → list shows statuses; viewer 403 on write; email logged

### Task 2: Desktop — comments client + anchor plumbing

**Files:**
- Create: `src/lib/comments.ts` (API client + anchor helpers)
- Modify: `src/lib/auth-client.ts` (nothing — reuse `api` via new module importing it? No: comments client lives in `src/lib/comments.ts` using fetch + getAuthToken/getServerURL)

Anchor helpers (used inside RichView where editor + ydoc exist):
```ts
import { ySyncPluginKey, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from "y-prosemirror";
// selection → anchor
const ystate = ySyncPluginKey.getState(editor.state);
const rel = absolutePositionToRelativePosition(pos, ystate.type, ystate.binding.mapping);
// anchor → absolute (null when content deleted)
const abs = relativePositionToAbsolutePosition(ydoc, ystate.type, Y.createRelativePositionFromJSON(json), ystate.binding.mapping);
```

- [ ] comments client: listThreads, createThread, reply, setStatus, deleteComment
- [ ] anchor encode/decode helpers exported from a RichView-adjacent module

### Task 3: Desktop — gutter + thread panel UI

**Files:**
- Create: `src/components/comments.tsx` (gutter bubbles + thread panel + composer)
- Modify: `src/components/rich-view.tsx` (selection bubble "💬 Comment", gutter overlay, decoration highlight of active thread range)
- Modify: `src/app/page.tsx` (threads state, polling, pass-through)

UX:
- Selecting text in a live doc shows a floating "Comment" button near the selection end; clicking opens a composer anchored in the right margin
- Right margin shows one bubble per open thread at its anchor's vertical offset; click expands to the thread panel (replies, resolve button, timestamps, author initials avatar)
- Resolved threads hidden behind a "N resolved" toggle at the top of the gutter
- Comment count in Library rows for synced docs (server returns counts on doc list — defer if heavy; v1: count shown inside the doc only)

- [ ] Selection-driven Comment affordance in RichView (live mode only)
- [ ] Gutter overlay with bubbles positioned via relativePositionToAbsolutePosition + editor.view.coordsAtPos
- [ ] Thread panel: replies, resolve/reopen, delete own comment
- [ ] 15s polling + refresh after each mutation
- [ ] Lint + build clean

### Task 4: Verify + ship

- [ ] Pack app; Alice creates a thread on a selection via CDP; Bob replies via API; Alice's gutter shows the reply after poll
- [ ] Resolve via CDP → gutter bubble moves to resolved; reopen works
- [ ] Notification email visible in dev server console
- [ ] Anchor survives concurrent edit: Bob inserts a paragraph above the anchor; bubble stays on the right text
- [ ] Roadmap update, PR #6, merge (standing approval)
