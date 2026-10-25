// The docs columns the mobile and agent work added (format, origin_kind,
// origin_agent, created_at) arrive on a database that already has documents.
// Existing rows must keep working and get sensible values; a restart must
// change nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-docs-migration-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-docs-migration-test-secret-32-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

// The docs table as every server before this change created it.
const db = new Database(process.env.DB_PATH);
db.exec(`
  CREATE TABLE docs (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL, hash TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT
  );
`);
const insert = db.prepare("INSERT INTO docs (id, owner_id, name, version, content, hash, updated_at) VALUES (?, 'u1', ?, 3, 'x', 'h', ?)");
const rows: [string, string, string][] = [
  ["md", "Notes.md", "2026-01-01T00:00:00.000Z"],
  ["wd", "Calc.WD", "2026-01-02T00:00:00.000Z"],
  ["txt", "log.txt", "2026-01-03T00:00:00.000Z"],
  ["text", "a.text", "2026-01-04T00:00:00.000Z"],
  ["log", "server.log", "2026-01-05T00:00:00.000Z"],
  ["dotfile", ".wd", "2026-01-06T00:00:00.000Z"],
  ["none", "README", "2026-01-07T00:00:00.000Z"],
];
for (const r of rows) insert.run(...r);

await import("./docs.ts");

const read = () =>
  Object.fromEntries(
    (db.prepare("SELECT id, format, origin_kind, origin_agent, created_at, updated_at FROM docs").all() as Record<string, string>[]).map((r) => [r.id, r])
  );

test("existing rows are backfilled: format from the name, app origin, created_at from updated_at", () => {
  const got = read();
  const formats = Object.fromEntries(Object.entries(got).map(([id, r]) => [id, r.format]));
  assert.deepEqual(formats, { md: "markdown", wd: "darkmown", txt: "text", text: "text", log: "text", dotfile: "markdown", none: "markdown" });
  for (const r of Object.values(got)) {
    assert.equal(r.origin_kind, "app");
    assert.equal(r.origin_agent, null);
    assert.equal(r.created_at, r.updated_at);
  }
});

test("the SQL backfill and formatForName agree on every name", async () => {
  const { formatForName } = await import("./doc-meta.ts");
  const names = Object.fromEntries(rows.map(([id, name]) => [id, name]));
  for (const [id, r] of Object.entries(read())) assert.equal(r.format, formatForName(names[id]), names[id]);
});

test("a restart rewrites nothing", async () => {
  db.prepare("UPDATE docs SET format = 'text', created_at = '2025-01-01T00:00:00.000Z' WHERE id = 'md'").run();
  await import("./docs.ts?restart");
  const md = read().md;
  assert.equal(md.format, "text");
  assert.equal(md.created_at, "2025-01-01T00:00:00.000Z");
  const columns = (db.prepare("PRAGMA table_info(docs)").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns.filter((c) => ["format", "origin_kind", "origin_agent", "created_at"].includes(c)), ["format", "origin_kind", "origin_agent", "created_at"]);
});
