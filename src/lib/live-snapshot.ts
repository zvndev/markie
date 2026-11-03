// Who writes a live document's stored copy, and when: one policy for every
// client that writes it while a live session runs (the web app, src/web, and
// the phone, apps/mobile). The desktop writes its own file while live and
// never the cloud copy (src/app/page.tsx handleSave), so it takes no part.
//
// The room (a Yjs document on the server's collab socket) is where the live
// edits are; the stored copy (docs.content, versioned) is what hosted pages,
// the phone, agents and the Library read. Writing the room's text over the
// stored copy is only safe when all of these hold:
//
//   1. The text came out of the room. Before the first sync a client holds
//      an empty or stale local document, and a rich room that has not been
//      seeded yet is empty: a push then would write "Hi" over the whole
//      document with a perfectly good base version. So a push needs the
//      socket connected, the provider synced, and the room holding content
//      (or the document genuinely empty). Editors also hold typing until
//      then (RichView holdUntilReady, TextCollabEditor), so a keystroke can
//      never seed a room in place of the document.
//   2. The session is still live. A ticket that never came ("unavailable")
//      means no room: the editor drops to solo, as the desktop does, and the
//      ordinary versioned save takes over.
//   3. The room can say everything the stored copy says. A rich room is
//      seeded by parsing the markdown into TipTap, and a push writes the
//      room's serialization. That is only safe when it is faithful for this
//      document: a room seeded from the stored copy, with nobody's edits in
//      it, must write the stored copy back byte for byte (roomCarries in
//      live-snapshot-rich.ts, which keeps every block the serializer merely
//      reformats as its source bytes, as rich-view.tsx serializeMarkdown
//      does). Front matter, raw HTML blocks, HTML comments, footnote
//      definitions and a refused picture address are the known losses and
//      answer at once (liveSnapshotRefusal); anything else the serializer
//      cannot reproduce is caught when the room is ready ("uncarried"). For
//      such a document no rich push happens at all and the client says so.
//      Plain text rooms (Y.Text) are byte-faithful.
//   4. One writer per room. Every eligible client advertises itself in the
//      room's awareness and the one with the lowest client id writes; the
//      rest only watch. That keeps peers from racing each other's versions.
//   5. A refused save (409) is resolved by the fingerprint rule below: write
//      over the server's version only when its text is one this client saw
//      in the room; anything else came from outside (an agent through MCP,
//      a desktop's file sync, another device) and is surfaced, never
//      overwritten.
//   6. The stored copy the session opened on must be a state of the room.
//      The server keeps the room (its update log) and the stored copy apart
//      and only drops the room when the document is deleted, so a room last
//      edited weeks ago can be older than a version an agent wrote since. A
//      push from it would carry a correct base version, draw no 409, and
//      silently put the old text back. So when the room is first ready, its
//      text is compared with the stored copy (classifyLiveRoom): equal, and
//      opening a document never rewrites it; different, and the client
//      shows a conflict and never pushes in this session, unless rule 7
//      says the room is simply ahead.
//   7. A room ahead of the stored copy is not a conflict. Live edits reach
//      the room at once and the stored copy only on the writer's next push,
//      so a server restart (every deploy) between the two leaves a room that
//      is newer than its stored copy, with nobody outside having written.
//      The room keeps a record in its meta map of the stored copy it last
//      matched or pushed (version and fingerprint, plus the fingerprint of a
//      push in flight). When the stored copy is still exactly that record,
//      the room is ahead and the writer pushes it; only a stored copy the
//      record does not know is an outside write.
//
// This module must not value-import yjs or y-websocket (they load lazily,
// src/lib/collab-loader.ts): the room is typed structurally.
import { useEffect, useState } from "react";
import { richRoomCannotCarry } from "@/lib/live-room-carry";
import { TEXT_COLLAB_KEY } from "@/lib/text-collab";

export type LiveKind = "rich" | "text";

/** The parts of a live session this policy reads. */
export interface LiveRoom {
  ydoc: {
    getXmlFragment(name: string): { length: number };
    getText(name: string): { length: number };
    on(event: "update", handler: (...args: unknown[]) => void): void;
    off(event: "update", handler: (...args: unknown[]) => void): void;
  };
  provider: {
    synced: boolean;
    wsconnected: boolean;
    on(event: "status" | "sync", handler: (...args: unknown[]) => void): void;
    off(event: "status" | "sync", handler: (...args: unknown[]) => void): void;
    awareness: {
      clientID: number;
      getStates(): Map<number, Record<string, unknown>>;
      setLocalStateField(field: string, value: unknown): void;
      on(event: "change", handler: (...args: unknown[]) => void): void;
      off(event: "change", handler: (...args: unknown[]) => void): void;
    };
  };
}

/** The awareness field a client sets when it may write the stored copy. */
export const SNAPSHOT_WRITER_FIELD = "markieSnapshotWriter";

/** Whether the room holds a document (the rich fragment, or the text). */
export function roomHasContent(ydoc: LiveRoom["ydoc"], kind: LiveKind): boolean {
  return kind === "rich" ? ydoc.getXmlFragment("default").length > 0 : ydoc.getText(TEXT_COLLAB_KEY).length > 0;
}

/** The client that writes the stored copy: the lowest id that offered to. */
export function snapshotWriter(states: Map<number, Record<string, unknown>>): number | null {
  let writer: number | null = null;
  for (const [clientId, state] of states) {
    if (state?.[SNAPSHOT_WRITER_FIELD] !== true) continue;
    if (writer === null || clientId < writer) writer = clientId;
  }
  return writer;
}

export interface LiveRoomState {
  /** The socket is open. */
  connected: boolean;
  /** The provider has the server's state. */
  synced: boolean;
  /** Synced, and the room holds the document (or the document is empty). */
  ready: boolean;
  /** This client is the one that writes the stored copy. */
  writer: boolean;
}

export const IDLE_ROOM: LiveRoomState = { connected: false, synced: false, ready: false, writer: false };

export function readLiveRoom(room: LiveRoom, kind: LiveKind, { documentEmpty, offered }: { documentEmpty: boolean; offered: boolean }): LiveRoomState {
  const { provider, ydoc } = room;
  const synced = !!provider.synced;
  const connected = !!provider.wsconnected;
  const ready = synced && (roomHasContent(ydoc, kind) || documentEmpty);
  const writer = offered && snapshotWriter(provider.awareness.getStates()) === provider.awareness.clientID;
  return { connected, synced, ready, writer };
}

/**
 * The room as this policy sees it, kept current. `offer` makes this client a
 * candidate writer (an editor that writes the stored copy); a viewer, or a
 * host that never writes it, passes false and is never elected.
 */
export function useLiveRoom(room: LiveRoom | null, kind: LiveKind, { documentEmpty, offer }: { documentEmpty: boolean; offer: boolean }): LiveRoomState {
  const [state, setState] = useState<LiveRoomState>(IDLE_ROOM);
  useEffect(() => {
    if (!room) { setState(IDLE_ROOM); return; }
    const { provider, ydoc } = room;
    const awareness = provider.awareness;
    if (offer) awareness.setLocalStateField(SNAPSHOT_WRITER_FIELD, true);
    const update = () => {
      const next = readLiveRoom(room, kind, { documentEmpty, offered: offer });
      setState((prev) => (prev.connected === next.connected && prev.synced === next.synced && prev.ready === next.ready && prev.writer === next.writer ? prev : next));
    };
    update();
    provider.on("status", update);
    provider.on("sync", update);
    awareness.on("change", update);
    ydoc.on("update", update);
    return () => {
      provider.off("status", update);
      provider.off("sync", update);
      awareness.off("change", update);
      ydoc.off("update", update);
      if (offer) {
        try { awareness.setLocalStateField(SNAPSHOT_WRITER_FIELD, false); } catch { /* the session is already gone */ }
      }
    };
  }, [room, kind, documentEmpty, offer]);
  return state;
}

/** Why a rich room cannot write over this stored copy, or null when it can. */
export type SnapshotRefusal = "held-constructs";

/**
 * Rule 3: whether the room can carry everything `stored` says. Front matter,
 * the constructs the solo editor holds aside (raw HTML blocks, HTML
 * comments, footnote definitions) and a picture whose address the editor
 * refuses do not survive a rich room.
 */
export function liveSnapshotRefusal(stored: string, kind: LiveKind): SnapshotRefusal | null {
  if (kind !== "rich") return null;
  // The same rule the desktop applies to its own file while live, so desktop,
  // web and phone refuse exactly the same texts (src/lib/live-room-carry.ts).
  return richRoomCannotCarry(stored) ? "held-constructs" : null;
}

export const SNAPSHOT_REFUSAL_NOTE =
  "Live edits stay in the live session. The saved copy isn't updated from it, because this document has front matter, raw HTML, a picture address or other markdown that live editing can't keep exactly.";

/**
 * Rules 3, 6 and 7, decided when the room is first ready. "unknown" until
 * then. "room-state": the room says exactly the stored copy. "ahead": the
 * room moved on from a stored copy it recorded (rule 7), so its text goes
 * out. "diverged": the stored copy was written outside the room.
 * "uncarried": the room cannot write this document faithfully (rule 3).
 */
export type LiveBase = "unknown" | "room-state" | "ahead" | "diverged" | "uncarried";

export type LiveSnapshotWait = "read-only" | "not-connected" | "not-synced" | "not-ready" | "not-writer" | "diverged" | SnapshotRefusal;

/** Rules 1 to 4 and 6 together: null when this client may push now. */
export function liveSnapshotWait(
  room: LiveRoomState,
  { editable, refusal, base }: { editable: boolean; refusal: SnapshotRefusal | null; base: LiveBase }
): LiveSnapshotWait | null {
  if (!editable) return "read-only";
  if (refusal) return refusal;
  if (base === "uncarried") return "held-constructs";
  if (base === "diverged") return "diverged";
  if (!room.connected) return "not-connected";
  if (!room.synced) return "not-synced";
  if (!room.ready || base === "unknown") return "not-ready";
  if (!room.writer) return "not-writer";
  return null;
}

// ── Rule 7: what the room last knew of the stored copy ────────────────────

/** The part of a room's Yjs document the record lives in. */
export interface RoomMeta {
  getMap(name: string): { get(key: string): unknown; set(key: string, value: unknown): void };
}

/** The room's document as a RoomMeta, from whatever session a host holds. */
export function roomMeta(room: { ydoc: unknown } | null | undefined): RoomMeta | null {
  const ydoc = room?.ydoc as Partial<RoomMeta> | null | undefined;
  return ydoc && typeof ydoc.getMap === "function" ? (ydoc as RoomMeta) : null;
}

/** The key in the room's "meta" map. */
export const STORED_RECORD_KEY = "storedCopy";

/**
 * The stored copy this room last matched or pushed: its version and the
 * fingerprint of its text, and `next`, the fingerprint of a push that was
 * sent but whose answer the room has not heard yet.
 */
export interface StoredRecord {
  version: number;
  hash: string;
  next?: string | null;
}

export function readStoredRecord(meta: RoomMeta): StoredRecord | null {
  const value = meta.getMap("meta").get(STORED_RECORD_KEY) as Partial<StoredRecord> | undefined;
  if (!value || typeof value !== "object" || typeof value.version !== "number" || typeof value.hash !== "string") return null;
  return { version: value.version, hash: value.hash, next: typeof value.next === "string" ? value.next : null };
}

export function writeStoredRecord(meta: RoomMeta, record: StoredRecord): void {
  const next = record.next ?? null;
  const prev = readStoredRecord(meta);
  if (prev && prev.version === record.version && prev.hash === record.hash && (prev.next ?? null) === next) return;
  meta.getMap("meta").set(STORED_RECORD_KEY, { version: record.version, hash: record.hash, next });
}

/**
 * Whether `stored` is a stored copy the room knows: the one it recorded, or
 * the result of the push it recorded as in flight (which landed before the
 * room heard back, a restart in between). A version the record does not
 * know, or a text it never held, came from outside.
 */
export function recordCovers(record: StoredRecord | null, stored: { content: string; version: number }): boolean {
  if (!record) return false;
  const hash = textFingerprint(stored.content);
  if (stored.version === record.version && hash === record.hash) return true;
  return !!record.next && hash === record.next && stored.version > record.version;
}

/**
 * Rules 3, 6 and 7: what the room's first text says about the stored copy.
 * `roomText` is the room as the editor writes it back: for a rich room, with
 * every untouched block in its source bytes, so a room seeded from the
 * stored copy says it exactly whenever the room can carry it at all.
 */
export async function classifyLiveRoom(
  roomText: string,
  stored: { content: string; version: number },
  kind: LiveKind,
  record: StoredRecord | null
): Promise<Exclude<LiveBase, "unknown">> {
  if (roomText === stored.content) return "room-state";
  if (kind === "rich") {
    const { roomCarries } = await import("@/lib/live-snapshot-rich");
    if (!roomCarries(stored.content)) return "uncarried";
  }
  return recordCovers(record, stored) ? "ahead" : "diverged";
}

/**
 * classifyLiveRoom, with the record kept current: a room that says the
 * stored copy records it, so a later session can tell "ahead" from an
 * outside write. Only an editor calls this; a viewer cannot write the room.
 */
export async function assessLiveRoom(
  roomText: string,
  stored: { content: string; version: number },
  kind: LiveKind,
  meta: RoomMeta | null
): Promise<Exclude<LiveBase, "unknown">> {
  const record = meta ? readStoredRecord(meta) : null;
  const base = await classifyLiveRoom(roomText, stored, kind, record);
  if (base === "room-state" && meta) {
    try {
      writeStoredRecord(meta, { version: stored.version, hash: textFingerprint(stored.content) });
    } catch {
      // The session is already gone.
    }
  }
  return base;
}

export const DIVERGED_NOTE =
  "The live session and the saved copy differ: someone saved this document outside the live session since it was last edited live. The live edits stay in the session and aren't saved over that version.";

// ── Rule 5: a refused save ────────────────────────────────────────────────

/**
 * A 53-bit fingerprint of a text (cyrb53): cheap, and not a secret. The room
 * keeps one of its stored copy (rule 7), beside the room's own text.
 */
export function textFingerprint(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The texts this client has seen in the room, newest last, bounded. */
export class RoomTexts {
  private readonly seen = new Set<string>();
  constructor(private readonly limit = 512) {}

  add(text: string): void {
    const key = textFingerprint(text);
    this.seen.delete(key);
    this.seen.add(key);
    if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value as string);
  }

  has(text: string): boolean {
    return this.seen.has(textFingerprint(text));
  }
}

export type LiveConflictAnswer =
  /** The server already holds exactly this: take its version. */
  | "adopt"
  /** A state of this room: save the room's text over it. */
  | "write"
  /** Written from outside the room: stop and ask, never save over it. */
  | "conflict";

export function resolveLiveConflict(
  server: { content: string; name: string },
  mine: { content: string; name: string },
  room: Pick<RoomTexts, "has">
): LiveConflictAnswer {
  if (server.content === mine.content && server.name === mine.name) return "adopt";
  if (server.name === mine.name && room.has(server.content)) return "write";
  return "conflict";
}

export type LiveSnapshotResult =
  | { kind: "saved"; version: number }
  | { kind: "conflict"; serverVersion: number | null };

/**
 * Write the room's text over the stored copy at `version`, resolving a 409
 * by rule 5. `save` returns the new version or throws; `isConflict` says
 * whether what it threw was the server's version refusal.
 */
export async function writeLiveSnapshot(
  io: {
    save(content: string, baseVersion: number): Promise<number>;
    read(): Promise<{ content: string; name: string; version: number } | null>;
    isConflict(error: unknown): boolean;
  },
  { content, name, version, room, meta = null }: { content: string; name: string; version: number; room: Pick<RoomTexts, "has" | "add">; meta?: RoomMeta | null }
): Promise<LiveSnapshotResult> {
  // Rule 7: say what is about to land before it does, and what landed once
  // it has, so a session that opens after a restart in between can tell this
  // write from an outside one.
  const hash = textFingerprint(content);
  const note = (record: StoredRecord) => {
    if (!meta) return;
    try { writeStoredRecord(meta, record); } catch { /* the session is already gone */ }
  };
  const before = meta ? readStoredRecord(meta) : null;
  note({ version: before?.version ?? version, hash: before?.hash ?? "", next: hash });
  const landed = (next: number): LiveSnapshotResult => {
    room.add(content);
    note({ version: next, hash });
    return { kind: "saved", version: next };
  };
  try {
    return landed(await io.save(content, version));
  } catch (error) {
    if (!io.isConflict(error)) throw error;
  }
  const server = await io.read();
  if (!server) return { kind: "conflict", serverVersion: null };
  const answer = resolveLiveConflict(server, { content, name }, room);
  if (answer === "adopt") return landed(server.version);
  if (answer === "conflict") return { kind: "conflict", serverVersion: server.version };
  try {
    return landed(await io.save(content, server.version));
  } catch (error) {
    if (io.isConflict(error)) return { kind: "conflict", serverVersion: null };
    throw error;
  }
}
