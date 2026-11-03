// Boot against a database that already has users in it.
//
// Every other server test builds its schema from empty, which means the whole
// suite only ever exercises a fresh install. That is not the case that breaks.
// On 2026-08-27 the 0.5.0 deploy could not start at all: better-auth 1.7.0
// scoped account identity by a new required `issuer` column and refused to add
// it to a populated `account` table, and 174 passing tests said nothing.
//
// better-auth 1.7.3 then reverted that column. New rows no longer write it, so
// a database that still has it NOT NULL rejects every sign-up, and better-auth
// refuses every auth request until it is gone. A server first created on
// 1.7.0-1.7.2 (any self-hosted install since then) has exactly that shape; one
// that predates 1.7 got the column nullable from our old backfill shim.
//
// So this file builds each previous schema by hand, fills it, and runs the
// real boot sequence (relax-account-issuer, then the auth migration) over it.
// Hand-built rather than a fixture copied from production, because production
// rows are real people's addresses and password hashes and do not belong in a
// repository.
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
process.env.MARKIE_NO_LISTEN = "1";
process.env.MARKIE_SIGNUP = "open";
process.env.RESEND_API_KEY = "synthetic-mail-key-not-a-credential";

const sent: { email: string; code: string }[] = [];
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://api.resend.com/emails", "No real network request is allowed");
  const body = JSON.parse(String(init?.body)) as { to: string[]; text: string };
  sent.push({ email: body.to[0], code: body.text.match(/\b\d{6}\b/)?.[0] ?? "" });
  return Response.json({ id: "synthetic-message" });
};

// The better-auth 1.6-era shape, taken from the columns the live database had
// before the 1.7 upgrade. `account` has no `issuer`.
const ACCOUNT_16 = `
  CREATE TABLE account (
    id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
    userId TEXT NOT NULL, accessToken TEXT, refreshToken TEXT, idToken TEXT,
    accessTokenExpiresAt TEXT, refreshTokenExpiresAt TEXT, scope TEXT,
    password TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
`;

// What better-auth 1.7.0-1.7.2 creates on an empty database, as its own
// migration printed it.
const ACCOUNT_171 = `
  CREATE TABLE "account" ("id" text not null primary key, "issuer" text not null,
    "accountId" text not null, "providerId" text not null,
    "userId" text not null references "user" ("id") on delete cascade,
    "accessToken" text, "refreshToken" text, "idToken" text,
    "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text,
    "password" text, "createdAt" date not null, "updatedAt" date not null);
  CREATE INDEX "account_userId_idx" on "account" ("userId");
  CREATE UNIQUE INDEX "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");
`;

const OTHER_TABLES = `
  CREATE TABLE user (
    id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
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

type Shape = "1.6" | "1.6-backfilled" | "1.7.1";

function seed(path: string, shape: Shape): void {
  const db = new Database(path);
  db.exec(OTHER_TABLES + (shape === "1.7.1" ? ACCOUNT_171 : ACCOUNT_16));
  if (shape === "1.6-backfilled") {
    // What the old backfill shim plus the 1.7.1 migration left on a database
    // that was already populated: the column nullable, every row filled, and
    // the unique index.
    db.exec(`ALTER TABLE account ADD COLUMN issuer TEXT`);
  }
  const withIssuer = shape !== "1.6";
  const user = db.prepare(
    "INSERT INTO user (id,name,email,emailVerified,image,createdAt,updatedAt) VALUES (?,?,?,?,NULL,?,?)"
  );
  const account = db.prepare(
    withIssuer
      ? "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt,issuer) VALUES (?,?,?,?,?,?,?,?)"
      : "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)"
  );
  const row = (...args: unknown[]) => (withIssuer ? args : args.slice(0, 7));
  db.transaction(() => {
    // Two password users and one Google user: the mix that matters.
    user.run("u1", "Ada", "ada@example.test", 1, NOW, NOW);
    user.run("u2", "Grace", "grace@example.test", 0, NOW, NOW);
    user.run("u3", "Lin", "lin@example.test", 1, NOW, NOW);
    account.run(...row("a1", "ada@example.test", "credential", "u1", "hash-1", NOW, NOW, "local:credential"));
    account.run(...row("a2", "grace@example.test", "credential", "u2", "hash-2", NOW, NOW, "local:credential"));
    account.run(...row("a3", "google-subject-123", "google", "u3", null, NOW, NOW, "https://accounts.google.com"));
  })();
  if (shape === "1.6-backfilled") {
    db.exec(`CREATE UNIQUE INDEX "account_issuer_accountId_uidx" on "account" ("issuer", "accountId")`);
  }
  db.close();
}

function fresh(shape: Shape): string {
  const path = join(mkdtempSync(join(tmpdir(), "markie-upgrade-shape-")), "t.db");
  seed(path, shape);
  return path;
}

function accountState(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const columns = (db.prepare("PRAGMA table_info(account)").all() as Array<{ name: string }>).map((c) => c.name);
    const indexes = (db.prepare("PRAGMA index_list(account)").all() as Array<{ name: string }>).map((i) => i.name);
    const rows = db
      .prepare("SELECT id, accountId, providerId, userId, password FROM account WHERE id IN ('a1','a2','a3') ORDER BY id")
      .all();
    const users = (db.prepare("SELECT COUNT(*) AS n FROM user").get() as { n: number }).n;
    return { columns, indexes, rows, users };
  } finally {
    db.close();
  }
}

const SEEDED_ROWS = [
  { id: "a1", accountId: "ada@example.test", providerId: "credential", userId: "u1", password: "hash-1" },
  { id: "a2", accountId: "grace@example.test", providerId: "credential", userId: "u2", password: "hash-2" },
  { id: "a3", accountId: "google-subject-123", providerId: "google", userId: "u3", password: null },
];

// The live server for this file runs on the hardest case: a database first
// created by better-auth 1.7.1, with the column NOT NULL.
seed(process.env.DB_PATH!, "1.7.1");

// Step 1 of the boot, run the way the container runs it: before the server
// process (and better-auth's startup schema check) ever opens the database.
const { relaxAccountIssuer } = await import("./relax-account-issuer.ts");
const bootRepair = relaxAccountIssuer(process.env.DB_PATH!);
const { auth } = await import("./auth.ts");
const { getMigrations } = await import("better-auth/db/migration");
const { betterAuth } = await import("better-auth");

test("better-auth refuses every sign-up while the 1.7.1 issuer column is still required", async () => {
  // The failure itself, pinned, on a copy that skips the repair. If a future
  // better-auth stops rejecting this, that is worth noticing.
  const bare = fresh("1.7.1");
  const unrepaired = betterAuth({ ...auth.options, database: new Database(bare) });
  await assert.rejects(
    () =>
      unrepaired.api.signUpEmail({
        body: { name: "Blocked", email: "blocked@example.test", password: "password-123" },
      }),
    (err: Error) => /issuer/i.test(String(err?.message ?? err)),
    "expected better-auth to reject auth on a database that still requires account.issuer"
  );
});

test("the real boot sequence repairs a database created on better-auth 1.7.1", async () => {
  assert.deepEqual(bootRepair, { dropped: true, indexes: ["account_issuer_accountId_uidx"] });

  // Step 2 is the migration.
  await (await getMigrations(auth.options)).runMigrations();

  const state = accountState(process.env.DB_PATH!);
  assert.ok(!state.columns.includes("issuer"));
  assert.ok(!state.indexes.includes("account_issuer_accountId_uidx"));
  assert.ok(state.indexes.includes("account_userId_idx"), "the userId index is not ours to drop");
  // Nobody was lost and nobody's password was dropped on the way through.
  assert.equal(state.users, 3);
  assert.deepEqual(state.rows, SEEDED_ROWS);
});

test("after the repair a new account can sign up, and existing users sign in by email code", async () => {
  const { app } = await import("./index.ts");
  const { signUpVerified } = await import("./test-users.ts");
  const headers = { "content-type": "application/json", origin: "http://localhost:3000" };

  // A new password account: an INSERT into account that 1.7.1's NOT NULL
  // column would have rejected.
  const created = await signUpVerified(app, { name: "New", email: "new@example.test" });
  assert.ok(created.token);

  // An existing user signs in with the emailed code.
  const send = await app.request("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { ...headers, "x-forwarded-for": "10.77.0.1" },
    body: JSON.stringify({ email: "ada@example.test", type: "sign-in" }),
  });
  assert.equal(send.status, 200);
  const code = sent.filter((m) => m.email === "ada@example.test").at(-1)?.code;
  assert.ok(code, "expected a sign-in code for ada");
  const signedIn = await app.request("/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { ...headers, "x-forwarded-for": "10.77.0.2" },
    body: JSON.stringify({ email: "ada@example.test", otp: code }),
  });
  assert.equal(signedIn.status, 200);
  assert.equal(((await signedIn.json()) as { user: { id: string } }).user.id, "u1");

  // A Google account row for a new subject inserts, and the existing Google
  // account is still found by its provider key.
  const context = await auth.$context;
  const linked = await context.internalAdapter.createAccount({
    userId: created.id,
    providerId: "google",
    accountId: "google-subject-456",
  });
  assert.equal(linked.providerId, "google");
  const existing = await context.internalAdapter.findAccountByKey({
    providerId: "google",
    accountId: "google-subject-123",
  });
  assert.equal(existing?.userId, "u3");
});

test("a database our old backfill upgraded (nullable column) ends the same way", async () => {
  const path = fresh("1.6-backfilled");
  assert.deepEqual(relaxAccountIssuer(path), { dropped: true, indexes: ["account_issuer_accountId_uidx"] });
  const state = accountState(path);
  assert.ok(!state.columns.includes("issuer"));
  assert.equal(state.users, 3);
  assert.deepEqual(state.rows, SEEDED_ROWS);
});

test("a 1.6 database without the column is left alone and migrates", async () => {
  const path = fresh("1.6");
  assert.deepEqual(relaxAccountIssuer(path), { dropped: false, indexes: [] });
  const db = new Database(path);
  await (await getMigrations({ ...auth.options, database: db })).runMigrations();
  db.close();
  const state = accountState(path);
  assert.equal(state.users, 3);
  assert.deepEqual(state.rows, SEEDED_ROWS);
});

test("a database with no account table yet is left for the migration", () => {
  const path = join(mkdtempSync(join(tmpdir(), "markie-upgrade-empty-")), "t.db");
  new Database(path).close();
  assert.deepEqual(relaxAccountIssuer(path), { dropped: false, indexes: [] });
});

test("booting again changes nothing", async () => {
  assert.deepEqual(relaxAccountIssuer(process.env.DB_PATH!), { dropped: false, indexes: [] });
  const m = await getMigrations(auth.options);
  assert.equal(m.toBeCreated.length, 0);
  assert.equal(m.toBeAdded.length, 0, "a repeat boot must have nothing left to migrate");
});
