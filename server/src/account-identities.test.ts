import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { activeVerifiedEmails, createIdentityStore, normalizeIdentityEmail, resolveVerifiedUserForEmail, type IdentityActor, type IdentityScope } from "./account-identities.ts";
import { createAccountIdentitiesApi } from "./account-identities-api.ts";

const secret = "synthetic-test-secret-32-characters-minimum";
function setup(extra = {}) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,email TEXT NOT NULL,emailVerified INTEGER NOT NULL);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT NOT NULL,token TEXT,expiresAt TEXT DEFAULT '2099-01-01T00:00:00.000Z');
    CREATE TABLE account(id TEXT PRIMARY KEY,userId TEXT,providerId TEXT,accountId TEXT,accessToken TEXT);`);
  for (const [id, email, verified] of [["one", "primary@example.test", 1], ["two", "second@example.test", 1], ["unverified", "reserved@example.test", 0]] as const) db.prepare("INSERT INTO user VALUES(?,?,?)").run(id, email, verified);
  db.prepare("INSERT INTO session(id,userId,token) VALUES('primary-session','one','primary-token'),('different-session','one','other-token'),('two-session','two','second-token')").run();
  db.prepare("INSERT INTO account VALUES('provider-row','one','google','private-subject','private-token')").run();
  let time = 1700000000000;
  const store = createIdentityStore(db, { secret, now: () => time, ...extra });
  const actor: IdentityActor = { userId: "one", email: "primary@example.test", emailVerified: true, sessionId: "primary-session" };
  const proof = (scope: IdentityScope = "email-add", who = actor) => {
    const challenge = store.startStepUp(who, scope);
    return store.verifyStepUp(who, challenge.challengeId, challenge.code!).proofId;
  };
  const add = (email = "alias@example.test") => {
    const challenge = store.startEmail(actor, email, proof());
    return store.verifyEmail(actor, challenge.challengeId, challenge.code!);
  };
  return { db, store, actor, proof, add, advance: (ms: number) => { time += ms; } };
}
test("verified primary backfill is additive, normalized and never merges or mutates user rows", () => {
  const t = setup();
  try {
    assert.equal(t.store.listIdentities("one").length, 1);
    assert.equal(t.store.listIdentities("unverified").length, 0);
    assert.equal(t.store.verifiedUserForEmail("  PRIMARY@EXAMPLE.TEST  "), "one");
    assert.equal(t.store.verifiedUserForEmail("reserved@example.test"), null);
    assert.equal(normalizeIdentityEmail("a.b+tag@example.test"), "a.b+tag@example.test");
    const before = t.db.prepare("SELECT * FROM user ORDER BY id").all();
    const identity = t.add();
    assert.equal(identity.primary, false); assert.equal(t.store.verifiedUserForEmail(identity.email), "one");
    assert.deepEqual(activeVerifiedEmails(t.db, "one"), ["alias@example.test", "primary@example.test"]);
    assert.equal(resolveVerifiedUserForEmail(t.db, identity.email), "one");
    assert.deepEqual(t.db.prepare("SELECT * FROM user ORDER BY id").all(), before);
    assert.deepEqual(t.store.listProviders("one"), [{ id: "provider-row", providerId: "google" }]);
    createIdentityStore(t.db, { secret }); assert.equal(t.store.listIdentities("one").length, 2);
  } finally { t.db.close(); }
});
test("step-up and email OTPs are bound to canonical UID/session/scope, single use, hashed and expiring", () => {
  const t = setup();
  try {
    const challenge = t.store.startStepUp(t.actor, "email-add");
    const other = { ...t.actor, sessionId: "different-session" };
    assert.throws(() => t.store.verifyStepUp(other, challenge.challengeId, challenge.code!), /invalid-verification/);
    const result = t.store.verifyStepUp(t.actor, challenge.challengeId, challenge.code!);
    assert.throws(() => t.store.verifyStepUp(t.actor, challenge.challengeId, challenge.code!), /invalid-verification/);
    assert.throws(() => t.store.consumeStepUp(t.actor, result.proofId, "google-link"), /invalid-verification/);
    const target = t.store.startEmail(t.actor, "alias@example.test", result.proofId);
    assert.throws(() => t.store.startEmail(t.actor, "other@example.test", result.proofId), /invalid-verification/);
    assert.throws(() => t.store.verifyEmail(other, target.challengeId, target.code!), /invalid-verification/);
    assert.throws(() => t.store.verifyStepUp(t.actor, target.challengeId, target.code!), /invalid-verification/);
    t.store.verifyEmail(t.actor, target.challengeId, target.code!);
    assert.throws(() => t.store.verifyEmail(t.actor, target.challengeId, target.code!), /invalid-verification/);
    const rows = t.db.prepare("SELECT code_hash,session_hash FROM account_identity_challenges").all() as { code_hash: string; session_hash: string }[];
    assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.code_hash) && /^[a-f0-9]{64}$/.test(row.session_hash)));
    assert.ok(rows.every((row) => row.code_hash !== challenge.code && row.session_hash !== t.actor.sessionId));
    const next = t.store.startStepUp(t.actor, "google-link"); t.advance(300000);
    assert.throws(() => t.store.verifyStepUp(t.actor, next.challengeId, next.code!), /invalid-verification/);
  } finally { t.db.close(); }
});
test("wrong-code attempts persist across factory restart and resend invalidates prior challenges", () => {
  const t = setup();
  try {
    const first = t.store.startStepUp(t.actor), next = t.store.startStepUp(t.actor);
    assert.throws(() => t.store.verifyStepUp(t.actor, first.challengeId, first.code!), /invalid-verification/);
    const wrong = next.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) assert.throws(() => t.store.verifyStepUp(t.actor, next.challengeId, wrong), /invalid-verification/);
    const restarted = createIdentityStore(t.db, { secret, now: () => 1700000000001 });
    assert.throws(() => restarted.verifyStepUp(t.actor, next.challengeId, next.code!), /invalid-verification/);
    assert.equal((t.db.prepare("SELECT attempts FROM account_identity_challenges WHERE id=?").get(next.challengeId) as { attempts: number }).attempts, 3);
  } finally { t.db.close(); }
});
test("any different user's primary is reserved, including unverified and consume-time collision", () => {
  const t = setup();
  try {
    for (const email of ["second@example.test", " RESERVED@EXAMPLE.TEST "]) assert.throws(() => t.store.startEmail(t.actor, email, t.proof()), /identity-conflict/);
    const pending = t.store.startEmail(t.actor, "late@example.test", t.proof());
    t.db.prepare("INSERT INTO user VALUES('late','LATE@example.test',0)").run();
    assert.throws(() => t.store.verifyEmail(t.actor, pending.challengeId, pending.code!), /identity-conflict/);
    assert.equal(t.store.verifiedUserForEmail("late@example.test"), null);
    assert.equal(t.store.listIdentities("one").length, 1);
    assert.throws(() => t.store.verifyEmail(t.actor, pending.challengeId, pending.code!), /invalid-verification/);
  } finally { t.db.close(); }
});
test("area callback shares identity transaction; a failure rolls back identity and challenge consumption", () => {
  let broken = true;
  const t = setup({ ensureIdentityArea(_uid: string, _id: string, label: string) { if (label === "alias@example.test" && broken) throw new Error("area unavailable"); } });
  try {
    const pending = t.store.startEmail(t.actor, "alias@example.test", t.proof());
    assert.throws(() => t.store.verifyEmail(t.actor, pending.challengeId, pending.code!), /area unavailable/);
    assert.equal(t.store.verifiedUserForEmail("alias@example.test"), null);
    broken = false;
    assert.equal(t.store.verifyEmail(t.actor, pending.challengeId, pending.code!).email, "alias@example.test");
  } finally { t.db.close(); }
});
test("prepared challenges cannot exceed active identity cap when consumed", () => {
  const t = setup();
  try {
    for (let i = 0; i < 18; i++) t.db.prepare("INSERT INTO account_emails(id,user_id,email_norm,email_display,verified_at,proof_kind) VALUES(?,?,?,?,1,'email-otp')").run(`seed-${i}`, "one", `seed${i}@example.test`, `seed${i}@example.test`);
    const a = t.store.startEmail(t.actor, "cap-a@example.test", t.proof()), b = t.store.startEmail(t.actor, "cap-b@example.test", t.proof());
    t.store.verifyEmail(t.actor, a.challengeId, a.code!);
    assert.throws(() => t.store.verifyEmail(t.actor, b.challengeId, b.code!), /identity-conflict/);
    assert.equal(t.store.listIdentities("one").length, 20);
  } finally { t.db.close(); }
});
test("alias sign-in resolves canonical user only, binds flow, consumes proof, and unlink revokes factor sessions", () => {
  const t = setup();
  try {
    const identity = t.add(), flow = randomBytes(32).toString("base64url");
    const unknown = t.store.startAliasSignIn("unknown@example.test", flow);
    assert.equal(unknown.code, undefined); assert.equal(unknown.email, undefined);
    const challenge = t.store.startAliasSignIn(identity.email, flow);
    assert.throws(() => t.store.verifyAliasSignIn(challenge.challengeId, challenge.code!, randomBytes(32).toString("base64url")), /invalid-verification/);
    const factor = t.store.verifyAliasSignIn(challenge.challengeId, challenge.code!, flow);
    assert.deepEqual(factor, { userId: "one", identityId: identity.id, email: identity.email });
    assert.throws(() => t.store.verifyAliasSignIn(challenge.challengeId, challenge.code!, flow), /invalid-verification/);
    t.db.prepare("INSERT INTO session(id,userId,token) VALUES('alias-session','one','alias-token')").run();
    assert.equal(t.store.finalizeAliasSession("one", identity.id, identity.email, "alias-session"), true);
    const remove = t.proof("email-remove"); assert.deepEqual(t.store.removeIdentity(t.actor, identity.id, remove), { revokedSessionIds: ["alias-session"] });
    assert.equal(t.db.prepare("SELECT 1 FROM session WHERE id='alias-session'").get(), undefined);
    assert.ok(t.db.prepare("SELECT 1 FROM session WHERE id='primary-session'").get());
    assert.equal(t.store.verifiedUserForEmail(identity.email), null);
    assert.deepEqual(t.store.activeEmailsForUser("one"), ["primary@example.test"]);
    assert.equal(t.store.finalizeAliasSession("one", identity.id, identity.email, "primary-session"), false);
    assert.throws(() => t.store.removeIdentity(t.actor, t.store.listIdentities("one")[0].id, t.proof("email-remove")), /identity-not-removable/);
  } finally { t.db.close(); }
});
test("persistent issuance limits survive factory recreation and reset after the bounded window", () => {
  const t = setup();
  try {
    for (let i = 0; i < 5; i++) t.store.startStepUp(t.actor);
    assert.throws(() => t.store.startStepUp(t.actor), /identity-rate-limited/);
    assert.throws(() => createIdentityStore(t.db, { secret, now: () => 1700000000001 }).startStepUp(t.actor), /identity-rate-limited/);
    t.advance(60000); assert.ok(t.store.startStepUp(t.actor).challengeId);
    assert.throws(() => createIdentityStore(t.db, { secret: "weak" }), /identity-unavailable/);
  } finally { t.db.close(); }
});
test("account routes expose only metadata and code-free challenges; alias mint/unlink race never returns token", async () => {
  const t = setup(), delivered: { email: string; code: string; purpose: string }[] = [];
  let removeDuringMint: (() => void) | undefined, mintCalls = 0;
  const app = new Hono();
  app.route("/api/account", createAccountIdentitiesApi({
    store: t.store, authenticate: (request) => request.headers.get("authorization") === "Bearer synthetic" ? t.actor : null,
    sendCode: async (input) => { delivered.push(input); },
    mintSession: async (uid) => { mintCalls++; t.db.prepare("INSERT INTO session(id,userId,token) VALUES('minted',?,'new-private-token')").run(uid); removeDuringMint?.(); return { id: "minted", token: "new-private-token" }; },
  }));
  const post = (path: string, body: unknown, signed = true) => app.request(`/api/account/identities/${path}`, { method: "POST", headers: { "content-type": "application/json", ...(signed ? { authorization: "Bearer synthetic" } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("step-up/start", {} ,false)).status, 401);
    const started = await post("step-up/start", { scope: "email-add" });
    assert.equal(started.status, 200); assert.match(started.headers.get("cache-control")!, /no-store/);
    const challenge = await started.json() as { challengeId: string };
    assert.deepEqual(Object.keys(challenge).sort(), ["challengeId", "expiresInSeconds"]);
    const verified = await post("step-up/verify", { challengeId: challenge.challengeId, code: delivered.at(-1)!.code });
    const { proofId } = await verified.json() as { proofId: string };
    const emailStart = await post("email/start", { email: "api-alias@example.test", proofId });
    const emailChallenge = await emailStart.json() as { challengeId: string };
    const added = await post("email/verify", { challengeId: emailChallenge.challengeId, code: delivered.at(-1)!.code });
    assert.equal(added.status, 200); const identity = (await added.json() as { identity: { id: string } }).identity;
    const metadata = await app.request("/api/account/identities", { headers: { authorization: "Bearer synthetic" } });
    assert.equal(metadata.status, 200); assert.ok(!(await metadata.text()).includes("private-token"));
    const removeProof = t.proof("email-remove");
    const signin = await post("sign-in/start", { email: "api-alias@example.test" }, false);
    const flow = await signin.json() as { challengeId: string; flowId: string };
    removeDuringMint = () => t.store.removeIdentity(t.actor, identity.id, removeProof);
    const completed = await post("sign-in/verify", { challengeId: flow.challengeId, flowId: flow.flowId, code: delivered.at(-1)!.code }, false);
    assert.equal(mintCalls, 1);
    assert.equal(completed.status, 400); assert.ok(!(await completed.text()).includes("new-private-token"));
    assert.equal(t.db.prepare("SELECT 1 FROM session WHERE id='minted'").get(), undefined);
    const unknown = await post("sign-in/start", { email: "unknown@example.test" }, false);
    assert.equal(unknown.status, 200); assert.deepEqual(Object.keys(await unknown.json()).sort(), ["challengeId", "expiresInSeconds", "flowId"]);
  } finally { t.db.close(); }
});
test("alias API successful sign-in mints only the canonical UID and records its factor before token return", async () => {
  const t = setup(), identity = t.add(), delivered: string[] = [], minted: string[] = [];
  const app = createAccountIdentitiesApi({
    store: t.store, authenticate: () => t.actor,
    sendCode: async ({ code }) => { delivered.push(code); },
    mintSession: async (uid, factor) => {
      assert.deepEqual(factor, { identityId: identity.id, email: identity.email }); minted.push(uid);
      t.db.prepare("INSERT INTO session(id,userId,token) VALUES('real-alias-session',?,'synthetic-alias-token')").run(uid);
      return { id: "real-alias-session", token: "synthetic-alias-token" };
    },
  });
  const request = (path: string, body: unknown) => app.request(`/identities/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const start = await request("sign-in/start", { email: identity.email });
    const { challengeId, flowId } = await start.json() as { challengeId: string; flowId: string };
    const response = await request("sign-in/verify", { challengeId, flowId, code: delivered.at(-1) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { token: "synthetic-alias-token" }); assert.deepEqual(minted, ["one"]);
    assert.deepEqual(t.db.prepare("SELECT * FROM account_identity_session_factors").all(), [{ session_id: "real-alias-session", user_id: "one", identity_id: identity.id }]);
    assert.equal((await request("sign-in/verify", { challengeId, flowId, code: delivered.at(-1) })).status, 400);
    assert.deepEqual(minted, ["one"]);
  } finally { t.db.close(); }
});
test("cross-user proofs, expired proofs, competing aliases and malformed email never change ownership", () => {
  const t = setup();
  try {
    const actorTwo = { ...t.actor, userId: "two", email: "second@example.test", sessionId: "two-session" };
    const proof = t.proof();
    assert.throws(() => t.store.startEmail(actorTwo, "other@example.test", proof), /invalid-verification/);
    const a = t.store.startEmail(t.actor, "contested@example.test", proof);
    const b = t.store.startEmail(actorTwo, "contested@example.test", t.proof("email-add", actorTwo));
    assert.throws(() => t.store.verifyEmail(t.actor, a.challengeId, a.code!), /invalid-verification/);
    t.store.verifyEmail(actorTwo, b.challengeId, b.code!);
    assert.equal(t.store.verifiedUserForEmail("contested@example.test"), "two");
    const expires = t.proof("google-link"); t.advance(300000);
    assert.throws(() => t.store.consumeStepUp(t.actor, expires, "google-link"), /invalid-verification/);
    for (const email of ["a", "a@b", "a..b@example.test", "a@example.test\ncc:victim@example.test", "a@-example.test", "a@ex ample.test", "\u0000a@example.test"]) assert.equal(normalizeIdentityEmail(email), null);
    assert.equal((t.db.prepare("SELECT count(*) AS n FROM user").get() as { n: number }).n, 3);
  } finally { t.db.close(); }
});
test("route failures are sanitized, bodies bounded, and failed delivery invalidates its OTP", async () => {
  const t = setup();
  const app = createAccountIdentitiesApi({ store: t.store, authenticate: () => t.actor, sendCode: async () => { throw new Error("smtp credentials must never escape"); }, mintSession: async () => { throw new Error("not reached"); } });
  try {
    const request = (body: string) => app.request("/identities/step-up/start", { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal((await request(JSON.stringify({ scope: "google-link", userId: "two" }))).status, 400);
    assert.equal((await request("x".repeat(4097))).status, 400);
    const response = await request("{}"); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "identity-unavailable" });
    const challenge = t.db.prepare("SELECT consumed_at FROM account_identity_challenges ORDER BY rowid DESC LIMIT 1").get() as { consumed_at: number | null };
    assert.notEqual(challenge.consumed_at, null);
  } finally { t.db.close(); }
});
test("mutation revalidates session UID and expiry after a paused request body revokes authentication", async () => {
  const t = setup(); let authenticated = false;
  const app = createAccountIdentitiesApi({ store: t.store, authenticate: () => { authenticated = true; return t.actor; }, sendCode: async () => {}, mintSession: async () => ({ token: "not-used" }) });
  try {
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      assert.equal(authenticated, true);
      t.db.prepare("DELETE FROM session WHERE id='primary-session'").run();
      controller.enqueue(Buffer.from("{}")); controller.close();
    } }, { highWaterMark: 0 });
    const request = new Request("https://markie.example/identities/step-up/start", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    assert.equal((await app.request(request)).status, 401);
    assert.deepEqual(t.db.prepare("SELECT * FROM account_identity_challenges").all(), []);
    t.db.prepare("INSERT INTO session(id,userId,expiresAt) VALUES('primary-session','one','2000-01-01T00:00:00Z')").run();
    assert.throws(() => t.store.startStepUp(t.actor), /identity-authentication-required/);
    t.db.prepare("UPDATE session SET expiresAt='2099-01-01T00:00:00Z',userId='two' WHERE id='primary-session'").run();
    assert.throws(() => t.store.startStepUp(t.actor), /identity-authentication-required/);
    t.db.prepare("UPDATE session SET userId='one' WHERE id='primary-session'").run();
    const challenge = t.store.startStepUp(t.actor, "google-remove");
    t.db.prepare("DELETE FROM session WHERE id='primary-session'").run();
    assert.throws(() => t.store.verifyStepUp(t.actor, challenge.challengeId, challenge.code!), /identity-authentication-required/);
  } finally { t.db.close(); }
});
test("pure primary fallback covers new verified signups without reviving revoked identities", () => {
  const t = setup();
  try {
    const before = t.db.prepare("SELECT count(*) AS n FROM account_emails").get();
    t.db.prepare("INSERT INTO user VALUES('new','New@example.test',1)").run();
    assert.equal(resolveVerifiedUserForEmail(t.db, "new@example.test"), "new");
    assert.deepEqual(activeVerifiedEmails(t.db, "new"), ["new@example.test"]);
    assert.deepEqual(t.db.prepare("SELECT count(*) AS n FROM account_emails").get(), before);
    const flow = randomBytes(32).toString("base64url"), login = t.store.startAliasSignIn("new@example.test", flow);
    assert.equal(t.store.verifyAliasSignIn(login.challengeId, login.code!, flow).userId, "new");
    const identity = t.add(); t.store.removeIdentity(t.actor, identity.id, t.proof("email-remove"));
    assert.equal(resolveVerifiedUserForEmail(t.db, identity.email), null);
    t.db.prepare("UPDATE account_emails SET revoked_at=1 WHERE user_id='one' AND is_primary=1").run();
    assert.equal(resolveVerifiedUserForEmail(t.db, t.actor.email), null);
    createIdentityStore(t.db, { secret });
    assert.equal(resolveVerifiedUserForEmail(t.db, t.actor.email), null);
    assert.deepEqual(activeVerifiedEmails(t.db, "one"), []);
  } finally { t.db.close(); }
});
test("backfill skips verified accounts whose primary collides with another and still boots the rest", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,email TEXT NOT NULL,emailVerified INTEGER NOT NULL);
      CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT NOT NULL,token TEXT,expiresAt TEXT DEFAULT '2099-01-01T00:00:00.000Z');`);
    // Legacy rows that differ only by case or whitespace, as an older auth build could have written.
    db.prepare("INSERT INTO user VALUES('twin-a','Twin@Example.test',1),('twin-b',' twin@example.test',1),('solo','solo@example.test',1)").run();
    const areas: string[] = [];
    const store = createIdentityStore(db, { secret, ensureIdentityArea: (uid) => { areas.push(uid); } });
    assert.deepEqual(store.listIdentities("solo").map((row) => row.email), ["solo@example.test"]);
    assert.deepEqual(areas, ["solo"]);
    assert.equal((db.prepare("SELECT count(*) AS n FROM account_emails WHERE user_id LIKE 'twin-%'").get() as { n: number }).n, 0);
    assert.equal(resolveVerifiedUserForEmail(db, "twin@example.test"), null);
    assert.throws(() => store.listIdentities("twin-a"), /identity-conflict/);
    assert.deepEqual(createIdentityStore(db, { secret }).backfillVerifiedPrimaries(), { skipped: 2 });
  } finally { db.close(); }
});
test("an address no verified account owns signs in through the ordinary email-code flow, bound to its challenge", async () => {
  const t = setup(), sent: string[] = [], verified: [string, string][] = [], identityCodes: string[] = [];
  let answer: { token: string } | null = null, sendFails = false;
  const app = createAccountIdentitiesApi({
    store: t.store, authenticate: () => null,
    sendCode: async ({ code }) => { identityCodes.push(code); },
    mintSession: async () => { throw new Error("canonical mint must not run for an unclaimed address"); },
    unclaimedSignIn: {
      send: async (email) => { if (sendFails) throw new Error("mail down"); sent.push(email); },
      verify: async (email, code) => { verified.push([email, code]); return answer; },
    },
  });
  const request = (path: string, body: unknown) => app.request(`/identities/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const start = await request("sign-in/start", { email: " NewPerson@Example.test " });
    assert.equal(start.status, 200);
    const flow = await start.json() as { challengeId: string; flowId: string };
    assert.deepEqual(Object.keys(flow).sort(), ["challengeId", "expiresInSeconds", "flowId"]);
    assert.deepEqual(sent, ["newperson@example.test"]); assert.deepEqual(identityCodes, []);
    // Another flow cannot borrow the challenge, and it costs the real flow nothing.
    assert.equal((await request("sign-in/verify", { challengeId: flow.challengeId, flowId: randomBytes(32).toString("base64url"), code: "123456" })).status, 400);
    assert.deepEqual(verified, []);
    assert.equal((await request("sign-in/verify", { challengeId: flow.challengeId, flowId: flow.flowId, code: "111111" })).status, 400);
    answer = { token: "fresh-account-token" };
    const done = await request("sign-in/verify", { challengeId: flow.challengeId, flowId: flow.flowId, code: "222222" });
    assert.equal(done.status, 200); assert.deepEqual(await done.json(), { token: "fresh-account-token" });
    assert.deepEqual(verified, [["newperson@example.test", "111111"], ["newperson@example.test", "222222"]]);
    assert.equal((await request("sign-in/verify", { challengeId: flow.challengeId, flowId: flow.flowId, code: "222222" })).status, 400);
    assert.equal(verified.length, 2);
    // Three attempts per challenge, as for every other code.
    answer = null;
    const capped = await (await request("sign-in/start", { email: "capped@example.test" })).json() as { challengeId: string; flowId: string };
    for (let i = 0; i < 3; i++) await request("sign-in/verify", { challengeId: capped.challengeId, flowId: capped.flowId, code: "000000" });
    answer = { token: "too-late" };
    assert.equal((await request("sign-in/verify", { challengeId: capped.challengeId, flowId: capped.flowId, code: "000000" })).status, 400);
    assert.equal(verified.length, 5);
    // A verified account still gets the canonical identity code, never the fallback.
    await request("sign-in/start", { email: "primary@example.test" });
    assert.equal(identityCodes.length, 1); assert.equal(sent.length, 2);
    sendFails = true;
    const failed = await request("sign-in/start", { email: "down@example.test" });
    assert.equal(failed.status, 503);
  } finally { t.db.close(); }
});
