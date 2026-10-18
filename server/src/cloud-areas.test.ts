import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { createCloudAreas, createCloudAreasApi, type CloudDocumentKind } from "./cloud-areas.ts";
import { createSqliteDocumentPlatformStore, type PlatformSqliteDatabase, type PlatformLimits } from "./document-platform-store.ts";
import { createDocumentPlatform } from "./document-platform.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (file: string) => PlatformSqliteDatabase & { close(): void } };
function payload(text = "data", baseVersion = 0, areaId?: string) { const bytes = Buffer.from(text); return { schemaVersion: 2, name: "note.txt", format: "text", encoding: "base64", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), baseVersion, ...(areaId !== undefined ? { areaId } : {}) }; }
function fixture(limits: Partial<PlatformLimits> = {}) {
  const db = new DatabaseSync(":memory:"), areas = createCloudAreas(db);
  db.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); INSERT INTO "user" VALUES(\'owner\',\'owner@example.test\',1),(\'viewer\',\'viewer@example.test\',1),(\'stranger\',\'stranger@example.test\',1)');
  const store = createSqliteDocumentPlatformStore(db, { cloudAreas: areas, limits, verifiedUserForEmail: (email) => email === "alias@example.test" ? "viewer" : null });
  const authenticate = async (request: Request) => { const id = request.headers.get("x-user"); return id && ["owner", "viewer", "stranger"].includes(id) ? { id } : null; };
  const canAccessDocument = (uid: string, kind: CloudDocumentKind, id: string) => { if (kind !== "snapshot") return false; try { store.get(uid, id); return true; } catch { return false; } };
  const app = new Hono().route("/api/account", createCloudAreasApi({ store: areas, authenticate, canAccessDocument })).route("/api/document-platform", createDocumentPlatform({ store, resolveUser: authenticate }));
  const request = (path: string, uid = "owner", method = "GET", body?: unknown) => app.request(path, { method, headers: { ...(uid ? { "x-user": uid } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return { db, areas, store, request, count };
}

test("cloud areas are per-user, bounded organizational labels with an idempotent personal/identity default", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  assert.equal((await f.request("/api/account/cloud-areas", "")).status, 401);
  const first = f.areas.ensureDefault("owner"), again = f.areas.ensureDefault("owner"); assert.deepEqual(first, again);
  assert.notEqual(first.id, f.areas.ensureDefault("stranger").id);
  const identity = f.areas.ensureIdentityArea("owner", "verified-id", "Verified address");
  assert.deepEqual(f.areas.ensureIdentityArea("owner", "verified-id", "Other label"), identity);
  const created = await f.request("/api/account/cloud-areas", "owner", "POST", { label: " Project " }); assert.equal(created.status, 201);
  const project = (await created.json()).area; assert.equal(project.label, "Project");
  assert.equal((await f.request(`/api/account/cloud-areas/${project.id}`, "stranger", "PATCH", { label: "stolen" })).status, 404);
  assert.equal((await f.request(`/api/account/cloud-areas/${project.id}`, "owner", "PATCH", { label: "Renamed" })).status, 200);
  for (const label of ["", " ", "x".repeat(81), "bad\nlabel"]) assert.equal((await f.request("/api/account/cloud-areas", "owner", "POST", { label })).status, 400);
  assert.equal((await f.request("/api/account/cloud-areas", "owner", "POST", { label: "Other", owner_uid: "stranger" })).status, 400);
  const listed = await f.request("/api/account/cloud-areas"); assert.equal(listed.headers.get("cache-control"), "private, no-store");
  const body = await listed.json(); assert.equal(body.areas.length, 3); assert.equal(body.areas.find((a: { identityId?: string }) => a.identityId)?.identityId, "verified-id");
  assert.equal(f.count("dp_members"), 0);
});

test("snapshot creation validates owned destination before writes and rolls back document/history/placement failures together", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const foreign = f.areas.create("stranger", "Foreign");
  const denied = await f.request("/api/document-platform/documents", "owner", "POST", payload("data", 0, foreign.id)); assert.equal(denied.status, 404);
  for (const table of ["dp_documents", "dp_history", "cloud_document_placements"]) assert.equal(f.count(table), 0);
  f.db.exec("CREATE TRIGGER fail_placement BEFORE INSERT ON cloud_document_placements BEGIN SELECT RAISE(ABORT,'private-sql-detail'); END;");
  const failed = await f.request("/api/document-platform/documents", "owner", "POST", payload()); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private-sql-detail|INSERT/);
  for (const table of ["dp_documents", "dp_history", "cloud_document_placements"]) assert.equal(f.count(table), 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM cloud_areas WHERE owner_uid='owner'").get() as { count: number }).count, 0);
});

test("no-area snapshot clients lazily backfill personal placement and updates never silently change it", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = f.store.create("owner", payload());
  assert.equal(doc.areaId, f.areas.ensureDefault("owner").id);
  const project = f.areas.create("owner", "Project"), foreign = f.areas.create("stranger", "Foreign");
  assert.equal((await f.request(`/api/document-platform/documents/${doc.id}`, "owner", "PUT", payload("bad", 1, foreign.id))).status, 404);
  assert.equal((await f.request(`/api/document-platform/documents/${doc.id}`, "owner", "PUT", payload("bad", 1, project.id))).status, 409);
  assert.equal(f.store.get("owner", doc.id).version, 1);
  const moved = await f.request(`/api/account/cloud-areas/placements/snapshot/${doc.id}`, "owner", "PUT", { areaId: project.id }); assert.equal(moved.status, 200);
  assert.equal(f.store.update("owner", doc.id, payload("saved", 1)).areaId, project.id);
  assert.equal(f.store.list("owner")[0].areaId, project.id);
  f.db.exec("DELETE FROM cloud_document_placements");
  assert.equal(f.store.get("owner", doc.id).areaId, f.areas.ensureDefault("owner").id);
});

test("shared placement requires ACL, is independent per user, never grants permissions, and hides revoked placements", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = f.store.create("owner", payload()), destination = f.areas.create("viewer", "Shared work"), foreign = f.areas.create("stranger", "Other");
  const endpoint = `/api/account/cloud-areas/placements/snapshot/${doc.id}`;
  assert.equal((await f.request(endpoint, "viewer", "PUT", { areaId: destination.id })).status, 404);
  assert.equal((await f.request(endpoint, "owner", "PUT", { areaId: foreign.id })).status, 404);
  assert.equal(f.count("dp_members"), 0);
  f.store.addMember("owner", doc.id, { userId: "viewer", role: "viewer" });
  assert.equal((await f.request(endpoint, "viewer", "PUT", { areaId: destination.id })).status, 200);
  assert.equal(f.store.get("viewer", doc.id).areaId, destination.id); assert.equal(f.store.get("owner", doc.id).areaId, doc.areaId);
  assert.throws(() => f.store.update("viewer", doc.id, payload("no", 1)), /permission/);
  const link = f.store.createLink("owner", doc.id, 60); assert.equal(f.store.publicSnapshot(link.token).areaId, undefined);
  f.store.removeMember("owner", doc.id, "viewer");
  assert.equal((await f.request(endpoint, "viewer", "PUT", { areaId: destination.id })).status, 404);
  assert.equal((await (await f.request("/api/account/cloud-areas", "viewer")).json()).placements.length, 0);
  assert.throws(() => f.store.get("viewer", doc.id), /not found/);
});

test("area separation never partitions account snapshot count/storage quotas", (t) => {
  const f = fixture({ maxDocumentsPerOwner: 1, maxStoredBytesPerOwner: 7 }); t.after(() => f.db.close());
  const one = f.areas.create("owner", "One"), two = f.areas.create("owner", "Two"), doc = f.store.create("owner", payload("abc", 0, one.id));
  assert.throws(() => f.store.create("owner", payload("x", 0, two.id)), /count limit/);
  f.areas.setPlacement("owner", "snapshot", doc.id, two.id);
  assert.throws(() => f.store.update("owner", doc.id, payload("abcd", 1)), /storage limit/);
  assert.equal(f.store.get("owner", doc.id).version, 1); assert.equal(f.store.get("owner", doc.id).areaId, two.id);
});

test("factory rejects a cross-handle placement store and default-disabled snapshot contract stays unchanged", (t) => {
  const db = new DatabaseSync(":memory:"), other = new DatabaseSync(":memory:"); t.after(() => { db.close(); other.close(); });
  assert.throws(() => createSqliteDocumentPlatformStore(db, { cloudAreas: createCloudAreas(other) }), /same database handle/);
  const disabled = createSqliteDocumentPlatformStore(db), doc = disabled.create("owner", payload());
  assert.equal(doc.areaId, undefined); assert.equal(disabled.list("owner")[0].areaId, undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='cloud_areas'").get(), undefined);
  assert.throws(() => disabled.create("owner", payload("no", 0, "area")), /payload fields/);
});

test("explicit owner role changes through a verified alias affect the canonical member once", (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = f.store.create("owner", payload());
  f.store.addMember("owner", doc.id, { userId: "viewer", role: "viewer" });
  f.store.addMember("owner", doc.id, { email: "alias@example.test", role: "editor" });
  assert.equal(f.store.get("viewer", doc.id).role, "editor");
  assert.equal(f.store.members("owner", doc.id).length, 1);
  f.store.addMember("owner", doc.id, { userId: "viewer", role: "editor" });
  assert.equal(f.store.get("viewer", doc.id).role, "editor");
  f.store.addMember("owner", doc.id, { email: "alias@example.test", role: "viewer" });
  assert.equal(f.store.get("viewer", doc.id).role, "viewer");
  // A configured resolver is authoritative even when a primary-email SQL
  // match exists: revoked/conflicted addresses must not regain access.
  assert.throws(() => f.store.addMember("owner", doc.id, { email: "stranger@example.test", role: "editor" }), /No verified existing account/);
  assert.throws(() => f.store.get("stranger", doc.id), /not found/i);
});

test("area creation limits are atomic and verified-identity callbacks remain inside their caller transaction", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  f.db.exec("BEGIN IMMEDIATE");
  f.areas.ensureIdentityArea("owner", "verified-then-rolled-back", "Identity label");
  f.db.exec("ROLLBACK");
  assert.equal(f.count("cloud_areas"), 0);
  for (let index = 0; index < 99; index++) f.areas.create("owner", `Area ${index}`);
  assert.equal(f.areas.list("owner").length, 100);
  assert.throws(() => f.areas.create("owner", "Overflow"), /limit/);
  assert.equal(f.areas.list("owner").length, 100);
  const huge = await f.request("/api/account/cloud-areas", "owner", "POST", { label: "x".repeat(3000) }); assert.equal(huge.status, 413);
  const invalidKind = await f.request("/api/account/cloud-areas/placements/unknown/doc", "owner", "PUT", { areaId: f.areas.ensureDefault("owner").id }); assert.equal(invalidKind.status, 400);
});
