// Comment threads on shared docs. Anchors are Yjs relative positions
// (serialized JSON) so they survive concurrent edits; the server treats
// them as opaque. Anyone with access can read and comment; resolving a
// thread and deleting somebody else's comment stay with editors and the owner.
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { auth } from "./auth.ts";
import {
  accessLevel,
  canCommentLevel,
  canEditLevel,
  canReadLevel,
  isOwner,
} from "./shares.ts";
import { sendEmail } from "./email.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    anchor TEXT NOT NULL,
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
  CREATE INDEX IF NOT EXISTS idx_threads_doc ON threads (doc_id);
  CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments (thread_id);
`);

async function requireUser(c: { req: { raw: Request } }) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Writing a comment only needs access to the doc; viewers may comment.
function canComment(docId: string, userId: string): boolean {
  return canCommentLevel(accessLevel(docId, userId));
}

// Changing a thread's status is an editing act and stays with editors.
function canWrite(docId: string, userId: string): boolean {
  return canEditLevel(accessLevel(docId, userId));
}

interface ThreadRow {
  id: string;
  doc_id: string;
  anchor: string;
  status: "open" | "resolved";
  created_by: string;
  created_at: string;
}

function docOwner(docId: string): { id: string; email: string } | null {
  const row = db
    .prepare(
      `SELECT u.id, u.email FROM docs d JOIN user u ON u.id = d.owner_id
       WHERE d.id = ?`
    )
    .get(docId) as { id: string; email: string } | undefined;
  return row ?? null;
}

function threadParticipants(threadId: string): Array<{ id: string; email: string }> {
  return db
    .prepare(
      `SELECT DISTINCT u.id, u.email FROM comments c JOIN user u ON u.id = c.author_id
       WHERE c.thread_id = ?`
    )
    .all(threadId) as Array<{ id: string; email: string }>;
}

function docName(docId: string): string {
  const row = db.prepare("SELECT name FROM docs WHERE id = ?").get(docId) as
    | { name: string }
    | undefined;
  return row?.name ?? "a doc";
}

// New comment → notify the owner + everyone in the thread, minus the author.
// Fire-and-forget: notification failures never fail the API call.
function notify(
  docId: string,
  threadId: string,
  author: { id: string; name: string; email: string },
  body: string
): void {
  const recipients = new Map<string, string>();
  const owner = docOwner(docId);
  if (owner) recipients.set(owner.id, owner.email);
  for (const p of threadParticipants(threadId)) recipients.set(p.id, p.email);
  recipients.delete(author.id);
  const name = docName(docId);
  const from = author.name || author.email;
  for (const email of recipients.values()) {
    void sendEmail({
      to: email,
      subject: `${from} commented on "${name}"`,
      text: `${from} wrote:\n\n${body}\n\nOpen "${name}" in Markie to reply.`,
    }).catch(() => {});
  }
}

export const comments = new Hono();

// List threads with nested comments
comments.get("/:id/threads", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!canReadLevel(accessLevel(docId, user.id))) return c.json({ error: "forbidden" }, 403);
  const threads = db
    .prepare("SELECT * FROM threads WHERE doc_id = ? ORDER BY created_at")
    .all(docId) as ThreadRow[];
  const commentsByThread = db.prepare(
    `SELECT c.*, u.name AS author_name, u.email AS author_email
     FROM comments c JOIN user u ON u.id = c.author_id
     WHERE c.thread_id = ? ORDER BY c.created_at`
  );
  return c.json({
    threads: threads.map((t) => ({
      ...t,
      anchor: JSON.parse(t.anchor),
      comments: commentsByThread.all(t.id),
    })),
  });
});

// Create a thread with its first comment
comments.post("/:id/threads", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!canComment(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const { anchor, body } = (await c.req.json()) as {
    anchor: unknown;
    body: string;
  };
  if (!anchor || typeof body !== "string" || !body.trim()) {
    return c.json({ error: "bad request" }, 400);
  }
  const now = new Date().toISOString();
  const threadId = randomUUID();
  const commentId = randomUUID();
  db.prepare(
    "INSERT INTO threads (id, doc_id, anchor, status, created_by, created_at) VALUES (?, ?, ?, 'open', ?, ?)"
  ).run(threadId, docId, JSON.stringify(anchor), user.id, now);
  db.prepare(
    "INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(commentId, threadId, user.id, body.trim(), now);
  notify(docId, threadId, user, body.trim());
  return c.json({ id: threadId, commentId });
});

// Reply to a thread
comments.post("/:id/threads/:threadId/comments", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  const threadId = c.req.param("threadId");
  if (!canComment(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const thread = db
    .prepare("SELECT id FROM threads WHERE id = ? AND doc_id = ?")
    .get(threadId, docId);
  if (!thread) return c.json({ error: "not found" }, 404);
  const { body } = (await c.req.json()) as { body: string };
  if (typeof body !== "string" || !body.trim()) {
    return c.json({ error: "bad request" }, 400);
  }
  // Capture participants before inserting so the author's own new comment
  // doesn't suppress notifications to earlier participants
  notify(docId, threadId, user, body.trim());
  const commentId = randomUUID();
  db.prepare(
    "INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(commentId, threadId, user.id, body.trim(), new Date().toISOString());
  return c.json({ id: commentId });
});

// Resolve / reopen
comments.post("/:id/threads/:threadId/status", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!canWrite(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const { status } = (await c.req.json()) as { status: string };
  if (status !== "open" && status !== "resolved") {
    return c.json({ error: "bad request" }, 400);
  }
  const res = db
    .prepare("UPDATE threads SET status = ? WHERE id = ? AND doc_id = ?")
    .run(status, c.req.param("threadId"), docId);
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// Delete own comment; the doc owner can delete any. Last comment out
// deletes the thread.
comments.delete("/:id/threads/:threadId/comments/:commentId", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  const threadId = c.req.param("threadId");
  const commentId = c.req.param("commentId");
  const comment = db
    .prepare(
      `SELECT c.author_id FROM comments c JOIN threads t ON t.id = c.thread_id
       WHERE c.id = ? AND c.thread_id = ? AND t.doc_id = ?`
    )
    .get(commentId, threadId, docId) as { author_id: string } | undefined;
  if (!comment) return c.json({ error: "not found" }, 404);
  if (comment.author_id !== user.id && !isOwner(docId, user.id)) {
    return c.json({ error: "forbidden" }, 403);
  }
  db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
  const left = (
    db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?")
      .get(threadId) as { n: number }
  ).n;
  if (left === 0) {
    db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  }
  return c.json({ ok: true, threadDeleted: left === 0 });
});
