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
  MARKIE_MAIL_LOG: "1",
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
const secretsSent: string[] = [];
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
  if (url.startsWith(APPLE) || url.includes("google")) throw new Error(`No network in tests: ${url}`);
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
