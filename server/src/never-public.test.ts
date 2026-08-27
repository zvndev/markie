// Nothing makes a document public except asking for it.
//
// This exists because the opposite was once true and nobody noticed. Inviting
// somebody who did not yet have an account minted a public link as a side
// effect and mailed it out, so three real documents were readable by anyone
// holding the URL — two of them for two months, with the owner believing he had
// shared them with one person each.
//
// The fix was one line. The reason it went unnoticed is that no test ever
// asserted the absence of a grant. These do. Every route that touches a
// document runs, and after each one the public link must still be null.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-never-public-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-never-public-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { getPublicLinkToken } = await import("./public-links.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);

const stamp = Date.now();
let ip = 0;

async function jsonRequest<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T | null; headers: Headers }> {
  const headers = new Headers({
    "Content-Type": "application/json",
    // A fresh address per call: sign-up is rate limited by IP and these tests
    // create several accounts in a row.
    "x-forwarded-for": `10.0.0.${(ip += 1) % 255}`,
    Origin: "http://localhost:3000",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as T | null,
    headers: res.headers,
  };
}

async function signUp(name: string, email: string) {
  const { token } = await signUpVerified(app, { name, email });
  return { token, email };
}

async function push(token: string, docId: string, body: string, baseVersion: number) {
  const hash = createHash("sha256").update(body, "utf8").digest("hex");
  return jsonRequest<{ version: number }>("PUT", `/api/docs/${docId}`, token, {
    name: "notes.md",
    content: body,
    hash,
    baseVersion,
  });
}

// The assertion the original bug would have failed.
function assertNotPublic(docId: string, after: string) {
  assert.equal(
    getPublicLinkToken(docId),
    null,
    `${after} left the document publicly readable`
  );
}

test("backing a document up to the cloud does not publish it", async () => {
  const owner = await signUp("Owner", `sync.${stamp}@test.local`);
  const docId = `sync-${stamp}`;

  const created = await push(owner.token, docId, "# Private notes\n", 0);
  assert.equal(created.status, 200);
  assertNotPublic(docId, "the first sync");

  // Repeatedly, because "syncing" is a thing that happens constantly, not once.
  for (let version = 1; version <= 3; version += 1) {
    const again = await push(owner.token, docId, `# Private notes\n\nv${version}\n`, version);
    assert.equal(again.status, 200);
    assertNotPublic(docId, `sync number ${version + 1}`);
  }

  const read = await jsonRequest("GET", `/api/docs/${docId}`, owner.token);
  assert.equal(read.status, 200);
  assertNotPublic(docId, "reading it back");
});

test("sharing with a person who has an account does not publish the document", async () => {
  const owner = await signUp("Owner", `share-owner.${stamp}@test.local`);
  const bob = await signUp("Bob", `share-bob.${stamp}@test.local`);
  const docId = `share-${stamp}`;
  await push(owner.token, docId, "# Shared\n", 0);

  for (const role of ["viewer", "editor"]) {
    const invite = await jsonRequest<{ status: string }>(
      "POST",
      `/api/docs/${docId}/shares`,
      owner.token,
      { email: bob.email, role }
    );
    assert.equal(invite.status, 200);
    assert.equal(invite.data?.status, "member");
    assertNotPublic(docId, `sharing as ${role}`);
  }
});

// The exact shape of the incident: the recipient has no account yet.
test("inviting someone without an account does not publish the document", async () => {
  const owner = await signUp("Owner", `pend-owner.${stamp}@test.local`);
  const docId = `pending-${stamp}`;
  await push(owner.token, docId, "# Confidential\n", 0);

  const invite = await jsonRequest<{ status: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: `nobody.${stamp}@test.local`, role: "editor" }
  );
  assert.equal(invite.status, 200);
  assert.equal(invite.data?.status, "invited");
  assertNotPublic(docId, "inviting someone with no account");

  // And the invite mail must not carry a public link either: the grant is what
  // matters, but so is what gets put in somebody's inbox.
  const link = await jsonRequest<{ url: string | null }>(
    "GET",
    `/api/docs/${docId}/public-link`,
    owner.token
  );
  assert.equal(link.data?.url, null);
});

test("only the owner can publish, and only by asking", async () => {
  const owner = await signUp("Owner", `pub-owner.${stamp}@test.local`);
  const editor = await signUp("Editor", `pub-editor.${stamp}@test.local`);
  const docId = `publish-${stamp}`;
  await push(owner.token, docId, "# Publishable\n", 0);
  await jsonRequest("POST", `/api/docs/${docId}/shares`, owner.token, {
    email: editor.email,
    role: "editor",
  });

  // An editor may change the document but may not decide the world can read it.
  const editorTries = await jsonRequest("POST", `/api/docs/${docId}/public-link`, editor.token);
  assert.equal(editorTries.status, 403);
  assertNotPublic(docId, "an editor asking to publish");

  const stranger = await signUp("Stranger", `pub-stranger.${stamp}@test.local`);
  const strangerTries = await jsonRequest("POST", `/api/docs/${docId}/public-link`, stranger.token);
  assert.equal(strangerTries.status, 403);
  assertNotPublic(docId, "a stranger asking to publish");

  // Explicit, by the owner, is the only way in.
  const published = await jsonRequest<{ url: string }>(
    "POST",
    `/api/docs/${docId}/public-link`,
    owner.token
  );
  assert.equal(published.status, 200);
  assert.ok(getPublicLinkToken(docId), "the owner's own request should publish it");

  const revoked = await jsonRequest("DELETE", `/api/docs/${docId}/public-link`, owner.token);
  assert.equal(revoked.status, 200);
  assertNotPublic(docId, "revoking");
});
