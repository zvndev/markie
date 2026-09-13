// Whether an owned document is reachable by anybody but its owner, as the
// listing reports it. The desktop client decides what media it may upload
// from this flag: an owned document nobody else can reach is private, and a
// private document is the only place a reference outside its own folder is
// still allowed to travel.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-shared-out-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-shared-out-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function json(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as never };
}

async function makeDoc(token: string) {
  const id = crypto.randomUUID();
  const content = "# t\n";
  const r = await json("PUT", `/api/docs/${id}`, token, { name: "t.md", content, hash: sha(content), baseVersion: 0 });
  assert.equal(r.status, 200);
  return id;
}

async function listed(token: string, id: string) {
  const r = await json("GET", "/api/docs", token);
  assert.equal(r.status, 200);
  return (r.data as { docs: { id: string; sharedOut?: boolean; shared?: boolean }[] }).docs.find((d) => d.id === id);
}

let owner: { token: string; id: string };
let member: { token: string; id: string };
before(async () => {
  owner = await signUpVerified(app, { name: "Owner", email: "owner@markie.test" });
  member = await signUpVerified(app, { name: "Member", email: "member@markie.test" });
});

test("an owned document nobody else can reach is not shared out", async () => {
  const id = await makeDoc(owner.token);
  assert.equal((await listed(owner.token, id))?.sharedOut, false);
});

test("a member makes an owned document shared out", async () => {
  const id = await makeDoc(owner.token);
  assert.equal((await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "member@markie.test", role: "editor" })).status, 200);
  assert.equal((await listed(owner.token, id))?.sharedOut, true);
});

test("an invite waiting for an address that has no account makes it shared out", async () => {
  const id = await makeDoc(owner.token);
  assert.equal((await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "nobody-yet@markie.test", role: "viewer" })).status, 200);
  assert.equal((await listed(owner.token, id))?.sharedOut, true);
});

test("a public link makes it shared out, and revoking it makes it private again", async () => {
  const id = await makeDoc(owner.token);
  assert.equal((await json("POST", `/api/docs/${id}/public-link`, owner.token, {})).status, 200);
  assert.equal((await listed(owner.token, id))?.sharedOut, true);
  assert.equal((await json("DELETE", `/api/docs/${id}/public-link`, owner.token)).status, 200);
  assert.equal((await listed(owner.token, id))?.sharedOut, false);
});

test("a document shared with me is listed as shared, which is exposure enough", async () => {
  const id = await makeDoc(owner.token);
  await json("POST", `/api/docs/${id}/shares`, owner.token, { email: "member@markie.test", role: "editor" });
  const row = await listed(member.token, id);
  assert.equal(row?.shared, true);
});
