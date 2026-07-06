import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-share-routes-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-share-routes-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");

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
): Promise<{ status: number; data: T | null; headers: Headers }> {
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
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as T | null,
    headers: res.headers,
  };
}

async function signUp(name: string, email: string): Promise<{ token: string; email: string }> {
  const res = await jsonRequest<{ user: { email: string } }>(
    "POST",
    "/api/auth/sign-up/email",
    undefined,
    { name, email, password: "password-123" }
  );
  assert.equal(res.status, 200);
  const token = res.headers.get("set-auth-token");
  assert.ok(token, `expected bearer token for ${email}`);
  assert.equal(res.data?.user.email, email);
  return { token, email };
}

async function createDoc(token: string, docId: string) {
  const content = "# Share routes\n\nLocal auth lifecycle coverage.\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await jsonRequest<{ id: string; version: number }>(
    "PUT",
    `/api/docs/${docId}`,
    token,
    { name: "share-routes.md", content, hash, baseVersion: 0 }
  );
  assert.equal(res.status, 200);
  assert.equal(res.data?.id, docId);
  assert.equal(res.data?.version, 1);
}

test("authenticated share routes cover pending invites, member removal, and scoped public links", async () => {
  const owner = await signUp("Owner", `owner.${stamp}@test.local`);
  const bob = await signUp("Bob", `bob.${stamp}@test.local`);
  const docId = `share-routes-${stamp}`;
  const pendingEmail = `pending.${stamp}@test.local`;
  await createDoc(owner.token, docId);

  const viewerShare = await jsonRequest<{ status: string; userId: string; role: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: bob.email, role: "viewer" }
  );
  assert.equal(viewerShare.status, 200);
  assert.equal(viewerShare.data?.status, "member");
  assert.equal(viewerShare.data?.role, "viewer");
  assert.ok(viewerShare.data?.userId);

  const bobAccess = await jsonRequest<{
    access: { role: string; canRead: boolean; canEdit: boolean; canManage: boolean };
  }>("GET", `/api/docs/${docId}/access`, bob.token);
  assert.deepEqual(bobAccess.data?.access, {
    role: "viewer",
    canRead: true,
    canEdit: false,
    canManage: false,
  });

  const viewerWrite = await jsonRequest(
    "PUT",
    `/api/docs/${docId}`,
    bob.token,
    { name: "share-routes.md", content: "blocked", hash: "blocked", baseVersion: 1 }
  );
  assert.equal(viewerWrite.status, 403);

  const pendingInvite = await jsonRequest<{
    ok: boolean;
    status: string;
    email: string;
    role: string;
  }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: pendingEmail.toUpperCase(), role: "editor" }
  );
  assert.equal(pendingInvite.status, 200);
  assert.deepEqual(pendingInvite.data, {
    ok: true,
    status: "invited",
    email: pendingEmail,
    role: "editor",
  });

  const ownerShares = await jsonRequest<{
    shares: Array<{ user_id: string | null; email: string; role: string; pending?: boolean }>;
  }>("GET", `/api/docs/${docId}/shares`, owner.token);
  assert.equal(ownerShares.status, 200);
  assert.ok(ownerShares.data?.shares.some((s) => s.email === bob.email && s.role === "viewer"));
  assert.ok(
    ownerShares.data?.shares.some((s) => s.email === pendingEmail && s.role === "editor" && s.pending)
  );

  const viewerShares = await jsonRequest<{
    shares: Array<{ user_id: string | null; email: string; role: string; pending?: boolean }>;
  }>("GET", `/api/docs/${docId}/shares`, bob.token);
  assert.equal(viewerShares.status, 200);
  assert.ok(viewerShares.data?.shares.some((s) => s.email === bob.email && s.role === "viewer"));
  assert.ok(!viewerShares.data?.shares.some((s) => s.pending || s.email === pendingEmail));

  const sharedByMe = await jsonRequest<{
    docs: Array<{
      id: string;
      name: string;
      updated_at: string;
      memberCount: number;
      pendingCount: number;
    }>;
  }>("GET", "/api/docs/shared-by-me", owner.token);
  const sharedDoc = sharedByMe.data?.docs.find((d) => d.id === docId);
  assert.ok(sharedDoc);
  assert.deepEqual(sharedDoc, {
    id: docId,
    name: "share-routes.md",
    updated_at: sharedDoc.updated_at,
    memberCount: 1,
    pendingCount: 1,
  });

  const blockedRemove = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(viewerShare.data?.userId ?? "")}`,
    bob.token
  );
  assert.equal(blockedRemove.status, 403);

  const removeMember = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(viewerShare.data?.userId ?? "")}`,
    owner.token
  );
  assert.equal(removeMember.status, 200);
  const bobAfterRemove = await jsonRequest("GET", `/api/docs/${docId}`, bob.token);
  assert.equal(bobAfterRemove.status, 404);

  const removePending = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(pendingEmail.toUpperCase())}`,
    owner.token
  );
  assert.equal(removePending.status, 200);

  const reinvite = await jsonRequest<{ status: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    owner.token,
    { email: pendingEmail, role: "editor" }
  );
  assert.equal(reinvite.data?.status, "invited");

  const invited = await signUp("Pending", pendingEmail);
  const invitedDocs = await jsonRequest<{ docs: Array<{ id: string; shared?: boolean; role?: string }> }>(
    "GET",
    "/api/docs",
    invited.token
  );
  assert.ok(invitedDocs.data?.docs.some((d) => d.id === docId && d.shared && d.role === "editor"));
  const editorAccess = await jsonRequest<{
    access: { role: string; canRead: boolean; canEdit: boolean; canManage: boolean };
  }>("GET", `/api/docs/${docId}/access`, invited.token);
  assert.deepEqual(editorAccess.data?.access, {
    role: "editor",
    canRead: true,
    canEdit: true,
    canManage: false,
  });

  const createPublicLink = await jsonRequest<{ url: string }>(
    "POST",
    `/api/docs/${docId}/public-link`,
    owner.token
  );
  assert.equal(createPublicLink.status, 200);
  assert.match(createPublicLink.data?.url ?? "", /^https:\/\/markie\.test\/s\/[a-f0-9]+$/);

  const memberCanReadLink = await jsonRequest<{ url: string }>(
    "GET",
    `/api/docs/${docId}/public-link`,
    invited.token
  );
  assert.equal(memberCanReadLink.data?.url, createPublicLink.data?.url);

  const memberCannotRevoke = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/public-link`,
    invited.token
  );
  assert.equal(memberCannotRevoke.status, 403);

  const revoke = await jsonRequest("DELETE", `/api/docs/${docId}/public-link`, owner.token);
  assert.equal(revoke.status, 200);
  const afterRevoke = await jsonRequest<{ url: string | null }>(
    "GET",
    `/api/docs/${docId}/public-link`,
    owner.token
  );
  assert.equal(afterRevoke.data?.url, null);
});
