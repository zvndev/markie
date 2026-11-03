// A live room survives the server restarting, the way every Kamal deploy
// restarts it: the real server process, stopped with SIGTERM and started again
// on the same database. A live edit reaches the room (the update log) at once
// and the stored copy only on a client's next push, so a deploy between the
// two used to leave everyone who opened the document afterwards looking at a
// false "someone saved this outside the live session" conflict. The client
// half of the fix reads a record the room keeps in its meta map
// (src/lib/live-snapshot.ts rule 7); this proves the room, that record
// included, is still there after the restart, and the stored copy untouched.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { signUpVerified, type TestApp } from "./test-users.ts";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const MESSAGE_SYNC = 0;
const REMOTE = Symbol("remote");

const dbPath = join(mkdtempSync(join(tmpdir(), "markie-collab-restart-")), "markie.db");
// test-users.ts marks addresses verified straight in this database.
process.env.DB_PATH = dbPath;

const children: ReturnType<typeof spawn>[] = [];
const sockets: WebSocket[] = [];
after(() => {
  for (const ws of sockets) ws.terminate();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function envFor(port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "development",
    PORT: String(port),
    DB_PATH: dbPath,
    BETTER_AUTH_URL: `http://localhost:${port}`,
    BETTER_AUTH_SECRET: "markie-collab-restart-test-secret-32-plus",
    MARKIE_MAIL_LOG: "1",
    MARKIE_WEB_DIST: "./.no-web-dist-in-tests",
    ENABLE_CRONS: "false",
  };
}

async function boot() {
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: envFor(port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const deadline = Date.now() + 20_000;
  while (!output.includes("markie-api listening")) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server did not start:\n${output}`);
    await sleep(25);
  }
  const app: TestApp = {
    request: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
  };
  return { port, app, child, exited, output: () => output };
}

async function api<T>(server: { port: number }, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://localhost:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

interface Peer {
  doc: Y.Doc;
  ws: WebSocket;
  resync(): Promise<void>;
}

async function joinRoom(server: { port: number }, docId: string, token: string): Promise<Peer> {
  const ticket = await api<{ ticket: string }>(server, "POST", `/api/docs/${docId}/collab-ticket`, token);
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/collab/${encodeURIComponent(docId)}?ticket=${encodeURIComponent(ticket.data.ticket)}`);
  sockets.push(ws);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("error", () => {});
  const doc = new Y.Doc();
  let waiters: Array<() => void> = [];
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
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve();
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
    const reply = new Promise<void>((resolve) => waiters.push(() => { landed = true; resolve(); }));
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
    await Promise.race([reply, sleep(5000, undefined, { ref: false })]);
    assert.ok(landed, "timed out waiting for the server's sync reply");
  };
  await resync();
  return { doc, ws, resync };
}

const paragraphText = (doc: Y.Doc) =>
  doc.getXmlFragment("default").toArray().map((node) => (node as Y.XmlElement).toArray().map((t) => (t as Y.XmlText).toString()).join("")).join("\n");

test("a live edit and the room's stored-copy record survive a SIGTERM restart; the stored copy is untouched", async () => {
  // The auth schema, as the container's entrypoint runs it before the server.
  const migrated = spawnSync(process.execPath, ["--experimental-strip-types", "src/migrate.ts"], {
    cwd: SERVER_DIR,
    env: envFor(0),
    encoding: "utf8",
  });
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);

  const first = await boot();
  const stamp = Date.now();
  const owner = await signUpVerified(first.app, { name: "Olga Owner", email: `restart.owner.${stamp}@test.local` });
  const bob = await signUpVerified(first.app, { name: "Bob Editor", email: `restart.bob.${stamp}@test.local` });

  const docId = `restart-${stamp}`;
  const stored = "Hello\n";
  const created = await api(first, "PUT", `/api/docs/${docId}`, owner.token, {
    name: "restart.md",
    content: stored,
    hash: createHash("sha256").update(stored, "utf8").digest("hex"),
    baseVersion: 0,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const shared = await api(first, "POST", `/api/docs/${docId}/shares`, owner.token, { email: bob.email, role: "editor" });
  assert.equal(shared.status, 200, JSON.stringify(shared.data));

  // The owner seeds the room from the stored copy, with the record a client
  // keeps of the stored copy the room says (version 1).
  const ownerPeer = await joinRoom(first, docId, owner.token);
  ownerPeer.doc.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("Hello")]);
    ownerPeer.doc.getXmlFragment("default").insert(0, [paragraph]);
    ownerPeer.doc.getMap("meta").set("schemaVersion", 1);
    ownerPeer.doc.getMap("meta").set("storedCopy", { version: 1, hash: "fingerprint-of-v1", next: null });
  });
  await ownerPeer.resync();

  // Bob types a word. Nobody pushes the stored copy before the deploy.
  const bobPeer = await joinRoom(first, docId, bob.token);
  assert.equal(paragraphText(bobPeer.doc), "Hello");
  const text = (bobPeer.doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  text.insert(text.length, " Bob");
  await bobPeer.resync();

  // The deploy: SIGTERM, then a new process on the same database.
  first.child.kill("SIGTERM");
  assert.equal(await first.exited, 0, first.output());
  for (const ws of sockets) ws.terminate();

  const second = await boot();
  const reader = await joinRoom(second, docId, bob.token);
  assert.equal(paragraphText(reader.doc), "Hello Bob", "the live edit is still in the room");
  assert.deepEqual(reader.doc.getMap("meta").get("storedCopy"), { version: 1, hash: "fingerprint-of-v1", next: null });

  // The stored copy is the version the record names, so the room is simply
  // ahead of it: the next writer pushes instead of raising a conflict.
  const doc = await api<{ doc: { version: number; content: string } }>(second, "GET", `/api/docs/${docId}`, bob.token);
  assert.equal(doc.status, 200);
  assert.equal(doc.data.doc.version, 1);
  assert.equal(doc.data.doc.content, stored);

  second.child.kill("SIGTERM");
  assert.equal(await second.exited, 0, second.output());
});
