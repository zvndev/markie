// What "Continue with Google" does once MARKIE_ACCOUNT_IDENTITIES=1 is on.
// The flag turns off better-auth's implicit linking (auth.ts accountLinking),
// so this pins the behavior an existing production user will meet: a Google
// account whose address matches an email-code or password account is refused
// with account_not_linked and creates nothing, while Google-first accounts and
// brand-new Google users keep signing in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";

const ORIGIN = "https://identity-google.example.org";
const dir = mkdtempSync(join(tmpdir(), "markie-identity-google-"));
for (const name of Object.keys(process.env)) {
  if (/^(B2_|ASSETS_|S3_|GOOGLE_|RESEND_|EMAIL_FROM|MARKIE_)/.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  NODE_ENV: "production",
  MARKIE_OFFICIAL: "0",
  MARKIE_SIGNUP: "open",
  MARKIE_ACCOUNT_IDENTITIES: "1",
  DB_PATH: join(dir, "t.db"),
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "markie-identity-google-test-secret-32-plus",
  MARKIE_MAIL_LOG: "1",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  MARKIE_NO_LISTEN: "1",
});
const originalLog = console.log;
console.log = () => {};

// Google's token endpoint, answered locally; better-auth reads the profile from the id token.
let googleEmail = "";
const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://oauth2.googleapis.com/token") {
    const idToken = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iss: "https://accounts.google.com", aud: "google-client-id", sub: `google-${googleEmail}`,
      email: googleEmail, email_verified: true, name: "Google Person",
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    })}.signature`;
    return Response.json({ access_token: "ya29.test", id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: "openid email profile" });
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

let ip = 0;
const req = (path: string, init: RequestInit = {}, origin = "app://markie") => {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  headers.set("x-forwarded-for", `10.4.0.${++ip % 250}`);
  return app.request(path, { ...init, headers });
};
const users = (email: string) => (db.prepare('SELECT COUNT(*) AS n FROM "user" WHERE lower(email) = ?').get(email) as { n: number }).n;
const googleRows = (email: string) => (db.prepare(`SELECT COUNT(*) AS n FROM account a JOIN "user" u ON u.id = a.userId WHERE a.providerId = 'google' AND lower(u.email) = ?`).get(email) as { n: number }).n;

async function googleSignIn(email: string): Promise<URL> {
  googleEmail = email;
  const start = await req("/auth/google-start?state=0123456789abcdef0123456789abcdef");
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const callback = await req(`/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } }, ORIGIN);
  assert.equal(callback.status, 302, await callback.clone().text());
  return new URL(callback.headers.get("location")!, ORIGIN);
}

test("an existing email account is not silently joined by a matching Google sign-in", async () => {
  const email = "existing-email-user@example.org";
  const created = await req("/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Email first", email, password: "password-123" }) });
  assert.equal(created.status, 200);
  markVerified(email);
  const landed = await googleSignIn(email);
  assert.equal(landed.pathname, "/auth/desktop-bridge");
  assert.equal(landed.searchParams.get("error"), "account_not_linked");
  assert.equal(users(email), 1);
  assert.equal(googleRows(email), 0);
  const page = await req(`${landed.pathname}${landed.search}`, {}, ORIGIN);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /link Google in Settings/);
});

test("a new Google user is created, and signs in again to the same account", async () => {
  const email = "google-first@example.org";
  const first = await googleSignIn(email);
  assert.equal(first.searchParams.get("error"), null);
  const second = await googleSignIn(email);
  assert.equal(second.searchParams.get("error"), null);
  assert.equal(users(email), 1);
  assert.equal(googleRows(email), 1);
});

test.after(() => { console.log = originalLog; globalThis.fetch = originalFetch; });

test("an email account links Google from Settings, then that Google account signs in to it", async () => {
  const email = "link-owner@example.org", googleAddress = "link-owner.personal@gmail.example";
  const json = { "Content-Type": "application/json" };
  assert.equal((await req("/api/auth/sign-up/email", { method: "POST", headers: json, body: JSON.stringify({ name: "Linker", email, password: "password-123" }) })).status, 200);
  markVerified(email);
  const signed = await req("/api/auth/sign-in/email", { method: "POST", headers: json, body: JSON.stringify({ email, password: "password-123" }) });
  const token = signed.headers.get("set-auth-token")!; assert.ok(token);
  const authed = { ...json, Authorization: `Bearer ${token}` };
  const uid = ((await (await req("/api/me", { headers: authed })).json()) as { user: { id: string } }).user.id;
  // Step-up: the code mailed to the primary address.
  const codes: string[] = [];
  console.log = (...args: unknown[]) => { const match = args.map(String).join(" ").match(/code is (\d{6})/); if (match) codes.push(match[1]); };
  const stepUp = await (await req("/api/account/identities/step-up/start", { method: "POST", headers: authed, body: JSON.stringify({ scope: "google-link" }) })).json() as { challengeId: string };
  const { proofId } = await (await req("/api/account/identities/step-up/verify", { method: "POST", headers: authed, body: JSON.stringify({ challengeId: stepUp.challengeId, code: codes.at(-1) }) })).json() as { proofId: string };
  console.log = () => {};
  const started = await req("/api/account/identities/google/start", { method: "POST", headers: authed, body: JSON.stringify({ proofId }) });
  assert.equal(started.status, 200);
  const { intentId, browserUrl } = await started.json() as { intentId: string; browserUrl: string };
  assert.equal(new URL(browserUrl).origin, ORIGIN);
  // The browser page posts its fragment back from the server's own origin.
  const secret = new URL(browserUrl).hash.slice(1).split(".")[1];
  const browser = await req("/api/account/identities/google/browser-start", { method: "POST", headers: json, body: JSON.stringify({ intentId, secret }) }, ORIGIN);
  assert.equal(browser.status, 200);
  const consent = new URL(((await browser.json()) as { url: string }).url);
  assert.equal(`${consent.origin}${consent.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(consent.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/google`);
  const cookies = browser.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  googleEmail = googleAddress;
  const callback = await req(`/api/auth/callback/google?code=link-code&state=${encodeURIComponent(consent.searchParams.get("state")!)}`, { headers: { Cookie: cookies } }, ORIGIN);
  assert.equal(callback.status, 302, await callback.clone().text());
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.pathname, "/account/google-link/complete", landed.href);
  const complete = await req(`${landed.pathname}${landed.search}`, { headers: { Cookie: cookies } }, ORIGIN);
  assert.equal(complete.status, 200, await complete.clone().text());
  assert.match(await complete.text(), /Google account linked/);
  const status = await (await req(`/api/account/identities/google/${intentId}`, { headers: authed })).json() as { status: string };
  assert.equal(status.status, "complete");
  const listed = await (await req("/api/account/identities", { headers: authed })).json() as { providers: { providerId: string }[] };
  assert.ok(listed.providers.some((row) => row.providerId === "google"));
  // The linked Google account now signs in to the same account, and makes no other.
  const viaGoogle = await googleSignIn(googleAddress);
  assert.equal(viaGoogle.searchParams.get("error"), null, viaGoogle.href);
  assert.equal(users(googleAddress), 0);
  const owner = db.prepare(`SELECT userId FROM account WHERE providerId = 'google' AND accountId = ?`).get(`google-${googleAddress}`) as { userId: string };
  assert.equal(owner.userId, uid);
});
