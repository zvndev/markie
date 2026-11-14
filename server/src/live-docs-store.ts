// What hosted Live Docs keep in the database: each Live Doc's address, the
// one-time passes that open it, and the cookies a pass turns into.
//
//   live_doc_addresses  doc id -> label. The label is 80 random bits, never
//                       derived from the doc id, so an address says nothing
//                       about the document and cannot be worked out from it.
//   live_doc_tickets    a pass: single use, 60 seconds, for one document,
//                       one person, one sign-in, one label and one browser
//                       (the hash of a nonce cookie the live host set before
//                       sending the browser for the pass). Stored hashed.
//   live_doc_sessions   what a pass becomes on the Live Doc's own host: a
//                       random cookie value, stored hashed, bound the same way.
//   live_doc_public_addresses
//                       a public Live Doc's second address, opened with no
//                       sign-in. Bound to the hash of the document's current
//                       public link token (public-links.ts), so rotating or
//                       revoking that link kills this address in the same
//                       moment, with nothing here to update.
//   live_doc_takedowns  Live Docs Markie has taken down. A taken-down doc is
//                       hosted at no level until it is restored
//                       (scripts/live-doc-takedown.ts).
//
// Nothing here decides access on its own. Every page load re-reads the doc,
// the person's Markie sign-in and their access level (live-docs.ts), so a
// deleted document, an ended sign-in or a removed share refuses the next load
// whatever these tables still hold.
//
// Tickets and cookie values are 32 random bytes and only their SHA-256 is
// kept, the same reasoning as collab-tickets.ts: a leaked table opens nothing,
// and the lookup is by hash, off the secret itself.
import { createHash, randomBytes } from "node:crypto";
import { openDatabase } from "./db.ts";
import { accessLevel, type ShareAccessLevel } from "./shares.ts";
import { getPublicLinkToken } from "./public-links.ts";
import { LIVE_DOC_LABEL } from "./live-docs-config.ts";

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS live_doc_addresses (
    doc_id TEXT PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS live_doc_tickets (
    ticket_hash TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    auth_session_id TEXT NOT NULL,
    label TEXT NOT NULL,
    state_hash TEXT NOT NULL DEFAULT '',
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_live_doc_tickets_user ON live_doc_tickets(user_id, issued_at);
  CREATE INDEX IF NOT EXISTS idx_live_doc_tickets_expiry ON live_doc_tickets(expires_at);
  CREATE TABLE IF NOT EXISTS live_doc_sessions (
    session_hash TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    auth_session_id TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_live_doc_sessions_doc ON live_doc_sessions(doc_id);
  CREATE INDEX IF NOT EXISTS idx_live_doc_sessions_auth ON live_doc_sessions(auth_session_id, label, created_at);
  CREATE INDEX IF NOT EXISTS idx_live_doc_sessions_user ON live_doc_sessions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_live_doc_sessions_expiry ON live_doc_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS live_doc_public_addresses (
    label TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_live_doc_public_doc ON live_doc_public_addresses(doc_id);
  CREATE TABLE IF NOT EXISTS live_doc_takedowns (
    doc_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// A database made before passes were bound to a browser: add the column. A
// pass row without it can never be redeemed, since redeem requires a match.
if (!(db.prepare("PRAGMA table_info(live_doc_tickets)").all() as Array<{ name: string }>).some((column) => column.name === "state_hash")) {
  db.exec("ALTER TABLE live_doc_tickets ADD COLUMN state_hash TEXT NOT NULL DEFAULT ''");
}

/** How long a pass is good for, from the app host's redirect to the live host's redeem. */
export const LIVE_DOC_TICKET_TTL_MS = 60 * 1000;
/** How long the Live Doc cookie lasts. The Markie sign-in behind it is re-checked on every load. */
export const LIVE_DOC_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// One person opening their Live Docs needs a pass per tab they open. Thirty a
// minute is far beyond that and still stops a script filling the table.
export const LIVE_DOC_TICKETS_PER_MINUTE = 30;
// Each pass redeemed adds a cookie row, so the same bound applies there.
export const LIVE_DOC_SESSIONS_PER_USER = 200;

const hash = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 10 random bytes as 16 lowercase base32 characters: exactly 80 bits, DNS-safe. */
export function newLiveDocLabel(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function liveDocLabel(docId: string): string | null {
  const row = db.prepare("SELECT label FROM live_doc_addresses WHERE doc_id = ?").get(docId) as { label: string } | undefined;
  return row?.label ?? null;
}

/** The doc's label, minted on first use. Stable for the life of the document. */
export function ensureLiveDocLabel(docId: string, now = Date.now()): string {
  const existing = liveDocLabel(docId);
  if (existing) return existing;
  // A collision between two 80-bit labels will not happen, but if it ever
  // did the UNIQUE constraint refuses it and a fresh label is drawn.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = newLiveDocLabel();
    if (labelTaken(candidate)) continue;
    try {
      db.prepare("INSERT OR IGNORE INTO live_doc_addresses (doc_id, label, created_at) VALUES (?, ?, ?)").run(docId, candidate, now);
    } catch (error) {
      if (!(error instanceof Error) || !/UNIQUE/i.test(error.message)) throw error;
      continue;
    }
    const label = liveDocLabel(docId);
    if (label) return label;
  }
  throw new Error("could not assign a Live Doc address");
}

/** Whether a label is in use as any Live Doc address, private or public. */
function labelTaken(label: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM live_doc_addresses WHERE label = ?").get(label)
      ?? db.prepare("SELECT 1 FROM live_doc_public_addresses WHERE label = ?").get(label)
  );
}

/** Which document a label addresses, or null. Says nothing about who may open it. */
export function docIdForLabel(label: string): string | null {
  if (!LIVE_DOC_LABEL.test(label)) return null;
  const row = db.prepare("SELECT doc_id FROM live_doc_addresses WHERE label = ?").get(label) as { doc_id: string } | undefined;
  return row?.doc_id ?? null;
}

export interface LiveDocMeta {
  id: string;
  name: string;
  ownerId: string;
}

export interface LiveDocRow extends LiveDocMeta {
  /** null when the source is too large to host, so it was never read. */
  content: string | null;
  /** The document's version, so an open page can tell when it has changed. */
  version: number;
}

// The most a hosted page ever reads of a source: 200,000 characters (the
// compile limit, live-docs-compile.ts) at four UTF-8 bytes each. Anything
// larger is refused without its text leaving the database.
export const LIVE_DOC_READ_BYTES = 200_000 * 4;

/**
 * Whether a document is a Live Doc right now (present, not deleted, format
 * darkmown), and whose. Never reads the document's text, so every access
 * check, including the ones an open tab repeats, costs the same however
 * large the document is.
 */
export function liveDocMeta(docId: string): LiveDocMeta | null {
  // INDEXED BY: deleted_at and format sit after content in the row, and the
  // planner, with no statistics, would read the row itself and walk the
  // text's overflow pages to reach them. The covering index (docs.ts) holds
  // every column this reads.
  const row = db
    .prepare("SELECT id, name, owner_id FROM docs INDEXED BY idx_docs_access WHERE id = ? AND deleted_at IS NULL AND format = 'darkmown'")
    .get(docId) as { id: string; name: string; owner_id: string } | undefined;
  return row ? { id: row.id, name: row.name, ownerId: row.owner_id } : null;
}

/**
 * A Live Doc with its text, for rendering the page only. The size is checked
 * in SQL first (octet_length reads it from the record header), so a source
 * over LIVE_DOC_READ_BYTES comes back with content null, unread.
 */
export function loadLiveDoc(docId: string): LiveDocRow | null {
  const meta = liveDocMeta(docId);
  if (!meta) return null;
  // Only content is read from the row, and it sits before every column the
  // check above needed, so a refused size costs a header read, nothing more.
  const row = db
    .prepare("SELECT version, CASE WHEN octet_length(content) <= ? THEN content END AS content FROM docs WHERE id = ?")
    .get(LIVE_DOC_READ_BYTES, docId) as { version: number; content: string | null } | undefined;
  return row ? { ...meta, content: row.content, version: row.version } : null;
}

/**
 * The document's version now, or null. version sits before content in the
 * row, so this never reads the text however large it is; an open page's
 * stream asks it on every check.
 */
export function liveDocVersion(docId: string): number | null {
  const row = db.prepare("SELECT version FROM docs WHERE id = ?").get(docId) as { version: number } | undefined;
  return typeof row?.version === "number" ? row.version : null;
}

/**
 * Which access levels open a Live Doc's private address: the owner and every
 * member it is shared with, viewer or editor, the same people who can read the
 * document in Markie (design, "Who can see a Live Doc"). A pending invite is
 * not a member until it is claimed by a verified account, so it opens nothing.
 */
export function liveDocLevelOpens(level: ShareAccessLevel): boolean {
  return level === "owner" || level === "editor" || level === "viewer";
}

/** Whether `userId` may open `docId` as a hosted Live Doc, read live from the database. */
export function canOpenLiveDoc(docId: string, userId: string): boolean {
  return liveDocMeta(docId) !== null && !liveDocTakenDown(docId) && liveDocLevelOpens(accessLevel(docId, userId));
}

// ---------------------------------------------------------------- public

/**
 * The public address for a Live Doc whose public link is on, minted on first
 * use and replaced whenever the link's token changes. null when the document
 * has no public link, is not a Live Doc, or is taken down. Only the owner may
 * be shown this (the caller checks); it needs no sign-in to open.
 */
export function ensurePublicLiveDocLabel(docId: string, now = Date.now()): string | null {
  if (!liveDocMeta(docId) || liveDocTakenDown(docId)) return null;
  const token = getPublicLinkToken(docId);
  if (!token) return null;
  const tokenHash = hash(token);
  return db.transaction(() => {
    const current = db
      .prepare("SELECT label FROM live_doc_public_addresses WHERE doc_id = ? AND token_hash = ?")
      .get(docId, tokenHash) as { label: string } | undefined;
    if (current) return current.label;
    // A link that was rotated or revoked and switched back on: its old address
    // already opens nothing, and this clears it away.
    db.prepare("DELETE FROM live_doc_public_addresses WHERE doc_id = ?").run(docId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const label = newLiveDocLabel();
      if (labelTaken(label)) continue;
      db.prepare("INSERT INTO live_doc_public_addresses (label, doc_id, token_hash, created_at) VALUES (?, ?, ?, ?)").run(label, docId, tokenHash, now);
      return label;
    }
    throw new Error("could not assign a public Live Doc address");
  })();
}

/**
 * The document a public address opens right now, or null. Checked against the
 * document's current public link on every call: a rotated or revoked link, a
 * deleted or renamed document, or a takedown answers null at once.
 */
export function publicLiveDocFor(label: string): string | null {
  if (!LIVE_DOC_LABEL.test(label)) return null;
  const row = db
    .prepare("SELECT doc_id, token_hash FROM live_doc_public_addresses WHERE label = ?")
    .get(label) as { doc_id: string; token_hash: string } | undefined;
  if (!row) return null;
  const token = getPublicLinkToken(row.doc_id);
  if (!token || hash(token) !== row.token_hash) return null;
  if (!liveDocMeta(row.doc_id) || liveDocTakenDown(row.doc_id)) return null;
  return row.doc_id;
}

/**
 * The name a public page shows as its publisher (design, "Security model" 6):
 * the owner's display name, never their email address. A name that is just
 * the email's local part (what a sign-up fills in when nobody types a name)
 * would give the address away next to a guessable domain, so it is not shown
 * either. The owner is told which name the page shows when they copy its
 * address.
 */
export function liveDocPublisherName(docId: string): string {
  const row = db
    .prepare('SELECT u.name AS name, u.email AS email FROM docs d JOIN "user" u ON u.id = d.owner_id WHERE d.id = ?')
    .get(docId) as { name: string | null; email: string | null } | undefined;
  const name = row?.name?.trim().replace(/\s+/g, " ").slice(0, 80) ?? "";
  const local = row?.email?.split("@")[0]?.trim().toLowerCase() ?? "";
  if (!name || name.toLowerCase() === local || name.includes("@")) return "a Markie account";
  return name;
}

// ---------------------------------------------------------------- takedowns

export function liveDocTakenDown(docId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM live_doc_takedowns WHERE doc_id = ?").get(docId));
}

/**
 * Takes a Live Doc down at every level. Its open tabs close on their next
 * check (this runs from a script, in another process, so the timer finds it).
 */
export function takeDownLiveDoc(docId: string, reason: string, now = Date.now()): void {
  db.transaction(() => {
    db.prepare("INSERT INTO live_doc_takedowns (doc_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at")
      .run(docId, reason.slice(0, 500), now);
    db.prepare("DELETE FROM live_doc_sessions WHERE doc_id = ?").run(docId);
    db.prepare("DELETE FROM live_doc_tickets WHERE doc_id = ?").run(docId);
    // The public address stays, so a visitor holding it is told the page was
    // taken down rather than sent to a sign-in.
  })();
}

export function restoreLiveDoc(docId: string): boolean {
  return db.prepare("DELETE FROM live_doc_takedowns WHERE doc_id = ?").run(docId).changes > 0;
}

/** The document behind a private or public label, for the takedown script. */
export function docIdForAnyLabel(label: string): string | null {
  if (!LIVE_DOC_LABEL.test(label)) return null;
  const row = (db.prepare("SELECT doc_id FROM live_doc_addresses WHERE label = ?").get(label)
    ?? db.prepare("SELECT doc_id FROM live_doc_public_addresses WHERE label = ?").get(label)) as { doc_id: string } | undefined;
  return row?.doc_id ?? null;
}

export interface LiveDocBinding {
  docId: string;
  userId: string;
  authSessionId: string;
  label: string;
}

/**
 * A new pass, or null when this person has asked for too many in the last
 * minute. Expired rows go on the way in, so the table only ever holds passes
 * that could still be used.
 */
export function issueLiveDocTicket(binding: LiveDocBinding, stateHash: string, now = Date.now()): { ticket: string; expiresAt: number } | null {
  if (!/^[a-f0-9]{64}$/.test(stateHash)) throw new Error("a pass needs the browser's state hash");
  return db.transaction(() => {
    db.prepare("DELETE FROM live_doc_tickets WHERE expires_at <= ?").run(now);
    const recent = (db
      .prepare("SELECT COUNT(*) AS n FROM live_doc_tickets WHERE user_id = ? AND issued_at > ?")
      .get(binding.userId, now - 60_000) as { n: number }).n;
    if (recent >= LIVE_DOC_TICKETS_PER_MINUTE) return null;
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + LIVE_DOC_TICKET_TTL_MS;
    db.prepare(
      "INSERT INTO live_doc_tickets (ticket_hash, doc_id, user_id, auth_session_id, label, state_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(hash(ticket), binding.docId, binding.userId, binding.authSessionId, binding.label, stateHash, now, expiresAt);
    return { ticket, expiresAt };
  })();
}

/**
 * Spends a pass on `label`'s host, from the browser holding `stateNonce`. The
 * row is deleted in the same statement that reads it, so two requests racing
 * with one pass cannot both win, and a pass shown to the wrong host or from
 * the wrong browser is burned rather than kept for the right one.
 */
export function consumeLiveDocTicket(
  ticket: string,
  label: string,
  nonceFor: (stateHash: string) => string | null,
  now = Date.now(),
): (LiveDocBinding & { stateHash: string }) | null {
  if (!ticket || ticket.length > 128) return null;
  const row = db
    .prepare("DELETE FROM live_doc_tickets WHERE ticket_hash = ? RETURNING doc_id, user_id, auth_session_id, label, state_hash, expires_at")
    .get(hash(ticket)) as { doc_id: string; user_id: string; auth_session_id: string; label: string; state_hash: string; expires_at: number } | undefined;
  if (!row || row.label !== label || row.expires_at <= now || !/^[a-f0-9]{64}$/.test(row.state_hash)) return null;
  // The browser's nonce for this flow, from the cookie named after it.
  const stateNonce = nonceFor(row.state_hash);
  if (!stateNonce || stateNonce.length > 128 || hash(stateNonce) !== row.state_hash) return null;
  return { docId: row.doc_id, userId: row.user_id, authSessionId: row.auth_session_id, label: row.label, stateHash: row.state_hash };
}

/** A fresh browser nonce for the pass, and the hash the app host is told. */
export function newLiveDocState(): { nonce: string; hash: string } {
  const nonce = randomBytes(32).toString("base64url");
  return { nonce, hash: hash(nonce) };
}

/** The cookie value for a redeemed pass. Only its hash is stored. */
export function createLiveDocSession(binding: LiveDocBinding, now = Date.now()): { value: string; expiresAt: number } {
  return db.transaction(() => {
    db.prepare("DELETE FROM live_doc_sessions WHERE expires_at <= ?").run(now);
    // Oldest first, so a person who has opened hundreds keeps their newest.
    db.prepare(
      `DELETE FROM live_doc_sessions WHERE session_hash IN (
         SELECT session_hash FROM live_doc_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?
       )`
    ).run(binding.userId, LIVE_DOC_SESSIONS_PER_USER - 1);
    const value = randomBytes(32).toString("base64url");
    const expiresAt = now + LIVE_DOC_SESSION_TTL_MS;
    db.prepare(
      "INSERT INTO live_doc_sessions (session_hash, doc_id, user_id, auth_session_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(hash(value), binding.docId, binding.userId, binding.authSessionId, binding.label, now, expiresAt);
    return { value, expiresAt };
  })();
}

/** Who a cookie value on `label`'s host belongs to, or null. A cookie for another label is no cookie. */
export function liveDocSessionFor(value: string, label: string, now = Date.now()): LiveDocBinding | null {
  if (!value || value.length > 128) return null;
  const row = db
    .prepare("SELECT doc_id, user_id, auth_session_id, label, expires_at FROM live_doc_sessions WHERE session_hash = ?")
    .get(hash(value)) as { doc_id: string; user_id: string; auth_session_id: string; label: string; expires_at: number } | undefined;
  if (!row || row.label !== label || row.expires_at <= now) return null;
  return { docId: row.doc_id, userId: row.user_id, authSessionId: row.auth_session_id, label: row.label };
}

/** Records that a cookie value opened its page, which is how a cookie that stuck is told from one that did not. */
export function markLiveDocSessionUsed(value: string, now = Date.now()): void {
  db.prepare("UPDATE live_doc_sessions SET used_at = ? WHERE session_hash = ? AND used_at IS NULL").run(now, hash(value));
}

// A browser that refuses the Live Doc cookie (cookies off, or Safari on a
// plain-http local address) would otherwise go round live host, pass, redeem
// and back until it gives up with "too many redirects". Each turn leaves one
// cookie row that never opens a page. Two of those for one sign-in and label
// in this window is that loop, not a person opening two tabs.
export const LIVE_DOC_LOOP_WINDOW_MS = 20_000;
export const LIVE_DOC_LOOP_LIMIT = 2;

/** Whether this sign-in's browser is going round the pass without keeping the cookie. */
export function liveDocCookieRefused(authSessionId: string, label: string, now = Date.now()): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM live_doc_sessions WHERE auth_session_id = ? AND label = ? AND used_at IS NULL AND created_at > ?")
    .get(authSessionId, label, now - LIVE_DOC_LOOP_WINDOW_MS) as { n: number };
  return row.n >= LIVE_DOC_LOOP_LIMIT;
}

export function endLiveDocSession(value: string): void {
  if (value) db.prepare("DELETE FROM live_doc_sessions WHERE session_hash = ?").run(hash(value));
}

/**
 * Everything hosted for one document: its address, its passes and its
 * cookies. Called when the document is deleted, so a revived id starts with
 * a new address. Access already fails on the next load without this; this
 * makes sure nothing is left that could ever point at it again.
 */
export function removeLiveDoc(docId: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM live_doc_sessions WHERE doc_id = ?").run(docId);
    db.prepare("DELETE FROM live_doc_tickets WHERE doc_id = ?").run(docId);
    db.prepare("DELETE FROM live_doc_addresses WHERE doc_id = ?").run(docId);
    db.prepare("DELETE FROM live_doc_public_addresses WHERE doc_id = ?").run(docId);
  })();
}
