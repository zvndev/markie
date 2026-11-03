// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  IDLE_ROOM, RoomTexts, SNAPSHOT_WRITER_FIELD, STORED_RECORD_KEY, assessLiveRoom, classifyLiveRoom, liveSnapshotRefusal, liveSnapshotWait,
  readLiveRoom, readStoredRecord, recordCovers, resolveLiveConflict, roomHasContent, snapshotWriter, textFingerprint, writeLiveSnapshot,
  writeStoredRecord, type LiveRoom,
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
    expect(liveSnapshotWait(ready, { editable: true, refusal: null, base: "room-state" })).toBeNull();
    expect(liveSnapshotWait(ready, { editable: false, refusal: null, base: "room-state" })).toBe("read-only");
    expect(liveSnapshotWait({ ...ready, connected: false }, { editable: true, refusal: null, base: "room-state" })).toBe("not-connected");
    expect(liveSnapshotWait({ ...ready, synced: false }, { editable: true, refusal: null, base: "room-state" })).toBe("not-synced");
    expect(liveSnapshotWait({ ...ready, ready: false }, { editable: true, refusal: null, base: "room-state" })).toBe("not-ready");
    expect(liveSnapshotWait({ ...ready, writer: false }, { editable: true, refusal: null, base: "room-state" })).toBe("not-writer");
    expect(liveSnapshotWait(IDLE_ROOM, { editable: true, refusal: null, base: "room-state" })).toBe("not-connected");
  });
});

describe("rule 6: the stored copy must be a state of the room", () => {
  it("waits until the room has been compared, and never pushes from a room that drifted", () => {
    const ready = { connected: true, synced: true, ready: true, writer: true };
    expect(liveSnapshotWait(ready, { editable: true, refusal: null, base: "unknown" })).toBe("not-ready");
    expect(liveSnapshotWait(ready, { editable: true, refusal: null, base: "diverged" })).toBe("diverged");
    expect(liveSnapshotWait({ ...ready, connected: false }, { editable: true, refusal: null, base: "diverged" })).toBe("diverged");
  });

  it("knows a room seeded from the stored copy: it writes the stored copy back byte for byte", async () => {
    const stored = "# Launch plan\n\nShip the **web app** this week.\n\n* Library\n* Editor\n";
    const { roomRendering, roomWriteBack } = await import("./live-snapshot-rich");
    expect(roomRendering(stored)).not.toBe(stored); // the serializer's own bytes
    // What the live pane writes back keeps every untouched block's source.
    const room = roomWriteBack(stored);
    expect(room).toBe(stored);
    const at = { content: stored, version: 3 };
    expect(await classifyLiveRoom(room, at, "rich", null)).toBe("room-state");
    // A room last edited before an agent rewrote the stored copy.
    expect(await classifyLiveRoom(roomWriteBack("# Launch plan\n\nOld text.\n"), at, "rich", null)).toBe("diverged");
    // Plain text rooms hold the characters themselves.
    expect(await classifyLiveRoom("a\nb\n", { content: "a\nb\n", version: 1 }, "text", null)).toBe("room-state");
    expect(await classifyLiveRoom("a\nb", { content: "a\nb\n", version: 1 }, "text", null)).toBe("diverged");
  });

  it("renders exactly what a seeded rich room serializes to", async () => {
    // The room path: the collab schema bound to a real Y.Doc, seeded with
    // setContent, read back through the markdown serializer.
    const { Y } = await loadCollabRuntime();
    const { Editor } = await import("@tiptap/core");
    const { default: Collaboration } = await import("@tiptap/extension-collaboration");
    const { richBaseExtensions } = await import("./rich-extensions");
    const { formatMarkdownTables } = await import("./format-tables");
    const { roomRendering } = await import("./live-snapshot-rich");
    const stored = "# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] task\n\n1. one\n2. two\n\n> quote\n\n```js\nx = 1\n```\n";
    const ydoc = new Y.Doc();
    const editor = new Editor({ extensions: [...richBaseExtensions({ collab: true }), Collaboration.configure({ document: ydoc })] });
    editor.commands.setContent(stored);
    const room = formatMarkdownTables((editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown());
    editor.destroy();
    ydoc.destroy();
    expect(roomRendering(stored)).toBe(room);
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
    expect(liveSnapshotWait({ connected: true, synced: true, ready: true, writer: true }, { editable: true, refusal: "held-constructs", base: "room-state" })).toBe("held-constructs");
  });

  // The verifier's document: KaTeX inline and display (with a thin space,
  // `\,`, that the parser reads as an escaped comma), a right-aligned table
  // column, and a closing newline. A room seeded from it used to write back
  // `\\pi`, a one-line display block without its `\,`, a table without its
  // alignment, and no newline, all on the first keystroke anyone made.
  const EVERYTHING = [
    "# Everything",
    "",
    "Inline math $e^{i\\pi} + 1 = 0$ in a sentence.",
    "",
    "$$",
    "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
    "$$",
    "",
    "| Item | Price |",
    "| :--- | ---: |",
    "| Tea | 3 |",
    "| Cake | 12 |",
    "",
    "Last line.",
    "",
  ].join("\n");

  it("is generic: a room may write a document only when it writes it back byte for byte", async () => {
    const { roomCarries, roomRendering, roomWriteBack } = await import("./live-snapshot-rich");
    // The serializer alone cannot say this document...
    expect(roomRendering(EVERYTHING)).not.toBe(EVERYTHING);
    // ...but the live pane, keeping untouched blocks, writes it back exactly.
    expect(roomWriteBack(EVERYTHING)).toBe(EVERYTHING);
    expect(roomCarries(EVERYTHING)).toBe(true);
    // The known losses answer without a parse, and still refuse.
    expect(roomCarries("---\ntitle: x\n---\n\n# Hi\n")).toBe(false);
    expect(roomCarries("# Hi\n\n<!-- note -->\n")).toBe(false);
    expect(roomCarries("")).toBe(true);
  });

  it("refuses, once the room is ready, a document the room cannot write back", async () => {
    const { roomCarries, roomWriteBack } = await import("./live-snapshot-rich");
    // A reference link whose definition sits a block away: the parser
    // inlines the link and drops the definition. No list of known losses
    // names it; the guard catches it because the room cannot write it back.
    const odd = "See [the docs][ref].\n\nUnrelated paragraph.\n\n[ref]: https://example.com\n";
    expect(liveSnapshotRefusal(odd, "rich")).toBeNull();
    expect(roomCarries(odd)).toBe(false);
    const stored = { content: odd, version: 2 };
    // The room as seeded from it, and a room somebody typed in: neither pushes.
    expect(await classifyLiveRoom(roomWriteBack(odd), stored, "rich", null)).toBe("uncarried");
    expect(await classifyLiveRoom("See the docs. Bob\n", stored, "rich", { version: 2, hash: textFingerprint(odd) })).toBe("uncarried");
    // An uncarried room never pushes, and says why like a held construct.
    const ready = { connected: true, synced: true, ready: true, writer: true };
    expect(liveSnapshotWait(ready, { editable: true, refusal: null, base: "uncarried" })).toBe("held-constructs");
  });
});

describe("rule 7: a room ahead of the stored copy it recorded", () => {
  function meta() {
    const map = new Map<string, unknown>();
    return { map, room: { getMap: () => ({ get: (k: string) => map.get(k), set: (k: string, v: unknown) => void map.set(k, v) }) } };
  }
  const stored = { content: "# Notes\n\nA\n", version: 4 };

  it("records the stored copy a room says, and reads it back", async () => {
    const { room } = meta();
    expect(readStoredRecord(room)).toBeNull();
    expect(await assessLiveRoom(stored.content, stored, "rich", room)).toBe("room-state");
    expect(readStoredRecord(room)).toEqual({ version: 4, hash: textFingerprint(stored.content), next: null });
  });

  it("pushes a room that moved on from the stored copy it recorded (a restart before the push)", async () => {
    const { room } = meta();
    writeStoredRecord(room, { version: 4, hash: textFingerprint(stored.content) });
    // Bob typed; the server restarted before anyone pushed.
    expect(await assessLiveRoom("# Notes\n\nA Bob\n", stored, "rich", room)).toBe("ahead");
    const ready = { connected: true, synced: true, ready: true, writer: true };
    expect(liveSnapshotWait(ready, { editable: true, refusal: null, base: "ahead" })).toBeNull();
  });

  it("knows its own push that landed before the room heard back", () => {
    const record = { version: 4, hash: textFingerprint(stored.content), next: textFingerprint("# Notes\n\nA B\n") };
    expect(recordCovers(record, { content: "# Notes\n\nA B\n", version: 5 })).toBe(true);
    expect(recordCovers(record, { content: "# Notes\n\nan agent\n", version: 5 })).toBe(false);
  });

  it("still calls an outside write a conflict", async () => {
    const { room } = meta();
    writeStoredRecord(room, { version: 4, hash: textFingerprint(stored.content) });
    // An agent wrote version 5 since.
    const newer = { content: "# Notes\n\nAgent text\n", version: 5 };
    expect(await assessLiveRoom("# Notes\n\nA Bob\n", newer, "rich", room)).toBe("diverged");
    // The same version with other text is not the recorded copy either.
    expect(recordCovers(readStoredRecord(room), { content: "# Notes\n\nB\n", version: 4 })).toBe(false);
    // No record, as in a room from an older build: a conflict, as before.
    expect(await assessLiveRoom("# Notes\n\nA Bob\n", stored, "rich", null)).toBe("diverged");
  });

  it("is kept by every push: pending before it lands, the new version after", async () => {
    const { room } = meta();
    writeStoredRecord(room, { version: 4, hash: textFingerprint(stored.content) });
    let seen: unknown = null;
    const save = vi.fn(async () => { seen = readStoredRecord(room); return 5; });
    await writeLiveSnapshot({ save, read: async () => null, isConflict: () => false },
      { content: "# Notes\n\nA B\n", name: "n.md", version: 4, room: new RoomTexts(), meta: room });
    expect(seen).toEqual({ version: 4, hash: textFingerprint(stored.content), next: textFingerprint("# Notes\n\nA B\n") });
    expect(readStoredRecord(room)).toEqual({ version: 5, hash: textFingerprint("# Notes\n\nA B\n"), next: null });
  });

  it("lives in the room's Yjs meta map, so a server restart keeps it", async () => {
    const { Y } = await loadCollabRuntime();
    const a = new Y.Doc();
    writeStoredRecord(a, { version: 9, hash: "abc" });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readStoredRecord(b)).toEqual({ version: 9, hash: "abc", next: null });
    expect(b.getMap("meta").get(STORED_RECORD_KEY)).toBeTruthy();
    a.destroy();
    b.destroy();
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
