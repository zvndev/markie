// One-time upgrade shim: take back the `account.issuer` column that
// better-auth 1.7.0 through 1.7.2 asked for.
//
// Those releases scoped account identity by issuer and wanted a required
// `issuer` column plus a unique index on (issuer, accountId). 1.7.3 reverted
// that and went back to identifying an account by (providerId, accountId), as
// 1.6 did. New rows no longer write `issuer` at all. So what is left behind
// depends on how the database got the column:
//
//   * A database created fresh on 1.7.0-1.7.2 has `issuer TEXT NOT NULL`.
//     Every sign-up and every Google link now fails on that constraint, and
//     better-auth's own startup check rejects every auth request until the
//     column is gone ("Required columns Better Auth never writes").
//   * A database that was populated before 1.7 got the column from our old
//     backfill shim, nullable, and still works. The column is dead weight.
//
// better-auth's upgrade guide gives the SQLite repair as: drop the unique
// index, then drop the column (SQLite has no ALTER COLUMN, and refuses to drop
// a column an index still covers). This applies exactly that, to both shapes,
// so every deployment ends on the 1.6 account schema better-auth now expects.
// https://www.better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-keeps-the-provider-key
//
// Nothing is lost that anything reads: the value was a per-provider constant
// derived from `providerId`, and no Markie code ever read it. Rolling back to
// an image on better-auth 1.7.1 re-runs that image's backfill, which adds the
// column back and fills it again.
//
// Idempotent: when the column is already gone this costs one PRAGMA, so it
// runs on every boot.
import Database from "better-sqlite3";

export function relaxAccountIssuer(dbPath: string): { dropped: boolean; indexes: string[] } {
  const db = new Database(dbPath);
  try {
    const hasAccount = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='account'")
      .get() as { n: number };
    // A brand new database has no account table yet; the boot migration will
    // create it without the column.
    if (hasAccount.n === 0) return { dropped: false, indexes: [] };

    const columns = (db.prepare("PRAGMA table_info(account)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    if (!columns.includes("issuer")) return { dropped: false, indexes: [] };

    // Every explicit index that covers the column has to go first. The one
    // better-auth made is account_issuer_accountId_uidx, but a renamed or
    // hand-made one would block the DROP COLUMN just the same.
    const indexes = (
      db.prepare("PRAGMA index_list(account)").all() as Array<{ name: string; origin: string }>
    )
      .filter((ix) => ix.origin === "c")
      .map((ix) => ix.name)
      .filter((name) =>
        (db.prepare(`PRAGMA index_info("${name.replaceAll('"', '""')}")`).all() as Array<{ name: string }>).some(
          (col) => col.name === "issuer"
        )
      );

    const run = db.transaction(() => {
      for (const name of indexes) db.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
      db.exec("ALTER TABLE account DROP COLUMN issuer");
    });
    run();
    return { dropped: true, indexes };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const path = process.env.DB_PATH ?? "./markie.db";
  try {
    const { dropped, indexes } = relaxAccountIssuer(path);
    console.log(
      dropped
        ? `relax-account-issuer: dropped account.issuer${indexes.length ? ` and ${indexes.join(", ")}` : ""}`
        : "relax-account-issuer: nothing to do"
    );
  } catch (err) {
    // Never block boot on this: documents, sharing and public links do not
    // depend on it, and better-auth's own startup check names the column that
    // is still in the way.
    console.error("relax-account-issuer failed:", err);
  }
  process.exit(0);
}
