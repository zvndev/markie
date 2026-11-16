// Who may put documents in whose Markie.
//
// Kirby's rule, 2026-11-15: nothing lands in a person's Markie because
// someone else chose to send it. A recipient accepts a sender once, and from
// then on that sender's shares land.
//
// The share rows themselves do not change shape. A row in `shares` (or
// `dp_members` for the document platform) still records that the owner
// shared the document. Whether it counts is decided here, at read time, by
// one table keyed on (recipient, sender), where the sender is always the
// document's owner, the only account that can share it:
//
//   no row      the share is a request. The recipient sees the sender and the
//               file name in their Requests list and nothing else.
//   accepted    the share is real: the document is theirs to read.
//   blocked     the share is hidden. It never shows as a request, and the
//               sender's view of it is the same "waiting" an unanswered
//               request shows, so blocking cannot be detected.
//
// Every access check and every listing that reads `shares` or `dp_members`
// for a recipient goes through acceptedSenderSql, so a route that asks
// "may this person read this document" inherits the rule without knowing it
// exists. The owner never needs a row: owner access is decided before any
// share is read.
//
// Dependency-free on purpose (only a database handle comes in): shares.ts and
// the document platform store both build on it, and shares.ts is imported by
// nearly everything.

/** The structural subset of better-sqlite3 both callers' handles provide. */
export interface PeopleDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...args: (string | number | null)[]): unknown;
    all(...args: (string | number | null)[]): unknown[];
    run(...args: (string | number | null)[]): { changes: number | bigint };
  };
}

export type SenderState = "accepted" | "blocked";

/**
 * SQL that is true when `recipient` has accepted `sender`. Both arguments are
 * column references from the calling query (never user input), such as
 * `s.user_id` and `d.owner_id`.
 */
export function acceptedSenderSql(recipient: string, sender: string): string {
  return `EXISTS (SELECT 1 FROM share_people sp WHERE sp.recipient_id = ${recipient} AND sp.sender_id = ${sender} AND sp.state = 'accepted')`;
}

/** SQL that is true when `recipient` has said anything at all about `sender`. */
export function decidedSenderSql(recipient: string, sender: string): string {
  return `EXISTS (SELECT 1 FROM share_people sp WHERE sp.recipient_id = ${recipient} AND sp.sender_id = ${sender})`;
}

// The one-time backfill: everybody who shares with somebody today counts as
// accepted, so introducing the rule takes nothing away from anyone. Recorded
// by name so it never runs again: after this, a share row from a sender the
// recipient has not accepted is a request, and re-running the backfill would
// silently accept every open request.
export const BACKFILL_MIGRATION = "share-people-backfill-2026-11-15";

const tableExists = (db: PeopleDatabase, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Creates the table if needed and runs the backfill once per database. */
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
    CREATE TABLE IF NOT EXISTS share_people_migrations (
      name TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL
    );
  `);
  if (db.prepare("SELECT 1 FROM share_people_migrations WHERE name = ?").get(BACKFILL_MIGRATION)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-checked under the write lock: another handle may have run it while
    // this one waited.
    if (!db.prepare("SELECT 1 FROM share_people_migrations WHERE name = ?").get(BACKFILL_MIGRATION)) {
      const now = new Date().toISOString();
      if (tableExists(db, "shares") && tableExists(db, "docs")) {
        db.prepare(
          `INSERT OR IGNORE INTO share_people (recipient_id, sender_id, state, updated_at)
           SELECT DISTINCT s.user_id, d.owner_id, 'accepted', ?
             FROM shares s JOIN docs d ON d.id = s.doc_id
            WHERE s.user_id <> d.owner_id`
        ).run(now);
      }
      if (tableExists(db, "dp_members") && tableExists(db, "dp_documents")) {
        db.prepare(
          `INSERT OR IGNORE INTO share_people (recipient_id, sender_id, state, updated_at)
           SELECT DISTINCT m.user_id, d.owner_id, 'accepted', ?
             FROM dp_members m JOIN dp_documents d ON d.id = m.doc_id
            WHERE m.user_id <> d.owner_id`
        ).run(now);
      }
      db.prepare("INSERT INTO share_people_migrations (name, ran_at) VALUES (?, ?)").run(BACKFILL_MIGRATION, now);
    }
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

export function senderState(db: PeopleDatabase, recipientId: string, senderId: string): SenderState | null {
  const row = db
    .prepare("SELECT state FROM share_people WHERE recipient_id = ? AND sender_id = ?")
    .get(recipientId, senderId) as { state: SenderState } | undefined;
  return row?.state ?? null;
}

export function setSenderState(
  db: PeopleDatabase,
  recipientId: string,
  senderId: string,
  state: SenderState
): void {
  db.prepare(
    `INSERT INTO share_people (recipient_id, sender_id, state, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (recipient_id, sender_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
  ).run(recipientId, senderId, state, new Date().toISOString());
}

export function clearSenderState(db: PeopleDatabase, recipientId: string, senderId: string, state: SenderState): boolean {
  return (
    Number(
      db
        .prepare("DELETE FROM share_people WHERE recipient_id = ? AND sender_id = ? AND state = ?")
        .run(recipientId, senderId, state).changes
    ) > 0
  );
}

export interface ShareRequest {
  /** The document's id: the request is declined by it. */
  docId: string;
  name: string;
  /** "doc" for Markdown and Live Docs, "file" for a document-platform file. */
  kind: "doc" | "file";
  role: "viewer" | "editor";
  createdAt: string;
  sender: { id: string; name: string | null; email: string };
}

// Requests waiting for this person: share rows on live documents whose owner
// they have neither accepted nor blocked. The sender's address is their
// account's primary address, which signing in requires them to have proven.
export function requestsFor(db: PeopleDatabase, recipientId: string): ShareRequest[] {
  const rows = db
    .prepare(
      `SELECT s.doc_id AS doc_id, d.name AS name, 'doc' AS kind, s.role AS role, s.created_at AS created_at,
              o.id AS sender_id, NULLIF(o.name, '') AS sender_name, o.email AS sender_email
         FROM shares s
         JOIN docs d ON d.id = s.doc_id
         JOIN user o ON o.id = d.owner_id
        WHERE s.user_id = ? AND d.owner_id <> s.user_id AND d.deleted_at IS NULL
          AND NOT ${decidedSenderSql("s.user_id", "d.owner_id")}
        ORDER BY s.created_at DESC`
    )
    .all(recipientId) as Array<{
    doc_id: string;
    name: string;
    kind: "doc";
    role: "viewer" | "editor";
    created_at: string;
    sender_id: string;
    sender_name: string | null;
    sender_email: string;
  }>;
  const out: ShareRequest[] = rows.map((r) => ({
    docId: r.doc_id,
    name: r.name,
    kind: r.kind,
    role: r.role,
    createdAt: r.created_at,
    sender: { id: r.sender_id, name: r.sender_name, email: r.sender_email },
  }));
  if (tableExists(db, "dp_members") && tableExists(db, "dp_documents")) {
    const files = db
      .prepare(
        `SELECT m.doc_id AS doc_id, d.name AS name, m.role AS role, m.created_at AS created_at,
                o.id AS sender_id, NULLIF(o.name, '') AS sender_name, o.email AS sender_email
           FROM dp_members m
           JOIN dp_documents d ON d.id = m.doc_id
           JOIN user o ON o.id = d.owner_id
          WHERE m.user_id = ? AND d.owner_id <> m.user_id
            AND NOT ${decidedSenderSql("m.user_id", "d.owner_id")}`
      )
      .all(recipientId) as Array<{
      doc_id: string;
      name: string;
      role: "viewer" | "editor";
      created_at: number;
      sender_id: string;
      sender_name: string | null;
      sender_email: string;
    }>;
    for (const r of files) {
      out.push({
        docId: r.doc_id,
        name: r.name,
        kind: "file",
        role: r.role,
        createdAt: new Date(r.created_at).toISOString(),
        sender: { id: r.sender_id, name: r.sender_name, email: r.sender_email },
      });
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return out;
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

/** The ids of `sender`'s live documents that are shared with `recipient`, accepted or not. */
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
      .prepare(
        "DELETE FROM dp_members WHERE user_id = ? AND doc_id IN (SELECT id FROM dp_documents WHERE owner_id = ? AND owner_id <> ?)"
      )
      .run(recipientId, senderId, recipientId).changes
  );
}

/** Whether a document-platform file shared with `recipient` is a request from its owner (not accepted, not blocked). */
export function fileRequestSender(db: PeopleDatabase, docId: string, recipientId: string): string | null {
  if (!tableExists(db, "dp_members") || !tableExists(db, "dp_documents")) return null;
  const row = db
    .prepare(
      `SELECT d.owner_id AS owner_id FROM dp_members m JOIN dp_documents d ON d.id = m.doc_id
        WHERE m.doc_id = ? AND m.user_id = ? AND d.owner_id <> m.user_id
          AND NOT ${decidedSenderSql("m.user_id", "d.owner_id")}`
    )
    .get(docId, recipientId) as { owner_id: string } | undefined;
  return row?.owner_id ?? null;
}
