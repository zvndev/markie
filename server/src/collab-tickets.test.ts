// Live-editing tickets end to end: issued through the real app (so the mount
// in index.ts is covered too) and redeemed over a real HTTP upgrade, because
// what matters is which sockets the server lets in and keeps, and none of
// that is visible from the helpers alone.
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
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-collab-tickets-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-collab-tickets-test-secret-32-plus";
process.env.MARKIE_SITE_URL = "https://markie.test";
// The real app, without the port or the websocket server index.ts would open.
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { app } = await import("./index.ts");
const { attachCollab } = await import("./collab.ts");
const { COLLAB_TICKET_TTL_MS, COLLAB_TICKETS_PER_MINUTE, issueCollabTicket } = await import("./collab-tickets.ts");
const Database = (await import("better-sqlite3")).default;
const db = new Database(process.env.DB_PATH);

const server = createServer((_req, res) => {
  res.statusCode = 404;
  res.end();
});
attachCollab(server as Parameters<typeof attachCollab>[0]);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const MESSAGE_SYNC = 0;
const REMOTE = Symbol("remote");
const WAIT_TIMEOUT_MS = 5000;
const stamp = Date.now();
const openPeers = new Set<Peer>();

after(async () => {
  for (const peer of openPeers) {
    peer.ws.terminate();
    peer.doc.destroy();
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

let callers = 0;
async function jsonRequest<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T | null; headers: Headers }> {
  callers += 1;
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": `10.77.${Math.floor(callers / 250) % 250}.${callers % 250}`,
    Origin: "http://localhost:3000",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null, headers: res.headers };
}

async function signUp(name: string, email: string) {
  const user = await signUpVerified(app, { name, email });
  return { name, email, token: user.token, id: user.id };
}

async function createDoc(token: string, docId: string, content = "") {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await jsonRequest("PUT", `/api/docs/${docId}`, token, {
    name: "collab-tickets.md",
    content,
    hash,
    baseVersion: 0,
  });
  assert.equal(res.status, 200);
}

async function share(ownerToken: string, docId: string, email: string, role: "viewer" | "editor") {
  const res = await jsonRequest<{ status: string; userId: string }>("POST", `/api/docs/${docId}/shares`, ownerToken, {
    email,
    role,
  });
  assert.equal(res.status, 200);
  return res.data?.userId ?? "";
}

function askTicket(docId: string, token?: string) {
  return jsonRequest<{ ticket?: string; expiresAt?: number; error?: string }>(
    "POST",
    `/api/docs/${encodeURIComponent(docId)}/collab-ticket`,
    token,
    {}
  );
}

async function ticketFor(docId: string, token: string): Promise<string> {
  const res = await askTicket(docId, token);
  assert.equal(res.status, 200, `expected a ticket, got ${res.status}`);
  assert.ok(res.data?.ticket);
  return res.data.ticket;
}

async function sessionId(token: string): Promise<string> {
  const session = await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${token}` }) });
  assert.ok(session?.session.id);
  return session.session.id;
}

// ── a minimal y-websocket peer: enough to sync and to see the server hang up ──

interface Peer {
  ws: WebSocket;
  doc: Y.Doc;
  closeCode: () => number | null;
  text: () => string;
  write: (value: string) => void;
  resync: () => Promise<void>;
}

async function connect(docId: string, query: string): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/collab/${encodeURIComponent(docId)}?${query}`);
  ws.binaryType = "arraybuffer";
  const doc = new Y.Doc();
  let closeCode: number | null = null;
  let syncWaiters: Array<() => void> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
  } catch (err) {
    doc.destroy();
    throw err;
  }
  ws.removeAllListeners("error");
  ws.on("error", () => {});
  ws.on("close", (code) => {
    closeCode = code;
  });
  ws.on("message", (data: ArrayBuffer) => {
    const bytes = new Uint8Array(data);
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const peek = decoding.createDecoder(bytes);
    decoding.readVarUint(peek);
    const isStep2 = decoding.readVarUint(peek) === syncProtocol.messageYjsSyncStep2;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
    if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
    if (isStep2) {
      const waiters = syncWaiters;
      syncWaiters = [];
      for (const resolve of waiters) resolve();
    }
  });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });
  const resync = async () => {
    let landed = false;
    const reply = new Promise<void>((resolve) =>
      syncWaiters.push(() => {
        landed = true;
        resolve();
      })
    );
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
    await Promise.race([reply, sleep(WAIT_TIMEOUT_MS, undefined, { ref: false })]);
    assert.ok(landed, "timed out waiting for the server's sync reply");
  };
  const peer: Peer = {
    ws,
    doc,
    closeCode: () => closeCode,
    text: () => doc.getText("default").toString(),
    write: (value) => doc.getText("default").insert(0, value),
    resync,
  };
  openPeers.add(peer);
  await resync();
  return peer;
}

const withTicket = (ticket: string) => `ticket=${encodeURIComponent(ticket)}`;
const withToken = (token: string) => `token=${encodeURIComponent(token)}`;

async function waitFor(label: string, predicate: () => boolean) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const owner = await signUp("Tia Owner", `tickets.owner.${stamp}@test.local`);
const editor = await signUp("Ed Ticket", `tickets.editor.${stamp}@test.local`);
const viewer = await signUp("Vi Ticket", `tickets.viewer.${stamp}@test.local`);
const stranger = await signUp("Stan Ticket", `tickets.stranger.${stamp}@test.local`);

// ── the route ──

test("the ticket route answers only a signed-in caller", async () => {
  const docId = `tickets-auth-${stamp}`;
  await createDoc(owner.token, docId);
  assert.equal((await askTicket(docId)).status, 401);
  assert.equal((await askTicket(docId, "not-a-token")).status, 401);
});

test("a non-member gets the same bare 404 as a document that does not exist", async () => {
  const docId = `tickets-stranger-${stamp}`;
  await createDoc(owner.token, docId);
  const refused = await askTicket(docId, stranger.token);
  const missing = await askTicket(`tickets-no-such-doc-${stamp}`, stranger.token);
  assert.equal(refused.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(refused.data, { error: "no_ticket" });
  assert.deepEqual(missing.data, refused.data, "the answer must not say whether the document exists");
});

test("the owner, an editor and a viewer each get a five-minute ticket, and only its hash is stored", async () => {
  const docId = `tickets-issue-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, editor.email, "editor");
  await share(owner.token, docId, viewer.email, "viewer");

  for (const person of [owner, editor, viewer]) {
    const before = Date.now();
    const res = await askTicket(docId, person.token);
    assert.equal(res.status, 200, `${person.name} should get a ticket`);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    const { ticket, expiresAt } = res.data as { ticket: string; expiresAt: number };
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    assert.ok(expiresAt >= before + COLLAB_TICKET_TTL_MS && expiresAt <= Date.now() + COLLAB_TICKET_TTL_MS);

    const rows = db.prepare("SELECT * FROM collab_tickets WHERE user_id = ? AND doc_id = ?").all(person.id, docId) as Array<
      Record<string, unknown>
    >;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ticket_hash, createHash("sha256").update(ticket).digest("hex"));
    assert.equal(rows[0].session_id, await sessionId(person.token));
    assert.ok(!Object.values(rows[0]).includes(ticket), "the ticket itself is never stored");
  }
});

test("issuing past the per-minute cap answers 429, and expired tickets are cleared on the way in", async () => {
  const user = await signUp("Busy Ticket", `tickets.busy.${stamp}@test.local`);
  const docId = `tickets-rate-${stamp}`;
  await createDoc(user.token, docId);
  const sid = await sessionId(user.token);

  const old = issueCollabTicket(docId, user.id, sid, Date.now() - COLLAB_TICKET_TTL_MS - 1000);
  assert.ok(old);
  for (let i = 0; i < COLLAB_TICKETS_PER_MINUTE; i++) assert.ok(issueCollabTicket(docId, user.id, sid));
  const stale = db
    .prepare("SELECT COUNT(*) AS n FROM collab_tickets WHERE ticket_hash = ?")
    .get(createHash("sha256").update(old.ticket).digest("hex")) as { n: number };
  assert.equal(stale.n, 0, "an expired ticket does not outlive the next issue");

  const res = await askTicket(docId, user.token);
  assert.equal(res.status, 429);
  assert.deepEqual(res.data, { error: "rate_limited" });
  assert.equal(res.headers.get("retry-after"), "60");
});

// ── the socket ──

test("a socket opened with a ticket syncs both ways, and the ticket is reusable", async () => {
  const docId = `tickets-sync-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, editor.email, "editor");

  const ownerTicket = await ticketFor(docId, owner.token);
  const ownerPeer = await connect(docId, withTicket(ownerTicket));
  const editorPeer = await connect(docId, withTicket(await ticketFor(docId, editor.token)));

  editorPeer.write("through-a-ticket ");
  await editorPeer.resync();
  await waitFor("the editor's text to reach the owner", () => ownerPeer.text().includes("through-a-ticket"));

  // y-websocket reconnects with the URL it already has.
  const again = await connect(docId, withTicket(ownerTicket));
  assert.ok(again.text().includes("through-a-ticket"));
});

test("a ticket opens only the document it was issued for", async () => {
  const docA = `tickets-doc-a-${stamp}`;
  const docB = `tickets-doc-b-${stamp}`;
  await createDoc(owner.token, docA);
  await createDoc(owner.token, docB);
  const ticketA = await ticketFor(docA, owner.token);
  await assert.rejects(connect(docB, withTicket(ticketA)), /401/, "even for someone who may read the other doc");
  await assert.rejects(connect(docA, withTicket("forged-ticket")), /401/);
  await assert.rejects(connect(docA, "ticket="), /401/);
});

test("an expired ticket is refused", async () => {
  const docId = `tickets-expired-${stamp}`;
  await createDoc(owner.token, docId);
  const ticket = await ticketFor(docId, owner.token);
  db.prepare("UPDATE collab_tickets SET expires_at = ? WHERE ticket_hash = ?").run(
    Date.now() - 1,
    createHash("sha256").update(ticket).digest("hex")
  );
  await assert.rejects(connect(docId, withTicket(ticket)), /401/);
});

test("a ticket whose sign-in has ended is refused, though the person's share remains", async () => {
  const user = await signUp("Ended Ticket", `tickets.ended.${stamp}@test.local`);
  const docId = `tickets-ended-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, user.email, "editor");
  const ticket = await ticketFor(docId, user.token);
  db.prepare('DELETE FROM "session" WHERE id = ?').run(await sessionId(user.token));
  await assert.rejects(connect(docId, withTicket(ticket)), /401/);
  assert.ok(db.prepare("SELECT 1 FROM shares WHERE doc_id = ? AND user_id = ?").get(docId, user.id));
});

test("a ticket for someone whose share has since gone is refused", async () => {
  const docId = `tickets-unshared-${stamp}`;
  await createDoc(owner.token, docId);
  const editorId = await share(owner.token, docId, editor.email, "editor");
  const ticket = await ticketFor(docId, editor.token);
  db.prepare("DELETE FROM shares WHERE doc_id = ? AND user_id = ?").run(docId, editorId);
  await assert.rejects(connect(docId, withTicket(ticket)), /401/);
});

test("removing a share hangs up a member who joined with a ticket", async () => {
  const docId = `tickets-remove-share-${stamp}`;
  await createDoc(owner.token, docId);
  const editorId = await share(owner.token, docId, editor.email, "editor");
  const ticket = await ticketFor(docId, editor.token);
  const editorPeer = await connect(docId, withTicket(ticket));

  const removed = await jsonRequest("DELETE", `/api/docs/${docId}/shares/${encodeURIComponent(editorId)}`, owner.token);
  assert.equal(removed.status, 200);
  await waitFor("the removed member's socket to close", () => editorPeer.closeCode() === 4403);
  await assert.rejects(connect(docId, withTicket(ticket)), /401/, "and the same ticket cannot bring them back");
});

test("a ticket-opened socket is bound to its sign-in: deleting the session stops its writes", async () => {
  const user = await signUp("Bound Ticket", `tickets.bound.${stamp}@test.local`);
  const docId = `tickets-bound-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, user.email, "editor");
  const peer = await connect(docId, withTicket(await ticketFor(docId, user.token)));
  const ownerPeer = await connect(docId, withTicket(await ticketFor(docId, owner.token)));

  db.prepare('DELETE FROM "session" WHERE id = ?').run(await sessionId(user.token));
  peer.write("after-sign-out ");
  await waitFor("the socket of the ended sign-in to close", () => peer.closeCode() === 4403);
  await ownerPeer.resync();
  assert.ok(!ownerPeer.text().includes("after-sign-out"));
});

test("a ticket is the only credential read when a URL carries both", async () => {
  const docId = `tickets-both-${stamp}`;
  await createDoc(owner.token, docId);
  await assert.rejects(connect(docId, `ticket=forged&${withToken(owner.token)}`), /401/);
});

test("the legacy ?token= path still works, and is counted without naming anyone", async () => {
  const docId = `tickets-legacy-${stamp}`;
  await createDoc(owner.token, docId);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const legacy = await connect(docId, withToken(owner.token));
    legacy.write("legacy-write ");
    await legacy.resync();
    await connect(docId, withTicket(await ticketFor(docId, owner.token)));
  } finally {
    console.log = log;
  }
  assert.deepEqual(
    lines.filter((line) => line.startsWith("collab:")),
    ["collab: legacy token connection"],
    "one line for the token connection, none for the ticket one"
  );
  for (const line of lines) {
    for (const secret of [owner.token, docId, owner.id]) assert.ok(!line.includes(secret), `log line names ${secret}`);
  }
  await assert.rejects(connect(docId, withToken(stranger.token)), /401/, "and it still checks access");
});
