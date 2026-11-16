// Accepting people before their shares land (share-people.ts,
// share-people-store.ts), end to end through the real server: every route a
// recipient could read a document through, before and after they accept the
// sender, plus decline, block, unblock, remove, and invites to an address
// with no account yet.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified, type TestUser } from "./test-users.ts";

const dir = mkdtempSync(join(tmpdir(), "markie-share-people-"));
process.env.DB_PATH = join(dir, "t.db");
process.env.ASSETS_DIR = join(dir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-share-people-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_NO_LISTEN = "1";
// Turns on the account platform, whose cloud-area placements are one more
// place a document id is checked against access.
process.env.MARKIE_ACCOUNT_IDENTITIES = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { app } = await import("./index.ts");
const { attachCollab } = await import("./collab.ts");
const { resetInviteLimitsForTests } = await import("./shares.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH);

// Mail goes to the console in tests (email.ts); nothing is sent anywhere.
// Captured here so tests can say who was mailed what.
const mail: Array<{ to: string; subject: string; body: string }> = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  const m = /\[email→console\] to=(\S+) subject="(.*)"\n([\s\S]*)/.exec(line);
  if (m) mail.push({ to: m[1], subject: m[2], body: m[3] });
  else realLog(...args);
};

const server = createServer((_req, res) => {
  res.statusCode = 404;
  res.end();
});
attachCollab(server as Parameters<typeof attachCollab>[0]);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const sockets = new Set<WebSocket>();
after(async () => {
  console.log = realLog;
  for (const ws of sockets) ws.terminate();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

const stamp = Date.now();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const SECRET = `the-secret-body-${stamp}`;
let callers = 0;

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T; text: string }> {
  callers += 1;
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: "http://localhost:3000",
    "x-forwarded-for": `10.44.${Math.floor(callers / 250) % 250}.${callers % 250}`,
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, data: data as T, text };
}

async function user(name: string): Promise<TestUser> {
  return signUpVerified(app, { name, email: `${name.toLowerCase()}.${stamp}@people.test` });
}

async function putDoc(owner: TestUser, id: string, name = "Plan.md") {
  const content = `# Plan\n\n${SECRET}\n\n![](a.png)\n`;
  const res = await call("PUT", `/api/docs/${id}`, owner.token, { name, content, hash: sha(content), baseVersion: 0 });
  assert.equal(res.status, 200, res.text);
}

async function share(owner: TestUser, id: string, email: string, role: "viewer" | "editor" = "editor") {
  const res = await call<{ status: string }>("POST", `/api/docs/${id}/shares`, owner.token, { email, role });
  assert.equal(res.status, 200, res.text);
  return res.data.status;
}

async function mintAgent(who: TestUser): Promise<string> {
  const res = await call<{ token: string }>("POST", "/api/agent-tokens", who.token, { name: "Agent" });
  assert.equal(res.status, 201, res.text);
  return res.data.token;
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return res.text();
}

/** Opens a collaboration socket. Resolves with the socket once open, or rejects with the refusal. */
function connect(docId: string, token: string): Promise<{ ws: WebSocket; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/collab/${encodeURIComponent(docId)}?token=${encodeURIComponent(token)}`);
    sockets.add(ws);
    let closed = false;
    ws.on("close", () => (closed = true));
    ws.once("open", () => {
      ws.removeAllListeners("error");
      ws.on("error", () => {});
      resolve({ ws, closed: () => closed });
    });
    ws.once("error", reject);
  });
}

async function waitFor(label: string, predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

type Request = { docId: string; name: string; kind: string; role: string; sender: { id: string; name: string | null; email: string } };
const requestsOf = async (who: TestUser) => (await call<{ requests: Request[]; count: number }>("GET", "/api/people/requests", who.token)).data;
const membersOf = async (owner: TestUser, id: string) =>
  (await call<{ shares: Array<Record<string, unknown>> }>("GET", `/api/docs/${id}/shares`, owner.token)).data.shares;
const libraryIds = async (who: TestUser) => (await call<{ docs: Array<{ id: string }> }>("GET", "/api/docs", who.token)).data.docs.map((d) => d.id);
const recentIds = async (who: TestUser) => (await call<{ docs: Array<{ id: string }> }>("GET", "/api/docs/recent", who.token)).data.docs.map((d) => d.id);

// Everything a recipient could reach a document through, asserted closed.
async function assertNothingReaches(who: TestUser, id: string, agentToken: string) {
  assert.ok(!(await libraryIds(who)).includes(id), "not in the Library listing");
  assert.ok(!(await recentIds(who)).includes(id), "not in the phone's recent list");
  const read = await call("GET", `/api/docs/${id}`, who.token);
  assert.equal(read.status, 404, "no document read");
  assert.ok(!read.text.includes(SECRET));
  assert.equal((await call("GET", `/api/docs/${id}/access`, who.token)).status, 403);
  assert.equal((await call("GET", `/api/docs/${id}/shares`, who.token)).status, 403, "no member list");
  const write = await call("PUT", `/api/docs/${id}`, who.token, { name: "x.md", content: "x", hash: sha("x"), baseVersion: 1 });
  assert.equal(write.status, 403, "no write, though the request is for an editor");
  assert.equal((await call("GET", `/api/docs/${id}/threads`, who.token)).status, 403, "no comments");
  assert.equal((await call("POST", `/api/docs/${id}/threads`, who.token, { anchor: { quote: "Plan" }, body: "hi" })).status, 403);
  const asset = await call("GET", `/api/docs/${id}/assets/file?ref=a.png`, who.token);
  assert.equal(asset.status, 404, "no assets");
  assert.equal((await call("POST", `/api/docs/${id}/collab-ticket`, who.token)).status, 404, "no collaboration ticket");
  await assert.rejects(connect(id, who.token), /401/, "no collaboration socket");
  const view = await call("GET", `/d/${id}`, who.token);
  assert.equal(view.status, 403, "no web read view");
  assert.ok(!view.text.includes(SECRET));
  const raw = await call("GET", `/d/${id}/raw`, who.token);
  assert.equal(raw.status, 403, "no raw download");
  assert.ok(!raw.text.includes(SECRET));
  assert.equal((await call("GET", `/d/${id}/assets?ref=a.png`, who.token)).status, 403);
  // The recipient's own agent token: it reads only what that token wrote, so
  // a request is out of its reach just as a landed share is.
  const agentList = await call<{ docs: Array<{ id: string }> }>("GET", "/api/agent/docs", agentToken);
  assert.ok(!agentList.data.docs.some((d) => d.id === id), "not in the agent's list");
  assert.equal((await call("GET", `/api/agent/docs/${encodeURIComponent(id)}`, agentToken)).status, 404, "no agent read");
  assert.ok(!(await mcp(agentToken, "markie_read_my_document", { id })).includes(SECRET), "no MCP read");
  assert.ok(!(await mcp(agentToken, "markie_list_my_documents", { limit: 100 })).includes(id), "not in the MCP list");
}

const owner = await user("Olive");
const bob = await user("Bob");
const bobAgent = await mintAgent(bob);

test("a share from someone not accepted is a request, and nothing of the document reaches the recipient", async () => {
  const id = `people-request-${stamp}`;
  await putDoc(owner, id);
  // A real asset behind a.png, so "no assets" below is a refusal, not a miss.
  const png = Buffer.from("0123456789");
  const pngHash = createHash("sha256").update(png).digest("hex");
  const uploaded = await app.request(`/api/assets/${pngHash}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "image/png", "Content-Length": "10", Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" },
    body: new Blob([png]),
  });
  assert.ok(uploaded.status < 300, `asset upload: ${uploaded.status}`);
  assert.equal((await call("PUT", `/api/docs/${id}/assets`, owner.token, { refs: [{ ref: "a.png", hash: pngHash }] })).status, 200);
  assert.equal((await call("GET", `/api/docs/${id}/assets/file?ref=a.png`, owner.token)).status, 200);
  mail.length = 0;
  assert.equal(await share(owner, id, bob.email), "requested");

  // The mail names the sender and the file, and carries no link to it and
  // nothing of its content.
  const sent = mail.filter((m) => m.to === bob.email);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Olive wants to share “Plan\.md” with you/);
  assert.ok(sent[0].body.includes(owner.email), "names the sender's address");
  assert.ok(sent[0].body.includes("Requests"));
  assert.ok(!sent[0].body.includes("/d/") && !sent[0].body.includes("?k=") && !sent[0].body.includes("markie://doc"));
  assert.ok(!sent[0].body.includes(SECRET));

  const { requests, count } = await requestsOf(bob);
  assert.equal(count, 1);
  assert.deepEqual(
    { docId: requests[0].docId, name: requests[0].name, kind: requests[0].kind, role: requests[0].role, sender: requests[0].sender },
    { docId: id, name: "Plan.md", kind: "doc", role: "editor", sender: { id: owner.id, name: "Olive", email: owner.email } }
  );
  assert.ok(!JSON.stringify(requests).includes(SECRET));

  await assertNothingReaches(bob, id, bobAgent);
  // The web view is the one place that says what is waiting: the sender and
  // the file name the request already shows, and still no content.
  const view = await call("GET", `/d/${id}?view=1`, bob.token);
  assert.ok(view.text.includes("Requests") && view.text.includes("Plan.md"));

  // The owner sees Bob as waiting.
  const bobRow = (await membersOf(owner, id)).find((m) => m.user_id === bob.id);
  assert.equal(bobRow?.waiting, true);
  // Contact suggestions: an unaccepted sender is not someone Bob shares with.
  const contacts = await call<{ contacts: Array<{ email: string }> }>("GET", "/api/docs/share-contacts", bob.token);
  assert.ok(!contacts.data.contacts.some((c) => c.email === owner.email));
});

test("accepting the sender lands every request from them, and their later shares land directly", async () => {
  const first = `people-request-${stamp}`;
  const second = `people-second-${stamp}`;
  await putDoc(owner, second, "Second.md");
  assert.equal(await share(owner, second, bob.email, "viewer"), "requested");
  assert.equal((await requestsOf(bob)).count, 2);

  const accepted = await call<{ landed: string[] }>("POST", `/api/people/${owner.id}/accept`, bob.token);
  assert.equal(accepted.status, 200);
  assert.deepEqual([...accepted.data.landed].sort(), [first, second].sort());
  assert.equal((await requestsOf(bob)).count, 0);

  for (const id of [first, second]) {
    assert.ok((await libraryIds(bob)).includes(id));
    assert.ok((await recentIds(bob)).includes(id));
    const read = await call<{ doc: { content: string } }>("GET", `/api/docs/${id}`, bob.token);
    assert.equal(read.status, 200);
    assert.ok(read.data.doc.content.includes(SECRET));
  }
  assert.equal((await call("GET", `/api/docs/${first}/threads`, bob.token)).status, 200);
  assert.equal((await call("GET", `/api/docs/${first}/assets/file?ref=a.png`, bob.token)).status, 200);
  assert.equal((await call("POST", `/api/docs/${first}/collab-ticket`, bob.token)).status, 200);
  const socket = await connect(first, bob.token);
  socket.ws.close();
  assert.equal((await membersOf(owner, first)).find((m) => m.user_id === bob.id)?.waiting, false);

  const third = `people-third-${stamp}`;
  await putDoc(owner, third, "Third.md");
  mail.length = 0;
  assert.equal(await share(owner, third, bob.email), "member", "lands directly once accepted");
  assert.ok(mail.find((m) => m.to === bob.email)?.subject.includes("shared"), "the usual shared-with-you mail");
  assert.ok((await libraryIds(bob)).includes(third));
  const people = await call<{ accepted: Array<{ id: string; email: string }>; blocked: unknown[] }>("GET", "/api/people", bob.token);
  assert.deepEqual(people.data.accepted.map((p) => p.email), [owner.email]);
  assert.deepEqual(people.data.blocked, []);
});

test("declining drops that one request, and the sender can ask again", async () => {
  const carol = await user("Carol");
  const id = `people-decline-${stamp}`;
  await putDoc(owner, id);
  assert.equal(await share(owner, id, carol.email), "requested");
  // Somebody else's request is not Carol's to decline, and Bob cannot touch hers.
  assert.equal((await call("POST", `/api/people/requests/${id}/decline`, bob.token)).status, 404);
  assert.equal((await call("POST", `/api/people/requests/${id}/decline`, carol.token)).status, 200);
  assert.equal((await requestsOf(carol)).count, 0);
  assert.ok(!(await membersOf(owner, id)).some((m) => m.user_id === carol.id), "the share row is gone");
  assert.equal((await call("POST", `/api/people/requests/${id}/decline`, carol.token)).status, 404, "nothing left to decline");

  assert.equal(await share(owner, id, carol.email), "requested");
  assert.equal((await requestsOf(carol)).count, 1, "a new request");
  assert.equal((await call("GET", `/api/docs/${id}`, carol.token)).status, 404, "still nothing until accepted");
});

test("blocking is silent: the sender sees the same waiting state, later shares stay hidden and send no mail", async () => {
  const dave = await user("Dave");
  const erin = await user("Erin");
  const daveAgent = await mintAgent(dave);
  const id = `people-block-${stamp}`;
  await putDoc(owner, id);
  assert.equal(await share(owner, id, dave.email), "requested");
  assert.equal(await share(owner, id, erin.email), "requested");

  assert.equal((await call("POST", `/api/people/${owner.id}/block`, dave.token)).status, 200);
  assert.equal((await requestsOf(dave)).count, 0);

  // Blocked Dave and unanswered Erin look exactly alike to the owner.
  const members = await membersOf(owner, id);
  // Everything but who the row is about.
  const shape = (row: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !["user_id", "email", "name", "created_at"].includes(key)));
  assert.deepEqual(
    shape(members.find((m) => m.user_id === dave.id)),
    shape(members.find((m) => m.user_id === erin.id))
  );
  assert.equal(members.find((m) => m.user_id === dave.id)?.waiting, true);

  // A later share: the same answer as for anyone who has not accepted, no
  // mail to Dave, and nothing in his Markie.
  const later = `people-block-later-${stamp}`;
  await putDoc(owner, later);
  mail.length = 0;
  assert.equal(await share(owner, later, dave.email), "requested");
  assert.equal(mail.filter((m) => m.to === dave.email).length, 0);
  assert.equal((await requestsOf(dave)).count, 0);
  await assertNothingReaches(dave, id, daveAgent);
  await assertNothingReaches(dave, later, daveAgent);
  assert.equal((await call("POST", `/api/people/${owner.id}/accept`, dave.token)).status, 404, "no request to accept");

  const people = await call<{ blocked: Array<{ id: string }> }>("GET", "/api/people", dave.token);
  assert.deepEqual(people.data.blocked.map((p) => p.id), [owner.id]);
  // Unblocking puts what they sent back as requests; nothing lands by itself.
  assert.equal((await call("POST", `/api/people/${owner.id}/unblock`, dave.token)).status, 200);
  assert.deepEqual((await requestsOf(dave)).requests.map((r) => r.docId).sort(), [id, later].sort());
  assert.equal((await call("GET", `/api/docs/${id}`, dave.token)).status, 404);
  assert.equal((await call("POST", `/api/people/${owner.id}/unblock`, dave.token)).status, 404, "not blocked any more");
});

test("removing an accepted person takes everything they shared away at once, open sockets included", async () => {
  const id = `people-request-${stamp}`;
  const socket = await connect(id, bob.token);
  // Bob took part in a thread, so he would be mailed about replies.
  const thread = await call<{ id: string }>("POST", `/api/docs/${id}/threads`, bob.token, { anchor: { quote: "Plan" }, body: "a note" });
  assert.equal(thread.status, 200, thread.text);
  mail.length = 0;
  assert.equal((await call("POST", `/api/docs/${id}/threads/${thread.data.id}/comments`, owner.token, { body: "first reply" })).status, 200);
  assert.equal(mail.filter((m) => m.to === bob.email).length, 1, "while accepted, Bob is mailed about replies");

  assert.equal((await call("DELETE", `/api/people/${owner.id}`, bob.token)).status, 200);
  await waitFor("Bob's socket to close", socket.closed);
  await assertNothingReaches(bob, id, bobAgent);
  assert.equal((await requestsOf(bob)).count, 0, "they do not come back as requests");
  assert.ok(!(await membersOf(owner, id)).some((m) => m.user_id === bob.id));

  // No more notifications from the owner's documents either.
  mail.length = 0;
  const reply = await call("POST", `/api/docs/${id}/threads/${thread.data.id}/comments`, owner.token, { body: "a reply" });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(mail.filter((m) => m.to === bob.email).length, 0);

  // Their next share is a request again.
  assert.equal(await share(owner, id, bob.email), "requested");
  assert.equal((await call("DELETE", `/api/people/${owner.id}`, bob.token)).status, 404, "not accepted any more");
});

test("blocking an accepted person takes their shares away just as removing does", async () => {
  const frank = await user("Frank");
  const id = `people-block-accepted-${stamp}`;
  await putDoc(owner, id);
  await share(owner, id, frank.email);
  assert.equal((await call("POST", `/api/people/${owner.id}/accept`, frank.token)).status, 200);
  const socket = await connect(id, frank.token);
  assert.equal((await call("POST", `/api/people/${owner.id}/block`, frank.token)).status, 200);
  await waitFor("Frank's socket to close", socket.closed);
  assert.equal((await call("GET", `/api/docs/${id}`, frank.token)).status, 404);
  // To the owner this reads as a removal, the same as any other.
  assert.ok(!(await membersOf(owner, id)).some((m) => m.user_id === frank.id));
  assert.equal(await share(owner, id, frank.email), "requested");
  assert.equal((await requestsOf(frank)).count, 0, "and stays hidden");
});

test("the people routes act only for the signed-in recipient, and answer 404 for anything else", async () => {
  const stranger = await user("Stan");
  for (const [method, path] of [
    ["GET", "/api/people"],
    ["GET", "/api/people/requests"],
    ["POST", `/api/people/${owner.id}/accept`],
    ["POST", `/api/people/${owner.id}/block`],
    ["DELETE", `/api/people/${owner.id}`],
  ] as const) {
    assert.equal((await call(method, path)).status, 401, `${method} ${path} needs a session`);
  }
  assert.equal((await call("POST", `/api/people/${owner.id}/accept`, stranger.token)).status, 404, "no request to accept");
  assert.equal((await call("POST", `/api/people/${stranger.id}/accept`, stranger.token)).status, 404, "not oneself");
  assert.equal((await call("POST", `/api/people/${owner.id}/block`, stranger.token)).status, 404, "nothing from them to block");
  assert.equal((await call("DELETE", `/api/people/${owner.id}`, stranger.token)).status, 404);
  assert.equal((await call("POST", `/api/people/${owner.id}/unblock`, stranger.token)).status, 404);
  assert.equal((await call("POST", "/api/people/requests/no-such-doc/decline", stranger.token)).status, 404);
  assert.deepEqual((await call("GET", "/api/people", stranger.token)).data, { accepted: [], blocked: [] });
});

test("an invite to an address with no account becomes a request when they sign up, and its link opens nothing until they accept", async () => {
  resetInviteLimitsForTests();
  const id = `people-invite-${stamp}`;
  await putDoc(owner, id);
  const email = `gina.${stamp}@people.test`;
  mail.length = 0;
  assert.equal(await share(owner, id, email), "invited");
  const invite = mail.find((m) => m.to === email);
  assert.ok(invite?.subject.includes("wants to share"));
  assert.ok(invite?.body.includes("Requests"));
  assert.ok(!invite?.body.includes(SECRET));
  const token = (db.prepare("SELECT token FROM pending_shares WHERE doc_id = ? AND email = ?").get(id, email) as { token: string }).token;

  const gina = await signUpVerified(app, { name: "Gina", email });
  assert.ok(!(await libraryIds(gina)).includes(id), "signing up claims a request, not the document");
  assert.deepEqual((await requestsOf(gina)).requests.map((r) => r.docId), [id]);
  // The emailed link is now the share's token. Signed out, it is no member's
  // link while the share is a request: no sign-in redirect that implies one.
  const signedOut = await call("GET", `/d/${id}?k=${token}&view=1`);
  assert.equal(signedOut.status, 403);
  assert.ok(!signedOut.text.includes(SECRET));

  assert.equal((await call("POST", `/api/people/${owner.id}/accept`, gina.token)).status, 200);
  assert.ok((await libraryIds(gina)).includes(id));
  const member = await call("GET", `/d/${id}?k=${token}&view=1`);
  assert.equal(member.status, 302, "once accepted, the link is a member's link again");
});

test("a document-platform file shared by someone not accepted is a request too", async () => {
  const hana = await user("Hana");
  const bytes = Buffer.from(String.raw`{\rtf1\ansi office-secret\par}`, "utf8");
  const created = await call<{ document: { id: string } }>("POST", "/api/document-platform/documents", owner.token, {
    schemaVersion: 2, name: "Sheet.rtf", format: "rtf", encoding: "base64", data: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"), baseVersion: 0,
  });
  assert.equal(created.status, 201, created.text);
  const file = created.data.document.id;
  const added = await call("POST", `/api/document-platform/documents/${file}/members`, owner.token, { userId: hana.id, role: "viewer" });
  assert.ok(added.status < 300, added.text);

  const listed = await call<{ documents: Array<{ id: string }> }>("GET", "/api/document-platform/documents", hana.token);
  assert.ok(!listed.data.documents.some((d) => d.id === file));
  assert.equal((await call("GET", `/api/document-platform/documents/${file}`, hana.token)).status, 404);
  const members = await call<{ members: Array<{ userId: string; waiting: boolean }> }>("GET", `/api/document-platform/documents/${file}/members`, owner.token);
  assert.equal(members.data.members.find((m) => m.userId === hana.id)?.waiting, true);
  const request = (await requestsOf(hana)).requests.find((r) => r.docId === file);
  assert.equal(request?.kind, "file");
  // Nor can Hana file it into one of her own cloud areas.
  const area = (await call<{ area: { id: string } }>("POST", "/api/account/cloud-areas", hana.token, { label: "Mine" })).data.area;
  const placement = `/api/account/cloud-areas/placements/snapshot/${file}`;
  assert.equal((await call("PUT", placement, hana.token, { areaId: area.id })).status, 404);

  assert.equal((await call("POST", `/api/people/${owner.id}/accept`, hana.token)).status, 200);
  assert.equal((await call("GET", `/api/document-platform/documents/${file}`, hana.token)).status, 200);
  assert.equal((await call("PUT", placement, hana.token, { areaId: area.id })).status, 200, "once accepted, she can");
  assert.equal((await call("DELETE", `/api/people/${owner.id}`, hana.token)).status, 200);
  assert.equal((await call("GET", `/api/document-platform/documents/${file}`, hana.token)).status, 404);
});
