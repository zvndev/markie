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
const { assetsApi, assetRefsFor, MAX_ASSET_BYTES, MAX_ACCOUNT_ASSET_BYTES, MAX_DOC_REFS, setAssetStoreForTests, setAssetLimitsForTests, inflightForTests, sweepOrphans } = await import("./assets.ts");
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
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
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
  assert.deepEqual(r.data, { linked: 2, kept: 0, dropped: 0, droppedRefs: [] });
  assert.deepEqual([...assetRefsFor(id).keys()].sort(), ["a.png", "b.png"]);
  // An editor pushes text it cannot resolve b.png for: the link survives.
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "editor" });
  r = await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [{ ref: "b.png" }] });
  assert.deepEqual(r.data, { linked: 0, kept: 1, dropped: 0, droppedRefs: [] });
  assert.deepEqual([...assetRefsFor(id).keys()], ["b.png"]);
  // a.png is referenced by nothing now: gone from the table and the store.
  const store = fsStore(process.env.ASSETS_DIR!);
  assert.equal(await store.head(`${owner.id}/${sha(a)}`), null);
  assert.deepEqual(await store.head(`${owner.id}/${sha(b)}`), { size: 4 });
  // A hash the caller does not hold cannot be linked; an unknown ref without a hash is dropped.
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "c.png", hash: "1".repeat(64) }, { ref: "z.png" }] });
  assert.equal(r.status, 400);
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "b.png" }, { ref: "z.png" }] });
  assert.deepEqual(r.data, { linked: 0, kept: 1, dropped: 1, droppedRefs: [] });
});

test("a hash another account really holds cannot be linked by someone who never uploaded it", async () => {
  const secret = Buffer.from("owner's private bytes");
  assert.equal((await upload(owner.token, secret)).status, 200);
  // The owner can link their own upload.
  const mine = await makeDoc(owner.token);
  const own = await json("PUT", `/api/docs/${mine}/assets`, owner.token, { refs: [{ ref: "s.png", hash: sha(secret) }] });
  assert.deepEqual(own.data, { linked: 1, kept: 0, dropped: 0, droppedRefs: [] });
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

// The client pushes its link set just before the text snapshot those links
// belong to. If the text is refused as stale, the links must be refused too,
// or the document keeps yesterday's markdown pointing at today's pictures.
test("link with a stale baseVersion is refused and the previous set survives", async () => {
  const id = await makeDoc(owner.token);
  const a = Buffer.from("base-version-a"), b = Buffer.from("base-version-b");
  assert.equal((await upload(owner.token, a)).status, 200);
  assert.equal((await upload(owner.token, b)).status, 200);
  // makeDoc wrote version 1, so that is the snapshot these links describe.
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { baseVersion: 1, refs: [{ ref: "a.png", hash: sha(a) }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 1, kept: 0, dropped: 0, droppedRefs: [] });

  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { baseVersion: 0, refs: [{ ref: "a.png", hash: sha(b) }] });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "version mismatch");
  assert.equal(r.data.serverVersion, 1);
  // Nothing moved: the ref still points at the hash the accepted text named.
  assert.equal(assetRefsFor(id).get("a.png")?.hash, sha(a));
  // And the refused set's own hash was not collected as an orphan either.
  assert.deepEqual(await fsStore(process.env.ASSETS_DIR!).head(`${owner.id}/${sha(b)}`), { size: b.length });

  // The current version is accepted, and a body without baseVersion still is.
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { baseVersion: 1, refs: [{ ref: "a.png", hash: sha(b) }] });
  assert.equal(r.status, 200);
  assert.equal(assetRefsFor(id).get("a.png")?.hash, sha(b));
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "a.png", hash: sha(b) }] });
  assert.equal(r.status, 200);
});

// A baseVersion that is not a whole number is a client bug, and silently
// ignoring it would skip exactly the check it asked for.
test("link refuses a malformed baseVersion rather than ignoring it", async () => {
  const id = await makeDoc(owner.token);
  const r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { baseVersion: "1", refs: [] });
  assert.equal(r.status, 400);
});

// Polls a condition instead of sleeping a fixed time, and gives up rather
// than hanging the run if the condition never comes true.
async function waitFor(ready: () => boolean, what: string) {
  for (let i = 0; i < 2000; i += 1) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A store whose put parks until the returned gate is opened, so a test can
// hold uploads in flight and see what a concurrent request is told.
function blockingStore() {
  const real = fsStore(process.env.ASSETS_DIR!);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const state = { puts: 0 };
  const store = {
    ...real,
    put: async (...args: Parameters<typeof real.put>) => {
      state.puts += 1;
      await gate;
      return real.put(...args);
    },
  };
  return { real, store, state, open: () => open() };
}

// The pre-flight account check reads committed usage, so without a
// reservation every parallel request sees the same headroom and all of them
// buffer a body and upload it before the transaction refuses the excess.
test("an in-flight upload's declared bytes count against the account cap", async () => {
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  const filler = "a".repeat(64);
  db.prepare("INSERT OR REPLACE INTO assets (owner_id, hash, size, mime, created_at) VALUES (?, ?, ?, ?, ?)").run(
    stranger.id, filler, MAX_ACCOUNT_ASSET_BYTES - 150 * 1024 * 1024, "image/png", "2026-01-01T00:00:00.000Z"
  );
  const { real, store, state, open } = blockingStore();
  setAssetStoreForTests(store);
  const declared = 100 * 1024 * 1024;
  const a = Buffer.from("in-flight-a");
  try {
    // Declares 100 MB and sends a handful of bytes: the reservation has to
    // work off what the client claims, before the body is read.
    const first = upload(stranger.token, a, sha(a), "image/png", declared);
    await waitFor(() => state.puts === 1, "the first upload to reach the store");
    assert.equal(inflightForTests().get(stranger.id)?.bytes, declared);

    const b = Buffer.from("in-flight-b");
    const second = await upload(stranger.token, b, sha(b), "image/png", declared);
    assert.equal(second.status, 413);
    assert.equal(second.data.error, "account over cap");
    // Refused before its body was buffered or a byte went to storage.
    assert.equal(state.puts, 1);
    assert.equal(await fsStore(process.env.ASSETS_DIR!).head(`${stranger.id}/${sha(b)}`), null);

    open();
    assert.equal((await first).status, 200);
    // The reservation is released once the request is done, not left behind.
    assert.equal(inflightForTests().get(stranger.id), undefined);
  } finally {
    setAssetStoreForTests(real);
    db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash IN (?, ?)").run(stranger.id, filler, sha(a));
    await real.delete(`${stranger.id}/${sha(a)}`);
  }
});

// Concurrency is its own limit: many small uploads never trip the cap, but
// each one still holds a temp file and an outbound connection.
test("a fifth concurrent upload from one account is refused", async () => {
  const { real, store, state, open } = blockingStore();
  setAssetStoreForTests(store);
  const held = [0, 1, 2, 3].map((n) => Buffer.from(`concurrent-upload-${n}`));
  const extra = Buffer.from("concurrent-upload-4");
  try {
    const running = held.map((bytes) => upload(editor.token, bytes, sha(bytes), "image/png", bytes.length));
    await waitFor(() => state.puts === 4, "four uploads to reach the store");
    assert.equal(inflightForTests().get(editor.id)?.count, 4);

    const fifth = await upload(editor.token, extra, sha(extra), "image/png", extra.length);
    assert.equal(fifth.status, 429);
    assert.equal(fifth.data.error, "too many uploads");
    // A client that is told to slow down needs to be told for how long.
    assert.equal(fifth.headers.get("retry-after"), "1");
    assert.equal(state.puts, 4);

    open();
    for (const r of await Promise.all(running)) assert.equal(r.status, 200);
    assert.equal(inflightForTests().get(editor.id), undefined);
    // With the four finished there is room again.
    assert.equal((await upload(editor.token, extra, sha(extra), "image/png", extra.length)).status, 200);
  } finally {
    setAssetStoreForTests(real);
    const { openDatabase } = await import("./db.ts");
    const db = openDatabase();
    for (const bytes of [...held, extra]) {
      db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(editor.id, sha(bytes));
      await real.delete(`${editor.id}/${sha(bytes)}`);
    }
  }
});

// A document that shows one picture three times leaves three candidates
// naming one object, and a bucket DELETE can wait up to two minutes.
test("orphan collection deletes one object per hash, however many refs named it", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("one-object-three-refs");
  assert.equal((await upload(owner.token, bytes)).status, 200);
  const refs = ["a.png", "b.png", "c.png"].map((ref) => ({ ref, hash: sha(bytes) }));
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs })).status, 200);

  const real = fsStore(process.env.ASSETS_DIR!);
  const deletes: string[] = [];
  setAssetStoreForTests({ ...real, delete: async (key: string) => { deletes.push(key); return real.delete(key); } });
  try {
    assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [] })).status, 200);
    assert.deepEqual(deletes, [`${owner.id}/${sha(bytes)}`]);
  } finally {
    setAssetStoreForTests(real);
  }
});

// Serially awaiting every DELETE makes a document with a lot of media hostage
// to the slowest one, and docs.delete awaits this sweep before it answers.
test("orphan deletes run four at a time, not one by one", async () => {
  const id = await makeDoc(owner.token);
  const many = [0, 1, 2, 3, 4, 5].map((n) => Buffer.from(`bounded-orphan-${n}`));
  for (const bytes of many) assert.equal((await upload(owner.token, bytes)).status, 200);
  const refs = many.map((bytes, i) => ({ ref: `o${i}.png`, hash: sha(bytes) }));
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs })).status, 200);

  const real = fsStore(process.env.ASSETS_DIR!);
  let live = 0, peak = 0;
  setAssetStoreForTests({
    ...real,
    delete: async (key: string) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return real.delete(key);
    },
  });
  try {
    assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [] })).status, 200);
    assert.equal(peak, 4);
    for (const bytes of many) assert.equal(await real.head(`${owner.id}/${sha(bytes)}`), null);
  } finally {
    setAssetStoreForTests(real);
  }
});

// An upload the document cap rejects was never in the document's previous
// link set, so collectOrphans cannot discover it and it counts against the
// account forever. The grace period is what tells an abandoned upload apart
// from one whose link push simply has not landed yet.
test("the orphan sweep removes an old unreferenced asset and leaves the rest alone", async () => {
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  const real = fsStore(process.env.ASSETS_DIR!);
  const stale = Buffer.from("sweep-stale"), fresh = Buffer.from("sweep-fresh"), held = Buffer.from("sweep-held");
  for (const bytes of [stale, fresh, held]) assert.equal((await upload(owner.token, bytes)).status, 200);
  const id = await makeDoc(owner.token);
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "h.png", hash: sha(held) }] })).status, 200);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE assets SET created_at = ? WHERE owner_id = ? AND hash IN (?, ?)").run(twoHoursAgo, owner.id, sha(stale), sha(held));

  await sweepOrphans();

  const row = (hash: string) => db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND hash = ?").get(owner.id, hash);
  assert.equal(row(sha(stale)), undefined);
  assert.equal(await real.head(`${owner.id}/${sha(stale)}`), null);
  // Too young to be abandoned: its link push may still be on its way.
  assert.ok(row(sha(fresh)));
  assert.deepEqual(await real.head(`${owner.id}/${sha(fresh)}`), { size: fresh.length });
  // Old, but a document still links it, so it is not an orphan at all.
  assert.ok(row(sha(held)));
  assert.deepEqual(await real.head(`${owner.id}/${sha(held)}`), { size: held.length });
});

// collectOrphans empties the rows synchronously and then works through the
// storage deletes four at a time, so a delete can still be queued when the
// same bytes are uploaded again. Removing the object then would leave a row
// with nothing behind it, the one state this module must never produce.
test("a re-upload during a queued orphan delete keeps its object", async () => {
  const id = await makeDoc(owner.token);
  const many = [0, 1, 2, 3, 4].map((n) => Buffer.from(`requeued-orphan-${n}`));
  for (const bytes of many) assert.equal((await upload(owner.token, bytes)).status, 200);
  const refs = many.map((bytes, i) => ({ ref: `q${i}.png`, hash: sha(bytes) }));
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs })).status, 200);

  const real = fsStore(process.env.ASSETS_DIR!);
  let open: () => void = () => {};
  const parked = new Promise<void>((resolve) => { open = resolve; });
  const deleted: string[] = [];
  setAssetStoreForTests({
    ...real,
    delete: async (key: string) => { deleted.push(key); await parked; return real.delete(key); },
  });
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  let queued = many[4];
  try {
    const unlinking = json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [] });
    // Four deletes fill the pool; one candidate is still waiting its turn.
    await waitFor(() => deleted.length === 4, "the orphan delete pool to fill");
    queued = many.find((bytes) => !deleted.includes(`${owner.id}/${sha(bytes)}`))!;
    assert.ok(queued, "one candidate should still be queued");
    // Its row went with the others, so this is a full re-upload.
    assert.equal((await upload(owner.token, queued)).status, 200);

    open();
    assert.equal((await unlinking).status, 200);
    // The queued delete saw the new row and stood down.
    assert.equal(deleted.length, 4);
    assert.ok(db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND hash = ?").get(owner.id, sha(queued)));
    assert.deepEqual(await real.head(`${owner.id}/${sha(queued)}`), { size: queued.length });
    for (const bytes of many.filter((b) => b !== queued)) {
      assert.equal(await real.head(`${owner.id}/${sha(bytes)}`), null);
    }
  } finally {
    setAssetStoreForTests(real);
    db.prepare("DELETE FROM assets WHERE owner_id = ? AND hash = ?").run(owner.id, sha(queued));
    await real.delete(`${owner.id}/${sha(queued)}`);
  }
});

// The dedupe short-circuit answers 200 without writing anything, so a row the
// sweep is about to consider stale stays stale while the client goes on to
// link it.
test("re-uploading bytes the account already holds keeps them out of the sweep", async () => {
  const { openDatabase } = await import("./db.ts");
  const db = openDatabase();
  const bytes = Buffer.from("dedupe-refreshes-created-at");
  assert.equal((await upload(owner.token, bytes)).status, 200);
  db.prepare("UPDATE assets SET created_at = ? WHERE owner_id = ? AND hash = ?").run(
    new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), owner.id, sha(bytes)
  );
  // The dedupe path: the row and the object are both already there.
  assert.equal((await upload(owner.token, bytes)).status, 200);

  await sweepOrphans();
  assert.ok(db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND hash = ?").get(owner.id, sha(bytes)));
  assert.deepEqual(await fsStore(process.env.ASSETS_DIR!).head(`${owner.id}/${sha(bytes)}`), { size: bytes.length });
});

// ── The shape of a reference ───────────────────────────────────────────────
// Who wrote the reference decides what may be uploaded under it. A reference
// that climbs out of the document's own folder is the one shape an attacker
// needs: a co-editor writes it into the text, and the machine that syncs the
// document resolves it against its own disk. Markie refuses to stage those
// (electron/asset-sync.js); this is the server refusing to store them, so a
// client that does not have the rule, or has been made to lose it, still
// cannot land the attack.
const ESCAPING = ["../x.png", "a/../../x.png", "/abs/x.png", "\\abs\\x.png", "C:\\Users\\x.png", "\\\\server\\share\\x.png"];
// Forms that read like an escape and are not one. `./shot.png` is how a lot
// of people write a reference to the file beside the document, and a segment
// that is popped by a later `..` never left the folder at all. Refusing them
// would mean those pictures never travel with a shared document.
const INSIDE = ["./x.png", "a/../x.png", "a/b/../../x.png"];

test("an editor cannot link a reference that leaves the document's folder", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("editor-escaping-ref");
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "editor" });
  assert.equal((await upload(editor.token, bytes)).status, 200);
  for (const ref of ESCAPING) {
    const r = await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [{ ref, hash: sha(bytes) }] });
    assert.equal(r.status, 400, `${ref} should be refused`);
    assert.equal(r.data.error, "bad ref");
  }
  // A reference beside the document is the ordinary case and still works, and
  // so does every spelling of it that normalises to the same place. The ref
  // is stored exactly as it was written, never rewritten.
  for (const ref of ["x.png", ...INSIDE]) {
    const ok = await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [{ ref, hash: sha(bytes) }] });
    assert.equal(ok.status, 200, `${ref} should be accepted`);
    assert.deepEqual([...assetRefsFor(id).keys()], [ref]);
  }
});

test("the owner of a shared-out document cannot link one either, and a private document's owner can", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("owner-repository-pattern");
  assert.equal((await upload(owner.token, bytes)).status, 200);
  // Private: the spec's repository pattern, where the document and its assets
  // folder are checked in beside each other and there is no second party.
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "../assets/logo.png", hash: sha(bytes) }] });
  assert.equal(r.status, 200);
  assert.deepEqual([...assetRefsFor(id).keys()], ["../assets/logo.png"]);
  // The moment somebody else can read it, the same reference is refused.
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "viewer" });
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "../assets/logo.png", hash: sha(bytes) }] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "bad ref");
  // And the previous set is untouched by the refusal.
  assert.deepEqual([...assetRefsFor(id).keys()], ["../assets/logo.png"]);
  // Popping out of the folder twice is the same escape written differently.
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "a/../../x.png", hash: sha(bytes) }] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "bad ref");
  // The forms that never actually leave the folder still link for the owner
  // of a shared-out document, exactly as they do for an editor.
  for (const ref of INSIDE) {
    const ok = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref, hash: sha(bytes) }] });
    assert.equal(ok.status, 200, `${ref} should be accepted`);
    assert.deepEqual([...assetRefsFor(id).keys()], [ref]);
  }
});

test("a public link alone makes the owner's document shared out for this check", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("public-link-escaping-ref");
  assert.equal((await upload(owner.token, bytes)).status, 200);
  assert.equal((await json("POST", `/api/docs/${id}/public-link`, owner.token, {})).status, 200);
  const r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "../secret.png", hash: sha(bytes) }] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "bad ref");
});

// These are refused for everyone, private document or not: none of them is a
// reference any renderer could resolve, and a ref is written into a header
// name, a query string and a Map key downstream.
test("a malformed reference is refused whoever is asking", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("malformed-ref-bytes");
  assert.equal((await upload(owner.token, bytes)).status, 200);
  const malformed = ["", "a\u0000b.png", "a\rb.png", "a\nb.png", "a\u007fb.png", `${"n".repeat(2049)}.png`];
  for (const ref of malformed) {
    const r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref, hash: sha(bytes) }] });
    assert.equal(r.status, 400, `${JSON.stringify(ref)} should be refused`);
    assert.equal(r.data.error, "bad ref");
  }
  // A ref missing from the entry altogether is the same malformed body.
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ hash: sha(bytes) }] })).status, 400);
  // 2048 bytes exactly is still allowed, and a multi-byte character counts
  // its bytes: the cap is on what is stored, not on what JavaScript counts.
  const long = `${"n".repeat(2044)}.png`;
  assert.equal(Buffer.byteLength(long), 2048);
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: long, hash: sha(bytes) }] })).status, 200);
  const wide = `${"é".repeat(1023)}.png`;
  assert.equal(Buffer.byteLength(wide), 2050);
  assert.equal((await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: wide, hash: sha(bytes) }] })).status, 400);
});

// An escaping reference carrying a hash is a request to store bytes under it,
// and that is refused. An escaping reference with no hash stores nothing: it
// is a document saying "I point at this and could not resolve it". Refusing
// the body for one of those would mean a shared document containing
// ../x.png never linked any of its media at all, and retried the same refusal
// on every save and every reconciliation pass for ever.
test("an escaping reference with no hash is dropped, not refused", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("older-client-body-shape");
  assert.equal((await upload(editor.token, bytes)).status, 200);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "editor" });
  // The exact body an older client builds for the document in the review's
  // critical finding: what it could resolve beside the document, and the
  // escaping reference it could not, sent bare. The server alone has to be
  // safe against it, whatever the client does.
  const r = await json("PUT", `/api/docs/${id}/assets`, editor.token, {
    refs: [{ ref: "x.png", hash: sha(bytes) }, { ref: "../y.png" }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 1, kept: 0, dropped: 1, droppedRefs: [{ ref: "../y.png", reason: "escaping" }] });
  assert.deepEqual([...assetRefsFor(id).keys()], ["x.png"]);
});

// The drop is a drop, not a keep: bytes already linked under an escaping
// reference do not survive a push from somebody who can only name it.
test("a bare escaping reference does not keep a link the document already had", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("kept-under-an-escaping-ref");
  assert.equal((await upload(owner.token, bytes)).status, 200);
  // Linked while the document was private, which is allowed.
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "../logo.png", hash: sha(bytes) }] });
  assert.equal(r.status, 200);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "editor" });
  r = await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [{ ref: "../logo.png" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 0, kept: 0, dropped: 1, droppedRefs: [{ ref: "../logo.png", reason: "escaping" }] });
  assert.equal(assetRefsFor(id).size, 0);
});

// A private document's owner is not in the exposed set at all, so a bare
// reference of any shape still keeps the link it already has. That is the
// case an editor pushing text whose pictures the owner uploaded relies on.
test("a private document's owner still keeps an escaping reference's existing link", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("private-repository-pattern");
  assert.equal((await upload(owner.token, bytes)).status, 200);
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "../assets/logo.png", hash: sha(bytes) }] });
  assert.equal(r.status, 200);
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "../assets/logo.png" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 0, kept: 1, dropped: 0, droppedRefs: [] });
  assert.deepEqual([...assetRefsFor(id).keys()], ["../assets/logo.png"]);
});

// Nothing bounded how many references one document could carry. A single
// request naming one 1-byte asset under 300 000 references turned every later
// read of that document, including an anonymous one through a public link,
// into a quarter of a second of CPU and tens of megabytes of allocation.
test("link refuses a reference set longer than the cap, and the cap itself still works", async () => {
  const id = await makeDoc(owner.token);
  const atCap = Array.from({ length: MAX_DOC_REFS }, (_, i) => ({ ref: `f${i}.png` }));
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: atCap });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 0, kept: 0, dropped: MAX_DOC_REFS, droppedRefs: [] });

  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [...atCap, { ref: "one-too-many.png" }] });
  assert.equal(r.status, 413);
  assert.deepEqual(r.data, { error: "too many references", cap: MAX_DOC_REFS });
  // The refusal is a refusal: the document's set is untouched.
  assert.equal(assetRefsFor(id).size, 0);
});

// The upload route takes the Content-Type from the client and checks only
// that it is in the allow-list; the reference it is later linked under is
// never consulted. So HTML bytes declared image/svg+xml were stored and
// served back as image/svg+xml under the reference a.png. On the web that is
// contained by nosniff and the sandboxing CSP, and on the desktop the
// protocol handler uses the requested path's extension rather than the
// server's type, which is right and means the two sides label the same bytes
// differently. asset-mime.ts already maps extension to mime, so the check is
// free, and this is the one place a stored object's declared type is taken on
// the client's word.
test("link drops an entry whose stored type is not the type its reference names", async () => {
  const id = await makeDoc(owner.token);
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  assert.equal((await upload(owner.token, svg, sha(svg), "image/svg+xml")).status, 200);
  // The bytes really are this account's, so nothing else refuses them.
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "a.png", hash: sha(svg) }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 0, kept: 0, dropped: 1, droppedRefs: [{ ref: "a.png", reason: "mime" }] });
  assert.equal(assetRefsFor(id).size, 0);
  // Under the reference that does name its type, it links.
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "a.svg", hash: sha(svg) }] });
  assert.equal(r.status, 200);
  assert.deepEqual([...assetRefsFor(id).keys()], ["a.svg"]);
  // The table's deliberate pairings are pairings, not drift: .m4v is
  // video/mp4 and .opus is audio/ogg, in step with electron/local-assets.js.
  const clip = Buffer.from("not really a movie");
  assert.equal((await upload(owner.token, clip, sha(clip), "video/mp4")).status, 200);
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "clip.m4v", hash: sha(clip) }] });
  assert.equal(r.status, 200);
});

test("a reference whose extension names no type carries no hash", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("typeless-ref-bytes");
  assert.equal((await upload(owner.token, bytes)).status, 200);
  for (const ref of ["README", "notes.txt", "a.png.exe"]) {
    const r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref, hash: sha(bytes) }] });
    assert.equal(r.status, 200, `${ref} should be accepted and dropped`);
    assert.deepEqual(r.data, { linked: 0, kept: 0, dropped: 1, droppedRefs: [{ ref, reason: "mime" }] });
    assert.equal(assetRefsFor(id).size, 0);
  }
  // The same references bare are the ordinary case: the document names a
  // local file the push could not resolve, and the server keeps nothing.
  const r = await json("PUT", `/api/docs/${id}/assets`, owner.token, {
    refs: [{ ref: "README" }, { ref: "notes.txt" }, { ref: "a.png.exe" }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 0, kept: 0, dropped: 3, droppedRefs: [] });
});

// An asset row is keyed (owner_id, hash) and its mime is written once, by the
// upload that created it; the dedupe branch returns 200 for bytes the account
// already holds without touching it. So one set of bytes has exactly one type
// for the life of the account, and refusing the whole body over a reference
// whose extension disagrees made an ordinary rename permanent: the document's
// other pictures never linked either, and the client retried the identical
// refused body every ten minutes for ever. The security property is the same
// whichever way it goes, because no bytes are stored under a name that lies
// about their type. Only the blast radius changes.
test("a reference whose extension disagrees with the stored type is dropped, not refused", async () => {
  const id = await makeDoc(owner.token);
  const icon = Buffer.from("these bytes were uploaded as a png");
  const other = Buffer.from("an unrelated picture");
  assert.equal((await upload(owner.token, icon)).status, 200);
  assert.equal((await upload(owner.token, other)).status, 200);

  // The everyday case: one file copied to a second name, which most .ico
  // files really are, plus a perfectly ordinary second picture.
  const r = await json("PUT", `/api/docs/${id}/assets`, owner.token, {
    refs: [
      { ref: "icon.png", hash: sha(icon) },
      { ref: "favicon.ico", hash: sha(icon) },
      { ref: "shot.png", hash: sha(other) },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, {
    linked: 2,
    kept: 0,
    dropped: 1,
    droppedRefs: [{ ref: "favicon.ico", reason: "mime" }],
  });
  // The two that agree are stored, and the one that cannot be served
  // honestly is not.
  assert.deepEqual([...assetRefsFor(id).keys()].sort(), ["icon.png", "shot.png"]);
});

test("renaming a synced picture's extension leaves the rest of the document linked", async () => {
  const id = await makeDoc(owner.token);
  const logo = Buffer.from("uploaded once, as a png");
  assert.equal((await upload(owner.token, logo)).status, 200);
  let r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "logo.png", hash: sha(logo) }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.droppedRefs, []);
  // The user renames the file and updates the markdown. The bytes, and so the
  // hash, and so the row's mime, are all unchanged.
  r = await json("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "logo.gif", hash: sha(logo) }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { linked: 0, kept: 0, dropped: 1, droppedRefs: [{ ref: "logo.gif", reason: "mime" }] });
  // And the stale link is gone rather than being kept alive for ever by a
  // body the server never accepted.
  assert.equal(assetRefsFor(id).size, 0);
});

// The response has to say why an entry did not survive, or the client cannot
// tell "dropped, settle the row" from "refused, try again".
test("a bare escaping reference is named in the response as escaping", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("named-in-the-response");
  assert.equal((await upload(editor.token, bytes)).status, 200);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "editor" });
  const r = await json("PUT", `/api/docs/${id}/assets`, editor.token, {
    refs: [{ ref: "x.png", hash: sha(bytes) }, { ref: "../y.png" }, { ref: "never-linked.png" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.dropped, 2);
  // An ordinary drop is a reference the document names and nothing holds, and
  // there is nothing to say about it. Only the two the server decided against
  // are named.
  assert.deepEqual(r.data.droppedRefs, [{ ref: "../y.png", reason: "escaping" }]);
});

// A ref is stored and matched exactly as written, and refEscapes reads it as
// a path, so it has to read the path the reference actually means.
test("an escaping reference spelt with percent escapes is still an escaping reference", async () => {
  const id = await makeDoc(owner.token);
  const bytes = Buffer.from("percent-encoded-traversal");
  assert.equal((await upload(editor.token, bytes)).status, 200);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "editor@markie.test", role: "editor" });
  for (const ref of ["%2e%2e/x.png", "%2E%2E/x.png", "..%2fx.png", "%2e%2e%2fx.png", "a/%2e%2e/%2e%2e/x.png", "%2fabs%2fx.png"]) {
    const r = await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [{ ref, hash: sha(bytes) }] });
    assert.equal(r.status, 400, `${ref} should be refused`);
    assert.equal(r.data.error, "bad ref");
  }
  // A stray percent is not an escape and is not a reason to refuse a file
  // whose name really does contain one.
  const ok = await json("PUT", `/api/docs/${id}/assets`, editor.token, { refs: [{ ref: "50% done.png", hash: sha(bytes) }] });
  assert.equal(ok.status, 200);
});
