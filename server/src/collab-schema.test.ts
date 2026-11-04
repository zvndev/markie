// The room schema gate end to end (collab-schema.ts): through the real ticket
// route and real upgraded sockets, because what matters is which builds the
// server lets into a room, and when it shows them out.
//
// "Old" is a build from before math nodes: its ticket request says nothing
// (`{}`), or it has no ticket at all and comes in on its token. "New" says
// `{ schema: 2 }`.
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

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-collab-schema-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-collab-schema-test-secret-32-plus";
process.env.MARKIE_SITE_URL = "https://markie.test";
process.env.MARKIE_NO_LISTEN = "1";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();

const { app } = await import("./index.ts");
const { attachCollab, roomSchemaState } = await import("./collab.ts");
const schema = await import("./collab-schema.ts");
const { issueCollabTicket } = await import("./collab-tickets.ts");
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
const stamp = Date.now();
const open = new Set<Peer>();

after(async () => {
  for (const peer of open) {
    peer.ws.terminate();
    peer.doc.destroy();
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

let callers = 0;
async function jsonRequest<T>(method: string, path: string, token?: string, body?: unknown) {
  callers += 1;
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": `10.78.${Math.floor(callers / 250) % 250}.${callers % 250}`,
    Origin: "http://localhost:3000",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

async function signUp(name: string, email: string) {
  const user = await signUpVerified(app, { name, email });
  return { name, email, token: user.token, id: user.id };
}

async function createDoc(token: string, docId: string, content: string) {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await jsonRequest("PUT", `/api/docs/${docId}`, token, { name: "schema.md", content, hash, baseVersion: 0 });
  assert.equal(res.status, 200);
}

async function share(ownerToken: string, docId: string, email: string) {
  const res = await jsonRequest("POST", `/api/docs/${docId}/shares`, ownerToken, { email, role: "editor" });
  assert.equal(res.status, 200);
}

const askTicket = (docId: string, token: string, body: unknown) =>
  jsonRequest<{ ticket?: string; error?: string }>("POST", `/api/docs/${encodeURIComponent(docId)}/collab-ticket`, token, body);

async function ticket(docId: string, token: string, body: unknown): Promise<string> {
  const res = await askTicket(docId, token, body);
  assert.equal(res.status, 200, `expected a ticket, got ${res.status}`);
  return res.data!.ticket!;
}

interface Peer {
  ws: WebSocket;
  doc: Y.Doc;
  closeCode: () => number | null;
  /** Every update the server sent this socket, as it arrived. */
  received: Uint8Array[];
}

// A minimal y-websocket peer over the rich fragment.
async function connect(docId: string, query: string): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/collab/${encodeURIComponent(docId)}?${query}`);
  ws.binaryType = "arraybuffer";
  const doc = new Y.Doc();
  let closeCode: number | null = null;
  const received: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("error", () => {});
  ws.on("close", (code) => {
    closeCode = code;
  });
  ws.on("message", (data: ArrayBuffer) => {
    const bytes = new Uint8Array(data);
    received.push(bytes);
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
    if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
  });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || ws.readyState !== ws.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  ws.send(encoding.toUint8Array(encoder));
  const peer = { ws, doc, closeCode: () => closeCode, received };
  open.add(peer);
  await sleep(80);
  return peer;
}

const withTicket = (t: string) => `ticket=${encodeURIComponent(t)}`;

async function waitFor(label: string, predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  return p;
}
function withFormula(): Y.XmlElement {
  const p = new Y.XmlElement("paragraph");
  const math = new Y.XmlElement("mathInline");
  math.setAttribute("source", "$x^2$");
  p.insert(0, [new Y.XmlText("See "), math]);
  return p;
}
const fragmentHasMath = (doc: Y.Doc) => JSON.stringify(doc.getXmlFragment("default").toJSON()).includes("mathInline");

// A room log as some client wrote it, straight into the update log.
function storeRoom(docId: string, build: (doc: Y.Doc) => void) {
  const doc = new Y.Doc();
  build(doc);
  db.prepare("INSERT INTO doc_updates (doc_id, seq, update_data) VALUES (?, 1, ?)").run(docId, Buffer.from(Y.encodeStateAsUpdate(doc)));
  doc.destroy();
}

const owner = await signUp("Sam Schema", `schema.owner.${stamp}@test.local`);
const oldPeer = await signUp("Olly Old", `schema.old.${stamp}@test.local`);

test("a ticket request that says nothing is a build from before the gate", () => {
  assert.equal(schema.clientSchemaFrom({}), 1);
  assert.equal(schema.clientSchemaFrom(null), 1);
  assert.equal(schema.clientSchemaFrom({ schema: "2" }), 1);
  assert.equal(schema.clientSchemaFrom({ schema: 0 }), 1);
  assert.equal(schema.clientSchemaFrom({ schema: 2 }), 2);
});

test("an old build gets no ticket for a room holding a formula, and opens its own copy; a new build does", async () => {
  const docId = `schema-math-${stamp}`;
  await createDoc(owner.token, docId, "See $x^2$\n");
  await share(owner.token, docId, oldPeer.email);
  storeRoom(docId, (doc) => doc.getXmlFragment("default").insert(0, [withFormula()]));

  const refused = await askTicket(docId, oldPeer.token, {});
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.data, { error: "room_needs_newer_markie" });
  assert.equal((await askTicket(docId, owner.token, { schema: 2 })).status, 200);
});

test("a room stamped 2 by its meta map is closed to old builds even before any formula is read", async () => {
  const docId = `schema-stamped-${stamp}`;
  await createDoc(owner.token, docId, "Plain.\n");
  await share(owner.token, docId, oldPeer.email);
  storeRoom(docId, (doc) => {
    doc.getXmlFragment("default").insert(0, [paragraph("Plain.")]);
    doc.getMap("meta").set("schemaVersion", 2);
  });
  assert.equal((await askTicket(docId, oldPeer.token, {})).status, 409);
});

test("a plain room stays open to old builds", async () => {
  const docId = `schema-plain-${stamp}`;
  await createDoc(owner.token, docId, "Plain.\n");
  await share(owner.token, docId, oldPeer.email);
  storeRoom(docId, (doc) => {
    doc.getXmlFragment("default").insert(0, [paragraph("Plain.")]);
    doc.getMap("meta").set("schemaVersion", 1);
  });
  const old = await connect(docId, withTicket(await ticket(docId, oldPeer.token, {})));
  await waitFor("the old build synced", () => old.doc.getXmlFragment("default").length > 0);
  assert.equal(old.closeCode(), null);
});

test("the first formula shows old builds out before it reaches them, and nothing they send after goes in", async () => {
  const docId = `schema-raise-${stamp}`;
  await createDoc(owner.token, docId, "Plain.\n");
  await share(owner.token, docId, oldPeer.email);
  storeRoom(docId, (doc) => {
    doc.getXmlFragment("default").insert(0, [paragraph("Plain.")]);
    doc.getMap("meta").set("schemaVersion", 1);
  });
  const old = await connect(docId, withTicket(await ticket(docId, oldPeer.token, {})));
  const fresh = await connect(docId, withTicket(await ticket(docId, owner.token, { schema: 2 })));
  await waitFor("both synced", () => old.doc.getXmlFragment("default").length > 0 && fresh.doc.getXmlFragment("default").length > 0);
  assert.equal(roomSchemaState(docId), 1);

  // The new build adds a formula and does not even stamp the room: the
  // server reads the formula from the update itself.
  fresh.doc.getXmlFragment("default").insert(1, [withFormula()]);
  await waitFor("the old build shown out", () => old.closeCode() !== null);
  assert.equal(old.closeCode(), 4403, "a build from before the gate stops only on 4403");
  assert.equal(fragmentHasMath(old.doc), false, "the old build never received the formula");
  assert.equal(roomSchemaState(docId), 2);
  assert.equal(fresh.closeCode(), null);

  // And it cannot come back: no ticket, and a ticket it already holds is
  // shown out at the door.
  assert.equal((await askTicket(docId, oldPeer.token, {})).status, 409);
});

test("a ticket issued before the room moved on is turned away at the socket", async () => {
  const docId = `schema-stale-ticket-${stamp}`;
  await createDoc(owner.token, docId, "Plain.\n");
  await share(owner.token, docId, oldPeer.email);
  const oldTicket = await ticket(docId, oldPeer.token, {});
  const fresh = await connect(docId, withTicket(await ticket(docId, owner.token, { schema: 2 })));
  fresh.doc.getXmlFragment("default").insert(0, [withFormula()]);
  await waitFor("the room holds the formula", () => roomSchemaState(docId) === 2);
  const late = await connect(docId, withTicket(oldTicket));
  await waitFor("the late old build shown out", () => late.closeCode() !== null);
  assert.equal(late.closeCode(), 4403);
  assert.equal(fragmentHasMath(late.doc), false);
});

test("a build from before tickets, on its token, is an old build", async () => {
  const docId = `schema-token-${stamp}`;
  await createDoc(owner.token, docId, "See $x^2$\n");
  await share(owner.token, docId, oldPeer.email);
  storeRoom(docId, (doc) => doc.getXmlFragment("default").insert(0, [withFormula()]));
  const legacy = await connect(docId, `token=${encodeURIComponent(oldPeer.token)}`);
  await waitFor("the token build shown out", () => legacy.closeCode() !== null);
  assert.equal(legacy.closeCode(), 4403);
  assert.equal(fragmentHasMath(legacy.doc), false);
});

test("a new build meets a room a newer build stamped: no ticket, and 4426 at the socket", async () => {
  const docId = `schema-future-${stamp}`;
  await createDoc(owner.token, docId, "Plain.\n");
  storeRoom(docId, (doc) => {
    doc.getXmlFragment("default").insert(0, [paragraph("Plain.")]);
    doc.getMap("meta").set("schemaVersion", 3);
  });
  assert.equal((await askTicket(docId, owner.token, { schema: 2 })).status, 409);
  // A ticket this build held from before the newer build stamped the room.
  const session = await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${owner.token}` }) });
  const held = issueCollabTicket(docId, owner.id, session!.session.id, Date.now(), 2)!.ticket;
  const peer = await connect(docId, withTicket(held));
  await waitFor("shown out", () => peer.closeCode() !== null);
  assert.equal(peer.closeCode(), 4426);
});

test("text rooms are schema 1: never closed to old builds", () => {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "$x$ in a text file");
  doc.getMap("meta").set("schemaVersion", 1);
  assert.equal(schema.schemaOfRoom(doc), 1);
  assert.equal(schema.updateAddsMath(Y.encodeStateAsUpdate(doc)), false);
});
