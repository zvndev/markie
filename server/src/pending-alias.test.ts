import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-alias-pending-")), "module.db");
const { createPendingShareStore } = await import("./pending.ts");
function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER,name TEXT);
    CREATE TABLE docs(id TEXT PRIMARY KEY,owner_id TEXT,deleted_at TEXT);
    CREATE TABLE shares(doc_id TEXT,user_id TEXT,role TEXT,invited_by TEXT,created_at TEXT,token TEXT,PRIMARY KEY(doc_id,user_id));
    INSERT INTO user VALUES('owner','owner@example.test',1,'Owner'),('member','main@example.test',1,'Member'),('unverified','unverified@example.test',0,'Unverified');
    INSERT INTO docs VALUES('doc','owner',NULL);`);
  const active = new Map([['main@example.test', 'member'], ['alias@example.test', 'member'], ['other@example.test', 'member'], ['owner@example.test', 'owner']]);
  const store = createPendingShareStore(db, { identities: {
    verifiedUserForEmail(email, connection) { assert.equal(connection, db); return active.get(email) ?? null; },
    activeEmailsForUser(id, connection) { assert.equal(connection, db); return [...active].filter(([, owner]) => owner === id).map(([email]) => email); },
  } });
  const member = () => db.prepare("SELECT role,token FROM shares WHERE doc_id='doc' AND user_id='member'").get() as { role: string; token: string } | undefined;
  const row = (email = 'alias@example.test') => db.prepare("SELECT * FROM pending_shares WHERE doc_id='doc' AND email=?").get(email) as Record<string, string | number>;
  const replay = (snapshot: Record<string, string | number>) => db.prepare("INSERT INTO pending_shares(doc_id,email,role,invited_by,token,created_at,decision_revision) VALUES(@doc_id,@email,@role,@invited_by,@token,@created_at,@decision_revision)").run(snapshot);
  return { db, active, store, member, row, replay };
}

test("verified aliases resolve on the transaction's own handle without modifying the primary identity", () => {
  const f = fixture();
  assert.equal(f.store.verifiedUserForEmail(' ALIAS@EXAMPLE.TEST '), 'member');
  assert.equal(f.store.verifiedUserForEmail('missing@example.test'), null);
  f.active.set('unverified@example.test', 'unverified');
  assert.equal(f.store.verifiedUserForEmail('unverified@example.test'), null);
  const recipient = f.store.shareWithEmail('doc', 'alias@example.test', 'viewer', 'owner');
  assert.equal(recipient?.id, 'member'); assert.equal(recipient?.email, 'main@example.test');
  assert.equal(f.member()?.role, 'viewer');
  assert.equal((f.db.prepare("SELECT email FROM user WHERE id='member'").get() as { email: string }).email, 'main@example.test');
});

for (const existingRole of ['viewer', 'editor'] as const) test(`claiming another alias never changes an existing ${existingRole} grant or token`, () => {
  const f = fixture(); f.store.grantMember('doc', 'member', existingRole, 'owner');
  f.db.prepare("UPDATE shares SET token='existing-token' WHERE doc_id='doc'").run();
  const token = f.store.addPending('doc', 'alias@example.test', existingRole === 'viewer' ? 'editor' : 'viewer', 'owner');
  f.store.claimPendingInvitesForUser('member');
  assert.deepEqual(f.member(), { role: existingRole, token: 'existing-token' });
  assert.deepEqual(f.store.memberForInviteToken(token), { docId: 'doc', userId: 'member' });
});

for (const lastRole of ['viewer', 'editor'] as const) test(`alias collisions deduplicate with latest explicit ${lastRole} invitation and preserve both URLs`, () => {
  const f = fixture();
  const one = f.store.addPending('doc', 'alias@example.test', lastRole === 'viewer' ? 'editor' : 'viewer', 'owner');
  const two = f.store.addPending('doc', 'other@example.test', lastRole, 'owner');
  assert.equal(f.store.claimPendingInvites('main@example.test', 'member'), 2);
  assert.equal(f.member()?.role, lastRole); assert.equal(f.store.listPendingForDoc('doc').length, 0);
  for (const token of [one, two]) assert.deepEqual(f.store.memberForInviteToken(token), { docId: 'doc', userId: 'member' });
  assert.equal(f.store.claimPendingInvitesForUser('member'), 0);
});

test("revocation survives a replayed old invite and a new owner invitation can regrant without reviving old URLs", () => {
  const f = fixture(); const oldToken = f.store.addPending('doc', 'alias@example.test', 'editor', 'owner'), old = f.row();
  f.store.claimPendingInvitesForUser('member'); assert.equal(f.member()?.role, 'editor');
  assert.equal(f.store.revokeMember('doc', 'member'), true); assert.equal(f.store.memberForInviteToken(oldToken), null);
  f.replay(old); f.store.claimPendingInvitesForUser('member'); assert.equal(f.member(), undefined);
  const fresh = f.store.addPending('doc', 'alias@example.test', 'viewer', 'owner'); assert.notEqual(fresh, oldToken);
  f.store.claimPendingInvitesForUser('member'); assert.equal(f.member()?.role, 'viewer');
  assert.equal(f.store.memberForInviteToken(oldToken), null); assert.deepEqual(f.store.memberForInviteToken(fresh), { docId: 'doc', userId: 'member' });
});

test("an explicit role change fences old invites even if the membership is later absent", () => {
  const f = fixture(); f.store.addPending('doc', 'alias@example.test', 'editor', 'owner'); const old = f.row();
  f.store.grantMember('doc', 'member', 'viewer', 'owner'); f.replay(old);
  f.store.claimPendingInvitesForUser('member'); assert.equal(f.member()?.role, 'viewer');
  f.db.prepare("DELETE FROM shares WHERE doc_id='doc'").run(); f.replay(old); f.store.claimPendingInvitesForUser('member'); assert.equal(f.member(), undefined);
});

test("an owner revocation also fences addresses verified only later", () => {
  const f = fixture(); f.active.delete('alias@example.test');
  f.store.addPending('doc', 'alias@example.test', 'editor', 'owner'); const old = f.row();
  f.store.grantMember('doc', 'member', 'viewer', 'owner'); f.store.revokeMember('doc', 'member');
  f.active.set('alias@example.test', 'member'); f.store.claimPendingInvitesForUser('member'); assert.equal(f.member(), undefined);
  f.replay(old); f.store.claimPendingInvitesForUser('member'); assert.equal(f.member(), undefined);
});

test("unlink stops future resolution and pending claims but retains existing grants", () => {
  const f = fixture(); f.store.grantMember('doc', 'member', 'editor', 'owner'); f.active.delete('alias@example.test');
  assert.equal(f.store.verifiedUserForEmail('alias@example.test'), null);
  f.store.addPending('doc', 'alias@example.test', 'viewer', 'owner');
  assert.equal(f.store.claimPendingInvites('alias@example.test', 'member'), 0);
  assert.equal(f.store.claimPendingInvitesForUser('member'), 0); assert.equal(f.member()?.role, 'editor');
  assert.equal(f.store.listPendingForDoc('doc').length, 1);
});

test("removing an unknown address invite durably rejects its replay, including after reopening the store", () => {
  const f = fixture(); f.store.addPending('doc', 'alias@example.test', 'editor', 'owner'); const old = f.row();
  assert(f.store.removePending('doc', 'alias@example.test')); f.replay(old);
  const again = createPendingShareStore(f.db, { identities: { verifiedUserForEmail: email => f.active.get(email) ?? null, activeEmailsForUser: id => [...f.active].filter(([, owner]) => owner === id).map(([email]) => email) } });
  again.claimPendingInvitesForUser('member'); assert.equal(f.member(), undefined);
});

test("unknown, unverified or client-mismatched addresses cannot claim another account's pending invitations", () => {
  const f = fixture(); f.store.addPending('doc', 'alias@example.test', 'editor', 'owner');
  for (const email of ['missing@example.test', 'unverified@example.test', 'owner@example.test']) assert.equal(f.store.claimPendingInvites(email, 'member'), 0);
  assert.equal(f.store.claimPendingInvites('alias@example.test', 'owner'), 0); assert.equal(f.member(), undefined);
  assert.equal(f.store.shareWithEmail('doc', 'unverified@example.test', 'editor', 'owner'), null);
});

test("reissuing an active pending invitation returns its actual retained token", () => {
  const f = fixture(), token = f.store.addPending('doc', 'alias@example.test', 'viewer', 'owner');
  assert.equal(f.store.addPending('doc', 'alias@example.test', 'editor', 'owner'), token);
  assert.equal(f.store.pendingForToken(token)?.role, 'editor');
});

test("an explicit grant keeps valid already-emailed alias URLs without reviving a revoked URL", () => {
  const f = fixture(), token = f.store.addPending('doc', 'alias@example.test', 'viewer', 'owner'), old = f.row();
  f.store.shareWithEmail('doc', 'alias@example.test', 'editor', 'owner');
  assert.deepEqual(f.store.memberForInviteToken(token), { docId: 'doc', userId: 'member' });
  f.store.revokeMember('doc', 'member'); f.replay(old);
  f.store.shareWithEmail('doc', 'alias@example.test', 'viewer', 'owner');
  assert.equal(f.store.memberForInviteToken(token), null); assert.equal(f.member()?.role, 'viewer');
});

test("identity resolution failures roll back all membership and pending mutations", () => {
  const f = fixture(); f.store.addPending('doc', 'alias@example.test', 'editor', 'owner');
  const before = f.row();
  const broken = createPendingShareStore(f.db, { identities: { verifiedUserForEmail() { throw new Error('proof unavailable'); }, activeEmailsForUser() { return ['alias@example.test']; } } });
  assert.throws(() => broken.claimPendingInvitesForUser('member'), /proof unavailable/);
  assert.equal(f.member(), undefined); assert.deepEqual(f.row(), before);
});

test("revoking a canonical recipient acknowledges and removes their verified-alias pending invites before claim", () => {
  const f = fixture(); f.store.addPending('doc', 'alias@example.test', 'editor', 'owner');
  assert.equal(f.store.revokeMember('doc', 'member'), true); assert.equal(f.store.listPendingForDoc('doc').length, 0);
  assert.equal(f.store.claimPendingInvitesForUser('member'), 0); assert.equal(f.member(), undefined);
});
