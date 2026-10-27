// Little Friend on markie-api: what leaves the process. Every route is a
// template, faults carry stacks, and nothing that names a share token, a
// document id or a session token is ever sent or logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-lf-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-lf-test-secret-32-plus-characters!";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_NO_LISTEN = "1";
delete process.env.LF_SERVER_KEY;

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

const { app } = await import("./index.ts");
const { attachCollab } = await import("./collab.ts");
const { HTTPException } = await import("hono/http-exception");
const lfModule = await import("./little-friend.ts");
const { FAULT_ROUTES, littleFriend, littleFriendFromEnv, releaseFrom, reportFault, installLittleFriend } = lfModule;

// Secrets a request could carry. None of them may appear in anything sent.
const SHARE_TOKEN = "shrTOKENabc123def456ghi789";
const DOC_ID = "docSECRETid0123456789";
const SESSION_TOKEN = "sessTOKENzyx987wvu654";
const LINK_TOKEN = "lnkTOKENqwe321rty654";
const SECRETS = [SHARE_TOKEN, DOC_ID, SESSION_TOKEN, LINK_TOKEN];

// Routes that exist only in this test.
app.get("/__test/boom/:secret", () => {
  throw new Error("deliberate test fault");
});
app.get("/__test/refused", () => {
  throw new HTTPException(429, { message: "slow down" });
});

interface Sent { url: string; body: string; auth: string | null }

function collector() {
  const sent: Sent[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(input), body: String(init?.body ?? ""), auth: headers.get("authorization") });
    return new Response(JSON.stringify({ accepted: 1, dropped: 0 }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  const lf = littleFriendFromEnv(
    { LF_SERVER_KEY: "lfs_testKey123", LF_RELEASE: "abc123def456", NODE_ENV: "test" },
    { fetch: fetchStub, endpoint: "http://collector.test" }
  );
  assert.ok(lf);
  return { lf, sent };
}

async function withConsole<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  const keep = (...args: unknown[]) => lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "));
  console.error = keep;
  console.warn = keep;
  console.log = keep;
  try {
    return { result: await run(), lines };
  } finally {
    Object.assign(console, original);
  }
}

function assertNoSecrets(text: string) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `sent or logged a secret: ${secret}`);
}

function rows(sent: Sent[]) {
  return sent
    .filter((s) => s.url.endsWith("/v1/server/requests"))
    .flatMap((s) => (JSON.parse(s.body) as { rows: Array<{ r: string; m: string; s: number; n: number }> }).rows);
}

function events(sent: Sent[]) {
  return sent
    .filter((s) => s.url.endsWith("/v1/server"))
    .flatMap((s) => (JSON.parse(s.body) as { events: Array<Record<string, unknown>> }).events);
}

test("release: LF_RELEASE, else Kamal's version, else GIT_SHA", () => {
  assert.equal(releaseFrom({ LF_RELEASE: "64518012a589", KAMAL_VERSION: "other" }), "64518012a589");
  assert.equal(releaseFrom({ LF_RELEASE: "", KAMAL_VERSION: "64518012a589" }), "64518012a589");
  assert.equal(releaseFrom({ LF_RELEASE: "bad value with spaces", GIT_SHA: "deadbeef" }), "deadbeef");
  assert.equal(releaseFrom({}), undefined);
});

test("off without a key, and a wrong key never stops boot or prints the key", async () => {
  assert.equal(littleFriendFromEnv({}), null);
  assert.equal(littleFriendFromEnv({ LF_SERVER_KEY: "  " }), null);
  const { result, lines } = await withConsole(async () => littleFriendFromEnv({ LF_SERVER_KEY: "lf_siteKeyNotSecret99" }));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes("little_friend_off")));
  assert.ok(lines.every((l) => !l.includes("lf_siteKeyNotSecret99")));
  // The app booted with none: nothing is installed and requests still answer.
  assert.equal(littleFriend(), null);
  assert.equal((await app.request("/health")).status, 200);
});

test("requests are timed by route template, never by path", async () => {
  const { lf, sent } = collector();
  installLittleFriend(lf);
  try {
    await app.request("/health");
    await app.request(`/s/${SHARE_TOKEN}`);
    await app.request(`/s/${SHARE_TOKEN}?x=${SESSION_TOKEN}`, { method: "HEAD" });
    await app.request(`/d/${DOC_ID}`);
    await app.request(`/api/document-platform/links/${LINK_TOKEN}`);
    await app.request(`/api/docs/${DOC_ID}`);
    await app.request(`/nowhere/${SHARE_TOKEN}`);
    await app.request(`/api/nowhere/${SHARE_TOKEN}`);
    await lf.flushRequests();
  } finally {
    installLittleFriend(null);
  }
  for (const s of sent) assertNoSecrets(s.body);
  assert.ok(sent.every((s) => s.auth === "Bearer lfs_testKey123"));
  const routes = new Set(rows(sent).map((r) => `${r.m} ${r.r} ${r.s}`));
  assert.ok(routes.has("GET /health 2"), [...routes].join(", "));
  assert.ok([...routes].some((r) => r.startsWith("GET /s/:token ")), [...routes].join(", "));
  assert.ok([...routes].some((r) => r.startsWith("HEAD /s/:token ")), [...routes].join(", "));
  assert.ok([...routes].some((r) => r.startsWith("GET /d/:id ")), [...routes].join(", "));
  assert.ok([...routes].some((r) => r.startsWith("GET /api/document-platform/links/:token ")), [...routes].join(", "));
  // A path no route answered counts under /*, whatever it held.
  assert.ok(routes.has("GET /* 4"), [...routes].join(", "));
});

test("a fault is sent with its stack under the route template, and the log names the template", async () => {
  const { lf, sent } = collector();
  installLittleFriend(lf);
  let res: Response | undefined;
  const { lines } = await withConsole(async () => {
    res = await app.request(`/__test/boom/${SHARE_TOKEN}`);
    await app.request("/__test/refused");
    await lf.flush();
    await lf.flushRequests();
  });
  installLittleFriend(null);
  assert.equal(res?.status, 500);
  for (const line of lines) assertNoSecrets(line);
  assert.ok(lines.some((l) => l.startsWith("GET /__test/boom/:secret failed:")), lines.join("\n"));
  for (const s of sent) assertNoSecrets(s.body);
  const errors = events(sent).filter((e) => e.name === "$error");
  assert.equal(errors.length, 1, "a 4xx HTTPException is not a fault");
  const [fault] = errors;
  const text = JSON.stringify(fault);
  assert.match(text, /deliberate test fault/);
  assert.match(text, /\/__test\/boom\/:secret/);
  assert.match(text, /abc123def456/, "names the release");
  assert.match(text, /little-friend\.test\.ts/, "carries stack frames");
  const routes = rows(sent).map((r) => `${r.m} ${r.r} ${r.s}`);
  assert.ok(routes.includes("GET /__test/boom/:secret 5"), routes.join(", "));
  assert.ok(routes.includes("GET /__test/refused 4"), routes.join(", "));
});

test("a collab upgrade fault is sent under /collab/:docId, without the socket's token", async () => {
  const { lf, sent } = collector();
  installLittleFriend(lf);
  const server = createServer();
  attachCollab(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const { lines } = await withConsole(async () => {
    // A malformed escape in the document id throws inside the upgrade handler.
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /collab/${DOC_ID}%zz?token=${SESSION_TOKEN} HTTP/1.1\r\n` +
            "Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
      });
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    await lf.flush();
  });
  installLittleFriend(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const line of lines) assertNoSecrets(line);
  for (const s of sent) assertNoSecrets(s.body);
  const errors = events(sent).filter((e) => e.name === "$error");
  assert.equal(errors.length, 1, lines.join("\n"));
  assert.match(JSON.stringify(errors[0]), /\/collab\/:docId/);
  assert.match(JSON.stringify(errors[0]), /URIError/);
});

test("reportFault does nothing when Little Friend is off", () => {
  installLittleFriend(null);
  reportFault(new Error("nowhere to go"), FAULT_ROUTES.orphanSweep);
});
