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
import { signUpVerified } from "./test-users.ts";

const dvDir = mkdtempSync(join(tmpdir(), "markie-doc-view-"));
process.env.DB_PATH = join(dvDir, "t.db");
process.env.ASSETS_DIR = join(dvDir, "store");
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
const { assetsApi } = await import("./assets.ts");
const { docLinksApi } = await import("./doc-links.ts");
const { docView } = await import("./doc-view.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api", assetsApi);
app.route("/api", docLinksApi);
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

// Accounts must prove their address before they can sign in, so the shared
// helper does the signup, the proof, and the sign-in. It also spreads callers
// across addresses: these tests need far more accounts than the auth rate
// limiter allows from a single one, and throttling is the behaviour under test
// everywhere except here.
async function signUp(name: string, email: string) {
  const user = await signUpVerified(app, { name, email });
  return { token: user.token, email };
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

// Uploads one small PNG under the owner's account and links it to the
// document under the given ref, the same two-step handshake the app does.
async function uploadAndLinkAsset(token: string, docId: string, ref: string) {
  const bytes = Buffer.from(`asset-bytes-${ref}-${stamp}`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const uploaded = await app.request(`/api/assets/${hash}`, {
    method: "PUT",
    headers: new Headers({
      Authorization: `Bearer ${token}`,
      "x-forwarded-for": "127.0.0.1",
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length),
      ...ORIGIN,
    }),
    body: new Blob([bytes]),
  });
  assert.equal(uploaded.status, 200);
  const linked = await jsonRequest("PUT", `/api/docs/${docId}/assets`, token, {
    refs: [{ ref, hash }],
  });
  assert.equal(linked.status, 200);
  return hash;
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

  // Making an account and proving the address claims the invite, which moves
  // the token onto the share row. Signing up alone no longer does it, which is
  // the whole point of the verification gate.
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

// ---------------------------------------------------------------------------
// Why the emailed-token path survives the email-verification change.
//
// Every other route that acts on a pending invite is now gated on proof of
// email ownership (auth.ts, docs.ts). This one is deliberately not, and these
// cases are the reason it is safe: the token was mailed to the invited address
// and nowhere else, so holding it is evidence of receiving mail there. It
// grants one read of one document and never creates anything account-bound,
// which is what keeps it from becoming a way around the gate.
// ---------------------------------------------------------------------------

// A signup that stops at signup: no proof of the address, so no session.
async function signUpUnverified(name: string, email: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: new Headers({
      "Content-Type": "application/json",
      "x-forwarded-for": `10.4.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      ...ORIGIN,
    }),
    body: JSON.stringify({ name, email, password: "password-123" }),
  });
  assert.equal(res.status, 200);
  return { sessionToken: res.headers.get("set-auth-token") };
}

async function inviteAndToken(ownerToken: string, docId: string, email: string) {
  const invited = await jsonRequest<{ status: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    ownerToken,
    { email, role: "viewer" }
  );
  assert.equal(invited.data?.status, "invited");
  const db = new (await import("better-sqlite3")).default(process.env.DB_PATH as string);
  const row = db
    .prepare("SELECT token FROM pending_shares WHERE doc_id = ? AND email = ?")
    .get(docId, email) as { token: string };
  assert.ok(row?.token);
  return row.token;
}

test("an emailed invite token opens the doc without minting an account for anyone", async () => {
  const owner = await signUp("Owner", `dv.tokown.${stamp}@test.local`);
  const docId = `dv-token-${stamp}`;
  const invitee = `dv.token.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  const token = await inviteAndToken(owner.token, docId, invitee);

  const ok = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes(SECRET_LINE), "the invited reader sees the document");

  // Reading it must leave no trace that could be mistaken for membership.
  const db = new (await import("better-sqlite3")).default(process.env.DB_PATH as string);
  const user = db.prepare("SELECT id FROM user WHERE email = ?").get(invitee);
  assert.equal(user, undefined, "viewing must not create an account");
  const share = db
    .prepare("SELECT * FROM shares WHERE doc_id = ?")
    .all(docId) as unknown[];
  assert.deepEqual(share, [], "viewing must not create a share row");
  const pending = db
    .prepare("SELECT email FROM pending_shares WHERE doc_id = ?")
    .all(docId) as Array<{ email: string }>;
  assert.deepEqual(
    pending.map((p) => p.email),
    [invitee],
    "the invite is still an invite, not a membership"
  );
});

test("withdrawing the invite kills the token immediately, account or no account", async () => {
  const owner = await signUp("Owner", `dv.withown.${stamp}@test.local`);
  const docId = `dv-withdraw-${stamp}`;
  const invitee = `dv.withdraw.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  const token = await inviteAndToken(owner.token, docId, invitee);

  // An unverified account now exists at the address. It changes nothing about
  // the token: the pending row is still the only authorization, so withdrawing
  // it is still the whole revocation.
  await signUpUnverified("Not Proven", invitee);
  const before = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(before.status, 200);

  const withdrawn = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(invitee)}`,
    owner.token
  );
  assert.equal(withdrawn.status, 200);

  const after = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(after.status, 403, "the withdrawn invite must stop opening the doc");
  assert.ok(!after.body.includes(SECRET_LINE));
});

test("an unverified account at the invited address gains nothing extra from the token", async () => {
  const owner = await signUp("Owner", `dv.unvown.${stamp}@test.local`);
  const docId = `dv-unverified-${stamp}`;
  const invitee = `dv.unverified.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  const token = await inviteAndToken(owner.token, docId, invitee);

  const { sessionToken } = await signUpUnverified("Unproven", invitee);
  assert.equal(
    sessionToken,
    null,
    "an unproven address gets no session, so there is nothing to list with"
  );

  // The token grants the read it always granted, and only that.
  const viaToken = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(viaToken.status, 200);

  const db = new (await import("better-sqlite3")).default(process.env.DB_PATH as string);
  const userId = (
    db.prepare("SELECT id FROM user WHERE email = ?").get(invitee) as { id: string }
  ).id;
  const share = db
    .prepare("SELECT * FROM shares WHERE doc_id = ? AND user_id = ?")
    .get(docId, userId);
  assert.equal(
    share,
    undefined,
    "reading through the token must not convert the invite into a share"
  );
  const stillPending = db
    .prepare("SELECT role FROM pending_shares WHERE doc_id = ? AND email = ?")
    .get(docId, invitee);
  assert.ok(stillPending, "the invite is still waiting for proof of the address");
});

// ---------------------------------------------------------------------------
// Cloud assets: the page rewrites a media src to the document's own asset
// route only for a ref the document actually links, and carries the reader's
// own ?k= token along for the ride so the rewritten URL stays theirs to use.
// ---------------------------------------------------------------------------

test("a linked asset renders through the doc's asset route, an unlinked ref does not", async () => {
  const owner = await signUp("Owner", `dv.asset.${stamp}@test.local`);
  const docId = `dv-asset-${stamp}`;
  const content = "![a](a.png)\n\n![b](b.png)\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const created = await jsonRequest("PUT", `/api/docs/${docId}`, owner.token, {
    name: "assets.md",
    content,
    hash,
    baseVersion: 0,
  });
  assert.equal(created.status, 200);
  const assetHash = await uploadAndLinkAsset(owner.token, docId, "a.png");

  const view = await page(`/d/${docId}`, owner.token);
  assert.equal(view.status, 200);
  // The hash rides along in ?v= so that relinking the ref changes the URL:
  // the response is fresh for an hour, and an ETag cannot revalidate what a
  // browser never asks about.
  assert.match(view.body, new RegExp(`src="/d/${docId}/assets\\?ref=a\\.png&#x26;v=${assetHash.slice(0, 16)}"`));
  // b.png was never linked, so the document's own text passes through as
  // written: nothing here fetches an asset that does not exist.
  assert.match(view.body, /src="b\.png"/);
});

test("a reader's rewritten asset src carries their own ?k= token", async () => {
  const owner = await signUp("Owner", `dv.assetk.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.assetkbob.${stamp}@test.local`);
  const docId = `dv-asset-k-${stamp}`;
  const content = "![a](a.png)\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const created = await jsonRequest("PUT", `/api/docs/${docId}`, owner.token, {
    name: "assets.md",
    content,
    hash,
    baseVersion: 0,
  });
  assert.equal(created.status, 200);
  const assetHash = await uploadAndLinkAsset(owner.token, docId, "a.png");

  const share = await jsonRequest<{ userId: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: bob.email, role: "viewer" }
  );
  const token = ensureShareToken(docId, share.data?.userId as string);

  const view = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(view.status, 200);
  // The HTML serializer entity-encodes the & in an attribute value
  // (hast-util-to-html writes it as &#x26;), which a browser decodes back to
  // a literal & when it parses the attribute; the query string still reaches
  // the server as ref=a.png&k=<token>.
  assert.match(
    view.body,
    new RegExp(`src="/d/${docId}/assets\\?ref=a\\.png&#x26;k=${token}&#x26;v=${assetHash.slice(0, 16)}"`)
  );
});

test("a document link on the shared page opens for a member who may read the target and is muted for one who may not", async () => {
  const owner = await signUp("Owner", `dl.owner.${stamp}@test.local`);
  const bob = await signUp("Bob", `dl.bob.${stamp}@test.local`);
  const sourceId = `dl-source-${stamp}`;
  const targetId = `dl-target-${stamp}`;
  await createDoc(owner.token, sourceId);
  await createDoc(owner.token, targetId);
  const withLink = "# Source\n\n[the plan](plan.md)\n";
  const hash = createHash("sha256").update(withLink, "utf8").digest("hex");
  const put = await jsonRequest<{ version: number }>("PUT", `/api/docs/${sourceId}`, owner.token, { name: "source.md", content: withLink, hash, baseVersion: 1 });
  assert.equal(put.status, 200);
  const linked = await jsonRequest("PUT", `/api/docs/${sourceId}/links`, owner.token, { links: [{ ref: "plan.md", target: targetId }] });
  assert.equal(linked.status, 200);

  const share = await jsonRequest<{ userId: string }>("POST", `/api/docs/${sourceId}/shares`, owner.token, { email: bob.email, role: "viewer" });
  assert.equal(share.status, 200);
  const bobId = share.data?.userId as string;

  // Bob may read the source but not the target: muted, with no target named.
  let view = await page(`/d/${sourceId}`, bob.token);
  assert.equal(view.status, 200);
  assert.match(view.body, /<a class="doc-link-muted" title="This document isn(?:'|&#x27;)t shared with you\.">the plan<\/a>/);
  assert.ok(!view.body.includes(targetId), "the muted page must not name the target");

  // Through Bob's personal token the answer is the same: it maps to Bob.
  const token = ensureShareToken(sourceId, bobId);
  view = await page(`/d/${sourceId}?k=${encodeURIComponent(token)}`);
  assert.match(view.body, /<a class="doc-link-muted" title="This document isn(?:'|&#x27;)t shared with you\.">the plan<\/a>/);

  // Once the target is shared with Bob the link opens.
  const shareTarget = await jsonRequest("POST", `/api/docs/${targetId}/shares`, owner.token, { email: bob.email, role: "viewer" });
  assert.equal(shareTarget.status, 200);
  view = await page(`/d/${sourceId}`, bob.token);
  assert.match(view.body, new RegExp(`<a href="/d/${targetId}">the plan</a>`));
  view = await page(`/d/${sourceId}?k=${encodeURIComponent(token)}`);
  assert.match(view.body, new RegExp(`<a href="/d/${targetId}">the plan</a>`));

  // The owner always may.
  view = await page(`/d/${sourceId}`, owner.token);
  assert.match(view.body, new RegExp(`<a href="/d/${targetId}">the plan</a>`));
});

test("a pending invite's link shows every document link muted", async () => {
  const owner = await signUp("Owner", `dl2.owner.${stamp}@test.local`);
  const sourceId = `dl2-source-${stamp}`;
  const targetId = `dl2-target-${stamp}`;
  await createDoc(owner.token, sourceId);
  await createDoc(owner.token, targetId);
  const withLink = "# Source\n\n[the plan](plan.md)\n";
  const hash = createHash("sha256").update(withLink, "utf8").digest("hex");
  await jsonRequest("PUT", `/api/docs/${sourceId}`, owner.token, { name: "source.md", content: withLink, hash, baseVersion: 1 });
  await jsonRequest("PUT", `/api/docs/${sourceId}/links`, owner.token, { links: [{ ref: "plan.md", target: targetId }] });
  const invitee = `dl2.nobody.${stamp}@test.local`;
  const invite = await jsonRequest<{ status: string }>("POST", `/api/docs/${sourceId}/shares`, owner.token, { email: invitee, role: "viewer" });
  assert.equal(invite.status, 200);
  assert.equal(invite.data?.status, "invited");
  // The POST response never carries the pending invite's token (see
  // shares.ts); doc-view.test.ts's own pending-invite test above reads it
  // straight off the pending_shares row, so this does the same.
  const db = new (await import("better-sqlite3")).default(process.env.DB_PATH as string);
  const row = db
    .prepare("SELECT token FROM pending_shares WHERE doc_id = ? AND email = ?")
    .get(sourceId, invitee) as { token: string };
  const pendingToken = row?.token;
  assert.ok(pendingToken, "a pending invite has a token in pending_shares");
  const view = await page(`/d/${sourceId}?k=${encodeURIComponent(pendingToken)}`);
  assert.equal(view.status, 200);
  assert.match(view.body, /<a class="doc-link-muted" title="This document isn(?:'|&#x27;)t shared with you\.">the plan<\/a>/);
  assert.ok(!view.body.includes(`/d/${targetId}`));
  assert.ok(!view.body.includes(`href="/d/${targetId}"`));
});
