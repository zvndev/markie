// The phone app's Google and Apple sign-in (mobile-auth.ts), end to end
// through the real better-auth providers. Google and Apple are answered
// locally: their token endpoints are stubs and Apple's key is a throwaway
// made here. Nothing reaches either of them.
//
// What this pins: the link back to the app carries a one-use code and never a
// session token; the code is worth nothing without the secret the app kept;
// and every other way of spending it is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";

const ORIGIN = "https://mobile-auth.example.org";
const APPLE = "https://appleid.apple.com";
const APPLE_CLIENT = "org.example.markie.signin";
const dir = mkdtempSync(join(tmpdir(), "markie-mobile-auth-"));
for (const name of Object.keys(process.env)) {
  if (/^(B2_|ASSETS_|S3_|GOOGLE_|APPLE_|RESEND_|EMAIL_FROM|MARKIE_)/.test(name)) delete process.env[name];
}
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
Object.assign(process.env, {
  NODE_ENV: "production",
  MARKIE_OFFICIAL: "0",
  MARKIE_SIGNUP: "open",
  MARKIE_ACCOUNT_IDENTITIES: "1",
  DB_PATH: join(dir, "t.db"),
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "markie-mobile-auth-test-secret-32-plus-chars",
  MARKIE_MAIL_LOG: "1",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  APPLE_CLIENT_ID: APPLE_CLIENT,
  APPLE_TEAM_ID: "TEAMID1234",
  APPLE_KEY_ID: "KEYID12345",
  APPLE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\\n"),
  MARKIE_NO_LISTEN: "1",
});

// Every line the server logs while these tests run, to prove no credential
// is ever written to one.
const logged: string[] = [];
const originalConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
for (const level of ["log", "error", "warn", "info"] as const) {
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((arg) => (arg instanceof Error ? `${arg.stack ?? arg.message}` : typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
  };
}

let googleEmail = "";
let appleClaims: Record<string, unknown> = {};
const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const now = Math.floor(Date.now() / 1000);
  if (url === "https://oauth2.googleapis.com/token") {
    const idToken = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iss: "https://accounts.google.com", aud: "google-client-id", sub: `google-${googleEmail}`,
      email: googleEmail, email_verified: true, name: "Google Person", iat: now, exp: now + 3600,
    })}.signature`;
    return Response.json({ access_token: "ya29.test", id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: "openid email profile" });
  }
  if (url === `${APPLE}/auth/token`) {
    const idToken = `${b64url({ alg: "RS256", kid: "apple-test" })}.${b64url({ iss: APPLE, aud: APPLE_CLIENT, iat: now, exp: now + 600, ...appleClaims })}.signature`;
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
const {
  MOBILE_HANDOFF_TTL_MS, createMobileHandoffStore, mobileChallenge, mobileProvider, mobileRefusal,
  mobileRefusalLink, mobileReturnLink, mobileState,
} = await import("./mobile-auth.ts");
const db = new Database(process.env.DB_PATH!);

test.after(() => {
  Object.assign(console, originalConsole);
  globalThis.fetch = originalFetch;
});

// Every redirect and every page the browser was shown, for the same proof.
const shown: string[] = [];
let ip = 0;
const req = async (path: string, init: RequestInit = {}, origin: string | null = ORIGIN) => {
  const headers = new Headers(init.headers);
  if (origin) headers.set("Origin", origin);
  headers.set("x-forwarded-for", `10.7.0.${++ip % 250}`);
  const response = await app.request(path, { ...init, headers });
  const location = response.headers.get("location");
  if (location) shown.push(location);
  if ((response.headers.get("content-type") ?? "").includes("text/html")) shown.push(await response.clone().text());
  return response;
};
const cookiesOf = (response: Response) => response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** What the app makes before it opens the browser. */
function phone() {
  const verifier = randomBytes(32).toString("hex");
  return { verifier, challenge: sha256(verifier), state: randomBytes(16).toString("hex") };
}
type Phone = ReturnType<typeof phone>;

const startPath = (p: Phone, provider = "google") => `/auth/mobile-start?provider=${provider}&challenge=${p.challenge}&state=${p.state}`;

/** The browser's whole trip through Google: start, consent, callback, bridge. */
async function googleTrip(p: Phone, email: string): Promise<{ page: Response; html: string; cookies: string }> {
  googleEmail = email;
  const start = await req(startPath(p));
  assert.equal(start.status, 302, await start.clone().text());
  const consent = new URL(start.headers.get("location")!);
  assert.equal(`${consent.origin}${consent.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(consent.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/google`);
  const callback = await req(`/api/auth/callback/google?code=test-code&state=${encodeURIComponent(consent.searchParams.get("state")!)}`, { headers: { Cookie: cookiesOf(start) } });
  assert.equal(callback.status, 302, await callback.clone().text());
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.origin, ORIGIN);
  assert.equal(landed.pathname, "/auth/mobile-bridge");
  const cookies = cookiesOf(callback);
  const page = await req(`${landed.pathname}${landed.search}`, { headers: { Cookie: cookies } });
  return { page, html: await page.clone().text(), cookies };
}

/** The one link on the bridge page: what the person taps to go back to the app. */
function linkOn(html: string): URL {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).filter((href) => !href.startsWith("/") && !href.startsWith("data:"));
  const app = hrefs.filter((href) => href.startsWith("markie-mobile://"));
  assert.equal(app.length, 1, `one link back to the app, got ${JSON.stringify(hrefs)}`);
  return new URL(app[0]);
}

const exchange = (body: unknown) =>
  req("/auth/mobile-exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }, null);

async function refused(response: Response): Promise<void> {
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_handoff" });
  assert.equal(response.headers.get("set-auth-token"), null);
  assert.equal(response.headers.getSetCookie().length, 0);
}

const sessionTokens = () => (db.prepare('SELECT token FROM "session"').all() as { token: string }[]).map((row) => row.token);

test("the server says it can hand a sign-in back to the phone", async () => {
  const info = (await (await req("/api/server-info")).json()) as { signIn: Record<string, unknown> };
  assert.equal(info.signIn.mobile, true);
  assert.equal(info.signIn.google, true);
  assert.equal(info.signIn.apple, true);
});

test("Google signs the phone in: a code comes back through the link, and the session over HTTPS", async () => {
  const p = phone();
  const { page, html } = await googleTrip(p, "phone-google@example.org");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("cache-control") ?? "", /no-store/);
  assert.match(html, /Signed in as phone-google@example\.org/);
  assert.doesNotMatch(html, /<script/i, "the page never sends the browser on by itself");
  const link = linkOn(html);
  assert.equal(link.protocol, "markie-mobile:");
  assert.equal(link.host, "auth");
  assert.deepEqual([...link.searchParams.keys()].sort(), ["code", "iss", "state"]);
  assert.equal(link.searchParams.get("state"), p.state);
  assert.equal(link.searchParams.get("iss"), ORIGIN);

  const answer = await exchange({ client: "markie-mobile", code: link.searchParams.get("code"), verifier: p.verifier, state: p.state });
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.match(answer.headers.get("cache-control") ?? "", /no-store/);
  const { token, user } = (await answer.json()) as { token: string; user: { id: string; email: string; name: string } };
  assert.equal(user.email, "phone-google@example.org");
  assert.ok(user.id);
  const me = (await (await req("/api/me", { headers: { Authorization: `Bearer ${token}` } }, null)).json()) as { user: { email: string } | null };
  assert.equal(me.user?.email, "phone-google@example.org");
});

test("Apple signs the phone in the same way", async () => {
  const p = phone();
  const start = await req(startPath(p, "apple"));
  assert.equal(start.status, 302, await start.clone().text());
  const consent = new URL(start.headers.get("location")!);
  assert.equal(`${consent.origin}${consent.pathname}`, `${APPLE}/auth/authorize`);
  assert.equal(consent.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/apple`);
  appleClaims = { sub: "apple-phone-1", email: "phone-apple@example.org", email_verified: true };
  const form = new URLSearchParams({ code: "code-apple-phone-1", state: consent.searchParams.get("state")! });
  // Apple's cross-site form POST, then the GET better-auth turns it into.
  const posted = await req("/api/auth/callback/apple", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }, APPLE);
  assert.equal(posted.status, 302, await posted.clone().text());
  const get = new URL(posted.headers.get("location")!);
  const callback = await req(`${get.pathname}${get.search}`, { headers: { Cookie: cookiesOf(start) } });
  assert.equal(callback.status, 302, await callback.clone().text());
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.pathname, "/auth/mobile-bridge");
  const page = await req(`${landed.pathname}${landed.search}`, { headers: { Cookie: cookiesOf(callback) } });
  assert.equal(page.status, 200);
  const link = linkOn(await page.text());
  const answer = await exchange({ client: "markie-mobile", code: link.searchParams.get("code"), verifier: p.verifier, state: p.state });
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.equal(((await answer.json()) as { user: { email: string } }).user.email, "phone-apple@example.org");
});

test("a stolen link is useless: the code without the secret opens nothing, and trying spends it", async () => {
  const p = phone();
  const link = linkOn((await googleTrip(p, "stolen-link@example.org")).html);
  const code = link.searchParams.get("code")!;
  // Whoever holds the link has the code and the state, and guesses the rest.
  await refused(await exchange({ client: "markie-mobile", code, verifier: randomBytes(32).toString("hex"), state: p.state }));
  // The code went with that attempt, so even the real secret is now refused.
  await refused(await exchange({ client: "markie-mobile", code, verifier: p.verifier, state: p.state }));
});

test("no secret at all, or the challenge passed off as the secret, is refused", async () => {
  for (const verifier of [undefined, "", null, 42, "challenge"] as const) {
    const p = phone();
    const code = linkOn((await googleTrip(p, "no-secret@example.org")).html).searchParams.get("code")!;
    await refused(await exchange({ client: "markie-mobile", code, verifier: verifier === "challenge" ? p.challenge : verifier, state: p.state }));
  }
});

test("a code works once", async () => {
  const p = phone();
  const code = linkOn((await googleTrip(p, "one-use@example.org")).html).searchParams.get("code")!;
  const body = { client: "markie-mobile", code, verifier: p.verifier, state: p.state };
  assert.equal((await exchange(body)).status, 200);
  await refused(await exchange(body));
});

test("two requests racing for one code: only one gets the session", async () => {
  const p = phone();
  const code = linkOn((await googleTrip(p, "race@example.org")).html).searchParams.get("code")!;
  const body = { client: "markie-mobile", code, verifier: p.verifier, state: p.state };
  const statuses = (await Promise.all([exchange(body), exchange(body), exchange(body)])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400, 400]);
});

test("an expired code is refused, and is gone afterwards", async () => {
  const p = phone();
  const code = linkOn((await googleTrip(p, "expired@example.org")).html).searchParams.get("code")!;
  const row = db.prepare("SELECT expires_at AS expiresAt FROM mobile_handoffs WHERE code_hash = ?").get(sha256(code)) as { expiresAt: number };
  assert.ok(row.expiresAt > Date.now() && row.expiresAt <= Date.now() + MOBILE_HANDOFF_TTL_MS, "a code lives two minutes at most");
  db.prepare("UPDATE mobile_handoffs SET expires_at = ? WHERE code_hash = ?").run(Date.now() - 1, sha256(code));
  await refused(await exchange({ client: "markie-mobile", code, verifier: p.verifier, state: p.state }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mobile_handoffs WHERE code_hash = ?").get(sha256(code))!.n, 0);
});

test("a code for another client is refused: another phone's secret, another state, another client name", async () => {
  const mine = phone();
  const theirs = phone();
  const theirCode = linkOn((await googleTrip(theirs, "their-phone@example.org")).html).searchParams.get("code")!;
  // My secret and state against the code minted for their sign-in.
  await refused(await exchange({ client: "markie-mobile", code: theirCode, verifier: mine.verifier, state: mine.state }));

  const again = phone();
  const code = linkOn((await googleTrip(again, "their-phone@example.org")).html).searchParams.get("code")!;
  // The right secret with the wrong state.
  await refused(await exchange({ client: "markie-mobile", code, verifier: again.verifier, state: mine.state }));

  for (const client of ["markie", "markie-rs", "", undefined]) {
    const p = phone();
    const minted = linkOn((await googleTrip(p, "their-phone@example.org")).html).searchParams.get("code")!;
    await refused(await exchange({ client, code: minted, verifier: p.verifier, state: p.state }));
  }
});

test("the hand-off never goes to another scheme, and the desktop's link never goes to the phone's", async () => {
  // The phone's routes only ever write markie-mobile://auth.
  const p = phone();
  const { html } = await googleTrip(p, "scheme@example.org");
  assert.equal(linkOn(html).protocol, "markie-mobile:");
  assert.doesNotMatch(html, /markie:\/\/|markie-rs:\/\//);

  // The desktop bridge puts a session token in its link. Asking it for the
  // phone's scheme gets Markie's own, so no token rides markie-mobile://.
  googleEmail = "scheme@example.org";
  const start = await req("/auth/google-start?app=markie-mobile&state=0123456789abcdef0123456789abcdef");
  const consent = new URL(start.headers.get("location")!);
  const callback = await req(`/api/auth/callback/google?code=test-code&state=${encodeURIComponent(consent.searchParams.get("state")!)}`, { headers: { Cookie: cookiesOf(start) } });
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.pathname, "/auth/desktop-bridge");
  const desktopPage = await (await app.request(`${landed.pathname}${landed.search}&app=markie-mobile`, { headers: { Cookie: cookiesOf(callback), Origin: ORIGIN } })).text();
  assert.match(desktopPage, /markie:\/\/auth\?token=/);
  assert.doesNotMatch(desktopPage, /markie-mobile:\/\//);

  // The bridge mints nothing without a well-formed state and challenge, even
  // for a browser that has just signed in.
  for (const query of ["", `?state=${p.state}`, `?challenge=${p.challenge}`, "?state=zz&challenge=zz"]) {
    const page = await req(`/auth/mobile-bridge${query}`, { headers: { Cookie: cookiesOf(callback) } });
    assert.equal(page.status, 401);
    const back = linkOn(await page.text());
    assert.equal(back.searchParams.get("code"), null);
    assert.equal(back.searchParams.get("error"), "failed");
  }
});

test("a start with no challenge, a malformed one, or an unknown provider goes nowhere", async () => {
  const p = phone();
  for (const path of [
    `/auth/mobile-start?provider=google&state=${p.state}`,
    `/auth/mobile-start?provider=google&challenge=${p.challenge}`,
    `/auth/mobile-start?provider=google&challenge=${p.challenge.toUpperCase()}&state=${p.state}`,
    `/auth/mobile-start?provider=google&challenge=${p.challenge}%22%3E%3Cscript%3E&state=${p.state}`,
    `/auth/mobile-start?provider=google&challenge=${p.challenge}&state=short`,
  ]) {
    const response = await req(path);
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("location"), null);
  }
  for (const provider of ["github", "", "Google", "google%20"]) {
    const response = await req(`/auth/mobile-start?provider=${provider}&challenge=${p.challenge}&state=${p.state}`);
    assert.equal(response.status, 404, provider);
    assert.equal(response.headers.get("location"), null);
  }
});

test("an old browser session does not become a phone session without the provider step", async () => {
  const p = phone();
  const { cookies } = await googleTrip(p, "stale-cookie@example.org");
  db.prepare('UPDATE "session" SET createdAt = ? WHERE userId = (SELECT id FROM "user" WHERE email = ?)').run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), "stale-cookie@example.org");
  const other = phone();
  const page = await req(`/auth/mobile-bridge?provider=google&state=${other.state}&challenge=${other.challenge}`, { headers: { Cookie: cookies } });
  assert.equal(page.status, 401);
  assert.equal(linkOn(await page.text()).searchParams.get("code"), null);
});

test("a sign-in that ended before the app came back is refused", async () => {
  const p = phone();
  const code = linkOn((await googleTrip(p, "signed-out@example.org")).html).searchParams.get("code")!;
  db.prepare('DELETE FROM "session" WHERE userId = (SELECT id FROM "user" WHERE email = ?)').run("signed-out@example.org");
  await refused(await exchange({ client: "markie-mobile", code, verifier: p.verifier, state: p.state }));
});

test("a refused sign-in sends the app a reason and no code", async () => {
  // An address that already has an email account is not joined by Google.
  const email = "email-first@example.org";
  const created = await req("/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Email first", email, password: "password-123" }) }, "app://markie");
  assert.equal(created.status, 200);
  markVerified(email);
  const p = phone();
  const { page, html } = await googleTrip(p, email);
  assert.equal(page.status, 401);
  assert.match(html, /Google isn&#39;t linked to this account yet/);
  const back = linkOn(html);
  assert.deepEqual([...back.searchParams.keys()].sort(), ["error", "iss", "state"]);
  assert.equal(back.searchParams.get("error"), "account_not_linked");
  assert.equal(back.searchParams.get("state"), p.state);
  // A reason the server does not know is never reflected into the link.
  const odd = await req(`/auth/mobile-bridge?provider=google&state=${p.state}&challenge=${p.challenge}&error=%22%3E%3Cscript%3Ealert(1)%3C/script%3E`);
  const oddHtml = await odd.text();
  assert.equal(linkOn(oddHtml).searchParams.get("error"), "failed");
  assert.doesNotMatch(oddHtml, /<script/i);
});

test("the exchange refuses anything that is not its own JSON", async () => {
  await refused(await exchange("not json"));
  await refused(await exchange("null"));
  await refused(await exchange("[]"));
  await refused(await exchange({}));
  await refused(await exchange({ client: "markie-mobile", code: "x".repeat(43), verifier: "0".repeat(64), state: "0".repeat(32) }));
  const viaGet = await req("/auth/mobile-exchange?code=x", {}, null);
  assert.equal(viaGet.status, 404);
});

test("the store: only a hash is kept, and the pieces are checked one by one", () => {
  const memory = new Database(":memory:");
  let clock = 1_000_000;
  const store = createMobileHandoffStore(memory, () => clock);
  const p = phone();
  const input = { challenge: p.challenge, state: p.state, sessionId: "session-1" };
  const good = (code: string) => ({ client: "markie-mobile", code, verifier: p.verifier, state: p.state });

  const code = store.issue(input);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const rows = memory.prepare("SELECT * FROM mobile_handoffs").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes(code), false, "the code itself is not stored");
  assert.equal(rows[0].code_hash, sha256(code));
  assert.equal(store.redeem(good(code)), "session-1");
  assert.equal(store.redeem(good(code)), null, "spent");

  clock = 2_000_000;
  const late = store.issue(input);
  clock += MOBILE_HANDOFF_TTL_MS;
  assert.equal(store.redeem(good(late)), null, "expired on the dot");

  const early = store.issue(input);
  clock += MOBILE_HANDOFF_TTL_MS - 1;
  assert.equal(store.redeem(good(early)), "session-1", "good until the last millisecond");

  // Issuing sweeps what has expired, so abandoned sign-ins do not pile up.
  store.issue(input);
  clock += MOBILE_HANDOFF_TTL_MS + 1;
  store.issue(input);
  assert.equal((memory.prepare("SELECT COUNT(*) AS n FROM mobile_handoffs").get() as { n: number }).n, 1);

  for (const bad of [null, undefined, 7, "", "short", `${code}x`, { code }]) {
    assert.equal(store.redeem({ client: "markie-mobile", code: bad, verifier: p.verifier, state: p.state }), null);
  }
});

test("only the shapes the app makes are accepted, and links are built from nothing else", () => {
  const p = phone();
  assert.equal(mobileChallenge(p.challenge), p.challenge);
  assert.equal(mobileState(p.state), p.state);
  for (const bad of [null, undefined, "", "abc", p.challenge.toUpperCase(), `${p.challenge}0`, `${p.challenge.slice(1)}&`, 5]) {
    assert.equal(mobileChallenge(bad), null, String(bad));
  }
  for (const bad of [null, undefined, "", "abcdef01", "g".repeat(32), "a".repeat(65), "a".repeat(31)]) {
    assert.equal(mobileState(bad), null, String(bad));
  }
  assert.equal(mobileProvider("google"), "google");
  assert.equal(mobileProvider("apple"), "apple");
  for (const bad of [null, "", "Google", "github", "apple "]) assert.equal(mobileProvider(bad), null);
  assert.equal(mobileRefusal("account_not_linked"), "account_not_linked");
  assert.equal(mobileRefusal("anything else"), "failed");
  assert.equal(mobileRefusal(undefined), "failed");
  assert.equal(mobileReturnLink("c-_d", p.state, "https://docs.example.com"), `markie-mobile://auth?code=c-_d&state=${p.state}&iss=https%3A%2F%2Fdocs.example.com`);
  assert.equal(mobileRefusalLink("failed", null, null), "markie-mobile://auth?error=failed");
});

// Last on purpose: it reads what every test above put on the wire and in the log.
test("no session token is ever in a redirect, a page, or a log line", () => {
  const tokens = sessionTokens();
  assert.ok(tokens.length >= 5, "the flows above made real sessions");
  assert.ok(shown.length >= 20, "and the browser was shown real redirects and pages");
  for (const token of tokens) {
    for (const seen of shown) assert.equal(seen.includes(token), false, "a session token reached the browser");
    for (const line of logged) assert.equal(line.includes(token), false, "a session token reached the log");
  }
  // The mobile link shape, wherever it appeared, never had a token on it.
  for (const seen of shown) assert.doesNotMatch(seen, /markie-mobile:\/\/[^"'\s]*token/);
});
