// Who may put documents in whose Markie.
//
// Kirby's rule, 2026-11-15: nothing lands in a person's Markie because
// someone else chose to send it. A recipient accepts a sender once, and from
// then on that sender's shares land.
//
// Two tables, keyed on (recipient, sender), where the sender is always the
// document's owner, the only account that can share it:
//
//   share_people    the recipient's decision about a sender: 'accepted' or
//                   'blocked'. No row means they have not answered yet.
//   share_requests  shares from a sender the recipient has not accepted.
//                   They live here, never in `shares` or `dp_members`, so
//                   no query on those tables can reach them, a server build
//                   from before this rule included. A row moves into `shares`
//                   (a Markdown or Live Doc) or `dp_members` (a document
//                   platform file) only when the recipient accepts the sender.
//                   A share from a sender already accepted goes straight
//                   there and never passes through this table.
//
// A blocked sender's requests stay in share_requests, hidden from the
// recipient, so the sender's own view ("waiting for them to accept") cannot
// tell a block from silence. They never move into `shares` while the block
// stands, and no build, old or new, reads them as access.
//
// The accepted-sender gate (acceptedSenderSql) still sits on every query that
// reads `shares` or `dp_members` for a recipient, as defense in depth: a row
// that somehow got there without an accept still grants nothing.
//
// Dependency-free on purpose (only a database handle comes in, plus the
// dependency-free text guard): shares.ts, pending.ts and the document
// platform store all build on it.

import { plainEmailText } from "./invite-guard.ts";

/** A share refused because the sender already has MAX_REQUESTS_PER_SENDER requests waiting on this person. */
export class RequestLimitError extends Error {
  constructor() {
    super("This person already has many of your shares waiting. Wait until they answer.");
  }
}

/** The structural subset of better-sqlite3 every caller's handle provides. */
export interface PeopleDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...args: (string | number | null)[]): unknown;
    all(...args: (string | number | null)[]): unknown[];
    run(...args: (string | number | null)[]): { changes: number | bigint };
  };
}

export type SenderState = "accepted" | "blocked";
export type RequestKind = "doc" | "file";
type Role = "viewer" | "editor";

/**
 * SQL that is true when `recipient` has accepted `sender`. Both arguments are
 * column references from the calling query (never user input), such as
 * `s.user_id` and `d.owner_id`.
 */
export function acceptedSenderSql(recipient: string, sender: string): string {
  return `EXISTS (SELECT 1 FROM share_people sp WHERE sp.recipient_id = ${recipient} AND sp.sender_id = ${sender} AND sp.state = 'accepted')`;
}

/** SQL that is true when `recipient` has blocked `sender`. */
function blockedSenderSql(recipient: string, sender: string): string {
  return `EXISTS (SELECT 1 FROM share_people sp WHERE sp.recipient_id = ${recipient} AND sp.sender_id = ${sender} AND sp.state = 'blocked')`;
}

/** SQL true when a Markdown document `doc` (a column reference) has a request open, for "shared out" checks. */
export function docRequestedSql(doc: string): string {
  return `EXISTS (SELECT 1 FROM share_requests r WHERE r.kind = 'doc' AND r.doc_id = ${doc})`;
}

// Migrations, each recorded by name so it runs once per database.
//
// BACKFILL: everybody who shares with somebody today counts as accepted, so
// introducing the rule takes nothing away from anyone. Never re-run: after
// it, a share from a sender the recipient has not accepted is a request, and
// a re-run would accept every one that ever got into `shares`.
//
// MOVE, on every start, not once: a row in `shares` or `dp_members` for a
// recipient who has not accepted the owner moves into share_requests. A
// server rolled back to a build from before this rule writes shares straight
// into `shares`; rolled forward again, those rows would otherwise be orphans
// the recipient never sees as a request and the owner's list never shows.
// It touches only unaccepted rows, and it is a read when there are none. The
// newest role the owner asked for wins when it meets an existing request.
export const BACKFILL_MIGRATION = "share-people-backfill-2026-11-15";

/** Requests one sender may have waiting on one recipient. More are refused, blocked or not. */
export const MAX_REQUESTS_PER_SENDER = 20;
/** The newest requests a listing returns; the total comes with it. */
export const REQUESTS_LISTED = 50;
const NAME_LIMIT = 120;
const PERSON_LIMIT = 60;

const tableExists = (db: PeopleDatabase, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const ran = (db: PeopleDatabase, name: string) =>
  !!db.prepare("SELECT 1 FROM share_people_migrations WHERE name = ?").get(name);

function inWriteTransaction(db: PeopleDatabase, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* keep the original failure */
    }
    throw error;
  }
}

/** Creates the tables if needed and runs each migration once per database. */
export function ensureSharePeopleSchema(db: PeopleDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_people (
      recipient_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('accepted','blocked')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (recipient_id, sender_id)
    );
    CREATE INDEX IF NOT EXISTS idx_share_people_sender ON share_people(sender_id);
    CREATE TABLE IF NOT EXISTS share_requests (
      kind TEXT NOT NULL CHECK (kind IN ('doc','file')),
      doc_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      invited_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token TEXT,
      PRIMARY KEY (kind, doc_id, recipient_id)
    );
    CREATE INDEX IF NOT EXISTS idx_share_requests_recipient ON share_requests(recipient_id, sender_id);
    CREATE INDEX IF NOT EXISTS idx_share_requests_doc ON share_requests(kind, doc_id);
    CREATE TABLE IF NOT EXISTS share_people_migrations (
      name TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL
    );
  `);
  const markdown = tableExists(db, "shares") && tableExists(db, "docs");
  const files = tableExists(db, "dp_members") && tableExists(db, "dp_documents");
  const unacceptedShare = `s.user_id <> d.owner_id AND NOT ${acceptedSenderSql("s.user_id", "d.owner_id")}`;
  const unacceptedMember = `m.user_id <> d.owner_id AND NOT ${acceptedSenderSql("m.user_id", "d.owner_id")}`;
  const strays = () =>
    (markdown && !!db.prepare(`SELECT 1 FROM shares s JOIN docs d ON d.id = s.doc_id WHERE ${unacceptedShare} LIMIT 1`).get()) ||
    (files && !!db.prepare(`SELECT 1 FROM dp_members m JOIN dp_documents d ON d.id = m.doc_id WHERE ${unacceptedMember} LIMIT 1`).get());
  if (ran(db, BACKFILL_MIGRATION) && !strays()) return;
  inWriteTransaction(db, () => {
    // Re-checked under the write lock: another handle may have done it.
    const now = new Date().toISOString();
    if (!ran(db, BACKFILL_MIGRATION)) {
      if (markdown) {
        db.prepare(
          `INSERT OR IGNORE INTO share_people (recipient_id, sender_id, state, updated_at)
           SELECT DISTINCT s.user_id, d.owner_id, 'accepted', ?
             FROM shares s JOIN docs d ON d.id = s.doc_id
            WHERE s.user_id <> d.owner_id`
        ).run(now);
      }
      if (files) {
        db.prepare(
          `INSERT OR IGNORE INTO share_people (recipient_id, sender_id, state, updated_at)
           SELECT DISTINCT m.user_id, d.owner_id, 'accepted', ?
             FROM dp_members m JOIN dp_documents d ON d.id = m.doc_id
            WHERE m.user_id <> d.owner_id`
        ).run(now);
      }
      db.prepare("INSERT OR IGNORE INTO share_people_migrations (name, ran_at) VALUES (?, ?)").run(BACKFILL_MIGRATION, now);
    }
    const newestWins = `ON CONFLICT (kind, doc_id, recipient_id) DO UPDATE SET
         role = CASE WHEN excluded.created_at >= share_requests.created_at THEN excluded.role ELSE share_requests.role END,
         created_at = MAX(share_requests.created_at, excluded.created_at),
         token = COALESCE(share_requests.token, excluded.token)`;
    if (markdown) {
      db.prepare(
        `INSERT INTO share_requests (kind, doc_id, recipient_id, sender_id, role, invited_by, created_at, token)
         SELECT 'doc', s.doc_id, s.user_id, d.owner_id, s.role, s.invited_by, s.created_at, s.token
           FROM shares s JOIN docs d ON d.id = s.doc_id WHERE ${unacceptedShare} ${newestWins}`
      ).run();
      db.prepare(`DELETE FROM shares WHERE rowid IN (SELECT s.rowid FROM shares s JOIN docs d ON d.id = s.doc_id WHERE ${unacceptedShare})`).run();
    }
    if (files) {
      db.prepare(
        `INSERT INTO share_requests (kind, doc_id, recipient_id, sender_id, role, invited_by, created_at, token)
         SELECT 'file', m.doc_id, m.user_id, d.owner_id, m.role, d.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at / 1000.0, 'unixepoch'), NULL
           FROM dp_members m JOIN dp_documents d ON d.id = m.doc_id WHERE ${unacceptedMember} ${newestWins}`
      ).run();
      db.prepare(`DELETE FROM dp_members WHERE rowid IN (SELECT m.rowid FROM dp_members m JOIN dp_documents d ON d.id = m.doc_id WHERE ${unacceptedMember})`).run();
    }
  });
}

export function senderState(db: PeopleDatabase, recipientId: string, senderId: string): SenderState | null {
  const row = db
    .prepare("SELECT state FROM share_people WHERE recipient_id = ? AND sender_id = ?")
    .get(recipientId, senderId) as { state: SenderState } | undefined;
  return row?.state ?? null;
}

export function setSenderState(db: PeopleDatabase, recipientId: string, senderId: string, state: SenderState): void {
  db.prepare(
    `INSERT INTO share_people (recipient_id, sender_id, state, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (recipient_id, sender_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
  ).run(recipientId, senderId, state, new Date().toISOString());
}

export function clearSenderState(db: PeopleDatabase, recipientId: string, senderId: string, state: SenderState): boolean {
  return (
    Number(
      db.prepare("DELETE FROM share_people WHERE recipient_id = ? AND sender_id = ? AND state = ?").run(recipientId, senderId, state).changes
    ) > 0
  );
}

/**
 * Records a share from `senderId` to `recipientId` as a request. An existing
 * request keeps its role and token when an invite claim repeats it; an
 * explicit owner share (`ownerCommand`) sets the role it asked for, the
 * newest one winning. Returns false, storing nothing, when the sender already
 * has MAX_REQUESTS_PER_SENDER other requests waiting on this recipient: the
 * same answer whether or not the recipient blocked them.
 */
export function putRequest(
  db: PeopleDatabase,
  request: { kind: RequestKind; docId: string; recipientId: string; senderId: string; role: Role; invitedBy: string; token?: string | null },
  ownerCommand: boolean
): boolean {
  const exists = !!db
    .prepare("SELECT 1 FROM share_requests WHERE kind = ? AND doc_id = ? AND recipient_id = ?")
    .get(request.kind, request.docId, request.recipientId);
  if (!exists && requestsWaitingFrom(db, request.recipientId, request.senderId) >= MAX_REQUESTS_PER_SENDER) return false;
  db.prepare(
    `INSERT INTO share_requests (kind, doc_id, recipient_id, sender_id, role, invited_by, created_at, token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, doc_id, recipient_id) DO UPDATE SET
       role = CASE WHEN ? THEN excluded.role ELSE share_requests.role END,
       created_at = CASE WHEN ? THEN excluded.created_at ELSE share_requests.created_at END,
       token = COALESCE(share_requests.token, excluded.token)`
  ).run(
    request.kind,
    request.docId,
    request.recipientId,
    request.senderId,
    request.role,
    request.invitedBy,
    new Date().toISOString(),
    request.token ?? null,
    ownerCommand ? 1 : 0,
    ownerCommand ? 1 : 0
  );
  return true;
}

/** How many requests `senderId` has waiting on `recipientId`, hidden ones included. */
export function requestsWaitingFrom(db: PeopleDatabase, recipientId: string, senderId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM share_requests WHERE recipient_id = ? AND sender_id = ?").get(recipientId, senderId) as { n: number }).n;
}

/**
 * Drops every stored request from `senderId` to `recipientId`, for unblock:
 * what was sent during a block never reaches the recipient. Returns the
 * Markdown document ids, so the caller can fence them like a decline.
 */
export function requestDocsFrom(db: PeopleDatabase, recipientId: string, senderId: string): { docs: string[]; files: string[] } {
  const rows = db
    .prepare("SELECT kind, doc_id FROM share_requests WHERE recipient_id = ? AND sender_id = ?")
    .all(recipientId, senderId) as Array<{ kind: RequestKind; doc_id: string }>;
  return { docs: rows.filter((r) => r.kind === "doc").map((r) => r.doc_id), files: rows.filter((r) => r.kind === "file").map((r) => r.doc_id) };
}

export function removeRequest(db: PeopleDatabase, kind: RequestKind, docId: string, recipientId: string): boolean {
  return Number(db.prepare("DELETE FROM share_requests WHERE kind = ? AND doc_id = ? AND recipient_id = ?").run(kind, docId, recipientId).changes) > 0;
}

/** Every request on one document, dropped when the document goes. */
export function removeDocRequests(db: PeopleDatabase, kind: RequestKind, docId: string): number {
  return Number(db.prepare("DELETE FROM share_requests WHERE kind = ? AND doc_id = ?").run(kind, docId).changes);
}

/** The owner's view of who has not accepted yet: the "waiting" rows. Blocked and unanswered alike. */
export function waitingOn(db: PeopleDatabase, kind: RequestKind, docId: string) {
  return db
    .prepare(
      `SELECT r.recipient_id AS user_id, r.role AS role, r.created_at AS created_at, u.email AS email, u.name AS name
         FROM share_requests r JOIN user u ON u.id = r.recipient_id
        WHERE r.kind = ? AND r.doc_id = ?`
    )
    .all(kind, docId) as Array<{ user_id: string; role: Role; created_at: string; email: string; name: string | null }>;
}

/**
 * Accept moves every request from `senderId` into real shares, in the
 * caller's transaction: Markdown into `shares` (with the token an invite was
 * emailed with, so that link works from now on), files into `dp_members`.
 * Existing access wins over a request. Returns the moved document ids.
 */
export function landRequestsFrom(db: PeopleDatabase, recipientId: string, senderId: string): { docs: string[]; files: string[] } {
  const rows = db
    .prepare("SELECT kind, doc_id, role, invited_by, created_at, token FROM share_requests WHERE recipient_id = ? AND sender_id = ?")
    .all(recipientId, senderId) as Array<{ kind: RequestKind; doc_id: string; role: Role; invited_by: string; created_at: string; token: string | null }>;
  const docs: string[] = [];
  const files: string[] = [];
  for (const row of rows) {
    if (row.kind === "doc") {
      // The request is the owner's newest word on this document: its role wins.
      db.prepare(
        `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at, token) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc_id, user_id) DO UPDATE SET role = excluded.role, token = COALESCE(shares.token, excluded.token)`
      ).run(row.doc_id, recipientId, row.role, row.invited_by, new Date().toISOString(), row.token);
      docs.push(row.doc_id);
    } else if (tableExists(db, "dp_members")) {
      db.prepare("INSERT INTO dp_members (doc_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (doc_id, user_id) DO UPDATE SET role = excluded.role").run(
        row.doc_id,
        recipientId,
        row.role,
        Date.now()
      );
      files.push(row.doc_id);
    }
  }
  db.prepare("DELETE FROM share_requests WHERE recipient_id = ? AND sender_id = ?").run(recipientId, senderId);
  return { docs, files };
}

export interface ShareRequest {
  /** The document's id: the request is declined by it. */
  docId: string;
  name: string;
  /** "doc" for Markdown and Live Docs, "file" for a document-platform file. */
  kind: RequestKind;
  role: Role;
  createdAt: string;
  sender: { id: string; name: string | null; email: string };
}

// Requests this person can see: on live documents, from senders they have
// neither blocked nor accepted. The sender's address is their account's
// primary address, which signing in requires them to have proven. Names are
// the sender's own typing, so they come back as bounded plain text with no
// markup or links, the same treatment the request email gives them.
function visibleRequestsSql(db: PeopleDatabase, where: string): string {
  const files = tableExists(db, "dp_documents");
  return `SELECT r.kind AS kind, r.doc_id AS doc_id, COALESCE(d.name, ${files ? "f.name" : "NULL"}) AS name, r.role AS role,
              r.created_at AS created_at, o.id AS sender_id, NULLIF(o.name, '') AS sender_name, o.email AS sender_email
         FROM share_requests r
         JOIN user o ON o.id = r.sender_id
         LEFT JOIN docs d ON r.kind = 'doc' AND d.id = r.doc_id AND d.deleted_at IS NULL AND d.owner_id = r.sender_id
         ${files ? "LEFT JOIN dp_documents f ON r.kind = 'file' AND f.id = r.doc_id AND f.owner_id = r.sender_id" : ""}
        WHERE r.recipient_id = ? AND r.sender_id <> r.recipient_id
          AND NOT ${blockedSenderSql("r.recipient_id", "r.sender_id")}
          AND NOT ${acceptedSenderSql("r.recipient_id", "r.sender_id")}
          AND COALESCE(d.id, ${files ? "f.id" : "NULL"}) IS NOT NULL
          ${where}`;
}

type RequestRow = {
  kind: RequestKind;
  doc_id: string;
  name: string;
  role: Role;
  created_at: string;
  sender_id: string;
  sender_name: string | null;
  sender_email: string;
};

const toRequest = (r: RequestRow): ShareRequest => ({
  docId: r.doc_id,
  name: plainEmailText(r.name, NAME_LIMIT) || "a document",
  kind: r.kind,
  role: r.role,
  createdAt: r.created_at,
  sender: { id: r.sender_id, name: r.sender_name ? plainEmailText(r.sender_name, PERSON_LIMIT) || null : null, email: r.sender_email },
});

/** The newest REQUESTS_LISTED requests, and how many there are in all. */
export function requestsFor(db: PeopleDatabase, recipientId: string): { requests: ShareRequest[]; total: number } {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${visibleRequestsSql(db, "")})`).get(recipientId) as { n: number }).n;
  const rows = db
    .prepare(`${visibleRequestsSql(db, "")} ORDER BY r.created_at DESC, r.doc_id LIMIT ?`)
    .all(recipientId, REQUESTS_LISTED) as RequestRow[];
  return { requests: rows.map(toRequest), total };
}

/** One visible request, by its document. */
export function requestFor(db: PeopleDatabase, recipientId: string, docId: string): ShareRequest | null {
  const row = db.prepare(`${visibleRequestsSql(db, "AND r.doc_id = ?")} LIMIT 1`).get(recipientId, docId) as RequestRow | undefined;
  return row ? toRequest(row) : null;
}

/** Whether `senderId` has a request the recipient can see. */
export function hasRequestFrom(db: PeopleDatabase, recipientId: string, senderId: string): boolean {
  return !!db.prepare(`${visibleRequestsSql(db, "AND r.sender_id = ?")} LIMIT 1`).get(recipientId, senderId);
}

export interface SharePerson {
  id: string;
  name: string | null;
  email: string;
  since: string;
}

export function peopleFor(db: PeopleDatabase, recipientId: string): { accepted: SharePerson[]; blocked: SharePerson[] } {
  const rows = db
    .prepare(
      `SELECT sp.state AS state, sp.updated_at AS since, u.id AS id, NULLIF(u.name, '') AS name, u.email AS email
         FROM share_people sp JOIN user u ON u.id = sp.sender_id
        WHERE sp.recipient_id = ?
        ORDER BY lower(COALESCE(NULLIF(u.name, ''), u.email))`
    )
    .all(recipientId) as Array<{ state: SenderState; since: string; id: string; name: string | null; email: string }>;
  const person = (r: (typeof rows)[number]): SharePerson => ({ id: r.id, name: r.name, email: r.email, since: r.since });
  return {
    accepted: rows.filter((r) => r.state === "accepted").map(person),
    blocked: rows.filter((r) => r.state === "blocked").map(person),
  };
}

/** The ids of `sender`'s documents with a real share row for `recipient`. */
export function docsFromSender(db: PeopleDatabase, recipientId: string, senderId: string): string[] {
  return (
    db
      .prepare(
        `SELECT s.doc_id AS id FROM shares s JOIN docs d ON d.id = s.doc_id
          WHERE s.user_id = ? AND d.owner_id = ? AND d.owner_id <> s.user_id`
      )
      .all(recipientId, senderId) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** Drops every document-platform membership `sender` gave `recipient`. */
export function removeFileSharesFromSender(db: PeopleDatabase, recipientId: string, senderId: string): number {
  if (!tableExists(db, "dp_members") || !tableExists(db, "dp_documents")) return 0;
  return Number(
    db
      .prepare("DELETE FROM dp_members WHERE user_id = ? AND doc_id IN (SELECT id FROM dp_documents WHERE owner_id = ? AND owner_id <> ?)")
      .run(recipientId, senderId, recipientId).changes
  );
}
