// Public share links: an unguessable, revocable token per doc that grants
// account-free read + download via GET /s/:token. Own table so it can be
// revoked independently of membership. Mirrors pending.ts (own db handle).
//
// A Live Doc (a document whose format is darkmown, a .wd) is never public.
// Creating its link is refused here, the database refuses the row even if
// some other path tried (guardLiveDocsPrivate below), and a document that
// becomes a Live Doc loses its link in the same statement that changes its
// format. Ordinary documents keep their public links exactly as before.
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

/** The answer every route gives when asked to make a Live Doc public. */
export const LIVE_DOC_PRIVATE = {
  error: "live-doc-private",
  message: "Live Docs can't be public. Share it with people instead.",
} as const;

/**
 * Whether `docId` is a Live Doc, deleted or not. Reads the docs table, which
 * docs.ts owns; every server that serves public links loads it.
 */
export function isLiveDocFormat(docId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM docs WHERE id = ? AND format = 'darkmown'")
    .get(docId);
}

// Create the link once; subsequent calls return the same token (stable URL).
// null for a Live Doc, which can never have one.
export function createOrGetPublicLink(docId: string, userId: string): string | null {
  if (isLiveDocFormat(docId)) return null;
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

/**
 * Makes "a Live Doc is never public" a property of the database, not only of
 * the routes, and clears out any link made before the rule. Called by docs.ts
 * once the docs table and its format column exist, on the caller's handle.
 *
 *   public_links_never_live_doc   refuses a new link row for a darkmown doc
 *   docs_live_doc_drops_link_*    a document that becomes darkmown, by rename,
 *                                 sync, upload or agent write, loses its link
 *                                 in the same statement, so the same
 *                                 transaction
 *
 * Then deletes every link a darkmown document still holds. Idempotent: after
 * the first run it finds none. Returns how many it removed.
 */
export function guardLiveDocsPrivate(handle: Database.Database): number {
  handle.exec(`
    CREATE TRIGGER IF NOT EXISTS public_links_never_live_doc
    BEFORE INSERT ON public_links
    WHEN EXISTS (SELECT 1 FROM docs WHERE id = NEW.doc_id AND format = 'darkmown')
    BEGIN SELECT RAISE(ABORT, 'live-doc-private'); END;

    CREATE TRIGGER IF NOT EXISTS docs_live_doc_drops_link_on_update
    AFTER UPDATE OF format ON docs
    WHEN NEW.format = 'darkmown'
    BEGIN DELETE FROM public_links WHERE doc_id = NEW.id; END;

    CREATE TRIGGER IF NOT EXISTS docs_live_doc_drops_link_on_insert
    AFTER INSERT ON docs
    WHEN NEW.format = 'darkmown'
    BEGIN DELETE FROM public_links WHERE doc_id = NEW.id; END;
  `);
  return handle
    .prepare("DELETE FROM public_links WHERE doc_id IN (SELECT id FROM docs WHERE format = 'darkmown')")
    .run().changes;
}
