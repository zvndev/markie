import type Database from "better-sqlite3";
import { openDatabase } from "./db.ts";

/** Server-only proof callbacks, evaluated on the caller's transaction handle. */
export interface ShareIdentities {
  verifiedUserForEmail(email: string, db: Database.Database): string | null;
  activeEmailsForUser(userId: string, db: Database.Database): string[];
}
let identities: ShareIdentities | null = null;
export function configureShareIdentities(value: ShareIdentities | null): void { identities = value; }
const norm = (email: string) => email.toLowerCase().trim();
type Role = "viewer" | "editor";
interface Pending { doc_id: string; email: string; role: Role; invited_by: string; token: string; created_at: string; decision_revision: number }

/** Claims and owner decisions use one SQLite transaction, including identity proof. */
export function createPendingShareStore(db: Database.Database, options: { identities?: ShareIdentities | null } = {}) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS pending_shares(doc_id TEXT NOT NULL,email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','editor')),invited_by TEXT NOT NULL,token TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(doc_id,email));" +
    "CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_shares(email);CREATE INDEX IF NOT EXISTS idx_pending_token ON pending_shares(token);" +
    "CREATE TABLE IF NOT EXISTS share_decision_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);INSERT OR IGNORE INTO share_decision_clock(id,revision) VALUES(1,0);" +
    "CREATE TABLE IF NOT EXISTS share_recipient_decisions(doc_id TEXT NOT NULL,user_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(doc_id,user_id));" +
    "CREATE TABLE IF NOT EXISTS share_address_decisions(doc_id TEXT NOT NULL,email TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(doc_id,email));" +
    "CREATE TABLE IF NOT EXISTS share_invite_tokens(token TEXT PRIMARY KEY,doc_id TEXT NOT NULL,user_id TEXT NOT NULL);" +
    "CREATE INDEX IF NOT EXISTS idx_share_invite_member ON share_invite_tokens(doc_id,user_id);"
  );
  if (!(db.prepare("PRAGMA table_info(pending_shares)").all() as { name: string }[]).some(column => column.name === "decision_revision")) db.exec("ALTER TABLE pending_shares ADD COLUMN decision_revision INTEGER NOT NULL DEFAULT 0");
  const proof = () => options.identities === undefined ? identities : options.identities;
  const verifiedUserForEmail = (email: string): string | null => {
    const e = norm(email), resolver = proof();
    const id = resolver ? resolver.verifiedUserForEmail(e, db) : (db.prepare('SELECT id FROM "user" WHERE lower(email)=? AND emailVerified=1').get(e) as { id: string } | undefined)?.id;
    return id && db.prepare('SELECT 1 FROM "user" WHERE id=? AND emailVerified=1').get(id) ? id : null;
  };
  const activeEmailsForUser = (userId: string): string[] => {
    const resolver = proof(), primary = db.prepare('SELECT email FROM "user" WHERE id=? AND emailVerified=1').get(userId) as { email: string } | undefined;
    if (!primary) return [];
    return [...new Set((resolver ? resolver.activeEmailsForUser(userId, db) : [primary.email]).map(norm))].filter(email => verifiedUserForEmail(email) === userId).sort();
  };
  const nextRevision = () => {
    db.prepare("UPDATE share_decision_clock SET revision=revision+1 WHERE id=1").run();
    return (db.prepare("SELECT revision FROM share_decision_clock WHERE id=1").get() as { revision: number }).revision;
  };
  const addressFence = (docId: string, email: string, revision: number) => db.prepare("INSERT INTO share_address_decisions(doc_id,email,revision) VALUES(?,?,?) ON CONFLICT(doc_id,email) DO UPDATE SET revision=excluded.revision").run(docId, email, revision);
  const retainTokens = (docId: string, userId: string, tokens: string[]) => {
    for (const token of tokens) db.prepare("INSERT OR IGNORE INTO share_invite_tokens(token,doc_id,user_id) VALUES(?,?,?)").run(token, docId, userId);
  };
  const fenceMember = (docId: string, userId: string) => {
    const prior = (db.prepare("SELECT revision FROM share_recipient_decisions WHERE doc_id=? AND user_id=?").get(docId, userId) as { revision: number } | undefined)?.revision ?? -1;
    const revision = nextRevision(), tokens: string[] = [];
    let pendingRemoved = 0;
    db.prepare("INSERT INTO share_recipient_decisions(doc_id,user_id,revision) VALUES(?,?,?) ON CONFLICT(doc_id,user_id) DO UPDATE SET revision=excluded.revision").run(docId, userId, revision);
    for (const email of activeEmailsForUser(userId)) {
      const previousAddress = (db.prepare("SELECT revision FROM share_address_decisions WHERE doc_id=? AND email=?").get(docId, email) as { revision: number } | undefined)?.revision ?? -1;
      const pending = db.prepare("SELECT token,decision_revision FROM pending_shares WHERE doc_id=? AND email=?").get(docId, email) as Pick<Pending, "token" | "decision_revision"> | undefined;
      if (pending && pending.decision_revision > Math.max(prior, previousAddress)) tokens.push(pending.token);
      addressFence(docId, email, revision); pendingRemoved += db.prepare("DELETE FROM pending_shares WHERE doc_id=? AND email=?").run(docId, email).changes;
    }
    return { tokens, pendingRemoved };
  };
  const claim = (userId: string, requestedEmail?: string): number => db.transaction(() => {
    if (requestedEmail !== undefined && verifiedUserForEmail(requestedEmail) !== userId) return 0;
    const pending = activeEmailsForUser(userId).flatMap(email => db.prepare("SELECT * FROM pending_shares WHERE email=?").all(email) as Pending[]);
    const groups = new Map<string, Pending[]>();
    for (const row of pending) { const group = groups.get(row.doc_id) ?? []; group.push(row); groups.set(row.doc_id, group); }
    for (const [docId, rows] of groups) {
      const doc = db.prepare("SELECT owner_id FROM docs WHERE id=? AND deleted_at IS NULL").get(docId) as { owner_id: string } | undefined;
      const decision = (db.prepare("SELECT revision FROM share_recipient_decisions WHERE doc_id=? AND user_id=?").get(docId, userId) as { revision: number } | undefined)?.revision ?? -1;
      const eligible = rows.filter(row => {
        const address = (db.prepare("SELECT revision FROM share_address_decisions WHERE doc_id=? AND email=?").get(docId, row.email) as { revision: number } | undefined)?.revision ?? -1;
        return row.decision_revision > Math.max(decision, address) && verifiedUserForEmail(row.email) === userId;
      }).sort((a, b) => b.decision_revision - a.decision_revision || b.created_at.localeCompare(a.created_at) || (a.role === b.role ? a.email.localeCompare(b.email) : a.role === "viewer" ? -1 : 1));
      if (doc && doc.owner_id !== userId && eligible.length) {
        const chosen = eligible[0];
        // Address verification is not an owner command: existing access wins.
        db.prepare("INSERT INTO shares(doc_id,user_id,role,invited_by,created_at,token) VALUES(?,?,?,?,?,?) ON CONFLICT(doc_id,user_id) DO UPDATE SET token=COALESCE(shares.token,excluded.token)").run(docId, userId, chosen.role, chosen.invited_by, new Date().toISOString(), chosen.token);
        retainTokens(docId, userId, eligible.map(row => row.token));
      }
      for (const row of rows) db.prepare("DELETE FROM pending_shares WHERE doc_id=? AND email=?").run(docId, row.email);
    }
    return pending.length;
  }).immediate();
  return {
    verifiedUserForEmail, activeEmailsForUser,
    addPending(docId: string, email: string, role: Role, invitedBy: string): string {
      return db.transaction(() => {
        const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""), e = norm(email), revision = nextRevision();
        db.prepare("INSERT INTO pending_shares(doc_id,email,role,invited_by,token,created_at,decision_revision) VALUES(?,?,?,?,?,?,?) ON CONFLICT(doc_id,email) DO UPDATE SET role=excluded.role,invited_by=excluded.invited_by,created_at=excluded.created_at,decision_revision=excluded.decision_revision").run(docId, e, role, invitedBy, token, new Date().toISOString(), revision);
        return (db.prepare("SELECT token FROM pending_shares WHERE doc_id=? AND email=?").get(docId, e) as { token: string }).token;
      }).immediate();
    },
    listPendingForDoc(docId: string) { return db.prepare("SELECT email,role,created_at FROM pending_shares WHERE doc_id=?").all(docId) as { email: string; role: string; created_at: string }[]; },
    pendingForToken(token: string) {
      const row = token ? db.prepare("SELECT doc_id,email,role FROM pending_shares WHERE token=?").get(token) as Pending | undefined : undefined;
      return row ? { docId: row.doc_id, email: row.email, role: row.role } : null;
    },
    memberForInviteToken(token: string) {
      const row = db.prepare("SELECT t.doc_id,t.user_id FROM share_invite_tokens t JOIN shares s ON s.doc_id=t.doc_id AND s.user_id=t.user_id WHERE t.token=?").get(token) as { doc_id: string; user_id: string } | undefined;
      return row ? { docId: row.doc_id, userId: row.user_id } : null;
    },
    removePending(docId: string, email: string): boolean {
      return db.transaction(() => { const e = norm(email); addressFence(docId, e, nextRevision()); return db.prepare("DELETE FROM pending_shares WHERE doc_id=? AND email=?").run(docId, e).changes > 0; }).immediate();
    },
    grantMember(docId: string, userId: string, role: Role, invitedBy: string): void {
      db.transaction(() => {
        const { tokens } = fenceMember(docId, userId);
        db.prepare("INSERT INTO shares(doc_id,user_id,role,invited_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(doc_id,user_id) DO UPDATE SET role=excluded.role").run(docId, userId, role, invitedBy, new Date().toISOString());
        retainTokens(docId, userId, tokens);
      }).immediate();
    },
    shareWithEmail(docId: string, email: string, role: Role, invitedBy: string) {
      return db.transaction(() => {
        const userId = verifiedUserForEmail(email);
        const recipient = userId ? db.prepare('SELECT id,email,name FROM "user" WHERE id=? AND emailVerified=1').get(userId) as { id: string; email: string; name: string } | undefined : undefined;
        if (!recipient || recipient.id === invitedBy) return recipient ?? null;
        const { tokens } = fenceMember(docId, recipient.id);
        db.prepare("INSERT INTO shares(doc_id,user_id,role,invited_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(doc_id,user_id) DO UPDATE SET role=excluded.role").run(docId, recipient.id, role, invitedBy, new Date().toISOString());
        retainTokens(docId, recipient.id, tokens);
        return recipient;
      }).immediate();
    },
    revokeMember(docId: string, userId: string): boolean {
      return db.transaction(() => {
        const { pendingRemoved } = fenceMember(docId, userId); db.prepare("DELETE FROM share_invite_tokens WHERE doc_id=? AND user_id=?").run(docId, userId);
        return db.prepare("DELETE FROM shares WHERE doc_id=? AND user_id=?").run(docId, userId).changes > 0 || pendingRemoved > 0;
      }).immediate();
    },
    claimPendingInvites: (email: string, userId: string) => claim(userId, email),
    claimPendingInvitesForUser: (userId: string) => claim(userId),
    removeDocPending(docId: string) {
      return db.transaction(() => { db.prepare("DELETE FROM share_invite_tokens WHERE doc_id=?").run(docId); return db.prepare("DELETE FROM pending_shares WHERE doc_id=?").run(docId).changes; }).immediate();
    },
  };
}

const store = createPendingShareStore(openDatabase());
export const addPending = store.addPending;
export const listPendingForDoc = store.listPendingForDoc;
export const pendingForToken = store.pendingForToken;
export const removePending = store.removePending;
export const claimPendingInvites = store.claimPendingInvites;
export const claimPendingInvitesForUser = store.claimPendingInvitesForUser;
export const removeDocPending = store.removeDocPending;
