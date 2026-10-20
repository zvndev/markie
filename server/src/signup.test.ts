// MARKIE_SIGNUP's decisions, against a bare database, and the entrypoint's
// `signup` helper against a real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { adminUserId, allowEmail, signupMode, signupRefusal, adminEmail } from "./signup.ts";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE "user"(id TEXT PRIMARY KEY, email TEXT, emailVerified INTEGER, createdAt TEXT);
    CREATE TABLE pending_shares(doc_id TEXT, email TEXT);`);
  return db;
}
const addUser = (db: Database.Database, id: string, email: string, createdAt: string, verified = 1) =>
  db.prepare('INSERT INTO "user" VALUES (?, ?, ?, ?)').run(id, email, verified, createdAt);

test("Markie Cloud is open by default and a self-hosted server is invite-only", () => {
  assert.equal(signupMode({}), "open");
  assert.equal(signupMode({ MARKIE_OFFICIAL: "1" }), "open");
  assert.equal(signupMode({ MARKIE_OFFICIAL: "0" }), "invite");
  assert.equal(signupMode({ MARKIE_OFFICIAL: "0", MARKIE_SIGNUP: "open" }), "open");
  assert.equal(signupMode({ MARKIE_SIGNUP: "closed" }), "closed");
  assert.throws(() => signupMode({ MARKIE_SIGNUP: "invite-only" }), /open, invite or closed/);
});

test("open lets anyone in; closed lets nobody in, not even the first account", () => {
  const db = freshDb();
  assert.equal(signupRefusal(db, "anyone@example.org", { MARKIE_OFFICIAL: "1" }), null);
  assert.equal(signupRefusal(db, "first@example.org", { MARKIE_SIGNUP: "closed" }), "signup_closed");
});

test("invite: the first account, then only invited or allowed addresses", () => {
  const db = freshDb();
  const env = { MARKIE_OFFICIAL: "0" };
  assert.equal(signupRefusal(db, "first@example.org", env), null);
  addUser(db, "u1", "first@example.org", "2026-10-20T10:00:00.000Z");
  assert.equal(signupRefusal(db, "stranger@example.org", env), "signup_invite_required");
  db.prepare("INSERT INTO pending_shares VALUES ('d1', 'guest@example.org')").run();
  assert.equal(signupRefusal(db, " Guest@Example.org ", env), null);
  allowEmail(db, "Friend@Example.org", "u1");
  assert.equal(signupRefusal(db, "friend@example.org", env), null);
  assert.equal(adminUserId(db, env), "u1");
});

test("a pinned MARKIE_ADMIN_EMAIL is the only first account and is always the admin", () => {
  const db = freshDb();
  const env = { MARKIE_OFFICIAL: "0", MARKIE_ADMIN_EMAIL: "Owner@Example.org" };
  assert.equal(signupRefusal(db, "squatter@example.org", env), "signup_invite_required");
  assert.equal(signupRefusal(db, "owner@example.org", env), null);
  addUser(db, "early", "early@example.org", "2026-10-20T09:00:00.000Z");
  addUser(db, "owner", "owner@example.org", "2026-10-20T10:00:00.000Z");
  assert.equal(adminUserId(db, env), "owner");
  assert.throws(() => adminEmail({ MARKIE_ADMIN_EMAIL: "not-an-address" }), /must be an email address/);
});

test("an admin who has not proven their address is no admin yet", () => {
  const db = freshDb();
  addUser(db, "u1", "first@example.org", "2026-10-20T10:00:00.000Z", 0);
  assert.equal(adminUserId(db, { MARKIE_OFFICIAL: "0" }), null);
});

test("./docker-entrypoint.sh signup manages the allowlist on the live database", () => {
  const server = fileURLToPath(new URL("..", import.meta.url));
  const dbPath = join(mkdtempSync(join(tmpdir(), "markie-signup-cli-")), "t.db");
  const run = (...args: string[]) => spawnSync("sh", ["docker-entrypoint.sh", "signup", ...args], {
    cwd: server, encoding: "utf8", env: { PATH: process.env.PATH, DB_PATH: dbPath, MARKIE_OFFICIAL: "0" },
  });
  assert.match(run("allow", "Guest@Example.org").stdout, /allowed guest@example.org/);
  const list = run("list");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /sign-up mode: invite/);
  assert.match(list.stdout, /admin: none yet/);
  assert.match(list.stdout, /guest@example.org/);
  assert.match(run("remove", "guest@example.org").stdout, /removed guest@example.org/);
  assert.match(run("list").stdout, /allowed: none/);
  assert.equal(run("allow", "nope").status, 1);
  assert.equal(run("bogus").status, 2);
});
