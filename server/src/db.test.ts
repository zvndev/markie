import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";

test("openDatabase turns secure_delete on for the handle it returns", () => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "markie-db-")), "t.db"));
  assert.equal(db.pragma("secure_delete", { simple: true }), 1);
  db.close();
});
