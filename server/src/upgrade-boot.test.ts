// Boot against a database that already has users in it.
//
// Every other server test builds its schema from empty, which means the whole
// suite only ever exercises a fresh install. That is not the case that breaks.
// On 2026-08-27 the 0.5.0 deploy could not start at all: better-auth 1.7 scopes
// account identity by a new required `issuer` column and refuses to add it to a
// populated `account` table, because there is no default and every existing row
// would take the same empty string. The refusal is correct and it happens inside
// the boot migration, so the container crash-looped and the API was down. 174
// passing tests said nothing, because not one of them had a row to migrate.
//
// So this file builds the PREVIOUS schema by hand, fills it, and runs the real
// boot sequence over it. Hand-built rather than a fixture copied from
// production, because production rows are real people's addresses and password
// hashes and do not belong in a repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "markie-upgrade-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-upgrade-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

// The better-auth 0.4.x-era shape, taken from the columns the live database
// actually had before the upgrade. `account` deliberately has no `issuer`.
const LEGACY_SCHEMA = `
  CREATE TABLE user (
    id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE account (
    id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
    userId TEXT NOT NULL, accessToken TEXT, refreshToken TEXT, idToken TEXT,
    accessTokenExpiresAt TEXT, refreshTokenExpiresAt TEXT, scope TEXT,
    password TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE session (
    id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL
  );
  CREATE TABLE verification (
    id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
    expiresAt TEXT NOT NULL, createdAt TEXT, updatedAt TEXT
  );
`;

const NOW = "2026-06-11T14:17:02.999Z";

function seedLegacy(path: string): void {
  const db = new Database(path);
  db.exec(LEGACY_SCHEMA);
  const user = db.prepare(
    "INSERT INTO user (id,name,email,emailVerified,image,createdAt,updatedAt) VALUES (?,?,?,?,NULL,?,?)"
  );
  const account = db.prepare(
    "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)"
  );
  const seed = db.transaction(() => {
    // Two password users and one Google user: the mix that matters, because the
    // two providers must not end up sharing an issuer value.
    user.run("u1", "Ada", "ada@example.test", 0, NOW, NOW);
    user.run("u2", "Grace", "grace@example.test", 0, NOW, NOW);
    user.run("u3", "Lin", "lin@example.test", 1, NOW, NOW);
    account.run("a1", "ada@example.test", "credential", "u1", "hash-1", NOW, NOW);
    account.run("a2", "grace@example.test", "credential", "u2", "hash-2", NOW, NOW);
    account.run("a3", "google-subject-123", "google", "u3", null, NOW, NOW);
  });
  seed();
  db.close();
}

seedLegacy(process.env.DB_PATH!);

const { backfill } = await import("./backfill-issuer.ts");
const { auth } = await import("./auth.ts");
const { getMigrations } = await import("better-auth/db/migration");

test("the boot migration refuses a populated database until it is repaired", async () => {
  // The failure itself, pinned. If a future better-auth stops rejecting this,
  // that is a change worth noticing rather than silently relying on.
  const bare = join(mkdtempSync(join(tmpdir(), "markie-upgrade-bare-")), "t.db");
  seedLegacy(bare);
  const previous = process.env.DB_PATH;
  process.env.DB_PATH = bare;
  try {
    await assert.rejects(
      async () => {
        const m = await getMigrations({ ...auth.options, database: new Database(bare) });
        await m.runMigrations();
      },
      (err: Error) => /issuer/i.test(String(err?.message ?? err)),
      "expected better-auth to refuse the required issuer column on a populated table"
    );
  } finally {
    process.env.DB_PATH = previous;
  }
});

test("the real boot sequence upgrades a populated database", async () => {
  // Step 1 is what the container runs before the migration.
  const result = backfill(process.env.DB_PATH!);
  assert.equal(result.added, true);
  assert.equal(result.updated, 3);
  assert.equal(result.remaining, 0);

  // Step 2 is the migration that used to be fatal.
  const m = await getMigrations(auth.options);
  await m.runMigrations();

  const db = new Database(process.env.DB_PATH!, { readonly: true });
  const rows = db
    .prepare("SELECT providerId, issuer FROM account ORDER BY id")
    .all() as Array<{ providerId: string; issuer: string }>;
  const users = db.prepare("SELECT COUNT(*) AS n FROM user").get() as { n: number };
  const passwords = db
    .prepare("SELECT COUNT(*) AS n FROM account WHERE password IS NOT NULL")
    .get() as { n: number };
  db.close();

  // Nobody was lost and nobody's password was dropped on the way through.
  assert.equal(users.n, 3);
  assert.equal(passwords.n, 2);

  // The value per provider has to match what better-auth writes for a NEW
  // account, or the row stops matching its owner and that person simply cannot
  // sign in, with nothing anywhere naming the cause.
  assert.deepEqual(rows, [
    { providerId: "credential", issuer: "local:credential" },
    { providerId: "credential", issuer: "local:credential" },
    { providerId: "google", issuer: "https://accounts.google.com" },
  ]);

  // Two providers must never collide on one issuer, which is the corruption
  // better-auth refused to create.
  assert.notEqual(rows[0].issuer, rows[2].issuer);
});

test("booting again changes nothing", async () => {
  const second = backfill(process.env.DB_PATH!);
  assert.equal(second.added, false);
  assert.equal(second.updated, 0);
  assert.equal(second.remaining, 0);

  const m = await getMigrations(auth.options);
  assert.equal(m.toBeCreated.length, 0);
  assert.equal(m.toBeAdded.length, 0, "a repeat boot must have nothing left to migrate");
});
