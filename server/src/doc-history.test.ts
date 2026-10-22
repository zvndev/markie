// doc_history keeps the newest DOC_HISTORY_KEEP snapshots per document and
// drops older ones on the push that makes them surplus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-doc-history-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-doc-history-test-secret-32-plus-chars";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs, DOC_HISTORY_KEEP } = await import("./docs.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
const db = new Database(process.env.DB_PATH);

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
async function push(token: string, id: string, content: string, baseVersion: number) {
  const res = await app.request(`/api/docs/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ name: "h.md", content, hash: sha(content), baseVersion }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { version: number }).version;
}
const versions = (id: string) =>
  (db.prepare("SELECT version FROM doc_history WHERE doc_id = ? ORDER BY version").all(id) as { version: number }[]).map((r) => r.version);

test("history keeps only the newest DOC_HISTORY_KEEP versions, the current one included", async () => {
  const user = await signUpVerified(app, { name: "H", email: "history@test.local" });
  const id = crypto.randomUUID();
  const other = crypto.randomUUID();
  await push(user.token, other, "untouched", 0);

  let version = 0;
  for (let i = 0; i < DOC_HISTORY_KEEP + 7; i += 1) version = await push(user.token, id, `v${i}`, version);
  assert.equal(version, DOC_HISTORY_KEEP + 7);
  const kept = versions(id);
  assert.equal(kept.length, DOC_HISTORY_KEEP);
  assert.equal(kept[0], version - DOC_HISTORY_KEEP + 1);
  assert.equal(kept.at(-1), version);
  const newest = db.prepare("SELECT content FROM doc_history WHERE doc_id = ? AND version = ?").get(id, version) as { content: string };
  assert.equal(newest.content, `v${DOC_HISTORY_KEEP + 6}`);
  // Another document's history is never touched by this one's pruning.
  assert.deepEqual(versions(other), [1]);
});

test("a document under the cap keeps every version", async () => {
  const user = await signUpVerified(app, { name: "H2", email: "history2@test.local" });
  const id = crypto.randomUUID();
  let version = 0;
  for (let i = 0; i < 3; i += 1) version = await push(user.token, id, `v${i}`, version);
  assert.deepEqual(versions(id), [1, 2, 3]);
});
