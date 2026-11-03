// Who a new comment is mailed to. The mail quotes the comment in full, so it
// may only reach people who can read the document right now: the owner, and
// those participants in the thread who still have access. Removing somebody
// leaves their old comments in the thread, and that must not keep them on the
// mailing list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-comments-notify-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-comments-notify-test-secret-32-plus";
process.env.MARKIE_SITE_URL = "https://markie.test";

// Mail goes to Resend through fetch (email.ts); capture what would have been
// sent. Production code is untouched: this is the same seam the mail suites use.
type Sent = { to: string[]; subject: string; text: string };
const sent: Sent[] = [];
process.env.RESEND_API_KEY = "test-key";
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body)));
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { comments } = await import("./comments.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api/docs", comments);

async function call<T>(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: "http://localhost:3000",
      "x-forwarded-for": "127.0.0.1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

const stamp = Date.now();
const owner = await signUpVerified(app, { name: "Owner", email: `owner-${stamp}@markie.test` });
const editor = await signUpVerified(app, { name: "Editor", email: `editor-${stamp}@markie.test` });
const viewer = await signUpVerified(app, { name: "Viewer", email: `viewer-${stamp}@markie.test` });

async function sharedDoc(): Promise<string> {
  const docId = randomUUID();
  const content = "# Notes\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  assert.equal(
    (await call("PUT", `/api/docs/${docId}`, owner.token, { name: "notes.md", content, hash, baseVersion: 0 })).status,
    200
  );
  for (const [who, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
    assert.equal(
      (await call("POST", `/api/docs/${docId}/shares`, owner.token, { email: who.email, role })).status,
      200
    );
  }
  return docId;
}

// The notification is fire-and-forget, so wait for it rather than trust the
// order of awaits inside the route.
async function commentMailFor(body: string): Promise<string[]> {
  for (let i = 0; i < 20; i++) {
    const found = sent.filter((m) => m.subject.includes("commented on") && m.text.includes(body));
    if (found.length > 0) {
      await new Promise((r) => setTimeout(r, 10));
      return sent
        .filter((m) => m.subject.includes("commented on") && m.text.includes(body))
        .flatMap((m) => m.to)
        .sort();
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

async function reply(docId: string, threadId: string, token: string, body: string) {
  const res = await call("POST", `/api/docs/${docId}/threads/${threadId}/comments`, token, { body });
  assert.equal(res.status, 200);
}

test("a removed member stops getting comment mail from threads they took part in", async () => {
  const docId = await sharedDoc();
  const t = await call<{ id: string }>("POST", `/api/docs/${docId}/threads`, owner.token, {
    anchor: { from: { c: 1 }, to: { c: 3 } },
    body: `opening ${stamp}`,
  });
  assert.equal(t.status, 200);
  const threadId = t.data!.id;
  await reply(docId, threadId, viewer.token, `viewer joins ${stamp}`);

  // While they can read the document, the viewer is on the list.
  await reply(docId, threadId, editor.token, `before removal ${stamp}`);
  assert.deepEqual(await commentMailFor(`before removal ${stamp}`), [owner.email, viewer.email].sort());

  assert.equal((await call("DELETE", `/api/docs/${docId}/shares/${viewer.id}`, owner.token)).status, 200);

  // Their comment is still in the thread, but the mail no longer reaches them.
  await reply(docId, threadId, editor.token, `after removal ${stamp}`);
  assert.deepEqual(await commentMailFor(`after removal ${stamp}`), [owner.email]);

  await reply(docId, threadId, owner.token, `owner after removal ${stamp}`);
  assert.deepEqual(await commentMailFor(`owner after removal ${stamp}`), [editor.email]);
});

test("the owner is mailed whether or not they are in the thread", async () => {
  const docId = await sharedDoc();
  const t = await call<{ id: string }>("POST", `/api/docs/${docId}/threads`, editor.token, {
    anchor: { from: { c: 1 }, to: { c: 3 } },
    body: `editor opens ${stamp}`,
  });
  assert.equal(t.status, 200);
  assert.deepEqual(await commentMailFor(`editor opens ${stamp}`), [owner.email]);
});
