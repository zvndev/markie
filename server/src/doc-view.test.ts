// The security contract for reading a shared document on the web.
//
// The interesting assertions here are the ones that must FAIL: a token from
// another document, a token whose owner was removed, a withdrawn invite, and a
// bare document id. If any of those render the document, a Markie document has
// become readable by someone who was not shared it, which is the exact thing
// this route exists to prevent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-doc-view-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-doc-view-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares, ensureShareToken } = await import("./shares.ts");
const { docView } = await import("./doc-view.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/", docView);

const ORIGIN = { Origin: "http://localhost:3000" };
const stamp = Date.now();
const SECRET_LINE = "the-secret-body-line";

async function jsonRequest<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T | null }> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
    ...ORIGIN,
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

async function page(path: string, bearer?: string) {
  const headers = new Headers({ "x-forwarded-for": "127.0.0.1", ...ORIGIN });
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  const res = await app.request(path, { headers });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

// Each signup comes from its own address. These tests need far more accounts
// than the auth rate limiter allows from a single one, and throttling is the
// behaviour under test everywhere except here.
let signUpCount = 0;
async function signUp(name: string, email: string) {
  signUpCount += 1;
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": `10.0.${Math.floor(signUpCount / 250)}.${signUpCount % 250}`,
    ...ORIGIN,
  });
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, email, password: "password-123" }),
  });
  assert.equal(res.status, 200);
  const token = res.headers.get("set-auth-token");
  assert.ok(token);
  return { token, email };
}

async function createDoc(token: string, docId: string) {
  const content = `# Doc view\n\n${SECRET_LINE}\n`;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await jsonRequest("PUT", `/api/docs/${docId}`, token, {
    name: "doc-view.md",
    content,
    hash,
    baseVersion: 0,
  });
  assert.equal(res.status, 200);
}

test("a member's link opens the document, and stops the moment they are removed", async () => {
  const owner = await signUp("Owner", `dv.owner.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.bob.${stamp}@test.local`);
  const docId = `dv-member-${stamp}`;
  await createDoc(owner.token, docId);

  const share = await jsonRequest<{ userId: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: bob.email, role: "viewer" }
  );
  assert.equal(share.status, 200);
  const bobId = share.data?.userId as string;

  // The invite email carries exactly this token.
  const token = ensureShareToken(docId, bobId);
  assert.ok(token && token.length >= 32);

  const ok = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes(SECRET_LINE), "member should see the document body");
  // A personal URL must not be stored by shared caches.
  assert.match(ok.headers.get("cache-control") ?? "", /no-store/);

  // Revoking access revokes the link, with nothing else to revoke.
  const removed = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${bobId}`,
    owner.token
  );
  assert.equal(removed.status, 200);

  const after = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(after.status, 403);
  assert.ok(!after.body.includes(SECRET_LINE), "removed member must not see the body");
});

// A link is a key to one document, not to its holder's account. Bob is a
// member of both documents here on purpose: if the token were treated merely as
// proof of "you are Bob", the second request would succeed, because Bob really
// can read that document. It must still be refused, so that forwarding one
// email hands over one document rather than everything Bob has access to.
test("a token for one document cannot open another, even one its owner may read", async () => {
  const owner = await signUp("Owner", `dv.cross.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.crossbob.${stamp}@test.local`);
  const first = `dv-first-${stamp}`;
  const second = `dv-second-${stamp}`;
  await createDoc(owner.token, first);
  await createDoc(owner.token, second);

  const shareFirst = await jsonRequest<{ userId: string }>(
    "POST",
    `/api/docs/${first}/shares`,
    owner.token,
    { email: bob.email, role: "viewer" }
  );
  const bobId = shareFirst.data?.userId as string;
  await jsonRequest("POST", `/api/docs/${second}/shares`, owner.token, {
    email: bob.email,
    role: "viewer",
  });

  const tokenForFirst = ensureShareToken(first, bobId);

  // Sanity: Bob genuinely has access to the second document.
  const bobSignedIn = await page(`/d/${second}`, bob.token);
  assert.equal(bobSignedIn.status, 200);

  // But the first document's link must not reach it.
  const crossed = await page(`/d/${second}?k=${encodeURIComponent(tokenForFirst)}`);
  assert.equal(
    crossed.status,
    403,
    "a link for one document must not open another, even for a reader entitled to both"
  );
  assert.ok(!crossed.body.includes(SECRET_LINE));
});

test("a pending invite opens, and withdrawing it closes the door", async () => {
  const owner = await signUp("Owner", `dv.pown.${stamp}@test.local`);
  const docId = `dv-pending-${stamp}`;
  const invitee = `dv.pending.${stamp}@test.local`;
  await createDoc(owner.token, docId);

  const invited = await jsonRequest<{ status: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: invitee, role: "viewer" }
  );
  assert.equal(invited.data?.status, "invited");

  const { pendingForToken } = await import("./pending.ts");
  const db = new (await import("better-sqlite3")).default(process.env.DB_PATH as string);
  const row = db
    .prepare("SELECT token FROM pending_shares WHERE doc_id = ? AND email = ?")
    .get(docId, invitee) as { token: string };
  assert.ok(row?.token);
  assert.equal(pendingForToken(row.token)?.docId, docId);

  const ok = await page(`/d/${docId}?k=${encodeURIComponent(row.token)}`);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes(SECRET_LINE));

  const withdrawn = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(invitee)}`,
    owner.token
  );
  assert.equal(withdrawn.status, 200);

  const after = await page(`/d/${docId}?k=${encodeURIComponent(row.token)}`);
  assert.equal(after.status, 403);
  assert.ok(!after.body.includes(SECRET_LINE));
});

test("the emailed link still works after the invitee makes an account", async () => {
  const owner = await signUp("Owner", `dv.claimown.${stamp}@test.local`);
  const docId = `dv-claim-${stamp}`;
  const invitee = `dv.claim.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  await jsonRequest("POST", `/api/docs/${docId}/shares`, owner.token, {
    email: invitee,
    role: "editor",
  });

  const db = new (await import("better-sqlite3")).default(process.env.DB_PATH as string);
  const { token } = db
    .prepare("SELECT token FROM pending_shares WHERE doc_id = ? AND email = ?")
    .get(docId, invitee) as { token: string };

  // Signing up claims the invite, which moves the token onto the share row.
  const joined = await signUp("Claimer", invitee);
  const listed = await jsonRequest("GET", "/api/docs", joined.token);
  assert.equal(listed.status, 200);

  const after = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(
    after.status,
    200,
    "the link in an already-sent email must survive the recipient signing up"
  );
  assert.ok(after.body.includes(SECRET_LINE));
});

test("a bare document id gives an access page that names nothing", async () => {
  const owner = await signUp("Owner", `dv.bare.${stamp}@test.local`);
  const docId = `dv-bare-${stamp}`;
  await createDoc(owner.token, docId);

  const bare = await page(`/d/${docId}`);
  assert.equal(bare.status, 403);
  assert.ok(!bare.body.includes(SECRET_LINE));
  assert.ok(!bare.body.includes("doc-view.md"), "must not leak the document name");

  // A document that does not exist is indistinguishable from one you cannot
  // read, so the route cannot be used to enumerate ids.
  const missing = await page(`/d/does-not-exist-${stamp}`);
  assert.equal(missing.status, 403);
  assert.equal(missing.body.length, bare.body.length);

  const garbage = await page(`/d/${docId}?k=not-a-real-token`);
  assert.equal(garbage.status, 403);
  assert.ok(!garbage.body.includes(SECRET_LINE));
});

test("the owner reads their own document from a signed-in browser, no token needed", async () => {
  const owner = await signUp("Owner", `dv.session.${stamp}@test.local`);
  const stranger = await signUp("Stranger", `dv.stranger.${stamp}@test.local`);
  const docId = `dv-session-${stamp}`;
  await createDoc(owner.token, docId);

  const mine = await page(`/d/${docId}`, owner.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.includes(SECRET_LINE));

  const theirs = await page(`/d/${docId}`, stranger.token);
  assert.equal(theirs.status, 403);
  assert.ok(!theirs.body.includes(SECRET_LINE));
});

test("the raw download enforces the same access as the page", async () => {
  const owner = await signUp("Owner", `dv.rawown.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.rawbob.${stamp}@test.local`);
  const docId = `dv-raw-${stamp}`;
  await createDoc(owner.token, docId);
  const share = await jsonRequest<{ userId: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: bob.email, role: "viewer" }
  );
  const token = ensureShareToken(docId, share.data?.userId as string);

  const ok = await page(`/d/${docId}/raw?k=${encodeURIComponent(token)}`);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes(SECRET_LINE));
  assert.match(ok.headers.get("content-disposition") ?? "", /doc-view\.md/);

  const bare = await page(`/d/${docId}/raw`);
  assert.equal(bare.status, 403);
  assert.ok(!bare.body.includes(SECRET_LINE));
});

test("the same token is returned on repeat, so a document has one link per person", async () => {
  const owner = await signUp("Owner", `dv.stable.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.stablebob.${stamp}@test.local`);
  const docId = `dv-stable-${stamp}`;
  await createDoc(owner.token, docId);
  const share = await jsonRequest<{ userId: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: bob.email, role: "viewer" }
  );
  const bobId = share.data?.userId as string;

  assert.equal(ensureShareToken(docId, bobId), ensureShareToken(docId, bobId));
});
