// The store route keeps pointers; the read route and the page resolvers
// decide per reader. The assertions that matter most are the ones where a
// target must NOT be named: a stranger, a deleted target, an id nobody owns.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-doc-links-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-doc-links-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { docLinksApi, docLinksFor, MAX_DOC_LINKS, sharedPageLinkFor, publicPageLinkFor } = await import("./doc-links.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api", docLinksApi);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function json(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function makeDoc(token: string, content = "# t\n\n[plan](plan.md)\n") {
  const id = crypto.randomUUID();
  const r = await json("PUT", `/api/docs/${id}`, token, { name: "t.md", content, hash: sha(content), baseVersion: 0 });
  assert.equal(r.status, 200);
  return id;
}
async function share(ownerToken: string, docId: string, email: string, role: "viewer" | "editor") {
  const r = await json("POST", `/api/docs/${docId}/shares`, ownerToken, { email, role });
  assert.equal(r.status, 200);
}

const EDITOR_EMAIL = "editor@links.test";
let owner: { token: string; id: string };
let editor: { token: string; id: string };
let stranger: { token: string; id: string };
before(async () => {
  owner = await signUpVerified(app, { name: "Owner", email: "owner@links.test" });
  editor = await signUpVerified(app, { name: "Editor", email: EDITOR_EMAIL });
  stranger = await signUpVerified(app, { name: "Stranger", email: "stranger@links.test" });
});

test("the owner stores pointers and reads them back with targets they can read", async () => {
  const a = await makeDoc(owner.token);
  const b = await makeDoc(owner.token, "# b\n");
  const put = await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "plan.md", target: b }, { ref: "../notes/x.md", target: "nope-never-existed" }] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data, { linked: 2 });
  assert.deepEqual([...docLinksFor(a)], [["plan.md", b], ["../notes/x.md", "nope-never-existed"]]);
  const get = await json("GET", `/api/docs/${a}/links`, owner.token);
  assert.equal(get.status, 200);
  assert.deepEqual(get.data, { links: [{ ref: "plan.md", target: b }, { ref: "../notes/x.md" }] });
});

test("a viewer of the source sees the target only when they may read it too", async () => {
  const a = await makeDoc(owner.token);
  const b = await makeDoc(owner.token, "# b\n");
  await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "plan.md", target: b }] });
  await share(owner.token, a, EDITOR_EMAIL, "viewer");
  let get = await json("GET", `/api/docs/${a}/links`, editor.token);
  assert.deepEqual(get.data, { links: [{ ref: "plan.md" }] });
  await share(owner.token, b, EDITOR_EMAIL, "viewer");
  get = await json("GET", `/api/docs/${a}/links`, editor.token);
  assert.deepEqual(get.data, { links: [{ ref: "plan.md", target: b }] });
});

test("a stranger gets 404 from both routes, and a viewer may not store", async () => {
  const a = await makeDoc(owner.token);
  assert.equal((await json("GET", `/api/docs/${a}/links`, stranger.token)).status, 404);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, stranger.token, { links: [] })).status, 404);
  assert.equal((await json("GET", `/api/docs/never-${Date.now()}/links`, stranger.token)).status, 404);
  await share(owner.token, a, EDITOR_EMAIL, "viewer");
  assert.equal((await json("PUT", `/api/docs/${a}/links`, editor.token, { links: [] })).status, 403);
});

test("an editor may store, and a replaced set drops what the body left out", async () => {
  const a = await makeDoc(owner.token);
  const b = await makeDoc(owner.token, "# b\n");
  await share(owner.token, a, EDITOR_EMAIL, "editor");
  let put = await json("PUT", `/api/docs/${a}/links`, editor.token, { links: [{ ref: "plan.md", target: b }, { ref: "old.md", target: b }] });
  assert.equal(put.status, 200);
  put = await json("PUT", `/api/docs/${a}/links`, editor.token, { links: [{ ref: "plan.md", target: b }] });
  assert.equal(put.status, 200);
  assert.deepEqual([...docLinksFor(a).keys()], ["plan.md"]);
});

test("the body is refused for shape, size, malformed refs, bad ids and duplicates", async () => {
  const a = await makeDoc(owner.token);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, owner.token, { links: "x" })).status, 400);
  const many = Array.from({ length: MAX_DOC_LINKS + 1 }, (_, i) => ({ ref: `d${i}.md`, target: "abc" }));
  const big = await json("PUT", `/api/docs/${a}/links`, owner.token, { links: many });
  assert.equal(big.status, 413);
  assert.equal(big.data.cap, MAX_DOC_LINKS);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "a\u0001.md", target: "abc" }] })).status, 400);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "x".repeat(2049), target: "abc" }] })).status, 400);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "a.md", target: "has space" }] })).status, 400);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "a.md", target: "" }] })).status, 400);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "a.md", target: "abc" }, { ref: "a.md", target: "def" }] })).status, 400);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [], baseVersion: -1 })).status, 400);
  assert.equal((await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [], baseVersion: "1" })).status, 400);
  assert.equal(docLinksFor(a).size, 0);
});

test("a stale baseVersion is refused with the server's version and nothing changes", async () => {
  const a = await makeDoc(owner.token);
  const b = await makeDoc(owner.token, "# b\n");
  const first = await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "plan.md", target: b }], baseVersion: 1 });
  assert.equal(first.status, 200);
  const stale = await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [], baseVersion: 7 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.serverVersion, 1);
  assert.deepEqual([...docLinksFor(a).keys()], ["plan.md"]);
});

test("a deleted target is never named, and deleting a source drops its rows", async () => {
  const a = await makeDoc(owner.token);
  const b = await makeDoc(owner.token, "# b\n");
  await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "plan.md", target: b }] });
  assert.equal((await json("DELETE", `/api/docs/${b}`, owner.token)).status, 200);
  assert.deepEqual((await json("GET", `/api/docs/${a}/links`, owner.token)).data, { links: [{ ref: "plan.md" }] });
  assert.equal((await json("DELETE", `/api/docs/${a}`, owner.token)).status, 200);
  assert.equal(docLinksFor(a).size, 0);
});

test("the page resolvers answer per reader and per public link", async () => {
  const a = await makeDoc(owner.token);
  const b = await makeDoc(owner.token, "# b\n");
  await json("PUT", `/api/docs/${a}/links`, owner.token, { links: [{ ref: "plan.md", target: b }, { ref: "gone.md", target: "never" }] });
  const forOwner = sharedPageLinkFor(a, owner.id);
  assert.deepEqual(forOwner("plan.md"), { href: `/d/${b}` });
  assert.deepEqual(forOwner("gone.md"), { muted: true });
  assert.equal(forOwner("unlinked.md"), null);
  const forStranger = sharedPageLinkFor(a, stranger.id);
  assert.deepEqual(forStranger("plan.md"), { muted: true });
  assert.deepEqual(sharedPageLinkFor(a, null)("plan.md"), { muted: true });
  const pub = publicPageLinkFor(a);
  assert.deepEqual(pub("plan.md"), { muted: true });
  const made = await json("POST", `/api/docs/${b}/public-link`, owner.token);
  assert.equal(made.status, 200);
  const token = String(made.data.url).split("/s/")[1];
  assert.deepEqual(publicPageLinkFor(a)("plan.md"), { href: `/s/${token}` });
  assert.equal(publicPageLinkFor(a)("unlinked.md"), null);
});

// Counts calls to Database.prototype.prepare whose SQL contains `needle`,
// across every handle any module opened (db.ts hands each module its own
// connection to the same file, so this is the only vantage point common to
// all of them). Patched on the shared prototype and restored after.
async function countPrepares<T>(needle: string, run: () => T): Promise<{ result: T; count: number }> {
  const original = Database.prototype.prepare;
  let count = 0;
  Database.prototype.prepare = function (sql: string, ...rest: unknown[]) {
    if (typeof sql === "string" && sql.includes(needle)) count += 1;
    // @ts-expect-error - forwarding to the original with whatever arity better-sqlite3 gives it
    return original.call(this, sql, ...rest);
  };
  try {
    return { result: run(), count };
  } finally {
    Database.prototype.prepare = original;
  }
}

test("the page resolvers look a repeated target up once per page, not once per link to it", async () => {
  const a = await makeDoc(owner.token);
  const b = await makeDoc(owner.token, "# b\n");
  await json("PUT", `/api/docs/${a}/links`, owner.token, {
    links: [{ ref: "plan.md", target: b }, { ref: "plan-again.md", target: b }, { ref: "plan-once-more.md", target: b }],
  });
  const made = await json("POST", `/api/docs/${b}/public-link`, owner.token);
  assert.equal(made.status, 200);
  const token = String(made.data.url).split("/s/")[1];

  const forOwner = sharedPageLinkFor(a, owner.id);
  const { result: sharedAnswers, count: docsLookups } = await countPrepares("FROM docs WHERE id", () => [
    forOwner("plan.md"),
    forOwner("plan-again.md"),
    forOwner("plan-once-more.md"),
  ]);
  assert.deepEqual(sharedAnswers[0], { href: `/d/${b}` });
  assert.deepEqual(sharedAnswers[1], sharedAnswers[0]);
  assert.deepEqual(sharedAnswers[2], sharedAnswers[0]);
  // docExists (SELECT 1 FROM docs...) plus accessLevel's isOwner (SELECT
  // owner_id FROM docs...) run once each for the one distinct target: 2, not
  // 2 per ref (6).
  assert.equal(docsLookups, 2);

  const pub = publicPageLinkFor(a);
  const { result: publicAnswers, count: tokenLookups } = await countPrepares("FROM public_links WHERE doc_id", () => [
    pub("plan.md"),
    pub("plan-again.md"),
    pub("plan-once-more.md"),
  ]);
  assert.deepEqual(publicAnswers[0], { href: `/s/${token}` });
  assert.deepEqual(publicAnswers[1], publicAnswers[0]);
  assert.deepEqual(publicAnswers[2], publicAnswers[0]);
  assert.equal(tokenLookups, 1);
});
