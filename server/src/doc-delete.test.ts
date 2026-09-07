import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-doc-delete-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-doc-delete-test-secret-32-plus-chars";
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

async function request(method: string, path: string, token: string, body?: unknown) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
    Origin: "http://localhost:3000",
    Authorization: `Bearer ${token}`,
  });
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

const sha = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

function push(token: string, id: string, content: string, baseVersion: number) {
  return request("PUT", `/api/docs/${id}`, token, {
    name: "keys.md",
    content,
    hash: sha(content),
    baseVersion,
  });
}

function rowsFor(db: Database.Database, table: string, docId: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE doc_id = ?`).get(docId) as { n: number }).n;
}

const SECRET = "PRODUCTION_API_KEY=do-not-keep-me-anywhere";

test("deleting a doc purges its text, its history and everything that pointed at it", async () => {
  const owner = await signUpVerified(app, { name: "Owner", email: `owner-${Date.now()}@example.com` });
  const id = crypto.randomUUID();

  assert.equal((await push(owner.token, id, "# draft\n", 0)).status, 200);
  assert.equal((await push(owner.token, id, `# keys\n\n${SECRET}\n`, 1)).status, 200);
  assert.equal((await request("POST", `/api/docs/${id}/public-link`, owner.token)).status, 200);
  assert.equal(
    (await request("POST", `/api/docs/${id}/shares`, owner.token, { email: "ghost@example.com", role: "viewer" })).status,
    200
  );
  const thread = await request("POST", `/api/docs/${id}/threads`, owner.token, {
    anchor: { from: 1, to: 4 },
    body: "why is this in here",
  });
  assert.ok(thread.status === 200 || thread.status === 201, `thread create returned ${thread.status}`);

  const before = new Database(process.env.DB_PATH!, { readonly: true });
  assert.equal(rowsFor(before, "doc_history", id), 2);
  assert.equal(rowsFor(before, "public_links", id), 1);
  assert.equal(rowsFor(before, "pending_shares", id), 1);
  assert.equal(rowsFor(before, "threads", id), 1);
  before.close();

  assert.equal((await request("DELETE", `/api/docs/${id}`, owner.token)).status, 200);

  // Gone from every API surface.
  assert.equal((await request("GET", `/api/docs/${id}`, owner.token)).status, 404);
  const listing = await request("GET", "/api/docs", owner.token);
  assert.ok(!listing.data.docs.some((d: { id: string }) => d.id === id), "still listed");
  assert.equal((await request("DELETE", `/api/docs/${id}`, owner.token)).status, 404);

  // Gone from every table, with the tombstone left behind.
  const after = new Database(process.env.DB_PATH!, { readonly: true });
  const row = after.prepare("SELECT content, hash, deleted_at FROM docs WHERE id = ?").get(id) as {
    content: string;
    hash: string;
    deleted_at: string | null;
  };
  assert.equal(row.content, "");
  assert.equal(row.hash, "");
  assert.ok(row.deleted_at);
  for (const table of ["doc_history", "public_links", "pending_shares", "shares", "threads", "doc_updates"]) {
    assert.equal(rowsFor(after, table, id), 0, `${table} still has rows`);
  }
  after.close();

  // Gone from the bytes on disk, not just from the rows: secure_delete zeroes
  // what a purge frees, and a checkpoint folds the WAL into the file.
  const sweep = new Database(process.env.DB_PATH!);
  sweep.pragma("wal_checkpoint(TRUNCATE)");
  sweep.close();
  for (const file of [process.env.DB_PATH!, `${process.env.DB_PATH}-wal`]) {
    if (!existsSync(file)) continue;
    assert.ok(!readFileSync(file).includes(SECRET), `${file} still contains the purged text`);
  }

  // The owner can start over on the same id, and history starts again at 1.
  const again = await push(owner.token, id, "# fresh\n", 0);
  assert.equal(again.status, 200);
  assert.equal(again.data.version, 1);
  const fresh = await request("GET", `/api/docs/${id}`, owner.token);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.doc.content, "# fresh\n");
});

test("a collab update that arrives after the delete is dropped, not stored", async () => {
  const { appendUpdate } = await import("./collab.ts");
  const owner = await signUpVerified(app, { name: "Owner", email: `owner2-${Date.now()}@example.com` });
  const id = crypto.randomUUID();
  assert.equal((await push(owner.token, id, "# live\n", 0)).status, 200);

  appendUpdate(id, new Uint8Array([1, 2, 3]));
  const live = new Database(process.env.DB_PATH!, { readonly: true });
  assert.equal(rowsFor(live, "doc_updates", id), 1);
  live.close();

  assert.equal((await request("DELETE", `/api/docs/${id}`, owner.token)).status, 200);
  // The socket that was mid-flight when the owner deleted the doc.
  appendUpdate(id, new Uint8Array([4, 5, 6]));
  const after = new Database(process.env.DB_PATH!, { readonly: true });
  assert.equal(rowsFor(after, "doc_updates", id), 0);
  after.close();
});
