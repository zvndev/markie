// Authorization on every comment route. The comment API is the one surface
// where a viewer, an editor, the owner and a stranger all reach the same doc,
// so each route is checked from each of those seats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-comments-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-comments-test-secret-32-plus-characters";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { comments } = await import("./comments.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api/docs", comments);

const stamp = Date.now();

async function call<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T | null }> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
    Origin: "http://localhost:3000",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

async function signUp(name: string, email: string): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "127.0.0.1",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ name, email, password: "password-123" }),
  });
  assert.equal(res.status, 200);
  const token = res.headers.get("set-auth-token");
  assert.ok(token, `expected a bearer token for ${email}`);
  return token;
}

async function createDoc(token: string, docId: string) {
  const content = "# Comments\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await call("PUT", `/api/docs/${docId}`, token, {
    name: "comments.md",
    content,
    hash,
    baseVersion: 0,
  });
  assert.equal(res.status, 200);
}

interface Fixture {
  docId: string;
  owner: string;
  editor: string;
  viewer: string;
  stranger: string;
  ownerEmail: string;
  editorEmail: string;
  viewerEmail: string;
}

// better-auth rate-limits sign-up, so the four seats are created once and every
// test gets its own document instead of its own accounts.
const ownerEmail = `owner-${stamp}@markie.test`;
const editorEmail = `editor-${stamp}@markie.test`;
const viewerEmail = `viewer-${stamp}@markie.test`;
const owner = await signUp("Owner", ownerEmail);
const editor = await signUp("Editor", editorEmail);
const viewer = await signUp("Viewer", viewerEmail);
const stranger = await signUp("Stranger", `stranger-${stamp}@markie.test`);

async function fixture(): Promise<Fixture> {
  const docId = randomUUID();
  await createDoc(owner, docId);
  assert.equal(
    (await call("POST", `/api/docs/${docId}/shares`, owner, { email: editorEmail, role: "editor" })).status,
    200
  );
  assert.equal(
    (await call("POST", `/api/docs/${docId}/shares`, owner, { email: viewerEmail, role: "viewer" })).status,
    200
  );
  return { docId, owner, editor, viewer, stranger, ownerEmail, editorEmail, viewerEmail };
}

async function thread(f: Fixture, token: string, body = "First note") {
  const res = await call<{ id: string; commentId: string }>(
    "POST",
    `/api/docs/${f.docId}/threads`,
    token,
    { anchor: { from: { c: 1 }, to: { c: 4 } }, body }
  );
  assert.equal(res.status, 200);
  assert.ok(res.data?.id);
  return res.data!;
}

interface ThreadView {
  id: string;
  status: "open" | "resolved";
  anchor: unknown;
  comments: Array<{ id: string; body: string; author_name: string; author_email: string }>;
}

test("every comment route rejects an unauthenticated caller", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);
  for (const [method, path] of [
    ["GET", `/api/docs/${f.docId}/threads`],
    ["POST", `/api/docs/${f.docId}/threads`],
    ["POST", `/api/docs/${f.docId}/threads/${t.id}/comments`],
    ["POST", `/api/docs/${f.docId}/threads/${t.id}/status`],
    ["DELETE", `/api/docs/${f.docId}/threads/${t.id}/comments/${t.commentId}`],
  ] as const) {
    const res = await call(method, path, undefined, method === "GET" ? undefined : {});
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("a non-member is forbidden from every comment route", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);
  const cases: Array<[string, string, unknown]> = [
    ["GET", `/api/docs/${f.docId}/threads`, undefined],
    ["POST", `/api/docs/${f.docId}/threads`, { anchor: {}, body: "hi" }],
    ["POST", `/api/docs/${f.docId}/threads/${t.id}/comments`, { body: "hi" }],
    ["POST", `/api/docs/${f.docId}/threads/${t.id}/status`, { status: "resolved" }],
  ];
  for (const [method, path, body] of cases) {
    const res = await call<{ error: string }>(method, path, f.stranger, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.data?.error, "forbidden");
  }
  const del = await call<{ error: string }>(
    "DELETE",
    `/api/docs/${f.docId}/threads/${t.id}/comments/${t.commentId}`,
    f.stranger
  );
  assert.equal(del.status, 403);
  assert.equal(del.data?.error, "forbidden");
});

test("a viewer may read threads and start one of their own", async () => {
  const f = await fixture();
  await thread(f, f.owner, "Owner's note");

  const read = await call<{ threads: ThreadView[] }>(
    "GET",
    `/api/docs/${f.docId}/threads`,
    f.viewer
  );
  assert.equal(read.status, 200);
  assert.equal(read.data?.threads.length, 1);
  assert.equal(read.data?.threads[0].comments[0].body, "Owner's note");
  assert.equal(read.data?.threads[0].comments[0].author_email, f.ownerEmail);
  // the anchor comes back as the JSON that went in, not a string
  assert.deepEqual(read.data?.threads[0].anchor, { from: { c: 1 }, to: { c: 4 } });

  // Commenting follows read access, so a viewer can open a thread even though
  // they cannot edit the document.
  const write = await call<{ id: string }>(
    "POST",
    `/api/docs/${f.docId}/threads`,
    f.viewer,
    { anchor: { from: { c: 2 }, to: { c: 6 } }, body: "May I?" }
  );
  assert.equal(write.status, 200);
  assert.ok(write.data?.id);

  const after = await call<{ threads: ThreadView[] }>(
    "GET",
    `/api/docs/${f.docId}/threads`,
    f.owner
  );
  assert.deepEqual(
    after.data?.threads.map((t) => t.comments[0].body),
    ["Owner's note", "May I?"]
  );
  assert.equal(
    after.data?.threads[1].comments[0].author_email,
    f.viewerEmail
  );
});

test("an editor, the owner and a viewer may all reply to a thread", async () => {
  const f = await fixture();
  const t = await thread(f, f.editor, "Editor opened this");

  const reply = await call<{ id: string }>(
    "POST",
    `/api/docs/${f.docId}/threads/${t.id}/comments`,
    f.owner,
    { body: "Owner replied" }
  );
  assert.equal(reply.status, 200);

  const viewerReply = await call<{ id: string }>(
    "POST",
    `/api/docs/${f.docId}/threads/${t.id}/comments`,
    f.viewer,
    { body: "Viewer replied" }
  );
  assert.equal(viewerReply.status, 200);
  assert.ok(viewerReply.data?.id);

  const read = await call<{ threads: ThreadView[] }>(
    "GET",
    `/api/docs/${f.docId}/threads`,
    f.viewer
  );
  assert.deepEqual(
    read.data?.threads[0].comments.map((c) => c.body),
    ["Editor opened this", "Owner replied", "Viewer replied"]
  );
});

test("a viewer still cannot resolve or reopen a thread", async () => {
  const f = await fixture();
  const t = await thread(f, f.viewer, "Viewer's own note");

  // even on the thread they opened themselves
  for (const status of ["resolved", "open"] as const) {
    const res = await call<{ error: string }>(
      "POST",
      `/api/docs/${f.docId}/threads/${t.id}/status`,
      f.viewer,
      { status }
    );
    assert.equal(res.status, 403, status);
    assert.equal(res.data?.error, "forbidden");
  }

  const read = await call<{ threads: ThreadView[] }>(
    "GET",
    `/api/docs/${f.docId}/threads`,
    f.owner
  );
  assert.equal(read.data?.threads[0].status, "open");
});

test("a viewer may delete their own comment but not somebody else's", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner, "Owner's note");
  const mine = await call<{ id: string }>(
    "POST",
    `/api/docs/${f.docId}/threads/${t.id}/comments`,
    f.viewer,
    { body: "Viewer's reply" }
  );
  assert.equal(mine.status, 200);

  const forbidden = await call<{ error: string }>(
    "DELETE",
    `/api/docs/${f.docId}/threads/${t.id}/comments/${t.commentId}`,
    f.viewer
  );
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data?.error, "forbidden");

  const own = await call<{ ok: boolean; threadDeleted: boolean }>(
    "DELETE",
    `/api/docs/${f.docId}/threads/${t.id}/comments/${mine.data!.id}`,
    f.viewer
  );
  assert.equal(own.status, 200);
  assert.equal(own.data?.threadDeleted, false);

  const read = await call<{ threads: ThreadView[] }>(
    "GET",
    `/api/docs/${f.docId}/threads`,
    f.owner
  );
  assert.deepEqual(
    read.data?.threads[0].comments.map((c) => c.body),
    ["Owner's note"]
  );
});

test("losing viewer access takes the right to comment with it", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);
  assert.equal(
    (await call("POST", `/api/docs/${f.docId}/threads/${t.id}/comments`, f.viewer, {
      body: "While I still can",
    })).status,
    200
  );

  const list = await call<{ shares: Array<{ user_id: string | null; email: string }> }>(
    "GET",
    `/api/docs/${f.docId}/shares`,
    f.owner
  );
  const target = list.data?.shares.find((m) => m.email === f.viewerEmail);
  assert.ok(target?.user_id);
  assert.equal(
    (await call("DELETE", `/api/docs/${f.docId}/shares/${target.user_id}`, f.owner)).status,
    200
  );

  assert.equal(
    (await call("POST", `/api/docs/${f.docId}/threads`, f.viewer, {
      anchor: {},
      body: "Still here?",
    })).status,
    403
  );
  assert.equal(
    (await call("POST", `/api/docs/${f.docId}/threads/${t.id}/comments`, f.viewer, {
      body: "Still here?",
    })).status,
    403
  );
});

test("a thread needs an anchor and a non-empty body", async () => {
  const f = await fixture();
  for (const body of [
    { anchor: null, body: "hi" },
    { anchor: {}, body: "" },
    { anchor: {}, body: "   " },
    { anchor: {}, body: 42 },
  ]) {
    const res = await call("POST", `/api/docs/${f.docId}/threads`, f.owner, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("a reply needs a real thread on this doc and a non-empty body", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);

  const missing = await call(
    "POST",
    `/api/docs/${f.docId}/threads/${randomUUID()}/comments`,
    f.owner,
    { body: "hi" }
  );
  assert.equal(missing.status, 404);

  const blank = await call(
    "POST",
    `/api/docs/${f.docId}/threads/${t.id}/comments`,
    f.owner,
    { body: "  " }
  );
  assert.equal(blank.status, 400);
});

test("a thread cannot be replied to through another doc's id", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);
  const otherDoc = randomUUID();
  await createDoc(f.owner, otherDoc);

  const res = await call(
    "POST",
    `/api/docs/${otherDoc}/threads/${t.id}/comments`,
    f.owner,
    { body: "hi" }
  );
  assert.equal(res.status, 404);
});

test("an editor can resolve and reopen a thread; a viewer cannot", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);

  const resolved = await call("POST", `/api/docs/${f.docId}/threads/${t.id}/status`, f.editor, {
    status: "resolved",
  });
  assert.equal(resolved.status, 200);
  let read = await call<{ threads: ThreadView[] }>("GET", `/api/docs/${f.docId}/threads`, f.owner);
  assert.equal(read.data?.threads[0].status, "resolved");

  const reopened = await call("POST", `/api/docs/${f.docId}/threads/${t.id}/status`, f.owner, {
    status: "open",
  });
  assert.equal(reopened.status, 200);
  read = await call<{ threads: ThreadView[] }>("GET", `/api/docs/${f.docId}/threads`, f.owner);
  assert.equal(read.data?.threads[0].status, "open");

  const viewer = await call("POST", `/api/docs/${f.docId}/threads/${t.id}/status`, f.viewer, {
    status: "resolved",
  });
  assert.equal(viewer.status, 403);
});

test("status only accepts open and resolved, on a thread that exists", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);

  const bad = await call("POST", `/api/docs/${f.docId}/threads/${t.id}/status`, f.owner, {
    status: "archived",
  });
  assert.equal(bad.status, 400);

  const missing = await call(
    "POST",
    `/api/docs/${f.docId}/threads/${randomUUID()}/status`,
    f.owner,
    { status: "resolved" }
  );
  assert.equal(missing.status, 404);
});

test("you can delete your own comment but not somebody else's", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner, "Owner's note");
  const reply = await call<{ id: string }>(
    "POST",
    `/api/docs/${f.docId}/threads/${t.id}/comments`,
    f.editor,
    { body: "Editor's reply" }
  );

  // the editor cannot delete the owner's comment
  const forbidden = await call(
    "DELETE",
    `/api/docs/${f.docId}/threads/${t.id}/comments/${t.commentId}`,
    f.editor
  );
  assert.equal(forbidden.status, 403);

  // but can delete their own
  const own = await call<{ ok: boolean; threadDeleted: boolean }>(
    "DELETE",
    `/api/docs/${f.docId}/threads/${t.id}/comments/${reply.data!.id}`,
    f.editor
  );
  assert.equal(own.status, 200);
  assert.equal(own.data?.threadDeleted, false);

  const read = await call<{ threads: ThreadView[] }>("GET", `/api/docs/${f.docId}/threads`, f.owner);
  assert.deepEqual(read.data?.threads[0].comments.map((c) => c.body), ["Owner's note"]);
});

test("the doc owner can delete anybody's comment", async () => {
  const f = await fixture();
  const t = await thread(f, f.editor, "Editor's note");
  const reply = await call<{ id: string }>(
    "POST",
    `/api/docs/${f.docId}/threads/${t.id}/comments`,
    f.editor,
    { body: "Second" }
  );

  const res = await call<{ ok: boolean }>(
    "DELETE",
    `/api/docs/${f.docId}/threads/${t.id}/comments/${reply.data!.id}`,
    f.owner
  );
  assert.equal(res.status, 200);

  // The 200 must mean the comment is actually gone, and only that one.
  const read = await call<{ threads: ThreadView[] }>("GET", `/api/docs/${f.docId}/threads`, f.owner);
  assert.deepEqual(read.data?.threads[0].comments.map((c) => c.body), ["Editor's note"]);
});

test("deleting the last comment deletes the thread with it", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);

  const res = await call<{ ok: boolean; threadDeleted: boolean }>(
    "DELETE",
    `/api/docs/${f.docId}/threads/${t.id}/comments/${t.commentId}`,
    f.owner
  );
  assert.equal(res.status, 200);
  assert.equal(res.data?.threadDeleted, true);

  const read = await call<{ threads: ThreadView[] }>("GET", `/api/docs/${f.docId}/threads`, f.owner);
  assert.deepEqual(read.data?.threads, []);
});

test("deleting an unknown comment is a 404, not a crash", async () => {
  const f = await fixture();
  const t = await thread(f, f.owner);
  const res = await call(
    "DELETE",
    `/api/docs/${f.docId}/threads/${t.id}/comments/${randomUUID()}`,
    f.owner
  );
  assert.equal(res.status, 404);
});

test("removing a viewer takes their comment access with it", async () => {
  const f = await fixture();
  await thread(f, f.owner);
  assert.equal(
    (await call("GET", `/api/docs/${f.docId}/threads`, f.viewer)).status,
    200
  );

  const list = await call<{ shares: Array<{ user_id: string | null; email: string }> }>(
    "GET",
    `/api/docs/${f.docId}/shares`,
    f.owner
  );
  const target = list.data?.shares.find((m) => m.email === f.viewerEmail);
  assert.ok(target?.user_id);
  assert.equal(
    (await call("DELETE", `/api/docs/${f.docId}/shares/${target.user_id}`, f.owner)).status,
    200
  );

  assert.equal(
    (await call("GET", `/api/docs/${f.docId}/threads`, f.viewer)).status,
    403
  );
});

test("threads come back oldest first", async () => {
  const f = await fixture();
  await thread(f, f.owner, "One");
  await new Promise((r) => setTimeout(r, 5));
  await thread(f, f.owner, "Two");

  const read = await call<{ threads: ThreadView[] }>("GET", `/api/docs/${f.docId}/threads`, f.owner);
  assert.deepEqual(
    read.data?.threads.map((t) => t.comments[0].body),
    ["One", "Two"]
  );
});
