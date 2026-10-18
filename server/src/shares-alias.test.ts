import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-share-alias-routes-")), "test.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "synthetic-alias-sharing-test-secret-more-than-32-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";
const { auth } = await import("./auth.ts");
const migration = await getMigrations(auth.options); await migration.runMigrations();
const { docs } = await import("./docs.ts");
const { shares, configureShareIdentities, memberForToken } = await import("./shares.ts");
const { addPending, claimPendingInvitesForUser } = await import("./pending.ts");
const app = new Hono(); app.on(["GET", "POST"], "/api/auth/*", context => auth.handler(context.req.raw)); app.route("/api/docs", docs); app.route("/api/docs", shares);
const owner = await signUpVerified(app, { name: "Owner", email: "owner@alias-routes.test" });
const member = await signUpVerified(app, { name: "Member", email: "member@alias-routes.test" });
const active = new Map<string, string>();
configureShareIdentities({
  verifiedUserForEmail(email, db) { return active.get(email) ?? (db.prepare('SELECT id FROM "user" WHERE lower(email)=? AND emailVerified=1').get(email) as { id: string } | undefined)?.id ?? null; },
  activeEmailsForUser(id, db) { return [...active].filter(([, user]) => user === id).map(([email]) => email).concat((db.prepare('SELECT email FROM "user" WHERE id=? AND emailVerified=1').all(id) as { email: string }[]).map(row => row.email)); },
});
const call = async (method: string, url: string, token: string, body?: unknown) => app.request(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://localhost:3000" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function document() {
  const id = randomUUID(), content = "# Alias route fixture\n";
  assert.equal((await call("PUT", `/api/docs/${id}`, owner.token, { name: "alias.md", content, hash: createHash("sha256").update(content).digest("hex"), baseVersion: 0 })).status, 200); return id;
}

test("real share routes resolve an active alias, revoke the canonical user, and allow a fresh explicit regrant", async () => {
  const id = await document(), alias = "work@alias-routes.test"; active.set(alias, member.id);
  const grant = await call("POST", `/api/docs/${id}/shares`, owner.token, { email: alias.toUpperCase(), role: "editor" }); assert.equal(grant.status, 200);
  assert.equal((await grant.json()).userId, member.id); assert.equal((await call("GET", `/api/docs/${id}`, member.token)).status, 200);
  assert.equal((await call("DELETE", `/api/docs/${id}/shares/${encodeURIComponent(alias)}`, owner.token)).status, 200);
  assert.equal((await call("GET", `/api/docs/${id}`, member.token)).status, 404);
  assert.equal((await call("POST", `/api/docs/${id}/shares`, owner.token, { email: alias, role: "viewer" })).status, 200);
  assert.equal((await call("GET", `/api/docs/${id}`, member.token)).status, 200);
  assert.equal((await call("PUT", `/api/docs/${id}`, member.token, { content: "no", hash: "no", baseVersion: 1, name: "alias.md" })).status, 403);
  active.delete(alias);
  const pending = await call("POST", `/api/docs/${id}/shares`, owner.token, { email: alias, role: "editor" }); assert.equal((await pending.json()).status, "invited");
  claimPendingInvitesForUser(member.id);
  const access = await call("GET", `/api/docs/${id}/access`, member.token); assert.equal((await access.json()).access.role, "viewer");
});

test("late alias proof retains current access and every valid pending URL, with canonical revocation ending all of them", async () => {
  const id = await document(), one = "one@alias-routes.test", two = "two@alias-routes.test";
  assert.equal((await call("POST", `/api/docs/${id}/shares`, owner.token, { email: member.email, role: "viewer" })).status, 200);
  const first = addPending(id, one, "editor", owner.id), second = addPending(id, two, "editor", owner.id);
  active.set(one, member.id); active.set(two, member.id); claimPendingInvitesForUser(member.id);
  assert.equal((await (await call("GET", `/api/docs/${id}/access`, member.token)).json()).access.role, "viewer");
  for (const token of [first, second]) assert.deepEqual(memberForToken(token), { docId: id, userId: member.id });
  const listed = await (await call("GET", `/api/docs/${id}/shares`, owner.token)).json(); assert.equal(listed.shares.filter((row: { user_id: string }) => row.user_id === member.id).length, 1);
  assert.equal((await call("DELETE", `/api/docs/${id}/shares/${member.id}`, owner.token)).status, 200);
  for (const token of [first, second]) assert.equal(memberForToken(token), null);
  assert.equal((await call("GET", `/api/docs/${id}`, member.token)).status, 404);
});
