// Pointers from one document to another. A document that says
// `[the plan](plan.md)` has, on the author's machine, a file beside it; here
// that file is a cloud document id the author's Markie resolved before it
// pushed. Nothing about the target moves with the pointer: whether a reader
// may follow it is decided here, per reader, at read time, by the same access
// lookups every other route uses.
//
// Storing a pointer checks nothing about its target on purpose. A route that
// refused pointers at unknown ids would confirm which ids exist, which
// /d/:id goes out of its way not to do.
import { Hono, type Context } from "hono";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import { accessLevel, canEditLevel, canReadLevel } from "./shares.ts";
import { getPublicLinkToken } from "./public-links.ts";

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS doc_links (
    doc_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (doc_id, ref)
  );
`);

export const MAX_DOC_LINKS = 500;
// Ids are minted by the client (crypto.randomUUID today), so the shape check
// is a bound on the string, not a claim about its format.
const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Same rule as a media reference (server/src/assets.ts): bounded, and no
// control characters, spelled out because editors mangle literal ones.
function refIsMalformed(ref: string): boolean {
  if (!ref) return true;
  if (Buffer.byteLength(ref, "utf8") > 2048) return true;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function requireUser(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

function docExists(docId: string): boolean {
  return !!db.prepare("SELECT 1 FROM docs WHERE id = ? AND deleted_at IS NULL").get(docId);
}

// 404 for "no such document" and "not yours" alike: telling them apart would
// make the route an oracle for document ids.
async function requireEditor(c: Context, docId: string) {
  const user = await requireUser(c);
  if (!user) return { error: c.json({ error: "unauthorized" }, 401) };
  const level = accessLevel(docId, user.id);
  if (!docExists(docId) || level === null) return { error: c.json({ error: "not found" }, 404) };
  if (!canEditLevel(level)) return { error: c.json({ error: "forbidden" }, 403) };
  return { user, level };
}

async function requireReader(c: Context, docId: string) {
  const user = await requireUser(c);
  if (!user) return { error: c.json({ error: "unauthorized" }, 401) };
  const level = accessLevel(docId, user.id);
  if (!docExists(docId) || !canReadLevel(level)) return { error: c.json({ error: "not found" }, 404) };
  return { user, level };
}

export function docLinksFor(docId: string): Map<string, string> {
  // ORDER BY rowid: without it, SQLite answers this WHERE from the (doc_id,
  // ref) primary key index and hands rows back sorted by ref, not the order
  // they were stored in.
  const rows = db.prepare("SELECT ref, target_id FROM doc_links WHERE doc_id = ? ORDER BY rowid").all(docId) as { ref: string; target_id: string }[];
  return new Map(rows.map((r) => [r.ref, r.target_id]));
}

export function removeDocLinks(docId: string): number {
  return db.prepare("DELETE FROM doc_links WHERE doc_id = ?").run(docId).changes;
}

// Whether this reader may open the target: it exists, is not deleted, and the
// share tables say yes. The only question a pointer ever asks.
export function readableTarget(targetId: string, userId: string): boolean {
  return docExists(targetId) && canReadLevel(accessLevel(targetId, userId));
}

export type DocLinkAnswer = { href: string } | { muted: true } | null;

// The shared page's answer per reference: a page the reader may open, a muted
// link, or nothing to say (the document stored no pointer for it).
export function sharedPageLinkFor(docId: string, userId: string | null): (ref: string) => DocLinkAnswer {
  const rows = docLinksFor(docId);
  // Keyed by target, not ref: several refs in one document can name the same
  // target, and each one otherwise repeats the same docExists + accessLevel
  // lookups (500 links to a handful of targets is 1000 queries per render).
  const cache = new Map<string, DocLinkAnswer>();
  return (ref) => {
    const target = rows.get(ref);
    if (target === undefined) return null;
    const cached = cache.get(target);
    if (cached !== undefined) return cached;
    const answer: DocLinkAnswer =
      userId && readableTarget(target, userId) ? { href: `/d/${encodeURIComponent(target)}` } : { muted: true };
    cache.set(target, answer);
    return answer;
  };
}

// The public page's answer: a public page can only lead to another public
// page, so a target without a live public link is muted.
export function publicPageLinkFor(docId: string): (ref: string) => DocLinkAnswer {
  const rows = docLinksFor(docId);
  // Same per-target memo as sharedPageLinkFor, and worth more here: this path
  // is unauthenticated, so a page with many repeated links is a free way to
  // run its docExists + getPublicLinkToken lookups over and over.
  const cache = new Map<string, DocLinkAnswer>();
  return (ref) => {
    const target = rows.get(ref);
    if (target === undefined) return null;
    const cached = cache.get(target);
    if (cached !== undefined) return cached;
    let answer: DocLinkAnswer;
    if (!docExists(target)) {
      answer = { muted: true };
    } else {
      const token = getPublicLinkToken(target);
      answer = token ? { href: `/s/${encodeURIComponent(token)}` } : { muted: true };
    }
    cache.set(target, answer);
    return answer;
  };
}

export const docLinksApi = new Hono();

docLinksApi.put("/docs/:id/links", async (c) => {
  const docId = c.req.param("id");
  const gate = await requireEditor(c, docId);
  if ("error" in gate) return gate.error;
  const body = (await c.req.json().catch(() => null)) as { links?: unknown; baseVersion?: unknown } | null;
  if (!Array.isArray(body?.links)) return c.json({ error: "bad request" }, 400);
  // Before the array is walked: the cost this bounds is the walk itself and
  // the rows it would leave behind.
  if (body!.links.length > MAX_DOC_LINKS) return c.json({ error: "too many links", cap: MAX_DOC_LINKS }, 413);
  const baseVersion = body!.baseVersion;
  if (baseVersion !== undefined && (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0)) {
    return c.json({ error: "bad request" }, 400);
  }
  const next = new Map<string, string>();
  for (const entry of body!.links as { ref?: unknown; target?: unknown }[]) {
    const ref = typeof entry?.ref === "string" ? entry.ref : "";
    const target = typeof entry?.target === "string" ? entry.target : "";
    if (refIsMalformed(ref)) return c.json({ error: "bad ref" }, 400);
    if (!TARGET_ID.test(target)) return c.json({ error: "bad target" }, 400);
    // The client dedupes, so a repeat is a client bug worth hearing about
    // rather than a last-one-wins the client could not predict.
    if (next.has(ref)) return c.json({ error: "duplicate ref" }, 400);
    next.set(ref, target);
  }
  // better-sqlite3 transactions are synchronous, so the version read and the
  // swap cannot interleave with another request's text PUT.
  const stale = db.transaction(() => {
    if (baseVersion !== undefined) {
      const doc = db.prepare("SELECT version FROM docs WHERE id = ? AND deleted_at IS NULL").get(docId) as { version: number } | undefined;
      if (!doc || doc.version !== baseVersion) return { serverVersion: doc?.version ?? null };
    }
    db.prepare("DELETE FROM doc_links WHERE doc_id = ?").run(docId);
    const ins = db.prepare("INSERT INTO doc_links (doc_id, ref, target_id) VALUES (?, ?, ?)");
    for (const [ref, target] of next) ins.run(docId, ref, target);
    return null;
  })();
  if (stale) return c.json({ error: "version mismatch", serverVersion: stale.serverVersion }, 409);
  return c.json({ linked: next.size });
});

docLinksApi.get("/docs/:id/links", async (c) => {
  const docId = c.req.param("id");
  const gate = await requireReader(c, docId);
  if ("error" in gate) return gate.error;
  const links = [...docLinksFor(docId)].map(([ref, target]) =>
    readableTarget(target, gate.user.id) ? { ref, target } : { ref }
  );
  return c.json({ links });
});
