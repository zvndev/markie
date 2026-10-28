// The share dialog's "Add people" suggestions.
//
// The assertions that matter most are the ones about who is NOT in the list:
// the caller themselves, and people the caller never had anything to do with.
// A suggestion list that leaked a stranger's address would be a directory of
// Markie's users.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-share-contacts-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-share-contacts-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares, SHARE_CONTACTS_LIMIT } = await import("./shares.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);

const ORIGIN = { Origin: "http://localhost:3000" };
const stamp = Date.now();

async function jsonRequest<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T | null }> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
    ...ORIGIN,
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

async function signUp(name: string, email: string) {
  const user = await signUpVerified(app, { name, email });
  return { token: user.token, email };
}

async function createDoc(token: string, docId: string) {
  const content = `# Contacts\n`;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await jsonRequest("PUT", `/api/docs/${docId}`, token, {
    name: "contacts.md",
    content,
    hash,
    baseVersion: 0,
  });
  assert.equal(res.status, 200);
}

async function share(token: string, docId: string, email: string) {
  const res = await jsonRequest("POST", `/api/docs/${docId}/shares`, token, {
    email,
    role: "viewer",
  });
  assert.equal(res.status, 200);
}

type Contacts = { contacts: Array<{ email: string; name: string | null }> };

test("needs a session", async () => {
  const res = await jsonRequest("GET", "/api/docs/share-contacts");
  assert.equal(res.status, 401);
});

test("lists people I shared with and owners who shared with me, newest first, never me", async () => {
  const me = await signUp("Me Myself", `sc.me.${stamp}@test.local`);
  const grace = await signUp("Grace Hopper", `sc.grace.${stamp}@test.local`);
  const alan = await signUp("Alan Turing", `sc.alan.${stamp}@test.local`);
  const stranger = await signUp("Stranger", `sc.stranger.${stamp}@test.local`);
  const invitee = `sc.invitee.${stamp}@test.local`;

  // I share one doc with Grace, then with an address that has no account.
  const mine = `sc-mine-${stamp}`;
  await createDoc(me.token, mine);
  await share(me.token, mine, grace.email);
  await new Promise((r) => setTimeout(r, 5));
  await share(me.token, mine, invitee);
  // Sharing with Grace again on a second doc must not list her twice.
  const mine2 = `sc-mine2-${stamp}`;
  await createDoc(me.token, mine2);
  await new Promise((r) => setTimeout(r, 5));
  await share(me.token, mine2, grace.email);

  // Alan shares his doc with me.
  await new Promise((r) => setTimeout(r, 5));
  const his = `sc-his-${stamp}`;
  await createDoc(alan.token, his);
  await share(alan.token, his, me.email);

  // The stranger shares with Grace: none of my business.
  const theirs = `sc-theirs-${stamp}`;
  await createDoc(stranger.token, theirs);
  await share(stranger.token, theirs, grace.email);

  const res = await jsonRequest<Contacts>("GET", "/api/docs/share-contacts", me.token);
  assert.equal(res.status, 200);
  const contacts = res.data?.contacts ?? [];
  assert.deepEqual(
    contacts.map((c) => c.email),
    [alan.email, grace.email, invitee]
  );
  assert.equal(contacts.find((c) => c.email === grace.email)?.name, "Grace Hopper");
  assert.equal(contacts.find((c) => c.email === alan.email)?.name, "Alan Turing");
  assert.equal(contacts.find((c) => c.email === invitee)?.name, null);
  assert.ok(!contacts.some((c) => c.email === me.email), "never the caller");
  assert.ok(!contacts.some((c) => c.email === stranger.email), "never a stranger");

  // The stranger sees only Grace.
  const theirView = await jsonRequest<Contacts>("GET", "/api/docs/share-contacts", stranger.token);
  assert.deepEqual(theirView.data?.contacts.map((c) => c.email), [grace.email]);
});

test("is capped", () => {
  assert.equal(SHARE_CONTACTS_LIMIT, 50);
});
