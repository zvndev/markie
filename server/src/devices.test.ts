// Push notifications end to end on the server: a phone registers, somebody
// comments, and the fake Apple and Google (push-fakes.ts) are sent a
// notification for the right people and no one else. The rules are the
// email's: the owner and the thread's participants who can still read the
// document, never the author. On top of those, a phone only counts while the
// session that registered it is alive.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";
import { acceptSender, signUpVerified, type TestUser } from "./test-users.ts";
import { startPushFakes } from "./push-fakes.ts";
import { pushSettings } from "./runtime-config.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-devices-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-devices-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";
for (const name of ["APNS_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID", "APNS_ENV", "FCM_SERVICE_ACCOUNT"]) delete process.env[name];

// Comment mail goes to Resend through fetch (email.ts). Capture it, and let
// every other request (the fake Google) through untouched.
type Mail = { to: string[]; subject: string; text: string };
const mail: Mail[] = [];
process.env.RESEND_API_KEY = "test-key";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(input).startsWith("https://api.resend.com/")) {
    mail.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { comments } = await import("./comments.ts");
const { devices, resetDeviceLimitsForTests, DEVICE_LIMITS } = await import("./devices.ts");
const { createPushSender, setPushSenderForTests } = await import("./push.ts");

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api/docs", comments);
app.route("/api/me/devices", devices);

const fakes = await startPushFakes();
const warnings: string[] = [];
const live = () => createPushSender(fakes.settings, fakes.endpoints, { warn: (line) => warnings.push(line) });
setPushSenderForTests(live());
const db = new Database(process.env.DB_PATH);
after(async () => {
  setPushSenderForTests(null);
  db.close();
  await fakes.close();
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  fakes.reset();
  resetDeviceLimitsForTests();
  db.prepare("DELETE FROM device_tokens").run();
});

async function call<T>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Origin: "http://localhost:3000",
      "x-forwarded-for": "127.0.0.1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, data: (await res.json().catch(() => null)) as T | null };
}

const stamp = Date.now();
const owner = await signUpVerified(app, { name: "Olive Owner", email: `owner-${stamp}@markie.test` });
const editor = await signUpVerified(app, { name: "Eddie Editor", email: `editor-${stamp}@markie.test` });
const viewer = await signUpVerified(app, { name: "Vera Viewer", email: `viewer-${stamp}@markie.test` });
acceptSender(editor.id, owner.id);
acceptSender(viewer.id, owner.id);

let tokenSeq = 0;
const iosToken = () => (++tokenSeq).toString(16).padStart(64, "0");
const androidToken = () => `fcm${++tokenSeq}:${"A".repeat(120)}_-`;

async function register(user: TestUser, platform: "ios" | "android", token: string, extra: Record<string, unknown> = {}) {
  const res = await call<{ ok: boolean; delivers: boolean }>("POST", "/api/me/devices", user.token, { platform, token, ...extra });
  assert.equal(res.status, 200);
  return res.data!;
}

const rows = () =>
  db.prepare("SELECT token, user_id, platform, show_names FROM device_tokens ORDER BY rowid").all() as Array<{
    token: string;
    user_id: string;
    platform: string;
    show_names: number;
  }>;

const DOC_NAME = "Secret launch plan.md";
async function sharedDoc(): Promise<string> {
  const docId = randomUUID();
  const content = "# Private words in the document\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  assert.equal((await call("PUT", `/api/docs/${docId}`, owner.token, { name: DOC_NAME, content, hash, baseVersion: 0 })).status, 200);
  for (const [who, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
    assert.equal((await call("POST", `/api/docs/${docId}/shares`, owner.token, { email: who.email, role })).status, 200);
  }
  return docId;
}

async function openThread(docId: string, by: TestUser, body: string): Promise<string> {
  const res = await call<{ id: string }>("POST", `/api/docs/${docId}/threads`, by.token, { anchor: { from: { c: 1 }, to: { c: 3 } }, body });
  assert.equal(res.status, 200);
  return res.data!.id;
}

async function reply(docId: string, threadId: string, by: TestUser, body: string) {
  assert.equal((await call("POST", `/api/docs/${docId}/threads/${threadId}/comments`, by.token, { body })).status, 200);
}

// Pushes are fire-and-forget. Wait until this many arrived, then a little
// longer so one too many would be seen too.
async function pushed(expected: number): Promise<string[]> {
  const count = () => fakes.apns.length + fakes.fcm.length;
  for (let i = 0; i < 100 && count() < expected; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 60));
  return [...fakes.apns.map((r) => r.token), ...fakes.fcm.map((r) => r.token)].sort();
}

async function mailFor(body: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const found = mail.filter((m) => m.text.includes(body));
    if (found.length) {
      await new Promise((r) => setTimeout(r, 20));
      return mail.filter((m) => m.text.includes(body)).flatMap((m) => m.to).sort();
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

test("registering needs a session and a token that looks like one", async () => {
  assert.equal((await call("POST", "/api/me/devices", null, { platform: "ios", token: iosToken() })).status, 401);
  assert.equal((await call("DELETE", `/api/me/devices/${iosToken()}`, null)).status, 401);
  const bad: unknown[] = [
    {},
    { platform: "windows", token: iosToken() },
    { platform: "ios", token: "short" },
    { platform: "ios", token: "Z".repeat(64) },
    { platform: "ios", token: "a".repeat(300) },
    { platform: "android", token: "has spaces in it, which no token does........" },
    { platform: "android", token: "a".repeat(1100) },
    { platform: "ios", token: 12 },
    { platform: "ios", token: iosToken(), showNames: "yes" },
  ];
  for (const body of bad) {
    assert.equal((await call("POST", "/api/me/devices", owner.token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("POST", "/api/me/devices", owner.token, { platform: "ios", token: iosToken(), pad: "x".repeat(5000) })).status, 413);
  assert.deepEqual(rows(), []);
});

test("a phone registers once, however often it says so, and can be removed", async () => {
  const token = iosToken();
  assert.deepEqual(await register(owner, "ios", token), { ok: true, delivers: true });
  await register(owner, "ios", token, { showNames: true });
  assert.deepEqual(rows(), [{ token, user_id: owner.id, platform: "ios", show_names: 1 }]);
  const android = androidToken();
  await register(owner, "android", android);
  assert.equal(rows().length, 2);

  // Somebody else cannot remove it.
  assert.deepEqual((await call("DELETE", `/api/me/devices/${encodeURIComponent(android)}`, editor.token)).data, { ok: true, removed: false });
  assert.equal(rows().length, 2);
  assert.deepEqual((await call("DELETE", `/api/me/devices/${encodeURIComponent(android)}`, owner.token)).data, { ok: true, removed: true });
  assert.deepEqual(rows().map((r) => r.token), [token]);
});

test("an account keeps its most recent phones, and registrations are rate limited", async () => {
  const tokens: string[] = [];
  for (let i = 0; i < DEVICE_LIMITS.perUser + 2; i++) {
    tokens.push(iosToken());
    await register(owner, "ios", tokens[i]);
    // last_seen_at is a timestamp; keep the order unambiguous.
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.deepEqual(rows().map((r) => r.token), tokens.slice(2));

  resetDeviceLimitsForTests();
  for (let i = 0; i < DEVICE_LIMITS.registrations; i++) await register(editor, "ios", tokens[0]);
  const refused = await call("POST", "/api/me/devices", editor.token, { platform: "ios", token: tokens[0] });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  // One account's limit is not another's.
  await register(viewer, "ios", iosToken());
});

test("a phone that signs in as someone else belongs to them from then on", async () => {
  const docId = await sharedDoc();
  const phone = iosToken();
  await register(owner, "ios", phone);
  await register(editor, "ios", phone);
  assert.deepEqual(rows(), [{ token: phone, user_id: editor.id, platform: "ios", show_names: 0 }]);

  // A comment for the owner no longer reaches that phone.
  await openThread(docId, editor, `moved ${stamp}`);
  assert.deepEqual(await pushed(0), []);
  // And one for the editor does.
  await openThread(docId, editor, `editor starts ${stamp}`).then((threadId) => reply(docId, threadId, owner, `owner answers ${stamp}`));
  assert.deepEqual(await pushed(1), [phone]);
});

test("a new comment reaches the owner's phones, and says who and where but never what", async () => {
  const docId = await sharedDoc();
  const ios = iosToken();
  const android = androidToken();
  const named = iosToken();
  await register(owner, "ios", ios);
  await register(owner, "android", android);
  await register(owner, "ios", named, { showNames: true });
  // The author's own phone is registered too, and must stay quiet.
  const authors = iosToken();
  await register(editor, "ios", authors);

  const secret = `the comment text ${stamp}`;
  const threadId = await openThread(docId, editor, secret);
  assert.deepEqual(await pushed(3), [ios, android, named].sort());

  const link = `http://localhost:8787/d/${docId}?thread=${threadId}`;
  const plain = fakes.apns.find((r) => r.token === ios)!;
  assert.deepEqual(plain.body, {
    aps: { alert: { title: "New comment", body: "Eddie Editor commented on a document." }, sound: "default", "thread-id": docId },
    link,
  });
  const google = fakes.fcm[0];
  assert.deepEqual(google.message.notification, { title: "New comment", body: "Eddie Editor commented on a document." });
  assert.deepEqual(google.message.data, { link });
  // Only the phone that asked for document names gets one.
  assert.equal(fakes.apns.find((r) => r.token === named)!.body.aps?.alert?.body, `Eddie Editor commented on "${DOC_NAME}".`);

  // Nothing written in the comment or the document leaves the server, and the
  // name only where it was asked for.
  for (const raw of [...fakes.apns.map((r) => r.raw), ...fakes.fcm.map((r) => r.raw)]) {
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes("Private words"));
    assert.ok(!raw.includes(editor.email));
  }
  assert.ok(!plain.raw.includes("Secret launch plan"));
  assert.ok(!google.raw.includes("Secret launch plan"));
  // The email went out as before.
  assert.deepEqual(await mailFor(secret), [owner.email]);
});

test("a reply reaches the owner and the thread's other participants, not its author", async () => {
  const docId = await sharedDoc();
  const ownerPhone = iosToken();
  const editorPhone = androidToken();
  const viewerPhone = iosToken();
  await register(owner, "ios", ownerPhone);
  await register(editor, "android", editorPhone);
  await register(viewer, "ios", viewerPhone);

  const threadId = await openThread(docId, owner, `opening ${stamp}`);
  // Nobody else is in the thread yet, and the owner wrote it.
  assert.deepEqual(await pushed(0), []);

  await reply(docId, threadId, viewer, `viewer joins ${stamp}`);
  assert.deepEqual(await pushed(1), [ownerPhone]);

  fakes.reset();
  await reply(docId, threadId, editor, `editor replies ${stamp}`);
  assert.deepEqual(await pushed(2), [ownerPhone, viewerPhone].sort());
  assert.equal(fakes.apns[0].body.link, `http://localhost:8787/d/${docId}?thread=${threadId}`);

  fakes.reset();
  await reply(docId, threadId, owner, `owner replies ${stamp}`);
  assert.deepEqual(await pushed(2), [editorPhone, viewerPhone].sort());
});

test("someone removed from the document stops getting its notifications", async () => {
  const docId = await sharedDoc();
  const ownerPhone = iosToken();
  const viewerPhone = iosToken();
  await register(owner, "ios", ownerPhone);
  await register(viewer, "ios", viewerPhone);
  const threadId = await openThread(docId, owner, `opening ${stamp}`);
  await reply(docId, threadId, viewer, `viewer joins ${stamp}`);
  await pushed(1);

  fakes.reset();
  await reply(docId, threadId, editor, `before removal ${stamp}`);
  assert.deepEqual(await pushed(2), [ownerPhone, viewerPhone].sort());

  assert.equal((await call("DELETE", `/api/docs/${docId}/shares/${viewer.id}`, owner.token)).status, 200);
  fakes.reset();
  await reply(docId, threadId, editor, `after removal ${stamp}`);
  assert.deepEqual(await pushed(1), [ownerPhone]);
});

test("a token the push service calls dead is forgotten; one that only failed is kept", async () => {
  const docId = await sharedDoc();
  const goneIos = iosToken();
  const goneAndroid = androidToken();
  const flakyIos = iosToken();
  const good = iosToken();
  for (const token of [goneIos, flakyIos, good]) await register(owner, "ios", token);
  await register(owner, "android", goneAndroid);
  fakes.answerApns(goneIos, 410, "Unregistered");
  fakes.answerApns(flakyIos, 503, "ServiceUnavailable");
  fakes.answerFcm(goneAndroid, 404, "UNREGISTERED");

  await openThread(docId, editor, `cleanup ${stamp}`);
  assert.equal((await pushed(4)).length, 4);
  for (let i = 0; i < 50 && rows().length > 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(rows().map((r) => r.token).sort(), [flakyIos, good].sort());
});

test("signing out, an expired session, and a deleted account each silence the phone", async () => {
  const docId = await sharedDoc();
  // Three more people on the document, each with a phone.
  const people: Array<TestUser & { phone: string }> = [];
  for (const name of ["Sam", "Exa", "Del"]) {
    const person = await signUpVerified(app, { name, email: `${name.toLowerCase()}-${stamp}@markie.test` });
    acceptSender(person.id, owner.id);
    assert.equal((await call("POST", `/api/docs/${docId}/shares`, owner.token, { email: person.email, role: "viewer" })).status, 200);
    const phone = iosToken();
    await register(person, "ios", phone);
    people.push({ ...person, phone });
  }
  const [signsOut, expires, deleted] = people;
  const threadId = await openThread(docId, owner, `opening ${stamp}`);
  for (const person of people) await reply(docId, threadId, person, `${person.email} joins`);
  await pushed(3);
  fakes.reset();
  await reply(docId, threadId, owner, `everyone hears this ${stamp}`);
  assert.deepEqual(await pushed(3), people.map((p) => p.phone).sort());

  // Sign-out through better-auth's own route removes the row with the session.
  assert.equal((await call("POST", "/api/auth/sign-out", signsOut.token, {})).status, 200);
  assert.ok(!rows().some((r) => r.token === signsOut.phone));
  // An expired session keeps its row but gets nothing.
  db.prepare('UPDATE "session" SET expiresAt = ? WHERE userId = ?').run(new Date(Date.now() - 60_000).toISOString(), expires.id);
  // No account-deletion route exists; whatever deletes the user row takes the phone too.
  db.prepare('DELETE FROM "user" WHERE id = ?').run(deleted.id);
  assert.ok(!rows().some((r) => r.token === deleted.phone));

  fakes.reset();
  await reply(docId, threadId, owner, `nobody hears this ${stamp}`);
  assert.deepEqual(await pushed(0), []);
});

test("with no push secrets, registering still works and a comment sends mail and nothing else", async () => {
  const errors: unknown[][] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => { errors.push(args); };
  console.warn = (...args: unknown[]) => { errors.push(args); };
  // What the server builds for itself when the environment names no secrets.
  setPushSenderForTests(null);
  try {
    const docId = await sharedDoc();
    assert.deepEqual(await register(owner, "ios", iosToken()), { ok: true, delivers: false });
    assert.deepEqual(await register(owner, "android", androidToken()), { ok: true, delivers: false });
    assert.equal(rows().length, 2);
    await openThread(docId, editor, `quiet ${stamp}`);
    assert.deepEqual(await mailFor(`quiet ${stamp}`), [owner.email]);
    assert.deepEqual(await pushed(0), []);
    assert.deepEqual(errors, []);
  } finally {
    console.error = realError;
    console.warn = realWarn;
    setPushSenderForTests(live());
  }
});

test("a push service that hangs, throws or is down never fails the comment or holds up its mail", async () => {
  const docId = await sharedDoc();
  await register(owner, "ios", iosToken());
  await register(owner, "android", androidToken());
  const broken = [
    // Never answers.
    { delivers: () => true, send: () => new Promise<never>(() => {}), close() {} },
    // Throws before it even returns a promise.
    { delivers: () => true, send: () => { throw new Error("boom"); }, close() {} },
    // Refuses to say whether it is on.
    { delivers: () => { throw new Error("boom"); }, send: () => Promise.resolve("sent" as const), close() {} },
    // The real sender, pointed at nothing.
    createPushSender(pushSettings(fakes.env), { apns: "http://127.0.0.1:1", fcm: "http://127.0.0.1:1", googleToken: "http://127.0.0.1:1/token" }, { warn: () => {} }),
  ];
  const realError = console.error;
  console.error = () => {};
  try {
    for (const [i, sender] of broken.entries()) {
      setPushSenderForTests(sender);
      const started = Date.now();
      await openThread(docId, editor, `broken ${i} ${stamp}`);
      assert.ok(Date.now() - started < 2000);
      assert.deepEqual(await mailFor(`broken ${i} ${stamp}`), [owner.email]);
    }
  } finally {
    console.error = realError;
    setPushSenderForTests(live());
  }
});
