import { Hono } from "hono";
import Database from "better-sqlite3";
import { auth } from "./auth.ts";
import { sendEmail } from "./email.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    doc_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
    invited_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, user_id)
  );
`);

async function requireUser(c: { req: { raw: Request } }) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

export function getShare(docId: string, userId: string) {
  return db
    .prepare("SELECT role FROM shares WHERE doc_id = ? AND user_id = ?")
    .get(docId, userId) as { role: "viewer" | "editor" } | undefined;
}

export function isOwner(docId: string, userId: string): boolean {
  const row = db
    .prepare("SELECT owner_id FROM docs WHERE id = ? AND deleted_at IS NULL")
    .get(docId) as { owner_id: string } | undefined;
  return row?.owner_id === userId;
}

// owner > editor > viewer > null
export function accessLevel(
  docId: string,
  userId: string
): "owner" | "editor" | "viewer" | null {
  if (isOwner(docId, userId)) return "owner";
  return getShare(docId, userId)?.role ?? null;
}

export function sharedDocsFor(userId: string) {
  return db
    .prepare(
      `SELECT d.id, d.name, d.version, d.hash, d.updated_at, s.role
       FROM shares s JOIN docs d ON d.id = s.doc_id
       WHERE s.user_id = ? AND d.deleted_at IS NULL
       ORDER BY d.updated_at DESC`
    )
    .all(userId) as Array<{
    id: string;
    name: string;
    version: number;
    hash: string;
    updated_at: string;
    role: string;
  }>;
}

export const shares = new Hono();

// List members (owner or member can see)
shares.get("/:id/shares", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!accessLevel(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const rows = db
    .prepare(
      `SELECT s.user_id, s.role, s.created_at, u.email, u.name
       FROM shares s JOIN user u ON u.id = s.user_id
       WHERE s.doc_id = ?`
    )
    .all(docId);
  return c.json({ shares: rows });
});

// Add a member by email (owner only)
shares.post("/:id/shares", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const { email, role } = (await c.req.json()) as {
    email: string;
    role: "viewer" | "editor";
  };
  if (!email || !["viewer", "editor"].includes(role)) {
    return c.json({ error: "bad request" }, 400);
  }
  const recipient = db
    .prepare("SELECT id, email, name FROM user WHERE email = ?")
    .get(email.toLowerCase().trim()) as
    | { id: string; email: string; name: string }
    | undefined;
  if (!recipient) {
    return c.json(
      { error: "No Markie account with that email yet" },
      404
    );
  }
  if (recipient.id === user.id) {
    return c.json({ error: "That's you" }, 400);
  }
  const doc = db
    .prepare("SELECT name FROM docs WHERE id = ?")
    .get(docId) as { name: string };
  db.prepare(
    `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(doc_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(docId, recipient.id, role, user.id, new Date().toISOString());

  await sendEmail({
    to: recipient.email,
    subject: `${user.name || user.email} shared "${doc.name}" with you on Markie`,
    text: `${user.name || user.email} added you to "${doc.name}" as ${
      role === "editor" ? "an editor" : "a viewer"
    }.\n\nOpen Markie and press Cmd+L — it's in your Library.`,
  });

  return c.json({ ok: true, userId: recipient.id, role });
});

// Remove a member (owner only)
shares.delete("/:id/shares/:userId", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const res = db
    .prepare("DELETE FROM shares WHERE doc_id = ? AND user_id = ?")
    .run(docId, c.req.param("userId"));
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
