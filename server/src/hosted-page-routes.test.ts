// Who is sent on to the web app from /d/:id, who keeps the static page, and
// what the bar links to, with the web app present and absent. The access
// rules themselves are doc-view.test.ts's; this file asserts only that the
// web app changes nothing about who reads, and where a reader lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-hosted-routes-"));
const webDist = join(dir, "web-dist");
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-hosted-routes-test-secret-32-plus";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_WEB_DIST = webDist;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

const { docs } = await import("./docs.ts");
const { shares, ensureShareToken } = await import("./shares.ts");
const { docView } = await import("./doc-view.ts");
const { publicShare } = await import("./public.ts");
const { webAppAvailable } = await import("./web-app.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/", docView);
app.route("/", publicShare);

const ORIGIN = { Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" };
const stamp = Date.now();
const BODY = "hosted-routes-secret-line";

function webApp(on: boolean) {
  if (on) {
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, "index.html"), "<!doctype html>");
  } else {
    rmSync(join(webDist, "index.html"), { force: true });
  }
  assert.equal(webAppAvailable(), on);
}

async function json<T>(method: string, path: string, token?: string, body?: unknown) {
  const headers = new Headers({ "Content-Type": "application/json", ...ORIGIN });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

async function page(path: string, bearer?: string) {
  const headers = new Headers(ORIGIN);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  const res = await app.request(path, { headers });
  return { status: res.status, body: await res.text(), location: res.headers.get("location"), headers: res.headers };
}

async function makeDoc(token: string, docId: string) {
  const content = `# Hosted\n\n${BODY}\n`;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await json("PUT", `/api/docs/${docId}`, token, { name: "hosted.md", content, hash, baseVersion: 0 });
  assert.equal(res.status, 200);
}

async function share(ownerToken: string, docId: string, email: string, role: "viewer" | "editor") {
  const res = await json<{ userId?: string; status: string }>("POST", `/api/docs/${docId}/shares`, ownerToken, { email, role });
  assert.equal(res.status, 200);
  return res.data;
}

const appHrefs = (body: string) =>
  [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => h === "/app" || h.startsWith("/app/"));

const owner = await signUpVerified(app, { name: "Owner", email: `hr.owner.${stamp}@test.local` });
const viewer = await signUpVerified(app, { name: "Viewer", email: `hr.viewer.${stamp}@test.local` });
const stranger = await signUpVerified(app, { name: "Stranger", email: `hr.stranger.${stamp}@test.local` });
const docId = `hr-doc-${stamp}`;
await makeDoc(owner.token, docId);
const viewerShare = await share(owner.token, docId, viewer.email, "viewer");

test("a signed-in reader is sent on to the document in the web app", async () => {
  webApp(true);
  for (const who of [owner, viewer]) {
    const res = await page(`/d/${docId}`, who.token);
    assert.equal(res.status, 302);
    assert.equal(res.location, `/app/d/${docId}`);
    assert.ok(!res.body.includes(BODY));
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
});

test("a member's ?k= token is not carried on to the web app", async () => {
  webApp(true);
  const token = ensureShareToken(docId, viewerShare?.userId as string);
  const res = await page(`/d/${docId}?k=${encodeURIComponent(token as string)}`, viewer.token);
  assert.equal(res.status, 302);
  assert.equal(res.location, `/app/d/${docId}`);
});

test("?view=1 keeps the static page, with the editor link for an editor only", async () => {
  webApp(true);
  const mine = await page(`/d/${docId}?view=1`, owner.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.includes(BODY));
  assert.deepEqual(appHrefs(mine.body), ["/app", "/app/new", `/app/d/${docId}`]);
  assert.match(mine.body, new RegExp(`Signed in as </span>hr\\.owner\\.${stamp}@test\\.local`));

  const theirs = await page(`/d/${docId}?view=1`, viewer.token);
  assert.equal(theirs.status, 200);
  assert.deepEqual(appHrefs(theirs.body), ["/app", "/app/new"]);
});

test("nobody who cannot read is sent to the web app", async () => {
  webApp(true);
  // Nobody signed in, no token: the access page, as before.
  const anon = await page(`/d/${docId}`);
  assert.equal(anon.status, 403);
  // A member's emailed link with nobody signed in: to sign in, not the app.
  const token = ensureShareToken(docId, viewerShare?.userId as string) as string;
  const forwarded = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(forwarded.status, 302);
  assert.match(forwarded.location ?? "", /\/auth\/web-signin\?next=/);
  // An open invite's holder keeps the invite page.
  const invited = await share(owner.token, docId, `hr.nobody.${stamp}@test.local`, "viewer");
  assert.equal(invited?.status, "invited");
  // Signed in as someone it was not shared with.
  const wrong = await page(`/d/${docId}`, stranger.token);
  assert.equal(wrong.status, 403);
  // Signed in, document does not exist.
  const missing = await page(`/d/hr-missing-${stamp}`, owner.token);
  assert.equal(missing.status, 403);
  for (const res of [anon, forwarded, wrong, missing]) {
    assert.ok(!(res.location ?? "").includes("/app"), "never toward the web app");
    assert.ok(!res.body.includes(BODY));
  }
});

test("an invite holder keeps the invite page", async () => {
  webApp(true);
  const docId2 = `hr-invite-${stamp}`;
  await makeDoc(owner.token, docId2);
  await share(owner.token, docId2, `hr.pending.${stamp}@test.local`, "editor");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(process.env.DB_PATH as string);
  const row = db.prepare("SELECT token FROM pending_shares WHERE doc_id = ?").get(docId2) as { token: string };
  db.close();
  const res = await page(`/d/${docId2}?k=${encodeURIComponent(row.token)}`);
  assert.equal(res.status, 401);
  assert.match(res.body, /Sign in to open this document/);
  assert.equal(res.location, null);
});

test("without the web app a reader gets the static page and no /app links", async () => {
  webApp(false);
  const res = await page(`/d/${docId}`, owner.token);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(BODY));
  assert.deepEqual(appHrefs(res.body), []);
  assert.match(res.body, />Open in Markie</);
});

test("a public link page stays a page and its bar follows the reader's account", async () => {
  const made = await json<{ url: string }>("POST", `/api/docs/${docId}/public-link`, owner.token);
  assert.equal(made.status, 200);
  const token = (made.data?.url ?? "").split("/s/")[1];
  assert.ok(token);

  webApp(true);
  const anon = await page(`/s/${token}`);
  assert.equal(anon.status, 200, "a public link never redirects to the web app");
  assert.ok(anon.body.includes(BODY));
  assert.deepEqual(appHrefs(anon.body), ["/app"]);
  assert.match(anon.body, />Sign in</);

  const asOwner = await page(`/s/${token}`, owner.token);
  assert.equal(asOwner.status, 200);
  assert.deepEqual(appHrefs(asOwner.body), ["/app", "/app/new", `/app/d/${docId}`]);

  const asViewer = await page(`/s/${token}`, viewer.token);
  assert.deepEqual(appHrefs(asViewer.body), ["/app", "/app/new"], "a viewer is not offered the editor");

  const asStranger = await page(`/s/${token}`, stranger.token);
  assert.deepEqual(appHrefs(asStranger.body), ["/app", "/app/new"]);
  assert.ok(!asStranger.body.includes(docId), "the id is never named to an account that cannot edit it");

  webApp(false);
  const plain = await page(`/s/${token}`, owner.token);
  assert.deepEqual(appHrefs(plain.body), []);
  assert.match(plain.body, />Open in Markie</);
});
