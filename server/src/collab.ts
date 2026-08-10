// Live collaboration: custom WebSocket rooms speaking the y-websocket wire
// protocol (y-protocols sync + awareness). One room per doc, share-gated on
// upgrade. Yjs updates persist to a SQLite log, compacted past 500 rows.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import Database from "better-sqlite3";
import { auth } from "./auth.ts";
import {
  accessLevel,
  canEditLevel,
  canReadLevel,
  type ShareAccessLevel,
} from "./shares.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS doc_updates (
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    update_data BLOB NOT NULL,
    PRIMARY KEY (doc_id, seq)
  );
`);

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const COMPACT_THRESHOLD = 500;
// 4000-4999 is the application-private close range; the client treats it as a
// permanent "don't reconnect" answer rather than a dropped connection.
const CLOSE_ACCESS_REVOKED = 4403;

// A share can be revoked while a socket is open, and the desktop app keeps its
// socket for as long as the doc is open, so the level resolved at upgrade time
// is not safe to trust for the life of the connection. Every inbound message
// re-reads it: that path is paced by human typing and the read is two indexed
// queries against a local SQLite file, so correctness is worth far more than
// the microseconds. The fan-out is the one genuinely hot path (recipients x
// updates), so it reuses a level read within the last ACCESS_CACHE_MS instead
// of querying per recipient per keystroke. Revocation through the API calls
// disconnectUser()/closeRoom() and hangs up immediately, so this window only
// ever bounds a revocation that reached the database some other way.
export const ACCESS_CACHE_MS = 1000;

function loadUpdates(docId: string, ydoc: Y.Doc): void {
  const rows = db
    .prepare("SELECT update_data FROM doc_updates WHERE doc_id = ? ORDER BY seq")
    .all(docId) as Array<{ update_data: Buffer }>;
  for (const row of rows) {
    Y.applyUpdate(ydoc, new Uint8Array(row.update_data));
  }
}

function appendUpdate(docId: string, update: Uint8Array): void {
  const next =
    ((db
      .prepare("SELECT MAX(seq) AS m FROM doc_updates WHERE doc_id = ?")
      .get(docId) as { m: number | null }).m ?? 0) + 1;
  db.prepare(
    "INSERT INTO doc_updates (doc_id, seq, update_data) VALUES (?, ?, ?)"
  ).run(docId, next, Buffer.from(update));
  if (next >= COMPACT_THRESHOLD) {
    const ydoc = new Y.Doc();
    loadUpdates(docId, ydoc);
    const merged = Y.encodeStateAsUpdate(ydoc);
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM doc_updates WHERE doc_id = ?").run(docId);
      db.prepare(
        "INSERT INTO doc_updates (doc_id, seq, update_data) VALUES (?, 1, ?)"
      ).run(docId, Buffer.from(merged));
    });
    tx();
  }
}

interface Conn {
  userId: string;
  identity: PresenceIdentity; // what this socket is allowed to claim it is
  controlled: Set<number>; // awareness client ids this socket controls
  level: ShareAccessLevel; // last level read for this user on this doc
  checkedAt: number; // when that read happened
}

interface Room {
  docId: string;
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Conn>;
}

const rooms = new Map<string, Room>();

function readLevel(docId: string, conn: Conn): ShareAccessLevel {
  conn.level = accessLevel(docId, conn.userId);
  conn.checkedAt = Date.now();
  return conn.level;
}

function cachedLevel(docId: string, conn: Conn): ShareAccessLevel {
  if (Date.now() - conn.checkedAt >= ACCESS_CACHE_MS) return readLevel(docId, conn);
  return conn.level;
}

function getRoom(docId: string): Room {
  let room = rooms.get(docId);
  if (room) return room;
  const ydoc = new Y.Doc();
  loadUpdates(docId, ydoc);
  const awareness = new awarenessProtocol.Awareness(ydoc);
  awareness.setLocalState(null);
  room = { docId, ydoc, awareness, conns: new Map() };
  rooms.set(docId, room);

  ydoc.on("update", (update: Uint8Array) => {
    appendUpdate(docId, update);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(room!, encoding.toUint8Array(encoder));
  });

  awareness.on(
    "update",
    (
      {
        added,
        updated,
        removed,
      }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown
    ) => {
      // remember which awareness client ids each connection controls
      const controlled = origin
        ? room!.conns.get(origin as WebSocket)?.controlled
        : null;
      if (controlled) {
        for (const id of added) controlled.add(id);
        for (const id of removed) controlled.delete(id);
      }
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
      );
      broadcast(room!, encoding.toUint8Array(encoder));
    }
  );
  return room;
}

function broadcast(room: Room, message: Uint8Array): void {
  for (const [ws, conn] of room.conns) {
    if (ws.readyState !== ws.OPEN) continue;
    // Losing access has to stop the reading too, not just the writing: a
    // removed collaborator was still being fed every keystroke. Hang up rather
    // than silently starve the socket, so the client knows it is out.
    if (!canReadLevel(cachedLevel(room.docId, conn))) {
      ws.close(CLOSE_ACCESS_REVOKED, "access revoked");
      continue;
    }
    ws.send(message);
  }
}

// Hang up on a collaborator whose share just went away. This is the mechanism
// that makes revocation immediate; the per-message check in handleConnection is
// the backstop for revocations that never reach this call.
export function disconnectUser(docId: string, userId: string): void {
  const room = rooms.get(docId);
  if (!room) return;
  for (const [ws, conn] of room.conns) {
    if (conn.userId === userId) ws.close(CLOSE_ACCESS_REVOKED, "access revoked");
  }
}

// A soft-deleted doc revokes access for everyone at once, owner included.
export function closeRoom(docId: string): void {
  const room = rooms.get(docId);
  if (!room) return;
  for (const ws of room.conns.keys()) ws.close(CLOSE_ACCESS_REVOKED, "doc deleted");
}

export interface PresenceIdentity {
  name: string;
  color: string;
}

// Mirrors colorForName in the renderer's src/lib/collab.ts so that stamping
// presence server-side is invisible to an honest client.
const PEER_COLORS = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#14b8a6",
  "#eab308",
];

export function presenceIdentity(user: {
  name?: string | null;
  email?: string | null;
}): PresenceIdentity {
  const name = user.name || user.email || "Someone";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return { name, color: PEER_COLORS[Math.abs(hash) % PEER_COLORS.length] };
}

// Awareness is relayed verbatim to every peer, so the identity inside it must
// be the session's rather than whatever the client typed: otherwise any
// collaborator, viewers included, can put words in another user's mouth. The
// cursor and everything else stays the client's own.
export function stampPresenceIdentity(
  update: Uint8Array,
  identity: PresenceIdentity
): Uint8Array {
  return awarenessProtocol.modifyAwarenessUpdate(update, (state) =>
    state && typeof state === "object" ? { ...state, user: identity } : state
  );
}

export function readAccessControlledSyncMessage(
  decoder: decoding.Decoder,
  encoder: encoding.Encoder,
  ydoc: Y.Doc,
  transactionOrigin: unknown,
  canEdit: boolean
): number {
  if (canEdit) {
    return syncProtocol.readSyncMessage(
      decoder,
      encoder,
      ydoc,
      transactionOrigin
    );
  }

  const messageType = decoding.readVarUint(decoder);
  if (messageType === syncProtocol.messageYjsSyncStep1) {
    syncProtocol.readSyncStep1(decoder, encoder, ydoc);
  }
  return messageType;
}

function handleConnection(
  conn: WebSocket,
  docId: string,
  user: { id: string; name?: string | null; email?: string | null },
  level: ShareAccessLevel
): void {
  const room = getRoom(docId);
  const state: Conn = {
    userId: user.id,
    identity: presenceIdentity(user),
    controlled: new Set(),
    level,
    checkedAt: Date.now(),
  };
  room.conns.set(conn, state);
  conn.binaryType = "arraybuffer";

  conn.on("message", (data: ArrayBuffer | Buffer) => {
    try {
      // Never trust the level captured at upgrade time (see ACCESS_CACHE_MS).
      const current = readLevel(docId, state);
      if (!canReadLevel(current)) {
        conn.close(CLOSE_ACCESS_REVOKED, "access revoked");
        return;
      }
      const message = new Uint8Array(data as ArrayBuffer);
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        readAccessControlledSyncMessage(
          decoder,
          encoder,
          room.ydoc,
          conn,
          canEditLevel(current)
        );
        if (encoding.length(encoder) > 1) {
          conn.send(encoding.toUint8Array(encoder));
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          room.awareness,
          stampPresenceIdentity(
            decoding.readVarUint8Array(decoder),
            state.identity
          ),
          conn
        );
      }
    } catch (err) {
      console.error("collab message error:", err);
    }
  });

  conn.on("close", () => {
    const controlled = room.conns.get(conn)?.controlled;
    room.conns.delete(conn);
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...controlled], null);
    }
    if (room.conns.size === 0) {
      // free the room; state is in the update log
      room.awareness.destroy();
      room.ydoc.destroy();
      rooms.delete(docId);
    }
  });

  // initial handshake: sync step 1 + current awareness states
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.ydoc);
  conn.send(encoding.toUint8Array(encoder));
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()])
    );
    conn.send(encoding.toUint8Array(awarenessEncoder));
  }
}

async function sessionFromToken(token: string) {
  return auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${token}` }),
  });
}

export function attachCollab(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const match = url.pathname.match(/^\/collab\/([^/]+)$/);
      if (!match) {
        socket.destroy();
        return;
      }
      const docId = decodeURIComponent(match[1]);
      const token = url.searchParams.get("token") ?? "";
      const session = await sessionFromToken(token);
      const level = session?.user ? accessLevel(docId, session.user.id) : null;
      if (!session?.user || !canReadLevel(level)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const user = session.user;
      wss.handleUpgrade(req, socket, head, (conn) => {
        handleConnection(conn, docId, user, level);
      });
    } catch (err) {
      console.error("collab upgrade error:", err);
      socket.destroy();
    }
  });

  console.log("collab websocket attached at /collab/:docId");
}
