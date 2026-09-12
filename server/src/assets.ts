// Media that travels with a document: what is stored, who may link it to
// which document, and how it is served. Reads go through the same three
// gates the text uses (bearer, /d/ viewer, /s/ token); this module only
// knows how to stream one asset once a caller has passed one of them.
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import { accessLevel, canEditLevel } from "./shares.ts";
import { assetMimeFor, ASSET_EXTENSIONS } from "./asset-mime.ts";
import { assetStore, type AssetStore } from "./storage.ts";

export const MAX_ASSET_BYTES = 100 * 1024 * 1024;
export const MAX_DOC_ASSET_BYTES = 500 * 1024 * 1024;
export const MAX_ACCOUNT_ASSET_BYTES = 5 * 1024 * 1024 * 1024;

const db = openDatabase();
db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    owner_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, hash)
  );
  CREATE TABLE IF NOT EXISTS doc_assets (
    doc_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (doc_id, ref)
  );
  CREATE INDEX IF NOT EXISTS idx_doc_assets_asset ON doc_assets(owner_id, hash);
`);

let store: AssetStore | null = assetStore();
export function setAssetStoreForTests(next: AssetStore | null): void {
  store = next;
}

// The per-file cap actually enforced by the upload route. Defaults to
// MAX_ASSET_BYTES; tests may lower it so a streamed over-cap upload can be
// exercised without sending 100 MB of bytes. The exported constant itself
// never changes, only what the route checks a request against.
let maxAssetBytesLimit = MAX_ASSET_BYTES;
export function setAssetLimitsForTests(limits: { maxAssetBytes?: number } | null): void {
  maxAssetBytesLimit = limits?.maxAssetBytes ?? MAX_ASSET_BYTES;
}

const HASH = /^[a-f0-9]{64}$/;
// One list of what a document may embed, kept in asset-mime.ts (and in step
// there with electron/local-assets.js); this file only reads it rather than
// keeping a second copy of the extension list.
const ALLOWED_MIMES = new Set(
  ASSET_EXTENSIONS.map((ext) => assetMimeFor(`x${ext}`)).filter((m): m is string => !!m)
);

async function requireUser(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

function docExists(docId: string): boolean {
  return !!db.prepare("SELECT 1 FROM docs WHERE id = ? AND deleted_at IS NULL").get(docId);
}

function usageFor(ownerId: string, excludeHash?: string): number {
  const row = (
    excludeHash
      ? db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM assets WHERE owner_id = ? AND hash != ?").get(ownerId, excludeHash)
      : db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM assets WHERE owner_id = ?").get(ownerId)
  ) as { total: number };
  return row.total;
}

interface AssetRow {
  owner_id: string;
  hash: string;
  size: number;
  mime: string;
}

export function assetRefsFor(docId: string): Map<string, AssetRow> {
  const rows = db
    .prepare(
      `SELECT d.ref, a.owner_id, a.hash, a.size, a.mime FROM doc_assets d
       JOIN assets a ON a.owner_id = d.owner_id AND a.hash = d.hash WHERE d.doc_id = ?`
    )
    .all(docId) as (AssetRow & { ref: string })[];
  return new Map(rows.map((r) => [r.ref, { owner_id: r.owner_id, hash: r.hash, size: r.size, mime: r.mime }]));
}

// Rows in `assets` that no document links any more, removed from the table
// and from storage. Storage failures are logged, not thrown: the link is
// already gone, and a leftover object is a cost, not a leak.
async function collectOrphans(candidates: { owner_id: string; hash: string }[]): Promise<void> {
  for (const { owner_id, hash } of candidates) {
    const still = db.prepare("SELECT 1 FROM doc_assets WHERE owner_id = ? AND hash = ? LIMIT 1").get(owner_id, hash);
    if (still) continue;
    db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(owner_id, hash);
    try {
      await store?.delete(`${owner_id}/${hash}`);
    } catch (err) {
      console.error(`asset delete failed for ${owner_id}/${hash}:`, err);
    }
  }
}

// Async, not fire-and-forget: a caller that awaits this sees the storage
// objects actually gone, the same guarantee collectOrphans already gives the
// link route below. A caller that does not await it still gets the DB row
// deleted synchronously; only the storage sweep trails behind.
export async function unlinkDocAssets(docId: string): Promise<void> {
  const rows = db.prepare("SELECT owner_id, hash FROM doc_assets WHERE doc_id = ?").all(docId) as { owner_id: string; hash: string }[];
  db.prepare("DELETE FROM doc_assets WHERE doc_id = ?").run(docId);
  await collectOrphans(rows);
}

// The gate for writes: owner or editor of a live document. 404 for a
// document the caller cannot see at all, the same as the text routes.
async function requireEditor(c: Context, docId: string) {
  const user = await requireUser(c);
  if (!user) return { error: c.json({ error: "unauthorized" }, 401) };
  const level = accessLevel(docId, user.id);
  if (!docExists(docId) || level === null) return { error: c.json({ error: "not found" }, 404) };
  if (!canEditLevel(level)) return { error: c.json({ error: "forbidden" }, 403) };
  return { user };
}

// The decisive account-cap check: the real, measured size, checked and
// claimed in one synchronous transaction, so no upload from the same account
// running in parallel can also pass it. A client can declare a small
// Content-Length and stream up to the per-file cap regardless, and every
// in-flight upload would otherwise read the same pre-upload usage; only a
// check against actual bytes, committed together with the row that reserves
// them, is authoritative. better-sqlite3 transactions are synchronous, so
// nothing else can interleave between the read and the write here.
function reserveAssetSpace(ownerId: string, hash: string, size: number, mime: string): boolean {
  return db.transaction(() => {
    if (usageFor(ownerId, hash) + size > MAX_ACCOUNT_ASSET_BYTES) return false;
    db.prepare(
      "INSERT OR REPLACE INTO assets (owner_id, hash, size, mime, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(ownerId, hash, size, mime, new Date().toISOString());
    return true;
  })();
}

export const assetsApi = new Hono();

// A per-route guard, not a blanket `use("*")`: assetsApi is mounted at the
// same "/api" prefix as docs, shares and the rest, and a wildcard middleware
// registered on a sub-app is merged into the parent's route table at that
// prefix, so it would gate every "/api/*" request, not just this module's
// own three routes, and take the whole API down whenever the store env vars
// are unset.
function requireStore(c: Context): Response | null {
  return store ? null : c.json({ error: "assets not configured" }, 503);
}

assetsApi.post("/docs/:id/assets/missing", async (c) => {
  const unconfigured = requireStore(c);
  if (unconfigured) return unconfigured;
  const docId = c.req.param("id");
  const gate = await requireEditor(c, docId);
  if ("error" in gate) return gate.error;
  const body = (await c.req.json().catch(() => null)) as { hashes?: unknown } | null;
  const hashes = Array.isArray(body?.hashes) ? body!.hashes.filter((h): h is string => typeof h === "string" && HASH.test(h)) : [];
  const have = new Set(
    (db.prepare("SELECT hash FROM assets WHERE owner_id = ?").all(gate.user.id) as { hash: string }[]).map((r) => r.hash)
  );
  return c.json({ missing: hashes.filter((h) => !have.has(h)), usage: usageFor(gate.user.id), cap: MAX_ACCOUNT_ASSET_BYTES });
});

// Bytes in, hashed as they stream to a temp file, kept only when the hash
// the URL names is the hash of what arrived. The per-file cap and the cheap
// declared-length courtesy check happen before anything is written; the
// decisive account-cap check happens after the object is written, so a row
// in `assets` is never created ahead of the bytes it claims to describe (see
// the comment at the reserveAssetSpace call below).
assetsApi.put("/assets/:hash", async (c) => {
  const unconfigured = requireStore(c);
  if (unconfigured) return unconfigured;
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const hash = c.req.param("hash");
  if (!HASH.test(hash)) return c.json({ error: "bad hash" }, 400);
  const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) return c.json({ error: "unsupported type" }, 415);
  const declared = Number(c.req.header("content-length") ?? NaN);
  if (!Number.isFinite(declared) || declared <= 0) return c.json({ error: "length required" }, 411);
  if (declared > maxAssetBytesLimit) return c.json({ error: "file over cap", cap: maxAssetBytesLimit }, 413);
  // Dedupe first, before the account-cap courtesy check below: re-uploading
  // bytes the account already holds adds nothing to its usage, so it must
  // never be refused for being "over cap".
  const existing = db.prepare("SELECT size FROM assets WHERE owner_id = ? AND hash = ?").get(user.id, hash) as { size: number } | undefined;
  if (existing && (await store!.head(`${user.id}/${hash}`))) return c.json({ ok: true, hash, size: existing.size });
  if (usageFor(user.id) + declared > MAX_ACCOUNT_ASSET_BYTES) {
    return c.json({ error: "account over cap", cap: MAX_ACCOUNT_ASSET_BYTES }, 413);
  }

  const dir = await mkdtemp(join(tmpdir(), "markie-upload-"));
  const tmp = join(dir, "body");
  try {
    const hasher = createHash("sha256");
    let seen = 0;
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty body" }, 400);
    const counted = Readable.fromWeb(body as never).on("data", (chunk: Buffer) => {
      seen += chunk.length;
      hasher.update(chunk);
      if (seen > maxAssetBytesLimit) counted.destroy(new Error("over cap"));
    });
    try {
      await pipeline(counted, createWriteStream(tmp));
    } catch (err) {
      if (String(err).includes("over cap")) return c.json({ error: "file over cap", cap: maxAssetBytesLimit }, 413);
      throw err;
    }
    if (hasher.digest("hex") !== hash) return c.json({ error: "hash mismatch" }, 400);
    const size = (await stat(tmp)).size;
    // Object first, then the atomic reserve: a row must never exist without
    // an object behind it, because a row alone counts against quota, answers
    // "not missing", and can be linked into a document. If the process dies
    // between these two steps the object is merely an orphan (a cost, the
    // same as the ones collectOrphans sweeps up), not a document pointing at
    // bytes that were never written.
    await store!.put(`${user.id}/${hash}`, Readable.toWeb(createReadStream(tmp)) as ReadableStream<Uint8Array>, size, mime);
    // The declared-length check above is a cheap courtesy: it reads
    // yesterday's usage against a number the client chose. This is the real
    // gate, on the size just measured from the bytes that actually arrived.
    if (!reserveAssetSpace(user.id, hash, size, mime)) {
      // The object was written on spec but the account can't afford it:
      // undo the write so it does not linger as an unowned orphan, then
      // refuse. A failure here is logged, not thrown, the same as
      // collectOrphans: the row was never claimed, so there is nothing this
      // request can still get wrong by moving on.
      try {
        await store!.delete(`${user.id}/${hash}`);
      } catch (err) {
        console.error(`asset cleanup failed for ${user.id}/${hash}:`, err);
      }
      return c.json({ error: "account over cap", cap: MAX_ACCOUNT_ASSET_BYTES }, 413);
    }
    return c.json({ ok: true, hash, size });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The document's full reference set. An entry with a hash must name an asset
// in the caller's scope; one without keeps whatever link the document already
// has for that ref (an editor pushing text whose pictures the owner uploaded)
// or is dropped.
assetsApi.put("/docs/:id/assets", async (c) => {
  const unconfigured = requireStore(c);
  if (unconfigured) return unconfigured;
  const docId = c.req.param("id");
  const gate = await requireEditor(c, docId);
  if ("error" in gate) return gate.error;
  const body = (await c.req.json().catch(() => null)) as { refs?: unknown } | null;
  if (!Array.isArray(body?.refs)) return c.json({ error: "bad request" }, 400);
  const current = assetRefsFor(docId);
  const next = new Map<string, { owner_id: string; hash: string; size: number }>();
  let linked = 0, kept = 0, dropped = 0;
  for (const entry of body!.refs as { ref?: unknown; hash?: unknown }[]) {
    const ref = typeof entry?.ref === "string" ? entry.ref : "";
    if (!ref || ref.length > 2048) {
      dropped += 1;
      continue;
    }
    if (typeof entry.hash === "string") {
      if (!HASH.test(entry.hash)) return c.json({ error: "bad hash" }, 400);
      const own = db.prepare("SELECT size FROM assets WHERE owner_id = ? AND hash = ?").get(gate.user.id, entry.hash) as { size: number } | undefined;
      if (!own) return c.json({ error: "unknown asset", hash: entry.hash }, 400);
      next.set(ref, { owner_id: gate.user.id, hash: entry.hash, size: own.size });
      linked += 1;
    } else if (current.has(ref)) {
      const row = current.get(ref)!;
      next.set(ref, { owner_id: row.owner_id, hash: row.hash, size: row.size });
      kept += 1;
    } else {
      dropped += 1;
    }
  }
  const total = [...next.values()].reduce((n, r) => n + r.size, 0);
  if (total > MAX_DOC_ASSET_BYTES) return c.json({ error: "document over cap", cap: MAX_DOC_ASSET_BYTES }, 413);
  const before = [...current.values()].map((r) => ({ owner_id: r.owner_id, hash: r.hash }));
  db.transaction(() => {
    db.prepare("DELETE FROM doc_assets WHERE doc_id = ?").run(docId);
    const ins = db.prepare("INSERT INTO doc_assets (doc_id, ref, owner_id, hash) VALUES (?, ?, ?, ?)");
    for (const [ref, r] of next) ins.run(docId, ref, r.owner_id, r.hash);
  })();
  await collectOrphans(before);
  return c.json({ linked, kept, dropped });
});

// True when an If-None-Match header names this ETag, weak (`W/`) prefix
// tolerated per RFC 9110 and one or more comma-separated values allowed.
function etagMatches(header: string, etag: string): boolean {
  return header.split(",").some((raw) => raw.trim().replace(/^W\//, "") === etag);
}

// Headers every response about an asset carries, whether it answers with
// bytes or merely confirms the caller already has them (304). An asset is
// arbitrary user content served back on the same origin, so it must never be
// sniffed as script or styled as a frame, and it must never be cached for
// anyone but the caller who was just gated.
const ASSET_SAFETY_HEADERS = {
  "Accept-Ranges": "bytes",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

// One asset, by the reference the document wrote, for a caller that has
// already passed a read gate. 404 for an unknown ref, or for a document that
// no longer exists, so the route says no more than the document page would.
export async function serveAsset(c: Context, docId: string, ref: string): Promise<Response> {
  if (!store) return c.json({ error: "assets not configured" }, 503);
  if (!docExists(docId)) return c.text("Not found", 404);
  const row = assetRefsFor(docId).get(ref);
  if (!row) return c.text("Not found", 404);
  const etag = `"${row.hash}"`;
  const cacheControl = "private, max-age=3600";
  const inm = c.req.header("if-none-match");
  if (inm && etagMatches(inm, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl, ...ASSET_SAFETY_HEADERS },
    });
  }
  const rangeHeader = c.req.header("range");
  let range: { start: number; end?: number } | undefined;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    // Either group may be empty to mean "to the end" / "the last N bytes",
    // but both empty at once names no bytes at all and must not fall through
    // to being silently served in full.
    if (!m || (!m[1] && !m[2])) return c.text("Range Not Satisfiable", 416);
    if (m[1]) range = { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
    else range = { start: Math.max(0, row.size - Number(m[2])) };
  }
  const read = await store.get(`${row.owner_id}/${row.hash}`, range);
  if (!read) return c.text(range ? "Range Not Satisfiable" : "Not found", range ? 416 : 404);
  const headers = new Headers({
    "Content-Type": row.mime,
    "Content-Length": String(read.size),
    "Cache-Control": cacheControl,
    ETag: etag,
    ...ASSET_SAFETY_HEADERS,
  });
  if (range) headers.set("Content-Range", `bytes ${read.start}-${read.end}/${read.total}`);
  return new Response(read.stream, { status: range ? 206 : 200, headers });
}
