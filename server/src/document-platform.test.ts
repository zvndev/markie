import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { createDocumentPlatform } from "./document-platform.ts";
import { createSqliteDocumentPlatformStore, type PlatformSqliteDatabase, type PlatformLimits } from "./document-platform-store.ts";

// Built-in SQLite, in-memory only. Never imports db.ts/auth.ts or opens markie.db.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => PlatformSqliteDatabase & { close(): void } };
function fixture(limits: Partial<PlatformLimits> = {}) {
  const db = new DatabaseSync(":memory:"), clock = { value: 1000000 };
  db.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT NOT NULL,emailVerified INTEGER NOT NULL)');
  for (const id of ["owner", "editor", "viewer", "stranger", "unverified"]) db.prepare('INSERT INTO "user"(id,email,emailVerified) VALUES(?,?,?)').run(id, `${id}@example.test`, id === "unverified" ? 0 : 1);
  const store = createSqliteDocumentPlatformStore(db, { limits, now: () => clock.value });
  const router = createDocumentPlatform({ store, resolveUser: async (req) => { const id = req.headers.get("x-test-user"); return ["owner", "editor", "viewer", "stranger"].includes(id ?? "") ? { id: id! } : null; } });
  const app = new Hono().route("/api/document-platform", router);
  const request = (path: string, user: string | null = "owner", method = "GET", body?: unknown) => app.request(`/api/document-platform${path}`, { method, headers: { ...(user ? { "x-test-user": user } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { db, clock, store, app, request };
}
function payload(bytes: string | Uint8Array = "hello\r\n", baseVersion = 0, extra: Record<string, unknown> = {}) {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return { schemaVersion: 2, name: "note.txt", format: "text", encoding: "base64", data: buffer.toString("base64"), sha256: createHash("sha256").update(buffer).digest("hex"), baseVersion, ...extra };
}
async function created(f: ReturnType<typeof fixture>, body = payload()) {
  const response = await f.request("/documents", "owner", "POST", body); assert.equal(response.status, 201);
  return (await response.json()).document as { id: string; version: number; data: string; sha256: string };
}

test("version-2 snapshots preserve exact bytes, metadata and opaque server IDs", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const bytes = new Uint8Array([0xff, 0xfe, 65, 0, 13, 0, 10, 0]), first = await created(f, payload(bytes));
  assert.match(first.id, /^[a-f0-9-]{36}$/); assert.equal(first.version, 1); assert.deepEqual(Buffer.from(first.data, "base64"), Buffer.from(bytes));
  const list = await (await f.request("/documents")).json(); assert.equal(list.documents.length, 1); assert.equal(list.documents[0].data, undefined); assert.equal(list.documents[0].byteLength, bytes.length);
  const fetched = await (await f.request(`/documents/${first.id}`)).json(); assert.equal(fetched.document.data, first.data); assert.equal(fetched.document.role, "owner");
  const next = await f.request(`/documents/${first.id}`, "owner", "PUT", payload("updated", 1)); assert.equal(next.status, 200); assert.equal((await next.json()).document.version, 2);
  const history = await (await f.request(`/documents/${first.id}/history`)).json(); assert.deepEqual(history.history.map((r: { version: number }) => r.version), [2, 1]);
  const original = await (await f.request(`/documents/${first.id}/history/1`)).json(); assert.equal(original.document.data, first.data);
});

test("unauthenticated and cross-user requests cannot enumerate or mutate private documents", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = await created(f);
  assert.equal((await f.request("/documents", null)).status, 401);
  assert.deepEqual((await (await f.request("/documents", "stranger")).json()).documents, []);
  for (const suffix of ["", "/history", "/history/1", "/members", "/links"]) {
    const response = await f.request(`/documents/${doc.id}${suffix}`, "stranger"); assert.equal(response.status, 404); assert.equal((await response.json()).serverVersion, undefined);
  }
  assert.equal((await f.request(`/documents/${doc.id}`, "stranger", "PUT", payload("takeover", 1))).status, 404);
  assert.equal((await f.request(`/documents/${doc.id}`, "stranger", "DELETE", { baseVersion: 1 })).status, 404);
  assert.equal((await f.request("/documents/not-an-id", "stranger")).status, 404);
  assert.equal((await f.request(`/documents/${doc.id}`, null)).status, 401);
});

test("owner controls verified existing-account membership; editor and viewer capabilities differ", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = await created(f), members = `/documents/${doc.id}/members`;
  assert.equal((await f.request(members, "owner", "POST", { email: "EDITOR@EXAMPLE.TEST", role: "editor" })).status, 200);
  assert.equal((await f.request(members, "owner", "POST", { userId: "viewer", role: "viewer" })).status, 200);
  assert.equal((await f.request(members, "owner", "POST", { email: "unverified@example.test", role: "viewer" })).status, 404);
  assert.equal((await f.request(members, "owner", "POST", { email: "missing@example.test", role: "viewer" })).status, 404);
  assert.equal((await f.request(members, "owner", "POST", { userId: "owner", role: "viewer" })).status, 400);
  assert.equal((await f.request(members, "owner", "POST", { userId: "editor", email: "editor@example.test", role: "editor" })).status, 400);
  assert.equal((await f.request(members, "owner", "POST", { userId: null, email: "editor@example.test", role: "editor" })).status, 400);
  assert.equal((await f.request(members, "editor", "POST", { userId: "stranger", role: "viewer" })).status, 403);
  assert.equal((await f.request(members, "viewer")).status, 403);
  const list = (await (await f.request("/documents", "editor")).json()).documents; assert.equal(list[0].role, "editor");
  assert.equal((await f.request(`/documents/${doc.id}`, "viewer", "PUT", payload("no", 1))).status, 403);
  assert.equal((await f.request(`/documents/${doc.id}`, "editor", "PUT", payload("editor save", 1))).status, 200);
  assert.equal((await f.request(`/documents/${doc.id}`, "editor", "DELETE", { baseVersion: 2 })).status, 403);
  assert.equal((await f.request(`${members}/editor`, "owner", "DELETE")).status, 200);
  assert.equal((await f.request(`/documents/${doc.id}`, "editor")).status, 404);
});

test("stale version saves/deletes conflict without changing content or history", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = await created(f);
  const [a, b] = await Promise.all([f.request(`/documents/${doc.id}`, "owner", "PUT", payload("one", 1)), f.request(`/documents/${doc.id}`, "owner", "PUT", payload("two", 1))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b; assert.equal((await loser.json()).serverVersion, 2);
  assert.equal((await f.request(`/documents/${doc.id}`, "owner", "DELETE", { baseVersion: 1 })).status, 409);
  assert.equal((await f.request(`/documents/${doc.id}/history`)).status, 200);
  assert.equal(f.store.history("owner", doc.id).length, 2);
});

test("viewers invited after redaction cannot retrieve pre-invitation historical bytes", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = await created(f, payload("removed private text"));
  assert.equal((await f.request(`/documents/${doc.id}`, "owner", "PUT", payload("public current text", 1))).status, 200);
  assert.equal((await f.request(`/documents/${doc.id}/members`, "owner", "POST", { userId: "viewer", role: "viewer" })).status, 200);
  assert.equal((await f.request(`/documents/${doc.id}`, "viewer")).status, 200);
  assert.equal((await f.request(`/documents/${doc.id}/history`, "viewer")).status, 403);
  assert.equal((await f.request(`/documents/${doc.id}/history/1`, "viewer")).status, 403);
  assert.equal((await f.request(`/documents/${doc.id}/members`, "owner", "POST", { userId: "editor", role: "editor" })).status, 200);
  assert.equal((await f.request(`/documents/${doc.id}/history/1`, "editor")).status, 200);
});

test("history failure rolls back the document row atomically and never leaks SQL details", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = await created(f);
  f.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON dp_history WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'deliberate-private-test-detail'); END;");
  const response = await f.request(`/documents/${doc.id}`, "owner", "PUT", payload("must rollback", 1));
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /deliberate-private-test-detail|INSERT|dp_history/);
  assert.equal(f.store.get("owner", doc.id).version, 1); assert.equal(f.store.get("owner", doc.id).data, doc.data); assert.equal(f.store.history("owner", doc.id).length, 1);
});

test("strict schema, canonical base64, SHA-256 and document/body bounds reject malformed input", async (t) => {
  const f = fixture({ maxDocumentBytes: 16 }); t.after(() => f.db.close());
  const bad = [payload("a", 1), payload("a", 0, { schemaVersion: 1 }), payload("a", 0, { format: "vault" }), payload("a", 0, { data: "YQ==\n" }), payload("a", 0, { data: "AB==" }), payload("a", 0, { sha256: "0".repeat(64) }), payload("a", 0, { plaintext: "forbidden unknown field" }), payload("a", 0, { name: "../escape" })];
  for (const body of bad) assert.ok([400, 415].includes((await f.request("/documents", "owner", "POST", body)).status));
  assert.equal((await f.request("/documents", "owner", "POST", payload("x".repeat(17)))).status, 413);
  const malformed = await f.app.request("/api/document-platform/documents", { method: "POST", headers: { "x-test-user": "owner", "content-type": "application/json" }, body: "{" }); assert.equal(malformed.status, 400);
  const wrongType = await f.app.request("/api/document-platform/documents", { method: "POST", headers: { "x-test-user": "owner", "content-type": "application/json-other" }, body: "{}" }); assert.equal(wrongType.status, 415);
  const oversized = await f.app.request("/api/document-platform/documents", { method: "POST", headers: { "x-test-user": "owner", "content-type": "application/json", "content-length": "1" }, body: "x".repeat(5000) }); assert.equal(oversized.status, 413);
  assert.equal(f.store.list("owner").length, 0);
});

test("recognized vault headers, envelopes and snapshots are excluded including UTF-16 JSON", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const values = [{ kind: "markie-vault", version: 1, vaultId: "private" }, { kind: "markie-vault-document", version: 1, ciphertext: "private" }, { version: 1, revision: 1, header: JSON.stringify({ kind: "markie-vault" }), records: [] }];
  for (const v of values) {
    const plain = JSON.stringify(v), utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plain, "utf16le")]);
    for (const bytes of [Buffer.from(plain), utf16]) {
      const response = await f.request("/documents", "owner", "POST", payload(bytes, 0, { name: "data.json", format: "json" })); assert.equal(response.status, 400); assert.equal((await response.json()).error, "vault-excluded");
    }
  }
  assert.equal((await f.request("/documents", "owner", "POST", payload("anything", 0, { name: "private.vault" }))).status, 400); assert.equal(f.store.list("owner").length, 0);
});

test("ordinary deep JSON bytes remain opaque while deeply nested transport JSON is refused", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const deep = '{"data":' + "[".repeat(10000) + "0" + "]".repeat(10000) + '}';
  const document = await created(f, payload(deep, 0, { name: "deep.json", format: "json" }));
  assert.equal(Buffer.from(document.data, "base64").toString(), deep);
  const response = await f.app.request("/api/document-platform/documents", { method: "POST", headers: { "x-test-user": "owner", "content-type": "application/json" }, body: '{"bad":' + "[".repeat(20) + "0" + "]".repeat(20) + '}' });
  assert.equal(response.status, 400); assert.match((await response.json()).message, /nesting/);
  const escaped = JSON.stringify({ unrelated: { nesting: [1] }, kind: "markie-vault" });
  assert.equal((await f.request("/documents", "owner", "POST", payload(escaped))).status, 400);
});

test("history, owner storage, document, member and link counts remain bounded", async (t) => {
  const f = fixture({ maxHistoryVersions: 2, maxDocumentsPerOwner: 1, maxMembersPerDocument: 1, maxLinksPerDocument: 1 }); t.after(() => f.db.close()); const doc = await created(f);
  for (let version = 1; version < 5; version++) assert.equal((await f.request(`/documents/${doc.id}`, "owner", "PUT", payload(`v${version}`, version))).status, 200);
  assert.deepEqual(f.store.history("owner", doc.id).map((r) => r.version), [5, 4]); assert.equal((await f.request(`/documents/${doc.id}/history/1`)).status, 404);
  assert.equal((await f.request("/documents", "owner", "POST", payload())).status, 413);
  assert.equal((await f.request(`/documents/${doc.id}/members`, "owner", "POST", { userId: "editor", role: "editor" })).status, 200);
  assert.equal((await f.request(`/documents/${doc.id}/members`, "owner", "POST", { userId: "viewer", role: "viewer" })).status, 413);
  const first = await f.request(`/documents/${doc.id}/links`, "owner", "POST", { expiresInSeconds: 60 }); assert.equal(first.status, 201);
  assert.equal((await f.request(`/documents/${doc.id}/links`, "owner", "POST", { expiresInSeconds: 60 })).status, 413);
  const quota = fixture({ maxStoredBytesPerOwner: 7 }); t.after(() => quota.db.close()); const small = await created(quota, payload("abc"));
  assert.equal((await quota.request(`/documents/${small.id}`, "owner", "PUT", payload("abcd", 1))).status, 413);
  assert.equal(quota.store.get("owner", small.id).version, 1); assert.equal(quota.store.history("owner", small.id).length, 1);
});

test("public tokens are explicit read-only capabilities, hashed in storage, revocable and expiring", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = await created(f);
  assert.equal((await f.request(`/documents/${doc.id}/links`, "stranger", "POST", { expiresInSeconds: 60 })).status, 404);
  const minted = await f.request(`/documents/${doc.id}/links`, "owner", "POST", { expiresInSeconds: 60 }), link = (await minted.json()).link;
  assert.equal(minted.status, 201); assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
  const raw = f.db.prepare("SELECT token_hash FROM dp_links WHERE id = ?").get(link.id) as { token_hash: string }; assert.notEqual(raw.token_hash, link.token); assert.match(raw.token_hash, /^[a-f0-9]{64}$/);
  const visible = await f.request(`/links/${link.token}`, null); assert.equal(visible.status, 200); const shared = (await visible.json()).document; assert.equal(shared.role, "viewer"); assert.equal(shared.owner_id, undefined);
  assert.equal((await f.request(`/documents/${doc.id}`, null)).status, 401); assert.equal((await f.request(`/links/${link.token}`, null, "PUT", payload("no", 1))).status, 404);
  const listed = await (await f.request(`/documents/${doc.id}/links`)).json(); assert.equal(listed.links[0].token, undefined); assert.equal(listed.links[0].token_hash, undefined);
  assert.equal((await f.request(`/documents/${doc.id}/links/${link.id}`, "owner", "DELETE")).status, 200); assert.equal((await f.request(`/links/${link.token}`, null)).status, 404);
  const next = (await (await f.request(`/documents/${doc.id}/links`, "owner", "POST", { expiresInSeconds: 60 })).json()).link;
  f.clock.value = next.expiresAt; assert.equal((await f.request(`/links/${next.token}`, null)).status, 404);
});

test("public downloads force safe attachment bytes/no-store/nosniff and deletion revokes all access", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = await created(f, payload("<script>not executed</script>", 0, { name: 'résumé"; attack.html', format: "text" }));
  const link = (await (await f.request(`/documents/${doc.id}/links`, "owner", "POST", { expiresInSeconds: 60 })).json()).link;
  const response = await f.request(`/links/${link.token}/download`, null);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/octet-stream"); assert.match(response.headers.get("content-disposition")!, /^attachment; filename="r_sum__;/); assert.match(response.headers.get("content-disposition")!, /filename\*=UTF-8''/);
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(await response.text(), "<script>not executed</script>");
  assert.equal((await f.request(`/documents/${doc.id}`, "owner", "DELETE", { baseVersion: 1 })).status, 200);
  assert.equal((await f.request(`/links/${link.token}`, null)).status, 404); assert.equal((await f.request(`/documents/${doc.id}/history`)).status, 404);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM dp_history").get() as { count: number }).count, 0); assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM dp_links").get() as { count: number }).count, 0);
});

test("success and authorization/conflict failures are private no-store responses", async (t) => {
  const f = fixture(); t.after(() => f.db.close()); const doc = await created(f);
  const responses = [await f.request("/documents"), await f.request("/documents", null), await f.request(`/documents/${doc.id}`, "stranger"), await f.request(`/documents/${doc.id}`, "owner", "PUT", payload("stale", 99))];
  assert.deepEqual(responses.map((r) => r.status), [200, 401, 404, 409]);
  for (const response of responses) { assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(response.headers.get("referrer-policy"), "no-referrer"); }
});
