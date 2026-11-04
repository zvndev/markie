// The update that brings an older room up to date, built without touching
// the room, and the socket message that carries it.
//
// Two clients of this build can open the same older room in the same moment.
// Applied locally, each one's migration would be its own set of new nodes,
// and the room would end up with both: every formula and every changed line
// twice. So the migration is built on a copy of the room and sent to the
// server as one update that claims the room's editor model (collab.ts
// MODEL_KEY). The server accepts the first such claim and drops any after it
// (server/src/collab-schema.ts); the sender sees its own update come back
// from the server, or the winner's, and only then has the room changed for
// it. Loaded with the live-session runtime (collab-runtime.ts): yjs and the
// binding never reach the launch bundle.
import * as Y from "yjs";
import { updateYFragment } from "@tiptap/y-tiptap";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * The update that turns `room`'s rich fragment into `doc` and sets `meta`
 * in its meta map, built on a copy: `room` itself is left as it is. Every
 * block that did not change keeps its place in the room, and with it every
 * comment anchored there.
 */
export function migrationUpdate(room: Y.Doc, doc: PMNode, meta: Record<string, unknown>): Uint8Array {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(room));
    copy.transact(() => {
      updateYFragment(copy, copy.getXmlFragment("default"), doc, { mapping: new Map(), isOMark: new Map() });
      const map = copy.getMap("meta");
      for (const [key, value] of Object.entries(meta)) map.set(key, value);
    });
    return Y.encodeStateAsUpdate(copy, Y.encodeStateVector(room));
  } finally {
    copy.destroy();
  }
}

// lib0's unsigned varint: seven bits a byte, low first, high bit for "more".
function varUint(out: number[], value: number): void {
  let n = value;
  while (n > 0x7f) {
    out.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  out.push(n);
}

/** The y-websocket message for one update: messageSync (0), messageYjsUpdate (2), the update. */
export function syncUpdateMessage(update: Uint8Array): Uint8Array {
  const head: number[] = [];
  varUint(head, 0);
  varUint(head, 2);
  varUint(head, update.length);
  const message = new Uint8Array(head.length + update.length);
  message.set(head, 0);
  message.set(update, head.length);
  return message;
}

/** The update inside a message syncUpdateMessage made, or null. For tests and fakes. */
export function updateFromSyncMessage(message: Uint8Array): Uint8Array | null {
  let at = 0;
  const read = () => {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = message[at++];
      if (byte === undefined) throw new Error("short message");
      value += (byte & 0x7f) * shift;
      if (byte < 0x80) return value;
      shift *= 128;
    }
  };
  try {
    if (read() !== 0 || read() !== 2) return null;
    const length = read();
    return message.slice(at, at + length);
  } catch {
    return null;
  }
}
