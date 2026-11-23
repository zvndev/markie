// The push sender on its own, against a fake Apple and a fake Google
// (push-fakes.ts): what each service is sent, how its answers are read, and
// that a server with no secrets, or with broken ones, stays quietly off.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createPushSender, type PushMessage } from "./push.ts";
import { pushSettings } from "./runtime-config.ts";
import { FAKE_PUSH_IDS, startPushFakes } from "./push-fakes.ts";

const fakes = await startPushFakes();
const warnings: string[] = [];
const sender = createPushSender(fakes.settings, fakes.endpoints, { warn: (message) => warnings.push(message) });
after(async () => {
  sender.close();
  await fakes.close();
});

const IOS = "a".repeat(64);
const ANDROID = `fcm-token:${"B".repeat(140)}`;
const message: PushMessage = {
  title: "New comment",
  body: "Ada commented on a document.",
  link: "https://api.markiedocs.com/d/doc-1?thread=thread-1",
  group: "doc-1",
};

test("with no secrets both platforms are off, nothing is sent and nothing is said", async () => {
  fakes.reset();
  const said: string[] = [];
  const off = createPushSender(pushSettings({}), fakes.endpoints, { warn: (line) => said.push(line) });
  assert.equal(off.delivers("ios"), false);
  assert.equal(off.delivers("android"), false);
  assert.equal(await off.send("ios", IOS, message), "off");
  assert.equal(await off.send("android", ANDROID, message), "off");
  assert.equal(fakes.apns.length + fakes.fcm.length, 0);
  assert.deepEqual(said, []);
});

test("one platform's secrets turn on that platform only", () => {
  const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, FCM_SERVICE_ACCOUNT } = fakes.env;
  const onlyApple = createPushSender(pushSettings({ APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID }), fakes.endpoints);
  assert.deepEqual([onlyApple.delivers("ios"), onlyApple.delivers("android")], [true, false]);
  const onlyGoogle = createPushSender(pushSettings({ FCM_SERVICE_ACCOUNT }), fakes.endpoints);
  assert.deepEqual([onlyGoogle.delivers("ios"), onlyGoogle.delivers("android")], [false, true]);
});

test("a half-finished or unreadable secret leaves the platform off and names the variable, never the value", () => {
  const said: string[] = [];
  const warn = (line: string) => said.push(line);
  const half = createPushSender(pushSettings({ APNS_KEY: fakes.env.APNS_KEY, APNS_TEAM_ID: "T" }), {}, { warn });
  assert.equal(half.delivers("ios"), false);
  const badKey = createPushSender(pushSettings({ ...fakes.env, APNS_KEY: "not-a-key-SECRETVALUE" }), {}, { warn });
  assert.equal(badKey.delivers("ios"), false);
  assert.equal(badKey.delivers("android"), true);
  const badAccount = createPushSender(pushSettings({ FCM_SERVICE_ACCOUNT: '{"project_id":"SECRETVALUE"}' }), {}, { warn });
  assert.equal(badAccount.delivers("android"), false);
  assert.equal(said.length, 3);
  assert.match(said[0], /APNS_KEY_ID, APNS_BUNDLE_ID not set/);
  assert.match(said[1], /APNS_KEY is set but is not a readable private key/);
  assert.match(said[2], /FCM_SERVICE_ACCOUNT is set but is not/);
  assert.ok(!said.join("\n").includes("SECRETVALUE"));
});

test("APNs: an alert to /3/device/<token>, signed with the key, for the app's bundle", async () => {
  fakes.reset();
  assert.equal(await sender.send("ios", IOS, message), "sent");
  assert.equal(fakes.apns.length, 1);
  const got = fakes.apns[0];
  assert.equal(got.token, IOS);
  assert.equal(got.headers[":method"], "POST");
  assert.equal(got.headers["apns-topic"], FAKE_PUSH_IDS.APNS_BUNDLE_ID);
  assert.equal(got.headers["apns-push-type"], "alert");
  assert.equal(got.headers["apns-priority"], "10");
  assert.ok(Number(got.headers["apns-expiration"]) > Date.now() / 1000);
  // The fake only fills this in when the ES256 signature verifies.
  assert.equal(got.provider?.kid, FAKE_PUSH_IDS.APNS_KEY_ID);
  assert.equal(got.provider?.iss, FAKE_PUSH_IDS.APNS_TEAM_ID);
  assert.ok(Math.abs((got.provider?.iat ?? 0) - Date.now() / 1000) < 60);
  assert.deepEqual(got.body, {
    aps: { alert: { title: message.title, body: message.body }, sound: "default", "thread-id": "doc-1" },
    link: message.link,
  });
});

test("APNs: the provider token is signed once and reused, on one connection", async () => {
  fakes.reset();
  await Promise.all([sender.send("ios", IOS, message), sender.send("ios", "b".repeat(64), message), sender.send("ios", "c".repeat(64), message)]);
  assert.equal(fakes.apns.length, 3);
  assert.equal(new Set(fakes.apns.map((r) => r.headers.authorization)).size, 1);
});

test("APNs: 410 and BadDeviceToken are dead tokens; any other refusal is only a failure", async () => {
  fakes.reset();
  fakes.answerApns("d".repeat(64), 410, "Unregistered");
  fakes.answerApns("e".repeat(64), 400, "BadDeviceToken");
  fakes.answerApns("f".repeat(64), 400, "PayloadTooLarge");
  fakes.answerApns("1".repeat(64), 503, "ServiceUnavailable");
  assert.equal(await sender.send("ios", "d".repeat(64), message), "dead");
  assert.equal(await sender.send("ios", "e".repeat(64), message), "dead");
  assert.equal(await sender.send("ios", "f".repeat(64), message), "failed");
  assert.equal(await sender.send("ios", "1".repeat(64), message), "failed");
});

test("FCM: a service-account assertion buys an access token, which is reused", async () => {
  fakes.reset();
  const before = fakes.tokenExchanges();
  assert.equal(await sender.send("android", ANDROID, message), "sent");
  assert.equal(await sender.send("android", `${ANDROID}2`, message), "sent");
  // The fake hands out a token only for an RS256 assertion that verifies,
  // names the service account, and is made out to Google's own endpoint.
  assert.equal(fakes.tokenExchanges() - before, 1);
  assert.equal(fakes.fcm.length, 2);
  const got = fakes.fcm[0];
  assert.equal(got.project, FAKE_PUSH_IDS.FCM_PROJECT);
  assert.equal(got.authorization, `Bearer ${FAKE_PUSH_IDS.ACCESS_TOKEN}`);
  assert.deepEqual(got.message, {
    token: ANDROID,
    notification: { title: message.title, body: message.body },
    data: { link: message.link },
    android: { priority: "HIGH", ttl: "86400s", notification: { tag: "doc-1" } },
  });
});

test("FCM: UNREGISTERED is a dead token; a bare 404 or a 500 is only a failure", async () => {
  fakes.reset();
  fakes.answerFcm("gone-token-0123456789abcdefghijklmnopqrstuv", 404, "UNREGISTERED");
  fakes.answerFcm("wrong-project-0123456789abcdefghijklmnopqrs", 404);
  fakes.answerFcm("server-error-0123456789abcdefghijklmnopqrst", 500, "INTERNAL");
  assert.equal(await sender.send("android", "gone-token-0123456789abcdefghijklmnopqrstuv", message), "dead");
  assert.equal(await sender.send("android", "wrong-project-0123456789abcdefghijklmnopqrs", message), "failed");
  assert.equal(await sender.send("android", "server-error-0123456789abcdefghijklmnopqrst", message), "failed");
});

test("a service that cannot be reached is a failure, never a throw", async () => {
  const said: string[] = [];
  const nowhere = createPushSender(
    fakes.settings,
    { apns: "http://127.0.0.1:1", fcm: "http://127.0.0.1:1", googleToken: "http://127.0.0.1:1/token" },
    { warn: (line) => said.push(line) }
  );
  assert.equal(await nowhere.send("ios", IOS, message), "failed");
  assert.equal(await nowhere.send("android", ANDROID, message), "failed");
  // Said once per kind of trouble, not once per phone.
  assert.equal(await nowhere.send("ios", IOS, message), "failed");
  assert.equal(said.filter((line) => line.includes("Apple")).length, 1);
  nowhere.close();
});
