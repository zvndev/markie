// One-time backfill for the email-verification deploy.
//
// Accounts created before verification existed are grandfathered as verified so
// that existing users keep signing in. Everything created after the deploy has
// to prove its address the normal way.
//
// DRY RUN BY DEFAULT. The script writes nothing unless --commit is passed, and
// it prints the same audit report either way. The report answers three
// questions before any grandfathering happens:
//   1. how many accounts are about to be grandfathered, and their creation-date
//      range;
//   2. how many pending invites were already claimed into shares, versus how
//      many are still waiting;
//   3. FLAGGED: already-claimed shares whose claiming account never proved
//      ownership of the address and has no OAuth account. That is the signature
//      of the share-takeover flaw having actually been exercised. Zero rows are
//      expected. Any non-zero result stops the run, because grandfathering such
//      an account would turn a stolen claim into a legitimate-looking one.
//
// Run by a human, against a backed-up database, after the server deploy:
//   node --experimental-strip-types src/migrate-verified.ts <cutoff-iso>
//   node --experimental-strip-types src/migrate-verified.ts <cutoff-iso> --commit
//
// Exit codes: 0 nothing to worry about, 1 bad usage, 2 flagged rows found
// (nothing was written).
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

export interface FlaggedShare {
  doc_id: string;
  user_id: string;
  email: string;
  role: string;
  created_at: string;
}

export interface AuditReport {
  cutoff: string;
  toGrandfather: { n: number; first: string | null; last: string | null };
  claimed: number;
  stillPending: number;
  flagged: FlaggedShare[];
}

// Which share rows came from claiming a pending invite.
//
// NOT `token IS NOT NULL`. Every share gets a token the first time its link is
// emailed, including a direct share to someone who already had an account
// (shares.ts ensureShareToken, called from the "member" branch of the share
// route), so "has a token" describes almost every share and would flag the
// whole database.
//
// The two token shapes are what tell them apart. A pending invite's token is
// two UUIDs with the dashes stripped: exactly 64 lowercase hex characters
// (pending.ts addPending). A member link is 32 random bytes in base64url: 43
// characters, mixed case, and usually carrying - or _ (link-token.ts
// newLinkToken). Claiming moves the pending token onto the share row and
// COALESCE keeps any token already there, so a claimed row keeps the 64-hex
// shape for good.
const CLAIMED_FROM_INVITE =
  "s.token IS NOT NULL AND length(s.token) = 64 AND s.token NOT GLOB '*[^0-9a-f]*'";

export function auditVerification(
  db: Database.Database,
  cutoff: string
): AuditReport {
  // createdAt is stored as an ISO-8601 UTC string, so a lexicographic
  // comparison against an ISO cutoff is also a chronological one. Confirm this
  // against the live schema before running (see the runbook).
  const toGrandfather = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(createdAt) AS first, MAX(createdAt) AS last
         FROM user WHERE createdAt < ? AND emailVerified = 0`
    )
    .get(cutoff) as AuditReport["toGrandfather"];

  const claimed = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM shares s WHERE ${CLAIMED_FROM_INVITE}`)
      .get() as { n: number }
  ).n;

  const stillPending = (
    db.prepare("SELECT COUNT(*) AS n FROM pending_shares").get() as { n: number }
  ).n;

  // The vulnerability signature: a claimed share held by an account that never
  // proved its address and did not arrive through OAuth, which proves it at the
  // provider.
  const flagged = db
    .prepare(
      `SELECT s.doc_id, s.user_id, u.email, s.role, s.created_at
         FROM shares s
         JOIN user u ON u.id = s.user_id
        WHERE ${CLAIMED_FROM_INVITE}
          AND u.emailVerified = 0
          AND NOT EXISTS (
            SELECT 1 FROM account a
             WHERE a.userId = u.id AND a.providerId <> 'credential'
          )
        ORDER BY s.created_at`
    )
    .all() as FlaggedShare[];

  return { cutoff, toGrandfather, claimed, stillPending, flagged };
}

export function formatReport(r: AuditReport): string {
  const lines = [
    `migrate-verified audit (cutoff ${r.cutoff})`,
    `  accounts to grandfather: ${r.toGrandfather.n}` +
      (r.toGrandfather.n
        ? ` (created ${r.toGrandfather.first} .. ${r.toGrandfather.last})`
        : ""),
    `  invites already claimed into shares: ${r.claimed}`,
    `  invites still pending (protected from now on): ${r.stillPending}`,
    `  FLAGGED claimed shares by never-verified accounts: ${r.flagged.length}`,
  ];
  for (const f of r.flagged) {
    lines.push(
      `    doc ${f.doc_id} -> user ${f.user_id} <${f.email}> role ${f.role} claimed ${f.created_at}`
    );
  }
  if (r.flagged.length > 0) {
    lines.push(
      "  STOP: the takeover flaw appears to have been exercised. Nothing was",
      "  written. Review the flagged rows with the owner and revoke the stolen",
      "  shares before re-running, because grandfathering those accounts would",
      "  turn a stolen claim into a legitimate-looking one."
    );
  }
  return lines.join("\n");
}

export function grandfather(db: Database.Database, cutoff: string): number {
  return db
    .prepare(
      "UPDATE user SET emailVerified = 1 WHERE createdAt < ? AND emailVerified = 0"
    )
    .run(cutoff).changes;
}

export function main(argv: string[]): number {
  const commit = argv.includes("--commit");
  const cutoff = argv.find((a) => a !== "--commit");
  if (!cutoff || Number.isNaN(Date.parse(cutoff))) {
    console.error(
      "usage: migrate-verified.ts <cutoff ISO datetime = deploy time> [--commit]"
    );
    return 1;
  }
  const db = new Database(process.env.DB_PATH ?? "./markie.db");
  const report = auditVerification(db, cutoff);
  console.log(formatReport(report));

  // A flagged row blocks the write in both modes. Grandfathering an account
  // that holds a stolen claim is the one outcome this script must never
  // produce on its own.
  if (report.flagged.length > 0) return 2;
  if (!commit) {
    console.log("dry run: nothing written. Re-run with --commit to grandfather.");
    return 0;
  }
  const changed = grandfather(db, cutoff);
  console.log(
    `verified ${changed} pre-existing accounts (created before ${cutoff})`
  );
  return 0;
}

// Only when run as a script, so the audit stays importable by tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
