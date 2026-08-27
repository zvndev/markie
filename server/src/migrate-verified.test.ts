// The deploy migration's audit report.
//
// The report exists to answer one question before anyone writes to production:
// did the share-takeover flaw actually get used? A detector that answers "yes"
// on a healthy database is worse than none, because the alarm gets ignored.
// These cases pin both directions: it must catch a real stolen claim, and it
// must stay silent on ordinary shares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-migrate-")), "t.db");
process.env.BETTER_AUTH_SECRET = "markie-migrate-test-secret-32-plus-chars";

const { ensureShareToken } = await import("./shares.ts");
const { addPending, claimPendingInvites } = await import("./pending.ts");
await import("./docs.ts");
const { auditVerification, formatReport, grandfather, main } = await import(
  "./migrate-verified.ts"
);
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH as string);

// better-auth owns these in production; the migration only reads them, so the
// suite creates just the columns it touches.
db.exec(`
  CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER,
    image TEXT, createdAt TEXT, updatedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY, accountId TEXT, providerId TEXT, userId TEXT,
    createdAt TEXT, updatedAt TEXT
  );
`);

const BEFORE = "2026-01-01T00:00:00.000Z";
const AFTER = "2026-09-01T00:00:00.000Z";
const CUTOFF = "2026-06-01T00:00:00.000Z";

function addUser(id: string, email: string, verified: 0 | 1, createdAt: string) {
  db.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, id, email, verified, createdAt, createdAt);
  db.prepare(
    "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?)"
  ).run(`acct-${id}`, id, id, createdAt, createdAt);
}

function addDoc(id: string) {
  db.prepare(
    `INSERT INTO docs (id, owner_id, name, version, content, hash, updated_at, deleted_at)
     VALUES (?, 'owner', 'D', 1, 'c', 'h', '2026-01-01', NULL)`
  ).run(id);
}

// An ordinary share to somebody who already had an account, with the invite
// email sent. This row HAS a token, which is exactly why "token IS NOT NULL"
// cannot be the claimed-from-invite signal.
addUser("direct-user", "direct@corp.test", 0, BEFORE);
addDoc("doc-direct");
db.prepare(
  `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at)
   VALUES ('doc-direct', 'direct-user', 'viewer', 'owner', '2026-01-02')`
).run();
ensureShareToken("doc-direct", "direct-user");

// A pending invite claimed by an account that never proved the address: the
// takeover signature.
addUser("thief", "victim@corp.test", 0, BEFORE);
addDoc("doc-stolen");
addPending("doc-stolen", "victim@corp.test", "editor", "owner");
claimPendingInvites("victim@corp.test", "thief");

// The same claim, but by an account that did prove the address. Legitimate.
addUser("rightful", "rightful@corp.test", 1, BEFORE);
addDoc("doc-claimed");
addPending("doc-claimed", "rightful@corp.test", "editor", "owner");
claimPendingInvites("rightful@corp.test", "rightful");

// An invite nobody has claimed yet.
addDoc("doc-waiting");
addPending("doc-waiting", "nobody@corp.test", "viewer", "owner");

// An account created after the cutoff: it must NOT be grandfathered.
addUser("newcomer", "newcomer@corp.test", 0, AFTER);

test("an ordinary emailed share is not mistaken for a claimed invite", () => {
  // The whole database has tokens on its share rows. Only the claims count.
  const anyToken = db
    .prepare("SELECT COUNT(*) AS n FROM shares WHERE token IS NOT NULL")
    .get() as { n: number };
  assert.equal(anyToken.n, 3, "every share here carries a token");

  const report = auditVerification(db, CUTOFF);
  assert.equal(report.claimed, 2, "only the two claimed invites count as claims");
  assert.equal(
    report.flagged.some((f) => f.user_id === "direct-user"),
    false,
    "a direct share to an unverified account is not a takeover"
  );
});

test("a claim by an account that never proved the address is flagged", () => {
  const report = auditVerification(db, CUTOFF);
  assert.equal(report.flagged.length, 1);
  assert.equal(report.flagged[0].user_id, "thief");
  assert.equal(report.flagged[0].doc_id, "doc-stolen");
  assert.equal(report.flagged[0].email, "victim@corp.test");
  assert.match(formatReport(report), /STOP: the takeover flaw appears/);
});

test("a claim by a verified account is left alone", () => {
  const report = auditVerification(db, CUTOFF);
  assert.equal(
    report.flagged.some((f) => f.user_id === "rightful"),
    false
  );
});

test("an OAuth account is never flagged: the provider proved the address", () => {
  addUser("googler", "googler@corp.test", 0, BEFORE);
  db.prepare(
    "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES ('acct-g2', 'g2', 'google', 'googler', ?, ?)"
  ).run(BEFORE, BEFORE);
  addDoc("doc-google");
  addPending("doc-google", "googler@corp.test", "viewer", "owner");
  claimPendingInvites("googler@corp.test", "googler");

  const report = auditVerification(db, CUTOFF);
  assert.equal(
    report.flagged.some((f) => f.user_id === "googler"),
    false,
    "an OAuth link is proof of the address even with emailVerified still 0"
  );
});

test("the report counts the accounts in range and the invites still waiting", () => {
  const report = auditVerification(db, CUTOFF);
  // direct-user, thief, googler: unverified and created before the cutoff.
  // newcomer is after it, rightful is already verified.
  assert.equal(report.toGrandfather.n, 3);
  assert.equal(report.toGrandfather.first, BEFORE);
  assert.equal(report.stillPending, 1, "doc-waiting is the only unclaimed invite");
});

test("a flagged row stops the run and writes nothing, with or without --commit", () => {
  const before = db
    .prepare("SELECT COUNT(*) AS n FROM user WHERE emailVerified = 0")
    .get() as { n: number };

  assert.equal(main([CUTOFF]), 2, "dry run exits non-zero when rows are flagged");
  assert.equal(main([CUTOFF, "--commit"]), 2, "--commit refuses too");

  const after = db
    .prepare("SELECT COUNT(*) AS n FROM user WHERE emailVerified = 0")
    .get() as { n: number };
  assert.equal(after.n, before.n, "a blocked run must not grandfather anybody");
});

test("usage is refused rather than guessed at", () => {
  assert.equal(main([]), 1);
  assert.equal(main(["not-a-date"]), 1);
  assert.equal(main(["--commit"]), 1, "a cutoff is required even with --commit");
});

test("with the flag cleared, grandfathering touches only accounts before the cutoff", () => {
  // Revoke the stolen share, which is what the runbook tells the owner to do.
  db.prepare("DELETE FROM shares WHERE doc_id = 'doc-stolen'").run();
  const report = auditVerification(db, CUTOFF);
  assert.equal(report.flagged.length, 0);

  assert.equal(main([CUTOFF]), 0, "a clean dry run exits zero");
  const stillUnverified = db
    .prepare("SELECT COUNT(*) AS n FROM user WHERE emailVerified = 0")
    .get() as { n: number };
  assert.equal(stillUnverified.n, 4, "a dry run writes nothing");

  assert.equal(grandfather(db, CUTOFF), 3, "three accounts predate the cutoff");
  const newcomer = db
    .prepare("SELECT emailVerified FROM user WHERE id = 'newcomer'")
    .get() as { emailVerified: number };
  assert.equal(
    newcomer.emailVerified,
    0,
    "an account created after the deploy still has to prove its address"
  );
});
