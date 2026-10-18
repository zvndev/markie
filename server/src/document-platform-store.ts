import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CloudAreaError, type CloudAreasStore } from "./cloud-areas.ts";

/** Ordinary byte snapshots only. This is neither vault transport nor live CRDT merging. */
export type PlatformFormat = "markdown" | "darkmown" | "text" | "csv" | "json" | "yaml" | "xml" | "docx" | "doc" | "rtf" | "odt";
export type PlatformRole = "owner" | "editor" | "viewer";
export interface PlatformSnapshotInput { schemaVersion: 2; name: string; format: PlatformFormat; encoding: "base64"; data: string; sha256: string; baseVersion: number; areaId?: string }
export interface PlatformMetadata { schemaVersion: 2; id: string; name: string; format: PlatformFormat; sha256: string; version: number; createdAt: number; updatedAt: number; byteLength: number; role: PlatformRole; areaId?: string }
export interface PlatformSnapshot extends PlatformMetadata { encoding: "base64"; data: string }
export interface PlatformLimits { maxDocumentBytes: number; maxDocumentsPerOwner: number; maxStoredBytesPerOwner: number; maxHistoryVersions: number; maxMembersPerDocument: number; maxLinksPerDocument: number; maxListedDocuments: number }
export const DEFAULT_DOCUMENT_PLATFORM_LIMITS: Readonly<PlatformLimits> = Object.freeze({ maxDocumentBytes: 16 * 1024 * 1024, maxDocumentsPerOwner: 500, maxStoredBytesPerOwner: 256 * 1024 * 1024, maxHistoryVersions: 20, maxMembersPerDocument: 100, maxLinksPerDocument: 100, maxListedDocuments: 1000 });
export const DOCUMENT_PLATFORM_MAX_WIRE_BYTES = Math.ceil(DEFAULT_DOCUMENT_PLATFORM_LIMITS.maxDocumentBytes / 3) * 4 + 4096;
export interface PlatformSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...parameters: (string | number | Uint8Array | null)[]): unknown;
    all(...parameters: (string | number | Uint8Array | null)[]): unknown[];
    run(...parameters: (string | number | Uint8Array | null)[]): { changes: number | bigint };
  };
}
export class DocumentPlatformError extends Error {
  code: string; status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503; serverVersion?: number;
  constructor(code: string, status: DocumentPlatformError["status"], message: string, serverVersion?: number) { super(message); this.code = code; this.status = status; this.serverVersion = serverVersion; }
}
export function platformFail(code: string, status: DocumentPlatformError["status"], message: string, serverVersion?: number): never { throw new DocumentPlatformError(code, status, message, serverVersion); }
// Byte snapshots are format-agnostic beyond this allowlist; keep in step
// with src/lib/document-cloud.ts FORMATS.
const FORMATS: readonly string[] = ["markdown", "darkmown", "text", "csv", "json", "yaml", "xml", "docx", "doc", "rtf", "odt"];
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const opaqueId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function platformObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) platformFail("invalid-request", 400, "Invalid document-platform payload fields.");
  return value as Record<string, unknown>;
}
export function platformVersion(value: unknown, allowZero = false): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) platformFail("invalid-request", 400, "A valid base version is required.");
}
function rejectVault(bytes: Uint8Array, name: string) {
  if (/\.(?:vault|markievault|markie-vault)$/i.test(name)) platformFail("vault-excluded", 400, "Encrypted vault documents are excluded from ordinary cloud sharing.");
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = Buffer.from(bytes).subarray(2).toString("utf16le");
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    if (swapped.length % 2) return;
    swapped.swap16(); text = swapped.toString("utf16le");
  } else {
    let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    while (i < bytes.length && [9, 10, 13, 32].includes(bytes[i])) i++;
    if (bytes[i] !== 123) return;
    text = Buffer.from(bytes).toString("utf8");
  }
  const kind = topLevelString(text, "kind");
  if (kind === "markie-vault" || kind === "markie-vault-document") platformFail("vault-excluded", 400, "Encrypted vault envelopes cannot be uploaded to ordinary cloud sharing.");
  const header = topLevelString(text, "header");
  if (header && topLevelString(header, "kind") === "markie-vault") platformFail("vault-excluded", 400, "Encrypted vault snapshots cannot be uploaded to ordinary cloud sharing.");
}
/** Inspect known top-level marker strings without expanding arbitrary nested document JSON. */
function topLevelString(text: string, property: string): string | undefined {
  let depth = 0, state: "key" | "colon" | "value" | "comma" = "key", key = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      for (; end < text.length; end++) { if (text[end] === "\\") end++; else if (text[end] === '"') break; }
      if (end >= text.length) return;
      if (depth === 1 && state === "key") {
        try { key = end - i < 256 ? JSON.parse(text.slice(i, end + 1)) : ""; } catch { return; }
        state = "colon";
      } else if (depth === 1 && state === "value") {
        if (key === property) { try { return JSON.parse(text.slice(i, end + 1)) as string; } catch { return; } }
        state = "comma";
      }
      i = end;
    } else if (c === "{" || c === "[") { if (depth === 1 && state === "value") state = "comma"; depth++; }
    else if (c === "}" || c === "]") depth--;
    else if (depth === 1 && c === ",") state = "key";
    else if (depth === 1 && c === ":" && state === "colon") state = "value";
    else if (depth === 1 && state === "value" && !/\s/.test(c)) state = "comma";
  }
}
function decodeInput(value: unknown, limits: PlatformLimits, areasEnabled = false) {
  const v = platformObject(value, ["schemaVersion", "name", "format", "encoding", "data", "sha256", "baseVersion", ...(areasEnabled ? ["areaId"] : [])]);
  if (v.areaId !== undefined && (typeof v.areaId !== "string" || !v.areaId || v.areaId.length > 128)) platformFail("invalid-request", 400, "Invalid cloud destination.");
  if (v.schemaVersion !== 2 || typeof v.name !== "string" || !v.name.trim() || v.name.length > 256 || /[\x00-\x1f\x7f/\\]/.test(v.name)) platformFail("invalid-request", 400, "A valid version-2 filename is required.");
  if (!FORMATS.includes(v.format as string)) platformFail("unsupported-format", 415, "This ordinary document format is not supported.");
  platformVersion(v.baseVersion, true);
  if (v.encoding !== "base64" || typeof v.data !== "string" || typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256)) platformFail("invalid-request", 400, "Canonical base64 data and a lowercase SHA-256 digest are required.");
  if (v.data.length > Math.ceil(limits.maxDocumentBytes / 3) * 4) platformFail("too-large", 413, "Document exceeds the snapshot byte limit.");
  // RFC 4648: exact re-encoding rejects whitespace, ignored characters, padding and pad-bit aliases.
  const bytes = Buffer.from(v.data, "base64");
  if (bytes.length > limits.maxDocumentBytes) platformFail("too-large", 413, "Document exceeds the snapshot byte limit.");
  if (bytes.toString("base64") !== v.data) platformFail("invalid-request", 400, "Document base64 encoding is not canonical.");
  if (hash(bytes) !== v.sha256) platformFail("digest-mismatch", 400, "Document bytes do not match their SHA-256 digest.");
  rejectVault(bytes, v.name);
  return { name: v.name, format: v.format as PlatformFormat, bytes, sha256: v.sha256, baseVersion: v.baseVersion, areaId: v.areaId as string | undefined };
}
interface DocumentRow { id: string; owner_id: string; name: string; format: PlatformFormat; version: number; bytes: Uint8Array; sha256: string; created_at: number; updated_at: number }
export interface DocumentPlatformStore {
  readonly limits: Readonly<PlatformLimits>;
  list(userId: string): PlatformMetadata[];
  create(userId: string, input: unknown): PlatformSnapshot;
  get(userId: string, id: string): PlatformSnapshot;
  update(userId: string, id: string, input: unknown): PlatformSnapshot;
  remove(userId: string, id: string, baseVersion: number): void;
  history(userId: string, id: string): PlatformMetadata[];
  historyVersion(userId: string, id: string, version: number): PlatformSnapshot;
  members(userId: string, id: string): { userId: string; email: string; role: "editor" | "viewer"; createdAt: number }[];
  addMember(userId: string, id: string, input: unknown): void;
  removeMember(userId: string, id: string, memberId: string): void;
  createLink(userId: string, id: string, expiresInSeconds: number): { id: string; token: string; createdAt: number; expiresAt: number; path: string };
  links(userId: string, id: string): { id: string; createdAt: number; expiresAt: number; revokedAt: number | null }[];
  revokeLink(userId: string, id: string, linkId: string): void;
  publicSnapshot(token: string): PlatformSnapshot;
}

/** Additive schema on the caller's injected handle only; never opens a database itself. */
export interface DocumentPlatformStoreOptions { limits?: Partial<PlatformLimits>; now?: () => number; cloudAreas?: CloudAreasStore; verifiedUserForEmail?: (email: string) => string | null }
export function createSqliteDocumentPlatformStore(db: PlatformSqliteDatabase, options: DocumentPlatformStoreOptions = {}): DocumentPlatformStore {
  const areas = options.cloudAreas;
  if (areas && areas.database !== db) platformFail("invalid-request", 400, "Cloud placements and document writes require the same database handle.");
  const limits = Object.freeze({ ...DEFAULT_DOCUMENT_PLATFORM_LIMITS, ...options.limits });
  if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 1) || limits.maxHistoryVersions > 20) platformFail("invalid-request", 400, "Invalid document-platform limits; history is capped at 20 revisions.");
  const clock = options.now ?? Date.now;
  const now = () => { const time = clock(); if (!Number.isSafeInteger(time) || time < 0) platformFail("storage-error", 503, "Document storage clock is invalid."); return time; };
  db.exec(`
    CREATE TABLE IF NOT EXISTS dp_documents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, format TEXT NOT NULL, version INTEGER NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS dp_documents_owner ON dp_documents(owner_id);
    CREATE TABLE IF NOT EXISTS dp_history (doc_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, format TEXT NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(doc_id, version));
    CREATE TABLE IF NOT EXISTS dp_members (doc_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','viewer')), created_at INTEGER NOT NULL, PRIMARY KEY(doc_id,user_id));
    CREATE INDEX IF NOT EXISTS dp_members_user ON dp_members(user_id);
    CREATE TABLE IF NOT EXISTS dp_links (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE INDEX IF NOT EXISTS dp_links_document ON dp_links(doc_id);
  `);
  const transaction = <T>(operation: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* Keep the original failure; no partial acknowledgement. */ } throw error; }
  };
  const access = (userId: string, id: string, required: PlatformRole = "viewer") => {
    if (!opaqueId(id)) platformFail("not-found", 404, "Document not found.");
    // Apply ACL inside the SELECT so unknown users never materialize private BLOBs.
    const row = db.prepare("SELECT d.*,CASE WHEN d.owner_id = ? THEN 'owner' ELSE m.role END AS access_role FROM dp_documents d LEFT JOIN dp_members m ON m.doc_id = d.id AND m.user_id = ? WHERE d.id = ? AND (d.owner_id = ? OR m.user_id = ?)").get(userId, userId, id, userId, userId) as (DocumentRow & { access_role: PlatformRole }) | undefined;
    if (!row) platformFail("not-found", 404, "Document not found.");
    const role = row.access_role;
    if (!["owner", "editor", "viewer"].includes(role)) platformFail("not-found", 404, "Document not found.");
    if ((required === "owner" && role !== "owner") || (required === "editor" && role === "viewer")) platformFail("forbidden", 403, "This document permission does not allow that operation.");
    return { row, role };
  };
  const placement = (userId: string, id: string) => areas ? { areaId: areas.ensurePlacement(userId, "snapshot", id).areaId } : {};
  const metadata = (row: DocumentRow, role: PlatformRole, userId?: string): PlatformMetadata => ({ schemaVersion: 2, id: row.id, name: row.name, format: row.format, sha256: row.sha256, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, byteLength: row.bytes.length, role, ...(userId ? placement(userId, row.id) : {}) });
  const snapshot = (row: DocumentRow, role: PlatformRole, userId?: string): PlatformSnapshot => {
    if (!(row.bytes instanceof Uint8Array) || row.bytes.length > limits.maxDocumentBytes || hash(row.bytes) !== row.sha256 || !FORMATS.includes(row.format)) platformFail("storage-error", 503, "Stored document integrity could not be verified.");
    return { ...metadata(row, role, userId), encoding: "base64", data: Buffer.from(row.bytes).toString("base64") };
  };
  const checkVersion = (row: DocumentRow, version: number) => { platformVersion(version); if (row.version !== version) platformFail("conflict", 409, "A newer document snapshot exists. Reopen it before saving.", row.version); };
  const appendHistory = (row: DocumentRow) => {
    db.prepare("INSERT INTO dp_history(doc_id,version,name,format,bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?)").run(row.id, row.version, row.name, row.format, row.bytes, row.sha256, row.updated_at);
    db.prepare("DELETE FROM dp_history WHERE doc_id = ? AND version NOT IN (SELECT version FROM dp_history WHERE doc_id = ? ORDER BY version DESC LIMIT ?)").run(row.id, row.id, limits.maxHistoryVersions);
    const total = db.prepare("SELECT COALESCE((SELECT SUM(length(bytes)) FROM dp_documents WHERE owner_id = ?),0) + COALESCE((SELECT SUM(length(h.bytes)) FROM dp_history h JOIN dp_documents d ON d.id = h.doc_id WHERE d.owner_id = ?),0) AS total").get(row.owner_id, row.owner_id) as { total: number };
    if (total.total > limits.maxStoredBytesPerOwner) platformFail("limit-exceeded", 413, "Account document storage limit reached. Remove unneeded cloud copies before retrying.");
  };
  return {
    limits,
    list(userId) {
      const rows = db.prepare("SELECT d.id,d.name,d.format,d.version,d.sha256,d.created_at,d.updated_at,length(d.bytes) AS byte_length,CASE WHEN d.owner_id = ? THEN 'owner' ELSE m.role END AS role FROM dp_documents d LEFT JOIN dp_members m ON m.doc_id = d.id AND m.user_id = ? WHERE d.owner_id = ? OR m.user_id = ? ORDER BY d.updated_at DESC,d.id ASC LIMIT ?").all(userId, userId, userId, userId, limits.maxListedDocuments + 1) as (Omit<DocumentRow, "bytes"> & { byte_length: number; role: PlatformRole })[];
      if (rows.length > limits.maxListedDocuments) platformFail("limit-exceeded", 413, "Too many accessible cloud documents to list.");
      return rows.map((row) => ({ schemaVersion: 2, id: row.id, name: row.name, format: row.format, version: row.version, sha256: row.sha256, createdAt: row.created_at, updatedAt: row.updated_at, byteLength: row.byte_length, role: row.role, ...placement(userId, row.id) }));
    },
    create(userId, input) {
      const decoded = decodeInput(input, limits, !!areas);
      if (decoded.baseVersion !== 0) platformFail("invalid-request", 400, "New cloud documents require baseVersion 0.");
      return transaction(() => {
        const destination = areas ? decoded.areaId !== undefined ? areas.ownArea(userId, decoded.areaId) : areas.ensureDefault(userId) : undefined;
        const count = db.prepare("SELECT COUNT(*) AS count FROM dp_documents WHERE owner_id = ?").get(userId) as { count: number };
        if (count.count >= limits.maxDocumentsPerOwner) platformFail("limit-exceeded", 413, "Account document count limit reached.");
        const time = now(), row: DocumentRow = { id: randomUUID(), owner_id: userId, name: decoded.name, format: decoded.format, version: 1, bytes: decoded.bytes, sha256: decoded.sha256, created_at: time, updated_at: time };
        db.prepare("INSERT INTO dp_documents(id,owner_id,name,format,version,bytes,sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(row.id, userId, row.name, row.format, 1, row.bytes, row.sha256, time, time);
        appendHistory(row);
        if (destination) areas!.setPlacement(userId, "snapshot", row.id, destination.id);
        return snapshot(row, "owner", userId);
      });
    },
    get(userId, id) { const { row, role } = access(userId, id); return snapshot(row, role, userId); },
    update(userId, id, input) {
      return transaction(() => {
        const { row, role } = access(userId, id, "editor"), decoded = decodeInput(input, limits, !!areas); checkVersion(row, decoded.baseVersion);
        if (areas && decoded.areaId !== undefined) {
          const destination = areas.ownArea(userId, decoded.areaId), current = areas.ensurePlacement(userId, "snapshot", id);
          if (destination.id !== current.areaId) throw new CloudAreaError("placement-required", 409, "Move this document through the explicit placement endpoint before saving.");
        }
        if (row.version === Number.MAX_SAFE_INTEGER) platformFail("limit-exceeded", 413, "Document version counter is exhausted.");
        const next: DocumentRow = { ...row, ...decoded, version: row.version + 1, updated_at: Math.max(now(), row.updated_at) };
        const updated = db.prepare("UPDATE dp_documents SET name = ?,format = ?,version = ?,bytes = ?,sha256 = ?,updated_at = ? WHERE id = ? AND version = ?").run(next.name, next.format, next.version, next.bytes, next.sha256, next.updated_at, id, row.version);
        if (Number(updated.changes) !== 1) platformFail("conflict", 409, "A concurrent document update won.", row.version);
        appendHistory(next); return snapshot(next, role, userId);
      });
    },
    remove(userId, id, baseVersion) {
      transaction(() => {
        const { row } = access(userId, id, "owner"); checkVersion(row, baseVersion);
        db.prepare("DELETE FROM dp_links WHERE doc_id = ?").run(id); db.prepare("DELETE FROM dp_members WHERE doc_id = ?").run(id); db.prepare("DELETE FROM dp_history WHERE doc_id = ?").run(id); db.prepare("DELETE FROM dp_documents WHERE id = ?").run(id);
      });
    },
    history(userId, id) {
      const { row, role } = access(userId, id, "editor");
      const rows = db.prepare("SELECT version,name,format,sha256,created_at,length(bytes) AS byte_length FROM dp_history WHERE doc_id = ? ORDER BY version DESC LIMIT ?").all(id, limits.maxHistoryVersions) as { version: number; name: string; format: PlatformFormat; sha256: string; created_at: number; byte_length: number }[];
      return rows.map((r) => ({ schemaVersion: 2, id, name: r.name, format: r.format, version: r.version, sha256: r.sha256, byteLength: r.byte_length, createdAt: row.created_at, updatedAt: r.created_at, role, ...placement(userId, id) }));
    },
    historyVersion(userId, id, version) {
      const { row, role } = access(userId, id, "editor"); platformVersion(version);
      const old = db.prepare("SELECT * FROM dp_history WHERE doc_id = ? AND version = ?").get(id, version) as { name: string; format: PlatformFormat; version: number; bytes: Uint8Array; sha256: string; created_at: number } | undefined;
      if (!old) platformFail("not-found", 404, "Document history version not found.");
      return snapshot({ ...row, ...old, created_at: row.created_at, updated_at: old.created_at }, role, userId);
    },
    members(userId, id) {
      access(userId, id, "owner");
      return (db.prepare('SELECT m.user_id,u.email,m.role,m.created_at FROM dp_members m JOIN "user" u ON u.id = m.user_id WHERE m.doc_id = ? ORDER BY m.created_at,m.user_id LIMIT ?').all(id, limits.maxMembersPerDocument) as { user_id: string; email: string; role: "editor" | "viewer"; created_at: number }[]).map((r) => ({ userId: r.user_id, email: r.email, role: r.role, createdAt: r.created_at }));
    },
    addMember(userId, id, input) {
      transaction(() => {
        const { row } = access(userId, id, "owner");
        const v = platformObject(input, ["userId", "email", "role"]);
        const byId = v.userId !== undefined, byEmail = v.email !== undefined;
        if ((v.role !== "editor" && v.role !== "viewer") || byId === byEmail || (byId && typeof v.userId !== "string") || (byEmail && typeof v.email !== "string")) platformFail("invalid-request", 400, "Choose one existing account by userId or email, and an editor/viewer role.");
        const reference = typeof v.userId === "string" ? v.userId : v.email as string;
        if (!reference.trim() || reference.length > (v.userId ? 128 : 320)) platformFail("invalid-request", 400, "Invalid member account reference.");
        const resolvedEmail = typeof v.email === "string" && options.verifiedUserForEmail !== undefined;
        const aliasId = resolvedEmail ? options.verifiedUserForEmail!(v.email as string) : null;
        const member = (resolvedEmail
          ? aliasId ? db.prepare('SELECT id FROM "user" WHERE id = ? AND emailVerified = 1').get(aliasId) : undefined
          : db.prepare(typeof v.userId === "string" ? 'SELECT id FROM "user" WHERE id = ? AND emailVerified = 1' : 'SELECT id FROM "user" WHERE lower(email) = lower(?) AND emailVerified = 1').get(reference)) as { id: string } | undefined;
        if (!member) platformFail("not-found", 404, "No verified existing account matches that reference.");
        if (member.id === row.owner_id) platformFail("invalid-request", 400, "The document owner's role cannot be changed.");
        const count = db.prepare("SELECT COUNT(*) AS count FROM dp_members WHERE doc_id = ? AND user_id != ?").get(id, member.id) as { count: number };
        if (count.count >= limits.maxMembersPerDocument) platformFail("limit-exceeded", 413, "Document member limit reached.");
        // This is an explicit document-owner command, not a passive invitation
        // claim. Resolving an alias must not suppress the requested role edit.
        db.prepare("INSERT INTO dp_members(doc_id,user_id,role,created_at) VALUES(?,?,?,?) ON CONFLICT(doc_id,user_id) DO UPDATE SET role = excluded.role").run(id, member.id, v.role as string, now());
      });
    },
    removeMember(userId, id, memberId) { transaction(() => { access(userId, id, "owner"); if (!memberId || memberId.length > 128) platformFail("invalid-request", 400, "Invalid member identifier."); db.prepare("DELETE FROM dp_members WHERE doc_id = ? AND user_id = ?").run(id, memberId); }); },
    createLink(userId, id, expiresInSeconds) {
      return transaction(() => {
        access(userId, id, "owner");
        if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 30 * 86400) platformFail("invalid-request", 400, "Share links must expire between one minute and 30 days.");
        const time = now();
        // Reclaim expired/revoked token rows so repeated revoke/create cannot grow storage forever.
        db.prepare("DELETE FROM dp_links WHERE doc_id = ? AND (revoked_at IS NOT NULL OR expires_at <= ?)").run(id, time);
        const count = db.prepare("SELECT COUNT(*) AS count FROM dp_links WHERE doc_id = ?").get(id) as { count: number };
        if (count.count >= limits.maxLinksPerDocument) platformFail("limit-exceeded", 413, "Document active share-link limit reached.");
        const linkId = randomUUID(), token = randomBytes(32).toString("base64url"), expiresAt = time + expiresInSeconds * 1000;
        if (!Number.isSafeInteger(expiresAt)) platformFail("limit-exceeded", 413, "Share-link expiry exceeds the supported clock range.");
        db.prepare("INSERT INTO dp_links(id,doc_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)").run(linkId, id, hash(token), time, expiresAt);
        return { id: linkId, token, createdAt: time, expiresAt, path: `/api/document-platform/links/${token}` };
      });
    },
    links(userId, id) { access(userId, id, "owner"); return (db.prepare("SELECT id,created_at,expires_at,revoked_at FROM dp_links WHERE doc_id = ? ORDER BY created_at DESC,id LIMIT ?").all(id, limits.maxLinksPerDocument) as { id: string; created_at: number; expires_at: number; revoked_at: number | null }[]).map((r) => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at })); },
    revokeLink(userId, id, linkId) { transaction(() => { access(userId, id, "owner"); if (!opaqueId(linkId)) platformFail("not-found", 404, "Share link not found."); const changed = db.prepare("UPDATE dp_links SET revoked_at = COALESCE(revoked_at,?) WHERE id = ? AND doc_id = ?").run(now(), linkId, id); if (Number(changed.changes) === 0) platformFail("not-found", 404, "Share link not found."); }); },
    publicSnapshot(token) {
      if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) platformFail("not-found", 404, "Share link not found.");
      const row = db.prepare("SELECT d.* FROM dp_links l JOIN dp_documents d ON d.id = l.doc_id WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ?").get(hash(token), now()) as DocumentRow | undefined;
      if (!row) platformFail("not-found", 404, "Share link not found.");
      return snapshot(row, "viewer");
    },
  };
}
