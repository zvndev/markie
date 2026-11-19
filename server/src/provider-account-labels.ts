// Which Google or Apple account a linked sign-in is, for the person looking at
// the list. Two Google rows used to read "Google sign-in 1" and "Google
// sign-in 2", with nothing to tell them apart.
//
// The address is copied once, when the provider row is created by a link or a
// sign-up, from the ID token the provider's token endpoint just returned. It
// is a label and nothing else: never read for sign-in, for matching an
// account, or as somewhere to send mail. Proving a mailbox is the email flow's
// job (account-identities.ts). Rows created before this table existed have no
// label and keep the old name in the list.
import type Database from "better-sqlite3";
import { isLinkProvider } from "./provider-identity-links.ts";

const MAX_EMAIL = 254;

/** The `email` claim of a provider ID token, decoded but not verified, or null. */
export function idTokenEmail(idToken: unknown): string | null {
  if (typeof idToken !== "string" || idToken.length > 16_384) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
  const email = claims && typeof claims === "object" ? (claims as { email?: unknown }).email : undefined;
  if (typeof email !== "string") return null;
  const value = email.trim();
  // Shown as the provider gives it (an Apple relay address included), so it
  // only has to be one printable line that looks like an address.
  return value.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+$/.test(value) && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

export interface ProviderRow { id: string; providerId: string }

/** Installed by the account platform. Creating it makes the table; nothing else migrates. */
export function createProviderAccountLabels(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_provider_labels (
    account_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    email TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  // Only a label whose account row still exists, for the same user and
  // provider, is ever shown. Prepared on first use: better-auth's migration
  // may create the account table after this module is installed.
  let lookup: Database.Statement | undefined;
  const find = (id: string, providerId: string) => (lookup ??= db.prepare(`SELECT l.email FROM account_provider_labels l
    JOIN account a ON a.id=l.account_id AND a.userId=l.user_id AND a.providerId=l.provider_id
    WHERE l.account_id=? AND l.provider_id=?`)).get(id, providerId) as { email: string } | undefined;
  return {
    /** Called for every new account row. Display only, so it never throws into sign-in. */
    record(account: { id?: unknown; userId?: unknown; providerId?: unknown; idToken?: unknown }): void {
      try {
        if (!isLinkProvider(account.providerId) || typeof account.id !== "string" || typeof account.userId !== "string") return;
        const email = idTokenEmail(account.idToken);
        if (!email) return;
        db.prepare("INSERT OR IGNORE INTO account_provider_labels(account_id,user_id,provider_id,email,created_at) VALUES(?,?,?,?,?)")
          .run(account.id, account.userId, account.providerId, email, Date.now());
      } catch (error) {
        console.error("recording a linked sign-in's address failed:", error);
      }
    },
    /** The listing's provider rows, each with `email` when one was recorded for it. */
    label<T extends ProviderRow>(rows: T[]): (T & { email?: string })[] {
      return rows.map((row) => {
        if (!isLinkProvider(row.providerId)) return row;
        const found = find(row.id, row.providerId);
        return found ? { ...row, email: found.email } : row;
      });
    },
    /** Same connection and transaction as the provider row's removal. */
    remove(accountId: string): void {
      db.prepare("DELETE FROM account_provider_labels WHERE account_id=?").run(accountId);
    },
  };
}
export type ProviderAccountLabels = ReturnType<typeof createProviderAccountLabels>;
