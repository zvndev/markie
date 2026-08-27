// One-time upgrade shim for better-auth 1.7.
//
// 1.7 scopes account identity by issuer, so `account` gains a required `issuer`
// column. better-auth deliberately REFUSES to add it to a populated table:
// there is no default, so every existing row would end up holding the same
// empty string and two different providers' accounts would collide on it. It
// stops and tells you to add the column nullable, backfill a correct value per
// row, and only then enforce NOT NULL.
//
// That refusal happens inside the boot migration, which means an existing
// deployment cannot start at all until someone backfills. This script is that
// someone, so the container repairs itself instead of crash-looping.
//
// The value per row is not ours to invent: it has to match exactly what the
// library writes for new accounts, or an existing user's account stops being
// found and they cannot sign in. So each provider is asked rather than guessed:
// a social provider that declares `accountIssuer` (Google says
// "https://accounts.google.com") supplies its own, anything else falls back to
// the same helper better-auth uses, and password accounts take the local form.
//
// Idempotent by construction: it adds the column only if missing and only
// touches rows whose issuer is still null or empty, so running it on every boot
// forever costs one PRAGMA.
import Database from "better-sqlite3";
import { createLocalAccountIssuer, createOAuthAccountIssuer } from "@better-auth/core/db";
import * as socialProviders from "@better-auth/core/social-providers";

// better-auth's own name for a password account.
const CREDENTIAL = "credential";

export function issuerFor(providerId: string): string {
  if (providerId === CREDENTIAL) return createLocalAccountIssuer(CREDENTIAL);

  // Social providers are exported as factories, not config objects, so the
  // declared issuer only exists once one is called. The credentials are
  // irrelevant here: nothing is contacted, the factory just returns its config,
  // and we read the constant off it. Getting this wrong is not cosmetic. Google
  // declares "https://accounts.google.com", so falling back to the generic
  // helper would write "local:oauth:google", and every existing Google user
  // would stop being found by their own account row.
  const factory = (socialProviders as Record<string, unknown>)[providerId];
  if (typeof factory === "function") {
    try {
      const config = (factory as (o: unknown) => unknown)({
        clientId: "unused",
        clientSecret: "unused",
      });
      const declared = (config as { accountIssuer?: unknown } | null)?.accountIssuer;
      if (typeof declared === "string" && declared.length > 0) return declared;
    } catch {
      // A provider that cannot be constructed without real options has not
      // declared a constant issuer either, so the generic form below is right.
    }
  }
  return createOAuthAccountIssuer(providerId);
}

export function backfill(dbPath: string): { added: boolean; updated: number; remaining: number } {
  const db = new Database(dbPath);
  try {
    const hasAccount = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='account'")
      .get() as { n: number };
    // A brand new database has no account table yet; the boot migration will
    // create it with the column already required, and there is nothing to fix.
    if (hasAccount.n === 0) return { added: false, updated: 0, remaining: 0 };

    const columns = (db.prepare("PRAGMA table_info(account)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    let added = false;
    if (!columns.includes("issuer")) {
      db.exec("ALTER TABLE account ADD COLUMN issuer TEXT");
      added = true;
    }

    const providers = (
      db
        .prepare("SELECT DISTINCT providerId FROM account WHERE issuer IS NULL OR issuer = ''")
        .all() as Array<{ providerId: string }>
    ).map((r) => r.providerId);

    const update = db.prepare(
      "UPDATE account SET issuer = ? WHERE providerId = ? AND (issuer IS NULL OR issuer = '')"
    );
    let updated = 0;
    const run = db.transaction(() => {
      for (const providerId of providers) {
        updated += update.run(issuerFor(providerId), providerId).changes;
      }
    });
    run();

    const remaining = (
      db.prepare("SELECT COUNT(*) AS n FROM account WHERE issuer IS NULL OR issuer = ''").get() as {
        n: number;
      }
    ).n;
    return { added, updated, remaining };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const path = process.env.DB_PATH ?? "./markie.db";
  const { added, updated, remaining } = backfill(path);
  console.log(
    `backfill-issuer: column ${added ? "added" : "already present"}, ${updated} row(s) backfilled, ${remaining} still empty`
  );
  // Never block boot on a leftover: the migration that follows reports the real
  // drift, and refusing to start would reproduce the outage this exists to end.
  process.exit(0);
}
