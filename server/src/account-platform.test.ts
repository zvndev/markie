import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-account-platform-")), "test.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "account-platform-synthetic-test-secret-32-plus";
process.env.MARKIE_ACCOUNT_IDENTITIES = "1";
process.env.MARKIE_NO_LISTEN = "1";
process.env.RESEND_API_KEY = "synthetic-mail-key-not-a-credential";
process.env.GOOGLE_CLIENT_ID = "synthetic-client-id";
process.env.GOOGLE_CLIENT_SECRET = "synthetic-client-secret";
const sent: { email: string; code: string }[] = [];
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://api.resend.com/emails", "No real network request is allowed");
  const body = JSON.parse(String(init?.body)) as { to: string[]; text: string };
  sent.push({ email: body.to[0], code: body.text.match(/\b\d{6}\b/)?.[0] ?? "" });
  return Response.json({ id: "synthetic-message" });
};
const { auth } = await import("./auth.ts");
await (await getMigrations(auth.options)).runMigrations();
const { app } = await import("./index.ts");
const { openDatabase } = await import("./db.ts");
const db = openDatabase();
let sequence = 0;
async function request(path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  sequence++;
  return app.request(path, { method, headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": `10.88.0.${sequence}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function proof(token: string, scope: string) {
  const start = await request("/api/account/identities/step-up/start", token, { scope }); assert.equal(start.status, 200);
  const { challengeId } = await start.json();
  const verified = await request("/api/account/identities/step-up/verify", token, { challengeId, code: sent.at(-1)!.code }); assert.equal(verified.status, 200);
  return (await verified.json()).proofId as string;
}
async function addAlias(token: string, email: string) {
  const started = await request("/api/account/identities/email/start", token, { email, proofId: await proof(token, "email-add") });
  assert.equal(started.status, 200);
  const { challengeId } = await started.json();
  const verified = await request("/api/account/identities/email/verify", token, { challengeId, code: sent.at(-1)!.code });
  assert.equal(verified.status, 200);
  return (await verified.json()).identity as { id: string; email: string };
}
async function provider(uid: string) {
  const { accountContext } = await import("./account-context.ts");
  const google = accountContext()?.google; assert.ok(google);
  const context = await auth.$context;
  let id = "";
  await google.runAuthRequest(new Request(`http://localhost:8787/api/auth/callback/google?state=synthetic-fixture-${randomUUID()}`), async () => {
    // Privileged synthetic fixture creation follows the real hooks/SQL trigger;
    // it never disables those guards or inserts directly into account.
    google.noteCreatedUser(uid);
    const account = await context.internalAdapter.createAccount({ userId: uid, providerId: "google", issuer: "https://accounts.google.com", accountId: `synthetic-google-sub-${randomUUID()}` });
    assert.ok(account); id = account.id;
    return Response.json({ ok: true });
  });
  return id;
}
async function googleFlow(owner: { token: string }) {
  const started = await request("/api/account/identities/google/start", owner.token, { proofId: await proof(owner.token, "google-link") });
  assert.equal(started.status, 200);
  const { intentId, browserUrl } = await started.json();
  const secret = new URL(browserUrl).hash.slice(1).split(".")[1];
  const response = await app.request("/api/account/identities/google/browser-start", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8787" }, body: JSON.stringify({ intentId, secret }),
  });
  assert.equal(response.status, 200);
  const data = await response.json() as { url: string }, url = new URL(data.url), state = url.searchParams.get("state");
  assert.equal(url.origin, "https://accounts.google.com"); assert.ok(state);
  const { accountContext } = await import("./account-context.ts");
  const google = accountContext()?.google; assert.ok(google);
  return { google, response, intentId, url, state };
}

test("real composition links mailbox, claims canonical shares, signs into canonical UID, and revokes only alias sessions", async () => {
  const owner = await signUpVerified(app, { name: "Original account", email: "primary@example.test" });
  const cap = await request("/api/account/capabilities"); assert.equal((await cap.json()).verifiedIdentities, true);
  const identities = await request("/api/account/identities", owner.token); assert.equal((await identities.json()).googleAvailable, true);
  const start = await request("/api/account/identities/email/start", owner.token, { email: "second@example.test", proofId: await proof(owner.token, "email-add") }); assert.equal(start.status, 200);
  const { challengeId } = await start.json();
  const verified = await request("/api/account/identities/email/verify", owner.token, { challengeId, code: sent.at(-1)!.code }); assert.equal(verified.status, 200);
  const { identity } = await verified.json();
  assert.equal((await request("/api/auth/sign-up/email", undefined, { email: identity.email, password: "password-123", name: "Wrong account" })).status, 403);
  assert.equal((await request("/api/auth/sign-in/email-otp", undefined, { email: identity.email, otp: "000000" })).status, 403);
  assert.equal((await request("/api/auth/link-social", owner.token, { provider: "google" })).status, 403);
  assert.equal((await request("/api/auth/unlink-account", owner.token, { providerId: "google" })).status, 403);
  const aliasStart = await request("/api/account/identities/sign-in/start", undefined, { email: identity.email });
  const flow = await aliasStart.json();
  const alias = await request("/api/account/identities/sign-in/verify", undefined, { ...flow, expiresInSeconds: undefined, code: sent.at(-1)!.code });
  assert.equal(alias.status, 200); const { token } = await alias.json();
  assert.equal((await (await request("/api/me", token)).json()).user.id, owner.id);
  const areas = (await (await request("/api/account/cloud-areas", owner.token)).json()).areas;
  assert.ok(areas.some((area: { identityId?: string }) => area.identityId === identity.id));
  const removed = await request(`/api/account/identities/${identity.id}`, owner.token, { proofId: await proof(owner.token, "email-remove") }, "DELETE"); assert.equal(removed.status, 200);
  assert.equal((await (await request("/api/me", token)).json()).user, null);
  assert.equal((await (await request("/api/me", owner.token)).json()).user.id, owner.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "user"').get().n, 1);
});

test("new verification mail fails closed without logging when delivery is unavailable", async () => {
  const owner = await signUpVerified(app, { name: "Mail check", email: "mail-check@example.test" });
  const previous = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  const originalLog = console.log; let logs = 0; console.log = () => { logs++; };
  try { const response = await request("/api/account/identities/step-up/start", owner.token, { scope: "email-add" }); assert.equal(response.status, 503); assert.equal(logs, 0); }
  finally { console.log = originalLog; process.env.RESEND_API_KEY = previous; }
});

test("the legacy primary-email OTP route retains canonical UID and password login with identities enabled", async () => {
  const owner = await signUpVerified(app, { name: "Primary parity", email: "primary-parity@example.test" });
  const count = db.prepare('SELECT COUNT(*) AS n FROM "user"').get();
  const sentCode = await request("/api/auth/email-otp/send-verification-otp", undefined, { email: owner.email, type: "sign-in" });
  assert.equal(sentCode.status, 200);
  const signed = await request("/api/auth/sign-in/email-otp", undefined, { email: owner.email, otp: sent.at(-1)!.code });
  assert.equal(signed.status, 200);
  const token = signed.headers.get("set-auth-token"); assert.ok(token);
  assert.equal((await (await request("/api/me", token)).json()).user.id, owner.id);
  assert.equal((await request("/api/auth/sign-in/email", undefined, { email: owner.email, password: "password-123" })).status, 200);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM "user"').get(), count);
  assert.equal((db.prepare('SELECT email FROM "user" WHERE id=?').get(owner.id) as { email: string }).email, owner.email);
});

test("a pending alias invitation is claimed through real verification routes without a second user or ACL upgrade", async () => {
  const sender = await signUpVerified(app, { name: "Document owner", email: "pending-owner@example.test" });
  const recipient = await signUpVerified(app, { name: "Canonical recipient", email: "pending-primary@example.test" });
  const docId = randomUUID(), content = "# Synthetic private document\n";
  assert.equal((await request(`/api/docs/${docId}`, sender.token, { name: "Alias invitation.md", content, hash: createHash("sha256").update(content).digest("hex"), baseVersion: 0 }, "PUT")).status, 200);
  const alias = "pending-alias@example.test";
  const invitation = await request(`/api/docs/${docId}/shares`, sender.token, { email: alias, role: "viewer" });
  assert.equal(invitation.status, 200); assert.equal((await invitation.json()).status, "invited");
  assert.equal((await request(`/api/docs/${docId}`, recipient.token)).status, 404);
  assert.ok(db.prepare("SELECT 1 FROM pending_shares WHERE doc_id=? AND email=?").get(docId, alias));
  const before = db.prepare('SELECT COUNT(*) AS n FROM "user"').get();
  const identity = await addAlias(recipient.token, alias);
  assert.equal(identity.email, alias);
  assert.equal(db.prepare("SELECT 1 FROM pending_shares WHERE doc_id=? AND email=?").get(docId, alias), undefined);
  assert.deepEqual(db.prepare("SELECT user_id,role FROM shares WHERE doc_id=?").all(docId), [{ user_id: recipient.id, role: "viewer" }]);
  assert.equal((await request(`/api/docs/${docId}`, recipient.token)).status, 200);
  assert.equal((await request(`/api/docs/${docId}`, recipient.token, { name: "Denied edit", content: "not allowed", hash: "denied", baseVersion: 1 }, "PUT")).status, 403);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM "user"').get(), before);
  assert.equal((await request(`/api/account/identities/${identity.id}`, recipient.token, { proofId: await proof(recipient.token, "email-remove") }, "DELETE")).status, 200);
  assert.equal((await request(`/api/docs/${docId}`, recipient.token)).status, 200, "Unlink does not remove canonical document ACL");
});

test("different existing verified or unverified primary addresses cannot become aliases", async () => {
  const owner = await signUpVerified(app, { name: "Collision owner", email: "collision-owner@example.test" });
  const separate = await signUpVerified(app, { name: "Separate account", email: "collision-existing@example.test" });
  const unverifiedEmail = "collision-unverified@example.test";
  assert.equal((await request("/api/auth/sign-up/email", undefined, { name: "Unverified separate account", email: unverifiedEmail, password: "password-123" })).status, 200);
  const before = db.prepare('SELECT id,email,emailVerified FROM "user" ORDER BY id').all();
  for (const email of [separate.email, unverifiedEmail]) {
    const response = await request("/api/account/identities/email/start", owner.token, { email, proofId: await proof(owner.token, "email-add") });
    assert.equal(response.status, 409); assert.equal((await response.json()).error, "identity-conflict");
  }
  assert.deepEqual(db.prepare('SELECT id,email,emailVerified FROM "user" ORDER BY id').all(), before);
  assert.deepEqual((await (await request("/api/account/identities", owner.token)).json()).identities.map((identity: { email: string }) => identity.email), [owner.email]);
});

test("Google unlink rejects the link scope and foreign provider owner then revokes every canonical session on valid removal", async () => {
  const owner = await signUpVerified(app, { name: "Google owner", email: "google-removal-owner@example.test" });
  const other = await signUpVerified(app, { name: "Other Google owner", email: "google-removal-other@example.test" });
  const ownProvider = await provider(owner.id), foreignProvider = await provider(other.id);
  const wrongScope = await proof(owner.token, "google-link");
  assert.equal((await request(`/api/account/identities/google-provider/${ownProvider}`, owner.token, { proofId: wrongScope }, "DELETE")).status, 400);
  assert.ok(db.prepare("SELECT 1 FROM account WHERE id=? AND userId=?").get(ownProvider, owner.id));
  const removalProof = await proof(owner.token, "google-remove");
  assert.equal((await request(`/api/account/identities/google-provider/${foreignProvider}`, owner.token, { proofId: removalProof }, "DELETE")).status, 400);
  assert.ok(db.prepare("SELECT 1 FROM account WHERE id=? AND userId=?").get(foreignProvider, other.id));
  const secondSignIn = await request("/api/auth/sign-in/email", undefined, { email: owner.email, password: "password-123" });
  assert.equal(secondSignIn.status, 200); const secondToken = secondSignIn.headers.get("set-auth-token"); assert.ok(secondToken);
  const response = await request(`/api/account/identities/google-provider/${ownProvider}`, owner.token, { proofId: removalProof }, "DELETE");
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, signedOut: true });
  assert.deepEqual(db.prepare("SELECT id FROM session WHERE userId=?").all(owner.id), []);
  for (const token of [owner.token, secondToken]) assert.equal((await (await request("/api/me", token)).json()).user, null);
  assert.equal((await (await request("/api/me", other.token)).json()).user.id, other.id);
  assert.ok(db.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='credential'").get(owner.id), "Primary password factor survives Google removal");
  assert.equal((await request("/api/auth/sign-in/email", undefined, { email: owner.email, password: "password-123" })).status, 200);
});

test("a revoked initiating session cannot spend its Google-removal proof or delete the provider", async () => {
  const owner = await signUpVerified(app, { name: "Stale Google session", email: "google-stale-session@example.test" });
  const id = await provider(owner.id), proofId = await proof(owner.token, "google-remove");
  const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${owner.token}` }) });
  assert.ok(session); db.prepare("DELETE FROM session WHERE id=?").run(session.session.id);
  assert.equal((await request(`/api/account/identities/google-provider/${id}`, owner.token, { proofId }, "DELETE")).status, 401);
  assert.ok(db.prepare("SELECT 1 FROM account WHERE id=? AND userId=?").get(id, owner.id));
});

test("composition bounds identity and provider-removal bodies before sending codes or changing factors", async () => {
  const owner = await signUpVerified(app, { name: "Bounded bodies", email: "bounded-account-bodies@example.test" });
  const id = await provider(owner.id), before = sent.length;
  const identityBody = await request("/api/account/identities/step-up/start", owner.token, { scope: "x".repeat(4100) });
  assert.equal(identityBody.status, 400); assert.equal(sent.length, before);
  const providerBody = await request(`/api/account/identities/google-provider/${id}`, owner.token, { proofId: "x".repeat(1100) }, "DELETE");
  assert.equal(providerBody.status, 413); assert.ok(db.prepare("SELECT 1 FROM account WHERE id=?").get(id));
  const authBody = await request("/api/auth/sign-up/email", undefined, { email: "x".repeat(5000), password: "password-123", name: "Not created" });
  assert.equal(authBody.status, 413);
});

test("configured SQLite guards close user-insert and user-email-update races against active verified aliases", async () => {
  const owner = await signUpVerified(app, { name: "Trigger owner", email: "trigger-owner@example.test" });
  const other = await signUpVerified(app, { name: "Trigger outsider", email: "trigger-other@example.test" });
  const identity = await addAlias(owner.token, "trigger-alias@example.test");
  const before = db.prepare('SELECT id,email,emailVerified FROM "user" ORDER BY id').all();
  const timestamp = new Date().toISOString();
  assert.throws(() => db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), "Rejected concurrent signup", ` ${identity.email.toUpperCase()} `, 0, timestamp, timestamp), /identity-conflict/);
  assert.throws(() => db.prepare('UPDATE "user" SET email=? WHERE id=?').run(identity.email.toUpperCase(), other.id), /identity-conflict/);
  assert.deepEqual(db.prepare('SELECT id,email,emailVerified FROM "user" ORDER BY id').all(), before);
  assert.equal((await (await request("/api/me", owner.token)).json()).user.id, owner.id);
  assert.equal((await (await request("/api/me", other.token)).json()).user.id, other.id);
});

test("a primary signup committed after alias challenge issuance still prevents alias ownership at consume", async () => {
  const owner = await signUpVerified(app, { name: "Late collision owner", email: "late-collision-owner@example.test" });
  const target = "late-primary-race@example.test";
  const started = await request("/api/account/identities/email/start", owner.token, { email: target, proofId: await proof(owner.token, "email-add") });
  assert.equal(started.status, 200); const { challengeId } = await started.json(), code = sent.at(-1)!.code;
  const created = await request("/api/auth/sign-up/email", undefined, { name: "Separate unverified owner", email: target, password: "password-123" });
  assert.equal(created.status, 200);
  const separate = (await created.json()).user;
  assert.notEqual(separate.id, owner.id);
  const verified = await request("/api/account/identities/email/verify", owner.token, { challengeId, code });
  assert.equal(verified.status, 409); assert.equal((await verified.json()).error, "identity-conflict");
  assert.equal(db.prepare("SELECT 1 FROM account_emails WHERE email_norm=? AND revoked_at IS NULL").get(target), undefined);
  assert.equal((db.prepare('SELECT email FROM "user" WHERE id=?').get(owner.id) as { email: string }).email, owner.email);
  assert.equal((db.prepare('SELECT email FROM "user" WHERE id=?').get(separate.id) as { email: string }).email, target);
});

test("real Google browser-start uses root's actual adapter offline without transplanting the primary session", async () => {
  const owner = await signUpVerified(app, { name: "Actual Google browser adapter", email: "google-real-browser-adapter@example.test" });
  const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${owner.token}` }) }); assert.ok(session);
  const before = db.prepare('SELECT id,email,emailVerified FROM "user" ORDER BY id').all();
  const flow = await googleFlow(owner), cookies = flow.response.headers.getSetCookie();
  assert.ok(cookies.length >= 1); assert.equal(flow.url.searchParams.getAll("state").length, 1);
  assert.ok(!cookies.join(";").includes(owner.token)); assert.ok(!cookies.join(";").includes(session.session.token));
  assert.ok(cookies.every((cookie) => !/better-auth\.session_token=/.test(cookie)));
  assert.equal((await (await request("/api/me", owner.token)).json()).user.id, owner.id);
  assert.deepEqual(db.prepare('SELECT id,email,emailVerified FROM "user" ORDER BY id').all(), before);
  assert.equal(db.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='google'").get(owner.id), undefined);
});

test("actual Better Auth CREATE rejects Google provider insertion when session is revoked after the before-hook authorization", async () => {
  const owner = await signUpVerified(app, { name: "Actual adapter race", email: "google-real-adapter-race@example.test" });
  const context = await auth.$context;
  const beforeUser = db.prepare('SELECT id,email,emailVerified FROM "user" WHERE id=?').get(owner.id);
  // Positive control traverses the real hooks and SQLite fence with a live initiator.
  const positive = await googleFlow(owner), positiveSubject = `synthetic-positive-${randomUUID()}`;
  await positive.google.runAuthRequest(new Request(`http://localhost:8787/api/auth/callback/google?state=${encodeURIComponent(positive.state)}`), async () => {
    const created = await context.internalAdapter.createAccount({ userId: owner.id, providerId: "google", issuer: "https://accounts.google.com", accountId: positiveSubject });
    assert.ok(created); assert.ok(db.prepare("SELECT 1 FROM account WHERE id=? AND userId=?").get(created.id, owner.id));
    return Response.json({ ok: true });
  });
  const flow = await googleFlow(owner), subject = `synthetic-revoked-${randomUUID()}`;
  const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${owner.token}` }) }); assert.ok(session);
  const hooks = auth.options.databaseHooks!.account!.create!, original = hooks.before!;
  let reached!: () => void, resume!: () => void;
  const authorized = new Promise<void>((resolve) => { reached = resolve; }), paused = new Promise<void>((resolve) => { resume = resolve; });
  let assignedId = "", beforePassed = false, pauseTimeout: ReturnType<typeof setTimeout> | undefined;
  hooks.before = async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (args[0].providerId === "google" && args[0].accountId === subject) {
      beforePassed = true;
      assert.ok(result && typeof result === "object" && "data" in result && result.data?.id);
      assignedId = result.data.id;
      reached(); await paused;
    }
    return result; // Preserve the root's server-assigned account ID, never bypass its fence.
  };
  try {
    const creation = flow.google.runAuthRequest(new Request(`http://localhost:8787/api/auth/callback/google?state=${encodeURIComponent(flow.state)}`), async () => {
      await context.internalAdapter.createAccount({ userId: owner.id, providerId: "google", issuer: "https://accounts.google.com", accountId: subject });
      return Response.json({ ok: true });
    });
    const rejected = assert.rejects(creation);
    await Promise.race([authorized, new Promise<never>((_resolve, reject) => { pauseTimeout = setTimeout(() => reject(new Error("Actual adapter did not reach the authorized write boundary")), 5000); })]);
    clearTimeout(pauseTimeout);
    assert.equal(beforePassed, true); assert.ok(assignedId);
    assert.ok(db.prepare("SELECT 1 FROM account_google_link_writes WHERE account_id=?").get(assignedId));
    db.prepare("DELETE FROM session WHERE id=?").run(session.session.id);
    resume(); await rejected;
    assert.equal(db.prepare("SELECT 1 FROM account WHERE accountId=?").get(subject), undefined);
    assert.ok(db.prepare("SELECT 1 FROM account WHERE accountId=? AND userId=?").get(positiveSubject, owner.id));
    assert.deepEqual(db.prepare('SELECT id,email,emailVerified FROM "user" WHERE id=?').get(owner.id), beforeUser);
    assert.ok(db.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='credential'").get(owner.id));
    assert.ok(db.prepare("SELECT 1 FROM account_google_link_writes WHERE account_id=?").get(assignedId), "Failed authorization marker is retained rather than turning into an unmarked signup");
  } finally { clearTimeout(pauseTimeout); resume(); hooks.before = original; }
});
