import { describe, expect, it, vi } from "vitest";
import {
  IDLE_ROOM, RoomTexts, SNAPSHOT_WRITER_FIELD, liveSnapshotRefusal, liveSnapshotWait, readLiveRoom, resolveLiveConflict,
  roomHasContent, snapshotWriter, textFingerprint, writeLiveSnapshot, type LiveRoom,
} from "./live-snapshot";
import { loadCollabRuntime } from "./collab-loader";
import { TEXT_COLLAB_KEY } from "./text-collab";

// The one policy the web app and the phone follow for writing a live
// document's stored copy (live-snapshot.ts rules 1 to 5).

function fakeRoom({ synced = true, connected = true, fragment = 1, text = 0, self = 7, states = new Map<number, Record<string, unknown>>() } = {}): LiveRoom {
  const noop = () => {};
  return {
    ydoc: { getXmlFragment: () => ({ length: fragment }), getText: () => ({ length: text }), on: noop, off: noop },
    provider: {
      synced, wsconnected: connected, on: noop, off: noop,
      awareness: { clientID: self, getStates: () => states, setLocalStateField: noop, on: noop, off: noop },
    },
  };
}

describe("rule 1: only a connected, synced room holding the document may push", () => {
  it("is not ready before the first sync, nor while a rich room is still empty", () => {
    const offered = { documentEmpty: false, offered: true };
    const states = new Map([[7, { [SNAPSHOT_WRITER_FIELD]: true }]]);
    expect(readLiveRoom(fakeRoom({ synced: false, states }), "rich", offered).ready).toBe(false);
    // Synced into a room nobody has seeded: typing here would become the room.
    expect(readLiveRoom(fakeRoom({ fragment: 0, states }), "rich", offered).ready).toBe(false);
    expect(readLiveRoom(fakeRoom({ states }), "rich", offered)).toEqual({ connected: true, synced: true, ready: true, writer: true });
    // An empty document has nothing to lose, so an empty room is ready.
    expect(readLiveRoom(fakeRoom({ fragment: 0, states }), "rich", { documentEmpty: true, offered: true }).ready).toBe(true);
    // Plain text reads the Y.Text.
    expect(readLiveRoom(fakeRoom({ fragment: 0, text: 3, states }), "text", offered).ready).toBe(true);
  });

  it("reads real Yjs content for both kinds", async () => {
    const { Y } = await loadCollabRuntime();
    const doc = new Y.Doc();
    expect(roomHasContent(doc, "rich")).toBe(false);
    expect(roomHasContent(doc, "text")).toBe(false);
    doc.getText(TEXT_COLLAB_KEY).insert(0, "x");
    expect(roomHasContent(doc, "text")).toBe(true);
    doc.destroy();
  });

  it("waits on each missing condition, in order", () => {
    const ready = { connected: true, synced: true, ready: true, writer: true };
    expect(liveSnapshotWait(ready, { editable: true, refusal: null })).toBeNull();
    expect(liveSnapshotWait(ready, { editable: false, refusal: null })).toBe("read-only");
    expect(liveSnapshotWait({ ...ready, connected: false }, { editable: true, refusal: null })).toBe("not-connected");
    expect(liveSnapshotWait({ ...ready, synced: false }, { editable: true, refusal: null })).toBe("not-synced");
    expect(liveSnapshotWait({ ...ready, ready: false }, { editable: true, refusal: null })).toBe("not-ready");
    expect(liveSnapshotWait({ ...ready, writer: false }, { editable: true, refusal: null })).toBe("not-writer");
    expect(liveSnapshotWait(IDLE_ROOM, { editable: true, refusal: null })).toBe("not-connected");
  });
});

describe("rule 3: a rich room cannot carry front matter or held constructs", () => {
  it("refuses a rich push over a stored copy that has them, and never a plain-text one", () => {
    expect(liveSnapshotRefusal("---\ntitle: x\n---\n\n# Hi\n", "rich")).toBe("held-constructs");
    expect(liveSnapshotRefusal("# Hi\n\n<div class=\"callout\">raw</div>\n", "rich")).toBe("held-constructs");
    expect(liveSnapshotRefusal("# Hi\n\n<!-- note -->\n", "rich")).toBe("held-constructs");
    expect(liveSnapshotRefusal("Text[^1].\n\n[^1]: A footnote.\n", "rich")).toBe("held-constructs");
    expect(liveSnapshotRefusal("# Hi\n\nPlain **markdown**.\n", "rich")).toBeNull();
    expect(liveSnapshotRefusal("---\ntitle: x\n---\n", "text")).toBeNull();
    // The refusal outranks everything else: such a document is never pushed.
    expect(liveSnapshotWait({ connected: true, synced: true, ready: true, writer: true }, { editable: true, refusal: "held-constructs" })).toBe("held-constructs");
  });
});

describe("rule 4: one writer per room", () => {
  it("is the lowest client id that offered, and nobody else", () => {
    const states = new Map<number, Record<string, unknown>>([
      [42, { user: { name: "desktop" } }], // a desktop never offers
      [19, { [SNAPSHOT_WRITER_FIELD]: true }],
      [23, { [SNAPSHOT_WRITER_FIELD]: true }],
      [3, { [SNAPSHOT_WRITER_FIELD]: false }], // withdrew
    ]);
    expect(snapshotWriter(states)).toBe(19);
    expect(readLiveRoom(fakeRoom({ self: 19, states }), "rich", { documentEmpty: false, offered: true }).writer).toBe(true);
    expect(readLiveRoom(fakeRoom({ self: 23, states }), "rich", { documentEmpty: false, offered: true }).writer).toBe(false);
    // A viewer that never offered is never the writer, even with the lowest id.
    expect(readLiveRoom(fakeRoom({ self: 3, states }), "rich", { documentEmpty: false, offered: false }).writer).toBe(false);
    expect(snapshotWriter(new Map())).toBeNull();
  });
});

describe("rule 5: a refused save", () => {
  const room = new RoomTexts();
  room.add("# Notes\n\nA");
  room.add("# Notes\n\nA B");

  it("adopts, writes over a room state, or surfaces anything else", () => {
    expect(resolveLiveConflict({ content: "x", name: "n.md" }, { content: "x", name: "n.md" }, room)).toBe("adopt");
    expect(resolveLiveConflict({ content: "# Notes\n\nA B", name: "n.md" }, { content: "# Notes\n\nA B C", name: "n.md" }, room)).toBe("write");
    expect(resolveLiveConflict({ content: "Agent rewrote this", name: "n.md" }, { content: "# Notes\n\nA B C", name: "n.md" }, room)).toBe("conflict");
    expect(resolveLiveConflict({ content: "# Notes\n\nA B", name: "renamed.md" }, { content: "# Notes\n\nA B C", name: "n.md" }, room)).toBe("conflict");
  });

  const conflict = Object.assign(new Error("409"), { status: 409 });
  const isConflict = (error: unknown) => error === conflict;

  it("saves plainly when nobody else wrote", async () => {
    const texts = new RoomTexts();
    const save = vi.fn(async () => 5);
    expect(await writeLiveSnapshot({ save, read: async () => null, isConflict }, { content: "a", name: "n.md", version: 4, room: texts })).toEqual({ kind: "saved", version: 5 });
    expect(save).toHaveBeenCalledWith("a", 4);
    expect(texts.has("a")).toBe(true);
  });

  it("writes over a version a peer in the room wrote", async () => {
    const texts = new RoomTexts();
    texts.add("room state");
    const save = vi.fn(async (_c: string, base: number) => { if (base === 4) throw conflict; return 7; });
    const result = await writeLiveSnapshot({ save, read: async () => ({ content: "room state", name: "n.md", version: 6 }), isConflict },
      { content: "room state, more", name: "n.md", version: 4, room: texts });
    expect(result).toEqual({ kind: "saved", version: 7 });
    expect(save).toHaveBeenLastCalledWith("room state, more", 6);
  });

  it("never writes over an outside write, and says so", async () => {
    const save = vi.fn(async () => { throw conflict; });
    const result = await writeLiveSnapshot({ save, read: async () => ({ content: "an agent's text", name: "n.md", version: 6 }), isConflict },
      { content: "room text", name: "n.md", version: 4, room: new RoomTexts() });
    expect(result).toEqual({ kind: "conflict", serverVersion: 6 });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("passes on any failure that is not a version refusal", async () => {
    const boom = new Error("offline");
    await expect(writeLiveSnapshot({ save: async () => { throw boom; }, read: async () => null, isConflict },
      { content: "a", name: "n.md", version: 1, room: new RoomTexts() })).rejects.toBe(boom);
  });

  it("keeps a bounded, newest-last memory with distinct fingerprints", () => {
    const texts = new RoomTexts(3);
    for (const t of ["a", "b", "c", "d"]) texts.add(t);
    expect(texts.has("a")).toBe(false);
    texts.add("b");
    texts.add("e");
    expect(texts.has("b")).toBe(true);
    expect(texts.has("c")).toBe(false);
    expect(textFingerprint("abc")).not.toBe(textFingerprint("abd"));
  });
});
