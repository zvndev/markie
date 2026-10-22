// The share-invite route sends mail to an address the caller chose, carrying
// a document name and a display name the caller chose. These pin the bounds on
// how often, and what the mail may say.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";
import { INVITE_LIMITS, createInviteLimiter, mailboxKey, plainEmailText } from "./invite-guard.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-invite-guard-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-invite-guard-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

// ── the limiter on its own, on a clock the test controls ──

test("an inviter is held to the hourly burst and then to the day", () => {
  let now = 0;
  const limiter = createInviteLimiter(() => now);
  for (let i = 0; i < INVITE_LIMITS.perInviterPerHour; i += 1) assert.equal(limiter.take("u1", `r${i}@x.test`).ok, true);
  const refused = limiter.take("u1", "one-more@x.test");
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= 3600);
  // A different inviter is unaffected.
  assert.equal(limiter.take("u2", "one-more@x.test").ok, true);
  // An hour on, the burst window has emptied, until the day runs out.
  let sent = INVITE_LIMITS.perInviterPerHour;
  while (sent < INVITE_LIMITS.perInviterPerDay) {
    now += 60 * 60 * 1000;
    for (let i = 0; i < INVITE_LIMITS.perInviterPerHour && sent < INVITE_LIMITS.perInviterPerDay; i += 1, sent += 1) {
      assert.equal(limiter.take("u1", `d${sent}@x.test`).ok, true);
    }
  }
  now += 60 * 60 * 1000;
  assert.equal(limiter.take("u1", "late@x.test").ok, false);
  now += 24 * 60 * 60 * 1000;
  assert.equal(limiter.take("u1", "tomorrow@x.test").ok, true);
});

test("one mailbox is protected across inviters and across spellings of its address", () => {
  const limiter = createInviteLimiter(() => 0);
  for (let i = 0; i < INVITE_LIMITS.perRecipientPerDay; i += 1) {
    assert.equal(limiter.take(`spammer-${i}`, i % 2 ? "Victim.Person+x@gmail.com" : "victimperson@googlemail.com").ok, true);
  }
  assert.equal(limiter.take("fresh-account", "v.i.c.t.i.m.p.e.r.s.o.n@gmail.com").ok, false);
  assert.equal(limiter.take("fresh-account", "someone-else@gmail.com").ok, true);
  assert.equal(mailboxKey(" A.B+tag@GMAIL.com "), "ab@gmail.com");
  // Dots matter at other providers.
  assert.equal(mailboxKey("a.b@corp.test"), "a.b@corp.test");
});

// ── the text that goes into the mail ──

test("links and markup are stripped from caller-chosen email text", () => {
  const cases: Array<[string, string]> = [
    ["Quarterly plan.md", "Quarterly plan.md"],
    ["notes.md", "notes.md"],
    ["README.v2.md", "README.v2.md"],
    ["Claim your prize at https://evil.test/win now", "Claim your prize at now"],
    ["visit evil.com today", "visit today"],
    ["visit evil.com/claim?x=1 today", "visit today"],
    ["see www.evil.test", "see"],
    ["evil.com.md", ""],
    ["mail support@evil.test", "mail"],
    ["javascript:alert(1)", ""],
    ["[click here](https://evil.test)", "click here"],
    ["<a href='https://evil.test'>Free</a> money", "Free money"],
    ["<b>bold</b> <img src=x onerror=alert(1)>", "bold"],
    ["fullwidth evil．com and ideographic evil。com", "fullwidth and ideographic"],
    ["hidden​zero‮width", "hidden zero width"],
    ["line\nbreak\r\nhere", "line break here"],
    ["e.g. U.S. 3.14", "e.g. U.S. 3.14"],
  ];
  for (const [input, expected] of cases) assert.equal(plainEmailText(input, 200), expected, input);
  assert.equal(plainEmailText("x".repeat(500), 20).length, 20);
  assert.ok(plainEmailText("x".repeat(500), 20).endsWith("…"));
});

// ── the route ──

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares, resetInviteLimitsForTests } = await import("./shares.ts");
const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
const db = new Database(process.env.DB_PATH);

// Mail goes to Resend through fetch; capture what would have been sent.
const sent: Array<{ to: string[]; subject: string; text: string; html?: string }> = [];
const realFetch = globalThis.fetch;
before(() => {
  process.env.RESEND_API_KEY = "test-key";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  db.close();
});
beforeEach(() => resetInviteLimitsForTests());

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function makeDoc(token: string, name = "plan.md") {
  const id = crypto.randomUUID();
  const r = await call("PUT", `/api/docs/${id}`, token, { name, content: "# x\n", hash: sha("# x\n"), baseVersion: 0 });
  assert.equal(r.status, 200);
  return id;
}
const pendingFor = (docId: string, email: string) =>
  db.prepare("SELECT 1 FROM pending_shares WHERE doc_id = ? AND email = ?").get(docId, email);

let n = 0;
const fresh = (label: string) => signUpVerified(app, { name: label, email: `${label}.${Date.now()}.${(n += 1)}@guard.test` });

test("an inviter over the hourly limit is refused with 429, and nothing is stored or sent", async () => {
  const owner = await fresh("burst");
  const doc = await makeDoc(owner.token);
  for (let i = 0; i < INVITE_LIMITS.perInviterPerHour; i += 1) {
    assert.equal((await call("POST", `/api/docs/${doc}/shares`, owner.token, { email: `p${i}@far.test`, role: "viewer" })).status, 200);
  }
  const before = sent.length;
  const refused = await call("POST", `/api/docs/${doc}/shares`, owner.token, { email: "over@far.test", role: "viewer" });
  assert.equal(refused.status, 429);
  assert.match(String(refused.data?.error), /Too many invitations/);
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  assert.equal(sent.length, before, "a refused invite sends no mail");
  assert.equal(pendingFor(doc, "over@far.test"), undefined, "a refused invite leaves no pending row");
});

test("one address stops receiving invites for the day, whoever sends them", async () => {
  const first = await fresh("first");
  const second = await fresh("second");
  const doc = await makeDoc(first.token);
  for (let i = 0; i < INVITE_LIMITS.perRecipientPerDay; i += 1) {
    const r = await call("POST", `/api/docs/${doc}/shares`, first.token, { email: "target@gmail.com", role: i % 2 ? "editor" : "viewer" });
    assert.equal(r.status, 200);
  }
  const theirs = await makeDoc(second.token);
  const refused = await call("POST", `/api/docs/${theirs}/shares`, second.token, { email: "tar.get+again@gmail.com", role: "viewer" });
  assert.equal(refused.status, 429);
  assert.equal(pendingFor(theirs, "tar.get+again@gmail.com"), undefined);
  // The first inviter is still well under their own limit for other people.
  assert.equal((await call("POST", `/api/docs/${doc}/shares`, first.token, { email: "colleague@corp.test", role: "viewer" })).status, 200);
});

test("the invite email carries no link or markup from the document name or the inviter's name", async () => {
  const owner = await signUpVerified(app, { name: "Prize desk <b>visit</b> evil.test/claim", email: `namer.${Date.now()}@guard.test` });
  const doc = await makeDoc(owner.token, "Claim at https://evil.test/win [here](https://evil.test) notes.md");
  const member = await fresh("member"); // before the capture: signing up mails a code
  sent.length = 0;
  // An address with no account (the invite template)...
  assert.equal((await call("POST", `/api/docs/${doc}/shares`, owner.token, { email: `stranger.${Date.now()}@far.test`, role: "viewer" })).status, 200);
  // ...and an existing account, which takes the other template.
  assert.equal((await call("POST", `/api/docs/${doc}/shares`, owner.token, { email: member.email, role: "editor" })).status, 200);
  assert.equal(sent.length, 2);
  for (const mail of sent) {
    for (const part of [mail.subject, mail.text, mail.html ?? ""]) {
      assert.ok(!part.includes("evil.test"), `no attacker host in: ${part.slice(0, 120)}`);
      assert.ok(!part.includes("<b>visit"), "no caller markup");
    }
    assert.match(mail.subject, /Prize desk visit/);
    assert.match(mail.text, /Claim at here notes\.md/);
    // Markie's own links are still there.
    assert.match(mail.text, /https:\/\/markie\.test\/d\//);
  }
});

test("an inviter whose name is nothing but a link is named by their verified address", async () => {
  const email = `linkname.${Date.now()}@guard.test`;
  const owner = await signUpVerified(app, { name: "https://evil.test", email });
  const doc = await makeDoc(owner.token, "https://evil.test");
  sent.length = 0;
  assert.equal((await call("POST", `/api/docs/${doc}/shares`, owner.token, { email: `x.${Date.now()}@far.test`, role: "viewer" })).status, 200);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].subject.includes(email));
  assert.ok(sent[0].text.includes('"a document"'));
  assert.ok(!JSON.stringify(sent[0]).includes("evil.test"));
});
