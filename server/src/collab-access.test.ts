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
const { ACCESS_CACHE_MS, attachCollab } = await import("./collab.ts");
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
  const res = await jsonRequest<{ user: { id: string } }>(
    "POST",
    "/api/auth/sign-up/email",
    undefined,
    { name, email, password: "password-123" }
  );
  assert.equal(res.status, 200);
  const token = res.headers.get("set-auth-token");
  assert.ok(token, `expected bearer token for ${email}`);
  return { name, email, token, id: res.data?.user.id ?? "" };
}

async function createDoc(token: string, docId: string) {
  const content = "# Collab access\n";
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

  const ownerPeer = await connect(docId, owner.token);
  const editorPeer = await connect(docId, editor.token);

  editorPeer.write("editor-write ");
  await editorPeer.resync();
  await ownerPeer.resync();

  assert.ok(ownerPeer.text().includes("editor-write"), "an editor's update belongs in the room");
});

test("a revoked editor's open socket can no longer write", async () => {
  const docId = `collab-revoked-write-${stamp}`;
  await createDoc(owner.token, docId);
  const editorId = await share(owner.token, docId, editor.email, "editor");

  const ownerPeer = await connect(docId, owner.token);
  const editorPeer = await connect(docId, editor.token);
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
