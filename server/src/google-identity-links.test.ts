import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createGoogleIdentityLinks } from "./google-identity-links.ts";

function setup() {
  const db = new Database(":memory:"); let time = Date.now(), calls = 0;
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,token TEXT,expiresAt INTEGER); CREATE TABLE account(id TEXT PRIMARY KEY,userId TEXT,providerId TEXT); INSERT INTO user VALUES('owner','owner@example.test',1),('other','other@example.test',1);`);
  db.prepare("INSERT INTO session VALUES('session','owner','never-client-visible',?)").run(time + 3600_000);
  const actor = { userId: "owner", email: "owner@example.test", emailVerified: true, sessionId: "session" };
  const tokens: string[] = [], callbacks: string[] = []; let oauthUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-google-state", stateCookies = ["better-auth.state=state-binding; Path=/; HttpOnly; Secure"];
  const api = createGoogleIdentityLinks({ db, secret: "test-secret-32-characters-minimum-for-hmac", authOrigin: "https://auth.example.test", now: () => time,
    authenticate: (request) => request.headers.get("authorization") === "Bearer owner" ? actor : null,
    consumeStepUp: (who, proof, scope) => { assert.equal(who, actor); assert.equal(scope, "google-link"); if (proof !== "valid-proof") throw Error("rejected proof"); calls++; },
    beginOAuthLink: async (input) => { tokens.push(input.sessionToken); callbacks.push(input.callbackURL); assert.equal(input.headers.get("cookie"), null); return { url: oauthUrl, stateCookies }; },
  });
  const post = (path: string, data: unknown, auth = true, origin = "https://auth.example.test") => api.app.request(path, { method: "POST", headers: { "content-type": "application/json", origin, ...(auth ? { authorization: "Bearer owner" } : {}) }, body: JSON.stringify(data) });
  async function start() { const response = await post("/identities/google/start", { proofId: "valid-proof" }); assert.equal(response.status, 200); return response.json() as Promise<{ intentId: string; browserUrl: string }>; }
  async function begin() {
    const intent = await start(), secret = new URL(intent.browserUrl).hash.slice(1).split(".")[1];
    const response = await post("/identities/google/browser-start", { intentId: intent.intentId, secret }, false);
    return { ...intent, secret, response };
  }
  return { db, api, post, start, begin, tokens, callbacks, actor, calls: () => calls, advance: (ms: number) => { time += ms; }, changeOAuth: (url: string, cookies = stateCookies) => { oauthUrl = url; stateCookies = cookies; } };
}
test("handoff is fragment-only, hashed at rest and bound to a live verified primary session", async () => {
  const t = setup(); try {
    const intent = await t.start(), url = new URL(intent.browserUrl);
    assert.equal(url.pathname, "/account/link-google"); assert.equal(url.search, ""); assert.equal(t.calls(), 1);
    const secret = url.hash.split(".")[1], row = t.db.prepare("SELECT * FROM account_google_link_intents").get() as Record<string, unknown>;
    assert.equal(JSON.stringify(row).includes(secret), false); assert.equal(row.user_id, "owner");
    assert.equal((await t.post("/identities/google/start", { proofId: "valid-proof" }, false)).status, 401);
    t.db.prepare("DELETE FROM session").run();
    assert.equal((await t.post("/identities/google/browser-start", { intentId: intent.intentId, secret }, false)).status, 400);
  } finally { t.db.close(); }
});
test("browser start is one-use, exact-origin and never exposes/transplants the primary session", async () => {
  const t = setup(); try {
    const result = await t.begin(); assert.equal(result.response.status, 200);
    assert.deepEqual(await result.response.json(), { url: "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-google-state" });
    assert.deepEqual(t.tokens, ["never-client-visible"]); assert.equal(t.callbacks[0], `https://auth.example.test/account/google-link/complete?intentId=${result.intentId}`);
    const cookies = result.response.headers.getSetCookie(); assert.equal(cookies.length, 2); assert.match(cookies[1], /HttpOnly; SameSite=Lax; Path=\/account\/google-link/); assert.equal(cookies.join().includes("never-client-visible"), false);
    assert.equal((await t.post("/identities/google/browser-start", { intentId: result.intentId, secret: result.secret }, false)).status, 400);
    const next = await t.start(), secret = new URL(next.browserUrl).hash.split(".")[1];
    assert.equal((await t.post("/identities/google/browser-start", { intentId: next.intentId, secret }, false, "https://evil.example")).status, 403);
    const page = await t.api.browserPage().text(); assert.ok(page.indexOf("history.replaceState") < page.indexOf("fetch(")); assert.equal(t.api.browserPage().headers.get("referrer-policy"), "no-referrer");
  } finally { t.db.close(); }
});
test("foreign URLs and primary session cookie adapters fail closed", async () => {
  for (const [url, cookies] of [
    ["https://accounts.google.com.evil.test/?state=x", []], ["http://accounts.google.com/?state=x", []], ["https://accounts.google.com/?state=x&state=y", []],
    ["https://accounts.google.com/?state=x", ["better-auth.session_token=primary; Path=/"]],
  ] as [string, string[]][]) {
    const t = setup(); try { t.changeOAuth(url, cookies); const result = await t.begin(); assert.equal(result.response.status, 400); assert.equal(result.response.headers.getSetCookie().length, 0); } finally { t.db.close(); }
  }
});
test("known-state callbacks require the initiating session at dispatch and again at account writes", async () => {
  const t = setup(); try {
    await t.begin(); const request = new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"); let ran = false;
    const response = await t.api.runAuthRequest(request, async () => {
      ran = true; t.api.assertGoogleAccountCreation("owner"); assert.throws(() => t.api.assertGoogleAccountCreation("other"));
      t.db.prepare("DELETE FROM session").run(); assert.throws(() => t.api.assertGoogleAccountCreation("owner")); assert.throws(() => t.api.assertGoogleAccountMutation("owner")); return new Response("ok");
    });
    assert.equal(response.status, 200); assert.equal(ran, true);
    ran = false; assert.equal((await t.api.runAuthRequest(request, async () => { ran = true; return new Response(); })).status, 400); assert.equal(ran, false);
  } finally { t.db.close(); }
});
test("expiry retains callback tombstones and unknown flows cannot implicitly create an existing user's account", async () => {
  const t = setup(); try {
    await t.begin(); t.advance(600001); let ran = false;
    assert.equal((await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => { ran = true; return new Response(); })).status, 400); assert.equal(ran, false);
    assert.equal((t.db.prepare("SELECT count(*) AS n FROM account_google_link_intents").get() as { n: number }).n, 1);
    await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=ordinary-signup"), async () => {
      assert.throws(() => t.api.assertGoogleAccountCreation("owner")); t.api.noteCreatedUser("new-user"); t.api.assertGoogleAccountCreation("new-user"); t.api.assertGoogleAccountMutation("owner"); return new Response();
    });
    assert.throws(() => t.api.assertGoogleAccountCreation("new-user"));
  } finally { t.db.close(); }
});
test("completion needs purpose cookie, a newly linked owned provider and live initiator; status reveals no provider identity", async () => {
  const t = setup(); try {
    const result = await t.begin(), url = `https://auth.example.test/account/google-link/complete?intentId=${result.intentId}`;
    const cookie = result.response.headers.getSetCookie()[1].split(";")[0];
    assert.equal(t.api.complete(new Request(url)).status, 400);
    assert.equal(t.api.complete(new Request(url, { headers: { cookie } })).status, 400);
    t.db.prepare("INSERT INTO account VALUES('new-google','owner','google')").run();
    assert.equal(t.api.complete(new Request(url, { headers: { cookie } })).status, 400);
    await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => { t.api.noteGoogleAccountCreated("owner", "new-google"); return new Response(); });
    assert.equal(t.api.complete(new Request(url, { headers: { cookie } })).status, 200);
    assert.equal(t.api.complete(new Request(url, { headers: { cookie } })).status, 400);
    const status = await t.api.app.request(`/identities/google/${result.intentId}`, { headers: { authorization: "Bearer owner" } });
    assert.deepEqual(await status.json(), { intentId: result.intentId, status: "complete" });
    assert.equal((await t.api.app.request(`/identities/google/${result.intentId}`)).status, 401);
  } finally { t.db.close(); }
});
test("request context does not leak between concurrent OAuth requests", async () => {
  const t = setup(); try {
    await t.begin(); let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
    const authorized = t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => { await wait; t.api.assertGoogleAccountCreation("owner"); return new Response(); });
    await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=other"), async () => { assert.throws(() => t.api.assertGoogleAccountCreation("owner")); return new Response(); }); release(); await authorized;
  } finally { t.db.close(); }
});
test("malformed and oversized payloads cannot reach OAuth or create a handoff", async () => {
  const t = setup(); try {
    for (const value of [{}, { proofId: "valid-proof", callbackURL: "https://evil.test" }, { proofId: 42 }, { proofId: "x".repeat(3000) }]) {
      assert.equal((await t.post("/identities/google/start", value)).status, 400);
    }
    assert.equal((await t.api.app.request("/identities/google/start", { method: "POST", headers: { authorization: "Bearer owner", "content-type": "text/plain" }, body: '{"proofId":"valid-proof"}' })).status, 400);
    assert.equal(t.calls(), 0); assert.equal(t.tokens.length, 0);
    for (const value of [{ intentId: "bad", secret: "x".repeat(43) }, { intentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", secret: "x".repeat(43) }]) assert.equal((await t.post("/identities/google/browser-start", value, false)).status, 400);
  } finally { t.db.close(); }
});
test("Google state query takes precedence over POST body and duplicate state is rejected", async () => {
  const t = setup(); try {
    await t.begin(); t.advance(600001); let ran = false;
    const run = async () => { ran = true; return new Response(); };
    const queryKnown = new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "state=ordinary-login" });
    assert.equal((await t.api.runAuthRequest(queryKnown, run)).status, 400); assert.equal(ran, false);
    const bodyKnown = new Request("https://auth.example.test/api/auth/callback/google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "state=synthetic-google-state" });
    assert.equal((await t.api.runAuthRequest(bodyKnown, run)).status, 400); assert.equal(ran, false);
    for (const request of [new Request("https://auth.example.test/api/auth/callback/google?state=ordinary&state=synthetic-google-state"), new Request("https://auth.example.test/api/auth/callback/google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "state=ordinary&state=synthetic-google-state" })]) assert.equal((await t.api.runAuthRequest(request, run)).status, 400);
    assert.equal(ran, false);
  } finally { t.db.close(); }
});
test("completion rejects a revoked session, wrong purpose cookie and preexisting Google account", async () => {
  const t = setup(); try {
    t.db.prepare("INSERT INTO account VALUES('preexisting','owner','google')").run();
    const result = await t.begin(), url = `https://auth.example.test/account/google-link/complete?intentId=${result.intentId}`;
    const cookie = result.response.headers.getSetCookie()[1].split(";")[0];
    await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => { t.api.noteGoogleAccountCreated("owner", "preexisting"); return new Response(); });
    assert.equal(t.api.complete(new Request(url, { headers: { cookie } })).status, 400);
    t.db.prepare("INSERT INTO account VALUES('fresh','owner','google')").run();
    await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => { t.api.noteGoogleAccountCreated("owner", "fresh"); return new Response(); });
    assert.equal(t.api.complete(new Request(url, { headers: { cookie: `${cookie}x` } })).status, 400);
    t.db.prepare("DELETE FROM session").run();
    assert.equal(t.api.complete(new Request(url, { headers: { cookie } })).status, 400);
  } finally { t.db.close(); }
});
test("ISO session expiry works, but unverified canonical user and changed session owner are refused", async () => {
  for (const mutation of ["UPDATE user SET emailVerified=0 WHERE id='owner'", "UPDATE session SET userId='other'"]) {
    const t = setup(); try { const intent = await t.start(); const secret = new URL(intent.browserUrl).hash.split(".")[1]; t.db.exec(mutation); assert.equal((await t.post("/identities/google/browser-start", { intentId: intent.intentId, secret }, false)).status, 400); } finally { t.db.close(); }
  }
  const t = setup(); try { t.db.prepare("UPDATE session SET expiresAt=?").run(new Date(Date.now() + 3600_000).toISOString()); const result = await t.begin(); assert.equal(result.response.status, 200); } finally { t.db.close(); }
});
test("SQLite fences the actual linked-account INSERT after hooks yield and the initiating session is revoked", async () => {
  const t = setup(); try {
    await t.begin();
    await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => {
      t.api.authorizeGoogleAccountCreation("owner", "racing-account");
      // Represents an async adapter yield after the before hook authorized.
      await Promise.resolve(); t.db.prepare("DELETE FROM session").run();
      assert.throws(() => t.db.prepare("INSERT INTO account VALUES('racing-account','owner','google')").run(), /google-link-authorization-expired/);
      assert.equal(t.db.prepare("SELECT 1 FROM account WHERE id='racing-account'").get(), undefined);
      assert.ok(t.db.prepare("SELECT 1 FROM account_google_link_writes WHERE account_id='racing-account'").get());
      return new Response();
    });
  } finally { t.db.close(); }
});
test("live authorized INSERT consumes its marker; wrong UID and expired intent/session fail atomically", async () => {
  for (const mutation of [null, "UPDATE account_google_link_intents SET expires_at=0", "UPDATE session SET expiresAt=0", "UPDATE user SET emailVerified=0 WHERE id='owner'", "UPDATE session SET userId='other'"]) {
    const t = setup(); try {
      await t.begin();
      await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => {
        t.api.authorizeGoogleAccountCreation("owner", "authorized-account");
        assert.throws(() => t.db.prepare("INSERT INTO account VALUES('authorized-account','other','google')").run(), /google-link-authorization-expired/);
        if (mutation) { t.db.exec(mutation); assert.throws(() => t.db.prepare("INSERT INTO account VALUES('authorized-account','owner','google')").run(), /google-link-authorization-expired/); assert.equal(t.db.prepare("SELECT 1 FROM account").get(),undefined); }
        else { t.db.prepare("INSERT INTO account VALUES('authorized-account','owner','google')").run(); assert.equal(t.db.prepare("SELECT 1 FROM account_google_link_writes WHERE account_id='authorized-account'").get(), undefined); }
        return new Response();
      });
    } finally { t.db.close(); }
  }
});
test("failed write markers survive deleted intent tombstones and cannot become an unfenced insert", async () => {
  const t=setup(); try {
    await t.begin();
    await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async()=>{t.api.authorizeGoogleAccountCreation("owner","delayed-account");return new Response();});
    t.db.prepare("DELETE FROM account_google_link_intents").run();
    assert.throws(()=>t.db.prepare("INSERT INTO account VALUES('delayed-account','owner','google')").run(),/google-link-authorization-expired/);
    assert.equal(t.db.prepare("SELECT 1 FROM account").get(),undefined);
  }finally{t.db.close();}
});
test("persisted link fences leave ordinary new Google signups compatible when the feature is disabled", async () => {
  const t = setup(); try {
    await t.begin();
    await t.api.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => { t.api.authorizeGoogleAccountCreation("owner", "old-link-id"); return new Response(); });
    t.db.prepare("DELETE FROM session").run();
    // Simulate a subsequent disabled-feature process: no Google link factory
    // hooks are called, but the previous schema/triggers remain in this DB.
    t.db.prepare("INSERT INTO account VALUES('ordinary-new-signup','other','google')").run();
    assert.ok(t.db.prepare("SELECT 1 FROM account WHERE id='ordinary-new-signup'").get());
    assert.throws(() => t.db.prepare("INSERT INTO account VALUES('old-link-id','owner','google')").run(), /google-link-authorization-expired/);
  } finally { t.db.close(); }
});
