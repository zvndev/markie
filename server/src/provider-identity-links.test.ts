// Apple's half of the provider-generic linking protocol. Google's behavior is
// pinned by google-identity-links.test.ts, which runs unchanged against the
// same module; these check that Apple gets the same guarantees under its own
// names, and that the two providers never answer for each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createProviderIdentityLinks, type LinkProvider } from "./provider-identity-links.ts";

const CONSENT = { google: "https://accounts.google.com/o/oauth2/v2/auth", apple: "https://appleid.apple.com/auth/authorize" };
function setup(db = schema()) {
  let time = Date.now();
  db.prepare("INSERT OR REPLACE INTO session VALUES('session','owner','never-client-visible',?)").run(time + 3600_000);
  const actor = { userId: "owner", email: "owner@example.test", emailVerified: true, sessionId: "session" };
  const scopes: string[] = [], tokens: string[] = [];
  const make = (provider: LinkProvider, url = `${CONSENT[provider]}?state=synthetic-${provider}-state`) => createProviderIdentityLinks({
    provider, db, secret: "test-secret-32-characters-minimum-for-hmac", authOrigin: "https://auth.example.test", now: () => time,
    authenticate: (request) => request.headers.get("authorization") === "Bearer owner" ? actor : null,
    consumeStepUp: (who, proof, scope) => { assert.equal(who, actor); scopes.push(scope); if (proof !== "valid-proof") throw Error("rejected proof"); },
    beginOAuthLink: async (input) => { tokens.push(input.sessionToken); return { url, stateCookies: ["better-auth.state=state-binding; Path=/; HttpOnly; Secure"] }; },
  });
  const post = (api: ReturnType<typeof make>, path: string, data: unknown, auth = true) => api.app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: "https://auth.example.test", ...(auth ? { authorization: "Bearer owner" } : {}) }, body: JSON.stringify(data) });
  async function begin(api: ReturnType<typeof make>) {
    const p = api.provider;
    const started = await post(api, `/identities/${p}/start`, { proofId: "valid-proof" }); assert.equal(started.status, 200);
    const intent = await started.json() as { intentId: string; browserUrl: string };
    const secret = new URL(intent.browserUrl).hash.slice(1).split(".")[1];
    return { ...intent, secret, response: await post(api, `/identities/${p}/browser-start`, { intentId: intent.intentId, secret }, false) };
  }
  return { db, make, post, begin, scopes, tokens, advance: (ms: number) => { time += ms; } };
}
function schema() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,token TEXT,expiresAt INTEGER); CREATE TABLE account(id TEXT PRIMARY KEY,userId TEXT,providerId TEXT); INSERT INTO user VALUES('owner','owner@example.test',1),('other','other@example.test',1);`);
  return db;
}
const callback = (state: string, init?: RequestInit) => new Request(`https://auth.example.test/api/auth/callback/apple${init ? "" : `?state=${state}`}`, init);
const formPost = (state: string) => callback(state, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: "c", state }).toString() });

test("Apple's handoff, page, cookie, scope and completion are all named for Apple", async () => {
  const t = setup(); try {
    const apple = t.make("apple"), result = await t.begin(apple);
    assert.equal(new URL(result.browserUrl).pathname, "/account/link-apple");
    assert.deepEqual(t.scopes, ["apple-link"]);
    assert.equal(result.response.status, 200);
    assert.deepEqual(await result.response.json(), { url: `${CONSENT.apple}?state=synthetic-apple-state` });
    assert.deepEqual(t.tokens, ["never-client-visible"]);
    const purpose = result.response.headers.getSetCookie()[1];
    assert.match(purpose, new RegExp(`^markie_apple_link_${result.intentId}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=/account/apple-link; Max-Age=600; Secure$`));
    const page = await apple.browserPage().text();
    assert.match(page, /<title>Link Apple to Markie<\/title>/);
    assert.match(page, /fetch\('\/api\/account\/identities\/apple\/browser-start'/);
    assert.match(page, /target\.origin!=='https:\/\/appleid\.apple\.com'/);
    assert.ok(page.indexOf("history.replaceState") < page.indexOf("fetch("));
    // Apple answers with a form POST that carries the state in its body.
    const url = `https://auth.example.test/account/apple-link/complete?intentId=${result.intentId}`, cookie = purpose.split(";")[0];
    await apple.runAuthRequest(formPost("synthetic-apple-state"), async () => {
      apple.authorizeAccountCreation("owner", "new-apple");
      t.db.prepare("INSERT INTO account VALUES('new-apple','owner','apple')").run();
      apple.noteAccountCreated("owner", "new-apple");
      return new Response();
    });
    const done = apple.complete(new Request(url, { headers: { cookie } }));
    assert.equal(done.status, 200);
    assert.equal(await done.text(), "Apple account linked. You can close this tab and return to Markie.");
    const status = await apple.app.request(`/identities/apple/${result.intentId}`, { headers: { authorization: "Bearer owner" } });
    assert.deepEqual(await status.json(), { intentId: result.intentId, status: "complete" });
  } finally { t.db.close(); }
});

test("Apple linking accepts only Apple's consent screen and refuses with its own error", async () => {
  for (const url of ["https://accounts.google.com/o/oauth2/v2/auth?state=x", "https://appleid.apple.com.evil.test/auth/authorize?state=x", "http://appleid.apple.com/auth/authorize?state=x", "https://appleid.apple.com/auth/authorize?state=x&state=y"]) {
    const t = setup(); try {
      const result = await t.begin(t.make("apple", url));
      assert.equal(result.response.status, 400, url);
      assert.deepEqual(await result.response.json(), { error: "invalid-apple-link" });
      assert.equal(result.response.headers.getSetCookie().length, 0);
    } finally { t.db.close(); }
  }
});

test("a known Apple state needs its live initiating session on the form POST and the GET it becomes", async () => {
  const t = setup(); try {
    const apple = t.make("apple"); await t.begin(apple);
    let ran = 0;
    const run = async () => { ran++; apple.assertAccountCreation("owner"); assert.throws(() => apple.assertAccountCreation("other")); return new Response("ok"); };
    assert.equal((await apple.runAuthRequest(formPost("synthetic-apple-state"), run)).status, 200);
    assert.equal((await apple.runAuthRequest(callback("synthetic-apple-state"), run)).status, 200);
    assert.equal(ran, 2);
    t.db.prepare("DELETE FROM session").run();
    for (const request of [formPost("synthetic-apple-state"), callback("synthetic-apple-state")]) {
      const refused = await apple.runAuthRequest(request, run);
      assert.equal(refused.status, 400); assert.deepEqual(await refused.json(), { error: "invalid-apple-link" });
    }
    assert.equal(ran, 2);
    // An unknown state is an ordinary sign-in: only a user this request created may get a row.
    await apple.runAuthRequest(formPost("ordinary-apple-signin"), async () => {
      assert.throws(() => apple.assertAccountCreation("owner")); apple.noteCreatedUser("new-user"); apple.assertAccountCreation("new-user"); return new Response();
    });
  } finally { t.db.close(); }
});

test("SQLite fences an authorized Apple insert, and each provider's fence covers only its own rows", async () => {
  const t = setup(); try {
    const google = t.make("google"), apple = t.make("apple");
    await t.begin(google); await t.begin(apple);
    await apple.runAuthRequest(callback("synthetic-apple-state"), async () => { apple.authorizeAccountCreation("owner", "apple-row"); return new Response(); });
    await google.runAuthRequest(new Request("https://auth.example.test/api/auth/callback/google?state=synthetic-google-state"), async () => { google.authorizeAccountCreation("owner", "google-row"); return new Response(); });
    assert.ok(t.db.prepare("SELECT 1 FROM account_apple_link_writes WHERE account_id='apple-row'").get());
    assert.equal(t.db.prepare("SELECT 1 FROM account_google_link_writes WHERE account_id='apple-row'").get(), undefined);
    // An Apple marker means nothing to a Google row of the same id, and the other way round.
    t.db.prepare("DELETE FROM session").run();
    assert.throws(() => t.db.prepare("INSERT INTO account VALUES('apple-row','owner','apple')").run(), /apple-link-authorization-expired/);
    assert.throws(() => t.db.prepare("INSERT INTO account VALUES('google-row','owner','google')").run(), /google-link-authorization-expired/);
    t.db.prepare("INSERT INTO account VALUES('apple-row','owner','google')").run();
    t.db.prepare("INSERT INTO account VALUES('google-row','owner','apple')").run();
    // Ordinary Apple sign-ups, with no marker, are untouched by the fence.
    t.db.prepare("INSERT INTO account VALUES('fresh-apple','other','apple')").run();
    assert.ok(t.db.prepare("SELECT 1 FROM account WHERE id='fresh-apple'").get());
  } finally { t.db.close(); }
});

test("a live authorized Apple insert consumes its marker; a wrong user or an expired intent fails", async () => {
  for (const mutation of [null, "UPDATE account_apple_link_intents SET expires_at=0", "UPDATE user SET emailVerified=0 WHERE id='owner'"]) {
    const t = setup(); try {
      const apple = t.make("apple"); await t.begin(apple);
      await apple.runAuthRequest(callback("synthetic-apple-state"), async () => {
        apple.authorizeAccountCreation("owner", "authorized-apple");
        assert.throws(() => t.db.prepare("INSERT INTO account VALUES('authorized-apple','other','apple')").run(), /apple-link-authorization-expired/);
        if (mutation) { t.db.exec(mutation); assert.throws(() => t.db.prepare("INSERT INTO account VALUES('authorized-apple','owner','apple')").run(), /apple-link-authorization-expired/); }
        else { t.db.prepare("INSERT INTO account VALUES('authorized-apple','owner','apple')").run(); assert.equal(t.db.prepare("SELECT 1 FROM account_apple_link_writes").get(), undefined); }
        return new Response();
      });
    } finally { t.db.close(); }
  }
});

test("a Google link state never authorizes Apple, and Apple's routes do not answer Google's", async () => {
  const t = setup(); try {
    const google = t.make("google"), apple = t.make("apple");
    await t.begin(google);
    // Google's live state, replayed at Apple's callback, is just an unknown state there.
    await apple.runAuthRequest(callback("synthetic-google-state"), async () => { assert.throws(() => apple.assertAccountCreation("owner")); return new Response(); });
    assert.equal((await t.post(apple, "/identities/google/start", { proofId: "valid-proof" })).status, 404);
    // An Apple intent cannot be completed through Google's page, or read through Google's status route.
    const result = await t.begin(apple);
    assert.equal((await google.app.request(`/identities/google/${result.intentId}`, { headers: { authorization: "Bearer owner" } })).status, 400);
    assert.equal(google.complete(new Request(`https://auth.example.test/account/google-link/complete?intentId=${result.intentId}`, { headers: { cookie: result.response.headers.getSetCookie()[1].split(";")[0] } })).status, 400);
  } finally { t.db.close(); }
});

test("an unknown provider is refused before anything is created", () => {
  const db = schema(); try {
    assert.throws(() => createProviderIdentityLinks({ provider: "github" as LinkProvider, db, secret: "x".repeat(40), authOrigin: "https://a.test", authenticate: () => null, consumeStepUp: () => {}, beginOAuthLink: async () => ({ url: "", stateCookies: [] }) }), /Unknown identity provider/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'account_github%'").get(), undefined);
  } finally { db.close(); }
});
