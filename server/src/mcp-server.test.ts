// The hosted MCP at POST /mcp, through the whole app. JSON-RPC 2.0 over
// Streamable HTTP with plain JSON answers; agent tokens only; the same
// document rule as the REST routes.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified, type TestUser } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-mcp-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-mcp-test-secret-32-plus-characters!";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app } = await import("./index.ts");
const { resetAgentWriteLimitsForTests, WRITES_PER_HOUR } = await import("./agent-tokens.ts");
const { PASTE_INSTRUCTION } = await import("./agent-docs.ts");
// The source the hosted guide must match, read from mcp/ itself.
const { MARKDOWN_GUIDE } = await import("../../mcp/markdown-guide.mjs");

const ORIGIN = "http://localhost:8787";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function post(token: string | undefined, body: unknown, extra: Record<string, string> = {}) {
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-forwarded-for": "127.0.0.1", ...extra });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request("/mcp", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, data: text ? JSON.parse(text) : null };
}

let seq = 0;
const rpc = (token: string, method: string, params?: unknown) => post(token, { jsonrpc: "2.0", id: ++seq, method, ...(params === undefined ? {} : { params }) });
const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  assert.equal(r.status, 200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.data.result as { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };
};

let alice: TestUser;
let bob: TestUser;
let aliceToken: string;
let aliceTokenId: string;
let bobToken: string;

before(async () => {
  alice = await signUpVerified(app, { name: "Alice", email: "alice@markie.test" });
  bob = await signUpVerified(app, { name: "Bob", email: "bob@markie.test" });
  const mint = async (user: TestUser, name: string) => {
    const res = await app.request("/api/agent-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ name }),
    });
    return (await res.json()) as { id: string; token: string };
  };
  const a = await mint(alice, "Claude on the web");
  aliceToken = a.token;
  aliceTokenId = a.id;
  bobToken = (await mint(bob, "Bob's agent")).token;
});

beforeEach(() => resetAgentWriteLimitsForTests());

test("no agent token, no MCP: 401 with the bearer challenge", async () => {
  const unknown = "mk_agent_" + "B".repeat(43);
  for (const token of [undefined, alice.token, unknown]) {
    const r = await post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(r.status, 401, String(token));
    assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="markie"');
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(r.data.error.code, -32001);
    assert.ok(!("result" in r.data));
  }
});

test("GET and DELETE are 405: no stream and no sessions", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await app.request("/mcp", { method, headers: { Authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "POST");
  }
});

test("initialize negotiates 2025-06-18 and says what the server is", async () => {
  const r = await rpc(aliceToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(r.data.jsonrpc, "2.0");
  assert.equal(r.data.id, seq);
  assert.equal(r.data.result.protocolVersion, "2025-06-18");
  assert.deepEqual(r.data.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.data.result.serverInfo.name, "markie-cloud");
  assert.match(r.data.result.instructions, /markdownLink/);
  const newer = await rpc(aliceToken, "initialize", { protocolVersion: "2099-01-01" });
  assert.equal(newer.data.result.protocolVersion, "2025-06-18", "an unknown version is offered ours");
  const older = await rpc(aliceToken, "initialize", { protocolVersion: "2025-03-26" });
  assert.equal(older.data.result.protocolVersion, "2025-03-26");
});

test("notifications are accepted with 202 and no body; ping answers {}", async () => {
  const n = await post(aliceToken, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(n.status, 202);
  assert.equal(n.text, "");
  const p = await rpc(aliceToken, "ping");
  assert.deepEqual(p.data.result, {});
});

test("the five tools, exactly", async () => {
  const r = await rpc(aliceToken, "tools/list");
  assert.deepEqual(
    r.data.result.tools.map((t: { name: string }) => t.name),
    ["markie_create_document", "markie_update_document", "markie_list_my_documents", "markie_read_my_document", "markie_guide"]
  );
  for (const tool of r.data.result.tools) assert.equal(tool.inputSchema.type, "object", tool.name);
});

test("create, read, update and list through tools, each with both links and the paste instruction", async () => {
  const created = await callTool(aliceToken, "markie_create_document", { name: "Trip.md", content: "# Trip\n" });
  assert.ok(!created.isError, created.content[0].text);
  const doc = created.structuredContent;
  assert.equal(doc.privateLink, `${ORIGIN}/d/${doc.id}`);
  assert.equal(doc.markdownLink, `[Trip.md](${ORIGIN}/d/${doc.id})`);
  assert.ok(created.content[0].text.includes(doc.markdownLink));
  assert.ok(created.content[0].text.includes(PASTE_INSTRUCTION));
  assert.equal(PASTE_INSTRUCTION, "Paste markdownLink into your reply. It opens in Markie on the user's phone, or in a browser after they sign in.");

  // The session sees it as an agent document named after the token.
  const asOwner = await app.request(`/api/docs/${doc.id}`, { headers: { Authorization: `Bearer ${alice.token}` } });
  assert.deepEqual(((await asOwner.json()) as { doc: { origin: unknown } }).doc.origin, { kind: "agent", agent: "Claude on the web" });

  const updated = await callTool(aliceToken, "markie_update_document", { id: doc.id, content: "# Trip v2\n" });
  assert.ok(!updated.isError);
  assert.equal(updated.structuredContent.version, 2);
  assert.ok(updated.content[0].text.includes(PASTE_INSTRUCTION));

  const read = await callTool(aliceToken, "markie_read_my_document", { id: doc.id });
  assert.equal(read.structuredContent.content, "# Trip v2\n");
  assert.equal(read.structuredContent.markdownLink, doc.markdownLink);

  const list = await callTool(aliceToken, "markie_list_my_documents", { limit: 5 });
  assert.ok(list.structuredContent.docs.some((d: { id: string; markdownLink: string }) => d.id === doc.id && d.markdownLink === doc.markdownLink));
});

test("tools refuse what the REST routes refuse, as tool errors", async () => {
  const docx = await callTool(aliceToken, "markie_create_document", { name: "a.docx", content: "x" });
  assert.equal(docx.isError, true);
  assert.match(docx.content[0].text, /\.md, \.markdown, \.mdx, \.wd, \.txt/);
  const big = await callTool(aliceToken, "markie_create_document", { name: "a.wd", content: "a".repeat(128_001) });
  assert.equal(big.isError, true);
  const noContent = await callTool(aliceToken, "markie_create_document", { name: "a.md" });
  assert.equal(noContent.isError, true);
  const badLimit = await callTool(aliceToken, "markie_list_my_documents", { limit: 0 });
  assert.equal(badLimit.isError, true);
});

test("tools cannot read or update app documents or another user's documents", async () => {
  const appId = crypto.randomUUID();
  const put = await app.request(`/api/docs/${appId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ name: "Diary.md", content: "dear diary", hash: sha("dear diary"), baseVersion: 0 }),
  });
  assert.equal(put.status, 200);
  const bobs = (await callTool(bobToken, "markie_create_document", { name: "Bob.md", content: "bob" })).structuredContent;
  const missing = crypto.randomUUID();

  const readMissing = await callTool(aliceToken, "markie_read_my_document", { id: missing });
  for (const id of [appId, bobs.id]) {
    const read = await callTool(aliceToken, "markie_read_my_document", { id });
    assert.equal(read.isError, true);
    assert.equal(read.content[0].text, readMissing.content[0].text, "same answer as a missing id");
    assert.ok(!read.content[0].text.includes("diary") && !read.content[0].text.includes("bob"));
    const update = await callTool(aliceToken, "markie_update_document", { id, content: "pwned" });
    assert.equal(update.isError, true);
  }
  const list = await callTool(aliceToken, "markie_list_my_documents", { limit: 100 });
  assert.ok(!list.structuredContent.docs.some((d: { id: string }) => d.id === appId || d.id === bobs.id));
  const diary = await app.request(`/api/docs/${appId}`, { headers: { Authorization: `Bearer ${alice.token}` } });
  assert.equal(((await diary.json()) as { doc: { content: string } }).doc.content, "dear diary");
});

test("markie_guide serves the local MCP's guide text", async () => {
  const r = await callTool(aliceToken, "markie_guide");
  assert.equal(r.content[0].text, MARKDOWN_GUIDE);
});

test("tool writes share the token's 60-an-hour budget", async () => {
  for (let i = 0; i < WRITES_PER_HOUR; i++) {
    const r = await callTool(aliceToken, "markie_create_document", { name: `n${i}.md`, content: "x" });
    assert.ok(!r.isError, `write ${i}`);
  }
  const over = await callTool(aliceToken, "markie_create_document", { name: "over.md", content: "x" });
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /60 writes/);
  const rest = await app.request("/api/agent/docs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ name: "rest.md", content: "x" }),
  });
  assert.equal(rest.status, 429, "the REST route sees the same budget");
  const read = await callTool(aliceToken, "markie_list_my_documents");
  assert.ok(!read.isError, "reads are not limited");
});

test("protocol errors: unknown tool, unknown method, bad JSON, batches, bad versions", async () => {
  const unknownTool = await rpc(aliceToken, "tools/call", { name: "markie_delete_everything", arguments: {} });
  assert.equal(unknownTool.data.error.code, -32602);
  const badArgs = await rpc(aliceToken, "tools/call", { name: "markie_guide", arguments: [1] });
  assert.equal(badArgs.data.error.code, -32602);
  const unknownMethod = await rpc(aliceToken, "resources/list");
  assert.equal(unknownMethod.data.error.code, -32601);
  const parse = await post(aliceToken, "{not json");
  assert.equal(parse.status, 400);
  assert.equal(parse.data.error.code, -32700);
  const batch = await post(aliceToken, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.equal(batch.status, 400);
  assert.equal(batch.data.error.code, -32600);
  const noVersion = await post(aliceToken, { id: 1, method: "ping" });
  assert.equal(noVersion.status, 400);
  const badHeader = await post(aliceToken, { jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "1999-01-01" });
  assert.equal(badHeader.status, 400);
  const goodHeader = await post(aliceToken, { jsonrpc: "2.0", id: "s", method: "ping" }, { "MCP-Protocol-Version": "2025-06-18" });
  assert.equal(goodHeader.status, 200);
  assert.equal(goodHeader.data.id, "s");
});

test("a body past the agent limit is refused before it is read", async () => {
  const r = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "markie_create_document", arguments: { name: "a.md", content: "a".repeat(6 * 1024 * 1024) } } }),
  });
  assert.equal(r.status, 413);
});

test("a revoked token is refused on the next request", async () => {
  const res = await app.request(`/api/agent-tokens/${aliceTokenId}`, { method: "DELETE", headers: { Authorization: `Bearer ${alice.token}` } });
  assert.equal(res.status, 200);
  const r = await rpc(aliceToken, "ping");
  assert.equal(r.status, 401);
});
