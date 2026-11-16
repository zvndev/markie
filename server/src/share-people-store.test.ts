// The one-time backfill that keeps today's shares when the accept rule
// arrives (share-people-store.ts): everyone who shares with somebody now
// counts as accepted, and it never runs a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { BACKFILL_MIGRATION, MAX_REQUESTS_PER_SENDER, REQUESTS_LISTED, acceptedSenderSql, ensureSharePeopleSchema, landRequestsFrom, putRequest, requestsFor, waitingOn } from "./share-people-store.ts";

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
  assert.deepEqual(requestsFor(db, "ben"), { requests: [], total: 0 });
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
  assert.deepEqual(requestsFor(db, "dan").requests.map((r) => [r.docId, r.sender.id]), [["d4", "cat"]]);
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

test("rows written to shares or dp_members for someone who has not accepted move out on every start", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  // An earlier build, or a rolled-back one, wrote shares straight in.
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
});

test("rolled back then forward: a share an old build wrote becomes a request again, and the newest role wins", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  db.prepare("INSERT INTO docs VALUES ('d4', 'cat', 'Four.md', NULL)").run();
  // On this build: Cat asks Dan as a viewer.
  putRequest(db, { kind: "doc", docId: "d4", recipientId: "dan", senderId: "cat", role: "viewer", invitedBy: "cat" }, true);
  db.prepare("UPDATE share_requests SET created_at = '2026-11-15T00:00:00.000Z'").run();
  // Rolled back: the old build knows nothing of requests and writes Cat's
  // newer share, as an editor, straight into shares.
  db.prepare("INSERT INTO shares VALUES ('d4', 'dan', 'editor', 'cat', '2026-11-17T00:00:00.000Z', NULL)").run();
  // Rolled forward: the next start moves it back.
  ensureSharePeopleSchema(db);
  assert.deepEqual(db.prepare("SELECT * FROM shares WHERE user_id = 'dan'").all(), [], "no orphan left in shares");
  assert.deepEqual(requestsFor(db, "dan").requests.map((r) => [r.docId, r.role]), [["d4", "editor"]], "Dan sees it, with the newest role");
  assert.deepEqual(waitingOn(db, "doc", "d4").map((r) => [r.user_id, r.role]), [["dan", "editor"]], "Cat's list shows Dan waiting");
  // Cat re-shares as a viewer: that newest word wins again, and accepting lands it.
  putRequest(db, { kind: "doc", docId: "d4", recipientId: "dan", senderId: "cat", role: "viewer", invitedBy: "cat" }, true);
  landRequestsFrom(db, "dan", "cat");
  assert.deepEqual(db.prepare("SELECT role FROM shares WHERE doc_id = 'd4' AND user_id = 'dan'").all(), [{ role: "viewer" }]);
});

test("one sender may keep only so many requests waiting on one person, and listings are bounded", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  for (let i = 0; i < MAX_REQUESTS_PER_SENDER + 5; i += 1) {
    db.prepare("INSERT INTO docs VALUES (?, 'cat', ?, NULL)").run(`x${i}`, `Doc ${i}.md`);
    const stored = putRequest(db, { kind: "doc", docId: `x${i}`, recipientId: "dan", senderId: "cat", role: "viewer", invitedBy: "cat" }, true);
    assert.equal(stored, i < MAX_REQUESTS_PER_SENDER, `request ${i}`);
  }
  // A repeat of one already waiting is still allowed (a role change).
  assert.equal(putRequest(db, { kind: "doc", docId: "x0", recipientId: "dan", senderId: "cat", role: "editor", invitedBy: "cat" }, true), true);
  // Other senders' requests add up, and the listing returns the newest few with the total.
  for (let i = 0; i < REQUESTS_LISTED; i += 1) {
    const sender = `s${i}`;
    db.prepare("INSERT INTO user VALUES (?, ?, ?, 1)").run(sender, sender, `${sender}@x.test`);
    db.prepare("INSERT INTO docs VALUES (?, ?, 'Theirs.md', NULL)").run(`y${i}`, sender);
    putRequest(db, { kind: "doc", docId: `y${i}`, recipientId: "dan", senderId: sender, role: "viewer", invitedBy: sender }, true);
  }
  const listed = requestsFor(db, "dan");
  assert.equal(listed.requests.length, REQUESTS_LISTED);
  assert.equal(listed.total, MAX_REQUESTS_PER_SENDER + REQUESTS_LISTED);
});

test("request names come back as bounded plain text, links and markup gone", () => {
  const db = legacyDatabase();
  ensureSharePeopleSchema(db);
  db.prepare("UPDATE user SET name = ? WHERE id = 'cat'").run("Prize desk <b>visit</b> evil.test/claim");
  db.prepare("INSERT INTO docs VALUES ('z1', 'cat', ?, NULL)").run(`Claim at https://evil.test/win <img src=x> ${"long ".repeat(80)}`);
  putRequest(db, { kind: "doc", docId: "z1", recipientId: "dan", senderId: "cat", role: "viewer", invitedBy: "cat" }, true);
  const [request] = requestsFor(db, "dan").requests;
  for (const text of [request.name, request.sender.name ?? ""]) {
    assert.ok(!/https?:|evil\.test|<|>/.test(text), text);
  }
  assert.ok(Array.from(request.name).length <= 120);
});

test("a fresh database starts with no accepted people and the backfill marked done", () => {
  const db = new Database(":memory:");
  ensureSharePeopleSchema(db);
  assert.deepEqual(accepted(db), []);
  assert.ok(db.prepare("SELECT 1 FROM share_people_migrations WHERE name = ?").get(BACKFILL_MIGRATION));
});
