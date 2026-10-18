import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export interface IdentityActor { userId: string; email: string; emailVerified: boolean; sessionId: string }
export type IdentityScope = "email-add" | "email-remove" | "google-link" | "google-remove";
export interface AccountIdentity { id: string; email: string; primary: boolean; verifiedAt: number }
export interface IdentityDelivery { challengeId: string; expiresInSeconds: number; email?: string; code?: string }
export class IdentityError extends Error {
  code: string; status: 400 | 401 | 403 | 409 | 429 | 503;
  constructor(code: string, status: IdentityError["status"]) { super(code); this.code = code; this.status = status; }
}
const fail = (code: string, status: IdentityError["status"]): never => { throw new IdentityError(code, status); };
const TTL = 300000;
export function normalizeIdentityEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const email = value.trim().toLowerCase(), parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..") ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0])) return null;
  const labels = parts[1].split(".");
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? email : null;
}
interface UserRow { id: string; email: string; emailVerified: number }
interface EmailRow { id: string; user_id: string; email_norm: string; email_display: string; verified_at: number; is_primary: number }
interface Challenge {
  id: string; user_id: string | null; session_hash: string; purpose: string; scope: IdentityScope | null;
  target_email: string; code_hash: string; expires_at: number; attempts: number; consumed_at: number | null;
}
export interface IdentityStoreOptions {
  secret: string;
  now?: () => number;
  /** Synchronous, same injected connection; throwing rolls back identity + OTP consumption. */
  ensureIdentityArea?: (userId: string, identityId: string, label: string) => unknown;
}
/** Pure lookups: no table creation, backfill, transaction or cross-connection reads. */
export function resolveVerifiedUserForEmail(db: Database.Database, value: string): string | null {
  const email = normalizeIdentityEmail(value);
  if (!email) return null;
  const row = db.prepare(`SELECT ae.user_id FROM account_emails ae JOIN "user" u ON u.id=ae.user_id
    WHERE ae.email_norm=? AND ae.revoked_at IS NULL AND ae.verified_at IS NOT NULL AND u.emailVerified=1
      AND NOT EXISTS(SELECT 1 FROM "user" other WHERE lower(trim(other.email))=ae.email_norm AND other.id<>ae.user_id)`)
    .get(email) as { user_id: string } | undefined;
  if (row) return row.user_id;
  if (db.prepare("SELECT 1 FROM account_emails WHERE email_norm=? LIMIT 1").get(email)) return null;
  const primaries = db.prepare('SELECT id,emailVerified FROM "user" WHERE lower(trim(email))=? LIMIT 2').all(email) as { id: string; emailVerified: number }[];
  return primaries.length === 1 && primaries[0].emailVerified === 1 ? primaries[0].id : null;
}
export function activeVerifiedEmails(db: Database.Database, uid: string): string[] {
  const emails = (db.prepare("SELECT email_norm FROM account_emails WHERE user_id=? AND revoked_at IS NULL").all(uid) as { email_norm: string }[]).map((row) => row.email_norm);
  const primary = db.prepare('SELECT email FROM "user" WHERE id=? AND emailVerified=1').get(uid) as { email: string } | undefined;
  const normalized = primary && normalizeIdentityEmail(primary.email);
  if (normalized) emails.push(normalized);
  return [...new Set(emails)].filter((email) => resolveVerifiedUserForEmail(db, email) === uid).sort();
}
export function createIdentityStore(db: Database.Database, options: IdentityStoreOptions) {
  if (typeof options.secret !== "string" || Buffer.byteLength(options.secret) < 32) fail("identity-unavailable", 503);
  const now = options.now ?? Date.now;
  const mac = (...parts: (string | null)[]) => createHmac("sha256", options.secret).update(JSON.stringify(parts)).digest("hex");
  const same = (a: string, b: string) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  const transaction = <T>(fn: () => T): T => db.transaction(fn).immediate();
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_emails (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), email_norm TEXT NOT NULL,
      email_display TEXT NOT NULL, verified_at INTEGER NOT NULL, proof_kind TEXT NOT NULL,
      source_account_id TEXT, revoked_at INTEGER, is_primary INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS account_emails_active_unique ON account_emails(email_norm) WHERE revoked_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS account_emails_primary_unique ON account_emails(user_id) WHERE revoked_at IS NULL AND is_primary=1;
    CREATE INDEX IF NOT EXISTS account_emails_user ON account_emails(user_id,revoked_at);
    CREATE TABLE IF NOT EXISTS account_identity_challenges (
      id TEXT PRIMARY KEY, user_id TEXT, session_hash TEXT NOT NULL, purpose TEXT NOT NULL, scope TEXT,
      target_email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS account_identity_challenge_expiry ON account_identity_challenges(expires_at);
    CREATE TABLE IF NOT EXISTS account_identity_proofs (
      proof_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS account_identity_rates (
      bucket TEXT PRIMARY KEY, started_at INTEGER NOT NULL, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_identity_session_factors (
      session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, user_id TEXT NOT NULL, identity_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_identity_session_identity ON account_identity_session_factors(identity_id,user_id);
  `);
  const user = (uid: string) => db.prepare('SELECT id,email,emailVerified FROM "user" WHERE id=?').get(uid) as UserRow | undefined;
  function validSession(uid: string, id: string): boolean {
    const session = db.prepare('SELECT userId,expiresAt FROM session WHERE id=?').get(id) as { userId: string; expiresAt: string | number } | undefined;
    const expiry = session && (typeof session.expiresAt === "number" ? session.expiresAt : /^\d+$/.test(session.expiresAt) ? Number(session.expiresAt) : Date.parse(session.expiresAt));
    return !!session && session.userId === uid && Number.isFinite(expiry) && expiry! > now();
  }
  const otherPrimary = (email: string, uid: string) => !!db.prepare('SELECT 1 FROM "user" WHERE lower(trim(email))=? AND id<>? LIMIT 1').get(email, uid);
  const alias = (email: string) => db.prepare("SELECT * FROM account_emails WHERE email_norm=? AND revoked_at IS NULL").get(email) as EmailRow | undefined;
  function available(email: string, uid: string) {
    const existing = alias(email);
    return !otherPrimary(email, uid) && (!existing || existing.user_id === uid);
  }
  function currentActor(actor: IdentityActor): UserRow {
    const row = actor && typeof actor.userId === "string" ? user(actor.userId) : undefined;
    if (!row || actor.emailVerified !== true || row.emailVerified !== 1 || typeof actor.sessionId !== "string" || !actor.sessionId || actor.sessionId.length > 512 ||
        normalizeIdentityEmail(actor.email) !== normalizeIdentityEmail(row.email) || !normalizeIdentityEmail(row.email) || !validSession(actor.userId, actor.sessionId)) fail("identity-authentication-required", 401);
    return row!;
  }
  function area(uid: string, id: string, email: string) {
    const result = options.ensureIdentityArea?.(uid, id, email);
    if (result && typeof (result as { then?: unknown }).then === "function") fail("identity-unavailable", 503);
  }
  function primary(uid: string): void {
    const row = user(uid), email = row && normalizeIdentityEmail(row.email);
    if (!row || row.emailVerified !== 1 || !email) return;
    if (!available(email, uid)) fail("identity-conflict", 409);
    const existing = alias(email);
    if (existing) return;
    if (db.prepare("SELECT 1 FROM account_emails WHERE user_id=? AND email_norm=? AND revoked_at IS NOT NULL LIMIT 1").get(uid, email)) return;
    const id = randomUUID();
    db.prepare("INSERT INTO account_emails(id,user_id,email_norm,email_display,verified_at,proof_kind,is_primary) VALUES(?,?,?,?,?,'primary',1)").run(id, uid, email, email, now());
    area(uid, id, email);
  }
  function backfillVerifiedPrimaries() {
    transaction(() => {
      const rows = db.prepare('SELECT id FROM "user" WHERE emailVerified=1').all() as { id: string }[];
      for (const row of rows) primary(row.id);
    });
  }
  // Explicit factory initialization only; importing this module opens no database.
  backfillVerifiedPrimaries();
  function verifiedUserForEmail(value: string): string | null {
    return resolveVerifiedUserForEmail(db, value);
  }
  function activeEmailsForUser(uid: string): string[] {
    return activeVerifiedEmails(db, uid);
  }
  function listIdentities(uid: string): AccountIdentity[] {
    transaction(() => primary(uid));
    return (db.prepare("SELECT * FROM account_emails WHERE user_id=? AND revoked_at IS NULL ORDER BY is_primary DESC,verified_at,id").all(uid) as EmailRow[])
      .map((row) => ({ id: row.id, email: row.email_display, primary: row.is_primary === 1, verifiedAt: row.verified_at }));
  }
  function rate(kind: string, value: string, max: number) {
    const bucket = mac("rate", kind, value), timestamp = now();
    const row = db.prepare("SELECT started_at,hits FROM account_identity_rates WHERE bucket=?").get(bucket) as { started_at: number; hits: number } | undefined;
    if (row && timestamp - row.started_at < 60000 && row.hits >= max) fail("identity-rate-limited", 429);
    db.prepare(`INSERT INTO account_identity_rates(bucket,started_at,hits,expires_at) VALUES(?,?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET started_at=excluded.started_at,hits=CASE WHEN account_identity_rates.started_at=excluded.started_at THEN account_identity_rates.hits+1 ELSE 1 END,expires_at=excluded.expires_at`)
      .run(bucket, row && timestamp - row.started_at < 60000 ? row.started_at : timestamp, timestamp + TTL);
  }
  function issue(uid: string | null, binding: string, purpose: string, email: string, scope: IdentityScope | null = null): IdentityDelivery {
    const timestamp = now();
    db.prepare("DELETE FROM account_identity_challenges WHERE expires_at<=?").run(timestamp);
    db.prepare("DELETE FROM account_identity_proofs WHERE expires_at<=?").run(timestamp);
    db.prepare("DELETE FROM account_identity_rates WHERE expires_at<=?").run(timestamp);
    rate("global", "all", 100); rate("user", uid ?? "anonymous", 20); rate("target", email, 5);
    db.prepare("UPDATE account_identity_challenges SET consumed_at=? WHERE purpose=? AND target_email=? AND consumed_at IS NULL").run(timestamp, purpose, email);
    const id = randomUUID(), code = String(randomInt(1000000)).padStart(6, "0"), session = mac("binding", binding);
    db.prepare("INSERT INTO account_identity_challenges(id,user_id,session_hash,purpose,scope,target_email,code_hash,expires_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, uid, session, purpose, scope, email, mac("otp", id, uid, session, purpose, scope, email, code), timestamp + TTL);
    return { challengeId: id, expiresInSeconds: 300, email, code };
  }
  function verify(id: string, code: string, purpose: string, binding: string, uid?: string): Challenge | null {
    if (typeof id !== "string" || id.length > 64 || typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
    const row = db.prepare("SELECT * FROM account_identity_challenges WHERE id=?").get(id) as Challenge | undefined;
    if (!row || row.purpose !== purpose || row.session_hash !== mac("binding", binding) || (uid !== undefined && row.user_id !== uid) ||
        row.consumed_at !== null || row.expires_at <= now() || row.attempts >= 3) return null;
    const matches = same(row.code_hash, mac("otp", row.id, row.user_id, row.session_hash, row.purpose, row.scope, row.target_email, code));
    db.prepare("UPDATE account_identity_challenges SET attempts=attempts+1,consumed_at=CASE WHEN ?=1 OR attempts+1>=3 THEN ? ELSE NULL END WHERE id=?")
      .run(matches ? 1 : 0, now(), id);
    return matches ? row : null;
  }
  function consumeProof(actor: IdentityActor, proofId: string, scope: IdentityScope): void {
    currentActor(actor);
    if (typeof proofId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proofId)) fail("invalid-verification", 400);
    const changed = db.prepare("UPDATE account_identity_proofs SET consumed_at=? WHERE proof_hash=? AND user_id=? AND session_hash=? AND scope=? AND expires_at>? AND consumed_at IS NULL")
      .run(now(), mac("proof", proofId), actor.userId, mac("binding", actor.sessionId), scope, now()).changes;
    if (changed !== 1) fail("invalid-verification", 400);
  }
  const consumeStepUp = (actor: IdentityActor, proofId: string, scope: IdentityScope) => transaction(() => consumeProof(actor, proofId, scope));
  return {
    verifiedUserForEmail, activeEmailsForUser, listIdentities, backfillVerifiedPrimaries, consumeStepUp,
    listProviders(uid: string): { id: string; providerId: string }[] {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account'").get()) return [];
      return db.prepare('SELECT id,providerId FROM account WHERE userId=? ORDER BY providerId,id').all(uid) as { id: string; providerId: string }[];
    },
    cancelChallenge(id: string) { db.prepare("UPDATE account_identity_challenges SET consumed_at=? WHERE id=?").run(now(), id); },
    finalizeAliasSession(userId: string, identityId: string, email: string, sessionId: string): boolean {
      return transaction(() => {
        const identity = alias(email);
        if (!identity || identity.id !== identityId || identity.user_id !== userId || verifiedUserForEmail(email) !== userId) return false;
        if (!validSession(userId, sessionId)) return false;
        db.prepare("DELETE FROM account_identity_session_factors WHERE session_id NOT IN (SELECT id FROM session)").run();
        db.prepare("INSERT INTO account_identity_session_factors(session_id,user_id,identity_id) VALUES(?,?,?)").run(sessionId, userId, identityId);
        return true;
      });
    },
    discardAliasSession(userId: string, sessionId: string) {
      transaction(() => { db.prepare('DELETE FROM session WHERE id=? AND userId=?').run(sessionId, userId); db.prepare("DELETE FROM account_identity_session_factors WHERE session_id=? AND user_id=?").run(sessionId, userId); });
    },
    startStepUp(actor: IdentityActor, scope: IdentityScope = "email-add") {
      return transaction(() => {
        const row = currentActor(actor);
        if (!["email-add", "email-remove", "google-link", "google-remove"].includes(scope)) fail("invalid-request", 400);
        primary(actor.userId);
        db.prepare("UPDATE account_identity_proofs SET consumed_at=? WHERE user_id=? AND session_hash=? AND scope=? AND consumed_at IS NULL").run(now(), actor.userId, mac("binding", actor.sessionId), scope);
        return issue(actor.userId, actor.sessionId, "step-up", normalizeIdentityEmail(row.email)!, scope);
      });
    },
    verifyStepUp(actor: IdentityActor, id: string, code: string) {
      const result = transaction(() => {
        currentActor(actor);
        const challenge = verify(id, code, "step-up", actor.sessionId, actor.userId);
        if (!challenge || !challenge.scope || challenge.target_email !== normalizeIdentityEmail(user(actor.userId)?.email)) return null;
        const proofId = randomBytes(32).toString("base64url");
        db.prepare("INSERT INTO account_identity_proofs(proof_hash,user_id,session_hash,scope,expires_at) VALUES(?,?,?,?,?)").run(mac("proof", proofId), actor.userId, mac("binding", actor.sessionId), challenge.scope, now() + TTL);
        return { proofId, expiresInSeconds: 300 };
      });
      if (!result) fail("invalid-verification", 400);
      return result!;
    },
    startEmail(actor: IdentityActor, value: string, proofId: string) {
      return transaction(() => {
        currentActor(actor); primary(actor.userId);
        const email = normalizeIdentityEmail(value);
        if (!email) fail("invalid-request", 400);
        if (!available(email!, actor.userId) || alias(email!)) fail("identity-conflict", 409);
        if (activeEmailsForUser(actor.userId).length >= 20) fail("identity-limit", 409);
        consumeProof(actor, proofId, "email-add");
        return issue(actor.userId, actor.sessionId, "email-add", email!);
      });
    },
    verifyEmail(actor: IdentityActor, id: string, code: string): AccountIdentity {
      const result = transaction(() => {
        currentActor(actor);
        const challenge = verify(id, code, "email-add", actor.sessionId, actor.userId);
        if (!challenge) return { error: "invalid-verification" };
        if (!available(challenge.target_email, actor.userId) || alias(challenge.target_email)) return { error: "identity-conflict" };
        if (activeEmailsForUser(actor.userId).length >= 20) return { error: "identity-conflict" };
        const identityId = randomUUID(), timestamp = now();
        db.prepare("INSERT INTO account_emails(id,user_id,email_norm,email_display,verified_at,proof_kind,is_primary) VALUES(?,?,?,?,?,'email-otp',0)").run(identityId, actor.userId, challenge.target_email, challenge.target_email, timestamp);
        area(actor.userId, identityId, challenge.target_email);
        return { identity: { id: identityId, email: challenge.target_email, primary: false, verifiedAt: timestamp } };
      });
      if (!result.identity) fail(result.error!, result.error === "identity-conflict" ? 409 : 400);
      return result.identity!;
    },
    removeIdentity(actor: IdentityActor, id: string, proofId: string) {
      return transaction(() => {
        const row = currentActor(actor), identity = db.prepare("SELECT * FROM account_emails WHERE id=? AND user_id=? AND revoked_at IS NULL").get(id, actor.userId) as EmailRow | undefined;
        if (!identity || identity.is_primary || identity.email_norm === normalizeIdentityEmail(row.email)) fail("identity-not-removable", 409);
        consumeProof(actor, proofId, "email-remove");
        const revokedSessionIds = (db.prepare("SELECT session_id FROM account_identity_session_factors WHERE identity_id=? AND user_id=?").all(id, actor.userId) as { session_id: string }[]).map((session) => session.session_id);
        db.prepare("UPDATE account_emails SET revoked_at=? WHERE id=?").run(now(), id);
        db.prepare('DELETE FROM session WHERE userId=? AND id IN (SELECT session_id FROM account_identity_session_factors WHERE identity_id=? AND user_id=?)').run(actor.userId, id, actor.userId);
        db.prepare("DELETE FROM account_identity_session_factors WHERE identity_id=? AND user_id=?").run(id, actor.userId);
        db.prepare("UPDATE account_identity_challenges SET consumed_at=? WHERE target_email=? AND consumed_at IS NULL").run(now(), identity!.email_norm);
        return { revokedSessionIds };
      });
    },
    startAliasSignIn(value: string, flowId: string): IdentityDelivery {
      return transaction(() => {
        const email = normalizeIdentityEmail(value);
        if (!email || !/^[A-Za-z0-9_-]{43}$/.test(flowId)) fail("invalid-request", 400);
        const uid = verifiedUserForEmail(email!);
        if (uid) primary(uid); // Newly verified primary after initial backfill.
        const delivery = issue(uid, flowId, "alias-sign-in", email!);
        return uid ? delivery : { challengeId: delivery.challengeId, expiresInSeconds: 300 };
      });
    },
    verifyAliasSignIn(id: string, code: string, flowId: string): { userId: string; identityId: string; email: string } {
      const result = transaction(() => {
        const row = verify(id, code, "alias-sign-in", flowId);
        const identity = row && alias(row.target_email);
        return row?.user_id && identity && verifiedUserForEmail(row.target_email) === row.user_id ? { userId: row.user_id, identityId: identity.id, email: identity.email_norm } : null;
      });
      if (!result) fail("invalid-verification", 400);
      return result!;
    },
  };
}
export type IdentityStore = ReturnType<typeof createIdentityStore>;
