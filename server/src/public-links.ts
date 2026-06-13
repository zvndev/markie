// Public share links: an unguessable, revocable token per doc that grants
// account-free read + download via GET /s/:token. Own table so it can be
// revoked independently of membership. Mirrors pending.ts (own db handle).
import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS public_links (
    doc_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_public_token ON public_links(token);
`);

const newToken = () =>
  `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

// Create the link once; subsequent calls return the same token (stable URL).
export function createOrGetPublicLink(docId: string, userId: string): string {
  const existing = db
    .prepare("SELECT token FROM public_links WHERE doc_id = ?")
    .get(docId) as { token: string } | undefined;
  if (existing) return existing.token;
  const token = newToken();
  db.prepare(
    `INSERT INTO public_links (doc_id, token, created_by, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(docId, token, userId, new Date().toISOString());
  return token;
}

export function getPublicLinkToken(docId: string): string | null {
  const row = db
    .prepare("SELECT token FROM public_links WHERE doc_id = ?")
    .get(docId) as { token: string } | undefined;
  return row?.token ?? null;
}

export function resolvePublicToken(token: string): { doc_id: string } | null {
  const row = db
    .prepare("SELECT doc_id FROM public_links WHERE token = ?")
    .get(token) as { doc_id: string } | undefined;
  return row ?? null;
}

export function revokePublicLink(docId: string): boolean {
  return (
    db.prepare("DELETE FROM public_links WHERE doc_id = ?").run(docId).changes >
    0
  );
}
