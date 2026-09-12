import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-assets-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-assets-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { assetsApi, assetRefsFor, MAX_ASSET_BYTES, MAX_ACCOUNT_ASSET_BYTES, setAssetStoreForTests, setAssetLimitsForTests } = await import("./assets.ts");
const { fsStore } = await import("./storage.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api", assetsApi);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function json(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function upload(token: string, bytes: Buffer, hash = sha(bytes), mime = "image/png", length = bytes.length) {
  const res = await app.request(`/api/assets/${hash}`, {
    method: "PUT",
    headers: { "Content-Type": mime, "Content-Length": String(length), Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: new Blob([bytes]),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function makeDoc(token: string, content = "# t\n\n![](shots/a.png)\n") {
  const id = crypto.randomUUID();
  const r = await json("PUT", `/api/docs/${id}`, token, { name: "t.md", content, hash: sha(Buffer.from(content)), baseVersion: 0 });
  assert.equal(r.status, 200);
  return id;
}

let owner: { token: string; id: string };
let editor: { token: string; id: string };
let stranger: { token: string; id: string };
before(async () => {
  owner = await signUpVerified(app, { name: "Owner", email: "owner@markie.test" });
  editor = await signUpVerified(app, { name: "Editor", email: "editor@markie.test" });
  stranger = await signUpVerified(app, { name: "Stranger", email: "stranger@markie.test" });
});

test("missing answers from the caller's own scope", async () => {
  const id = await makeDoc(owner.token);
  const h = sha(PNG);
  let r = await json("POST", `/api/docs/${id}/assets/missing`, owner.token, { hashes: [h] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.missing, [h]);
  assert.equal(r.data.cap, 5 * 1024 * 1024 * 1024);
  assert.equal((await upload(owner.token, PNG)).status, 200);
  r = await json("POST", `/api/docs/${id}/assets/missing`, owner.token, { hashes: [h] });
  assert.deepEqual(r.data.missing, []);
  // Another account holding the same bytes learns nothing from this.
  const theirs = await makeDoc(stranger.token);
  r = await json("POST", `/api/docs/${theirs}/assets/missing`, stranger.token, { hashes: [h] });
  assert.deepEqual(r.data.missing, [h]);
});

test("missing is for the document's owner and editors only", async () => {
  const id = await makeDoc(owner.token);
  assert.equal((await json("POST", `/api/docs/${id}/assets/missing`, stranger.token, { hashes: [] })).status, 404);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "viewer" });
  assert.equal((await json("POST", `/api/docs/${id}/assets/missing`, editor.token, { hashes: [] })).status, 403);
});

test("upload refuses a wrong hash, a wrong type and a body over the cap, and is idempotent", async () => {
  assert.equal((await upload(owner.token, PNG, "0".repeat(64))).status, 400);
  assert.equal((await upload(owner.token, PNG, sha(PNG), "text/html")).status, 415);
  assert.equal((await upload(owner.token, PNG, sha(PNG), "image/png", MAX_ASSET_BYTES + 1)).status, 413);
  assert.equal((await upload(owner.token, PNG)).status, 200);
  assert.equal((await upload(owner.token, PNG)).status, 200);
  assert.equal((await upload(owner.token, PNG, "nothex")).status, 400);
});

test("upload refuses an account over its total", async () => {
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  db.prepare("INSERT OR REPLACE INTO assets (owner_id, hash, size, mime, created_at) VALUES (?, ?, ?, ?, ?)").run(
    stranger.id, "f".repeat(64), 5 * 1024 * 1024 * 1024, "image/png", "2026-01-01T00:00:00.000Z"
  );
  const r = await upload(stranger.token, Buffer.from("xx"));
  assert.equal(r.status, 413);
  assert.equal(r.data.error, "account over cap");
  db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(stranger.id, "f".repeat(64));
});

// A client can lie about Content-Length; the courtesy pre-flight check on
// the declared number only rejects the common case cheaply. The real gate is
// on the bytes actually received.
test("a streamed body over a lowered per-file cap is refused mid-stream and stores nothing", async () => {
  setAssetLimitsForTests({ maxAssetBytes: 8 });
  try {
    const bytes = Buffer.from("this body is well over eight bytes long");
    const hash = sha(bytes);
    // Declares under the (lowered) cap; the real body is far over it.
    const r = await upload(stranger.token, bytes, hash, "image/png", 4);
    assert.equal(r.status, 413);
    const { openDatabase } = await import("./db.ts");
    const db = openDatabase();
    assert.equal(db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND hash = ?").get(stranger.id, hash), undefined);
    assert.equal(await fsStore(process.env.ASSETS_DIR!).head(`${stranger.id}/${hash}`), null);
  } finally {
    setAssetLimitsForTests(null);
  }
});

// The declared-length pre-flight check is a courtesy that trusts the
// client's number; the real account cap has to hold against the bytes that
// actually land, checked and claimed in the same transaction as the write.
test("the account cap is enforced against the real size, not just the declared length", async () => {
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  const filler = "d".repeat(64);
  db.prepare("INSERT OR REPLACE INTO assets (owner_id, hash, size, mime, created_at) VALUES (?, ?, ?, ?, ?)").run(
    stranger.id, filler, MAX_ACCOUNT_ASSET_BYTES - 2, "image/png", "2026-01-01T00:00:00.000Z"
  );
  try {
    // Declaring the true length (4) already trips the pre-flight check: only 2 bytes of headroom.
    const a = Buffer.from("aaaa");
    let r = await upload(stranger.token, a);
    assert.equal(r.status, 413);
    assert.equal(r.data.error, "account over cap");
    assert.equal(db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND hash = ?").get(stranger.id, sha(a)), undefined);

    // Declaring less (1) slips past the pre-flight check, but the real bytes
    // (4) still exceed the cap: the object gets written (the route writes
    // before it reserves), then the post-stat transactional check catches
    // what the courtesy check missed and the object is deleted again. No
    // row and no stored object should be left behind.
    const b = Buffer.from("bbbb");
    r = await upload(stranger.token, b, sha(b), "image/png", 1);
    assert.equal(r.status, 413);
    assert.equal(r.data.error, "account over cap");
    assert.equal(db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND hash = ?").get(stranger.id, sha(b)), undefined);
    assert.equal(await fsStore(process.env.ASSETS_DIR!).head(`${stranger.id}/${sha(b)}`), null);
  } finally {
    db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(stranger.id, filler);
  }
});

// If the object never arrives, the row must not exist either: the route
// writes the object before it reserves the row, so a rejected store.put
// leaves nothing behind for reserveAssetSpace to have claimed.
test("a store.put rejection leaves no row behind", async () => {
  const real = fsStore(process.env.ASSETS_DIR!);
  const failing = { ...real, put: async () => { throw new Error("simulated store failure"); } };
  setAssetStoreForTests(failing);
  try {
    const bytes = Buffer.from("bytes that never make it to storage");
    const hash = sha(bytes);
    const r = await upload(owner.token, bytes, hash);
    assert.equal(r.status, 500);
    const { openDatabase } = await import("./db.ts");
    const db = openDatabase();
    assert.equal(db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND hash = ?").get(owner.id, hash), undefined);
  } finally {
    setAssetStoreForTests(real);
  }
});

test("link replaces the set, keeps an entry without a hash, and collects orphans", async () => {
  const id = await makeDoc(owner.token);
  const a = Buffer.from("aaaa"), b = Buffer.from("bbbb");
  assert.equal((await upload(owner.token, a)).status, 200);
  assert.equal((await upload(owner.token, b)).status, 200);
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "a.png", hash: sha(a) }, { ref: "b.png", hash: sha(b) }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 2, kept: 0, dropped: 0 });
  assert.deepEqual([...assetRefsFor(id).keys()].sort(), ["a.png", "b.png"]);
  // An editor pushes text it cannot resolve b.png for: the link survives.
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "editor" });
  r = await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [{ ref: "b.png" }] });
  assert.deepEqual(r.data, { linked: 0, kept: 1, dropped: 0 });
  assert.deepEqual([...assetRefsFor(id).keys()], ["b.png"]);
  // a.png is referenced by nothing now: gone from the table and the store.
  const store = fsStore(process.env.ASSETS_DIR!);
  assert.equal(await store.head(`${owner.id}/${sha(a)}`), null);
  assert.deepEqual(await store.head(`${owner.id}/${sha(b)}`), { size: 4 });
  // A hash the caller does not hold cannot be linked; an unknown ref without a hash is dropped.
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "c.png", hash: "1".repeat(64) }, { ref: "z.png" }] });
  assert.equal(r.status, 400);
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "b.png" }, { ref: "z.png" }] });
  assert.deepEqual(r.data, { linked: 0, kept: 1, dropped: 1 });
});

test("a hash another account really holds cannot be linked by someone who never uploaded it", async () => {
  const secret = Buffer.from("owner's private bytes");
  assert.equal((await upload(owner.token, secret)).status, 200);
  // The owner can link their own upload.
  const mine = await makeDoc(owner.token);
  const own = await json("PUT", `/api/docs/${mine}/assets`, owner.token, { refs: [{ ref: "s.png", hash: sha(secret) }] });
  assert.deepEqual(own.data, { linked: 1, kept: 0, dropped: 0 });
  // A stranger who knows the real hash (e.g. saw it referenced in shared
  // markdown) never uploaded those bytes under their own account, so it does
  // not exist in their scope: this is not the "nobody holds this hash" case,
  // it is "someone else holds it".
  const theirs = await makeDoc(stranger.token);
  const r = await json("PUT", `/api/docs/${theirs}/assets`, stranger.token, { refs: [{ ref: "s.png", hash: sha(secret) }] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "unknown asset");
  assert.equal(assetRefsFor(theirs).size, 0);
});

test("link refuses a document set over 500 MB by declared sizes", async () => {
  const id = await makeDoc(owner.token);
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  const big = "e".repeat(64);
  db.prepare("INSERT OR REPLACE INTO assets (owner_id, hash, size, mime, created_at) VALUES (?, ?, ?, ?, ?)").run(
    owner.id, big, 500 * 1024 * 1024 + 1, "video/mp4", "2026-01-01T00:00:00.000Z"
  );
  const r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "big.mp4", hash: big }] });
  assert.equal(r.status, 413);
  db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(owner.id, big);
});

test("a viewer may not link; a stranger sees 404", async () => {
  const id = await makeDoc(owner.token);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "viewer" });
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [] })).status, 403);
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, stranger.token, { refs: [] })).status, 404);
});

test("deleting the document unlinks and collects", async () => {
  const id = await makeDoc(owner.token);
  const z = Buffer.from("zzzz");
  await upload(owner.token, z);
  await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "z.png", hash: sha(z) }] });
  assert.equal((await json("DELETE", `/api/docs/${id}`, owner.token)).status, 200);
  assert.equal(assetRefsFor(id).size, 0);
  assert.equal(await fsStore(process.env.ASSETS_DIR!).head(`${owner.id}/${sha(z)}`), null);
});

test("every route answers 503 when no store is configured", async () => {
  setAssetStoreForTests(null);
  try {
    const id = await makeDoc(owner.token);
    assert.equal((await upload(owner.token, PNG)).status, 503);
    assert.equal((await json("POST", `/api/docs/${id}/assets/missing`, owner.token, { hashes: [] })).status, 503);
    assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [] })).status, 503);
  } finally {
    setAssetStoreForTests(fsStore(process.env.ASSETS_DIR!));
  }
});
