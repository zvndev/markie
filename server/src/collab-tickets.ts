// Passes for the live-editing socket.
//
// A browser WebSocket cannot carry an Authorization header, so the socket's
// credential has to travel in its URL, and the production proxy keeps full
// request URLs, query included, in its log for about a day. The URL used to
// carry the account's session token, which made every live session write an
// account-wide credential to that log. A ticket is what goes there instead:
// it opens one document's room, for one person on one sign-in, for a few
// minutes, and nothing else.
//
// Only a ticket's SHA-256 is stored. The ticket is 32 random bytes, so a fast
// unsalted hash is enough to make a leaked table useless, and looking a ticket
// up by its hash keeps the comparison off the secret itself.
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import { accessLevel, canReadLevel } from "./shares.ts";
import { LEGACY_CLIENT_SCHEMA, clientSchemaFrom, roomSchemaFor } from "./collab-schema.ts";

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS collab_tickets (
    ticket_hash TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_collab_tickets_user ON collab_tickets(user_id, issued_at)");
// The room schema the client asked with (collab-schema.ts). Tickets live five
// minutes, so a table from before the column only needs it added.
if (!(db.prepare("PRAGMA table_info(collab_tickets)").all() as Array<{ name: string }>).some((c) => c.name === "schema")) {
  db.exec(`ALTER TABLE collab_tickets ADD COLUMN schema INTEGER NOT NULL DEFAULT ${LEGACY_CLIENT_SCHEMA}`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_collab_tickets_expiry ON collab_tickets(expires_at)");

// Long enough to outlast the client's two-minute refresh with room to spare
// for a slow network, short enough that a ticket read out of the proxy log
// a day later opens nothing.
export const COLLAB_TICKET_TTL_MS = 5 * 60 * 1000;

// One open document asks for about one ticket every two minutes, plus one per
// reconnect. Sixty a minute is far beyond any honest client and still stops a
// script from filling the table.
export const COLLAB_TICKETS_PER_MINUTE = 60;

// The refusal for a document the caller may not read. It never says whether
// the document exists. Its error code is what tells the desktop this server
// has tickets at all: a server from before them answers this path with the
// generic `{ error: "not found" }`, and the app falls back to the session
// token for that server only (src/lib/auth-client.ts collabTicket).
export const NO_TICKET = { error: "no_ticket" } as const;

// The refusal for a room that holds what the asking build cannot represent
// (collab-schema.ts). Every build reads a 409 as "no live session" and opens
// the document on its own copy.
export const ROOM_TOO_NEW = { error: "room_needs_newer_markie" } as const;

/**
 * Whether one sign-in is still good, read from the session table on every
 * call. better-auth's getSession is not used for this because the per-message
 * checks in collab.ts run it on every keystroke, and a revoked session must
 * stop working on the next one.
 */
export function liveSession(userId: string, sessionId: string): boolean {
  const session = db.prepare('SELECT userId,expiresAt FROM "session" WHERE id=?').get(sessionId) as
    | { userId: string; expiresAt: string | number }
    | undefined;
  if (!session || session.userId !== userId) return false;
  const expiresAt =
    typeof session.expiresAt === "number"
      ? session.expiresAt
      : /^\d+$/.test(session.expiresAt)
        ? Number(session.expiresAt)
        : Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

const hashTicket = (ticket: string) => createHash("sha256").update(ticket, "utf8").digest("hex");

export interface IssuedTicket {
  ticket: string;
  expiresAt: number;
}

/**
 * A new ticket for one person's sign-in on one document, or null when they
 * have asked for too many in the last minute. Expired rows go on the way in,
 * so the table only ever holds tickets that could still be used.
 */
export function issueCollabTicket(
  docId: string,
  userId: string,
  sessionId: string,
  now = Date.now(),
  schema = LEGACY_CLIENT_SCHEMA
): IssuedTicket | null {
  const issue = db.transaction((): IssuedTicket | null => {
    db.prepare("DELETE FROM collab_tickets WHERE expires_at <= ?").run(now);
    const recent = (db
      .prepare("SELECT COUNT(*) AS n FROM collab_tickets WHERE user_id = ? AND issued_at > ?")
      .get(userId, now - 60_000) as { n: number }).n;
    if (recent >= COLLAB_TICKETS_PER_MINUTE) return null;
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + COLLAB_TICKET_TTL_MS;
    db.prepare(
      "INSERT INTO collab_tickets (ticket_hash, doc_id, user_id, session_id, issued_at, expires_at, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(hashTicket(ticket), docId, userId, sessionId, now, expiresAt, schema);
    return { ticket, expiresAt };
  });
  return issue();
}

export interface TicketHolder {
  user: { id: string; name: string | null; email: string | null };
  sessionId: string;
  /** The newest room schema the client can represent (collab-schema.ts). */
  schema: number;
}

/**
 * Who may join `docId`'s room with this ticket, or null. Everything is
 * re-derived here rather than trusted from the moment of issue: the sign-in
 * behind it may have ended and the share may have gone in the minutes since.
 * A ticket is reusable until it expires, because y-websocket reconnects with
 * the URL it already has.
 */
export function redeemCollabTicket(ticket: string, docId: string, now = Date.now()): TicketHolder | null {
  if (!ticket) return null;
  const row = db
    .prepare("SELECT doc_id, user_id, session_id, expires_at, schema FROM collab_tickets WHERE ticket_hash = ?")
    .get(hashTicket(ticket)) as
    | { doc_id: string; user_id: string; session_id: string; expires_at: number; schema: number | null }
    | undefined;
  if (!row || row.doc_id !== docId || row.expires_at <= now) return null;
  if (!liveSession(row.user_id, row.session_id)) return null;
  if (!canReadLevel(accessLevel(docId, row.user_id))) return null;
  const user = db.prepare("SELECT id, name, email FROM user WHERE id = ?").get(row.user_id) as
    | TicketHolder["user"]
    | undefined;
  return user ? { user, sessionId: row.session_id, schema: row.schema ?? LEGACY_CLIENT_SCHEMA } : null;
}

export const collabTickets = new Hono();

collabTickets.post("/:id/collab-ticket", async (c) => {
  // The answer is a credential.
  c.header("Cache-Control", "private, no-store");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user || !session.session?.id || !liveSession(session.user.id, session.session.id)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const docId = c.req.param("id");
  if (!canReadLevel(accessLevel(docId, session.user.id))) return c.json(NO_TICKET, 404);
  // A build from before the field sends `{}`; one that sends nothing at all
  // is read the same way.
  const schema = clientSchemaFrom(await c.req.json().catch(() => null));
  if (roomSchemaFor(docId) > schema) return c.json(ROOM_TOO_NEW, 409);
  const issued = issueCollabTicket(docId, session.user.id, session.session.id, Date.now(), schema);
  if (!issued) {
    c.header("Retry-After", "60");
    return c.json({ error: "rate_limited" }, 429);
  }
  return c.json(issued);
});
