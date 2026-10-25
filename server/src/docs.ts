import { Hono } from "hono";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import {
  accessLevel,
  canEditLevel,
  canReadLevel,
  sharedDocsFor,
  docsSharedByMe,
  sharedOutDocIds,
  removeDocShares,
} from "./shares.ts";
import { claimPendingInvites, removeDocPending } from "./pending.ts";
import { closeRoom, purgeDocUpdates } from "./collab.ts";
import { purgeDocThreads } from "./comments.ts";
import { revokePublicLink } from "./public-links.ts";
import { serveAsset, unlinkDocAssets } from "./assets.ts";
import { removeDocLinks } from "./doc-links.ts";
import { CloudAreaError, createCloudAreas, type CloudAreasStore } from "./cloud-areas.ts";
import { quotaRefusal, storageQuotaBytes } from "./quota.ts";
import {
  FORMAT_FROM_NAME_SQL,
  formatForName,
  originOf,
  privateLinkFor,
  requestedOrigin,
  type DocOrigin,
} from "./doc-meta.ts";

const db = openDatabase();
let cloudAreas: CloudAreasStore | undefined;
/** Explicit rollout seam; default legacy behavior/schema remain unchanged. */
export function configureDocsCloudAreas(enabled: boolean): CloudAreasStore | undefined {
  cloudAreas = enabled ? cloudAreas ?? createCloudAreas(db) : undefined;
  return cloudAreas;
}
const placement = (userId: string, id: string) => cloudAreas ? { areaId: cloudAreas.ensurePlacement(userId, "markdown", id).areaId } : {};

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

// What a document is and where it came from (docs/mobile/AGENT-LINKS-CONTRACT.md).
// Added in place, checked through PRAGMA like every other column this server
// grew. Each backfill runs only in the branch that adds its column, so a
// restart never rewrites a value a later write chose.
//
//   format        markdown | darkmown | text, from the name's extension
//   origin_kind   app | agent, set on a document's first version only
//   origin_agent  the agent's display name; NULL for app
//   created_at    when the first version landed; updated_at for older rows
{
  const columns = new Set((db.prepare("PRAGMA table_info(docs)").all() as { name: string }[]).map((c) => c.name));
  if (!columns.has("format")) {
    db.transaction(() => {
      db.exec("ALTER TABLE docs ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'");
      db.exec(`UPDATE docs SET format = ${FORMAT_FROM_NAME_SQL}`);
    })();
  }
  if (!columns.has("origin_kind")) db.exec("ALTER TABLE docs ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'app'");
  if (!columns.has("origin_agent")) db.exec("ALTER TABLE docs ADD COLUMN origin_agent TEXT");
  if (!columns.has("created_at")) {
    db.transaction(() => {
      db.exec("ALTER TABLE docs ADD COLUMN created_at TEXT");
      db.exec("UPDATE docs SET created_at = updated_at WHERE created_at IS NULL");
    })();
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_docs_owner_updated ON docs(owner_id, updated_at)");
}

// How many snapshots of one document the server keeps, newest first, the
// current one included. Every push of a document used to add a full copy of
// its text and nothing ever removed one, so a document edited daily grew the
// database (and every Litestream snapshot of it) without limit, at up to the
// ~100 MB a single push may carry. Nothing on the server reads these rows yet:
// the desktop's history panel is local (electron/history.js). They exist for
// a future server-side restore, which needs recent versions, not all of them.
export const DOC_HISTORY_KEEP = 20;

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

interface DocWrite {
  id: string;
  ownerId: string;
  name: string;
  content: string;
  hash: string;
  version: number;
  now: string;
  /**
   * Set only when this write creates the document: its first version, or a
   * deleted document's id coming back at version 1. A document's origin and
   * created_at are decided here and never touched again.
   */
  origin?: DocOrigin;
}

// One version of a document, its history row and the history trim. Callers
// run it inside their own transaction, after every check has passed.
function upsertDocRow(w: DocWrite): void {
  const format = formatForName(w.name);
  if (w.origin) {
    // The conflict branch only revives a tombstone. A live row under this id
    // means the caller's "this creates it" was wrong, and the write stops
    // rather than handing that document a new origin.
    const changes = db.prepare(
      `INSERT INTO docs (id, owner_id, name, version, content, hash, updated_at, deleted_at, format, origin_kind, origin_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, version = excluded.version,
         content = excluded.content, hash = excluded.hash,
         updated_at = excluded.updated_at, deleted_at = NULL, format = excluded.format,
         origin_kind = excluded.origin_kind, origin_agent = excluded.origin_agent,
         created_at = excluded.created_at
       WHERE docs.deleted_at IS NOT NULL`
    ).run(w.id, w.ownerId, w.name, w.version, w.content, w.hash, w.now, format, w.origin.kind, w.origin.agent, w.now).changes;
    if (changes !== 1) throw new Error("document already exists");
  } else {
    const changes = db.prepare(
      "UPDATE docs SET name = ?, version = ?, content = ?, hash = ?, updated_at = ?, format = ? WHERE id = ? AND deleted_at IS NULL"
    ).run(w.name, w.version, w.content, w.hash, w.now, format, w.id).changes;
    if (changes !== 1) throw new Error("document is gone");
  }
  db.prepare(
    "INSERT OR REPLACE INTO doc_history (doc_id, version, content, hash, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(w.id, w.version, w.content, w.hash, w.now);
  // Versions climb by one per push and restart only after a delete, which
  // empties the history, so "older than the newest N" is a range on the
  // primary key.
  db.prepare("DELETE FROM doc_history WHERE doc_id = ? AND version <= ?").run(w.id, w.version - DOC_HISTORY_KEEP);
}

/**
 * Write one version of a document owned by `ownerId`, for callers that have
 * already authorised, version-checked and quota-checked it (agent-docs.ts).
 * The document lands in its owner's default cloud area when areas are on.
 */
export function writeDocVersion(w: DocWrite): void {
  db.transaction(() => {
    upsertDocRow(w);
    if (cloudAreas) cloudAreas.ensurePlacement(w.ownerId, "markdown", w.id);
  })();
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
  // Whether anybody else can reach each owned document. Markie reads this to
  // decide what a document's references may pull off the machine it is on:
  // once a second party can read the document, a reference in its text is no
  // longer certainly the owner's own words, so only files beside the document
  // travel. See sharedOutDocIds.
  const out = sharedOutDocIds(user.id);
  const owned = rows.map((d) => ({ ...d, sharedOut: out.has(d.id), ...placement(user.id, d.id) }));
  const shared = sharedDocsFor(user.id).map((d) => ({ ...d, shared: true, ...placement(user.id, d.id) }));
  return c.json({ docs: [...owned, ...shared] });
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
    ...placement(user.id, d.id),
  }));
  return c.json({ docs: rows });
});

// The mobile home screen: owned and shared markdown documents, newest first,
// one page at a time. `before` is the updatedAt of the last item already
// shown. Office documents (dp_documents) are not in this list yet.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const RECENT_DEFAULT_LIMIT = 50;
export const RECENT_MAX_LIMIT = 100;

interface RecentRow {
  id: string;
  name: string;
  format: string;
  created_at: string | null;
  updated_at: string;
  origin_kind: string;
  origin_agent: string | null;
  role: string;
  shared_by: string | null;
}

docs.get("/recent", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? RECENT_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_MAX_LIMIT) {
    return c.json({ error: "bad request", message: `limit must be a whole number from 1 to ${RECENT_MAX_LIMIT}.` }, 400);
  }
  const before = c.req.query("before");
  if (before !== undefined && (!ISO_INSTANT.test(before) || Number.isNaN(Date.parse(before)))) {
    return c.json({ error: "bad request", message: "before must be an ISO 8601 UTC timestamp, such as an item's updatedAt." }, 400);
  }
  // The same sweep the full listing does, for the same reason: a phone is
  // somewhere a person signs in, and invites waiting for their proven
  // address are theirs from then on.
  try {
    if (user.email && user.emailVerified) claimPendingInvites(user.email, user.id);
  } catch (err) {
    console.error("claim-on-recent failed:", err);
  }
  // updated_at is always written by toISOString(), so text order is time order.
  const cursor = before ? new Date(before).toISOString() : null;
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT d.id, d.name, d.format, d.created_at, d.updated_at, d.origin_kind, d.origin_agent,
                'owner' AS role, NULL AS shared_by
         FROM docs d
         WHERE d.owner_id = ? AND d.deleted_at IS NULL AND (? IS NULL OR d.updated_at < ?)
         UNION ALL
         SELECT d.id, d.name, d.format, d.created_at, d.updated_at, d.origin_kind, d.origin_agent,
                s.role AS role, COALESCE(NULLIF(inviter.name, ''), inviter.email) AS shared_by
         FROM shares s
         JOIN docs d ON d.id = s.doc_id
         LEFT JOIN user inviter ON inviter.id = s.invited_by
         WHERE s.user_id = ? AND d.owner_id <> ? AND d.deleted_at IS NULL AND (? IS NULL OR d.updated_at < ?)
       ) ORDER BY updated_at DESC, id ASC LIMIT ?`
    )
    .all(user.id, cursor, cursor, user.id, user.id, cursor, cursor, limit) as RecentRow[];
  return c.json({
    docs: rows.map((r) => ({
      id: r.id,
      name: r.name,
      format: r.format,
      createdAt: r.created_at ?? r.updated_at,
      updatedAt: r.updated_at,
      origin: originOf(r),
      shared: r.role !== "owner",
      role: r.role,
      sharedBy: r.role === "owner" ? null : r.shared_by,
      privateLink: privateLinkFor(r.id),
    })),
  });
});

// Fetch one doc with content
docs.get("/:id", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!canReadLevel(accessLevel(docId, user.id))) return c.json({ error: "not found" }, 404);
  const row = db
    .prepare(
      "SELECT id, name, version, content, hash, updated_at, format, origin_kind, origin_agent FROM docs WHERE id = ? AND deleted_at IS NULL"
    )
    .get(docId) as (DocRow & { format: string; origin_kind: string; origin_agent: string | null }) | undefined;
  if (!row) return c.json({ error: "not found" }, 404);
  const { origin_kind, origin_agent, ...doc } = row;
  return c.json({ doc: { ...doc, origin: originOf({ origin_kind, origin_agent }), ...placement(user.id, docId) } });
});

// One asset from a document the caller can read. Same read gate as the
// document itself; the ref is just a query string, not a claim about what
// exists, so an unknown ref falls through to serveAsset's own 404.
docs.get("/:id/assets/file", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  if (!canReadLevel(accessLevel(id, user.id))) return c.text("Not found", 404);
  const ref = c.req.query("ref") ?? "";
  return serveAsset(c, id, ref);
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
    areaId?: string;
    origin?: unknown;
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

  const creating = !existing || !!existing.deleted_at;
  const version = creating || !existing ? 1 : existing.version + 1;
  // Counted against the document's owner, whoever is pushing: an editor's
  // save lands in the owner's storage. Only growth is refused.
  if (storageQuotaBytes() !== null) {
    const previous = existing && !existing.deleted_at
      ? (db.prepare("SELECT length(CAST(content AS BLOB)) AS bytes FROM docs WHERE id = ?").get(id) as { bytes: number }).bytes
      : 0;
    const refusal = quotaRefusal(db, existing?.owner_id ?? user.id, Buffer.byteLength(body.content, "utf8") - previous);
    if (refusal) return c.json(refusal, 413);
  }
  try {
    db.transaction(() => {
      let destination: string | undefined;
      if (cloudAreas) {
        if (body.areaId !== undefined) {
          destination = cloudAreas.ownArea(user.id, body.areaId).id;
          if (existing && cloudAreas.ensurePlacement(user.id, "markdown", id).areaId !== destination) throw new CloudAreaError("placement-required", 409, "Move this document through the explicit placement endpoint before saving.");
        } else destination = cloudAreas.ensurePlacement(user.id, "markdown", id).areaId;
      }
      upsertDocRow({
        id,
        ownerId: user.id,
        name: body.name,
        content: body.content,
        hash: body.hash,
        version,
        now,
        // `origin` is read only when this push creates the document. Every
        // later version keeps the origin the first one set, so an app
        // document can never be turned into one an agent token may open.
        ...(creating ? { origin: requestedOrigin(body.origin) } : {}),
      });
      if (cloudAreas && destination) cloudAreas.setPlacement(user.id, "markdown", id, destination);
    })();
  } catch (error) {
    if (error instanceof CloudAreaError) return c.json({ error: error.code, message: error.message }, error.status);
    return c.json({ error: "storage-error" }, 503);
  }

  return c.json({ id, version, updated_at: now, ...placement(user.id, id) });
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
  removeDocLinks(docId);
  await unlinkDocAssets(docId);
  return c.json({ ok: true });
});
