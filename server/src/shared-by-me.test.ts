import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point every module's db at a throwaway file BEFORE importing them.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-sbm-")), "t.db");
process.env.BETTER_AUTH_SECRET = "markie-shared-by-me-test-secret-32-plus-chars";
const { docsSharedByMe } = await import("./shares.ts");
await import("./docs.ts"); // ensures the docs table exists
const Database = (await import("better-sqlite3")).default;

const db = new Database(process.env.DB_PATH);
const insDoc = db.prepare(
  `INSERT INTO docs (id, owner_id, name, version, content, hash, updated_at, deleted_at)
   VALUES (?, ?, ?, 1, '', 'h', ?, ?)`
);
const insShare = db.prepare(
  `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at)
   VALUES (?, ?, ?, 'owner', '2026-01-01')`
);
const insPending = db.prepare(
  `INSERT INTO pending_shares (doc_id, email, role, invited_by, token, created_at)
   VALUES (?, ?, ?, 'owner', 'tok', '2026-01-01')`
);

// d1: owned + 1 member  → included
insDoc.run("d1", "owner", "Doc One", "2026-01-03T00:00:00Z", null);
insShare.run("d1", "u2", "viewer");
// d2: owned + 1 pending invite, no member → included
insDoc.run("d2", "owner", "Doc Two", "2026-01-02T00:00:00Z", null);
insPending.run("d2", "x@y.com", "editor");
// d3: owned, nobody → excluded
insDoc.run("d3", "owner", "Doc Three", "2026-01-04T00:00:00Z", null);
// d4: owned + share but soft-deleted → excluded
insDoc.run("d4", "owner", "Doc Four", "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z");
insShare.run("d4", "u3", "viewer");
// d5: someone else's doc with a share → excluded for "owner"
insDoc.run("d5", "other", "Doc Five", "2026-01-07T00:00:00Z", null);
insShare.run("d5", "u4", "editor");

test("docsSharedByMe returns only owned, non-deleted docs that have people", () => {
  const rows = docsSharedByMe("owner");
  assert.deepEqual(
    rows.map((r) => r.id),
    ["d1", "d2"], // updated_at DESC; d3/d4/d5 excluded
  );
});

test("docsSharedByMe counts members and pending invites separately", () => {
  const rows = docsSharedByMe("owner");
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.d1.member_count, 1);
  assert.equal(byId.d1.pending_count, 0);
  assert.equal(byId.d2.member_count, 0);
  assert.equal(byId.d2.pending_count, 1);
});

test("docsSharedByMe is empty for a user who has shared nothing", () => {
  assert.deepEqual(docsSharedByMe("nobody"), []);
});
