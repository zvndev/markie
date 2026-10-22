// Markie Cloud after BETTER_AUTH_URL moves to api.markiedocs.com. Every app
// released before the move keeps calling the Railway hostname, so the API has
// to answer there exactly as before, with the same sessions; only the browser
// pages that set cookies move to the new name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";

const CLOUD = "https://api.markiedocs.com";
const RAILWAY = "https://api-production-602f.up.railway.app";
const dir = mkdtempSync(join(tmpdir(), "markie-cloud-hostname-"));
Object.assign(process.env, {
  NODE_ENV: "production",
  DB_PATH: join(dir, "t.db"),
  BETTER_AUTH_URL: CLOUD,
  BETTER_AUTH_SECRET: "markie-cloud-hostname-test-secret-32-plus",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  RESEND_API_KEY: "re_test_not_a_key",
  EMAIL_FROM: "Markie <hello@markiedocs.com>",
  MARKIE_NO_LISTEN: "1",
});
for (const name of ["MARKIE_OFFICIAL", "MARKIE_SITE_URL", "MARKIE_DOWNLOAD_BASE", "MARKIE_MAIL_LOG", "MARKIE_STORAGE_QUOTA_BYTES", "MARKIE_SERVER_NAME", "MARKIE_WEB_ORIGINS"]) {
  delete process.env[name];
}
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.resend.com/")) return Response.json({ id: "email" });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app } = await import("./index.ts");
const { markVerified } = await import("./test-users.ts");

// A request as Railway's edge hands it to the process: plain http, with the
// name the client used in Host.
const at = (origin: string, path: string, init: RequestInit = {}, from = "app://markie") => {
  const host = new URL(origin).host;
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("origin", from);
  headers.set("x-forwarded-for", "10.2.2.2");
  return app.fetch(new Request(`http://${host}${path}`, { ...init, headers }));
};

async function signedIn(origin: string): Promise<string> {
  const email = `hostname-${crypto.randomUUID()}@markie.test`;
  const json = { "Content-Type": "application/json" };
  const up = await at(origin, "/api/auth/sign-up/email", { method: "POST", headers: json, body: JSON.stringify({ name: "Host", email, password: "password-123" }) });
  assert.equal(up.status, 200);
  markVerified(email);
  const signIn = await at(origin, "/api/auth/sign-in/email", { method: "POST", headers: json, body: JSON.stringify({ email, password: "password-123" }) });
  assert.equal(signIn.status, 200);
  return signIn.headers.get("set-auth-token")!;
}

test("server-info names the new origin, on either name", async () => {
  for (const origin of [CLOUD, RAILWAY]) {
    const res = await at(origin, "/api/server-info");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { origin: string }).origin, CLOUD);
  }
});

test("a session from before the move, made on the Railway name, is good on both", async () => {
  const token = await signedIn(RAILWAY);
  for (const origin of [RAILWAY, CLOUD]) {
    const me = await at(origin, "/api/me", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    assert.ok(((await me.json()) as { user: { id: string } | null }).user?.id, origin);
    assert.equal(me.headers.get("access-control-allow-origin"), "app://markie");
  }
  const session = await at(RAILWAY, "/api/auth/get-session", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(session.status, 200);
});

test("the API is served, not redirected, on the Railway name", async () => {
  for (const path of ["/health", "/api/me", "/api/auth/get-session", "/s/not-a-real-token", "/download"]) {
    const res = await at(RAILWAY, path);
    assert.notEqual(res.status, 308, path);
  }
});

test("a browser Google sign-in on the Railway name moves to the new one before any cookie is set", async () => {
  const res = await at(RAILWAY, "/auth/google-start?state=0123456789abcdef", {}, "null");
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), `${CLOUD}/auth/google-start?state=0123456789abcdef`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(res.headers.getSetCookie(), []);

  for (const path of ["/auth/desktop-bridge?state=0123456789abcdef", "/account/link-google"]) {
    const page = await at(RAILWAY, path);
    assert.equal(page.status, 308, path);
    assert.equal(page.headers.get("location"), `${CLOUD}${path}`);
  }
});

test("on the new name it starts at Google with the new callback, setting its state cookie there", async () => {
  const res = await at(CLOUD, "/auth/google-start?state=0123456789abcdef", {}, "null");
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.host, "accounts.google.com");
  assert.equal(location.searchParams.get("redirect_uri"), `${CLOUD}/api/auth/callback/google`);
  assert.ok(res.headers.getSetCookie().length > 0);
});

test("the desktop bridge names the new origin as the issuer", async () => {
  const token = await signedIn(CLOUD);
  const res = await at(CLOUD, "/auth/desktop-bridge?state=0123456789abcdef", { headers: { Authorization: `Bearer ${token}` } }, "null");
  assert.equal(res.status, 200);
  assert.match(await res.text(), new RegExp(`iss=${encodeURIComponent(CLOUD).replace(/[.]/g, "\\.")}`));
});

test("a cookie-carrying request from a page on the Railway name still passes the origin check", async () => {
  const res = await at(RAILWAY, "/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json", cookie: "unrelated=1" }, body: "{}" }, RAILWAY);
  assert.notEqual(res.status, 403);
  const stranger = await at(RAILWAY, "/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json", cookie: "unrelated=1" }, body: "{}" }, "https://evil.example");
  assert.equal(stranger.status, 403);
});
