// The value written here has to be byte-identical to what better-auth writes
// for a new account of the same provider. If it is not, the account row stops
// matching its own owner and that user cannot sign in, silently, with no error
// anywhere that names the cause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { issuerFor, backfill } from "./backfill-issuer.ts";

test("a password account takes better-auth's local form", () => {
  assert.equal(issuerFor("credential"), "local:credential");
});

test("Google takes its own declared issuer, not the generic one", () => {
  // The bug this pins: social providers are exported as factories, so reading
  // `.accountIssuer` off the export finds nothing and the generic helper
  // produces "local:oauth:google". Both look plausible; only one lets an
  // existing Google user sign in.
  assert.equal(issuerFor("google"), "https://accounts.google.com");
  assert.notEqual(issuerFor("google"), "local:oauth:google");
});

test("a provider with no declared issuer still gets a stable value", () => {
  const v = issuerFor("github");
  assert.ok(typeof v === "string" && v.length > 0);
  assert.notEqual(v, issuerFor("google"));
});

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "markie-issuer-"));
  const path = join(dir, "t.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE account (
      id TEXT PRIMARY KEY, accountId TEXT, providerId TEXT, userId TEXT, password TEXT
    );
    INSERT INTO account (id, accountId, providerId, userId) VALUES
      ('a1','u1','credential','u1'),
      ('a2','u2','credential','u2'),
      ('a3','g1','google','u3');
  `);
  db.close();
  return path;
}

test("backfills every row, per provider, and says so", () => {
  const path = seed();
  const r = backfill(path);
  assert.equal(r.added, true);
  assert.equal(r.updated, 3);
  assert.equal(r.remaining, 0);

  const db = new Database(path, { readonly: true });
  const rows = db.prepare("SELECT providerId, issuer FROM account ORDER BY id").all() as Array<{
    providerId: string;
    issuer: string;
  }>;
  db.close();
  assert.deepEqual(rows.map((r) => r.issuer), [
    "local:credential",
    "local:credential",
    "https://accounts.google.com",
  ]);
});

test("is safe to run on every boot forever", () => {
  const path = seed();
  backfill(path);
  const second = backfill(path);
  assert.equal(second.added, false);
  assert.equal(second.updated, 0);
  assert.equal(second.remaining, 0);
});

test("does nothing to a database that has no account table yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "markie-issuer-fresh-"));
  const path = join(dir, "t.db");
  new Database(path).close();
  const r = backfill(path);
  assert.deepEqual(r, { added: false, updated: 0, remaining: 0 });
});

test("leaves an already-correct row alone", () => {
  const path = seed();
  const db = new Database(path);
  db.exec("ALTER TABLE account ADD COLUMN issuer TEXT");
  db.exec("UPDATE account SET issuer='https://accounts.google.com' WHERE id='a3'");
  db.close();
  const r = backfill(path);
  assert.equal(r.added, false);
  assert.equal(r.updated, 2); // only the two that were empty
  assert.equal(r.remaining, 0);
});
