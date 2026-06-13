// Pending invites: shares addressed to an email that has no Markie account yet.
// When that email becomes a user (signup hook) or next lists their docs (read
// sweep), the pending rows are "claimed" into real `shares` rows — so the doc
// shows up in their Library and they join live collab.
import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_shares (
    doc_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
    invited_by TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_shares(email);
`);

const norm = (email: string) => email.toLowerCase().trim();

export function addPending(
  docId: string,
  email: string,
  role: "viewer" | "editor",
  invitedBy: string
): string {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  db.prepare(
    `INSERT INTO pending_shares (doc_id, email, role, invited_by, token, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id, email) DO UPDATE SET role = excluded.role`
  ).run(docId, norm(email), role, invitedBy, token, new Date().toISOString());
  return token;
}

export function listPendingForDoc(docId: string) {
  return db
    .prepare(
      `SELECT email, role, created_at FROM pending_shares WHERE doc_id = ?`
    )
    .all(docId) as Array<{ email: string; role: string; created_at: string }>;
}

export function removePending(docId: string, email: string): boolean {
  const res = db
    .prepare("DELETE FROM pending_shares WHERE doc_id = ? AND email = ?")
    .run(docId, norm(email));
  return res.changes > 0;
}

// Convert every pending invite for this email into a real member share.
// Idempotent; safe to call on every signup and on every shared-docs listing.
export function claimPendingInvites(email: string, userId: string): number {
  const e = norm(email);
  const pending = db
    .prepare(
      "SELECT doc_id, role, invited_by FROM pending_shares WHERE email = ?"
    )
    .all(e) as Array<{ doc_id: string; role: string; invited_by: string }>;
  if (pending.length === 0) return 0;

  const claim = db.transaction(() => {
    const now = new Date().toISOString();
    for (const p of pending) {
      // skip invites to a doc the user already owns
      const owns = db
        .prepare("SELECT 1 FROM docs WHERE id = ? AND owner_id = ?")
        .get(p.doc_id, userId);
      if (!owns) {
        db.prepare(
          `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(doc_id, user_id) DO UPDATE SET role = excluded.role`
        ).run(p.doc_id, userId, p.role, p.invited_by, now);
      }
      db.prepare(
        "DELETE FROM pending_shares WHERE doc_id = ? AND email = ?"
      ).run(p.doc_id, e);
    }
  });
  claim();
  return pending.length;
}
