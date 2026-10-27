import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllDatabases, openDatabase } from "./db.ts";

test("openDatabase turns secure_delete on for the handle it returns", () => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "markie-db-")), "t.db"));
  assert.equal(db.pragma("secure_delete", { simple: true }), 1);
  db.close();
});

test("openDatabase puts the file in WAL mode, which Litestream replicates from", () => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "markie-db-")), "t.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
  db.close();
});

test("closeAllDatabases closes every handle openDatabase gave out, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "markie-db-"));
  const a = openDatabase(join(dir, "a.db"));
  const b = openDatabase(join(dir, "b.db"));
  b.close();
  assert.equal(closeAllDatabases(), 1);
  assert.equal(a.open, false);
  assert.equal(closeAllDatabases(), 0);
});
