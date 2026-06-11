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
import { accessLevel } from "./shares.ts";

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

interface Room {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>; // ws -> controlled awareness client ids
}

const rooms = new Map<string, Room>();

function getRoom(docId: string): Room {
  let room = rooms.get(docId);
  if (room) return room;
  const ydoc = new Y.Doc();
  loadUpdates(docId, ydoc);
  const awareness = new awarenessProtocol.Awareness(ydoc);
  awareness.setLocalState(null);
  room = { ydoc, awareness, conns: new Map() };
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
      const controlled = origin ? room!.conns.get(origin as WebSocket) : null;
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
  for (const conn of room.conns.keys()) {
    if (conn.readyState === conn.OPEN) conn.send(message);
  }
}

function handleConnection(conn: WebSocket, docId: string): void {
  const room = getRoom(docId);
  room.conns.set(conn, new Set());
  conn.binaryType = "arraybuffer";

  conn.on("message", (data: ArrayBuffer | Buffer) => {
    try {
      const message = new Uint8Array(data as ArrayBuffer);
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, conn);
        if (encoding.length(encoder) > 1) {
          conn.send(encoding.toUint8Array(encoder));
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          room.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
      }
    } catch (err) {
      console.error("collab message error:", err);
    }
  });

  conn.on("close", () => {
    const controlled = room.conns.get(conn);
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
      if (!session?.user || !accessLevel(docId, session.user.id)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (conn) => {
        handleConnection(conn, docId);
      });
    } catch (err) {
      console.error("collab upgrade error:", err);
      socket.destroy();
    }
  });

  console.log("collab websocket attached at /collab/:docId");
}
