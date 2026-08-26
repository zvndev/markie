// Taking access away. Every one of these is the moment somebody believes a
// document stopped being readable, so each removal is checked by trying to
// read the document again afterwards rather than by trusting the 200.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-shares-revoke-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-shares-revoke-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { publicShare } = await import("./public.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/", publicShare);

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
const memberEmail = `member-${stamp}@markie.test`;
const invitedEmail = `invited-${stamp}@markie.test`;
const owner = await signUp("Owner", ownerEmail);
const member = await signUp("Member", memberEmail);
const stranger = await signUp("Stranger", `stranger-${stamp}@markie.test`);

async function newDoc(): Promise<string> {
  const docId = randomUUID();
  const content = "# Revoke\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  assert.equal(
    (await call("PUT", `/api/docs/${docId}`, owner, {
      name: "revoke.md",
      content,
      hash,
      baseVersion: 0,
    })).status,
    200
  );
  return docId;
}

interface ShareRow {
  user_id: string | null;
  email: string;
  role: string;
  pending?: boolean;
}

async function memberId(docId: string, email: string): Promise<string> {
  const res = await call<{ shares: ShareRow[] }>("GET", `/api/docs/${docId}/shares`, owner);
  const row = res.data?.shares.find((s) => s.email === email);
  assert.ok(row?.user_id, `no joined member ${email}`);
  return row.user_id;
}

test("removing a member ends their access immediately", async () => {
  const docId = await newDoc();
  await call("POST", `/api/docs/${docId}/shares`, owner, { email: memberEmail, role: "editor" });
  assert.equal((await call("GET", `/api/docs/${docId}`, member)).status, 200);

  const id = await memberId(docId, memberEmail);
  const res = await call<{ ok: boolean }>("DELETE", `/api/docs/${docId}/shares/${id}`, owner);
  assert.equal(res.status, 200);
  assert.equal(res.data?.ok, true);

  // GET /api/docs/:id answers 404 to somebody with no access — it does not
  // confirm the document exists.
  assert.equal((await call("GET", `/api/docs/${docId}`, member)).status, 404);
  const list = await call<{ shares: ShareRow[] }>("GET", `/api/docs/${docId}/shares`, owner);
  assert.deepEqual(list.data?.shares, []);
});

test("removing a pending invite by email drops it from the list", async () => {
  const docId = await newDoc();
  await call("POST", `/api/docs/${docId}/shares`, owner, {
    email: invitedEmail,
    role: "viewer",
  });
  const before = await call<{ shares: ShareRow[] }>("GET", `/api/docs/${docId}/shares`, owner);
  assert.ok(before.data?.shares.some((s) => s.email === invitedEmail && s.pending));

  const res = await call(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(invitedEmail)}`,
    owner
  );
  assert.equal(res.status, 200);

  const after = await call<{ shares: ShareRow[] }>("GET", `/api/docs/${docId}/shares`, owner);
  assert.equal(after.data?.shares.length, 0);
});

test("removing somebody who was never on the doc is a 404", async () => {
  const docId = await newDoc();
  assert.equal(
    (await call("DELETE", `/api/docs/${docId}/shares/${randomUUID()}`, owner)).status,
    404
  );
  assert.equal(
    (await call(
      "DELETE",
      `/api/docs/${docId}/shares/${encodeURIComponent("nobody@markie.test")}`,
      owner
    )).status,
    404
  );
});

test("only the owner can remove anybody", async () => {
  const docId = await newDoc();
  await call("POST", `/api/docs/${docId}/shares`, owner, { email: memberEmail, role: "editor" });
  const id = await memberId(docId, memberEmail);

  // an editor cannot remove themselves or anyone else
  const asMember = await call<{ error: string }>(
    "DELETE",
    `/api/docs/${docId}/shares/${id}`,
    member
  );
  assert.equal(asMember.status, 403);
  assert.equal(asMember.data?.error, "forbidden");

  const asStranger = await call("DELETE", `/api/docs/${docId}/shares/${id}`, stranger);
  assert.equal(asStranger.status, 403);

  const unauth = await call("DELETE", `/api/docs/${docId}/shares/${id}`);
  assert.equal(unauth.status, 401);

  // and the member still has access
  assert.equal((await call("GET", `/api/docs/${docId}`, member)).status, 200);
});

test("revoking the public link stops the URL working for everyone", async () => {
  const docId = await newDoc();
  const created = await call<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner);
  assert.equal(created.status, 200);
  const token = created.data!.url.split("/s/")[1];
  assert.ok(token);

  const live = await app.request(`/s/${token}`, {
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  assert.equal(live.status, 200);

  const revoke = await call<{ ok: boolean }>(
    "DELETE",
    `/api/docs/${docId}/public-link`,
    owner
  );
  assert.equal(revoke.status, 200);

  const dead = await app.request(`/s/${token}`, {
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  assert.equal(dead.status, 404);

  const readBack = await call<{ url: string | null }>(
    "GET",
    `/api/docs/${docId}/public-link`,
    owner
  );
  assert.equal(readBack.data?.url, null);
});

test("revoking is idempotent and safe when no link was ever made", async () => {
  const docId = await newDoc();
  assert.equal((await call("DELETE", `/api/docs/${docId}/public-link`, owner)).status, 200);
  assert.equal((await call("DELETE", `/api/docs/${docId}/public-link`, owner)).status, 200);
  const read = await call<{ url: string | null }>(
    "GET",
    `/api/docs/${docId}/public-link`,
    owner
  );
  assert.equal(read.data?.url, null);
});

test("a re-created public link gets a fresh token, not the revoked one", async () => {
  const docId = await newDoc();
  const first = await call<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner);
  const firstToken = first.data!.url.split("/s/")[1];
  await call("DELETE", `/api/docs/${docId}/public-link`, owner);

  const second = await call<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner);
  const secondToken = second.data!.url.split("/s/")[1];
  assert.notEqual(secondToken, firstToken);

  const oldUrl = await app.request(`/s/${firstToken}`, {
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  assert.equal(oldUrl.status, 404);
});

test("only the owner can create or revoke the public link", async () => {
  const docId = await newDoc();
  await call("POST", `/api/docs/${docId}/shares`, owner, { email: memberEmail, role: "editor" });

  assert.equal((await call("POST", `/api/docs/${docId}/public-link`, member)).status, 403);
  assert.equal((await call("DELETE", `/api/docs/${docId}/public-link`, member)).status, 403);
  assert.equal((await call("POST", `/api/docs/${docId}/public-link`, stranger)).status, 403);
  assert.equal((await call("DELETE", `/api/docs/${docId}/public-link`, undefined)).status, 401);

  // an editor may still see whether one exists
  assert.equal((await call("GET", `/api/docs/${docId}/public-link`, member)).status, 200);
  // a stranger may not
  assert.equal((await call("GET", `/api/docs/${docId}/public-link`, stranger)).status, 403);
});

test("asking twice for a public link returns the same one", async () => {
  const docId = await newDoc();
  const a = await call<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner);
  const b = await call<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner);
  assert.equal(a.data?.url, b.data?.url);
});

test("deleting the doc takes the public link down with it", async () => {
  const docId = await newDoc();
  const created = await call<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner);
  const token = created.data!.url.split("/s/")[1];

  assert.equal((await call("DELETE", `/api/docs/${docId}`, owner)).status, 200);
  const res = await app.request(`/s/${token}`, {
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  assert.equal(res.status, 404);
});
