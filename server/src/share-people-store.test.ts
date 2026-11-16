// The one-time backfill that keeps today's shares when the accept rule
// arrives (share-people-store.ts): everyone who shares with somebody now
// counts as accepted, and it never runs a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { BACKFILL_MIGRATION, MOVE_MIGRATION, acceptedSenderSql, ensureSharePeopleSchema, landRequestsFrom, putRequest, requestsFor } from "./share-people-store.ts";

function legacyDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER);
    CREATE TABLE docs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE shares (doc_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, created_at TEXT NOT NULL, token TEXT, PRIMARY KEY (doc_id, user_id));
    CREATE TABLE dp_documents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE dp_members (doc_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (doc_id, user_id));
  `);
  for (const id of ["ann", "ben", "cat", "dan"]) {
    db.prepare("INSERT INTO user VALUES (?, ?, ?, 1)").run(id, id.toUpperCase(), `${id}@x.test`);
  }
  db.prepare("INSERT INTO docs VALUES ('d1', 'ann', 'One.md', NULL)").run();
  db.prepare("INSERT INTO docs VALUES ('d2', 'ann', 'Two.md', NULL)").run();
  db.prepare("INSERT INTO docs VALUES ('d3', 'ben', 'Three.md', NULL)").run();
  const share = db.prepare("INSERT INTO shares VALUES (?, ?, 'viewer', ?, '2026-11-01', NULL)");
  share.run("d1", "ben", "ann");
  share.run("d2", "ben", "ann");
  share.run("d3", "cat", "ben");
  db.prepare("INSERT INTO dp_documents VALUES ('f1', 'dan', 'Sheet.rtf')").run();
  db.prepare("INSERT INTO dp_members VALUES ('f1', 'ann', 'editor', 1)").run();
  return db;
}

const accepted = (db: Database.Database) =>
  (db.prepare("SELECT recipient_id || '<-' || sender_id AS pair FROM share_people WHERE state = 'accepted' ORDER BY pair").all() as Array<{ pair: string }>).map((r) => r.pair);

test("everyone who shares with somebody today is accepted, once per pair, Markdown and files alike", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  assert.deepEqual(accepted(db), ["ann<-dan", "ben<-ann", "cat<-ben"]);
  assert.ok(db.prepare("SELECT 1 FROM share_people_migrations WHERE name = ?").get(BACKFILL_MIGRATION));
  // Every one of today's shares still reads.
  const readable = db
    .prepare(`SELECT COUNT(*) AS n FROM shares s JOIN docs d ON d.id = s.doc_id WHERE ${acceptedSenderSql("s.user_id", "d.owner_id")}`)
    .get() as { n: number };
  assert.equal(readable.n, 3);
  assert.deepEqual(requestsFor(db, "ben"), []);
});

test("running it again changes nothing, and a share made after it is a request outside shares", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  // After the rule: Cat shares with Dan, and Dan has accepted nobody.
  db.prepare("INSERT INTO docs VALUES ('d4', 'cat', 'Four.md', NULL)").run();
  putRequest(db, { kind: "doc", docId: "d4", recipientId: "dan", senderId: "cat", role: "editor", invitedBy: "cat" }, true);
  // Ben removed Ann after the backfill; a re-run must not bring her back.
  db.prepare("DELETE FROM share_people WHERE recipient_id = 'ben' AND sender_id = 'ann'").run();
  ensureSharePeopleSchema(db);
  ensureSharePeopleSchema(db);
  assert.deepEqual(accepted(db), ["ann<-dan", "cat<-ben"]);
  assert.deepEqual(requestsFor(db, "dan").map((r) => [r.docId, r.sender.id]), [["d4", "cat"]]);
  assert.deepEqual(db.prepare("SELECT * FROM shares WHERE user_id = 'dan'").all(), [], "a request is no row in shares");
});

test("accepting moves a request into shares, with its invite token", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  db.prepare("INSERT INTO docs VALUES ('d4', 'cat', 'Four.md', NULL)").run();
  db.prepare("INSERT INTO dp_documents VALUES ('f2', 'cat', 'Sheet.rtf')").run();
  putRequest(db, { kind: "doc", docId: "d4", recipientId: "dan", senderId: "cat", role: "viewer", invitedBy: "cat", token: "invite-token" }, false);
  putRequest(db, { kind: "file", docId: "f2", recipientId: "dan", senderId: "cat", role: "editor", invitedBy: "cat" }, true);
  const moved = landRequestsFrom(db, "dan", "cat");
  assert.deepEqual(moved, { docs: ["d4"], files: ["f2"] });
  assert.deepEqual(db.prepare("SELECT doc_id, role, token FROM shares WHERE user_id = 'dan'").all(), [{ doc_id: "d4", role: "viewer", token: "invite-token" }]);
  assert.deepEqual(db.prepare("SELECT doc_id, role FROM dp_members WHERE user_id = 'dan'").all(), [{ doc_id: "f2", role: "editor" }]);
  assert.deepEqual(db.prepare("SELECT * FROM share_requests").all(), []);
});

test("rows an earlier build left in shares and dp_members as hidden requests move out, once", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  // A database that ran the backfill under the earlier build, then got a
  // share to someone who never accepted, stored in shares as that build did.
  db.prepare("DELETE FROM share_people_migrations WHERE name = ?").run(MOVE_MIGRATION);
  db.prepare("INSERT INTO docs VALUES ('d4', 'cat', 'Four.md', NULL)").run();
  db.prepare("INSERT INTO shares VALUES ('d4', 'dan', 'editor', 'cat', '2026-11-16', 'tok')").run();
  db.prepare("INSERT INTO dp_documents VALUES ('f2', 'cat', 'Sheet.rtf')").run();
  db.prepare("INSERT INTO dp_members VALUES ('f2', 'dan', 'viewer', 1794800000000)").run();
  ensureSharePeopleSchema(db);
  assert.deepEqual(db.prepare("SELECT * FROM shares WHERE user_id = 'dan'").all(), []);
  assert.deepEqual(db.prepare("SELECT * FROM dp_members WHERE user_id = 'dan'").all(), []);
  assert.deepEqual(
    db.prepare("SELECT kind, doc_id, sender_id, role, token FROM share_requests ORDER BY kind").all(),
    [
      { kind: "doc", doc_id: "d4", sender_id: "cat", role: "editor", token: "tok" },
      { kind: "file", doc_id: "f2", sender_id: "cat", role: "viewer", token: null },
    ]
  );
  // Accepted shares stay where they are.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n, 3);
  assert.ok(db.prepare("SELECT 1 FROM share_people_migrations WHERE name = ?").get(MOVE_MIGRATION));
});

test("a fresh database starts with no accepted people and the backfill marked done", () => {
  const db = new Database(":memory:");
  ensureSharePeopleSchema(db);
  assert.deepEqual(accepted(db), []);
  assert.ok(db.prepare("SELECT 1 FROM share_people_migrations WHERE name = ?").get(BACKFILL_MIGRATION));
});
