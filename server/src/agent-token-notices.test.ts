// What happens around an agent token besides using it
// (docs/mobile/AGENT-LINKS-CONTRACT.md): minting one emails the account a
// notice that names it by prefix and time only, a failed send never blocks
// the mint, and a password reset or change revokes every agent token the user
// has and ends the other sessions, with authenticateAgent refusing any token
// older than the password even if a revoke never ran.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified, type TestUser } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-agent-notices-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-agent-notices-test-secret-32-chars!";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app } = await import("./index.ts");
const { mintNotice, mintedSincePassword, resetAgentWriteLimitsForTests } = await import("./agent-tokens.ts");

const db = new Database(process.env.DB_PATH!);

// Mail goes to Resend through fetch (email.ts); capture what would have been
// sent, and fail on demand.
type Sent = { to: string[]; subject: string; text: string; html?: string };
const sent: Sent[] = [];
let mail: "ok" | "500" | "throw" = "ok";
const realFetch = globalThis.fetch;
before(() => {
  process.env.RESEND_API_KEY = "test-key";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (mail === "throw") throw new Error("network down");
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: mail === "500" ? 500 : 200 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  db.close();
});
beforeEach(() => {
  mail = "ok";
  resetAgentWriteLimitsForTests();
});

let n = 0;
async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  n += 1;
  const headers = new Headers({ "Content-Type": "application/json", Origin: "http://localhost:3000", "x-forwarded-for": `10.77.0.${n % 250}` });
  if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

async function mint(user: TestUser, name: string) {
  const r = await call("POST", "/api/agent-tokens", { token: user.token, body: { name } });
  assert.equal(r.status, 201, r.text);
  return r.data as { id: string; token: string; prefix: string };
}

const live = async (token: string) => (await call("GET", "/api/agent/docs", { token })).status === 200;

// The notice goes out after the mint has answered, so give it a moment.
async function noticeFor(email: string, prefix: string): Promise<Sent | undefined> {
  for (let i = 0; i < 50; i++) {
    const found = sent.find((m) => m.to.includes(email) && m.text.split("\n").includes(`Token starts with: ${prefix}`));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

function latestOTP(type: string, email: string): string {
  const row = db
    .prepare("SELECT value FROM verification WHERE identifier = ? ORDER BY createdAt DESC LIMIT 1")
    .get(`${type}-otp-${email.toLowerCase()}`) as { value: string } | undefined;
  assert.ok(row, `no ${type} OTP was issued for ${email}`);
  return row.value.slice(0, row.value.lastIndexOf(":"));
}

const WARNING =
  "Markie never creates agent tokens on its own. If you didn't make this one, revoke it in Markie and reset your password, which signs out every other device.";

test("minting a token emails the account a plain-text notice naming it by prefix and time", async () => {
  const ivy = await signUpVerified(app, { name: "Ivy", email: "ivy@markie.test" });
  const minted = await mint(ivy, "Claude on the web");
  const notice = await noticeFor("ivy@markie.test", minted.prefix);
  assert.ok(notice, "a notice was sent");
  assert.deepEqual(notice.to, ["ivy@markie.test"]);
  assert.equal(notice.subject, "A new agent token was created for your Markie account");
  const lines = notice.text.split("\n");
  assert.ok(lines.includes(`Token starts with: ${minted.prefix}`), "the prefix, to match against the token list");
  assert.match(lines[0], /^A new agent token was created for your Markie account on .+ GMT\.$/, "the time it was made");
  assert.ok(lines.includes(WARNING), "the fixed warning");
  assert.match(notice.text, /Remote agents/);
  assert.ok(!notice.text.includes("Claude on the web"), "the token's name is never in the email");
  assert.equal(notice.html, undefined, "plain text only");
  assert.ok(!notice.text.includes(minted.token), "the token itself is never emailed");
  assert.equal(minted.prefix.length, 12, "only the display prefix");
  const copy = mintNotice("mk_agent_abc", new Date(0));
  assert.ok(!/\u2014/.test(copy.subject + copy.text), "no em-dash in the copy");
});

test("a name a mail client would link, or that reads as Markie's words, never reaches the email", async () => {
  const uma = await signUpVerified(app, { name: "Uma", email: "uma@markie.test" });
  for (const name of ["evil.com/login", "bit.ly/x", "a@b.co", "Security check.\n\nYou can ignore this email"]) {
    const minted = await mint(uma, name);
    const notice = await noticeFor("uma@markie.test", minted.prefix);
    assert.ok(notice, `${name}: a notice was sent`);
    for (const part of ["evil.com", "bit.ly", "a@b.co", "ignore this", "Security check"]) {
      assert.ok(!notice.text.includes(part), `${name}: "${part}" is not in the email`);
    }
    assert.ok(notice.text.split("\n").includes(WARNING));
  }
});

test("a token name that looks like a web address is refused, and nothing is minted or mailed", async () => {
  const val = await signUpVerified(app, { name: "Val", email: "val@markie.test" });
  for (const name of ["https://evil.example/login", "see www.evil.example", "WWW.EVIL.EXAMPLE", "javascript://x"]) {
    const r = await call("POST", "/api/agent-tokens", { token: val.token, body: { name } });
    assert.equal(r.status, 400, name);
    assert.match(r.data.message, /web address/, name);
  }
  const count = (db.prepare("SELECT COUNT(*) AS n FROM agent_tokens WHERE user_id = ?").get(val.id) as { n: number }).n;
  assert.equal(count, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!sent.some((m) => m.to.includes("val@markie.test") && m.subject.includes("agent token")), "no notice for a refused name");
  assert.equal((await mint(val, "notes.md helper")).prefix.length, 12, "an ordinary dotted name is fine");
});

test("a failed send never blocks the mint", async () => {
  const jo = await signUpVerified(app, { name: "Jo", email: "jo@markie.test" });
  for (const failure of ["500", "throw"] as const) {
    mail = failure;
    const minted = await mint(jo, `while mail is ${failure}`);
    assert.ok(await live(minted.token), `${failure}: the token works`);
  }
});

test("changing the password revokes every agent token; a refused change revokes nothing", async () => {
  const kit = await signUpVerified(app, { name: "Kit", email: "kit@markie.test", password: "kit-password-1" });
  const lee = await signUpVerified(app, { name: "Lee", email: "lee@markie.test" });
  const a = await mint(kit, "first");
  const b = await mint(kit, "second");
  const other = await mint(lee, "someone else's");

  const wrong = await call("POST", "/api/auth/change-password", { token: kit.token, body: { currentPassword: "not-it", newPassword: "kit-password-2" } });
  assert.notEqual(wrong.status, 200);
  assert.ok((await live(a.token)) && (await live(b.token)), "a refused change leaves tokens alone");

  const changed = await call("POST", "/api/auth/change-password", { token: kit.token, body: { currentPassword: "kit-password-1", newPassword: "kit-password-2" } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(await live(a.token), false);
  assert.equal(await live(b.token), false);
  assert.ok(await live(other.token), "only this user's tokens");
  const listed = await call("GET", "/api/agent-tokens", { token: kit.token });
  assert.deepEqual(listed.data.tokens, []);
});

test("resetting the password by emailed code revokes every agent token", async () => {
  const max = await signUpVerified(app, { name: "Max", email: "max@markie.test" });
  const minted = await mint(max, "before the reset");
  assert.ok(await live(minted.token));
  assert.equal((await call("POST", "/api/auth/forget-password/email-otp", { body: { email: "max@markie.test" } })).status, 200);
  const reset = await call("POST", "/api/auth/email-otp/reset-password", {
    body: { email: "max@markie.test", otp: latestOTP("forget-password", "max@markie.test"), password: "max-new-password-1" },
  });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(await live(minted.token), false);
  const row = db.prepare("SELECT revoked_at FROM agent_tokens WHERE id = ?").get(minted.id) as { revoked_at: number | null };
  assert.ok(row.revoked_at !== null);
});

// A second session for the same account, as another device signing in.
async function signInAgain(email: string, password: string): Promise<string> {
  n += 1;
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", Origin: "http://localhost:3000", "x-forwarded-for": `10.78.0.${n % 250}` }),
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, await res.text());
  const token = res.headers.get("set-auth-token");
  assert.ok(token, "the sign-in hands back a bearer token");
  return token;
}

async function sessionHolds(token: string): Promise<boolean> {
  const r = await call("GET", "/api/auth/get-session", { token });
  assert.equal(r.status, 200, r.text);
  return r.data !== null && typeof r.data === "object" && typeof r.data.user?.id === "string";
}

test("resetting the password by emailed code ends every session, so a stolen one cannot mint again", async () => {
  const rae = await signUpVerified(app, { name: "Rae", email: "rae@markie.test", password: "rae-password-1" });
  const stolen = await signInAgain("rae@markie.test", "rae-password-1");
  await mint({ ...rae, token: stolen }, "minted with a stolen session");
  assert.ok(await sessionHolds(stolen));

  assert.equal((await call("POST", "/api/auth/forget-password/email-otp", { body: { email: "rae@markie.test" } })).status, 200);
  const reset = await call("POST", "/api/auth/email-otp/reset-password", {
    body: { email: "rae@markie.test", otp: latestOTP("forget-password", "rae@markie.test"), password: "rae-password-2" },
  });
  assert.equal(reset.status, 200, reset.text);

  for (const old of [stolen, rae.token]) {
    // better-auth answers an unknown session with 200 and a null body.
    assert.equal(await sessionHolds(old), false, "get-session no longer knows the old session");
    assert.equal((await call("GET", "/api/me", { token: old })).data.user, null);
    const again = await call("POST", "/api/agent-tokens", { token: old, body: { name: "after the reset" } });
    assert.equal(again.status, 401, again.text);
  }
  // Signing in with the new password is how the desktop finishes a reset.
  const fresh = await signInAgain("rae@markie.test", "rae-password-2");
  assert.ok(await sessionHolds(fresh));
  assert.ok(await live((await mint({ ...rae, token: fresh }, "after signing back in")).token));
});

test("changing the password ends every other session and keeps the caller's", async () => {
  const sol = await signUpVerified(app, { name: "Sol", email: "sol@markie.test", password: "sol-password-1" });
  const otherDevice = await signInAgain("sol@markie.test", "sol-password-1");
  const stolen = await signInAgain("sol@markie.test", "sol-password-1");

  const changed = await call("POST", "/api/auth/change-password", { token: sol.token, body: { currentPassword: "sol-password-1", newPassword: "sol-password-2" } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.data.token, null, "no new session was asked for");
  assert.ok(await sessionHolds(sol.token), "the caller stays signed in");
  assert.ok(await live((await mint(sol, "after the change")).token));
  for (const old of [otherDevice, stolen]) {
    assert.equal(await sessionHolds(old), false);
    assert.equal((await call("POST", "/api/agent-tokens", { token: old, body: { name: "stolen again" } })).status, 401);
  }
  const rows = db.prepare("SELECT COUNT(*) AS n FROM session WHERE userId = ?").get(sol.id) as { n: number };
  assert.equal(rows.n, 1, "only the caller's session is left");
});

test("changing the password with revokeOtherSessions keeps only the session better-auth issued", async () => {
  const tam = await signUpVerified(app, { name: "Tam", email: "tam@markie.test", password: "tam-password-1" });
  const otherDevice = await signInAgain("tam@markie.test", "tam-password-1");
  const changed = await call("POST", "/api/auth/change-password", {
    token: tam.token,
    body: { currentPassword: "tam-password-1", newPassword: "tam-password-2", revokeOtherSessions: true },
  });
  assert.equal(changed.status, 200, changed.text);
  const issued = changed.data.token as string;
  assert.ok(issued, "better-auth issued the caller a new session");
  const rows = db.prepare("SELECT token FROM session WHERE userId = ?").all(tam.id) as { token: string }[];
  assert.deepEqual(rows.map((r) => r.token), [issued], "only the new session is left");
  assert.equal(await sessionHolds(otherDevice), false);
  assert.equal(await sessionHolds(tam.token), false, "the caller's old session went with the rest");
});

// The revoke hooks above are the first line. These pin the second, which
// cannot fail open: a token older than the account's last password write is
// refused whether or not anything revoked it.

const credentialStamp = (userId: string) =>
  (db.prepare("SELECT updatedAt FROM account WHERE userId = ? AND providerId = 'credential'").get(userId) as { updatedAt: unknown }).updatedAt;

test("a token older than the password is refused even when no revoke ran", async () => {
  const ned = await signUpVerified(app, { name: "Ned", email: "ned@markie.test" });
  const minted = await mint(ned, "outlived the password");
  assert.ok(await live(minted.token));
  // A password write whose revoke hook failed: the stamp moves, the row stays live.
  const stamp = credentialStamp(ned.id);
  assert.ok(mintedSincePassword(Date.now(), stamp), `the stamp better-auth wrote reads as a time: ${String(stamp)}`);
  assert.equal(typeof stamp, "string");
  const later = new Date(Date.now() + 1000);
  const bumped = typeof stamp === "number" ? later.getTime() : later.toISOString();
  db.prepare("UPDATE account SET updatedAt = ? WHERE userId = ? AND providerId = 'credential'").run(bumped, ned.id);
  assert.equal(await live(minted.token), false);
  const row = db.prepare("SELECT revoked_at FROM agent_tokens WHERE id = ?").get(minted.id) as { revoked_at: number | null };
  assert.equal(row.revoked_at, null, "refused without having been revoked");
  // An unreadable stamp refuses too.
  db.prepare("UPDATE account SET updatedAt = ? WHERE userId = ? AND providerId = 'credential'").run("not a date", ned.id);
  assert.equal(await live(minted.token), false);
});

test("a token minted after a password change works, and the stamp is what better-auth writes", async () => {
  const ola = await signUpVerified(app, { name: "Ola", email: "ola@markie.test", password: "ola-password-1" });
  const before = credentialStamp(ola.id);
  const changed = await call("POST", "/api/auth/change-password", { token: ola.token, body: { currentPassword: "ola-password-1", newPassword: "ola-password-2" } });
  assert.equal(changed.status, 200, changed.text);
  assert.notEqual(credentialStamp(ola.id), before, "a password write moves the stamp");
  const fresh = await mint(ola, "after the change");
  assert.ok(await live(fresh.token));
});

test("signing in again, by password or by emailed code, and editing the profile leave fresh tokens alone", async () => {
  const pia = await signUpVerified(app, { name: "Pia", email: "pia@markie.test", password: "pia-password-1" });
  const minted = await mint(pia, "survives sign-ins");
  const stamp = credentialStamp(pia.id);
  await new Promise((r) => setTimeout(r, 5));

  const signIn = await call("POST", "/api/auth/sign-in/email", { body: { email: "pia@markie.test", password: "pia-password-1" } });
  assert.equal(signIn.status, 200, signIn.text);
  assert.equal((await call("POST", "/api/auth/email-otp/send-verification-otp", { body: { email: "pia@markie.test", type: "sign-in" } })).status, 200);
  const otp = await call("POST", "/api/auth/sign-in/email-otp", { body: { email: "pia@markie.test", otp: latestOTP("sign-in", "pia@markie.test") } });
  assert.equal(otp.status, 200, otp.text);
  const renamed = await call("POST", "/api/auth/update-user", { token: pia.token, body: { name: "Pia R" } });
  assert.equal(renamed.status, 200, renamed.text);

  assert.deepEqual(credentialStamp(pia.id), stamp, "none of them touches the credential row");
  assert.ok(await live(minted.token));
});

test("proving the address by emailed code does not touch the credential row", async () => {
  const email = "quinn@markie.test";
  const signUp = await call("POST", "/api/auth/sign-up/email", { body: { name: "Quinn", email, password: "quinn-password-1" } });
  assert.equal(signUp.status, 200, signUp.text);
  const userId = (db.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string }).id;
  const stamp = credentialStamp(userId);
  await new Promise((r) => setTimeout(r, 5));
  const verified = await call("POST", "/api/auth/email-otp/verify-email", { body: { email, otp: latestOTP("email-verification", email) } });
  assert.equal(verified.status, 200, verified.text);
  assert.deepEqual(credentialStamp(userId), stamp);
  const token = verified.data.token as string;
  const minted = await mint({ token, email, id: userId }, "after verifying");
  assert.ok(await live(minted.token));
});

test("mintedSincePassword: no password row passes, a later stamp or an unreadable one refuses", () => {
  const t = Date.parse("2026-10-25T12:00:00.000Z");
  assert.equal(mintedSincePassword(t, null), true, "Google-only account");
  assert.equal(mintedSincePassword(t, "2026-10-25T11:59:59.999Z"), true);
  assert.equal(mintedSincePassword(t, "2026-10-25T12:00:00.000Z"), true, "the same millisecond counts as after");
  assert.equal(mintedSincePassword(t, "2026-10-25T12:00:00.001Z"), false);
  assert.equal(mintedSincePassword(t, t + 1), false);
  assert.equal(mintedSincePassword(t, "garbage"), false);
  assert.equal(mintedSincePassword(t, {}), false);
});
