// The one-time backfill that keeps today's shares when the accept rule
// arrives (share-people-store.ts): everyone who shares with somebody now
// counts as accepted, and it never runs a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { BACKFILL_MIGRATION, acceptedSenderSql, ensureSharePeopleSchema, requestsFor } from "./share-people-store.ts";

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

test("running it again changes nothing, and a share made after it stays a request", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  // After the rule: Cat shares with Dan, and Dan has accepted nobody.
  db.prepare("INSERT INTO docs VALUES ('d4', 'cat', 'Four.md', NULL)").run();
  db.prepare("INSERT INTO shares VALUES ('d4', 'dan', 'editor', 'cat', '2026-11-16', NULL)").run();
  // Ben removed Ann after the backfill; a re-run must not bring her back.
  db.prepare("DELETE FROM share_people WHERE recipient_id = 'ben' AND sender_id = 'ann'").run();
  ensureSharePeopleSchema(db);
  ensureSharePeopleSchema(db);
  assert.deepEqual(accepted(db), ["ann<-dan", "cat<-ben"]);
  assert.deepEqual(
    requestsFor(db, "dan").map((r) => [r.docId, r.sender.id]),
    [["d4", "cat"]]
  );
});

test("a fresh database starts with no accepted people and the backfill marked done", () => {
  const db = new Database(":memory:");
  ensureSharePeopleSchema(db);
  assert.deepEqual(accepted(db), []);
  assert.ok(db.prepare("SELECT 1 FROM share_people_migrations WHERE name = ?").get(BACKFILL_MIGRATION));
});
