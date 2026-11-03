// The security contract for reading a shared document on the web.
//
// The interesting assertions here are the ones that must FAIL: an emailed
// link with nobody signed in, a link opened by the wrong account, a removed
// member, an invite opened at a different address, and a bare document id. If
// any of those render the document, a Markie document has become readable by
// someone who was not shared it, which is the exact thing this route exists to
// prevent. A ?k= token authorizes nothing: reading is the signed-in account's
// access, every time.
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
const { createWebSignIn, safeNext, renderWebSignInPage } = await import("./web-signin.ts");
app.route("/", createWebSignIn({ authBase: "http://localhost:8787", google: false }));

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
  assert.ok(user.id, `expected a user id for ${email}`);
  return { token: user.token, email, id: user.id };
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

const SIGN_IN = (docId: string) =>
  `http://localhost:8787/auth/web-signin?next=${encodeURIComponent(`/d/${docId}`)}`;

// Every /d/ answer, a refusal or a redirect as much as a page, may be the one
// carrying someone's personal token in its URL.
function assertPrivate(res: { headers: Headers }, label: string) {
  assert.equal(res.headers.get("cache-control"), "private, no-store", `${label}: cache-control`);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", `${label}: referrer-policy`);
}

// A refusal carries none of the document: not its text, not its name.
function assertNothingOfTheDoc(body: string, label: string) {
  assert.ok(!body.includes(SECRET_LINE), `${label}: must not carry the document body`);
  assert.ok(!body.includes("doc-view.md"), `${label}: must not carry the document name`);
}

function openDb() {
  return import("better-sqlite3").then((m) => new m.default(process.env.DB_PATH as string));
}

async function pendingToken(docId: string, email: string): Promise<string> {
  const db = await openDb();
  const row = db
    .prepare("SELECT token FROM pending_shares WHERE doc_id = ? AND email = ?")
    .get(docId, email) as { token: string } | undefined;
  db.close();
  assert.ok(row?.token, "a pending invite has a token in pending_shares");
  return row.token;
}

async function inviteAndToken(ownerToken: string, docId: string, email: string, role: "viewer" | "editor" = "viewer") {
  const invited = await jsonRequest<{ status: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    ownerToken,
    { email, role }
  );
  assert.equal(invited.data?.status, "invited");
  return pendingToken(docId, email);
}

async function shareWith(ownerToken: string, docId: string, email: string, role: "viewer" | "editor" = "viewer") {
  const share = await jsonRequest<{ userId: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    ownerToken,
    { email, role }
  );
  assert.equal(share.status, 200);
  return share.data?.userId as string;
}

test("a member's link alone sends the browser to sign in and carries nothing of the document", async () => {
  const owner = await signUp("Owner", `dv.owner.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.bob.${stamp}@test.local`);
  const docId = `dv-member-${stamp}`;
  await createDoc(owner.token, docId);
  const bobId = await shareWith(owner.token, docId, bob.email);

  // The invite email carries exactly this token.
  const token = ensureShareToken(docId, bobId);
  assert.ok(token && token.length >= 32);

  // The phone reads the caller's role here to decide whether to offer Edit.
  const ownerRead = await jsonRequest<{ doc: { role: string } }>("GET", `/api/docs/${docId}`, owner.token);
  assert.equal(ownerRead.data?.doc.role, "owner");
  const bobRead = await jsonRequest<{ doc: { role: string } }>("GET", `/api/docs/${docId}`, bob.token);
  assert.equal(bobRead.data?.doc.role, "viewer");

  // A forwarded email is exactly this request: the token, and nobody signed in.
  const forwarded = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(forwarded.status, 302);
  assert.equal(forwarded.headers.get("location"), SIGN_IN(docId));
  assert.ok(!(forwarded.headers.get("location") ?? "").includes(token), "the token is not carried on to sign-in");
  assertNothingOfTheDoc(forwarded.body, "member link, no session");
  assertPrivate(forwarded, "member link redirect");

  const raw = await page(`/d/${docId}/raw?k=${encodeURIComponent(token)}`);
  assert.equal(raw.status, 401);
  assertNothingOfTheDoc(raw.body, "raw, member link, no session");
  assertPrivate(raw, "raw 401");
  assert.equal(raw.headers.get("content-disposition"), null);
});

test("a member's link opens for that member's session, and stops the moment they are removed", async () => {
  const owner = await signUp("Owner", `dv.mown.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.mbob.${stamp}@test.local`);
  const docId = `dv-member-session-${stamp}`;
  await createDoc(owner.token, docId);
  const bobId = await shareWith(owner.token, docId, bob.email);
  const token = ensureShareToken(docId, bobId);

  const ok = await page(`/d/${docId}?k=${encodeURIComponent(token)}`, bob.token);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes(SECRET_LINE), "member should see the document body");
  assertPrivate(ok, "member page");

  const withoutToken = await page(`/d/${docId}`, bob.token);
  assert.equal(withoutToken.status, 200, "the session is the access; the token adds nothing");

  const removed = await jsonRequest("DELETE", `/api/docs/${docId}/shares/${bobId}`, owner.token);
  assert.equal(removed.status, 200);

  // Still signed in, still holding the link, no longer a member.
  const after = await page(`/d/${docId}?k=${encodeURIComponent(token)}`, bob.token);
  assert.equal(after.status, 403);
  assertNothingOfTheDoc(after.body, "removed member, session");
  assert.ok(!after.body.includes(owner.email), "the refusal names no other member");
  assertPrivate(after, "removed member 403");
  for (const path of [`/d/${docId}/raw`, `/d/${docId}/assets?ref=a.png`]) {
    const res = await page(`${path}${path.includes("?") ? "&" : "?"}k=${encodeURIComponent(token)}`, bob.token);
    assert.equal(res.status, 403, path);
    assertNothingOfTheDoc(res.body, `removed member, ${path}`);
  }

  // Signed out, the dead token is a stranger's request: not even a redirect.
  const signedOut = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(signedOut.status, 403);
  assertNothingOfTheDoc(signedOut.body, "removed member, no session");
});

test("a member's link opened by another account that has no access gets a 403 naming only who is signed in", async () => {
  const owner = await signUp("Owner", `dv.wown.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.wbob.${stamp}@test.local`);
  const mallory = await signUp("Mallory", `dv.wmal.${stamp}@test.local`);
  const docId = `dv-wrong-${stamp}`;
  await createDoc(owner.token, docId);
  const bobId = await shareWith(owner.token, docId, bob.email);
  const token = ensureShareToken(docId, bobId);

  const res = await page(`/d/${docId}?k=${encodeURIComponent(token)}`, mallory.token);
  assert.equal(res.status, 403);
  assertNothingOfTheDoc(res.body, "wrong account");
  assert.ok(!res.body.includes(bob.email), "must not name the member the link belongs to");
  assert.ok(!res.body.includes(owner.email), "must not name the owner");
  assert.ok(res.body.includes(mallory.email), "says who is signed in");
  assert.ok(
    res.body.includes(`${SIGN_IN(docId)}&amp;switch=1`),
    "offers to sign in as a different account, past the signed-in forward"
  );
  assertPrivate(res, "wrong account 403");

  const raw = await page(`/d/${docId}/raw?k=${encodeURIComponent(token)}`, mallory.token);
  assert.equal(raw.status, 403);
  assertNothingOfTheDoc(raw.body, "wrong account raw");

  // The same refusal for an id that does not exist, so a signed-in account
  // cannot use this route to find out which ids are real.
  const missing = await page(`/d/dv-wrong-missing-${stamp}`, mallory.token);
  assert.equal(missing.status, 403);
  const withoutNext = (body: string) => body.replace(/next=[^"&]*/g, "next=");
  assert.equal(withoutNext(missing.body), withoutNext(res.body));
});

// A token is not a key to anything, so a token for one document does not even
// earn a redirect on another. Bob is a member of both on purpose.
test("a token for one document does nothing for another, even one its owner may read", async () => {
  const owner = await signUp("Owner", `dv.cross.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.crossbob.${stamp}@test.local`);
  const first = `dv-first-${stamp}`;
  const second = `dv-second-${stamp}`;
  await createDoc(owner.token, first);
  await createDoc(owner.token, second);
  const bobId = await shareWith(owner.token, first, bob.email);
  await shareWith(owner.token, second, bob.email);
  const tokenForFirst = ensureShareToken(first, bobId);

  // Sanity: Bob genuinely has access to the second document.
  const bobSignedIn = await page(`/d/${second}`, bob.token);
  assert.equal(bobSignedIn.status, 200);

  const crossed = await page(`/d/${second}?k=${encodeURIComponent(tokenForFirst)}`);
  assert.equal(crossed.status, 403);
  assert.ok(!crossed.body.includes(SECRET_LINE));
});

test("a pending invite's link shows the invite page and no content; withdrawing it closes even that", async () => {
  const owner = await signUp("Owner", `dv.pown.${stamp}@test.local`);
  const docId = `dv-pending-${stamp}`;
  const invitee = `dv.pending.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  const token = await inviteAndToken(owner.token, docId, invitee, "editor");
  const { pendingForToken } = await import("./pending.ts");
  assert.equal(pendingForToken(token)?.docId, docId);

  const invite = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(invite.status, 401);
  assert.ok(!invite.body.includes(SECRET_LINE), "the invite page carries no content");
  assert.ok(invite.body.includes(invitee), "names the address the invite was sent to");
  assert.ok(invite.body.includes(SIGN_IN(docId).replace(/&/g, "&amp;")), "links to the web sign-in");
  // The name is already in the invite email's subject, so it may appear.
  assert.ok(invite.body.includes("doc-view.md"));
  assert.ok(!invite.body.includes("edit it with them"), "nothing of the document page, editor invite or not");
  assertPrivate(invite, "invite page");

  for (const path of [`/d/${docId}/raw`, `/d/${docId}/assets?ref=a.png`]) {
    const res = await page(`${path}${path.includes("?") ? "&" : "?"}k=${encodeURIComponent(token)}`);
    assert.equal(res.status, 401, path);
    assertNothingOfTheDoc(res.body, `pending token, ${path}`);
    assertPrivate(res, path);
  }

  const withdrawn = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(invitee)}`,
    owner.token
  );
  assert.equal(withdrawn.status, 200);

  const after = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(after.status, 403);
  assertNothingOfTheDoc(after.body, "withdrawn invite");
  assert.ok(!after.body.includes(invitee), "a withdrawn invite names no address");
});

test("a verified account at the invited address claims the invite through the link and reads it", async () => {
  const owner = await signUp("Owner", `dv.claimown.${stamp}@test.local`);
  const docId = `dv-claim-${stamp}`;
  const invitee = `dv.claim.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  const token = await inviteAndToken(owner.token, docId, invitee, "editor");

  // Proving the address alone claims nothing here: signUpVerified marks the
  // row verified directly, which runs no claim hook.
  const joined = await signUp("Claimer", invitee);

  const opened = await page(`/d/${docId}?k=${encodeURIComponent(token)}`, joined.token);
  assert.equal(opened.status, 200);
  assert.ok(opened.body.includes(SECRET_LINE));
  assert.ok(opened.body.includes("edit it with them"), "an editor invite becomes editor access");

  const db = await openDb();
  const share = db.prepare("SELECT role FROM shares WHERE doc_id = ? AND user_id = ?").get(docId, joined.id) as { role: string } | undefined;
  const stillPending = db.prepare("SELECT 1 FROM pending_shares WHERE doc_id = ?").get(docId);
  db.close();
  assert.equal(share?.role, "editor", "the invite became a real share");
  assert.equal(stillPending, undefined, "and is no longer an invite");

  for (const path of [`/d/${docId}/raw`]) {
    const res = await page(`${path}?k=${encodeURIComponent(token)}`, joined.token);
    assert.equal(res.status, 200, path);
    assert.ok(res.body.includes(SECRET_LINE));
  }

  // The link in the already-sent email now names a member, and still opens
  // nothing on its own.
  const signedOut = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.headers.get("location"), SIGN_IN(docId));
  assertNothingOfTheDoc(signedOut.body, "claimed token, no session");
});

// Signing in on the web lands on /d/<id> with no token at all, so the claim
// has to happen from the session alone.
test("a verified account at the invited address claims on a bare /d/ visit, as after signing in", async () => {
  const owner = await signUp("Owner", `dv.bareclaimown.${stamp}@test.local`);
  const docId = `dv-bareclaim-${stamp}`;
  const invitee = `dv.bareclaim.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  await inviteAndToken(owner.token, docId, invitee);
  const joined = await signUp("Claimer", invitee);

  const opened = await page(`/d/${docId}`, joined.token);
  assert.equal(opened.status, 200);
  assert.ok(opened.body.includes(SECRET_LINE));
  assert.ok(opened.body.includes("You have view access"));
});

test("an invite opened by a verified account at a different address is refused and stays an invite", async () => {
  const owner = await signUp("Owner", `dv.mmown.${stamp}@test.local`);
  const mallory = await signUp("Mallory", `dv.mmmal.${stamp}@test.local`);
  const docId = `dv-mismatch-${stamp}`;
  const invitee = `dv.mismatch.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  const token = await inviteAndToken(owner.token, docId, invitee);

  const res = await page(`/d/${docId}?k=${encodeURIComponent(token)}`, mallory.token);
  assert.equal(res.status, 403);
  assertNothingOfTheDoc(res.body, "mismatched address");
  assert.ok(res.body.includes(mallory.email), "says who is signed in");
  assert.ok(res.body.includes(invitee), "and which address the invite needs");
  assertPrivate(res, "mismatch 403");

  for (const path of [`/d/${docId}/raw`, `/d/${docId}/assets?ref=a.png`]) {
    const r = await page(`${path}${path.includes("?") ? "&" : "?"}k=${encodeURIComponent(token)}`, mallory.token);
    assert.equal(r.status, 403, path);
    assertNothingOfTheDoc(r.body, `mismatch ${path}`);
  }

  const db = await openDb();
  const share = db.prepare("SELECT 1 FROM shares WHERE doc_id = ? AND user_id = ?").get(docId, mallory.id);
  const pending = db.prepare("SELECT email FROM pending_shares WHERE doc_id = ?").all(docId) as Array<{ email: string }>;
  db.close();
  assert.equal(share, undefined, "a forwarded invite claims nothing for whoever opens it");
  assert.deepEqual(pending.map((p) => p.email), [invitee], "the invite still waits for its address");
});

test("a bare document id gives an access page that names nothing", async () => {
  const owner = await signUp("Owner", `dv.bare.${stamp}@test.local`);
  const docId = `dv-bare-${stamp}`;
  await createDoc(owner.token, docId);

  const bare = await page(`/d/${docId}`);
  assert.equal(bare.status, 403);
  assertNothingOfTheDoc(bare.body, "bare id");
  assertPrivate(bare, "bare id");

  // A document that does not exist is indistinguishable from one you cannot
  // read, so the route cannot be used to enumerate ids.
  const missing = await page(`/d/does-not-exist-${stamp}`);
  assert.equal(missing.status, 403);
  // The only difference is the id the browser itself asked for, echoed in the
  // sign-in link.
  const withoutNext = (body: string) => body.replace(/next=[^"&]*/g, "next=");
  assert.equal(withoutNext(missing.body), withoutNext(bare.body));
  assert.ok(bare.body.includes(SIGN_IN(docId)));

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
  assertNothingOfTheDoc(theirs.body, "stranger");
});

test("the raw download enforces the same access as the page", async () => {
  const owner = await signUp("Owner", `dv.rawown.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.rawbob.${stamp}@test.local`);
  const stranger = await signUp("Stranger", `dv.rawstr.${stamp}@test.local`);
  const docId = `dv-raw-${stamp}`;
  await createDoc(owner.token, docId);
  const token = ensureShareToken(docId, await shareWith(owner.token, docId, bob.email));

  const linkOnly = await page(`/d/${docId}/raw?k=${encodeURIComponent(token)}`);
  assert.equal(linkOnly.status, 401);
  assertNothingOfTheDoc(linkOnly.body, "raw, link only");

  const ok = await page(`/d/${docId}/raw?k=${encodeURIComponent(token)}`, bob.token);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes(SECRET_LINE));
  assert.match(ok.headers.get("content-disposition") ?? "", /doc-view\.md/);
  assertPrivate(ok, "raw 200");

  const theirs = await page(`/d/${docId}/raw`, stranger.token);
  assert.equal(theirs.status, 403);
  assertNothingOfTheDoc(theirs.body, "raw, stranger");

  const bare = await page(`/d/${docId}/raw`);
  assert.equal(bare.status, 403);
  assertNothingOfTheDoc(bare.body, "raw, bare");
  assertPrivate(bare, "raw bare");
});

test("the same token is returned on repeat, so a document has one link per person", async () => {
  const owner = await signUp("Owner", `dv.stable.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.stablebob.${stamp}@test.local`);
  const docId = `dv-stable-${stamp}`;
  await createDoc(owner.token, docId);
  const bobId = await shareWith(owner.token, docId, bob.email);

  assert.equal(ensureShareToken(docId, bobId), ensureShareToken(docId, bobId));
});

// ---------------------------------------------------------------------------
// An invite's token, and the email-verification gate.
//
// Every route that turns a pending invite into a share requires proof of the
// address (auth.ts, docs.ts, and the claim here). The token is not that proof:
// email is forwarded. So the token on its own reads nothing and creates
// nothing, whoever holds it and whatever account exists at the address.
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

test("an emailed invite token reads nothing and mints nothing for anyone", async () => {
  const owner = await signUp("Owner", `dv.tokown.${stamp}@test.local`);
  const docId = `dv-token-${stamp}`;
  const invitee = `dv.token.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  const token = await inviteAndToken(owner.token, docId, invitee);

  const res = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(res.status, 401);
  assert.ok(!res.body.includes(SECRET_LINE), "the invite page carries no content");

  const db = await openDb();
  const user = db.prepare("SELECT id FROM user WHERE email = ?").get(invitee);
  const share = db.prepare("SELECT * FROM shares WHERE doc_id = ?").all(docId) as unknown[];
  const pending = db.prepare("SELECT email FROM pending_shares WHERE doc_id = ?").all(docId) as Array<{ email: string }>;
  db.close();
  assert.equal(user, undefined, "viewing must not create an account");
  assert.deepEqual(share, [], "viewing must not create a share row");
  assert.deepEqual(pending.map((p) => p.email), [invitee], "the invite is still an invite, not a membership");
});

test("withdrawing the invite takes the address off its link, account or no account", async () => {
  const owner = await signUp("Owner", `dv.withown.${stamp}@test.local`);
  const docId = `dv-withdraw-${stamp}`;
  const invitee = `dv.withdraw.${stamp}@test.local`;
  await createDoc(owner.token, docId);
  const token = await inviteAndToken(owner.token, docId, invitee);

  // An unverified account now exists at the address. It changes nothing: the
  // link still shows the invite page and nothing more.
  await signUpUnverified("Not Proven", invitee);
  const before = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(before.status, 401);
  assert.ok(!before.body.includes(SECRET_LINE));

  const withdrawn = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(invitee)}`,
    owner.token
  );
  assert.equal(withdrawn.status, 200);

  const after = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(after.status, 403, "the withdrawn invite is a stranger's link");
  assertNothingOfTheDoc(after.body, "withdrawn, unverified account");
});

test("an unverified account at the invited address gains nothing from the token", async () => {
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

  const viaToken = await page(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(viaToken.status, 401);
  assert.ok(!viaToken.body.includes(SECRET_LINE));

  const db = await openDb();
  const userId = (db.prepare("SELECT id FROM user WHERE email = ?").get(invitee) as { id: string }).id;
  const share = db.prepare("SELECT * FROM shares WHERE doc_id = ? AND user_id = ?").get(docId, userId);
  const stillPending = db.prepare("SELECT role FROM pending_shares WHERE doc_id = ? AND email = ?").get(docId, invitee);
  db.close();
  assert.equal(share, undefined, "the token must not convert the invite into a share");
  assert.ok(stillPending, "the invite is still waiting for proof of the address");
});

// ---------------------------------------------------------------------------
// Cloud assets: the page rewrites a media src to the document's own asset
// route only for a ref the document actually links. The asset is read with the
// same session as the page, so the src never carries a link token.
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

test("a reader's asset src never carries the link token, and the asset itself needs the session", async () => {
  const owner = await signUp("Owner", `dv.assetk.${stamp}@test.local`);
  const bob = await signUp("Bob", `dv.assetkbob.${stamp}@test.local`);
  const stranger = await signUp("Stranger", `dv.assetkstr.${stamp}@test.local`);
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
  const token = ensureShareToken(docId, await shareWith(owner.token, docId, bob.email));

  const view = await page(`/d/${docId}?k=${encodeURIComponent(token)}`, bob.token);
  assert.equal(view.status, 200);
  // hast-util-to-html writes the & in an attribute as &#x26;.
  assert.match(view.body, new RegExp(`src="/d/${docId}/assets\\?ref=a\\.png&#x26;v=${assetHash.slice(0, 16)}"`));
  assert.ok(!view.body.includes(token), "the token appears nowhere on the page");

  const asset = `/d/${docId}/assets?ref=a.png`;
  const linkOnly = await page(`${asset}&k=${encodeURIComponent(token)}`);
  assert.equal(linkOnly.status, 401);
  assert.ok(!linkOnly.body.includes(`asset-bytes-a.png-${stamp}`));
  assertPrivate(linkOnly, "asset 401");

  const asBob = await page(asset, bob.token);
  assert.equal(asBob.status, 200);
  assert.equal(asBob.body, `asset-bytes-a.png-${stamp}`);
  // A served asset keeps its own private, hour-long caching, which the ?v= in
  // its URL is there for. Private still keeps it out of shared caches.
  assert.equal(asBob.headers.get("cache-control"), "private, max-age=3600");

  const asStranger = await page(`${asset}&k=${encodeURIComponent(token)}`, stranger.token);
  assert.equal(asStranger.status, 403);
  assert.ok(!asStranger.body.includes(`asset-bytes-a.png-${stamp}`));
  assertPrivate(asStranger, "asset 403");

  const bare = await page(asset);
  assert.equal(bare.status, 404);
  assertPrivate(bare, "asset bare");
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
  const bobId = await shareWith(owner.token, sourceId, bob.email);

  // Bob may read the source but not the target: muted, with no target named.
  let view = await page(`/d/${sourceId}`, bob.token);
  assert.equal(view.status, 200);
  assert.match(view.body, /<a class="doc-link-muted" title="This document isn(?:'|&#x27;)t shared with you\.">the plan<\/a>/);
  assert.ok(!view.body.includes(targetId), "the muted page must not name the target");

  // Bob's link, opened in Bob's browser, answers the same: links follow the
  // session, not the token.
  const token = ensureShareToken(sourceId, bobId);
  view = await page(`/d/${sourceId}?k=${encodeURIComponent(token)}`, bob.token);
  assert.match(view.body, /<a class="doc-link-muted" title="This document isn(?:'|&#x27;)t shared with you\.">the plan<\/a>/);

  // Once the target is shared with Bob the link opens.
  await shareWith(owner.token, targetId, bob.email);
  view = await page(`/d/${sourceId}`, bob.token);
  assert.match(view.body, new RegExp(`<a href="/d/${targetId}">the plan</a>`));

  // The owner always may.
  view = await page(`/d/${sourceId}`, owner.token);
  assert.match(view.body, new RegExp(`<a href="/d/${targetId}">the plan</a>`));
});

test("a pending invite's link shows none of the document's links", async () => {
  const owner = await signUp("Owner", `dl2.owner.${stamp}@test.local`);
  const sourceId = `dl2-source-${stamp}`;
  const targetId = `dl2-target-${stamp}`;
  await createDoc(owner.token, sourceId);
  await createDoc(owner.token, targetId);
  const withLink = "# Source\n\n[the plan](plan.md)\n";
  const hash = createHash("sha256").update(withLink, "utf8").digest("hex");
  await jsonRequest("PUT", `/api/docs/${sourceId}`, owner.token, { name: "source.md", content: withLink, hash, baseVersion: 1 });
  await jsonRequest("PUT", `/api/docs/${sourceId}/links`, owner.token, { links: [{ ref: "plan.md", target: targetId }] });
  const token = await inviteAndToken(owner.token, sourceId, `dl2.nobody.${stamp}@test.local`);

  const view = await page(`/d/${sourceId}?k=${encodeURIComponent(token)}`);
  assert.equal(view.status, 401);
  assert.ok(!view.body.includes("the plan"));
  assert.ok(!view.body.includes(targetId));
});

test("web sign-in only ever sends a browser on to a /d/ page on this server", async () => {
  assert.equal(safeNext("/d/abc-123_X"), "/d/abc-123_X");
  for (const bad of ["https://evil.test/d/x", "//evil.test/d/x", "/d/x/../../admin", "/d/", "/s/token", "/d/a b", "/d/" + "a".repeat(129), undefined, null]) {
    assert.equal(safeNext(bad as string), "/", String(bad));
  }
  const res = await page(`/auth/web-signin?next=${encodeURIComponent("https://evil.test")}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('var next = "/";'));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const ok = await page(`/auth/web-signin?next=${encodeURIComponent("/d/doc-1")}`);
  assert.ok(ok.body.includes('var next = "/d/doc-1";'));
  assert.ok(!ok.body.includes("Continue with Google"), "no Google button when Google is not configured");
  assert.ok(renderWebSignInPage({ next: "/d/x", google: true, failed: true }).includes("/auth/web-google?next=%2Fd%2Fx"));
});

test("a browser signed in with an emailed code gets a session cookie that opens the owner's private page", async () => {
  const owner = await signUp("Owner", `dv.cookie.${stamp}@test.local`);
  const docId = `dv-cookie-${stamp}`;
  await createDoc(owner.token, docId);
  // The web page's code form posts here; a password sign-in sets the same
  // better-auth session cookie and needs no mailbox in a test.
  const signedIn = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1", ...ORIGIN }),
    body: JSON.stringify({ email: `dv.cookie.${stamp}@test.local`, password: "password-123" }),
  });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.ok(cookie.includes("session_token"));
  const res = await app.request(`/d/${docId}`, { headers: new Headers({ cookie, "x-forwarded-for": "127.0.0.1" }) });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes(SECRET_LINE));
});

// /d/ sends every reader who arrives without this origin's cookie to the web
// sign-in, including ones already signed in here, because the emailed link is
// on the website's origin. Those go straight back; only the "different
// account" link and a failed attempt stop at the form.
test("web sign-in sends an already signed-in browser straight back to the document", async () => {
  const bob = await signUp("Bob", `dv.fwd.${stamp}@test.local`);
  const owner = await signUp("Owner", `dv.fwdown.${stamp}@test.local`);
  const docId = `dv-fwd-${stamp}`;
  await createDoc(owner.token, docId);
  const token = ensureShareToken(docId, await shareWith(owner.token, docId, bob.email));
  const signedIn = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1", ...ORIGIN }),
    body: JSON.stringify({ email: bob.email, password: "password-123" }),
  });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const asBrowser = (path: string) =>
    app.request(path, { headers: new Headers({ cookie, "x-forwarded-for": "127.0.0.1" }) });

  // The emailed link, opened in the browser that holds Bob's cookie.
  const opened = await asBrowser(`/d/${docId}?k=${encodeURIComponent(token)}`);
  assert.equal(opened.status, 200);
  assert.ok((await opened.text()).includes(SECRET_LINE));

  const next = encodeURIComponent(`/d/${docId}`);
  const forwarded = await asBrowser(`/auth/web-signin?next=${next}`);
  assert.equal(forwarded.status, 302);
  assert.equal(forwarded.headers.get("location"), `/d/${docId}`);
  assert.equal(forwarded.headers.get("cache-control"), "private, no-store");

  for (const stay of [`/auth/web-signin?next=${next}&switch=1`, `/auth/web-signin?next=${next}&error=1`, `/auth/web-signin?next=${encodeURIComponent("https://evil.test")}`]) {
    const res = await asBrowser(stay);
    assert.equal(res.status, 200, stay);
    assert.ok((await res.text()).includes('id="send"'), `${stay} shows the form`);
  }

  // Signed out, the page is the form whatever next is.
  const signedOut = await page(`/auth/web-signin?next=${next}`);
  assert.equal(signedOut.status, 200);
});

