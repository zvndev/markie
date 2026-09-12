import { Hono } from "hono";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import {
  accessLevel,
  canEditLevel,
  canReadLevel,
  sharedDocsFor,
  docsSharedByMe,
  removeDocShares,
} from "./shares.ts";
import { claimPendingInvites, removeDocPending } from "./pending.ts";
import { closeRoom, purgeDocUpdates } from "./collab.ts";
import { purgeDocThreads } from "./comments.ts";
import { revokePublicLink } from "./public-links.ts";
import { unlinkDocAssets } from "./assets.ts";

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_docs_owner ON docs(owner_id);
  CREATE TABLE IF NOT EXISTS doc_history (
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, version)
  );
`);

interface DocRow {
  id: string;
  owner_id: string;
  name: string;
  version: number;
  content: string;
  hash: string;
  updated_at: string;
  deleted_at: string | null;
}

async function requireUser(c: { req: { raw: Request } }) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

export const docs = new Hono();

// List the caller's docs (metadata only)
docs.get("/", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  // Sweep any invites addressed to this email, but only once the caller has
  // PROVEN the address. Without the emailVerified check this route was a
  // takeover path in its own right: register someone else's address, list your
  // documents, and every invite waiting for them became yours.
  try {
    if (user.email && user.emailVerified) {
      claimPendingInvites(user.email, user.id);
    }
  } catch (err) {
    console.error("claim-on-list failed:", err);
  }
  const rows = db
    .prepare(
      "SELECT id, name, version, hash, updated_at FROM docs WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC"
    )
    .all(user.id) as Omit<DocRow, "owner_id" | "content" | "deleted_at">[];
  const shared = sharedDocsFor(user.id).map((d) => ({ ...d, shared: true }));
  return c.json({ docs: [...rows, ...shared] });
});

// Owned docs I've shared with people — the "shared by me" tab. Registered
// before "/:id" so the literal path wins over the param route.
docs.get("/shared-by-me", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = docsSharedByMe(user.id).map((d) => ({
    id: d.id,
    name: d.name,
    updated_at: d.updated_at,
    memberCount: d.member_count,
    pendingCount: d.pending_count,
  }));
  return c.json({ docs: rows });
});

// Fetch one doc with content
docs.get("/:id", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!canReadLevel(accessLevel(docId, user.id))) return c.json({ error: "not found" }, 404);
  const row = db
    .prepare(
      "SELECT id, name, version, content, hash, updated_at FROM docs WHERE id = ? AND deleted_at IS NULL"
    )
    .get(docId) as DocRow | undefined;
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ doc: row });
});

// Upsert a snapshot. baseVersion must match the server version (or 0 for create).
docs.put("/:id", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const body = (await c.req.json()) as {
    name: string;
    content: string;
    hash: string;
    baseVersion: number;
  };
  if (typeof body?.content !== "string" || !body?.name) {
    return c.json({ error: "bad request" }, 400);
  }
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT version, owner_id, deleted_at FROM docs WHERE id = ?")
    .get(id) as Pick<DocRow, "version" | "owner_id" | "deleted_at"> | undefined;

  if (existing && existing.owner_id !== user.id) {
    // editors on a shared doc may push snapshots; viewers may not
    if (!canEditLevel(accessLevel(id, user.id))) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  if (existing && !existing.deleted_at && existing.version !== body.baseVersion) {
    return c.json({ error: "conflict", serverVersion: existing.version }, 409);
  }

  const version = existing && !existing.deleted_at ? existing.version + 1 : 1;
  db.prepare(
    `INSERT INTO docs (id, owner_id, name, version, content, hash, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, version = excluded.version,
       content = excluded.content, hash = excluded.hash,
       updated_at = excluded.updated_at, deleted_at = NULL`
  ).run(id, user.id, body.name, version, body.content, body.hash, now);
  db.prepare(
    "INSERT OR REPLACE INTO doc_history (doc_id, version, content, hash, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, version, body.content, body.hash, now);

  return c.json({ id, version, updated_at: now });
});

// Delete the cloud copy. The row stays as a tombstone, so a client that still
// knows the id gets the same 404 either way and the owner's next push starts
// over at version 1. Everything readable goes now: the text, its hash, every
// version in the history, and every share, invite, link, thread and collab
// update that pointed at it. Nothing waits for a sweep that might never run.
docs.delete("/:id", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  const tombstone = db.transaction((): number => {
    const changes = db
      .prepare(
        "UPDATE docs SET deleted_at = ?, content = '', hash = '' WHERE id = ? AND owner_id = ? AND deleted_at IS NULL"
      )
      .run(new Date().toISOString(), docId, user.id).changes;
    if (changes > 0) db.prepare("DELETE FROM doc_history WHERE doc_id = ?").run(docId);
    return changes;
  });
  if (tombstone() === 0) return c.json({ error: "not found" }, 404);
  // The delete revokes access for every member at once, so nobody keeps a live
  // socket on the room. Closed before the update log is purged, so a socket
  // mid-write cannot put a fragment of the text back.
  closeRoom(docId);
  purgeDocUpdates(docId);
  removeDocShares(docId);
  removeDocPending(docId);
  revokePublicLink(docId);
  purgeDocThreads(docId);
  await unlinkDocAssets(docId);
  return c.json({ ok: true });
});
