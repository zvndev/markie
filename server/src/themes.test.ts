// The theme store follows the account, and a pinned doc theme is owner-only.
// Both are "opaque JSON" endpoints, which is exactly where authorization slips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-themes-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-themes-test-secret-32-plus-characters";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { themes } = await import("./themes.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api", themes);

const stamp = Date.now();

async function call<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T | null }> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
    Origin: "http://localhost:3000",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

async function signUp(name: string, email: string): Promise<string> {
  const { token } = await signUpVerified(app, { name, email });
  return token;
}

const ownerEmail = `owner-${stamp}@markie.test`;
const viewerEmail = `viewer-${stamp}@markie.test`;
const owner = await signUp("Owner", ownerEmail);
const viewer = await signUp("Viewer", viewerEmail);
const stranger = await signUp("Stranger", `stranger-${stamp}@markie.test`);

async function sharedDoc(): Promise<string> {
  const docId = randomUUID();
  const content = "# Theme\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  assert.equal(
    (await call("PUT", `/api/docs/${docId}`, owner, {
      name: "theme.md",
      content,
      hash,
      baseVersion: 0,
    })).status,
    200
  );
  assert.equal(
    (await call("POST", `/api/docs/${docId}/shares`, owner, {
      email: viewerEmail,
      role: "viewer",
    })).status,
    200
  );
  return docId;
}

const TOKENS = { background: "#101010", accent: "#f59e0b", fontSize: 16 };

test("the account theme store round-trips, opaquely", async () => {
  const empty = await call<{ store: unknown; updated_at: string | null }>(
    "GET",
    "/api/me/themes",
    owner
  );
  assert.equal(empty.status, 200);
  assert.equal(empty.data?.store, null);
  assert.equal(empty.data?.updated_at, null);

  const store = { activeId: "sunset", custom: [{ id: "sunset", tokens: TOKENS }] };
  const put = await call<{ ok: boolean; updated_at: string }>(
    "PUT",
    "/api/me/themes",
    owner,
    { store }
  );
  assert.equal(put.status, 200);
  assert.ok(put.data?.updated_at);

  const read = await call<{ store: typeof store }>("GET", "/api/me/themes", owner);
  assert.deepEqual(read.data?.store, store);
});

test("the theme store is last-write-wins per account, and private to it", async () => {
  await call("PUT", "/api/me/themes", owner, { store: { activeId: "a", custom: [] } });
  await call("PUT", "/api/me/themes", owner, { store: { activeId: "b", custom: [] } });
  const mine = await call<{ store: { activeId: string } }>("GET", "/api/me/themes", owner);
  assert.equal(mine.data?.store.activeId, "b");

  // another account sees its own store, not the owner's
  const theirs = await call<{ store: unknown }>("GET", "/api/me/themes", stranger);
  assert.equal(theirs.data?.store, null);
});

test("the theme store rejects a non-object payload", async () => {
  for (const store of [null, "dark", 3, undefined]) {
    const res = await call("PUT", "/api/me/themes", owner, { store });
    assert.equal(res.status, 400, JSON.stringify(store));
  }
});

test("the theme routes are closed to unauthenticated callers", async () => {
  assert.equal((await call("GET", "/api/me/themes")).status, 401);
  assert.equal((await call("PUT", "/api/me/themes", undefined, { store: {} })).status, 401);
  const docId = await sharedDoc();
  assert.equal((await call("GET", `/api/docs/${docId}/theme`)).status, 401);
  assert.equal(
    (await call("PUT", `/api/docs/${docId}/theme`, undefined, { tokens: null })).status,
    401
  );
});

test("the owner pins a doc theme and every member reads it", async () => {
  const docId = await sharedDoc();

  const before = await call<{ tokens: unknown }>("GET", `/api/docs/${docId}/theme`, viewer);
  assert.equal(before.status, 200);
  assert.equal(before.data?.tokens, null);

  assert.equal(
    (await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS })).status,
    200
  );

  const after = await call<{ tokens: typeof TOKENS }>(
    "GET",
    `/api/docs/${docId}/theme`,
    viewer
  );
  assert.deepEqual(after.data?.tokens, TOKENS);
});

test("unpinning with null clears the doc theme", async () => {
  const docId = await sharedDoc();
  await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: TOKENS });
  assert.equal(
    (await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: null })).status,
    200
  );
  const read = await call<{ tokens: unknown }>("GET", `/api/docs/${docId}/theme`, owner);
  assert.equal(read.data?.tokens, null);
});

test("only the owner can pin a doc theme", async () => {
  const docId = await sharedDoc();
  for (const token of [viewer, stranger]) {
    const res = await call<{ error: string }>("PUT", `/api/docs/${docId}/theme`, token, {
      tokens: TOKENS,
    });
    assert.equal(res.status, 403);
    assert.equal(res.data?.error, "forbidden");
  }
});

test("a non-member cannot read a doc's theme", async () => {
  const docId = await sharedDoc();
  const res = await call("GET", `/api/docs/${docId}/theme`, stranger);
  assert.equal(res.status, 403);
});

test("pinning rejects a non-object token payload", async () => {
  const docId = await sharedDoc();
  const res = await call("PUT", `/api/docs/${docId}/theme`, owner, { tokens: "dark" });
  assert.equal(res.status, 400);
});

test("an unknown doc is a 403, not a leak that it does not exist", async () => {
  const res = await call("GET", `/api/docs/${randomUUID()}/theme`, owner);
  assert.equal(res.status, 403);
});
