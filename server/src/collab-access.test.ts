// Authorization at the collaboration socket, not at the pure helper: these
// tests drive attachCollab over a real HTTP upgrade with real bearer sessions,
// because join gating, per-message write gating, revocation and presence
// identity all live there and none of it is reachable from a unit test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Hono } from "hono";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { getMigrations } from "better-auth/db/migration";
import { signUpVerified } from "./test-users.ts";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-collab-access-")), "t.db");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-collab-access-test-secret-32-plus-chars";
process.env.MARKIE_SITE_URL = "https://markie.test";

const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) {
  await runMigrations();
}

const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { ACCESS_CACHE_MS, attachCollab, seedLockState } = await import("./collab.ts");
const Database = (await import("better-sqlite3")).default;

const db = new Database(process.env.DB_PATH);

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/docs", docs);
app.route("/api/docs", shares);

// attachCollab only claims the "upgrade" event, so what sits under it is
// irrelevant here.
const server = createServer((_req, res) => {
  res.statusCode = 404;
  res.end();
});
attachCollab(server as Parameters<typeof attachCollab>[0]);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const REMOTE = Symbol("remote");
const WAIT_TIMEOUT_MS = 5000;
const stamp = Date.now();
const openPeers = new Set<Peer>();

after(async () => {
  for (const peer of openPeers) {
    peer.ws.terminate();
    peer.awareness.destroy(); // its outdated-state interval outlives the socket
    peer.doc.destroy();
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

// ── HTTP helpers (same shape as share-routes.test.ts) ──

async function jsonRequest<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: T | null; headers: Headers }> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": "127.0.0.1",
    Origin: "http://localhost:3000",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as T | null,
    headers: res.headers,
  };
}

async function signUp(name: string, email: string) {
  const user = await signUpVerified(app, { name, email });
  return { name, email, token: user.token, id: user.id };
}

async function createDoc(token: string, docId: string, body = "# Collab access\n") {
  const content = body;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const res = await jsonRequest("PUT", `/api/docs/${docId}`, token, {
    name: "collab-access.md",
    content,
    hash,
    baseVersion: 0,
  });
  assert.equal(res.status, 200);
}

async function share(
  ownerToken: string,
  docId: string,
  email: string,
  role: "viewer" | "editor"
): Promise<string> {
  const res = await jsonRequest<{ status: string; userId: string }>(
    "POST",
    `/api/docs/${docId}/shares`,
    ownerToken,
    { email, role }
  );
  assert.equal(res.status, 200);
  assert.equal(res.data?.status, "member");
  return res.data?.userId ?? "";
}

function revokeInDb(docId: string, userId: string) {
  const res = db
    .prepare("DELETE FROM shares WHERE doc_id = ? AND user_id = ?")
    .run(docId, userId);
  assert.equal(res.changes, 1, "expected a share row to revoke");
}

// ── a minimal y-websocket client: enough to sync, and to lie about presence ──

interface Peer {
  ws: WebSocket;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  closeCode: () => number | null;
  text: () => string;
  write: (value: string) => void;
  sendPresence: (state: Record<string, unknown>) => void;
  // Round-trips a sync step 1 and resolves once the server's step 2 lands.
  // Every "did the server accept that?" assertion hangs off this rather than a
  // sleep: the reply proves the server finished everything sent before it.
  resync: () => Promise<void>;
}

async function connect(docId: string, token: string): Promise<Peer> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/collab/${encodeURIComponent(docId)}?token=${encodeURIComponent(token)}`
  );
  ws.binaryType = "arraybuffer";
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  let closeCode: number | null = null;
  let syncWaiters: Array<() => void> = [];

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
  } catch (err) {
    // A refused upgrade still leaves an Awareness behind, and its interval is
    // enough to keep the test process alive forever.
    awareness.destroy();
    doc.destroy();
    throw err;
  }
  ws.removeAllListeners("error");
  ws.on("error", () => {}); // an abrupt close must not take the process down
  ws.on("close", (code) => {
    closeCode = code;
  });

  ws.on("message", (data: ArrayBuffer) => {
    const bytes = new Uint8Array(data);
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) === MESSAGE_SYNC) {
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
    } else {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        REMOTE
      );
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
    // The server opens with its own step 1, which only asks for our state; the
    // real provider sends this one to pull the room's content down.
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
    // A regression that stops answering has to fail the test, not hang the run.
    await Promise.race([reply, sleep(WAIT_TIMEOUT_MS, undefined, { ref: false })]);
    assert.ok(landed, "timed out waiting for the server's sync reply");
  };

  const peer: Peer = {
    ws,
    doc,
    awareness,
    closeCode: () => closeCode,
    text: () => doc.getText("default").toString(),
    write: (value) => doc.getText("default").insert(0, value),
    sendPresence: (state) => {
      awareness.setLocalState(state);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID])
      );
      ws.send(encoding.toUint8Array(encoder));
    },
    resync,
  };
  openPeers.add(peer);
  await resync();
  return peer;
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const owner = await signUp("Olga Owner", `collab.owner.${stamp}@test.local`);
const editor = await signUp("Eddie Editor", `collab.editor.${stamp}@test.local`);
const viewer = await signUp("Vic Viewer", `collab.viewer.${stamp}@test.local`);
const stranger = await signUp("Sam Stranger", `collab.stranger.${stamp}@test.local`);

test("a user with no access cannot join the room", async () => {
  const docId = `collab-stranger-${stamp}`;
  await createDoc(owner.token, docId);

  await assert.rejects(
    connect(docId, stranger.token),
    /401/,
    "an authenticated stranger must not reach the room"
  );
  await assert.rejects(connect(docId, "not-a-token"), /401/, "a forged token must not reach the room");
  await assert.rejects(connect(docId, ""), /401/, "an absent token must not reach the room");
});

test("a viewer can join but cannot write a sync update", async () => {
  const docId = `collab-viewer-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, viewer.email, "viewer");

  const ownerPeer = await connect(docId, owner.token);
  const viewerPeer = await connect(docId, viewer.token);

  viewerPeer.write("viewer-write ");
  await viewerPeer.resync(); // the server has now handled that update
  await ownerPeer.resync(); // and told the owner what it really holds

  assert.ok(!ownerPeer.text().includes("viewer-write"), "viewer text must not reach the room");
  assert.equal(viewerPeer.closeCode(), null, "a viewer keeps its read-only socket");
});

test("an editor can write into the room", async () => {
  const docId = `collab-editor-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, editor.email, "editor");

  // Join order matters now: the room is empty and the doc is not, so the first
  // editor through the door holds the seed lock. Letting the editor take it
  // keeps this test about write permission rather than about the lock.
  const editorPeer = await connect(docId, editor.token);
  const ownerPeer = await connect(docId, owner.token);

  editorPeer.write("editor-write ");
  await editorPeer.resync();
  await ownerPeer.resync();

  assert.ok(ownerPeer.text().includes("editor-write"), "an editor's update belongs in the room");
});

test("a revoked editor's open socket can no longer write", async () => {
  const docId = `collab-revoked-write-${stamp}`;
  await createDoc(owner.token, docId);
  const editorId = await share(owner.token, docId, editor.email, "editor");

  const editorPeer = await connect(docId, editor.token); // seeder, see above
  const ownerPeer = await connect(docId, owner.token);
  editorPeer.write("before-revoke ");
  await editorPeer.resync();
  await ownerPeer.resync();
  assert.ok(ownerPeer.text().includes("before-revoke"), "the editor could write before revocation");

  // Revoked straight in the database, so this exercises the per-message access
  // check rather than the socket hang-up in disconnectUser().
  revokeInDb(docId, editorId);

  editorPeer.write("after-revoke ");
  await waitFor("the revoked socket to be hung up on", () => editorPeer.closeCode() !== null);
  await ownerPeer.resync();
  assert.ok(
    !ownerPeer.text().includes("after-revoke"),
    "a revoked editor must not write through an already-open socket"
  );
});

test("a revoked collaborator stops receiving updates without saying a word", async () => {
  const docId = `collab-revoked-read-${stamp}`;
  await createDoc(owner.token, docId);
  const viewerId = await share(owner.token, docId, viewer.email, "viewer");

  const ownerPeer = await connect(docId, owner.token);
  const viewerPeer = await connect(docId, viewer.token);
  ownerPeer.write("before-revoke ");
  await waitFor("the first edit to reach the viewer", () =>
    viewerPeer.text().includes("before-revoke")
  );

  revokeInDb(docId, viewerId);
  // This socket never speaks again, so nothing refreshes its cached level
  // except the cache expiring. Wait that out rather than weaken the assertion.
  await sleep(ACCESS_CACHE_MS + 250);

  ownerPeer.write("after-revoke ");
  // The fan-out closes the socket in the same pass that skips it, and anything
  // actually sent to that socket would have arrived ahead of the close frame.
  await waitFor("the revoked socket to be hung up on", () => viewerPeer.closeCode() !== null);
  assert.ok(
    !viewerPeer.text().includes("after-revoke"),
    "a revoked collaborator must stop receiving the room's updates"
  );
});

test("removing a share hangs up the member's open socket", async () => {
  const docId = `collab-remove-share-${stamp}`;
  await createDoc(owner.token, docId);
  const editorId = await share(owner.token, docId, editor.email, "editor");

  const editorPeer = await connect(docId, editor.token);
  const removed = await jsonRequest(
    "DELETE",
    `/api/docs/${docId}/shares/${encodeURIComponent(editorId)}`,
    owner.token
  );
  assert.equal(removed.status, 200);

  await waitFor("the removed member's socket to close", () => editorPeer.closeCode() !== null);
  await assert.rejects(connect(docId, editor.token), /401/, "and they cannot come back");
});

test("soft-deleting a doc closes the whole room", async () => {
  const docId = `collab-deleted-doc-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, editor.email, "editor");

  const ownerPeer = await connect(docId, owner.token);
  const editorPeer = await connect(docId, editor.token);

  const deleted = await jsonRequest("DELETE", `/api/docs/${docId}`, owner.token);
  assert.equal(deleted.status, 200);

  await waitFor("the owner's socket to close", () => ownerPeer.closeCode() !== null);
  await waitFor("the member's socket to close", () => editorPeer.closeCode() !== null);
});

test("awareness from a viewer cannot claim another user's identity", async () => {
  const docId = `collab-awareness-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, viewer.email, "viewer");

  const ownerPeer = await connect(docId, owner.token);
  const viewerPeer = await connect(docId, viewer.token);
  const viewerClientId = viewerPeer.awareness.clientID;

  viewerPeer.sendPresence({
    user: { name: owner.name, color: "#000000" },
    cursor: { anchor: 3, head: 7 },
  });

  await waitFor("the owner to see the viewer's presence", () =>
    ownerPeer.awareness.getStates().has(viewerClientId)
  );
  const seen = ownerPeer.awareness.getStates().get(viewerClientId) as {
    user: { name: string; color: string };
    cursor: { anchor: number; head: number };
  };
  assert.equal(seen.user.name, viewer.name, "presence must carry the authenticated name");
  assert.notEqual(seen.user.color, "#000000", "presence must not carry a client-chosen colour");
  assert.deepEqual(seen.cursor, { anchor: 3, head: 7 }, "the cursor itself is still the client's");
});


// ── seed lock: docs.content and doc_updates are stored independently, so a doc
// shared as a snapshot opens into an empty room that somebody has to seed ──

test("only the first editor may seed a room that has no updates yet", async () => {
  const docId = `collab-seed-lock-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, editor.email, "editor");

  const ownerPeer = await connect(docId, owner.token); // first editor in, seeder
  const editorPeer = await connect(docId, editor.token);
  assert.deepEqual(seedLockState(docId), { seedPending: true, seeder: owner.id });

  editorPeer.write("racing-seed ");
  await editorPeer.resync();
  await ownerPeer.resync();
  assert.ok(
    !ownerPeer.text().includes("racing-seed"),
    "a second editor must not seed the room alongside the seeder"
  );

  ownerPeer.write("real-seed ");
  await ownerPeer.resync();
  await waitFor("the seed to reach the other editor", () =>
    editorPeer.text().includes("real-seed")
  );
  assert.deepEqual(
    seedLockState(docId),
    { seedPending: false, seeder: null },
    "the first stored update releases the lock"
  );

  // A dropped update leaves that client's own doc ahead of the room, and Yjs
  // will not integrate later edits that sit on top of the item the server never
  // saw. Reconnecting is what the real client does with a room it lost, so the
  // "editing works again" half of this is asserted from a fresh socket.
  const rejoined = await connect(docId, editor.token);
  rejoined.write("after-seed ");
  await rejoined.resync();
  await ownerPeer.resync();
  assert.ok(
    ownerPeer.text().includes("after-seed"),
    "once the room is seeded every editor writes normally"
  );
});

test("a metadata-only update does not release the seed lock", async () => {
  const docId = `collab-seed-meta-only-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, editor.email, "editor");

  const ownerPeer = await connect(docId, owner.token); // seeder
  const editorPeer = await connect(docId, editor.token);
  assert.deepEqual(seedLockState(docId), { seedPending: true, seeder: owner.id });

  // The client stamps a schemaVersion into the meta map when it seeds. Sent
  // as its own update ahead of the content, that stamp carries no document —
  // the lock must hold until something readable actually lands.
  ownerPeer.doc.getMap("meta").set("schemaVersion", 1);
  await ownerPeer.resync();
  assert.deepEqual(
    seedLockState(docId),
    { seedPending: true, seeder: owner.id },
    "a stamp with no content must not open the room"
  );

  editorPeer.write("meta-race ");
  await editorPeer.resync();
  await ownerPeer.resync();
  assert.ok(
    !ownerPeer.text().includes("meta-race"),
    "the lock still blocks the racing editor after a metadata-only update"
  );

  // The seeder leaves after the stamp but before the text. The stored
  // metadata update must not make a reborn room believe it was seeded.
  ownerPeer.ws.close();
  editorPeer.ws.close();
  await waitFor("the room to be torn down", () => seedLockState(docId) === null);
  const rejoined = await connect(docId, editor.token);
  assert.deepEqual(
    seedLockState(docId),
    { seedPending: true, seeder: editor.id },
    "a room holding only metadata still needs its seed"
  );

  rejoined.write("real-content ");
  await rejoined.resync();
  assert.deepEqual(
    seedLockState(docId),
    { seedPending: false, seeder: null },
    "the first update carrying content releases the lock"
  );
});

test("the seed passes to the next editor when the seeder leaves", async () => {
  const docId = `collab-seed-handoff-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, editor.email, "editor");

  const ownerPeer = await connect(docId, owner.token); // seeder
  const editorPeer = await connect(docId, editor.token);
  assert.deepEqual(seedLockState(docId), { seedPending: true, seeder: owner.id });

  ownerPeer.ws.close();
  await waitFor("the seed to be handed to the remaining editor", () => {
    const state = seedLockState(docId);
    return !!state && state.seedPending && state.seeder === editor.id;
  });

  editorPeer.write("inherited-seed ");
  await editorPeer.resync();
  const witness = await connect(docId, owner.token);
  assert.ok(
    witness.text().includes("inherited-seed"),
    "the inheriting editor may seed the room"
  );
});

test("a viewer never holds the seed", async () => {
  const docId = `collab-seed-viewer-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, viewer.email, "viewer");
  await share(owner.token, docId, editor.email, "editor");

  const viewerPeer = await connect(docId, viewer.token);
  assert.deepEqual(
    seedLockState(docId),
    { seedPending: true, seeder: null },
    "a room of viewers waits for an editor rather than electing one"
  );

  const editorPeer = await connect(docId, editor.token);
  assert.deepEqual(seedLockState(docId), { seedPending: true, seeder: editor.id });

  editorPeer.write("editor-seed ");
  await editorPeer.resync();
  await waitFor("the seed to reach the viewer", () =>
    viewerPeer.text().includes("editor-seed")
  );
});

test("a doc with no content is never seed locked", async () => {
  const docId = `collab-seed-empty-doc-${stamp}`;
  await createDoc(owner.token, docId, "");
  await share(owner.token, docId, editor.email, "editor");

  const ownerPeer = await connect(docId, owner.token);
  const editorPeer = await connect(docId, editor.token);
  assert.deepEqual(seedLockState(docId), { seedPending: false, seeder: null });

  editorPeer.write("no-lock-here ");
  await editorPeer.resync();
  await ownerPeer.resync();
  assert.ok(ownerPeer.text().includes("no-lock-here"), "nothing to seed, nothing to lock");
});

test("a room that already holds updates is never seed locked", async () => {
  const docId = `collab-seed-existing-${stamp}`;
  await createDoc(owner.token, docId);
  await share(owner.token, docId, editor.email, "editor");

  // Straight into the update log, so the room is built from stored Yjs state
  // rather than from an empty doc.
  const seeded = new Y.Doc();
  seeded.getText("default").insert(0, "already-here ");
  db.prepare(
    "INSERT INTO doc_updates (doc_id, seq, update_data) VALUES (?, 1, ?)"
  ).run(docId, Buffer.from(Y.encodeStateAsUpdate(seeded)));
  seeded.destroy();

  const ownerPeer = await connect(docId, owner.token);
  const editorPeer = await connect(docId, editor.token);
  assert.deepEqual(seedLockState(docId), { seedPending: false, seeder: null });
  assert.ok(ownerPeer.text().includes("already-here"), "the stored update loaded");

  editorPeer.write("second-editor ");
  await editorPeer.resync();
  await ownerPeer.resync();
  assert.ok(
    ownerPeer.text().includes("second-editor"),
    "a seeded room takes writes from any editor"
  );
});
