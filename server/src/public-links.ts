// Public share links: an unguessable, revocable token per doc that grants
// account-free read + download via GET /s/:token. Own table so it can be
// revoked independently of membership. Mirrors pending.ts (own db handle).
import type Database from "better-sqlite3";
import { openDatabase } from "./db.ts";

const db = openDatabase();

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

// A new token for a link that already exists, so every copy of the old URL
// stops working at once while the document stays public. Removing somebody is
// the reason: they may have kept the old URL, and the link alone lets them in.
// Never creates a link. Takes the caller's handle because each module holds
// its own connection, and a write through this module's handle would wait on
// the caller's open transaction instead of joining it.
export function rotatePublicLink(
  docId: string,
  handle: Database.Database = db
): string | null {
  const token = newToken();
  const changed = handle
    .prepare("UPDATE public_links SET token = ? WHERE doc_id = ?")
    .run(token, docId).changes;
  return changed > 0 ? token : null;
}

export function revokePublicLink(docId: string): boolean {
  return (
    db.prepare("DELETE FROM public_links WHERE doc_id = ?").run(docId).changes >
    0
  );
}
