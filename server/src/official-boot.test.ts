// Boot the whole app under the variables the live Railway service has today,
// none of which this change added, and check that it is still the official
// Markie Cloud: same links, same trusted websites, same download routes, no
// quota, and the new server-info answer saying so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";

const RAILWAY = "https://api-production-602f.up.railway.app";
const dir = mkdtempSync(join(tmpdir(), "markie-official-"));
Object.assign(process.env, {
  NODE_ENV: "production",
  DB_PATH: join(dir, "t.db"),
  BETTER_AUTH_URL: RAILWAY,
  BETTER_AUTH_SECRET: "markie-official-boot-test-secret-32-plus",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  RESEND_API_KEY: "re_test_not_a_key",
  EMAIL_FROM: "Markie <hello@markiedocs.com>",
  B2_ENDPOINT: "https://s3.us-east-005.backblazeb2.com",
  B2_BUCKET: "Markie",
  B2_KEY_ID: "b2-key-id",
  B2_APP_KEY: "b2-app-key",
  ASSETS_BUCKET: "markie-assets",
  ASSETS_ENDPOINT: "https://s3.us-east-005.backblazeb2.com",
  ASSETS_KEY_ID: "assets-key-id",
  ASSETS_APP_KEY: "assets-app-key",
  LITESTREAM_AGE_IDENTITY: "AGE-SECRET-KEY-1TEST",
  LITESTREAM_AGE_RECIPIENT: "age1test",
  MARKIE_NO_LISTEN: "1",
});
for (const name of ["MARKIE_OFFICIAL", "MARKIE_SITE_URL", "MARKIE_DOWNLOAD_BASE", "MARKIE_MAIL_LOG", "MARKIE_STORAGE_QUOTA_BYTES", "MARKIE_SERVER_NAME", "MARKIE_WEB_ORIGINS"]) {
  delete process.env[name];
}

// Mail and the release feed go over the network; nothing here may.
const sent: { url: string; body: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  sent.push({ url, body: typeof init?.body === "string" ? init.body : "" });
  if (url.startsWith("https://api.resend.com/")) return Response.json({ id: "email" });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app } = await import("./index.ts");
const { markVerified } = await import("./test-users.ts");

const req = (path: string, init: RequestInit = {}, origin = "app://markie") => {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  headers.set("x-forwarded-for", "10.1.1.1");
  return app.request(path, { ...init, headers });
};

test("server-info names the official Markie Cloud", async () => {
  const res = await req("/api/server-info", {}, "https://anywhere.example");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    product: "markie-server",
    apiVersion: 1,
    version: "0.1.0",
    name: "Markie Cloud",
    origin: RAILWAY,
    signIn: { email: true, google: true },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

test("server-info's preflight allows GET from anywhere without credentials", async () => {
  const res = await req("/api/server-info", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } }, "https://anywhere.example");
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /^GET$/);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

test("the API keeps its credentialed allowlist: the app and the official website, nobody else", async () => {
  for (const origin of ["app://markie", "https://markiedocs.com", "https://www.markiedocs.com"]) {
    const res = await req("/api/me", {}, origin);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  }
  const stranger = await req("/api/me", {}, "https://evil.example");
  assert.notEqual(stranger.headers.get("access-control-allow-origin"), "https://evil.example");
  assert.notEqual(stranger.headers.get("access-control-allow-origin"), "*");
});

test("the official download routes are still served from the release manifest", async () => {
  const latest = await req("/download/latest");
  assert.equal(latest.status, 307);
  assert.equal(latest.headers.get("location"), "/download/mac");
  const page = await req("/download");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Markie downloads/);
  const manifest = await req("/download/latest.json");
  assert.equal(manifest.status, 200);
  assert.equal(((await manifest.json()) as { downloadPageUrl: string }).downloadPageUrl, "https://markiedocs.com/download");
});

test("share pages and their links still point at markiedocs.com", async () => {
  const res = await req("/s/not-a-real-token");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /href="https:\/\/markiedocs.com\/download\/mac"/);
});

test("desktop Google sign-in starts on this server's own origin", async () => {
  const res = await req("/auth/google-start?state=0123456789abcdef");
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.host, "accounts.google.com");
  assert.equal(location.searchParams.get("redirect_uri"), `${RAILWAY}/api/auth/callback/google`);
});

test("email sign-up sends its code through Resend from the configured address, and there is no quota", async () => {
  const email = `official-${Date.now()}@markie.test`;
  const signUp = await req("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Official", email, password: "password-123" }),
  });
  assert.equal(signUp.status, 200);
  const mail = sent.find((s) => s.url === "https://api.resend.com/emails");
  assert.ok(mail, "no mail was sent");
  assert.equal(JSON.parse(mail!.body).from, "Markie <hello@markiedocs.com>");

  markVerified(email);
  const signIn = await req("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password-123" }),
  });
  assert.equal(signIn.status, 200);
  const token = signIn.headers.get("set-auth-token")!;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const content = "x".repeat(200_000);
  const put = await req(`/api/docs/${crypto.randomUUID()}`, {
    method: "PUT", headers: auth, body: JSON.stringify({ name: "big.md", content, hash: "h", baseVersion: 0 }),
  });
  assert.equal(put.status, 200);
  const usage = await req("/api/account/usage", { headers: auth });
  assert.equal(usage.status, 200);
  assert.equal(usage.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await usage.json(), { usedBytes: 200_000, quotaBytes: null });
  assert.equal((await req("/api/account/usage")).status, 401);
});
