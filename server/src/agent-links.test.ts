// Agent tokens and the documents they reach (docs/mobile/AGENT-LINKS-CONTRACT.md),
// through the whole app so the body limits, mounting and headers are the
// production ones. The rule under test above all: an agent token reads and
// updates only the documents it created itself, and every other id answers a
// 404 that cannot be told apart from "no such document".
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified, type TestUser } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-agent-links-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-agent-links-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_NO_LISTEN = "1";
process.env.ASSETS_DIR = join(mkdtempSync(join(tmpdir(), "markie-agent-links-assets-")), "store");

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app } = await import("./index.ts");
const {
  resetAgentWriteLimitsForTests,
  authenticateAgent,
  takeAgentWrite,
  recordAgentBytes,
  WRITES_PER_HOUR,
  USER_WRITES_PER_HOUR,
  USER_BYTES_PER_DAY,
} = await import("./agent-tokens.ts");
const { setStorageQuotaForTests } = await import("./quota.ts");
const { resetInviteLimitsForTests } = await import("./shares.ts");
const { privateLinkOrigin, markdownLink, markdownLinkFor, cleanAgentName } = await import("./doc-meta.ts");
const { writeDocVersion } = await import("./docs.ts");

const db = new Database(process.env.DB_PATH!);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ORIGIN = "http://localhost:8787";

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}) {
  const headers = new Headers({ "Content-Type": "application/json", Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" });
  if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data, text };
}

async function appDoc(user: TestUser, name = "Mine.md", content = "# private\n", origin?: unknown) {
  const id = crypto.randomUUID();
  const r = await call("PUT", `/api/docs/${id}`, { token: user.token, body: { name, content, hash: sha(content), baseVersion: 0, ...(origin ? { origin } : {}) } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return id;
}

async function mintToken(user: TestUser, name = "Claude on the web") {
  const r = await call("POST", "/api/agent-tokens", { token: user.token, body: { name } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data as { id: string; name: string; token: string; prefix: string; createdAt: string };
}

async function agentCreate(token: string, body: Record<string, unknown>) {
  return call("POST", "/api/agent/docs", { token, body });
}

let alice: TestUser;
let bob: TestUser;
let aliceAgent: { id: string; token: string };
let bobAgent: { id: string; token: string };

before(async () => {
  alice = await signUpVerified(app, { name: "Alice", email: "alice@markie.test" });
  bob = await signUpVerified(app, { name: "Bob", email: "bob@markie.test" });
  aliceAgent = await mintToken(alice, "Alice's agent");
  bobAgent = await mintToken(bob, "Bob's agent");
});

beforeEach(() => {
  resetAgentWriteLimitsForTests();
  resetInviteLimitsForTests();
  setStorageQuotaForTests(null);
});

// ---- tokens ------------------------------------------------------------------

test("a new token is shown once, in the agent format, and only its hash is stored", async () => {
  const minted = await mintToken(alice, "Once");
  assert.match(minted.token, /^mk_agent_[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.prefix, minted.token.slice(0, 12));
  assert.equal(minted.name, "Once");
  assert.ok(!Number.isNaN(Date.parse(minted.createdAt)));
  const row = db.prepare("SELECT * FROM agent_tokens WHERE id = ?").get(minted.id) as Record<string, unknown>;
  assert.equal(row.token_hash, sha(minted.token));
  assert.ok(!Object.values(row).includes(minted.token), "the token itself is never stored");

  const listed = await call("GET", "/api/agent-tokens", { token: alice.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  const entry = listed.data.tokens.find((t: { id: string }) => t.id === minted.id);
  assert.deepEqual(Object.keys(entry).sort(), ["createdAt", "id", "lastUsedAt", "name", "prefix"]);
  assert.ok(!listed.text.includes(minted.token), "listing never repeats the token");
  await call("DELETE", `/api/agent-tokens/${minted.id}`, { token: alice.token });
});

test("a token needs a name of 1 to 64 characters", async () => {
  for (const body of [{}, { name: "" }, { name: "   " }, { name: 7 }, { name: "x".repeat(65) }]) {
    const r = await call("POST", "/api/agent-tokens", { token: alice.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const ok = await mintToken(alice, "x".repeat(64));
  await call("DELETE", `/api/agent-tokens/${ok.id}`, { token: alice.token });
});

test("an account holds at most 20 active tokens, and revoking frees a place", async () => {
  const carol = await signUpVerified(app, { name: "Carol", email: "carol@markie.test" });
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push((await mintToken(carol, `t${i}`)).id);
  const refused = await call("POST", "/api/agent-tokens", { token: carol.token, body: { name: "one too many" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, "token limit");
  assert.equal((await call("DELETE", `/api/agent-tokens/${ids[0]}`, { token: carol.token })).status, 204);
  await mintToken(carol, "fits again");
});

test("token routes need a session and refuse an agent token, its own included", async () => {
  assert.equal((await call("GET", "/api/agent-tokens")).status, 401);
  assert.equal((await call("POST", "/api/agent-tokens", { body: { name: "x" } })).status, 401);
  const before = (db.prepare("SELECT COUNT(*) AS n FROM agent_tokens").get() as { n: number }).n;
  const list = await call("GET", "/api/agent-tokens", { token: aliceAgent.token });
  const mint = await call("POST", "/api/agent-tokens", { token: aliceAgent.token, body: { name: "successor" } });
  const revoke = await call("DELETE", `/api/agent-tokens/${aliceAgent.id}`, { token: aliceAgent.token });
  for (const r of [list, mint, revoke]) assert.equal(r.status, 403);
  assert.ok(!list.text.includes("prefix"), "no token list leaks to an agent token");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_tokens").get() as { n: number }).n, before);
  assert.equal((await call("GET", "/api/agent/docs", { token: aliceAgent.token })).status, 200, "still live");
});

test("revoking is immediate and repeatable, and another account's token answers 404", async () => {
  const minted = await mintToken(alice, "short-lived");
  assert.equal((await call("GET", "/api/agent/docs", { token: minted.token })).status, 200);
  assert.equal((await call("DELETE", `/api/agent-tokens/${minted.id}`, { token: bob.token })).status, 404);
  assert.equal((await call("GET", "/api/agent/docs", { token: minted.token })).status, 200, "bob could not revoke it");
  const revoked = await call("DELETE", `/api/agent-tokens/${minted.id}`, { token: alice.token });
  assert.equal(revoked.status, 204);
  assert.equal(revoked.text, "");
  const after = await call("GET", "/api/agent/docs", { token: minted.token });
  assert.equal(after.status, 401);
  assert.equal(after.headers.get("www-authenticate"), 'Bearer realm="markie"');
  assert.equal((await agentCreate(minted.token, { name: "a.md", content: "x" })).status, 401);
  assert.equal((await call("DELETE", `/api/agent-tokens/${minted.id}`, { token: alice.token })).status, 204, "already revoked is still 204");
  assert.equal((await call("DELETE", `/api/agent-tokens/${minted.id}`, { token: bob.token })).status, 404, "never bob's");
  assert.equal((await call("DELETE", `/api/agent-tokens/${crypto.randomUUID()}`, { token: alice.token })).status, 404, "never anyone's");
  const listed = await call("GET", "/api/agent-tokens", { token: alice.token });
  assert.ok(!listed.data.tokens.some((t: { id: string }) => t.id === minted.id));
});

test("agent routes take agent tokens only: no session, no malformed or unknown token", async () => {
  const unknown = "mk_agent_" + "A".repeat(43);
  for (const token of [undefined, alice.token, unknown, "mk_agent_short", aliceAgent.token + "x", aliceAgent.token.slice(9)]) {
    const r = await call("GET", "/api/agent/docs", { token });
    assert.equal(r.status, 401, String(token));
    assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="markie"');
  }
});

test("an agent token is not a session anywhere else", async () => {
  const id = await appDoc(alice);
  for (const path of ["/api/docs", `/api/docs/${id}`, "/api/docs/recent", "/api/account/usage"]) {
    assert.equal((await call("GET", path, { token: aliceAgent.token })).status, 401, path);
  }
  const put = await call("PUT", `/api/docs/${id}`, { token: aliceAgent.token, body: { name: "x.md", content: "pwned", hash: sha("pwned"), baseVersion: 1 } });
  assert.equal(put.status, 401);
  assert.equal((await call("DELETE", `/api/docs/${id}`, { token: aliceAgent.token })).status, 401);
});

test("last_used_at is set on use and written at most once a minute", async () => {
  const minted = await mintToken(alice, "clock");
  const headers = new Headers({ Authorization: `Bearer ${minted.token}` });
  const read = () => (db.prepare("SELECT last_used_at FROM agent_tokens WHERE id = ?").get(minted.id) as { last_used_at: number | null }).last_used_at;
  assert.equal(read(), null);
  const t0 = 1_800_000_000_000;
  assert.ok(authenticateAgent(headers, t0));
  assert.equal(read(), t0);
  authenticateAgent(headers, t0 + 59_000);
  assert.equal(read(), t0, "not rewritten inside the minute");
  authenticateAgent(headers, t0 + 60_000);
  assert.equal(read(), t0 + 60_000);
  await call("DELETE", `/api/agent-tokens/${minted.id}`, { token: alice.token });
});

// ---- creating ------------------------------------------------------------------

test("an agent creates a private document and gets both links back", async () => {
  const r = await agentCreate(aliceAgent.token, { name: "Plan.md", content: "# Plan\n" });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(r.data).sort(), ["format", "id", "markdownLink", "name", "privateLink", "version"]);
  assert.equal(r.data.name, "Plan.md");
  assert.equal(r.data.format, "markdown");
  assert.equal(r.data.version, 1);
  assert.equal(r.data.privateLink, `${ORIGIN}/d/${r.data.id}`);
  assert.equal(r.data.markdownLink, `[Plan.md](${ORIGIN}/d/${r.data.id})`);
  const row = db.prepare("SELECT owner_id, origin_kind, origin_agent, format, created_at, updated_at, hash FROM docs WHERE id = ?").get(r.data.id) as Record<string, string>;
  assert.equal(row.owner_id, alice.id);
  assert.equal(row.origin_kind, "agent");
  assert.equal(row.origin_agent, "Alice's agent", "the token's name when no agent is given");
  assert.equal(row.created_at, row.updated_at);
  assert.equal(row.hash, sha("# Plan\n"));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM doc_history WHERE doc_id = ?").get(r.data.id) as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM public_links WHERE doc_id = ?").get(r.data.id) as { n: number } | undefined)?.n ?? 0, 0, "never public");
});

test("the agent's own name is cleaned and limited, else the token's name is used", async () => {
  const named = await agentCreate(aliceAgent.token, { name: "a.md", content: "x", agent: "  Claude‮\u0007 Code\n  " });
  const row = db.prepare("SELECT origin_agent FROM docs WHERE id = ?").get(named.data.id) as { origin_agent: string };
  assert.equal(row.origin_agent, "Claude Code");
  const long = await agentCreate(aliceAgent.token, { name: "b.md", content: "x", agent: "y".repeat(100) });
  assert.equal((db.prepare("SELECT origin_agent FROM docs WHERE id = ?").get(long.data.id) as { origin_agent: string }).origin_agent.length, 64);
  const blank = await agentCreate(aliceAgent.token, { name: "c.md", content: "x", agent: "\u0000​ " });
  assert.equal((db.prepare("SELECT origin_agent FROM docs WHERE id = ?").get(blank.data.id) as { origin_agent: string }).origin_agent, "Alice's agent");
  assert.equal(cleanAgentName(42), null);
});

test("only .md, .markdown, .mdx, .wd and .txt may be written", async () => {
  const formats: Record<string, string> = { "a.md": "markdown", "a.markdown": "markdown", "a.mdx": "markdown", "a.wd": "darkmown", "a.txt": "text", "UPPER.MD": "markdown" };
  for (const [name, format] of Object.entries(formats)) {
    const r = await agentCreate(aliceAgent.token, { name, content: "x" });
    assert.equal(r.status, 201, name);
    assert.equal(r.data.format, format, name);
  }
  for (const name of ["a.docx", "a.html", "a.json", "a.log", "README", ".md", "a.md.exe", "dir/a.md", "a\\b.md", "a\u0000.md", "x".repeat(256) + ".md", ""]) {
    const r = await agentCreate(aliceAgent.token, { name, content: "x" });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(r.data.error, "bad request");
  }
  assert.equal((await agentCreate(aliceAgent.token, { name: "a.md" })).status, 400, "content is required");
  assert.equal((await agentCreate(aliceAgent.token, { name: "a.md", content: 5 })).status, 400);
  assert.equal((await call("POST", "/api/agent/docs", { token: aliceAgent.token, raw: "not json" })).status, 400);
  assert.equal((await call("POST", "/api/agent/docs", { token: aliceAgent.token, raw: "[1]" })).status, 400);
});

test("size limits: .wd at the Darkmown limit, everything else at 2 MB", async () => {
  assert.equal((await agentCreate(aliceAgent.token, { name: "max.wd", content: "a".repeat(128_000) })).status, 201);
  const wd = await agentCreate(aliceAgent.token, { name: "over.wd", content: "a".repeat(128_001) });
  assert.equal(wd.status, 413);
  assert.equal(wd.data.error, "too large");
  assert.equal((await agentCreate(aliceAgent.token, { name: "max.md", content: "a".repeat(2 * 1024 * 1024) })).status, 201);
  assert.equal((await agentCreate(aliceAgent.token, { name: "over.md", content: "a".repeat(2 * 1024 * 1024 + 1) })).status, 413);
  // Counted in bytes: 2 MB of a 3-byte character is over.
  // 699,050 euro signs are 2,097,150 bytes; one more is 2,097,153.
  assert.equal((await agentCreate(aliceAgent.token, { name: "wide.txt", content: "€".repeat(699_050) })).status, 201);
  assert.equal((await agentCreate(aliceAgent.token, { name: "wider.txt", content: "€".repeat(699_051) })).status, 413);
});

test("a body past the agent route's limit is refused before anything reads it", async () => {
  const r = await call("POST", "/api/agent/docs", { token: aliceAgent.token, raw: JSON.stringify({ name: "a.md", content: "a".repeat(6 * 1024 * 1024) }) });
  assert.equal(r.status, 413);
});

test("without a live token, a chunked body with no Content-Length is not read at all", async () => {
  const offered = 4 * 1024 * 1024;
  const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
  const unknown = "mk_agent_" + "D".repeat(43);
  for (const [method, path] of [["POST", "/api/agent/docs"], ["PUT", `/api/agent/docs/${crypto.randomUUID()}`]]) {
    for (const token of [undefined, alice.token, unknown]) {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulled >= offered) return controller.close();
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 }
      );
      const headers = new Headers({ "Content-Type": "application/json" });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const res = await app.request(path, { method, headers, body, duplex: "half" } as RequestInit);
      assert.equal(res.status, 401, `${method} ${String(token)}`);
      assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="markie"');
      assert.ok(pulled <= chunk.byteLength, `${method}: read ${pulled} bytes before answering 401`);
    }
  }
});

test("agent documents count against the storage quota", async () => {
  setStorageQuotaForTests(1);
  const r = await agentCreate(aliceAgent.token, { name: "q.md", content: "too much" });
  assert.equal(r.status, 413);
  assert.equal(r.data.error, "storage_quota_exceeded");
  assert.deepEqual(Object.keys(r.data).sort(), ["error", "message"], "a token holder never learns the account's usage or quota");
  setStorageQuotaForTests(null);
  const made = await agentCreate(aliceAgent.token, { name: "q.md", content: "fits" });
  assert.equal(made.status, 201);
  setStorageQuotaForTests(1);
  const shrink = await call("PUT", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token, body: { content: "f" } });
  assert.equal(shrink.status, 200, "shrinking is always allowed");
  const grow = await call("PUT", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token, body: { content: "much more than before" } });
  assert.equal(grow.status, 413);
});

// ---- the rule ------------------------------------------------------------------

test("an agent token cannot read, update or list the user's own app documents (404, not 403)", async () => {
  const appId = await appDoc(alice, "Secret.md", "# diary\n");
  const missing = crypto.randomUUID();
  const readApp = await call("GET", `/api/agent/docs/${appId}`, { token: aliceAgent.token });
  const readMissing = await call("GET", `/api/agent/docs/${missing}`, { token: aliceAgent.token });
  assert.equal(readApp.status, 404);
  assert.equal(readApp.text, readMissing.text, "indistinguishable from no such document");
  assert.deepEqual(readApp.data, { error: "not found" });
  const putApp = await call("PUT", `/api/agent/docs/${appId}`, { token: aliceAgent.token, body: { content: "pwned" } });
  const putMissing = await call("PUT", `/api/agent/docs/${missing}`, { token: aliceAgent.token, body: { content: "pwned" } });
  assert.equal(putApp.status, 404);
  assert.equal(putApp.text, putMissing.text);
  // Even a malformed body cannot tell the two apart.
  const badApp = await call("PUT", `/api/agent/docs/${appId}`, { token: aliceAgent.token, body: { name: "x.docx" } });
  const badMissing = await call("PUT", `/api/agent/docs/${missing}`, { token: aliceAgent.token, body: { name: "x.docx" } });
  assert.equal(badApp.status, 404);
  assert.equal(badApp.text, badMissing.text);
  const list = await call("GET", "/api/agent/docs?limit=100", { token: aliceAgent.token });
  assert.ok(!list.data.docs.some((d: { id: string }) => d.id === appId));
  const row = db.prepare("SELECT content, version FROM docs WHERE id = ?").get(appId) as { content: string; version: number };
  assert.deepEqual(row, { content: "# diary\n", version: 1 });
});

test("an agent token cannot reach another user's documents, agent-made or shared", async () => {
  const bobs = await agentCreate(bobAgent.token, { name: "Bob.md", content: "bob" });
  const bobsApp = await appDoc(bob, "BobApp.md", "bob app");
  // Shared with Alice as an editor: her session may edit it, her agent may not.
  assert.equal((await call("POST", `/api/docs/${bobsApp}/shares`, { token: bob.token, body: { email: "alice@markie.test", role: "editor" } })).status, 200);
  assert.equal((await call("POST", `/api/docs/${bobs.data.id}/shares`, { token: bob.token, body: { email: "alice@markie.test", role: "editor" } })).status, 200);
  for (const id of [bobs.data.id, bobsApp]) {
    assert.equal((await call("GET", `/api/agent/docs/${id}`, { token: aliceAgent.token })).status, 404);
    assert.equal((await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { content: "x" } })).status, 404);
  }
  const list = await call("GET", "/api/agent/docs", { token: aliceAgent.token });
  assert.ok(!list.data.docs.some((d: { id: string }) => d.id === bobs.data.id || d.id === bobsApp));
  assert.equal((db.prepare("SELECT content FROM docs WHERE id = ?").get(bobs.data.id) as { content: string }).content, "bob");
});

test("a token reaches only the documents it created, not those of the user's other tokens", async () => {
  const second = await mintToken(alice, "second agent");
  const mine = await agentCreate(aliceAgent.token, { name: "Mine.md", content: "one" });
  const theirs = await agentCreate(second.token, { name: "Theirs.md", content: "two" });
  const missing = crypto.randomUUID();
  for (const [token, id] of [[second.token, mine.data.id], [aliceAgent.token, theirs.data.id]] as const) {
    const read = await call("GET", `/api/agent/docs/${id}`, { token });
    const readMissing = await call("GET", `/api/agent/docs/${missing}`, { token });
    assert.equal(read.status, 404);
    assert.equal(read.text, readMissing.text);
    const put = await call("PUT", `/api/agent/docs/${id}`, { token, body: { content: "pwned" } });
    const putMissing = await call("PUT", `/api/agent/docs/${missing}`, { token, body: { content: "pwned" } });
    assert.equal(put.status, 404);
    assert.equal(put.text, putMissing.text);
  }
  const listed = (token: string) => call("GET", "/api/agent/docs?limit=100", { token }).then((r) => r.data.docs.map((d: { id: string }) => d.id));
  assert.ok((await listed(aliceAgent.token)).includes(mine.data.id));
  assert.ok(!(await listed(aliceAgent.token)).includes(theirs.data.id));
  assert.deepEqual(await listed(second.token), [theirs.data.id]);
  assert.equal((db.prepare("SELECT content FROM docs WHERE id = ?").get(mine.data.id) as { content: string }).content, "one");
  await call("DELETE", `/api/agent-tokens/${second.id}`, { token: alice.token });
});

test("a revoked token's documents stay the user's and no token reaches them", async () => {
  const shortLived = await mintToken(alice, "short-lived writer");
  const made = await agentCreate(shortLived.token, { name: "Left.md", content: "kept" });
  assert.equal((await call("DELETE", `/api/agent-tokens/${shortLived.id}`, { token: alice.token })).status, 204);
  const row = db.prepare("SELECT owner_id, deleted_at, origin_token_id FROM docs WHERE id = ?").get(made.data.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { owner_id: alice.id, deleted_at: null, origin_token_id: shortLived.id }, "unchanged by revoking");
  const owner = await call("GET", `/api/docs/${made.data.id}`, { token: alice.token });
  assert.equal(owner.status, 200);
  assert.equal(owner.data.doc.content, "kept");
  assert.equal((await call("GET", `/api/agent/docs/${made.data.id}`, { token: shortLived.token })).status, 401);
  assert.equal((await call("GET", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token })).status, 404);
});

test("origin_token_id is set by token creates only, never changes, and is never returned", async () => {
  const made = await agentCreate(aliceAgent.token, { name: "Tracked.md", content: "v1" });
  const tokenOf = (id: string) => (db.prepare("SELECT origin_token_id FROM docs WHERE id = ?").get(id) as { origin_token_id: string | null }).origin_token_id;
  assert.equal(tokenOf(made.data.id), aliceAgent.id);
  const updated = await call("PUT", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token, body: { content: "v2", name: "Tracked.wd" } });
  assert.equal(updated.status, 200);
  const pushed = await call("PUT", `/api/docs/${made.data.id}`, {
    token: alice.token,
    body: { name: "Tracked.wd", content: "v3", hash: sha("v3"), baseVersion: 2, origin: { kind: "app" } },
  });
  assert.equal(pushed.status, 200);
  assert.equal(tokenOf(made.data.id), aliceAgent.id, "neither an update nor a session push moves it");
  const bridged = await appDoc(alice, "ViaBridge.md", "x", { kind: "agent", agent: "Claude Code" });
  assert.equal(tokenOf(bridged), null, "the desktop bridge never sets it");

  const answers = [
    made,
    updated,
    pushed,
    await call("GET", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token }),
    await call("GET", "/api/agent/docs", { token: aliceAgent.token }),
    await call("GET", `/api/docs/${made.data.id}`, { token: alice.token }),
    await call("GET", "/api/docs", { token: alice.token }),
    await call("GET", "/api/docs/recent", { token: alice.token }),
  ];
  for (const r of answers) {
    assert.ok(!r.text.includes("origin_token_id") && !r.text.includes("originTokenId"), r.text.slice(0, 120));
    assert.ok(!r.text.includes(aliceAgent.id), "the token's id is not in any answer");
  }
});

test("GET /api/docs reports every token-written document as sharedOut, and nothing else new", async () => {
  const fern = await signUpVerified(app, { name: "Fern", email: "fern@markie.test" });
  const fernAgent = await mintToken(fern, "Fern's agent");
  const written = await agentCreate(fernAgent.token, { name: "Written.md", content: "![x](~/repo/.env)" });
  const bridged = await appDoc(fern, "Bridged.md", "mine", { kind: "agent", agent: "Claude Code" });
  const own = await appDoc(fern, "Own.md", "mine");
  const shared = await appDoc(fern, "Shared.md", "mine");
  assert.equal((await call("POST", `/api/docs/${shared}/shares`, { token: fern.token, body: { email: "bob@markie.test", role: "viewer" } })).status, 200);
  const listing = async () =>
    Object.fromEntries(
      ((await call("GET", "/api/docs", { token: fern.token })).data.docs as { id: string; sharedOut: boolean }[]).map((d) => [d.id, d.sharedOut])
    );
  assert.deepEqual(await listing(), { [written.data.id]: true, [bridged]: false, [own]: false, [shared]: true });
  assert.equal((await call("DELETE", `/api/agent-tokens/${fernAgent.id}`, { token: fern.token })).status, 204);
  assert.equal((await listing())[written.data.id], true, "revoking the token does not make its text the owner's");

  // The server's own link route draws the same line: an escaping reference
  // in a token-written document is dropped, as in a shared one.
  const links = async (id: string) =>
    (await call("PUT", `/api/docs/${id}/assets`, { token: fern.token, body: { refs: [{ ref: "../outside.png" }] } })).data.droppedRefs;
  assert.deepEqual(await links(written.data.id), [{ ref: "../outside.png", reason: "escaping" }]);
  assert.deepEqual(await links(own), [], "the owner's own document is unchanged");
});

test("a shared, invited or public document is frozen to tokens: 409 shared, reads still work", async () => {
  const shareWith = (id: string) => call("POST", `/api/docs/${id}/shares`, { token: alice.token, body: { email: "bob@markie.test", role: "editor" } });
  const invite = (id: string) => call("POST", `/api/docs/${id}/shares`, { token: alice.token, body: { email: "nobody-yet@markie.test", role: "viewer" } });
  const publish = (id: string) => call("POST", `/api/docs/${id}/public-link`, { token: alice.token, body: {} });
  for (const [how, open] of [["member", shareWith], ["pending invite", invite], ["public link", publish]] as const) {
    const made = await agentCreate(aliceAgent.token, { name: `Frozen ${how}.md`, content: "as shared" });
    const opened = await open(made.data.id);
    assert.ok(opened.status === 200 || opened.status === 201, `${how}: ${opened.status} ${opened.text}`);
    const put = await call("PUT", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token, body: { content: "changed under them" } });
    assert.equal(put.status, 409, how);
    assert.equal(put.data.error, "shared", how);
    assert.match(put.data.message, /Create a new document instead/, how);
    const read = await call("GET", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token });
    assert.equal(read.status, 200, how);
    assert.equal(read.data.content, "as shared");
    const row = db.prepare("SELECT content, version FROM docs WHERE id = ?").get(made.data.id) as { content: string; version: number };
    assert.deepEqual({ ...row }, { content: "as shared", version: 1 }, how);
  }
});

test("200 writes an hour per user across all tokens, then 429 that reveals no usage", async () => {
  const gwen = await signUpVerified(app, { name: "Gwen", email: "gwen@markie.test" });
  const gwenAgent = await mintToken(gwen, "Gwen's agent");
  const fresh = await mintToken(gwen, "Gwen's fresh agent");
  // Other tokens of hers used the budget; none of them is over its own 60.
  for (let i = 0; i < USER_WRITES_PER_HOUR; i++) assert.equal(takeAgentWrite({ tokenId: `other-${i % 4}`, userId: gwen.id }), null);
  const over = await agentCreate(fresh.token, { name: "over.md", content: "x" });
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("retry-after"), null, "when other agents' writes age out is theirs");
  assert.deepEqual(Object.keys(over.data).sort(), ["error", "message"]);
  assert.equal(over.data.error, "rate limited");
  assert.deepEqual(over.data.message.match(/\d+/g), [String(USER_WRITES_PER_HOUR)], "the public limit, and no count");
  assert.equal((await agentCreate(gwenAgent.token, { name: "also.md", content: "x" })).status, 429, "every token of hers");
  assert.equal((await call("GET", "/api/agent/docs", { token: fresh.token })).status, 200, "reads are not limited");
  assert.equal((await agentCreate(aliceAgent.token, { name: "alice.md", content: "x" })).status, 201, "per user");
});

test("50 MB of written content a day per user across all tokens, then 429 that reveals no usage", async () => {
  const hal = await signUpVerified(app, { name: "Hal", email: "hal@markie.test" });
  const halAgent = await mintToken(hal, "Hal's agent");
  recordAgentBytes(hal.id, USER_BYTES_PER_DAY - 10);
  const fits = await agentCreate(halAgent.token, { name: "fits.md", content: "0123456789" });
  assert.equal(fits.status, 201, "exactly at the budget");
  const over = await agentCreate(halAgent.token, { name: "over.md", content: "x" });
  assert.equal(over.status, 429);
  assert.deepEqual(Object.keys(over.data).sort(), ["error", "message"]);
  assert.deepEqual(over.data.message.match(/\d+/g), ["50"], "the public limit, and no usage");
  const update = await call("PUT", `/api/agent/docs/${fits.data.id}`, { token: halAgent.token, body: { content: "y" } });
  assert.equal(update.status, 429, "an update writes content too");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM docs WHERE owner_id = ?").get(hal.id) as { n: number }).n, 1);
});

test("a deleted agent document is gone for the agent too", async () => {
  const made = await agentCreate(aliceAgent.token, { name: "Gone.md", content: "bye" });
  assert.equal((await call("DELETE", `/api/docs/${made.data.id}`, { token: alice.token })).status, 200);
  assert.equal((await call("GET", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token })).status, 404);
  assert.equal((await call("PUT", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token, body: { content: "back" } })).status, 404);
});

// ---- reading and updating --------------------------------------------------------

test("read, list and update an agent document", async () => {
  const made = await agentCreate(aliceAgent.token, { name: "Notes.md", content: "v1" });
  const id = made.data.id;
  const read = await call("GET", `/api/agent/docs/${id}`, { token: aliceAgent.token });
  assert.equal(read.status, 200);
  assert.equal(read.data.content, "v1");
  assert.deepEqual(read.data.origin, { kind: "agent", agent: "Alice's agent" });
  assert.equal(read.data.privateLink, `${ORIGIN}/d/${id}`);

  const conflict = await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { content: "v2", baseVersion: 7 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.serverVersion, 1);
  assert.equal((await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { content: "v2", baseVersion: "1" } })).status, 400);

  const updated = await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { content: "v2", baseVersion: 1 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.version, 2);
  assert.equal(updated.data.privateLink, `${ORIGIN}/d/${id}`);
  assert.equal(updated.data.markdownLink, `[Notes.md](${ORIGIN}/d/${id})`);
  const lww = await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { content: "v3" } });
  assert.equal(lww.data.version, 3, "baseVersion is optional");

  const renamed = await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { content: "v4", name: "Notes.wd" } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.format, "darkmown");
  assert.equal((db.prepare("SELECT format, origin_kind FROM docs WHERE id = ?").get(id) as { format: string }).format, "darkmown");
  assert.equal((await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { content: "x", name: "Notes.docx" } })).status, 400);
  assert.equal((await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { content: "a".repeat(128_001) } })).status, 413, "the .wd limit follows the rename");
  assert.equal((await call("PUT", `/api/agent/docs/${id}`, { token: aliceAgent.token, body: { name: "x.md" } })).status, 400, "content is required");

  const list = await call("GET", "/api/agent/docs?limit=1", { token: aliceAgent.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.docs.length, 1);
  assert.equal(list.data.docs[0].id, id, "newest first");
  assert.ok(!("content" in list.data.docs[0]), "metadata only");
  for (const limit of ["0", "101", "abc", "1.5"]) {
    assert.equal((await call("GET", `/api/agent/docs?limit=${limit}`, { token: aliceAgent.token })).status, 400, limit);
  }
});

test("origin is honoured when a session push creates a document, and ignored afterwards", async () => {
  const bridged = await appDoc(alice, "Bridged.md", "from the desktop bridge", { kind: "agent", agent: "Claude Code" });
  const asOwner = await call("GET", `/api/docs/${bridged}`, { token: alice.token });
  assert.deepEqual(asOwner.data.doc.origin, { kind: "agent", agent: "Claude Code" }, "a desktop-bridge document carries the agent badge");
  assert.equal((await call("GET", `/api/agent/docs/${bridged}`, { token: aliceAgent.token })).status, 404, "and no token reaches it");

  const plain = await appDoc(alice, "Plain.md", "mine");
  const push = await call("PUT", `/api/docs/${plain}`, { token: alice.token, body: { name: "Plain.md", content: "mine 2", hash: sha("mine 2"), baseVersion: 1, origin: { kind: "agent", agent: "Sneaky" } } });
  assert.equal(push.status, 200);
  assert.equal((await call("GET", `/api/agent/docs/${plain}`, { token: aliceAgent.token })).status, 404, "an app document never becomes an agent one");
  const row = db.prepare("SELECT origin_kind, origin_agent FROM docs WHERE id = ?").get(plain) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { origin_kind: "app", origin_agent: null });

  const later = await call("PUT", `/api/docs/${bridged}`, { token: alice.token, body: { name: "Bridged.md", content: "edited", hash: sha("edited"), baseVersion: 1, origin: { kind: "app" } } });
  assert.equal(later.status, 200);
  assert.equal((db.prepare("SELECT origin_kind FROM docs WHERE id = ?").get(bridged) as { origin_kind: string }).origin_kind, "agent", "nor the other way round");

  const odd = await appDoc(alice, "Odd.md", "x", { kind: "robot", agent: "nope" });
  assert.equal((db.prepare("SELECT origin_kind FROM docs WHERE id = ?").get(odd) as { origin_kind: string }).origin_kind, "app");
  const nameless = await appDoc(alice, "Nameless.md", "x", { kind: "agent" });
  assert.equal((db.prepare("SELECT origin_agent FROM docs WHERE id = ?").get(nameless) as { origin_agent: string }).origin_agent, "an agent");
});

test("a deleted document's id coming back starts a new origin, with no token", async () => {
  const id = await appDoc(alice, "Phoenix.md", "x", { kind: "agent", agent: "First" });
  assert.equal((await call("DELETE", `/api/docs/${id}`, { token: alice.token })).status, 200);
  const back = await call("PUT", `/api/docs/${id}`, { token: alice.token, body: { name: "Phoenix.md", content: "y", hash: sha("y"), baseVersion: 0 } });
  assert.equal(back.status, 200);
  assert.equal((await call("GET", `/api/agent/docs/${id}`, { token: aliceAgent.token })).status, 404);

  const made = await agentCreate(aliceAgent.token, { name: "Phoenix2.md", content: "agent" });
  assert.equal((await call("DELETE", `/api/docs/${made.data.id}`, { token: alice.token })).status, 200);
  const revived = await call("PUT", `/api/docs/${made.data.id}`, { token: alice.token, body: { name: "Phoenix2.md", content: "mine now", hash: sha("mine now"), baseVersion: 0 } });
  assert.equal(revived.status, 200);
  const row = db.prepare("SELECT origin_kind, origin_token_id FROM docs WHERE id = ?").get(made.data.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { origin_kind: "app", origin_token_id: null });
  assert.equal((await call("GET", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token })).status, 404, "the token lost it with the delete");
});

test("an editor's origin on someone else's document is ignored", async () => {
  const bobsDoc = await appDoc(bob, "BobsPlan.md", "bob v1");
  assert.equal((await call("POST", `/api/docs/${bobsDoc}/shares`, { token: bob.token, body: { email: "alice@markie.test", role: "editor" } })).status, 200);
  const push = await call("PUT", `/api/docs/${bobsDoc}`, {
    token: alice.token,
    body: { name: "BobsPlan.md", content: "alice edit", hash: sha("alice edit"), baseVersion: 1, origin: { kind: "agent", agent: "Sneaky" } },
  });
  assert.equal(push.status, 200);
  const row = db.prepare("SELECT owner_id, content, origin_kind, origin_agent, origin_token_id FROM docs WHERE id = ?").get(bobsDoc) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { owner_id: bob.id, content: "alice edit", origin_kind: "app", origin_agent: null, origin_token_id: null });
});

test("a write that claims to create a live document stops with nothing changed", () => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  writeDocVersion({ id, ownerId: alice.id, name: "Live.md", content: "first", hash: sha("first"), version: 1, now, origin: { kind: "app", agent: null } });
  assert.throws(
    () =>
      writeDocVersion({
        id,
        ownerId: alice.id,
        name: "Live.md",
        content: "second",
        hash: sha("second"),
        version: 1,
        now,
        origin: { kind: "agent", agent: "Hijack" },
        originTokenId: aliceAgent.id,
      }),
    /document already exists/
  );
  const row = db.prepare("SELECT content, origin_kind, origin_agent, origin_token_id FROM docs WHERE id = ?").get(id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { content: "first", origin_kind: "app", origin_agent: null, origin_token_id: null });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM doc_history WHERE doc_id = ?").get(id) as { n: number }).n, 1, "the transaction rolled back");
});

test("GET /api/docs/:id now says the format and origin", async () => {
  const made = await agentCreate(aliceAgent.token, { name: "Calc.wd", content: "::state x = 1" });
  const r = await call("GET", `/api/docs/${made.data.id}`, { token: alice.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.doc.format, "darkmown");
  assert.deepEqual(r.data.doc.origin, { kind: "agent", agent: "Alice's agent" });
  for (const key of ["id", "name", "version", "content", "hash", "updated_at"]) assert.ok(key in r.data.doc, key);
  const appId = await appDoc(alice);
  const app = await call("GET", `/api/docs/${appId}`, { token: alice.token });
  assert.deepEqual(app.data.doc.origin, { kind: "app", agent: null });
  assert.equal(app.data.doc.format, "markdown");
});

// ---- rate limit ------------------------------------------------------------------

test("60 writes an hour per token, then 429 with Retry-After; reads and other tokens unaffected", async () => {
  const made = await agentCreate(aliceAgent.token, { name: "Busy.md", content: "0" });
  assert.equal(made.status, 201);
  // Refused writes count too.
  assert.equal((await agentCreate(aliceAgent.token, { name: "bad.docx", content: "x" })).status, 400);
  for (let i = 2; i < WRITES_PER_HOUR; i++) {
    const r = await call("PUT", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token, body: { content: String(i) } });
    assert.equal(r.status, 200, `write ${i}`);
  }
  const limited = await call("PUT", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token, body: { content: "over" } });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error, "rate limited");
  const retry = Number(limited.headers.get("retry-after"));
  assert.ok(retry >= 1 && retry <= 3600, String(retry));
  assert.equal((await agentCreate(aliceAgent.token, { name: "more.md", content: "x" })).status, 429);
  assert.equal((await call("GET", `/api/agent/docs/${made.data.id}`, { token: aliceAgent.token })).status, 200, "reads still work");
  assert.equal((await agentCreate(bobAgent.token, { name: "bob.md", content: "x" })).status, 201, "per token");
  assert.equal((db.prepare("SELECT content FROM docs WHERE id = ?").get(made.data.id) as { content: string }).content, String(WRITES_PER_HOUR - 1));
});

// ---- recent ------------------------------------------------------------------

test("recent lists owned and shared documents newest first, with origin, role and link", async () => {
  const dave = await signUpVerified(app, { name: "Dave", email: "dave@markie.test" });
  const daveAgent = await mintToken(dave, "Dave's agent");
  const ownApp = await appDoc(dave, "Own.md", "own");
  const ownAgent = await agentCreate(daveAgent.token, { name: "Agent.wd", content: "w", agent: "Claude Code" });
  const fromBob = await appDoc(bob, "FromBob.txt", "hi dave");
  assert.equal((await call("POST", `/api/docs/${fromBob}/shares`, { token: bob.token, body: { email: "dave@markie.test", role: "viewer" } })).status, 200);
  // Three writes can land in one millisecond; pin the order under test.
  const at = (id: string, iso: string) => db.prepare("UPDATE docs SET updated_at = ? WHERE id = ?").run(iso, id);
  at(ownApp, "2026-10-01T10:00:00.000Z");
  at(ownAgent.data.id, "2026-10-02T10:00:00.000Z");
  at(fromBob, "2026-10-03T10:00:00.000Z");
  const r = await call("GET", "/api/docs/recent", { token: dave.token });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  const ids = r.data.docs.map((d: { id: string }) => d.id);
  assert.deepEqual(ids, [fromBob, ownAgent.data.id, ownApp]);
  const [shared, agentItem, owned] = r.data.docs;
  assert.deepEqual(shared, {
    id: fromBob, name: "FromBob.txt", format: "text", createdAt: shared.createdAt, updatedAt: shared.updatedAt,
    origin: { kind: "app", agent: null }, shared: true, role: "viewer", sharedBy: "Bob", privateLink: `${ORIGIN}/d/${fromBob}`,
  });
  assert.deepEqual(agentItem.origin, { kind: "agent", agent: "Claude Code" });
  assert.equal(agentItem.format, "darkmown");
  assert.equal(agentItem.role, "owner");
  assert.equal(agentItem.shared, false);
  assert.equal(agentItem.sharedBy, null);
  assert.equal(owned.privateLink, `${ORIGIN}/d/${ownApp}`);

  const page1 = await call("GET", "/api/docs/recent?limit=2", { token: dave.token });
  assert.deepEqual(page1.data.docs.map((d: { id: string }) => d.id), [fromBob, ownAgent.data.id]);
  const page2 = await call("GET", `/api/docs/recent?limit=2&before=${encodeURIComponent(page1.data.docs[1].updatedAt)}`, { token: dave.token });
  assert.deepEqual(page2.data.docs.map((d: { id: string }) => d.id), [ownApp]);

  for (const q of ["limit=0", "limit=101", "limit=x", "before=yesterday", "before=2026-13-45T99:99:99Z"]) {
    assert.equal((await call("GET", `/api/docs/recent?${q}`, { token: dave.token })).status, 400, q);
  }
  assert.equal((await call("GET", "/api/docs/recent")).status, 401);
  const others = (db.prepare("SELECT id FROM docs WHERE owner_id <> ?").all(dave.id) as { id: string }[]).map((d) => d.id);
  assert.ok(!ids.some((id: string) => others.includes(id) && id !== fromBob), "nothing of anyone else's but what was shared");
});

test("recent leaves out deleted documents", async () => {
  const erin = await signUpVerified(app, { name: "Erin", email: "erin@markie.test" });
  const id = await appDoc(erin, "Temp.md", "x");
  await call("DELETE", `/api/docs/${id}`, { token: erin.token });
  const r = await call("GET", "/api/docs/recent", { token: erin.token });
  assert.deepEqual(r.data.docs, []);
});

// ---- the web view ------------------------------------------------------------------

test("/d/:id shows a Darkmown document as escaped source, never as running script", async () => {
  const source = '# Budget\n\n<script>alert("x")</script>\n<img src=x onerror=alert(1)>\n::button[Add]{on:click="n += 1"}\n';
  const made = await agentCreate(aliceAgent.token, { name: "Budget.wd", content: source });
  const res = await app.request(`/d/${made.data.id}`, { headers: { Authorization: `Bearer ${alice.token}` } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /interactive Markie document\. Open it in the Markie app/);
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!/<script/i.test(html.replace(/&lt;script/g, "")), "no live script tag");
  assert.ok(!/<img[^>]*onerror/i.test(html));
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(html, /default-src 'none'/, "the page's own policy allows no script");
  assert.match(html, /Download \.wd/);

  const raw = await app.request(`/d/${made.data.id}/raw`, { headers: { Authorization: `Bearer ${alice.token}` } });
  assert.match(raw.headers.get("content-disposition") ?? "", /filename="Budget\.wd"/);
  assert.equal(await raw.text(), source);

  const md = await agentCreate(aliceAgent.token, { name: "Plain.md", content: "# Title\n\n<script>alert(1)</script>" });
  const mdHtml = await (await app.request(`/d/${md.data.id}`, { headers: { Authorization: `Bearer ${alice.token}` } })).text();
  assert.match(mdHtml, /<h1>Title<\/h1>/, "markdown still renders as markdown");
  assert.ok(!mdHtml.includes("interactive Markie document"));

  const stranger = await app.request(`/d/${made.data.id}`, { headers: { Authorization: `Bearer ${bob.token}` } });
  assert.equal(stranger.status, 403, "the private rule is unchanged");
});

// ---- links ------------------------------------------------------------------

test("privateLink is this server's own origin, and api.markiedocs.com on Markie Cloud", () => {
  assert.equal(privateLinkOrigin(), ORIGIN);
  assert.equal(privateLinkOrigin({ official: true, origin: "https://api-production-602f.up.railway.app" }), "https://api.markiedocs.com");
  assert.equal(privateLinkOrigin({ official: true, origin: "https://api.markiedocs.com" }), "https://api.markiedocs.com");
  assert.equal(privateLinkOrigin({ official: false, origin: "https://docs.example.org" }), "https://docs.example.org");
  assert.equal(privateLinkOrigin({ official: true, origin: "http://localhost:8787" }), "http://localhost:8787");
});

// The contract's vectors (docs/mobile/AGENT-LINKS-CONTRACT.md). The desktop
// runs the same ones, so the two sides cannot drift apart.
test("markdownLink escapes exactly as the contract says", () => {
  const link = "https://api.markiedocs.com/d/abc";
  const vectors: [string, string][] = [
    ["Plan.md", `[Plan.md](${link})`],
    ["a[b]c.md", `[a\\[b\\]c.md](${link})`],
    ["back\\slash.md", `[back\\\\slash.md](${link})`],
    ["line1\nline2.md", `[line1 line2.md](${link})`],
    ["<img>.md", `[\\<img\\>.md](${link})`],
    ["tick`.md", `[tick\\\`.md](${link})`],
  ];
  for (const [name, expected] of vectors) assert.equal(markdownLink(name, link), expected, JSON.stringify(name));
  assert.equal(markdownLink("x.md", "https://h/d/a(x)b"), "[x.md](https://h/d/a%28x%29b)");
  // A run of CR, LF, U+2028 and U+2029 is one space; other text is left alone.
  assert.equal(markdownLink("a\r\n\u2028\u2029b.md", link), `[a b.md](${link})`);
  assert.equal(markdownLink("a\n\nb\rc.md", link), `[a b c.md](${link})`);
  assert.equal(markdownLink("*bold*_x_ (1).md", link), `[*bold*_x_ (1).md](${link})`);
  assert.equal(markdownLinkFor("Plan.md", "id 1"), `[Plan.md](${ORIGIN}/d/id%201)`);
});
