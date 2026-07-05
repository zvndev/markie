import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-share-access-")), "t.db");
process.env.BETTER_AUTH_SECRET = "markie-share-access-test-secret-32-plus-chars";
const {
  accessLevel,
  canEditLevel,
  canManageLevel,
  canReadLevel,
  shareAccessSummary,
} = await import("./shares.ts");
await import("./docs.ts");
const Database = (await import("better-sqlite3")).default;

const db = new Database(process.env.DB_PATH);
db.prepare(
  `INSERT INTO docs (id, owner_id, name, version, content, hash, updated_at, deleted_at)
   VALUES (?, ?, ?, 1, '', 'h', '2026-01-01', ?)`
).run("doc-active", "owner", "Active Doc", null);
db.prepare(
  `INSERT INTO docs (id, owner_id, name, version, content, hash, updated_at, deleted_at)
   VALUES (?, ?, ?, 1, '', 'h', '2026-01-01', ?)`
).run("doc-deleted", "owner", "Deleted Doc", "2026-01-02");
db.prepare(
  `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at)
   VALUES (?, ?, ?, 'owner', '2026-01-01')`
).run("doc-active", "editor", "editor");
db.prepare(
  `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at)
   VALUES (?, ?, ?, 'owner', '2026-01-01')`
).run("doc-active", "viewer", "viewer");
db.prepare(
  `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at)
   VALUES (?, ?, ?, 'owner', '2026-01-01')`
).run("doc-deleted", "viewer", "viewer");

test("accessLevel resolves owner, editor, viewer, and no-access users", () => {
  assert.equal(accessLevel("doc-active", "owner"), "owner");
  assert.equal(accessLevel("doc-active", "editor"), "editor");
  assert.equal(accessLevel("doc-active", "viewer"), "viewer");
  assert.equal(accessLevel("doc-active", "stranger"), null);
});

test("role helpers make read/edit/manage permissions explicit", () => {
  assert.equal(canReadLevel("owner"), true);
  assert.equal(canEditLevel("owner"), true);
  assert.equal(canManageLevel("owner"), true);

  assert.equal(canReadLevel("editor"), true);
  assert.equal(canEditLevel("editor"), true);
  assert.equal(canManageLevel("editor"), false);

  assert.equal(canReadLevel("viewer"), true);
  assert.equal(canEditLevel("viewer"), false);
  assert.equal(canManageLevel("viewer"), false);

  assert.equal(canReadLevel(null), false);
  assert.equal(canEditLevel(null), false);
  assert.equal(canManageLevel(null), false);
});

test("comment-writing follows edit permission, not read permission", () => {
  assert.equal(canReadLevel("viewer"), true);
  assert.equal(canEditLevel("viewer"), false);

  assert.equal(canEditLevel("editor"), true);
  assert.equal(canEditLevel("owner"), true);
});

test("shareAccessSummary returns role and scoped capabilities from server truth", () => {
  assert.deepEqual(shareAccessSummary("doc-active", "owner"), {
    role: "owner",
    canRead: true,
    canEdit: true,
    canManage: true,
  });
  assert.deepEqual(shareAccessSummary("doc-active", "editor"), {
    role: "editor",
    canRead: true,
    canEdit: true,
    canManage: false,
  });
  assert.deepEqual(shareAccessSummary("doc-active", "viewer"), {
    role: "viewer",
    canRead: true,
    canEdit: false,
    canManage: false,
  });
  assert.deepEqual(shareAccessSummary("doc-active", "stranger"), {
    role: null,
    canRead: false,
    canEdit: false,
    canManage: false,
  });
});

test("soft-deleted docs do not retain owner or share access", () => {
  assert.equal(accessLevel("doc-deleted", "owner"), null);
  assert.equal(accessLevel("doc-deleted", "viewer"), null);
  assert.deepEqual(shareAccessSummary("doc-deleted", "owner"), {
    role: null,
    canRead: false,
    canEdit: false,
    canManage: false,
  });
});
