import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { PlatformSqliteDatabase } from "./document-platform-store.ts";
import { reportRouteFault } from "./little-friend.ts";

export type CloudDocumentKind = "markdown" | "snapshot";
export interface CloudArea { id: string; label: string; identityId?: string }
export interface CloudPlacement { kind: CloudDocumentKind; documentId: string; areaId: string }
export class CloudAreaError extends Error {
  readonly code: string; readonly status: 400 | 401 | 404 | 409 | 413 | 503;
  constructor(code: string, status: CloudAreaError["status"], message: string) { super(message); this.code = code; this.status = status; }
}
function fail(code: string, status: CloudAreaError["status"], message: string): never { throw new CloudAreaError(code, status, message); }
function reference(value: unknown): asserts value is string { if (typeof value !== "string" || !value || value.length > 128 || /[\x00-\x20\x7f]/.test(value)) fail("invalid-request", 400, "Invalid cloud area reference."); }
function label(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) fail("invalid-request", 400, "Area labels must contain 1–80 ordinary characters.");
  return value.trim();
}
function kind(value: unknown): asserts value is CloudDocumentKind { if (value !== "markdown" && value !== "snapshot") fail("invalid-request", 400, "Unknown cloud document kind."); }
interface AreaRow { id: string; label: string; identity_id: string | null }
const area = (row: AreaRow): CloudArea => ({ id: row.id, label: row.label, ...(row.identity_id ? { identityId: row.identity_id } : {}) });

export interface CloudAreasStore {
  readonly database: PlatformSqliteDatabase;
  ensureDefault(userId: string): CloudArea;
  ensureIdentityArea(userId: string, identityId: string, label: string): CloudArea;
  ownArea(userId: string, areaId: unknown): CloudArea;
  list(userId: string): CloudArea[];
  create(userId: string, label: unknown): CloudArea;
  rename(userId: string, areaId: string, label: unknown): CloudArea;
  getPlacement(userId: string, kind: CloudDocumentKind, documentId: string): CloudPlacement | undefined;
  setPlacement(userId: string, kind: CloudDocumentKind, documentId: string, areaId: unknown): CloudPlacement;
  ensurePlacement(userId: string, kind: CloudDocumentKind, documentId: string): CloudPlacement;
  listPlacements(userId: string): CloudPlacement[];
}

/** Organizational metadata only. No account/ownership/ACL mutation; no database open.
 * All methods are synchronous and can join a caller's existing transaction.
 * The identity callback is trusted only after its caller proves the identity.
 */
export function createCloudAreas(database: PlatformSqliteDatabase | Database.Database): CloudAreasStore {
  // Both installed SQLite implementations expose these positional statements;
  // retain the actual handle identity rather than wrapping across connections.
  const db = database as PlatformSqliteDatabase;
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_areas(id TEXT PRIMARY KEY,owner_uid TEXT NOT NULL,label TEXT NOT NULL,identity_id TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS cloud_areas_owner ON cloud_areas(owner_uid);
    CREATE UNIQUE INDEX IF NOT EXISTS cloud_areas_identity ON cloud_areas(owner_uid,identity_id) WHERE identity_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cloud_document_placements(user_uid TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('markdown','snapshot')),document_id TEXT NOT NULL,area_id TEXT NOT NULL,PRIMARY KEY(user_uid,kind,document_id));
  `);
  let sequence = 0;
  const mutate = <T>(operation: () => T): T => {
    const savepoint = `cloud_area_${++sequence}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try { const result = operation(); db.exec(`RELEASE ${savepoint}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); throw error; }
  };
  const ownArea = (userId: string, areaId: unknown): CloudArea => {
    reference(userId); reference(areaId);
    const row = db.prepare("SELECT id,label,identity_id FROM cloud_areas WHERE id = ? AND owner_uid = ?").get(areaId, userId) as AreaRow | undefined;
    if (!row) fail("not-found", 404, "Cloud area not found.");
    return area(row);
  };
  const count = (userId: string) => {
    const row = db.prepare("SELECT COUNT(*) AS count FROM cloud_areas WHERE owner_uid = ?").get(userId) as { count: number };
    if (row.count >= 100) fail("limit-exceeded", 413, "Account cloud area limit reached.");
  };
  const store: CloudAreasStore = {
    database: db,
    ownArea,
    ensureDefault(userId) {
      reference(userId);
      const id = `personal-${createHash("sha256").update(userId).digest("hex")}`;
      db.prepare("INSERT OR IGNORE INTO cloud_areas(id,owner_uid,label,identity_id,created_at) VALUES(?,?,?,NULL,?)").run(id, userId, "Personal", Date.now());
      return ownArea(userId, id);
    },
    ensureIdentityArea(userId, identityId, text) {
      return mutate(() => {
        reference(userId); reference(identityId);
        const existing = db.prepare("SELECT id,label,identity_id FROM cloud_areas WHERE owner_uid = ? AND identity_id = ?").get(userId, identityId) as AreaRow | undefined;
        if (existing) return area(existing);
        const name = label(typeof text === "string" ? text.slice(0, 80) : text), id = randomUUID();
        store.ensureDefault(userId);
        count(userId);
        db.prepare("INSERT OR IGNORE INTO cloud_areas(id,owner_uid,label,identity_id,created_at) VALUES(?,?,?,?,?)").run(id, userId, name, identityId, Date.now());
        return area(db.prepare("SELECT id,label,identity_id FROM cloud_areas WHERE owner_uid = ? AND identity_id = ?").get(userId, identityId) as AreaRow);
      });
    },
    list(userId) { reference(userId); store.ensureDefault(userId); return (db.prepare("SELECT id,label,identity_id FROM cloud_areas WHERE owner_uid = ? ORDER BY created_at,id").all(userId) as AreaRow[]).map(area); },
    create(userId, text) {
      return mutate(() => {
        reference(userId); const name = label(text); store.ensureDefault(userId); count(userId);
        const id = randomUUID(); db.prepare("INSERT INTO cloud_areas(id,owner_uid,label,identity_id,created_at) VALUES(?,?,?,NULL,?)").run(id, userId, name, Date.now());
        return ownArea(userId, id);
      });
    },
    rename(userId, areaId, text) { const current = ownArea(userId, areaId), name = label(text); db.prepare("UPDATE cloud_areas SET label = ? WHERE id = ? AND owner_uid = ?").run(name, areaId, userId); return { ...current, label: name }; },
    getPlacement(userId, documentKind, documentId) {
      reference(userId); kind(documentKind); reference(documentId);
      const row = db.prepare("SELECT p.kind,p.document_id,p.area_id FROM cloud_document_placements p JOIN cloud_areas a ON a.id = p.area_id AND a.owner_uid = p.user_uid WHERE p.user_uid = ? AND p.kind = ? AND p.document_id = ?").get(userId, documentKind, documentId) as { kind: CloudDocumentKind; document_id: string; area_id: string } | undefined;
      return row ? { kind: row.kind, documentId: row.document_id, areaId: row.area_id } : undefined;
    },
    setPlacement(userId, documentKind, documentId, areaId) {
      kind(documentKind); reference(documentId); const owned = ownArea(userId, areaId);
      db.prepare("INSERT INTO cloud_document_placements(user_uid,kind,document_id,area_id) VALUES(?,?,?,?) ON CONFLICT(user_uid,kind,document_id) DO UPDATE SET area_id = excluded.area_id").run(userId, documentKind, documentId, owned.id);
      return { kind: documentKind, documentId, areaId: owned.id };
    },
    ensurePlacement(userId, documentKind, documentId) { return store.getPlacement(userId, documentKind, documentId) ?? store.setPlacement(userId, documentKind, documentId, store.ensureDefault(userId).id); },
    listPlacements(userId) { reference(userId); return (db.prepare("SELECT p.kind,p.document_id,p.area_id FROM cloud_document_placements p JOIN cloud_areas a ON a.id = p.area_id AND a.owner_uid = p.user_uid WHERE p.user_uid = ? ORDER BY p.kind,p.document_id").all(userId) as { kind: CloudDocumentKind; document_id: string; area_id: string }[]).map((row) => ({ kind: row.kind, documentId: row.document_id, areaId: row.area_id })); },
  };
  return store;
}

async function input(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) fail("invalid-request", 400, "JSON content is required.");
  if (!request.body) fail("invalid-request", 400, "A JSON body is required.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 2048) { await reader.cancel(); fail("too-large", 413, "Cloud area request exceeds its size bound."); } chunks.push(result.value); } }
  finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("invalid-request", 400, "Invalid JSON body."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid-request", 400, "Invalid cloud area payload.");
  return body as Record<string, unknown>;
}
export interface CloudAreasApiOptions {
  store: CloudAreasStore;
  authenticate(request: Request): Promise<{ id: string } | null>;
  canAccessDocument(userId: string, kind: CloudDocumentKind, documentId: string): boolean | Promise<boolean>;
}
/** Mount at /api/account. Every placement operation independently checks ACL. */
export function createCloudAreasApi({ store, authenticate, canAccessDocument }: CloudAreasApiOptions): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  app.onError((error, c) => {
    if (error instanceof CloudAreaError) return c.json({ error: error.code, message: error.message }, error.status);
    reportRouteFault(error, c);
    return c.json({ error: "storage-error" }, 503);
  });
  const user = async (request: Request) => { const account = await authenticate(request); if (!account || !account.id || account.id.length > 128) fail("unauthorized", 401, "Sign in to organize cloud documents."); return account.id; };
  app.get("/cloud-areas", async (c) => {
    const uid = await user(c.req.raw), areas = store.list(uid), placements: CloudPlacement[] = [];
    for (const placement of store.listPlacements(uid)) if (await canAccessDocument(uid, placement.kind, placement.documentId)) placements.push(placement);
    return c.json({ areas, placements });
  });
  app.post("/cloud-areas", async (c) => { const uid = await user(c.req.raw), body = await input(c.req.raw); if (Object.keys(body).some((key) => key !== "label")) fail("invalid-request", 400, "Only an area label may be supplied."); return c.json({ area: store.create(uid, body.label) }, 201); });
  app.patch("/cloud-areas/:id", async (c) => { const uid = await user(c.req.raw), body = await input(c.req.raw); if (Object.keys(body).some((key) => key !== "label")) fail("invalid-request", 400, "Only an area label may be supplied."); return c.json({ area: store.rename(uid, c.req.param("id"), body.label) }); });
  app.put("/cloud-areas/placements/:kind/:documentId", async (c) => {
    const uid = await user(c.req.raw), body = await input(c.req.raw), documentKind = c.req.param("kind"), documentId = c.req.param("documentId");
    if (Object.keys(body).some((key) => key !== "areaId")) fail("invalid-request", 400, "Only the destination area may be supplied.");
    kind(documentKind); reference(documentId); store.ownArea(uid, body.areaId);
    if (!await canAccessDocument(uid, documentKind, documentId)) fail("not-found", 404, "Document not found.");
    return c.json({ placement: store.setPlacement(uid, documentKind, documentId, body.areaId) });
  });
  return app;
}
