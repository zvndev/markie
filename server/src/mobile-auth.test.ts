// The phone app's Google and Apple sign-in (mobile-auth.ts), end to end
// through the real better-auth providers. Google and Apple are answered
// locally: their token endpoints are stubs and Apple's key is a throwaway
// made here. Nothing reaches either of them.
//
// What this pins: the link back to the app carries a one-use code and never a
// session token; a code only ever comes from a sign-in /auth/mobile-start
// opened and its own provider callback finished; the browser is left with no
// session; the code is worth nothing without the secret the app kept; and
// every other way of spending it is refused.
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
  MOBILE_BROWSER_COOKIE, MOBILE_BROWSER_COOKIE_DEV, MOBILE_EXCHANGE_BODY_MAX, MOBILE_HANDOFF_TTL_MS, MOBILE_PAGE_CSP, MOBILE_PENDING_MAX,
  MOBILE_PENDING_PER_ADDRESS, MOBILE_RATE, MOBILE_SIGN_IN_TTL_MS, addressBucket, createMobileAuth, mobileBrowserCookie, createMobileHandoffStore, createRateLimiter, mobileChallenge, mobileProvider, mobileRefusal,
  mobileRefusalLink, mobileReturnLink, mobileState, readSmallJson,
} = await import("./mobile-auth.ts");
const { verifiedReturnOrigin } = await import("./well-known.ts");
const db = new Database(process.env.DB_PATH!);
// Every session token this server ever makes, kept even after the session is
// ended, so the last test can look for each of them on the wire.
db.exec("CREATE TABLE test_seen_tokens (token TEXT NOT NULL, user_id TEXT NOT NULL)");
db.exec('CREATE TRIGGER test_see_token AFTER INSERT ON "session" BEGIN INSERT INTO test_seen_tokens VALUES (NEW.token, NEW.userId); END');

test.after(() => {
  Object.assign(console, originalConsole);
  globalThis.fetch = originalFetch;
});

// Every redirect, page and response header a phone sign-in put on the wire,
// for the last test's proof that no session token was ever among them.
const shown: string[] = [];
let ip = 0;
const req = async (path: string, init: RequestInit = {}, origin: string | null = ORIGIN, record = true) => {
  const headers = new Headers(init.headers);
  if (origin) headers.set("Origin", origin);
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", `10.7.0.${++ip % 250}`);
  const response = await app.request(path, { ...init, headers });
  if (record) {
    shown.push(JSON.stringify([...response.headers.entries()]));
    shown.push(response.headers.getSetCookie().join("\n"));
    if ((response.headers.get("content-type") ?? "").includes("text/html")) shown.push(await response.clone().text());
  }
  return response;
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** One browser: it keeps the cookies it is given and sends them back. */
class Browser {
  jar = new Map<string, string>();
  cookies(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  /** `record: false` for a trip that is not a phone sign-in (a desktop one sets a session cookie on purpose). */
  async visit(path: string, init: RequestInit = {}, { origin = ORIGIN as string | null, record = true } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("Cookie", this.cookies());
    const response = await req(path, { ...init, headers }, origin, record);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!value || attributes.some((attribute) => /^\s*max-age=0$/i.test(attribute))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }
}

/** What the app makes before it opens the browser. */
function phone() {
  const verifier = randomBytes(32).toString("hex");
  return { verifier, challenge: sha256(verifier), state: randomBytes(16).toString("hex") };
}
type Phone = ReturnType<typeof phone>;

const startPath = (p: Phone, provider = "google") => `/auth/mobile-start?provider=${provider}&challenge=${p.challenge}&state=${p.state}`;

/** Opens a sign-in and stops at Google's consent screen. */
async function googleStart(browser: Browser, p: Phone): Promise<{ consent: URL; callbackPath: string }> {
  const start = await browser.visit(startPath(p));
  assert.equal(start.status, 302, await start.clone().text());
  const consent = new URL(start.headers.get("location")!);
  assert.equal(`${consent.origin}${consent.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(consent.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/google`);
  return { consent, callbackPath: `/api/auth/callback/google?code=test-code&state=${encodeURIComponent(consent.searchParams.get("state")!)}` };
}

/** The browser's whole trip through Google: start, consent, callback, bridge. */
async function googleTrip(p: Phone, email: string, browser = new Browser()): Promise<{ page: Response; html: string; browser: Browser; callback: Response }> {
  const { callbackPath } = await googleStart(browser, p);
  googleEmail = email;
  const callback = await browser.visit(callbackPath);
  assert.equal(callback.status, 302, await callback.clone().text());
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.origin, ORIGIN);
  assert.equal(landed.pathname, "/auth/mobile-bridge");
  const page = await browser.visit(`${landed.pathname}${landed.search}`);
  return { page, html: await page.clone().text(), browser, callback };
}

/** An ordinary desktop Google sign-in in this browser: it leaves a real session cookie. */
async function desktopSignIn(browser: Browser, email: string): Promise<void> {
  googleEmail = email;
  const start = await browser.visit("/auth/google-start?state=0123456789abcdef0123456789abcdef", {}, { record: false });
  const consent = new URL(start.headers.get("location")!);
  const callback = await browser.visit(`/api/auth/callback/google?code=test-code&state=${encodeURIComponent(consent.searchParams.get("state")!)}`, {}, { record: false });
  assert.equal(new URL(callback.headers.get("location")!, ORIGIN).pathname, "/auth/desktop-bridge");
  const me = (await (await browser.visit("/api/me", {}, { record: false })).json()) as { user: { email: string } | null };
  assert.equal(me.user?.email, email, "the browser really is signed in");
}

/** The one link on the bridge page: what the person taps to go back to the app. */
function linkOn(html: string, prefix = "markie-mobile://"): URL {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).filter((href) => !href.startsWith("/") && !href.startsWith("data:"));
  const app = hrefs.filter((href) => href.startsWith(prefix));
  assert.equal(app.length, 1, `one link back to the app, got ${JSON.stringify(hrefs)}`);
  return new URL(app[0]);
}

/** A page that offers no code: a refusal, with nothing to trade. */
async function noCode(page: Response): Promise<URL> {
  assert.equal(page.status, 401);
  const html = await page.text();
  assert.doesNotMatch(html, /code=/);
  const back = linkOn(html);
  assert.equal(back.searchParams.get("code"), null);
  return back;
}

const exchange = (body: unknown, headers: Record<string, string> = {}) =>
  req("/auth/mobile-exchange", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, null);

async function refused(response: Response): Promise<void> {
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_handoff" });
  assert.equal(response.headers.get("set-auth-token"), null);
  assert.equal(response.headers.getSetCookie().length, 0);
}

const userId = (email: string) => (db.prepare('SELECT id FROM "user" WHERE email = ?').get(email) as { id: string } | undefined)?.id ?? "";
const liveSessions = (email: string) => (db.prepare('SELECT token FROM "session" WHERE userId = ?').all(userId(email)) as { token: string }[]).map((row) => row.token);
const everyToken = (email?: string) =>
  (email
    ? (db.prepare("SELECT token FROM test_seen_tokens WHERE user_id = ?").all(userId(email)) as { token: string }[])
    : (db.prepare("SELECT token FROM test_seen_tokens").all() as { token: string }[])
  ).map((row) => row.token);
const statusOf = (p: Phone) => (db.prepare("SELECT status FROM mobile_sign_ins WHERE state = ?").get(p.state) as { status: string } | undefined)?.status ?? null;
const signInRows = () => (db.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins").get() as { n: number }).n;

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
  assert.equal(answer.headers.getSetCookie().length, 0);
  const { token, user } = (await answer.json()) as { token: string; user: { id: string; email: string; name: string } };
  assert.equal(user.email, "phone-google@example.org");
  assert.ok(user.id);
  const me = (await (await req("/api/me", { headers: { Authorization: `Bearer ${token}` } }, null)).json()) as { user: { email: string } | null };
  assert.equal(me.user?.email, "phone-google@example.org");
});

test("Apple signs the phone in the same way", async () => {
  const p = phone();
  const browser = new Browser();
  const start = await browser.visit(startPath(p, "apple"));
  assert.equal(start.status, 302, await start.clone().text());
  const consent = new URL(start.headers.get("location")!);
  assert.equal(`${consent.origin}${consent.pathname}`, `${APPLE}/auth/authorize`);
  assert.equal(consent.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/apple`);
  appleClaims = { sub: "apple-phone-1", email: "phone-apple@example.org", email_verified: true };
  const form = new URLSearchParams({ code: "code-apple-phone-1", state: consent.searchParams.get("state")! });
  // Apple's cross-site form POST (no cookies ride it), then the GET better-auth turns it into.
  const posted = await req("/api/auth/callback/apple", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }, APPLE);
  assert.equal(posted.status, 302, await posted.clone().text());
  const get = new URL(posted.headers.get("location")!);
  const callback = await browser.visit(`${get.pathname}${get.search}`);
  assert.equal(callback.status, 302, await callback.clone().text());
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.pathname, "/auth/mobile-bridge");
  const page = await browser.visit(`${landed.pathname}${landed.search}`);
  assert.equal(page.status, 200);
  const link = linkOn(await page.text());
  const answer = await exchange({ client: "markie-mobile", code: link.searchParams.get("code"), verifier: p.verifier, state: p.state });
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.equal(((await answer.json()) as { user: { email: string } }).user.email, "phone-apple@example.org");
  assert.equal(liveSessions("phone-apple@example.org").length, 1, "the app's session, and none left for the browser");
});

test("a browser that just signed in for something else cannot mint a hand-off, whatever challenge it is handed", async () => {
  // The person signed in to Markie in this browser a moment ago, for the
  // desktop app. Their session cookie is fresh and perfectly good.
  const browser = new Browser();
  await desktopSignIn(browser, "bystander@example.org");
  const before = liveSessions("bystander@example.org");
  assert.equal(before.length, 1);

  // Another app sends that browser straight to the bridge with a challenge
  // of its own. No sign-in was opened, so there is nothing to mint from.
  const theirs = phone();
  for (const query of ["", "?provider=google", `?provider=google&state=${theirs.state}&challenge=${theirs.challenge}`]) {
    const back = await noCode(await browser.visit(`/auth/mobile-bridge${query}`));
    assert.equal(back.searchParams.get("error"), "failed");
    assert.equal(back.searchParams.get("state"), null);
  }

  // It opens a real sign-in in that browser, with its own challenge, and
  // skips the provider: straight to the bridge. The sign-in is open but no
  // callback finished it, and the session already in the browser counts for
  // nothing.
  await googleStart(browser, theirs);
  assert.ok(browser.jar.has(MOBILE_BROWSER_COOKIE));
  const back = await noCode(await browser.visit("/auth/mobile-bridge?provider=google"));
  assert.equal(back.searchParams.get("error"), "failed");
  assert.equal(back.searchParams.get("state"), null);
  assert.equal(statusOf(theirs), "started", "the sign-in is still where it was: nobody signed in for it");
  // The bystander's own session is untouched, and still only theirs.
  assert.deepEqual(liveSessions("bystander@example.org"), before);
});

test("a callback finishes only the sign-in it was started for", async () => {
  // Two phones, two browsers, two sign-ins under way.
  const mine = phone();
  const theirs = phone();
  const myBrowser = new Browser();
  const theirBrowser = new Browser();
  await googleStart(myBrowser, mine);
  const their = await googleStart(theirBrowser, theirs);

  // Their provider answer, delivered to my browser. better-auth refuses it
  // (the state is not this browser's), and my sign-in stays unfinished.
  googleEmail = "callback-theirs@example.org";
  const swapped = await myBrowser.visit(their.callbackPath);
  assert.equal(swapped.status, 302);
  const refusal = new URL(swapped.headers.get("location")!, ORIGIN);
  assert.ok(refusal.pathname !== "/auth/mobile-bridge" || refusal.searchParams.has("error"), "a refused callback comes back as an error, if it comes back at all");
  assert.equal(userId("callback-theirs@example.org"), "", "and it signed nobody in");
  await noCode(await myBrowser.visit(`${refusal.pathname}${refusal.search}`));
  await noCode(await myBrowser.visit("/auth/mobile-bridge?provider=google"));
  // Neither sign-in was touched by it: both are still waiting on their own callback.
  assert.equal(statusOf(mine), "started");
  assert.equal(statusOf(theirs), "started");

  // Their own callback, in their own browser, still works: once.
  const callback = await theirBrowser.visit(their.callbackPath);
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.pathname, "/auth/mobile-bridge");
  // Played again before the bridge is even opened: better-auth has spent the
  // state, and the sign-in is not marked twice or for anyone else.
  googleEmail = "callback-replayed@example.org";
  const replay = new URL((await new Browser().visit(their.callbackPath)).headers.get("location")!, ORIGIN);
  assert.ok(replay.pathname !== "/auth/mobile-bridge" || replay.searchParams.has("error"));
  assert.equal(userId("callback-replayed@example.org"), "", "the replay signed nobody in");

  const page = await theirBrowser.visit(`${landed.pathname}${landed.search}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Signed in as callback-theirs@example\.org/);
  const code = linkOn(html).searchParams.get("code")!;
  // The page is good for one code. Asking again gets none.
  await noCode(await theirBrowser.visit(`${landed.pathname}${landed.search}`));
  assert.equal((await exchange({ client: "markie-mobile", code, verifier: theirs.verifier, state: theirs.state })).status, 200);
});

test("a provider sign-in that names the bridge but was not opened by /auth/mobile-start finishes nothing", async () => {
  // A sign-in is open in this browser, waiting on its own trip to Google.
  const p = phone();
  const browser = new Browser();
  await googleStart(browser, p);
  // A second provider flow, started through better-auth's own API and aimed
  // at the bridge. It is a real, successful Google sign-in, in the same
  // browser, and it is not the flow the open sign-in is waiting on.
  const other = await browser.visit("/api/auth/sign-in/social", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: `${ORIGIN}/auth/mobile-bridge?provider=google`, disableRedirect: true }),
  });
  assert.equal(other.status, 200, await other.clone().text());
  const consent = new URL(((await other.json()) as { url: string }).url);
  googleEmail = "side-door@example.org";
  const callback = await browser.visit(`/api/auth/callback/google?code=test-code&state=${encodeURIComponent(consent.searchParams.get("state")!)}`);
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.pathname, "/auth/mobile-bridge");
  // The session it made is ended and never reached the browser.
  assert.ok(userId("side-door@example.org"));
  assert.deepEqual(liveSessions("side-door@example.org"), []);
  assert.equal(callback.headers.getSetCookie().some((cookie) => !/max-age=0/i.test(cookie)), false);
  // And the open sign-in was not finished by it.
  await noCode(await browser.visit(`${landed.pathname}${landed.search}`));
  assert.equal(statusOf(p), "started");
});

test("a callback that arrives in another browser finishes nothing, even with better-auth's own state cookie planted there", async () => {
  // Someone opens a sign-in with their own challenge, in their own browser.
  const starter = phone();
  const theirBrowser = new Browser();
  const { callbackPath } = await googleStart(theirBrowser, starter);
  // They get their better-auth state cookie into another person's browser: a
  // script on a sibling name can set a cookie for the whole parent domain.
  // Our cookie is host-only and prefixed, so it cannot be planted that way,
  // and the other person's browser does not have it.
  const victim = new Browser();
  for (const [name, value] of theirBrowser.jar) if (name !== MOBILE_BROWSER_COOKIE) victim.jar.set(name, value);
  assert.ok(victim.jar.size >= 1, "better-auth's state cookie was copied over");
  assert.equal(victim.jar.has(MOBILE_BROWSER_COOKIE), false);
  // The other person follows the provider link and signs in.
  googleEmail = "led-astray@example.org";
  const callback = await victim.visit(callbackPath);
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.pathname, "/auth/mobile-bridge", "better-auth itself accepted the callback");
  assert.ok(userId("led-astray@example.org"), "and signed them in");
  // Their account is not attached to the starter's sign-in, the session is
  // ended, and nobody gets a code: not their browser, not the starter's.
  assert.deepEqual(liveSessions("led-astray@example.org"), []);
  assert.equal(statusOf(starter), "started");
  await noCode(await victim.visit(`${landed.pathname}${landed.search}`));
  await noCode(await theirBrowser.visit("/auth/mobile-bridge?provider=google"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins WHERE user_id = ?").get(userId("led-astray@example.org"))!.n, 0);

  // The same with a sign-in of the other person's own open in their browser:
  // the flow is the starter's and the cookie is theirs, so neither row moves.
  const again = phone();
  const second = await googleStart(theirBrowser, again);
  const own = phone();
  const busyVictim = new Browser();
  await googleStart(busyVictim, own);
  for (const [name, value] of theirBrowser.jar) if (name !== MOBILE_BROWSER_COOKIE) busyVictim.jar.set(name, value);
  googleEmail = "led-astray@example.org";
  await busyVictim.visit(second.callbackPath);
  assert.equal(statusOf(again), "started");
  assert.equal(statusOf(own), "started");
  await noCode(await theirBrowser.visit("/auth/mobile-bridge?provider=google"));
  await noCode(await busyVictim.visit("/auth/mobile-bridge?provider=google"));
  assert.deepEqual(liveSessions("led-astray@example.org"), []);
});

test("the browser's cookie is bound to this host: prefixed, Secure, for every path, with no Domain", async () => {
  const start = await req(startPath(phone()));
  const ours = start.headers.getSetCookie().filter((cookie) => cookie.includes("markie_mobile_sign_in"));
  assert.equal(ours.length, 1);
  assert.match(ours[0], /^__Host-markie_mobile_sign_in=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
  assert.doesNotMatch(ours[0], /domain/i);

  assert.deepEqual(mobileBrowserCookie("https://api.markiedocs.com"), { name: MOBILE_BROWSER_COOKIE, secure: true });
  assert.deepEqual(mobileBrowserCookie("https://markie.example.com"), { name: MOBILE_BROWSER_COOKIE, secure: true });
  // Development on this machine: a browser will not take __Host- over plain HTTP.
  for (const local of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
    assert.deepEqual(mobileBrowserCookie(local), { name: MOBILE_BROWSER_COOKIE_DEV, secure: false }, local);
  }
  // Plain HTTP anywhere else keeps the prefixed, Secure cookie, which a
  // browser refuses: the sign-in fails closed there.
  for (const elsewhere of ["http://markie.lan", "http://192.168.1.20:8787", "http://localhost.evil.example"]) {
    assert.deepEqual(mobileBrowserCookie(elsewhere), { name: MOBILE_BROWSER_COOKIE, secure: true }, elsewhere);
  }

  // A development server reads and clears the plain name, and only that one.
  const id = userId("phone-google@example.org");
  const store = createMobileHandoffStore(new Database(":memory:"));
  const dev = createMobileAuth({ authBase: "http://localhost:8787", issuer: "http://localhost:8787", google: true, apple: false, store, sweepEveryMs: 0 });
  const p = phone();
  const browser = store.start({ provider: "google", challenge: p.challenge, state: p.state, flow: "flow-dev", address: "127.0.0.1" })!;
  assert.equal(store.complete({ flow: "flow-dev", browser, userId: id }), true);
  const wrongName = await dev.app.request("/auth/mobile-bridge", { headers: { Cookie: `${MOBILE_BROWSER_COOKIE}=${browser}` } });
  assert.equal(wrongName.status, 401);
  const page = await dev.app.request("/auth/mobile-bridge", { headers: { Cookie: `${MOBILE_BROWSER_COOKIE_DEV}=${browser}` } });
  assert.equal(page.status, 200);
  assert.deepEqual(page.headers.getSetCookie(), ["markie_mobile_sign_in=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"]);
});

test("a page elsewhere that sends the browser to the bridge cannot cancel a sign-in under way", async () => {
  const p = phone();
  const browser = new Browser();
  const { callbackPath } = await googleStart(browser, p);
  // Top-level navigations from another site: the Lax cookie rides along.
  for (const path of ["/auth/mobile-bridge", "/auth/mobile-bridge?provider=google&error=failed", "/auth/mobile-bridge?error=signup_closed"]) {
    const response = await browser.visit(path);
    const back = await noCode(response);
    assert.equal(back.searchParams.get("error"), "failed", "whatever the address says, the page reports nothing it did not read from the sign-in");
    assert.equal(back.searchParams.get("state"), null);
    assert.equal(response.headers.getSetCookie().length, 0, "and the cookie is left alone");
  }
  assert.equal(statusOf(p), "started");
  assert.ok(browser.jar.has(MOBILE_BROWSER_COOKIE));
  // The person comes back from Google and the sign-in finishes as if nothing happened.
  googleEmail = "not-cancelled@example.org";
  const callback = await browser.visit(callbackPath);
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  const page = await browser.visit(`${landed.pathname}${landed.search}`);
  assert.equal(page.status, 200);
  const code = linkOn(await page.text()).searchParams.get("code")!;
  assert.equal((await exchange({ client: "markie-mobile", code, verifier: p.verifier, state: p.state })).status, 200);
});

test("the bridge and return pages run nothing, load nothing from elsewhere, and cannot be framed", async () => {
  assert.equal(MOBILE_PAGE_CSP, "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const { page, html } = await googleTrip(phone(), "page-policy@example.org");
  const pages: [string, Response, string][] = [
    ["the return page", page, html],
    ["a refusal", ...(await (async () => { const r = await req("/auth/mobile-bridge"); return [r, await r.clone().text()] as const; })())],
    ["the page behind the verified link", ...(await (async () => { const r = await req("/auth/mobile-return"); return [r, await r.clone().text()] as const; })())],
  ];
  for (const [name, response, body] of pages) {
    assert.equal(response.headers.get("content-security-policy"), MOBILE_PAGE_CSP, name);
    assert.equal(response.headers.get("x-frame-options"), "DENY", name);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", name);
    assert.equal(response.headers.get("cache-control"), "private, no-store", name);
    assert.doesNotMatch(body, /<script|<iframe|<form|<link[^>]+href="https?:|src="https?:|url\(https?:/i, name);
  }
});

test("the browser is left with no session: the one the provider step made is ended before the page is shown", async () => {
  const p = phone();
  const email = "no-browser-session@example.org";
  const { html, browser, callback } = await googleTrip(p, email);
  // The callback set nothing: every cookie on it is one being cleared, and
  // the header better-auth's bearer plugin puts a new session in is not there.
  for (const cookie of callback.headers.getSetCookie()) assert.match(cookie, /max-age=0/i, cookie);
  assert.equal(callback.headers.get("set-auth-token"), null);
  assert.deepEqual([...browser.jar.keys()], [], "the browser holds no cookie from the trip");
  // A session was made for the provider step, and it is already gone.
  const made = everyToken(email);
  assert.equal(made.length, 1);
  assert.deepEqual(liveSessions(email), []);
  // The desktop bridge has nothing to hand on: not for this browser, and not
  // for anyone holding the ended session's token.
  for (const headers of [{ Cookie: browser.cookies() }, { Authorization: `Bearer ${made[0]}` }] as Record<string, string>[]) {
    const desktop = await req("/auth/desktop-bridge?state=0123456789abcdef0123456789abcdef", { headers });
    assert.equal(desktop.status, 401);
    assert.doesNotMatch(await desktop.text(), /markie(?:-rs)?:\/\/auth\?token=/);
    const me = (await (await req("/api/me", { headers }, null)).json()) as { user: unknown };
    assert.equal(me.user, null);
  }
  // The app's session is a new one, made at the exchange, and the only one.
  const answer = await exchange({ client: "markie-mobile", code: linkOn(html).searchParams.get("code"), verifier: p.verifier, state: p.state });
  assert.equal(answer.status, 200);
  const { token } = (await answer.json()) as { token: string };
  assert.notEqual(token, made[0]);
  assert.deepEqual(liveSessions(email), [token]);
});

test("a phone sign-in leaves a session the browser already had alone", async () => {
  const browser = new Browser();
  await desktopSignIn(browser, "web-reader@example.org");
  const [mine] = liveSessions("web-reader@example.org");
  const cookiesBefore = browser.cookies();
  const p = phone();
  const { page } = await googleTrip(p, "phone-other@example.org", browser);
  assert.equal(page.status, 200);
  assert.equal(browser.cookies(), cookiesBefore, "the same cookies as before the phone sign-in");
  assert.deepEqual(liveSessions("web-reader@example.org"), [mine]);
  const me = (await (await browser.visit("/api/me", {}, { record: false })).json()) as { user: { email: string } | null };
  assert.equal(me.user?.email, "web-reader@example.org");
});

test("a stolen link is useless: the code without the secret opens nothing, and trying spends it", async () => {
  const p = phone();
  const link = linkOn((await googleTrip(p, "stolen-link@example.org")).html);
  const code = link.searchParams.get("code")!;
  // Whoever holds the link has the code and the state, and guesses the rest.
  await refused(await exchange({ client: "markie-mobile", code, verifier: randomBytes(32).toString("hex"), state: p.state }));
  // The code went with that attempt, so even the real secret is now refused.
  await refused(await exchange({ client: "markie-mobile", code, verifier: p.verifier, state: p.state }));
  assert.deepEqual(liveSessions("stolen-link@example.org"), []);
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
  assert.equal(liveSessions("race@example.org").length, 1);
});

test("an expired code is refused, and is gone afterwards", async () => {
  const p = phone();
  const code = linkOn((await googleTrip(p, "expired@example.org")).html).searchParams.get("code")!;
  const row = db.prepare("SELECT expires_at AS expiresAt FROM mobile_sign_ins WHERE code_hash = ?").get(sha256(code)) as { expiresAt: number };
  assert.ok(row.expiresAt > Date.now() && row.expiresAt <= Date.now() + MOBILE_HANDOFF_TTL_MS, "a code lives two minutes at most");
  db.prepare("UPDATE mobile_sign_ins SET expires_at = ? WHERE code_hash = ?").run(Date.now() - 1, sha256(code));
  await refused(await exchange({ client: "markie-mobile", code, verifier: p.verifier, state: p.state }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins WHERE code_hash = ?").get(sha256(code))!.n, 0);
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
  const browser = new Browser();
  const start = await browser.visit("/auth/google-start?app=markie-mobile&state=0123456789abcdef0123456789abcdef", {}, { record: false });
  const consent = new URL(start.headers.get("location")!);
  const callback = await browser.visit(`/api/auth/callback/google?code=test-code&state=${encodeURIComponent(consent.searchParams.get("state")!)}`, {}, { record: false });
  const landed = new URL(callback.headers.get("location")!, ORIGIN);
  assert.equal(landed.pathname, "/auth/desktop-bridge");
  // The desktop's own sign-in is as it was: the callback sets its session cookie.
  assert.ok(callback.headers.getSetCookie().some((cookie) => /session_token=[^;]+/.test(cookie) && !/max-age=0/i.test(cookie)));
  const desktopPage = await (await app.request(`${landed.pathname}${landed.search}&app=markie-mobile`, { headers: { Cookie: browser.cookies(), Origin: ORIGIN } })).text();
  assert.match(desktopPage, /markie:\/\/auth\?token=/);
  assert.doesNotMatch(desktopPage, /markie-mobile:\/\//);
});

test("a start with no challenge, a malformed one, or an unknown provider goes nowhere", async () => {
  const p = phone();
  const before = signInRows();
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
  assert.equal(signInRows(), before, "and none of them opened a sign-in");
});

test("starting again in the same browser replaces the sign-in that was waiting", async () => {
  const browser = new Browser();
  const first = phone();
  const second = phone();
  await googleStart(browser, first);
  await googleStart(browser, second);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins WHERE state = ?").get(first.state)!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins WHERE state = ?").get(second.state)!.n, 1);
});

test("an account removed before the app came back is refused", async () => {
  const p = phone();
  const code = linkOn((await googleTrip(p, "removed@example.org")).html).searchParams.get("code")!;
  const id = userId("removed@example.org");
  db.prepare('DELETE FROM "account" WHERE userId = ?').run(id);
  db.prepare('DELETE FROM "user" WHERE id = ?').run(id);
  await refused(await exchange({ client: "markie-mobile", code, verifier: p.verifier, state: p.state }));
});

test("a refused sign-in sends the app a reason and no code", async () => {
  // An address that already has an email account is not joined by Google.
  const email = "email-first@example.org";
  const created = await req("/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Email first", email, password: "password-123" }) }, "app://markie", false);
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins WHERE state = ?").get(p.state)!.n, 0, "the refused sign-in is over");
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

test("an oversized exchange body is refused before it is read", async () => {
  const big = JSON.stringify({ client: "markie-mobile", code: "x".repeat(43), verifier: "0".repeat(64), state: "0".repeat(32), pad: "p".repeat(MOBILE_EXCHANGE_BODY_MAX) });
  const declared = await exchange(big, { "Content-Length": String(Buffer.byteLength(big)) });
  assert.equal(declared.status, 413);
  assert.deepEqual(await declared.json(), { error: "body too large" });

  // No Content-Length: a stream that would go on for 64 MB. Reading stops at
  // the first chunk past the limit, and the rest is never pulled.
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 65536) controller.close();
      else controller.enqueue(new Uint8Array(1024).fill(0x20));
    },
  });
  const streamed = await app.request("/auth/mobile-exchange", {
    method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "10.9.9.9" }, body: endless, duplex: "half",
  } as RequestInit);
  assert.equal(streamed.status, 413);
  assert.ok(pulled <= 16, `stopped after ${pulled} KB of a 64 MB body`);

  const direct = await readSmallJson(new Request("https://x.example/", { method: "POST", body: "x".repeat(101) }), 100);
  assert.deepEqual(direct, { ok: false, reason: "too_large" });
  assert.deepEqual(await readSmallJson(new Request("https://x.example/", { method: "POST", body: '{"a":1}' }), 100), { ok: true, value: { a: 1 } });
});

test("each client address gets a fixed number of starts, bridge pages and exchanges a minute", async () => {
  const p = phone();
  const from = (address: string) => ({ headers: { "x-forwarded-for": address } });
  for (let i = 0; i < MOBILE_RATE.start; i += 1) assert.equal((await req(startPath(p), from("10.8.0.1"))).status, 302, `start ${i + 1}`);
  const tooMany = await req(startPath(p), from("10.8.0.1"));
  assert.equal(tooMany.status, 429);
  assert.equal(tooMany.headers.get("retry-after"), "60");
  assert.equal(tooMany.headers.get("location"), null);
  // Another address is not held back by the first one's tries.
  assert.equal((await req(startPath(p), from("10.8.0.2"))).status, 302);

  const body = JSON.stringify({ client: "markie-mobile", code: "x".repeat(43), verifier: "0".repeat(64), state: "0".repeat(32) });
  const post = () => req("/auth/mobile-exchange", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "10.8.0.3" }, body }, null);
  for (let i = 0; i < MOBILE_RATE.exchange; i += 1) assert.equal((await post()).status, 400);
  const limited = await post();
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "rate_limited" });

  // The exchange keeps its own count: an address that has used up its starts
  // can still finish a sign-in.
  assert.equal((await req(startPath(p), from("10.8.0.1"))).status, 429);
  assert.equal((await req("/auth/mobile-exchange", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "10.8.0.1" }, body }, null)).status, 400);

  // IPv6: every address in one /64 is one client, however many it rotates through.
  for (let i = 0; i < MOBILE_RATE.start; i += 1) {
    assert.equal((await req(startPath(p), from(`2001:db8:aa:bb:${i.toString(16)}::${(i * 7 + 1).toString(16)}`))).status, 302, `rotated start ${i + 1}`);
  }
  assert.equal((await req(startPath(p), from("2001:db8:aa:bb:ffff:ffff:ffff:ffff"))).status, 429);
  assert.equal((await req(startPath(p), from("2001:db8:aa:bc::1"))).status, 302, "the /64 next door is someone else");

  for (let i = 0; i < MOBILE_RATE.bridge; i += 1) assert.equal((await req("/auth/mobile-bridge", from("10.8.0.4"))).status, 401);
  assert.equal((await req("/auth/mobile-bridge", from("10.8.0.4"))).status, 429);
  assert.equal((await req("/auth/mobile-return", from("10.8.0.4"))).status, 429, "the return page shares the bridge's allowance");
});

test("the rate limiter: a window per key, and a full map drops its oldest key instead of turning a new one away", () => {
  let clock = 0;
  const limiter = createRateLimiter(() => clock, 2);
  assert.equal(limiter.allow("a", 2, 1000), true);
  assert.equal(limiter.allow("a", 2, 1000), true);
  assert.equal(limiter.allow("a", 2, 1000), false);
  assert.equal(limiter.allow("b", 2, 1000), true);
  assert.equal(limiter.allow("c", 2, 1000), true, "a third key is let in");
  assert.equal(limiter.size(), 2, "and the map is no bigger for it");
  assert.equal(limiter.allow("b", 2, 1000), true, "the newer key kept its count");
  assert.equal(limiter.allow("b", 2, 1000), false);
  clock = 1000;
  assert.equal(limiter.allow("b", 2, 1000), true, "a new window starts the count again");

  // A flood of new keys never refuses anyone, and never grows the map.
  const flooded = createRateLimiter(() => clock, 100);
  for (let i = 0; i < 5000; i += 1) assert.equal(flooded.allow(`flood-${i}`, 20, 60_000), true);
  assert.equal(flooded.size(), 100);
  assert.equal(flooded.allow("a-real-person", 20, 60_000), true);
});

test("what counts as one client: an IPv4 address, or an IPv6 /64", () => {
  assert.equal(addressBucket("203.0.113.9"), "203.0.113.9");
  assert.equal(addressBucket(" 203.0.113.9 , 10.0.0.1"), "203.0.113.9", "the first address named, as better-auth reads it");
  for (const same of ["2001:db8:1:2::1", "2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:DB8:1:2:a:b:c:d", "[2001:db8:1:2::9]", "2001:db8:1:2::9%eth0"]) {
    assert.equal(addressBucket(same), "2001:db8:1:2::/64", same);
  }
  assert.equal(addressBucket("2001:db8:1:3::1"), "2001:db8:1:3::/64");
  assert.equal(addressBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(addressBucket("::1"), "0:0:0:0::/64");
  assert.equal(addressBucket("2001:db8:1:2::203.0.113.9"), "2001:db8:1:2::/64");
  // An IPv4 client reported in IPv6 clothing is still that IPv4 client.
  assert.equal(addressBucket("::ffff:203.0.113.9"), "203.0.113.9");
  for (const none of [undefined, null, "", "unknown", "not an address", "203.0.113", "2001:db8:::1", "<script>"]) assert.equal(addressBucket(none), "unknown", String(none));
  // Far more addresses than the whole table holds are needed to fill it.
  assert.ok(MOBILE_PENDING_MAX / MOBILE_PENDING_PER_ADDRESS > 1500);
});

test("the store: when it is full the oldest sign-in still at the provider makes way, and one that has signed in never does", () => {
  const memory = new Database(":memory:");
  let clock = 1_000_000;
  const store = createMobileHandoffStore(memory, () => clock, { max: 4, perAddress: 2 });
  const states = () => (memory.prepare("SELECT state FROM mobile_sign_ins ORDER BY seq").all() as { state: string }[]).map((row) => row.state);
  let n = 0;
  const open = (address: string) => {
    const p = phone();
    const flow = `flow-${++n}`;
    return { p, flow, browser: store.start({ provider: "google", challenge: p.challenge, state: p.state, flow, address }) };
  };
  // One address: its third start replaces its own oldest, and nobody else's.
  const a1 = open("1.1.1.1");
  const a2 = open("1.1.1.1");
  const b1 = open("2.2.2.2");
  assert.equal(store.room("1.1.1.1"), true, "there is always room while something of its own can make way");
  const a3 = open("1.1.1.1");
  assert.ok(a3.browser);
  assert.deepEqual(states(), [a2.p.state, b1.p.state, a3.p.state]);
  assert.equal(states().includes(a1.p.state), false, "its oldest is the one that went");
  assert.equal(JSON.stringify(memory.prepare("SELECT * FROM mobile_sign_ins").all()).includes("1.1.1.1"), false, "the address itself is not what is stored");

  // Someone finishes at the provider. Their sign-in is now waiting on the
  // bridge and the exchange, and a flood of starts must not take it.
  assert.equal(store.complete({ flow: b1.flow, browser: b1.browser, userId: "user-b" }), true);
  const flood = Array.from({ length: 40 }, (_, i) => open(`10.0.${i}.1`));
  assert.ok(flood.every((entry) => entry.browser), "every start in the flood was let in");
  assert.equal((memory.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins").get() as { n: number }).n, 4, "and the table is no bigger");
  assert.ok(states().includes(b1.p.state), "the finished sign-in is still there");
  const issued = store.issue(b1.browser)!;
  assert.equal(store.redeem({ client: "markie-mobile", code: issued.code, verifier: b1.p.verifier, state: b1.p.state }), "user-b");

  // Only when nothing can make way is a start refused: every row has signed in.
  const full = createMobileHandoffStore(new Database(":memory:"), () => clock, { max: 2, perAddress: 2 });
  for (const flow of ["f1", "f2"]) {
    const p = phone();
    const browser = full.start({ provider: "google", challenge: p.challenge, state: p.state, flow, address: "3.3.3.3" })!;
    assert.equal(full.complete({ flow, browser, userId: "user-c" }), true);
  }
  assert.equal(full.room("3.3.3.3"), false);
  assert.equal(full.room("4.4.4.4"), false);
  const late = phone();
  assert.equal(full.start({ provider: "google", challenge: late.challenge, state: late.state, flow: "f3", address: "4.4.4.4" }), null);
  // Once they expire there is room again, with or without a sweep having run.
  clock += MOBILE_SIGN_IN_TTL_MS;
  assert.equal(full.room("4.4.4.4"), true);
  assert.equal(full.sweep(), 2);
  assert.equal(full.sweep(), 0);
});

test("expired sign-ins are swept on a timer, not only when someone signs in", async () => {
  const memory = new Database(":memory:");
  let clock = 5_000_000;
  const store = createMobileHandoffStore(memory, () => clock);
  const p = phone();
  assert.ok(store.start({ provider: "google", challenge: p.challenge, state: p.state, flow: "flow-timer", address: "9.9.9.9" }));
  const count = () => (memory.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins").get() as { n: number }).n;
  const mobile = createMobileAuth({ authBase: ORIGIN, issuer: ORIGIN, google: true, apple: false, store, now: () => clock, sweepEveryMs: 10 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(count(), 1, "a sign-in still under way is left alone");
    clock += MOBILE_SIGN_IN_TTL_MS;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(count(), 0, "and it is removed once it expires, with no request made");
  } finally {
    mobile.stop();
  }
});

test("the store: each step happens once, in order, and only for the flow and browser that opened it", () => {
  const memory = new Database(":memory:");
  let clock = 1_000_000;
  const store = createMobileHandoffStore(memory, () => clock);
  const p = phone();
  const good = (code: string) => ({ client: "markie-mobile", code, verifier: p.verifier, state: p.state });
  const open = (flow: string) => store.start({ provider: "google", challenge: p.challenge, state: p.state, flow, address: "1.2.3.4" })!;

  const browser = open("flow-1");
  assert.match(browser, /^[A-Za-z0-9_-]{43}$/);
  // Not signed in yet: no code, for the right browser or any other.
  assert.equal(store.issue(browser), null);
  // Another flow's callback, or none, marks nothing.
  assert.equal(store.complete({ flow: "flow-2", browser, userId: "user-1" }), false);
  assert.equal(store.complete({ flow: null, browser, userId: "user-1" }), false);
  assert.equal(store.complete({ flow: "flow-1", browser, userId: "" }), false);
  // The right flow, arriving in a browser that did not open the sign-in.
  const stranger = open("flow-stranger");
  for (const other of [null, undefined, "", stranger, randomBytes(32).toString("base64url"), `${browser}x`]) {
    assert.equal(store.complete({ flow: "flow-1", browser: other, userId: "user-1" }), false);
    assert.equal(store.fail({ flow: "flow-1", browser: other, refusal: "failed" }), false);
  }
  assert.equal(store.complete({ flow: "flow-1", browser, userId: "user-1" }), true);
  assert.equal(store.complete({ flow: "flow-1", browser, userId: "user-2" }), false, "a second callback cannot change who signed in");
  assert.equal(store.fail({ flow: "flow-1", browser, refusal: "failed" }), false, "or turn it into a refusal");
  assert.equal(store.refused(browser), null);
  // Only the browser that opened it gets the code.
  for (const other of [null, undefined, "", randomBytes(32).toString("base64url"), `${browser}x`, { browser }]) assert.equal(store.issue(other), null);
  const issued = store.issue(browser)!;
  assert.match(issued.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.state, p.state);
  assert.equal(issued.userId, "user-1");
  assert.equal(store.issue(browser), null, "one code per sign-in");
  const rows = memory.prepare("SELECT * FROM mobile_sign_ins").all() as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  for (const secret of [issued.code, browser, stranger, "flow-1"]) assert.equal(JSON.stringify(rows).includes(secret), false, "only hashes are stored");
  assert.equal(rows.find((row) => row.code_hash)?.code_hash, sha256(issued.code));
  assert.equal(store.redeem(good(issued.code)), "user-1");
  assert.equal(store.redeem(good(issued.code)), null, "spent");

  // A sign-in the provider never finished expires where it stands.
  clock = 2_000_000;
  const slow = open("flow-slow");
  clock += MOBILE_SIGN_IN_TTL_MS;
  assert.equal(store.complete({ flow: "flow-slow", browser: slow, userId: "user-1" }), false, "too late for the callback");
  assert.equal(store.issue(slow), null);

  const codeFor = (flow: string) => {
    const b = open(flow);
    assert.equal(store.complete({ flow, browser: b, userId: "user-1" }), true);
    return store.issue(b)!.code;
  };
  const late = codeFor("flow-late");
  clock += MOBILE_HANDOFF_TTL_MS;
  assert.equal(store.redeem(good(late)), null, "expired on the dot");
  const early = codeFor("flow-early");
  clock += MOBILE_HANDOFF_TTL_MS - 1;
  assert.equal(store.redeem(good(early)), "user-1", "good until the last millisecond");

  // Opening and issuing sweep what has expired, so abandoned sign-ins do not pile up.
  codeFor("flow-a");
  clock += MOBILE_HANDOFF_TTL_MS + 1;
  codeFor("flow-b");
  assert.equal((memory.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins").get() as { n: number }).n, 1);

  // A sign-in still under way has nothing to say, and asking leaves it alone.
  const ended = open("flow-refused");
  assert.equal(store.refused(ended), null);
  assert.equal(store.fail({ flow: "flow-refused", browser: ended, refusal: "signup_closed" }), true);
  assert.equal(store.complete({ flow: "flow-refused", browser: ended, userId: "user-1" }), false, "a refused sign-in cannot then be finished");
  assert.equal(store.issue(ended), null);
  // A refused one is told once, with the state it was for, and is then gone.
  assert.deepEqual(store.refused(ended), { state: p.state, provider: "google", refusal: "signup_closed" });
  assert.equal(store.refused(ended), null);
  // A reason this server does not know is stored as "failed".
  const odd = open("flow-odd");
  assert.equal(store.fail({ flow: "flow-odd", browser: odd, refusal: "<script>" as never }), true);
  assert.equal(store.refused(odd)?.refusal, "failed");
  const dropped = open("flow-dropped");
  store.drop(dropped);
  assert.equal(store.complete({ flow: "flow-dropped", browser: dropped, userId: "user-1" }), false);

  for (const bad of [null, undefined, 7, "", "short", `${issued.code}x`, { code: issued.code }]) {
    assert.equal(store.redeem({ client: "markie-mobile", code: bad, verifier: p.verifier, state: p.state }), null);
  }
});

test("on Markie Cloud the button is a link only the real app can be handed", async () => {
  // Which host: one the app claims, and never the one the page is on.
  assert.equal(verifiedReturnOrigin({ official: true, origin: "https://api.markiedocs.com", docsOrigin: "https://markiedocs.com" }), "https://markiedocs.com");
  assert.equal(verifiedReturnOrigin({ official: true, origin: "https://api.markiedocs.com", docsOrigin: null }), "https://markiedocs.com");
  assert.equal(verifiedReturnOrigin({ official: true, origin: "https://markiedocs.com", docsOrigin: null }), "https://api.markiedocs.com");
  assert.equal(verifiedReturnOrigin({ official: true, origin: "https://api.markiedocs.com", docsOrigin: "https://docs.elsewhere.example" }), "https://markiedocs.com");
  assert.equal(verifiedReturnOrigin({ official: false, origin: "https://markie.example.com", docsOrigin: "https://markiedocs.com" }), null, "a self-hosted server has no host the app claims");

  const id = userId("phone-google@example.org");
  assert.ok(id);
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const pixel = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
  const cases: { android: boolean; agent: string; verified: boolean }[] = [
    { android: false, agent: iphone, verified: true },
    { android: false, agent: ipad, verified: true },
    { android: false, agent: "", verified: true },
    // Android waits on its signing fingerprint: until then, the custom scheme.
    { android: false, agent: pixel, verified: false },
    { android: true, agent: pixel, verified: true },
  ];
  for (const { android, agent, verified } of cases) {
    const store = createMobileHandoffStore(new Database(":memory:"));
    const cloud = createMobileAuth({
      authBase: "https://api.markiedocs.com", issuer: "https://api.markiedocs.com", google: true, apple: true,
      verifiedReturn: { origin: "https://markiedocs.com", android }, store, sweepEveryMs: 0,
    });
    const p = phone();
    const browser = store.start({ provider: "apple", challenge: p.challenge, state: p.state, flow: "flow-cloud", address: "1.2.3.4" })!;
    assert.equal(store.complete({ flow: "flow-cloud", browser, userId: id }), true);
    const page = await cloud.app.request("/auth/mobile-bridge?provider=apple", { headers: { Cookie: `${MOBILE_BROWSER_COOKIE}=${browser}`, "User-Agent": agent } });
    assert.equal(page.status, 200);
    assert.match(page.headers.getSetCookie().join("\n"), new RegExp(`${MOBILE_BROWSER_COOKIE}=; .*Max-Age=0.*Secure`), "the browser's cookie is cleared");
    const html = await page.text();
    shown.push(html);
    if (!verified) {
      assert.equal(linkOn(html).protocol, "markie-mobile:");
      continue;
    }
    assert.doesNotMatch(html, /markie-mobile:/, "no custom-scheme link for another app to take");
    const link = linkOn(html, "https://markiedocs.com/");
    assert.equal(`${link.origin}${link.pathname}`, "https://markiedocs.com/auth/mobile-return");
    assert.equal(link.search, "", "nothing in the query, so nothing reaches a server");
    const carried = new URLSearchParams(link.hash.slice(1));
    assert.deepEqual([...carried.keys()].sort(), ["code", "iss", "state"]);
    assert.equal(carried.get("state"), p.state);
    assert.equal(carried.get("iss"), "https://api.markiedocs.com");
    assert.equal(store.redeem({ client: "markie-mobile", code: carried.get("code"), verifier: p.verifier, state: p.state }), id);

    // A refusal goes back the same way.
    const again = phone();
    const refusedBrowser = store.start({ provider: "apple", challenge: again.challenge, state: again.state, flow: "flow-cloud-2", address: "1.2.3.4" })!;
    assert.equal(store.fail({ flow: "flow-cloud-2", browser: refusedBrowser, refusal: "signup_closed" }), true);
    const refusal = await cloud.app.request("/auth/mobile-bridge?provider=apple", { headers: { Cookie: `${MOBILE_BROWSER_COOKIE}=${refusedBrowser}`, "User-Agent": agent } });
    assert.equal(refusal.status, 401);
    const back = linkOn(await refusal.text(), "https://markiedocs.com/");
    assert.equal(back.hash, `#error=signup_closed&state=${again.state}&iss=https%3A%2F%2Fapi.markiedocs.com`);
  }
});

test("the page behind the verified link holds nothing and sets nothing", async () => {
  const page = await req("/auth/mobile-return?code=ignored");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(page.headers.getSetCookie().length, 0);
  const html = await page.text();
  assert.match(html, /Open Markie to finish/);
  assert.doesNotMatch(html, /<script|markie-mobile:|ignored/i);
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
  assert.equal(mobileReturnLink("c-_d", p.state, "https://api.markiedocs.com", "https://markiedocs.com"), `https://markiedocs.com/auth/mobile-return#code=c-_d&state=${p.state}&iss=https%3A%2F%2Fapi.markiedocs.com`);
});

// Last on purpose: it reads what every test above put on the wire and in the log.
test("no session token is ever in a redirect, a response header, a page, or a log line", () => {
  // Every token ever made here, ended or not: the provider step's short-lived
  // sessions as well as the ones the app was given.
  const tokens = everyToken();
  assert.ok(tokens.length >= 20, "the flows above made real sessions");
  assert.ok(shown.length >= 100, "and the browser was shown real redirects, headers and pages");
  assert.ok(shown.some((seen) => seen.includes("/auth/mobile-bridge")), "the callback's redirect is among them");
  assert.ok(shown.some((seen) => seen.includes("Return to Markie")), "and the return page");
  for (const token of tokens) {
    for (const seen of shown) assert.equal(seen.includes(token), false, `a session token reached the browser: ${seen.slice(0, 300)}`);
    for (const line of logged) assert.equal(line.includes(token), false, "a session token reached the log");
  }
  // The return link, wherever it appeared, never had a token on it.
  for (const seen of shown) assert.doesNotMatch(seen, /(?:markie-mobile:\/\/|\/auth\/mobile-return)[^"'\s]*token/);
});
