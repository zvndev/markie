// A per-account storage quota, off unless MARKIE_STORAGE_QUOTA_BYTES is set.
//
// Groundwork for paid plans and for self-hosters who want a ceiling. It counts
// what an account owns, from the ownership columns the server already keeps:
//
//   docs.content          Markdown documents the account owns, current text
//   assets.size           media the account uploaded
//   dp_documents.bytes    Word/RTF/ODT snapshots the account owns, current bytes
//
// History rows (doc_history, dp_history) and the live-collaboration update log
// are not counted. They are bounded copies the server keeps for its own sake
// (20 versions each), and charging a person for them would make one edit of a
// large file cost many times its size.
//
// A write is refused only when it GROWS the account past the quota, so an
// account already over it (because the quota was lowered) can still shrink and
// delete. The checks run synchronously next to the write they guard, and
// better-sqlite3 is synchronous, so nothing interleaves between the read and
// the write in one process.
import type Database from "better-sqlite3";

export const STORAGE_QUOTA_ERROR = "storage_quota_exceeded";

type Env = Record<string, string | undefined>;

/** The configured quota in bytes, or null for unlimited. Refuses a value that is not a whole number of bytes. */
export function parseStorageQuota(env: Env = process.env): number | null {
  const raw = env.MARKIE_STORAGE_QUOTA_BYTES?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new Error("MARKIE_STORAGE_QUOTA_BYTES must be a positive whole number of bytes, or unset for unlimited.");
  }
  return Number(raw);
}

let quotaBytes: number | null = parseStorageQuota();
export function storageQuotaBytes(): number | null {
  return quotaBytes;
}
/** Test seam. */
export function setStorageQuotaForTests(bytes: number | null): void {
  quotaBytes = bytes;
}

const COUNTED: { table: string; sql: string }[] = [
  {
    table: "docs",
    sql: "SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS total FROM docs WHERE owner_id = ? AND deleted_at IS NULL",
  },
  { table: "assets", sql: "SELECT COALESCE(SUM(size), 0) AS total FROM assets WHERE owner_id = ?" },
  { table: "dp_documents", sql: "SELECT COALESCE(SUM(length(bytes)), 0) AS total FROM dp_documents WHERE owner_id = ?" },
];

/** Bytes the account owns across every counted table that exists in this database. */
export function storageUsedBytes(db: Database.Database, ownerId: string): number {
  let total = 0;
  for (const { table, sql } of COUNTED) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) continue;
    total += (db.prepare(sql).get(ownerId) as { total: number }).total;
  }
  return total;
}

export interface QuotaRefusal {
  error: typeof STORAGE_QUOTA_ERROR;
  message: string;
  usedBytes: number;
  quotaBytes: number;
}

/**
 * Null when the write may go ahead, otherwise the 413 body to answer with.
 * `growth` is how many bytes the write adds to the owner's total; `pending` is
 * anything already promised but not yet in a table (uploads in flight).
 */
export function quotaRefusal(db: Database.Database, ownerId: string, growth: number, pending = 0): QuotaRefusal | null {
  const quota = quotaBytes;
  if (quota === null || growth <= 0) return null;
  const used = storageUsedBytes(db, ownerId);
  if (used + pending + growth <= quota) return null;
  return {
    error: STORAGE_QUOTA_ERROR,
    message: "This account has used all of its storage. Remove cloud copies or media you no longer need, then try again.",
    usedBytes: used,
    quotaBytes: quota,
  };
}
