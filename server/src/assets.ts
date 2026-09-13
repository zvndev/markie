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
import { accessLevel, canEditLevel, isSharedOut } from "./shares.ts";
import { assetMimeFor, ASSET_EXTENSIONS } from "./asset-mime.ts";
import { assetStore, type AssetStore } from "./storage.ts";

export const MAX_ASSET_BYTES = 100 * 1024 * 1024;
export const MAX_DOC_ASSET_BYTES = 500 * 1024 * 1024;
export const MAX_ACCOUNT_ASSET_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_CONCURRENT_UPLOADS = 4;
// How many references one document may carry. Nothing bounded this before,
// and the document cap is a byte total, so N references to one 1-byte asset
// never reached it: one request could put 300 000 rows on a document and make
// every later read of it, anonymous ones through a public link included, cost
// a quarter of a second. Well above any real document; electron/asset-sync.js
// applies the same number locally so a huge document degrades instead of
// retrying a 413 for ever.
export const MAX_DOC_REFS = 2000;

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

// One reference's row, by the primary key doc_assets already has. This is
// what a read needs: assetRefsFor below builds the document's whole map,
// which the page rewrite wants and a single asset request does not.
export function assetRowFor(docId: string, ref: string): AssetRow | undefined {
  return db
    .prepare(
      `SELECT a.owner_id, a.hash, a.size, a.mime FROM doc_assets d
       JOIN assets a ON a.owner_id = d.owner_id AND a.hash = d.hash
       WHERE d.doc_id = ? AND d.ref = ?`
    )
    .get(docId, ref) as AssetRow | undefined;
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

// How many storage deletes a single sweep keeps in the air. A bucket DELETE
// can wait up to two minutes, and docs.delete awaits this sweep before it
// answers, so a document with a lot of media must not be a queue of them.
const ORPHAN_DELETE_CONCURRENCY = 4;

// Runs fn over every item with at most `limit` of them in flight.
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// The cache-busting half of a generated asset URL: enough of the hash to
// change whenever the ref is relinked, short enough to keep the URL readable.
// The asset route never reads it; a browser's cache key does.
export function assetVersion(hash: string): string {
  return hash.slice(0, 16);
}

// Rows in `assets` that no document links any more, removed from the table
// and from storage. Storage failures are logged, not thrown: the link is
// already gone, and a leftover object is a cost, not a leak.
//
// Candidates are deduplicated first, because a document that shows one
// picture three times hands this three entries naming one object, and the
// rows all go before any storage call does, so the database is consistent
// whatever the bucket does next.
async function collectOrphans(candidates: { owner_id: string; hash: string }[]): Promise<void> {
  const unique = new Map<string, { owner_id: string; hash: string }>();
  for (const candidate of candidates) unique.set(`${candidate.owner_id}/${candidate.hash}`, candidate);
  const doomed: { owner_id: string; hash: string }[] = [];
  for (const { owner_id, hash } of unique.values()) {
    const still = db.prepare("SELECT 1 FROM doc_assets WHERE owner_id = ? AND hash = ? LIMIT 1").get(owner_id, hash);
    if (still) continue;
    db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(owner_id, hash);
    doomed.push({ owner_id, hash });
  }
  await eachLimit(doomed, ORPHAN_DELETE_CONCURRENCY, async ({ owner_id, hash }) => {
    // A delete can sit queued behind three others while the same bytes are
    // uploaded again, which writes the object and a fresh row. Removing the
    // object now would leave that row pointing at nothing, so the row this
    // sweep deleted has to still be absent at the moment of the call.
    if (db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND hash = ?").get(owner_id, hash)) return;
    try {
      await store?.delete(`${owner_id}/${hash}`);
    } catch (err) {
      console.error(`asset delete failed for ${owner_id}/${hash}:`, err);
    }
  });
}

// Assets nothing links and nothing is likely to link any more. An upload the
// document cap rejects at the link step was never in the document's previous
// set, so collectOrphans cannot discover it: the row keeps counting against
// the account and the object keeps costing money with no path that removes
// either. The grace period is the whole point of the threshold, because a
// fresh unlinked row is the normal state of an upload whose link push has not
// arrived yet.
export async function sweepOrphans({ olderThanMs = 60 * 60 * 1000 } = {}): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = db
    .prepare(
      `SELECT owner_id, hash FROM assets a WHERE a.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM doc_assets d WHERE d.owner_id = a.owner_id AND d.hash = a.hash)`
    )
    .all(cutoff) as { owner_id: string; hash: string }[];
  await collectOrphans(rows);
  return rows.length;
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
  return { user, level };
}

// A reference nothing should ever be stored under, whoever is asking. None of
// these is a name a renderer could resolve: they are the shapes that turn a
// ref into something else downstream, where it is a Map key, a SQL parameter
// and a query-string value. The cap is on bytes because that is what is
// stored, and it matches the client's own bound on a bare destination run
// (electron/doc-assets.js).
function refIsMalformed(ref: string): boolean {
  if (!ref) return true;
  if (Buffer.byteLength(ref, "utf8") > 2048) return true;
  // Spelled out rather than a regex with literal control characters in it,
  // which every linter and half the editors in the world mangle.
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// A reference that names something outside the document's own folder. This is
// the shape the critical attack needs: a co-editor writes `../notes/x.png`
// into a document's text, and the machine that syncs it resolves that against
// its own disk and uploads whatever is there.
//
// The question is where the reference lands, not which characters it is spelt
// with. `./shot.png` is how a great many people write the file beside the
// document, and a segment a later `..` pops never left the folder either, so
// the segments are walked the way a path resolver walks them: `.` dropped,
// `..` popping, and a pop with nothing left to pop is the moment the
// reference reaches the folder's own parent. Both separators count, because a
// reference is written by hand and Windows text reaches the same table.
//
// Nothing here rewrites the reference. It is stored, matched and served
// exactly as the document wrote it; this only decides whether it may be
// stored at all.
function refEscapes(raw: string): boolean {
  // Read as the path the reference means, not as the characters it is spelt
  // with: `%2e%2e/x.png` is `../x.png` to anything that resolves it, and the
  // client percent-decodes every reference before it sends one, so this is
  // the shape only a client that is not Markie would send. A reference whose
  // name really does contain a stray percent does not decode, and a name is
  // not a reason to refuse a file.
  let ref = raw;
  try {
    ref = decodeURIComponent(raw);
  } catch {
    ref = raw;
  }
  if (ref.startsWith("/") || ref.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(ref)) return true;
  const stack: string[] = [];
  for (const segment of ref.split(/[/\\]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      stack.push(segment);
      continue;
    }
    if (stack.length === 0) return true;
    stack.pop();
  }
  return false;
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

// What this account is already in the middle of uploading, by declared bytes
// and by request count. The committed-usage check alone reads the same
// headroom for every request in flight, so a hundred parallel 100 MB uploads
// all pass it, each buffering a temp file and pushing bytes to the bucket
// before the transaction at the end refuses the excess. A claim taken before
// the body is touched is what makes the cap bound disk and bandwidth, not
// just stored bytes. One process's view only: two server instances still
// reserve independently, and the transactional check on real bytes stays the
// authority on what is actually stored.
const inflight = new Map<string, { bytes: number; count: number }>();
export function inflightForTests(): Map<string, { bytes: number; count: number }> {
  return inflight;
}

// Synchronous on purpose: nothing may await between reading the map and
// writing it, or two requests could both see room for the last byte.
function claimInflight(ownerId: string, declared: number): "account over cap" | "too many uploads" | null {
  const held = inflight.get(ownerId) ?? { bytes: 0, count: 0 };
  if (usageFor(ownerId) + held.bytes + declared > MAX_ACCOUNT_ASSET_BYTES) return "account over cap";
  if (held.count >= MAX_CONCURRENT_UPLOADS) return "too many uploads";
  inflight.set(ownerId, { bytes: held.bytes + declared, count: held.count + 1 });
  return null;
}

function releaseInflight(ownerId: string, declared: number): void {
  const held = inflight.get(ownerId);
  if (!held) return;
  const bytes = held.bytes - declared;
  const count = held.count - 1;
  if (count <= 0) inflight.delete(ownerId);
  else inflight.set(ownerId, { bytes, count });
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
  if (existing && (await store!.head(`${user.id}/${hash}`))) {
    // This answer is a client about to link these bytes, so the row is in use
    // again even though nothing was written. Without a fresh created_at the
    // hourly sweep can take it away between this 200 and the link that
    // follows it.
    db.prepare("UPDATE assets SET created_at = ? WHERE owner_id = ? AND hash = ?").run(new Date().toISOString(), user.id, hash);
    return c.json({ ok: true, hash, size: existing.size });
  }
  // Claimed before anything is read or written, and released in the outer
  // finally below, so a refusal costs the server nothing.
  const refused = claimInflight(user.id, declared);
  if (refused === "account over cap") return c.json({ error: refused, cap: MAX_ACCOUNT_ASSET_BYTES }, 413);
  // Retry-After because the condition clears as soon as one of the four
  // uploads in front of this one finishes, and a client with no number to
  // wait on retries immediately or gives up.
  if (refused) return c.json({ error: refused, limit: MAX_CONCURRENT_UPLOADS }, 429, { "Retry-After": "1" });

  try {
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
  } finally {
    // After the temp directory is gone, so the claim outlives every
    // resource it was standing in for.
    releaseInflight(user.id, declared);
  }
});

// The document's full reference set. An entry with a hash must name an asset
// in the caller's scope; one without keeps whatever link the document already
// has for that ref (an editor pushing text whose pictures the owner uploaded)
// or is dropped.
//
// `baseVersion` is optional and names the text snapshot these links belong to.
// The client sends its links just before the text PUT they describe, so a
// snapshot the server later refuses as stale must not leave its hashes linked
// to the markdown that survived. When it is present the swap only happens if
// the document is still at that version, checked inside the same transaction;
// when it is absent the route behaves as it always has.
assetsApi.put("/docs/:id/assets", async (c) => {
  const unconfigured = requireStore(c);
  if (unconfigured) return unconfigured;
  const docId = c.req.param("id");
  const gate = await requireEditor(c, docId);
  if ("error" in gate) return gate.error;
  const body = (await c.req.json().catch(() => null)) as { refs?: unknown; baseVersion?: unknown } | null;
  if (!Array.isArray(body?.refs)) return c.json({ error: "bad request" }, 400);
  // Before anything is read out of the array: the cost this bounds is the
  // work of walking it and the rows it would leave behind.
  if (body!.refs.length > MAX_DOC_REFS) {
    return c.json({ error: "too many references", cap: MAX_DOC_REFS }, 413);
  }
  // Present but malformed is a client bug, and ignoring it would quietly skip
  // the very check the client asked for.
  const baseVersion = body!.baseVersion;
  if (baseVersion !== undefined && (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0)) {
    return c.json({ error: "bad request" }, 400);
  }
  // Whether anybody but the caller can read this document at the moment these
  // links are claimed. An owner alone with their document wrote every word of
  // it themselves, so a reference that climbs out of its folder is their own
  // repository layout (the spec's `../assets/logo.png`). Anyone else, and any
  // owner whose document has a member, an invite or a public link, is a
  // document whose text a second party can write, and the reference stops
  // being evidence of anything. Read once, before the loop: one link call is
  // one decision about one document.
  const exposed = gate.level !== "owner" || isSharedOut(docId);
  const current = assetRefsFor(docId);
  const next = new Map<string, { owner_id: string; hash: string; size: number }>();
  let linked = 0, kept = 0, dropped = 0;
  // The references the server decided against, and why. An ordinary drop is a
  // reference the document names and nothing holds, and there is nothing to
  // say about it; these two are the server refusing to store something the
  // client offered, and a client that is not told cannot settle the row and
  // stops retrying a body that will never be accepted.
  const droppedRefs: { ref: string; reason: "mime" | "escaping" }[] = [];
  for (const entry of body!.refs as { ref?: unknown; hash?: unknown }[]) {
    const ref = typeof entry?.ref === "string" ? entry.ref : "";
    // Refused, not dropped: a client sending one of these is either broken or
    // hostile, and answering 200 to a body the server silently emptied tells
    // neither of them anything.
    if (refIsMalformed(ref)) return c.json({ error: "bad ref" }, 400);
    // An escaping reference is only dangerous when it carries a hash, because
    // that is the half that stores bytes under it. A bare one stores nothing:
    // it is a document saying "I point at this and could not resolve it", and
    // refusing the body for it would mean a shared document containing
    // ../x.png linked none of its media at all and retried the same refusal
    // on every save and every reconciliation pass for ever. So it is dropped
    // instead, and dropped rather than kept, so bytes already linked under
    // that name do not survive a push from somebody who can only name it.
    const escaping = exposed && refEscapes(ref);
    if (typeof entry.hash === "string") {
      // Before the hash is looked up, so the route cannot be used to ask
      // which hashes an account holds.
      if (escaping) return c.json({ error: "bad ref" }, 400);
      if (!HASH.test(entry.hash)) return c.json({ error: "bad hash" }, 400);
      const own = db.prepare("SELECT size, mime FROM assets WHERE owner_id = ? AND hash = ?").get(gate.user.id, entry.hash) as { size: number; mime: string } | undefined;
      if (!own) return c.json({ error: "unknown asset", hash: entry.hash }, 400);
      // The upload route takes the type from the client and only checks that
      // it is in the allow-list; the reference it is later linked under is
      // never consulted, so HTML bytes declared image/svg+xml were stored and
      // served back under the reference a.png. asset-mime.ts already maps
      // extension to mime, so the two can simply be made to agree. A
      // reference whose extension names no type at all cannot carry a hash
      // either: nothing could serve it honestly.
      //
      // Dropped rather than refused, because an asset row's mime is written
      // once, by the upload that created it, and the dedupe branch returns
      // 200 for bytes the account already holds without touching it. So one
      // set of bytes has exactly one type for the life of the account, and
      // refusing the body made an ordinary rename permanent: the document's
      // other pictures never linked either, and the client retried the same
      // refused body every ten minutes for ever. Nothing is stored under a
      // name that lies about its type either way; only the blast radius
      // changes.
      if (assetMimeFor(ref) !== own.mime) {
        dropped += 1;
        droppedRefs.push({ ref, reason: "mime" });
        continue;
      }
      next.set(ref, { owner_id: gate.user.id, hash: entry.hash, size: own.size });
      linked += 1;
    } else if (!escaping && current.has(ref)) {
      const row = current.get(ref)!;
      next.set(ref, { owner_id: row.owner_id, hash: row.hash, size: row.size });
      kept += 1;
    } else {
      dropped += 1;
      if (escaping) droppedRefs.push({ ref, reason: "escaping" });
    }
  }
  const total = [...next.values()].reduce((n, r) => n + r.size, 0);
  if (total > MAX_DOC_ASSET_BYTES) return c.json({ error: "document over cap", cap: MAX_DOC_ASSET_BYTES }, 413);
  const before = [...current.values()].map((r) => ({ owner_id: r.owner_id, hash: r.hash }));
  // better-sqlite3 transactions are synchronous, so the version read and the
  // swap cannot be interleaved by another request's text PUT.
  const stale = db.transaction(() => {
    if (baseVersion !== undefined) {
      const doc = db.prepare("SELECT version FROM docs WHERE id = ? AND deleted_at IS NULL").get(docId) as { version: number } | undefined;
      if (!doc || doc.version !== baseVersion) return { serverVersion: doc?.version ?? null };
    }
    db.prepare("DELETE FROM doc_assets WHERE doc_id = ?").run(docId);
    const ins = db.prepare("INSERT INTO doc_assets (doc_id, ref, owner_id, hash) VALUES (?, ?, ?, ?)");
    for (const [ref, r] of next) ins.run(docId, ref, r.owner_id, r.hash);
    return null;
  })();
  // Nothing was written, so nothing was orphaned either: leave the previous
  // set, and the bytes the refused set named, exactly as they were.
  if (stale) return c.json({ error: "version mismatch", serverVersion: stale.serverVersion }, 409);
  await collectOrphans(before);
  return c.json({ linked, kept, dropped, droppedRefs });
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
  const row = assetRowFor(docId, ref);
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
  // A ref can be relinked to different bytes while a client holds a partial
  // copy of the old ones. If-Range is how that client asks for the rest only
  // if it is still the same representation; when the validator does not match
  // the answer is the whole thing, never a slice of something else stitched
  // onto what it already has.
  //
  // Compared exactly, not through etagMatches: RFC 9110 13.1.5 takes a strong
  // validator only here, so the weak form of this same ETag is not a match,
  // and a date-form If-Range matches nothing because this route issues no
  // Last-Modified to compare it against. If-None-Match keeps the tolerant
  // comparison, where a weak match is exactly what it is for.
  const ifRange = c.req.header("if-range");
  const rangeHeader = ifRange && ifRange.trim() !== etag ? undefined : c.req.header("range");
  let range: { start: number; end?: number } | undefined;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    // Either group may be empty to mean "to the end" / "the last N bytes",
    // but both empty at once names no bytes at all and must not fall through
    // to being silently served in full.
    if (!m || (!m[1] && !m[2])) return c.text("Range Not Satisfiable", 416);
    if (m[1]) range = { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
    // A suffix asking for at least as many bytes as the object has is asking
    // for the whole object, and the honest answer to that is 200. A 206 with
    // Content-Range 0-4/5 is legal, but a client that reads 206 as "partial"
    // comes back for the rest of something it already holds. A suffix of zero
    // names no bytes at all, which is not the object, and falls through to
    // the 416 the store's own read produces.
    else if (Number(m[2]) >= row.size) range = undefined;
    else range = { start: row.size - Number(m[2]) };
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
