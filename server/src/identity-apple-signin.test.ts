// Sign in with Apple, end to end through the real better-auth provider, with
// MARKIE_ACCOUNT_IDENTITIES=1 as in production. Apple is answered locally:
// its token endpoint is a stub that records the client secret it was sent,
// and the key is a throwaway P-256 key made here. Nothing reaches Apple.
//
// Apple posts its callback from its own origin (response_mode=form_post), and
// better-auth answers that POST with a redirect to the same callback as a GET,
// so the Lax state cookie arrives. Every flow here walks both legs.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";

const ORIGIN = "https://identity-apple.example.org";
const APPLE = "https://appleid.apple.com";
const CLIENT_ID = "org.example.markie.signin";
const dir = mkdtempSync(join(tmpdir(), "markie-identity-apple-"));
for (const name of Object.keys(process.env)) {
  if (/^(B2_|ASSETS_|S3_|GOOGLE_|APPLE_|RESEND_|EMAIL_FROM|MARKIE_)/.test(name)) delete process.env[name];
}
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
Object.assign(process.env, {
  NODE_ENV: "production",
  MARKIE_OFFICIAL: "0",
  MARKIE_SIGNUP: "open",
  MARKIE_ACCOUNT_IDENTITIES: "1",
  DB_PATH: join(dir, "t.db"),
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "markie-identity-apple-test-secret-32-plus",
  RESEND_API_KEY: "synthetic-mail-key-not-a-credential",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  APPLE_CLIENT_ID: CLIENT_ID,
  APPLE_TEAM_ID: "TEAMID1234",
  APPLE_KEY_ID: "KEYID12345",
  // As it sits in a one-line env file.
  APPLE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\\n"),
  MARKIE_NO_LISTEN: "1",
});
const originalLog = console.log;
console.log = () => {};

// What the next code exchange answers with, and every client secret Apple was sent.
let appleClaims: Record<string, unknown> = {};
let googleClaims: Record<string, unknown> = {};
const secretsSent: string[] = [];
const codes: string[] = [];
const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `${APPLE}/auth/token`) {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_id"), CLIENT_ID);
    secretsSent.push(body.get("client_secret") ?? "");
    const now = Math.floor(Date.now() / 1000);
    const idToken = `${b64url({ alg: "RS256", kid: "apple-test" })}.${b64url({ iss: APPLE, aud: CLIENT_ID, iat: now, exp: now + 600, ...appleClaims })}.signature`;
    return Response.json({ access_token: "apple-access", refresh_token: "apple-refresh", id_token: idToken, token_type: "Bearer", expires_in: 3600 });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    const now = Math.floor(Date.now() / 1000);
    const idToken = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iss: "https://accounts.google.com", aud: "google-client-id", email_verified: true, iat: now, exp: now + 3600, ...googleClaims })}.signature`;
    return Response.json({ access_token: "ya29.test", id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: "openid email profile" });
  }
  if (url.startsWith(APPLE) || url.includes("google")) throw new Error(`No network in tests: ${url}`);
  // Step-up codes go out through Resend; the code is read from the request.
  if (url === "https://api.resend.com/emails") {
    const sent = JSON.parse(String(init?.body)) as { text: string };
    codes.push(sent.text.match(/\b\d{6}\b/)?.[0] ?? "");
    return Response.json({ id: "synthetic-message" });
  }
  return originalFetch(input, init);
}) as typeof fetch;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app } = await import("./index.ts");
const { markVerified } = await import("./test-users.ts");
const { openDatabase } = await import("./db.ts");
const db = openDatabase();
test.after(() => { console.log = originalLog; globalThis.fetch = originalFetch; mock.timers.reset(); });

let ip = 0;
const req = (path: string, init: RequestInit = {}, origin = "app://markie") => {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  headers.set("x-forwarded-for", `10.5.0.${++ip % 250}`);
  return app.request(path, { ...init, headers });
};
const cookiesOf = (response: Response) => response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const users = (email: string) => (db.prepare('SELECT COUNT(*) AS n FROM "user" WHERE lower(email) = ?').get(email) as { n: number }).n;
const appleRows = (sub: string) => db.prepare("SELECT userId FROM account WHERE providerId = 'apple' AND accountId = ?").all(sub) as { userId: string }[];

let lastCallbackCookies = "";
/** Apple's consent screen answered: the form POST, then the GET it turns into. */
async function appleCallback(consent: URL, cookie: string, claims: Record<string, unknown>, user?: object): Promise<URL> {
  assert.equal(`${consent.origin}${consent.pathname}`, `${APPLE}/auth/authorize`);
  assert.equal(consent.searchParams.get("response_mode"), "form_post");
  assert.equal(consent.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/apple`);
  appleClaims = claims;
  const form = new URLSearchParams({ code: `code-${claims.sub}`, state: consent.searchParams.get("state")! });
  if (user) form.set("user", JSON.stringify(user));
  // A cross-site POST: the browser sends no Lax cookies with it.
  const posted = await req("/api/auth/callback/apple", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }, APPLE);
  assert.equal(posted.status, 302, await posted.clone().text());
  const get = new URL(posted.headers.get("location")!);
  assert.equal(`${get.origin}${get.pathname}`, `${ORIGIN}/api/auth/callback/apple`);
  const callback = await req(`${get.pathname}${get.search}`, { headers: { Cookie: cookie } }, ORIGIN);
  assert.equal(callback.status, 302, await callback.clone().text());
  lastCallbackCookies = cookiesOf(callback);
  return new URL(callback.headers.get("location")!, ORIGIN);
}

async function desktopAppleSignIn(claims: Record<string, unknown>, user?: object): Promise<URL> {
  const start = await req("/auth/apple-start?state=0123456789abcdef0123456789abcdef");
  assert.equal(start.status, 302, await start.clone().text());
  return appleCallback(new URL(start.headers.get("location")!), cookiesOf(start), claims, user);
}

function secretClaims(jwt: string) {
  const [header, payload, signature] = jwt.split(".");
  assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true, "signed by the configured key");
  return { header: JSON.parse(Buffer.from(header, "base64url").toString()), payload: JSON.parse(Buffer.from(payload, "base64url").toString()) };
}

test("the server advertises Apple, and trusts Apple's origin for auth but not for CORS", async () => {
  const info = await (await req("/api/server-info")).json() as { signIn: { apple: boolean; google: boolean } };
  assert.equal(info.signIn.apple, true);
  assert.equal(info.signIn.google, true);
  const preflight = await req("/api/docs", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } }, APPLE);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  // better-auth checks a POST's origin whenever the browser sent cookies with
  // it, which a browser can do on Apple's form POST. Apple's passes; any
  // other origin's is refused before the callback runs.
  const post = (origin: string) => req("/api/auth/callback/apple", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "unrelated=1" }, body: "code=x&state=y" }, origin);
  assert.equal((await post(APPLE)).status, 302);
  assert.equal((await post("https://evil.example")).status, 403);
});

test("a new Apple user is created from the desktop, and signs in again to the same account", async () => {
  const sub = "001234.apple-first.0001", email = "apple-first@example.org";
  const first = await desktopAppleSignIn({ sub, email, email_verified: "true" }, { name: { firstName: "Ada", lastName: "Apple" } });
  assert.equal(first.pathname, "/auth/desktop-bridge");
  assert.equal(first.searchParams.get("provider"), "apple");
  assert.equal(first.searchParams.get("error"), null, first.href);
  assert.equal(users(email), 1);
  const created = db.prepare('SELECT id,name,emailVerified FROM "user" WHERE email = ?').get(email) as { id: string; name: string; emailVerified: number };
  assert.equal(created.name, "Ada Apple");
  assert.equal(created.emailVerified, 1);
  assert.deepEqual(appleRows(sub), [{ userId: created.id }]);
  // Apple sends the name only the first time; the account keeps it.
  const second = await desktopAppleSignIn({ sub, email, email_verified: true });
  assert.equal(second.searchParams.get("error"), null, second.href);
  assert.equal(users(email), 1);
  assert.deepEqual(appleRows(sub), [{ userId: created.id }]);
});

test("the desktop bridge hands the Apple session back to the app with its nonce and issuer", async () => {
  const start = await req("/auth/apple-start?state=feedfacefeedfacefeedfacefeedface");
  const landed = await appleCallback(new URL(start.headers.get("location")!), cookiesOf(start), { sub: "001234.apple-bridge.0002", email: "apple-bridge@example.org", email_verified: "true" });
  assert.equal(landed.pathname, "/auth/desktop-bridge");
  // The callback set the session cookie on this origin; the bridge reads it.
  const bridge = await req(`${landed.pathname}${landed.search}`, { headers: { Cookie: lastCallbackCookies } }, ORIGIN);
  assert.equal(bridge.status, 200);
  assert.equal(bridge.headers.get("cache-control"), "private, no-store");
  const link = new URL(JSON.parse(/location\.href=("[^"]+")/.exec(await bridge.text())![1]));
  assert.equal(link.protocol, "markie:");
  assert.ok(link.searchParams.get("token"));
  assert.equal(link.searchParams.get("state"), "feedfacefeedfacefeedfacefeedface");
  assert.equal(link.searchParams.get("iss"), ORIGIN);
});

test("an existing email account is not joined by a matching Apple sign-in, and is told to link Apple", async () => {
  const email = "apple-existing@example.org";
  const created = await req("/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Email first", email, password: "password-123" }) });
  assert.equal(created.status, 200);
  markVerified(email);
  const landed = await desktopAppleSignIn({ sub: "001234.apple-existing.0003", email, email_verified: "true" });
  assert.equal(landed.pathname, "/auth/desktop-bridge");
  assert.equal(landed.searchParams.get("error"), "account_not_linked");
  assert.equal(users(email), 1);
  assert.deepEqual(appleRows("001234.apple-existing.0003"), []);
  const page = await req(`${landed.pathname}${landed.search}`, {}, ORIGIN);
  assert.equal(page.status, 401);
  const text = await page.text();
  assert.match(text, /Apple isn&#39;t linked to this account yet|Apple isn't linked to this account yet/);
  assert.match(text, /link Apple in Settings, Account, Manage linked sign-ins/);
  assert.doesNotMatch(text, /Google/);
});

test("a Hide My Email relay address becomes the account's verified address, as Apple gives it", async () => {
  const relay = "x7k2p9qz4m@privaterelay.appleid.com";
  const landed = await desktopAppleSignIn({ sub: "001234.apple-relay.0004", email: relay, email_verified: "true", is_private_email: "true" });
  assert.equal(landed.searchParams.get("error"), null, landed.href);
  const row = db.prepare('SELECT email,emailVerified FROM "user" WHERE email = ?').get(relay) as { email: string; emailVerified: number };
  assert.deepEqual(row, { email: relay, emailVerified: 1 });
});

test("the web sign-in page offers Apple, starts it, and explains a sign-in that needs linking", async () => {
  const page = await (await req("/auth/web-signin?next=%2Fapp", {}, ORIGIN)).text();
  assert.match(page, /href="\/auth\/web-google\?next=%2Fapp">Continue with Google</);
  assert.match(page, /href="\/auth\/web-apple\?next=%2Fapp">Continue with Apple</);
  const start = await req("/auth/web-apple?next=%2Fapp", {}, ORIGIN);
  assert.equal(start.status, 302);
  const email = "apple-web@example.org";
  const landed = await appleCallback(new URL(start.headers.get("location")!), cookiesOf(start), { sub: "001234.apple-web.0005", email, email_verified: "true" });
  assert.equal(landed.href, `${ORIGIN}/app`);
  assert.equal(users(email), 1);
  const refused = await (await req("/auth/web-signin?next=%2Fapp&error=1&error=account_not_linked", {}, ORIGIN)).text();
  assert.match(refused, /This email already has a Markie account\. Sign in with an email code, then link this sign-in in the Markie app/);
});

test("every Apple code exchange sends a client secret signed with the configured key, and a day later a fresh one", async () => {
  const before = secretsSent.length;
  await desktopAppleSignIn({ sub: "001234.apple-secret.0006", email: "apple-secret@example.org", email_verified: "true" });
  const first = secretsSent.at(-1)!;
  assert.equal(secretsSent.length, before + 1);
  const { header, payload } = secretClaims(first);
  assert.deepEqual(header, { alg: "ES256", kid: "KEYID12345", typ: "JWT" });
  assert.equal(payload.iss, "TEAMID1234"); assert.equal(payload.sub, CLIENT_ID); assert.equal(payload.aud, APPLE);
  assert.ok(payload.exp - payload.iat <= 15_777_000);
  assert.ok(payload.iat <= Date.now() / 1000);
  // A second sign-in the same day reuses it.
  await desktopAppleSignIn({ sub: "001234.apple-secret.0006", email: "apple-secret@example.org", email_verified: "true" });
  assert.equal(secretsSent.at(-1), first);
  // Two days on, the provider better-auth built at boot sends a new secret:
  // it reads the getter on every exchange instead of a copy taken at init.
  const later = Date.now() + 2 * 86_400_000;
  mock.timers.enable({ apis: ["Date"], now: later });
  try {
    const landed = await desktopAppleSignIn({ sub: "001234.apple-secret.0006", email: "apple-secret@example.org", email_verified: "true" });
    assert.equal(landed.searchParams.get("error"), null, landed.href);
  } finally { mock.timers.reset(); }
  const refreshed = secretsSent.at(-1)!;
  assert.notEqual(refreshed, first);
  const claims = secretClaims(refreshed).payload;
  assert.ok(claims.iat >= Math.floor(later / 1000) - 120 && claims.iat <= Math.floor(later / 1000), "issued at the later time");
  assert.ok(claims.exp > Math.floor(later / 1000) + 6 * 86_400);
});

// ── Linking Apple and Google from Settings ──────────────────────────────────

const json = { "Content-Type": "application/json" };
async function emailAccount(email: string) {
  assert.equal((await req("/api/auth/sign-up/email", { method: "POST", headers: json, body: JSON.stringify({ name: "Linker", email, password: "password-123" }) })).status, 200);
  markVerified(email);
  return signInByPassword(email);
}
async function signInByPassword(email: string) {
  const signed = await req("/api/auth/sign-in/email", { method: "POST", headers: json, body: JSON.stringify({ email, password: "password-123" }) });
  const token = signed.headers.get("set-auth-token")!; assert.ok(token);
  const authed = { ...json, Authorization: `Bearer ${token}` };
  const uid = ((await (await req("/api/me", { headers: authed })).json()) as { user: { id: string } }).user.id;
  return { token, authed, uid };
}
async function proof(authed: Record<string, string>, scope: string) {
  const start = await req("/api/account/identities/step-up/start", { method: "POST", headers: authed, body: JSON.stringify({ scope }) });
  assert.equal(start.status, 200, await start.clone().text());
  const { challengeId } = await start.json() as { challengeId: string };
  const verified = await req("/api/account/identities/step-up/verify", { method: "POST", headers: authed, body: JSON.stringify({ challengeId, code: codes.at(-1) }) });
  assert.equal(verified.status, 200);
  return ((await verified.json()) as { proofId: string }).proofId;
}
async function providers(authed: Record<string, string>) {
  return (await (await req("/api/account/identities", { headers: authed })).json()) as { providers: { id: string; providerId: string; email?: string }[]; googleAvailable: boolean; appleAvailable: boolean };
}
/** Settings, Manage linked sign-ins, Link Google or Apple sign-in, all the way through the browser. */
async function link(provider: "google" | "apple", authed: Record<string, string>, claims: Record<string, unknown>) {
  const started = await req(`/api/account/identities/${provider}/start`, { method: "POST", headers: authed, body: JSON.stringify({ proofId: await proof(authed, `${provider}-link`) }) });
  assert.equal(started.status, 200, await started.clone().text());
  const { intentId, browserUrl } = await started.json() as { intentId: string; browserUrl: string };
  const handoff = new URL(browserUrl);
  assert.equal(`${handoff.origin}${handoff.pathname}`, `${ORIGIN}/account/link-${provider}`);
  const page = await req(handoff.pathname, {}, ORIGIN);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`<title>Link ${provider === "apple" ? "Apple" : "Google"} to Markie</title>`));
  const browser = await req(`/api/account/identities/${provider}/browser-start`, { method: "POST", headers: json, body: JSON.stringify({ intentId, secret: handoff.hash.slice(1).split(".")[1] }) }, ORIGIN);
  assert.equal(browser.status, 200, await browser.clone().text());
  const consent = new URL(((await browser.json()) as { url: string }).url);
  const cookies = cookiesOf(browser);
  let landed: URL;
  if (provider === "apple") landed = await appleCallback(consent, cookies, claims);
  else {
    assert.equal(consent.origin, "https://accounts.google.com");
    googleClaims = claims;
    const callback = await req(`/api/auth/callback/google?code=link&state=${encodeURIComponent(consent.searchParams.get("state")!)}`, { headers: { Cookie: cookies } }, ORIGIN);
    assert.equal(callback.status, 302, await callback.clone().text());
    landed = new URL(callback.headers.get("location")!, ORIGIN);
  }
  assert.equal(landed.pathname, `/account/${provider}-link/complete`, landed.href);
  const complete = await req(`${landed.pathname}${landed.search}`, { headers: { Cookie: cookies } }, ORIGIN);
  assert.equal(complete.status, 200, await complete.clone().text());
  assert.match(await complete.text(), new RegExp(`${provider === "apple" ? "Apple" : "Google"} account linked`));
  const status = await (await req(`/api/account/identities/${provider}/${intentId}`, { headers: authed })).json() as { status: string };
  assert.equal(status.status, "complete");
}

test("capabilities and the identity listing advertise Apple linking beside Google's", async () => {
  const caps = await (await req("/api/account/capabilities")).json() as Record<string, unknown>;
  assert.equal(caps.googleLinking, true);
  assert.equal(caps.appleLinking, true);
  const owner = await emailAccount("apple-caps@example.org");
  const listed = await providers(owner.authed);
  assert.equal(listed.googleAvailable, true);
  assert.equal(listed.appleAvailable, true);
});

test("an email account links an Apple ID in Settings, then that Apple ID signs in to the same account", async () => {
  const email = "apple-link-owner@example.org", sub = "001234.apple-link.0010", appleEmail = "link-owner@icloud.example";
  const owner = await emailAccount(email);
  await link("apple", owner.authed, { sub, email: appleEmail, email_verified: "true" });
  assert.deepEqual(appleRows(sub), [{ userId: owner.uid }]);
  const listed = await providers(owner.authed);
  assert.deepEqual(listed.providers.filter((row) => row.providerId === "apple").map(({ providerId, email }) => ({ providerId, email })), [{ providerId: "apple", email: appleEmail }]);
  // Signed out on this browser, back in with Apple: the same account, no new one.
  const again = await desktopAppleSignIn({ sub, email: appleEmail, email_verified: "true" });
  assert.equal(again.searchParams.get("error"), null, again.href);
  const bridge = await req(`${again.pathname}${again.search}`, { headers: { Cookie: lastCallbackCookies } }, ORIGIN);
  const deepLink = new URL(JSON.parse(/location\.href=("[^"]+")/.exec(await bridge.text())![1]));
  const me = await (await req("/api/me", { headers: { Authorization: `Bearer ${deepLink.searchParams.get("token")}` } })).json() as { user: { id: string } };
  assert.equal(me.user.id, owner.uid);
  assert.equal(users(appleEmail), 0);
});

// Five codes a minute may go to one address (account-identities.ts), so each
// test here asks for five at most.
test("two Apple IDs and two Google accounts sit on one account, each with its address, and an Apple ID unlinks like Google", async () => {
  const email = "four-sign-ins@example.org";
  let owner = await emailAccount(email);
  await link("apple", owner.authed, { sub: "001234.four.apple-a", email: "four.a@icloud.example", email_verified: "true" });
  await link("apple", owner.authed, { sub: "001234.four.apple-b", email: "q8w7e6r5t4@privaterelay.appleid.com", email_verified: "true", is_private_email: "true" });
  await link("google", owner.authed, { sub: "google-four-a", email: "four.a@gmail.example" });
  await link("google", owner.authed, { sub: "google-four-b", email: "four.b@work.example" });
  const listed = (await providers(owner.authed)).providers.filter((row) => row.providerId !== "credential");
  assert.deepEqual(listed.map(({ providerId, email }) => `${providerId}:${email}`).sort(), [
    "apple:four.a@icloud.example", "apple:q8w7e6r5t4@privaterelay.appleid.com", "google:four.a@gmail.example", "google:four.b@work.example",
  ]);
  // The address is a label only: it is not an extra verified email on the account.
  const identities = (await (await req("/api/account/identities", { headers: owner.authed })).json() as { identities: { email: string }[] }).identities;
  assert.deepEqual(identities.map((row) => row.email), [email]);
  const relay = listed.find((row) => row.email?.includes("privaterelay"))!;
  // Unlinking an Apple ID signs out every session of the account, like Google.
  const removed = await req(`/api/account/identities/apple-provider/${relay.id}`, { method: "DELETE", headers: owner.authed, body: JSON.stringify({ proofId: await proof(owner.authed, "apple-remove") }) });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true, signedOut: true });
  assert.deepEqual(db.prepare("SELECT id FROM session WHERE userId=?").all(owner.uid), []);
  assert.equal(db.prepare("SELECT 1 FROM account_provider_labels WHERE account_id=?").get(relay.id), undefined);
  owner = await signInByPassword(email);
  const after = (await providers(owner.authed)).providers.filter((row) => row.providerId !== "credential");
  assert.deepEqual(after.map(({ providerId, email }) => `${providerId}:${email}`).sort(), ["apple:four.a@icloud.example", "google:four.a@gmail.example", "google:four.b@work.example"]);
  // The removed Apple ID is a stranger now: its next sign-in makes a new account of its own.
  const stranger = await desktopAppleSignIn({ sub: "001234.four.apple-b", email: "q8w7e6r5t4@privaterelay.appleid.com", email_verified: "true" });
  assert.equal(stranger.searchParams.get("error"), null);
  assert.notEqual(appleRows("001234.four.apple-b")[0].userId, owner.uid);
});

test("each provider's unlink needs that provider's removal proof and removes only that provider's rows", async () => {
  const owner = await emailAccount("apple-scopes@example.org");
  await link("apple", owner.authed, { sub: "001234.scopes.apple", email: "scopes@icloud.example", email_verified: "true" });
  await link("google", owner.authed, { sub: "google-scopes", email: "scopes@gmail.example" });
  const listed = (await providers(owner.authed)).providers;
  const appleRow = listed.find((row) => row.providerId === "apple")!, googleRow = listed.find((row) => row.providerId === "google")!;
  const remove = async (provider: string, id: string, scope: string) => (await req(`/api/account/identities/${provider}-provider/${id}`, { method: "DELETE", headers: owner.authed, body: JSON.stringify({ proofId: await proof(owner.authed, scope) }) })).status;
  assert.equal(await remove("apple", appleRow.id, "google-remove"), 400);
  assert.equal(await remove("google", googleRow.id, "apple-remove"), 400);
  assert.equal(await remove("google", appleRow.id, "google-remove"), 400, "the Google route never removes an Apple row");
  assert.equal((await providers(owner.authed)).providers.length, listed.length, "nothing removed, nobody signed out");
});

test("an Apple or Google sign-up records its address, and rows from before keep no label", async () => {
  const sub = "001234.apple-label.0020", email = "apple-label@example.org";
  await desktopAppleSignIn({ sub, email, email_verified: "true" });
  const [{ userId }] = appleRows(sub);
  const label = db.prepare("SELECT user_id,provider_id,email FROM account_provider_labels l JOIN account a ON a.id=l.account_id WHERE a.accountId=?").get(sub);
  assert.deepEqual(label, { user_id: userId, provider_id: "apple", email });
  // An older row: linked before addresses were recorded.
  const old = "old-google-row-0001";
  db.prepare("INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(old, "google-old-sub", "google", userId, new Date().toISOString(), new Date().toISOString());
  const session = await auth.$context.then((context) => context.internalAdapter.createSession(userId));
  const listed = await providers({ ...json, Authorization: `Bearer ${session.token}` });
  assert.deepEqual(listed.providers.find((row) => row.id === old), { id: old, providerId: "google" });
  assert.equal(listed.providers.find((row) => row.providerId === "apple")?.email, email);
});

test("an Apple link whose initiating session was revoked before Apple answered creates nothing", async () => {
  const owner = await emailAccount("apple-revoked-link@example.org");
  const started = await req("/api/account/identities/apple/start", { method: "POST", headers: owner.authed, body: JSON.stringify({ proofId: await proof(owner.authed, "apple-link") }) });
  const { intentId, browserUrl } = await started.json() as { intentId: string; browserUrl: string };
  const browser = await req("/api/account/identities/apple/browser-start", { method: "POST", headers: json, body: JSON.stringify({ intentId, secret: new URL(browserUrl).hash.slice(1).split(".")[1] }) }, ORIGIN);
  const consent = new URL(((await browser.json()) as { url: string }).url);
  db.prepare("DELETE FROM session WHERE userId=?").run(owner.uid);
  appleClaims = { sub: "001234.apple-revoked.0030", email: "revoked@icloud.example", email_verified: "true" };
  // Refused at Apple's form POST, before better-auth reads the state.
  const posted = await req("/api/auth/callback/apple", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: "c", state: consent.searchParams.get("state")! }).toString() }, APPLE);
  assert.equal(posted.status, 400);
  assert.deepEqual(await posted.json(), { error: "invalid-apple-link" });
  const get = await req(`/api/auth/callback/apple?code=c&state=${encodeURIComponent(consent.searchParams.get("state")!)}`, { headers: { Cookie: cookiesOf(browser) } }, ORIGIN);
  assert.equal(get.status, 400);
  assert.deepEqual(appleRows("001234.apple-revoked.0030"), []);
  assert.equal(users("revoked@icloud.example"), 0);
});

test("better-auth's real Apple account INSERT is fenced when the initiating session goes away after the hook authorized it", async () => {
  const owner = await emailAccount("apple-adapter-race@example.org");
  const { accountContext } = await import("./account-context.ts");
  const apple = accountContext()?.apple; assert.ok(apple);
  const started = await req("/api/account/identities/apple/start", { method: "POST", headers: owner.authed, body: JSON.stringify({ proofId: await proof(owner.authed, "apple-link") }) });
  const { intentId, browserUrl } = await started.json() as { intentId: string; browserUrl: string };
  const browser = await req("/api/account/identities/apple/browser-start", { method: "POST", headers: json, body: JSON.stringify({ intentId, secret: new URL(browserUrl).hash.slice(1).split(".")[1] }) }, ORIGIN);
  const state = new URL(((await browser.json()) as { url: string }).url).searchParams.get("state")!;
  const context = await auth.$context, subject = "001234.apple-race.0040";
  const hooks = auth.options.databaseHooks!.account!.create!, original = hooks.before!;
  let reached!: () => void, resume!: () => void, assignedId = "";
  const authorized = new Promise<void>((resolve) => { reached = resolve; }), paused = new Promise<void>((resolve) => { resume = resolve; });
  hooks.before = async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (args[0].providerId === "apple" && args[0].accountId === subject) {
      assert.ok(result && typeof result === "object" && "data" in result && result.data?.id);
      assignedId = result.data.id; reached(); await paused;
    }
    return result;
  };
  try {
    const creation = apple.runAuthRequest(new Request(`${ORIGIN}/api/auth/callback/apple?state=${encodeURIComponent(state)}`), async () => {
      await context.internalAdapter.createAccount({ userId: owner.uid, providerId: "apple", accountId: subject });
      return Response.json({ ok: true });
    });
    const rejected = assert.rejects(creation);
    await authorized;
    assert.ok(db.prepare("SELECT 1 FROM account_apple_link_writes WHERE account_id=?").get(assignedId));
    db.prepare("DELETE FROM session WHERE userId=?").run(owner.uid);
    resume(); await rejected;
    assert.deepEqual(appleRows(subject), []);
    assert.ok(db.prepare("SELECT 1 FROM account_apple_link_writes WHERE account_id=?").get(assignedId), "the failed marker is kept, so a delayed write cannot become an unmarked sign-up");
  } finally { resume(); hooks.before = original; }
});

// ── Review fixes ────────────────────────────────────────────────────────────

test("a Google or Apple sign-up whose provider has not verified the email makes no account, and says why", async () => {
  const appleEmail = "apple-unverified@example.org";
  const landed = await desktopAppleSignIn({ sub: "001234.apple-unverified.0050", email: appleEmail, email_verified: "false" });
  assert.equal(landed.pathname, "/auth/desktop-bridge");
  assert.equal(landed.searchParams.get("error"), "provider_email_unverified");
  assert.equal(users(appleEmail), 0);
  assert.deepEqual(appleRows("001234.apple-unverified.0050"), []);
  const page = await (await req(`${landed.pathname}${landed.search}`, {}, ORIGIN)).text();
  assert.match(page, /Apple hasn&#39;t verified this email|Apple hasn't verified this email/);
  assert.match(page, /Verify it with Apple, or sign in with an email code\./);
  // Google, the same.
  const googleEmail = "google-unverified@example.org";
  googleClaims = { sub: "google-unverified", email: googleEmail, email_verified: false };
  const start = await req("/auth/google-start?state=0123456789abcdef0123456789abcdef");
  const consent = new URL(start.headers.get("location")!);
  const callback = await req(`/api/auth/callback/google?code=c&state=${encodeURIComponent(consent.searchParams.get("state")!)}`, { headers: { Cookie: cookiesOf(start) } }, ORIGIN);
  const googleLanded = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(googleLanded.searchParams.get("error"), "provider_email_unverified");
  assert.equal(users(googleEmail), 0);
  assert.match(await (await req(`${googleLanded.pathname}${googleLanded.search}`, {}, ORIGIN)).text(), /Verify it with Google, or sign in with an email code\./);
  // On the web the sign-in page says it.
  const web = await req("/auth/web-apple?next=%2Fapp", {}, ORIGIN);
  const webLanded = await appleCallback(new URL(web.headers.get("location")!), cookiesOf(web), { sub: "001234.apple-unverified.0051", email: "apple-unverified-web@example.org", email_verified: false });
  assert.equal(webLanded.pathname, "/auth/web-signin");
  assert.match(await (await req(`${webLanded.pathname}${webLanded.search}`, {}, ORIGIN)).text(), /That Google or Apple account&#39;s email isn&#39;t verified\. Verify it with the provider, or sign in with an email code\./);
  assert.equal(users("apple-unverified-web@example.org"), 0);
});

test("email-code and password sign-ups, which prove the address their own way, still make accounts", async () => {
  const password = await req("/api/auth/sign-up/email", { method: "POST", headers: json, body: JSON.stringify({ name: "Password first", email: "pw-unaffected@example.org", password: "password-123" }) });
  assert.equal(password.status, 200);
  assert.equal(users("pw-unaffected@example.org"), 1);
  const sent = await req("/api/auth/email-otp/send-verification-otp", { method: "POST", headers: json, body: JSON.stringify({ email: "otp-unaffected@example.org", type: "sign-in" }) });
  assert.equal(sent.status, 200);
  const signedIn = await req("/api/auth/sign-in/email-otp", { method: "POST", headers: json, body: JSON.stringify({ email: "otp-unaffected@example.org", otp: codes.at(-1) }) });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  assert.equal(users("otp-unaffected@example.org"), 1);
});

test("Apple's real email in its form POST never reaches the redirect better-auth builds, and the name still arrives", async () => {
  const start = await req("/auth/apple-start?state=0123456789abcdef0123456789abcdef");
  const consent = new URL(start.headers.get("location")!);
  const relay = "m3n4b5v6c7@privaterelay.appleid.com";
  appleClaims = { sub: "001234.apple-private.0060", email: relay, email_verified: "true", is_private_email: "true" };
  const form = new URLSearchParams({ code: "c", state: consent.searchParams.get("state")!, user: JSON.stringify({ name: { firstName: "Priya", lastName: "Private" }, email: "priya.real@icloud.example" }) });
  const posted = await req("/api/auth/callback/apple", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }, APPLE);
  assert.equal(posted.status, 302);
  const redirect = posted.headers.get("location")!;
  assert.doesNotMatch(decodeURIComponent(redirect), /priya\.real|icloud\.example|"email"/);
  assert.deepEqual(JSON.parse(new URL(redirect).searchParams.get("user")!), { name: { firstName: "Priya", lastName: "Private" } });
  const get = new URL(redirect);
  const callback = await req(`${get.pathname}${get.search}`, { headers: { Cookie: cookiesOf(start) } }, ORIGIN);
  assert.equal(callback.status, 302);
  assert.deepEqual(db.prepare('SELECT name,email FROM "user" WHERE email = ?').get(relay), { name: "Priya Private", email: relay });
  // A user field that is not Apple's JSON is dropped, not passed along.
  const junk = new URLSearchParams({ code: "c", state: "s", user: "priya.real@icloud.example" });
  const junkPost = await req("/api/auth/callback/apple", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: junk.toString() }, APPLE);
  assert.equal(new URL(junkPost.headers.get("location")!).searchParams.has("user"), false);
});

test("when a mailbox owner reclaims an unproven account, better-auth's removal of its provider rows takes their labels too", async () => {
  const email = "reclaimed-labels@example.org";
  assert.equal((await req("/api/auth/sign-up/email", { method: "POST", headers: json, body: JSON.stringify({ name: "Squatter", email, password: "password-123" }) })).status, 200);
  const { id: uid } = db.prepare('SELECT id FROM "user" WHERE email = ?').get(email) as { id: string };
  // A provider row on the unproven account, made through the real hooks.
  const { accountContext } = await import("./account-context.ts");
  const google = accountContext()?.google; assert.ok(google);
  const context = await auth.$context;
  let rowId = "";
  await google.runAuthRequest(new Request(`${ORIGIN}/api/auth/callback/google?state=fixture-reclaim`), async () => {
    google.noteCreatedUser(uid);
    const idToken = `${b64url({ alg: "RS256" })}.${b64url({ email: "squatter@gmail.example" })}.sig`;
    rowId = (await context.internalAdapter.createAccount({ userId: uid, providerId: "google", accountId: "google-reclaim-sub", idToken }))!.id;
    return new Response();
  });
  assert.ok(db.prepare("SELECT 1 FROM account_provider_labels WHERE account_id=?").get(rowId));
  // The real owner signs in with the code mailed to the address.
  assert.equal((await req("/api/auth/email-otp/send-verification-otp", { method: "POST", headers: json, body: JSON.stringify({ email, type: "sign-in" }) })).status, 200);
  const reclaimed = await req("/api/auth/sign-in/email-otp", { method: "POST", headers: json, body: JSON.stringify({ email, otp: codes.at(-1) }) });
  assert.equal(reclaimed.status, 200, await reclaimed.clone().text());
  assert.equal(db.prepare("SELECT 1 FROM account WHERE id=?").get(rowId), undefined, "better-auth removed the unproven provider row");
  assert.equal(db.prepare("SELECT 1 FROM account_provider_labels WHERE account_id=?").get(rowId), undefined);
});
