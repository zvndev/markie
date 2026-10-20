// A self-hosted server is invite-only unless it says otherwise. Booted the way
// deploy/docker-compose.yml runs it, with no MARKIE_SIGNUP and no admin email
// pinned, so the first account to sign up becomes the admin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";

const ORIGIN = "https://private.example.org";
const dir = mkdtempSync(join(tmpdir(), "markie-invite-"));
for (const name of Object.keys(process.env)) {
  if (/^(B2_|ASSETS_|S3_|GOOGLE_|RESEND_|EMAIL_FROM|MARKIE_)/.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  NODE_ENV: "production",
  MARKIE_OFFICIAL: "0",
  DB_PATH: join(dir, "t.db"),
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "markie-invite-signup-test-secret-32-plus",
  MARKIE_MAIL_LOG: "1",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  MARKIE_NO_LISTEN: "1",
});

// Mail goes to the log in this mode; keep it, so codes can be read back.
const logged: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };

// Google's token endpoint, answered locally. The id token is all better-auth
// reads the profile from, and it only decodes it on this path.
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
  headers.set("x-forwarded-for", `10.3.0.${++ip % 250}`);
  return app.request(path, { ...init, headers });
};
const json = { "Content-Type": "application/json" };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, ...json });
const userExists = (email: string) => !!db.prepare('SELECT 1 FROM "user" WHERE lower(email) = ?').get(email.toLowerCase());

const signUp = (email: string) => req("/api/auth/sign-up/email", {
  method: "POST", headers: json, body: JSON.stringify({ name: "Someone", email, password: "password-123" }),
});
async function signIn(email: string): Promise<string> {
  markVerified(email);
  const res = await req("/api/auth/sign-in/email", { method: "POST", headers: json, body: JSON.stringify({ email, password: "password-123" }) });
  assert.equal(res.status, 200);
  return res.headers.get("set-auth-token")!;
}

const stamp = Date.now();
const ADMIN = `admin-${stamp}@example.org`;
let adminToken = "";

test("server-info says this server is invite-only", async () => {
  const body = (await (await req("/api/server-info")).json()) as { apiVersion: number; signIn: { signup: string } };
  assert.equal(body.apiVersion, 1);
  assert.equal(body.signIn.signup, "invite");
});

test("the first account to sign up is let in and becomes the admin", async () => {
  assert.equal((await signUp(ADMIN)).status, 200);
  adminToken = await signIn(ADMIN);
  const list = await req("/api/admin/signup-allowlist", { headers: bearer(adminToken) });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { signup: "invite", emails: [] });
});

test("a stranger is refused with signup_invite_required, and no account is made", async () => {
  const email = `stranger-${stamp}@example.org`;
  const res = await signUp(email);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, "signup_invite_required");
  assert.match(body.message, /invite-only/);
  assert.equal(userExists(email), false);
});

test("a stranger cannot get in through a first email-code sign-in either", async () => {
  const email = `otp-stranger-${stamp}@example.org`;
  logged.length = 0;
  await req("/api/auth/email-otp/send-verification-otp", { method: "POST", headers: json, body: JSON.stringify({ email, type: "sign-in" }) });
  const code = logged.join("\n").match(/sign-in code is (\d{6})/)?.[1];
  assert.ok(code, "no sign-in code was written to the log");
  const res = await req("/api/auth/sign-in/email-otp", { method: "POST", headers: json, body: JSON.stringify({ email, otp: code }) });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, "signup_invite_required");
  assert.equal(userExists(email), false);
});

test("an invited guest can sign up and finds the shared document", async () => {
  const guest = `guest-${stamp}@example.org`;
  const doc = crypto.randomUUID();
  const put = await req(`/api/docs/${doc}`, { method: "PUT", headers: bearer(adminToken), body: JSON.stringify({ name: "plan.md", content: "# plan", hash: "h", baseVersion: 0 }) });
  assert.equal(put.status, 200);
  const invite = await req(`/api/docs/${doc}/shares`, { method: "POST", headers: bearer(adminToken), body: JSON.stringify({ email: guest, role: "editor" }) });
  assert.equal(invite.status, 200);
  assert.equal(((await invite.json()) as { status: string }).status, "invited");

  assert.equal((await signUp(guest)).status, 200);
  const token = await signIn(guest);
  const docs = (await (await req("/api/docs", { headers: bearer(token) })).json()) as { docs: { id: string; shared?: boolean }[] };
  assert.ok(docs.docs.some((d) => d.id === doc && d.shared));
});

test("the admin's allowlist lets an address in, and only the admin can change it", async () => {
  const friend = `friend-${stamp}@example.org`;
  const later = `later-${stamp}@example.org`;
  for (const email of [friend, later]) {
    const add = await req("/api/admin/signup-allowlist", { method: "POST", headers: bearer(adminToken), body: JSON.stringify({ email: email.toUpperCase() }) });
    assert.equal(add.status, 200);
    assert.deepEqual(await add.json(), { ok: true, email });
  }
  assert.equal((await req("/api/admin/signup-allowlist", { method: "POST", headers: bearer(adminToken), body: JSON.stringify({ email: "nope" }) })).status, 400);

  assert.equal((await signUp(friend)).status, 200);
  const friendToken = await signIn(friend);
  const notAdmin = await req("/api/admin/signup-allowlist", { method: "POST", headers: bearer(friendToken), body: JSON.stringify({ email: "x@example.org" }) });
  assert.equal(notAdmin.status, 403);
  assert.deepEqual(await notAdmin.json(), { error: "admin_required" });
  assert.equal((await req("/api/admin/signup-allowlist")).status, 401);

  const removed = await req(`/api/admin/signup-allowlist/${encodeURIComponent(later)}`, { method: "DELETE", headers: bearer(adminToken) });
  assert.deepEqual(await removed.json(), { ok: true, removed: true });
  assert.equal((await signUp(later)).status, 403);
});

// Drives the real flow: /auth/google-start, Google's redirect back to the
// callback with the state cookie, and better-auth's token exchange (answered
// above). Returns where the callback sent the browser.
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

test("a first Google sign-in by a stranger is refused, and the bridge says why", async () => {
  const email = `google-stranger-${stamp}@example.org`;
  const landed = await googleSignIn(email);
  assert.equal(landed.pathname, "/auth/desktop-bridge");
  assert.equal(landed.searchParams.get("error"), "signup_invite_required");
  assert.equal(userExists(email), false);
  const page = await req(`${landed.pathname}${landed.search}`, {}, ORIGIN);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /invite-only/);
});

test("a first Google sign-in by an invited address is let in", async () => {
  const email = `google-friend-${stamp}@example.org`;
  await req("/api/admin/signup-allowlist", { method: "POST", headers: bearer(adminToken), body: JSON.stringify({ email }) });
  const landed = await googleSignIn(email);
  assert.equal(landed.pathname, "/auth/desktop-bridge");
  assert.equal(landed.searchParams.get("error"), null);
  assert.equal(userExists(email), true);
});

test.after(() => {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
});
