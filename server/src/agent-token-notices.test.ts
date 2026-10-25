// What happens around an agent token besides using it
// (docs/mobile/AGENT-LINKS-CONTRACT.md): minting one emails the account a
// notice naming it, a failed send never blocks the mint, and a password reset
// or change revokes every agent token the user has.
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
const { mintNotice } = await import("./agent-tokens.ts");

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
  return r.data as { id: string; token: string };
}

const live = async (token: string) => (await call("GET", "/api/agent/docs", { token })).status === 200;

// The notice goes out after the mint has answered, so give it a moment.
async function noticeFor(email: string, name: string): Promise<Sent | undefined> {
  for (let i = 0; i < 50; i++) {
    const found = sent.find((m) => m.to.includes(email) && m.text.includes(`"${name}"`));
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

test("minting a token emails the account a notice naming it, in plain text", async () => {
  const ivy = await signUpVerified(app, { name: "Ivy", email: "ivy@markie.test" });
  await mint(ivy, "Claude on the web");
  const notice = await noticeFor("ivy@markie.test", "Claude on the web");
  assert.ok(notice, "a notice was sent");
  assert.deepEqual(notice.to, ["ivy@markie.test"]);
  assert.equal(notice.subject, "A new agent token was created for your Markie account");
  assert.match(notice.text, /named "Claude on the web"/);
  assert.match(notice.text, /revoke it in Markie under Remote agents/);
  assert.equal(notice.html, undefined, "the token's name never lands in HTML");
  assert.ok(!notice.text.includes("mk_agent_"), "the token itself is never emailed");
  const copy = mintNotice("x", new Date(0));
  assert.ok(!/\u2014/.test(copy.subject + copy.text), "no em-dash in the copy");
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
