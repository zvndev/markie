// Boot the whole app the way deploy/docker-compose.yml runs it: a self-hosted
// production server on its own domain, with no mail, and a storage quota.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";

const ORIGIN = "https://markie.example.org";
const QUOTA = 10_000;
const dir = mkdtempSync(join(tmpdir(), "markie-selfhost-"));
for (const name of Object.keys(process.env)) {
  if (/^(B2_|ASSETS_|S3_|GOOGLE_|RESEND_|EMAIL_FROM|MARKIE_)/.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  NODE_ENV: "production",
  MARKIE_OFFICIAL: "0",
  DB_PATH: join(dir, "t.db"),
  ASSETS_DIR: join(dir, "assets"),
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "markie-selfhost-boot-test-secret-32-plus",
  MARKIE_MAIL_LOG: "1",
  MARKIE_STORAGE_QUOTA_BYTES: String(QUOTA),
  MARKIE_NO_LISTEN: "1",
});

// Mail-log mode writes every message to the log; collect it.
const logged: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
};

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app } = await import("./index.ts");
const { markVerified } = await import("./test-users.ts");
// Invite-only is the self-hosted default; every account here is let in the
// way an admin would let it in. invite-signup.test.ts covers the gate itself.
const { allowEmail } = await import("./signup.ts");
const { openDatabase } = await import("./db.ts");
const allow = (email: string) => allowEmail(openDatabase(), email, null);
console.log = originalLog;
const captureLog = () => {
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  return () => { console.log = originalLog; };
};

let ip = 0;
const req = (path: string, init: RequestInit = {}, origin = "app://markie") => {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  headers.set("x-forwarded-for", `10.2.0.${++ip % 250}`);
  return app.request(path, { ...init, headers });
};
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function account(name: string): Promise<{ token: string; id: string; email: string }> {
  const email = `${name}-${Date.now()}@example.org`;
  allow(email);
  const restore = captureLog();
  const signUp = await req("/api/auth/sign-up/email", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "password-123" }),
  });
  restore();
  assert.equal(signUp.status, 200, await signUp.clone().text());
  markVerified(email);
  const signIn = await req("/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password-123" }),
  });
  assert.equal(signIn.status, 200);
  const body = (await signIn.json()) as { user: { id: string } };
  return { token: signIn.headers.get("set-auth-token")!, id: body.user.id, email };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const putDoc = (token: string, id: string, content: string, baseVersion: number) =>
  req(`/api/docs/${id}`, { method: "PUT", headers: bearer(token), body: JSON.stringify({ name: "d.md", content, hash: sha(content), baseVersion }) });

test("server-info describes this server, not Markie Cloud", async () => {
  const res = await req("/api/server-info", {}, "https://anywhere.example");
  assert.deepEqual(await res.json(), {
    product: "markie-server",
    apiVersion: 1,
    version: "0.1.0",
    name: "markie.example.org",
    origin: ORIGIN,
    signIn: { email: true, google: false, signup: "invite" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("the desktop app and the server's own pages are trusted; the official website is not", async () => {
  for (const origin of ["app://markie", ORIGIN]) {
    const res = await req("/api/me", {}, origin);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
  }
  const official = await req("/api/me", {}, "https://markiedocs.com");
  assert.notEqual(official.headers.get("access-control-allow-origin"), "https://markiedocs.com");
});

test("download routes send people to the official download page", async () => {
  for (const path of ["/download", "/download/mac", "/download/latest", "/download/windows"]) {
    const res = await req(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("location"), "https://markiedocs.com/download", path);
  }
  const manifest = await req("/download/latest.json");
  assert.equal(manifest.status, 302);
  assert.equal(manifest.headers.get("location"), "https://markiedocs.com/download/latest.json");
  const missing = await req("/s/not-a-real-token");
  assert.match(await missing.text(), /href="https:\/\/markiedocs.com\/download\/mac"/);
});

test("with no mail, the sign-up code is written to the server log for the admin to pass on", async () => {
  const email = `guest-${Date.now()}@example.org`;
  allow(email);
  logged.length = 0;
  const restore = captureLog();
  const res = await req("/api/auth/sign-up/email", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Guest", email, password: "password-123" }),
  });
  restore();
  assert.equal(res.status, 200);
  const line = logged.find((l) => l.includes("[mail-log]") && l.includes(email));
  assert.ok(line, "no code in the log");
  const code = line!.match(/Enter (\d{6}) in Markie/)?.[1];
  assert.ok(code);
  // The code proves the address exactly as an emailed one would.
  const verify = await req("/api/auth/email-otp/verify-email", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, otp: code }),
  });
  assert.equal(verify.status, 200);
});

test("desktop sign-in hands the session back through the markie:// deep link on any origin", async () => {
  const { token } = await account("bridge");
  const res = await req("/auth/desktop-bridge?state=00112233445566778899aabbccddeeff", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /markie:\/\/auth\?token=[^"&]+&state=00112233445566778899aabbccddeeff/);
});

test("share links and invite emails use this server's origin", async () => {
  const owner = await account("linker");
  const id = crypto.randomUUID();
  assert.equal((await putDoc(owner.token, id, "# hi", 0)).status, 200);
  const link = await req(`/api/docs/${id}/public-link`, { method: "POST", headers: bearer(owner.token) });
  const { url } = (await link.json()) as { url: string };
  assert.match(url, /^https:\/\/markie\.example\.org\/s\//);
  const page = await req(new URL(url).pathname);
  const html = await page.text();
  assert.match(html, /markie:\/\/open\?token=[^"]+&amp;src=https%3A%2F%2Fmarkie\.example\.org/);
  assert.match(html, /href="https:\/\/markiedocs.com\/download\/mac"/);

  logged.length = 0;
  const restore = captureLog();
  const invite = await req(`/api/docs/${id}/shares`, {
    method: "POST", headers: bearer(owner.token), body: JSON.stringify({ email: `invitee-${Date.now()}@example.org`, role: "viewer" }),
  });
  restore();
  assert.equal(invite.status, 200, await invite.clone().text());
  assert.ok(logged.some((l) => l.includes(`${ORIGIN}/d/${id}?k=`)), "invite link does not use the server's origin");
});

test("the storage quota refuses growth past it on doc sync, uploads and snapshots, and reports usage", async () => {
  const owner = await account("quota-owner");
  const editor = await account("quota-editor");
  const doc = crypto.randomUUID();

  assert.equal((await putDoc(owner.token, doc, "a".repeat(6000), 0)).status, 200);
  const over = await putDoc(owner.token, crypto.randomUUID(), "b".repeat(5000), 0);
  assert.equal(over.status, 413);
  const refusal = (await over.json()) as Record<string, unknown>;
  assert.equal(refusal.error, "storage_quota_exceeded");
  assert.equal(refusal.usedBytes, 6000);
  assert.equal(refusal.quotaBytes, QUOTA);
  assert.equal(typeof refusal.message, "string");

  // Shrinking is always allowed.
  assert.equal((await putDoc(owner.token, doc, "a".repeat(1000), 1)).status, 200);

  // Uploads: refused on the declared length before any bytes are read, then
  // accepted once they fit.
  const big = Buffer.alloc(12_000, 1);
  const refusedUpload = await req(`/api/assets/${sha(big)}`, {
    method: "PUT", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "image/png", "Content-Length": String(big.length) }, body: new Blob([big]),
  });
  assert.equal(refusedUpload.status, 413);
  assert.equal(((await refusedUpload.json()) as { error: string }).error, "storage_quota_exceeded");
  const small = Buffer.alloc(3000, 2);
  const upload = await req(`/api/assets/${sha(small)}`, {
    method: "PUT", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "image/png", "Content-Length": String(small.length) }, body: new Blob([small]),
  });
  assert.equal(upload.status, 200);

  // Word/RTF/ODT snapshots.
  const snapshot = (bytes: Buffer) => JSON.stringify({ schemaVersion: 2, name: "s.txt", format: "text", encoding: "base64", data: bytes.toString("base64"), sha256: sha(bytes), baseVersion: 0 });
  const tooBig = await req("/api/document-platform/documents", { method: "POST", headers: bearer(owner.token), body: snapshot(Buffer.alloc(7000, 65)) });
  assert.equal(tooBig.status, 413);
  assert.equal(((await tooBig.json()) as { error: string }).error, "storage_quota_exceeded");
  const fits = await req("/api/document-platform/documents", { method: "POST", headers: bearer(owner.token), body: snapshot(Buffer.alloc(1000, 65)) });
  assert.equal(fits.status, 201);

  // An editor's save lands in the owner's storage, so it is the owner's quota
  // that refuses it.
  const restore = captureLog();
  const share = await req(`/api/docs/${doc}/shares`, { method: "POST", headers: bearer(owner.token), body: JSON.stringify({ email: editor.email, role: "editor" }) });
  restore();
  assert.equal(share.status, 200, await share.clone().text());
  const editorPush = await putDoc(editor.token, doc, "e".repeat(7000), 2);
  assert.equal(editorPush.status, 413);
  assert.equal(((await editorPush.json()) as { usedBytes: number }).usedBytes, 5000);

  const usage = await req("/api/account/usage", { headers: bearer(owner.token) });
  assert.deepEqual(await usage.json(), { usedBytes: 5000, quotaBytes: QUOTA });
  const editorUsage = await req("/api/account/usage", { headers: bearer(editor.token) });
  assert.deepEqual(await editorUsage.json(), { usedBytes: 0, quotaBytes: QUOTA });
});
