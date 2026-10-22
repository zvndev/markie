// Who may create an account on this server: MARKIE_SIGNUP.
//
//   open     anyone. Markie Cloud's behaviour, and the default there.
//   invite   the default on a self-hosted server. The first account becomes the
//            admin; after that only an address someone on this server has
//            invited to a document, or one the admin has allowed, may sign up.
//   closed   no new accounts at all.
//
// Enforced in better-auth's user-create hook (auth.ts), which every path that
// makes an account goes through: email sign-up, a first email-code sign-in,
// and a first Google sign-in. A self-hosted server is a private document
// cloud, so the open default would hand a stranger who finds the domain an
// account and somewhere to put files.
import type Database from "better-sqlite3";
import { APIError } from "better-auth/api";
import { officialFlag } from "./official.ts";

export type SignupMode = "open" | "invite" | "closed";
type Env = Record<string, string | undefined>;

export function signupMode(env: Env = process.env): SignupMode {
  const raw = env.MARKIE_SIGNUP?.trim();
  if (!raw) return officialFlag(env) ? "open" : "invite";
  if (raw === "open" || raw === "invite" || raw === "closed") return raw;
  throw new Error("MARKIE_SIGNUP must be open, invite or closed.");
}

/** The pinned admin address, if MARKIE_ADMIN_EMAIL is set. */
export function adminEmail(env: Env = process.env): string | null {
  const raw = env.MARKIE_ADMIN_EMAIL?.trim().toLowerCase();
  if (!raw) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new Error("MARKIE_ADMIN_EMAIL must be an email address.");
  return raw;
}

export const SIGNUP_INVITE_REQUIRED = "signup_invite_required";
export const SIGNUP_CLOSED = "signup_closed";

const norm = (email: string) => email.trim().toLowerCase();

export function ensureAllowlist(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS signup_allowlist(email TEXT PRIMARY KEY, added_by TEXT, created_at TEXT NOT NULL)"
  );
}

const tableExists = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function allowlist(db: Database.Database): { email: string; addedBy: string | null; createdAt: string }[] {
  ensureAllowlist(db);
  return (db.prepare("SELECT email, added_by, created_at FROM signup_allowlist ORDER BY email").all() as {
    email: string; added_by: string | null; created_at: string;
  }[]).map((row) => ({ email: row.email, addedBy: row.added_by, createdAt: row.created_at }));
}

export function allowEmail(db: Database.Database, email: string, addedBy: string | null): string {
  const e = norm(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 320) throw new Error("not an email address");
  ensureAllowlist(db);
  db.prepare("INSERT INTO signup_allowlist(email, added_by, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING")
    .run(e, addedBy, new Date().toISOString());
  return e;
}

export function disallowEmail(db: Database.Database, email: string): boolean {
  ensureAllowlist(db);
  return db.prepare("DELETE FROM signup_allowlist WHERE email = ?").run(norm(email)).changes > 0;
}

/**
 * The admin's account id, or null before anyone has signed up. The pinned
 * address when MARKIE_ADMIN_EMAIL is set, otherwise the first account ever
 * created. Either way it must have proven its address.
 */
export function adminUserId(db: Database.Database, env: Env = process.env): string | null {
  if (!tableExists(db, "user")) return null;
  const pinned = adminEmail(env);
  const row = pinned
    ? db.prepare('SELECT id, emailVerified FROM "user" WHERE lower(email) = ?').get(pinned)
    : db.prepare('SELECT id, emailVerified FROM "user" ORDER BY createdAt ASC, rowid ASC LIMIT 1').get();
  const user = row as { id: string; emailVerified: number | boolean } | undefined;
  return user && user.emailVerified ? user.id : null;
}

/** Why this address may not create an account, or null when it may. */
export function signupRefusal(db: Database.Database, email: string, env: Env = process.env): typeof SIGNUP_INVITE_REQUIRED | typeof SIGNUP_CLOSED | null {
  const mode = signupMode(env);
  if (mode === "open") return null;
  if (mode === "closed") return SIGNUP_CLOSED;
  const e = norm(email);
  const pinned = adminEmail(env);
  if (pinned) {
    if (e === pinned) return null;
  } else if (!tableExists(db, "user") || !db.prepare('SELECT 1 FROM "user" LIMIT 1').get()) {
    // Nobody yet: this is the admin.
    return null;
  }
  if (tableExists(db, "pending_shares") && db.prepare("SELECT 1 FROM pending_shares WHERE email = ? LIMIT 1").get(e)) return null;
  if (tableExists(db, "signup_allowlist") && db.prepare("SELECT 1 FROM signup_allowlist WHERE email = ?").get(e)) return null;
  return SIGNUP_INVITE_REQUIRED;
}

const MESSAGES = {
  [SIGNUP_INVITE_REQUIRED]: "This Markie server is invite-only. Ask someone here to share a document with this address, or ask the server's admin to allow it.",
  [SIGNUP_CLOSED]: "This Markie server is not accepting new accounts.",
} as const;

export function signupRefusalMessage(code: keyof typeof MESSAGES): string {
  return MESSAGES[code];
}

/** Throws the refusal better-auth turns into a 403 JSON body (and a Google error redirect). */
export function assertSignupAllowed(db: Database.Database, email: string, env: Env = process.env): void {
  const refusal = signupRefusal(db, email, env);
  if (refusal) throw new APIError("FORBIDDEN", { code: refusal, message: MESSAGES[refusal] });
}
