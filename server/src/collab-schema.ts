// Which builds a live room lets in.
//
// A rich room is a Yjs copy of the editor's ProseMirror document, and a
// build can only take part in a room whose nodes its editor knows. Markie
// added math nodes (mathInline, mathBlock; src/lib/rich-math.ts) after
// desktop 0.9.4. A build without them cannot draw a room holding one: its
// binding stops on the first formula and shows an empty or stale page, and
// as the web app or the phone it could then report that page as the room's
// text and push it over the stored copy. The room of a document with front
// matter is the other case: it holds only the body, and 0.9.4's desktop
// writes its file from a live room with nothing in front, deleting the YAML.
// So a room records the oldest schema that can represent it (2 for both),
// every client says which it can represent, and the server keeps a client
// out of a room that has moved past it:
//
//   * The ticket request carries `schema` (src/lib/auth-client.ts and the
//     phone's api.ts send it; a build from before sends `{}`, which reads
//     as 1). A room that needs more answers 409, which every build takes as
//     "no live session" and opens the document on its own copy.
//   * The ticket keeps the schema, so the socket knows it. A socket that
//     came in on the account's token (a build from before tickets) is 1.
//   * The moment an update puts the room past a socket's schema, that socket
//     is closed before the update is passed on, so an old build never even
//     receives a node it cannot represent. Anything it sends after that is
//     dropped. Builds from before this gate stop only on 4403 (they read it
//     as access removed and lock the page); newer ones get 4426 and go back
//     to their own copy.
//
// A room's schema is the higher of what its meta map records (RichView
// stamps 2 as the first formula arrives, and for front matter) and what its
// content needs, read from the content itself when a room is loaded and from
// each update as it arrives, so a client that forgets the stamp cannot open
// the door. A recorded stamp above the schemas this server knows is ignored,
// so one editor cannot lock a room. The schema only rises; deleting the
// document drops the room with it.
//
// One more rule lives here: a room is seeded or brought up to date from an
// older build's shape exactly once. The update that does it claims the
// room's editor model (MODEL_KEY); the server takes the first claim and drops
// any later one, so two clients migrating the same room at once cannot both
// add their copy of every formula (src/lib/room-migration-update.ts).
import * as Y from "yjs";

export const SCHEMA_KEY = "schemaVersion";
/**
 * Set once, by the client that seeded a room or brought an older room up to
 * date (src/lib/rich-room-migrate.ts). The server lets exactly one update
 * set it: two clients bringing the same room up to date at once would each
 * insert their own copy of every formula, so the second is dropped.
 */
export const MODEL_KEY = "editorModel";
/** Every room content up to desktop 0.9.4, and every plain text room. */
export const ROOM_SCHEMA_PLAIN = 1;
/** A rich room holding a math node. */
export const ROOM_SCHEMA_MATH = 2;
/** What a client that says nothing can represent: a build from before this gate. */
export const LEGACY_CLIENT_SCHEMA = 1;
/** The close code a client that knows this gate reads as "this room needs a newer Markie". */
export const CLOSE_ROOM_TOO_NEW = 4426;
/** Access removed: the only 4xxx code builds from before this gate stop on. */
export const CLOSE_ACCESS_REVOKED = 4403;

const MATH_NODES = new Set(["mathInline", "mathBlock"]);

/** The schema a ticket request says its client can represent. */
export function clientSchemaFrom(body: unknown): number {
  const value = body && typeof body === "object" ? (body as { schema?: unknown }).schema : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return LEGACY_CLIENT_SCHEMA;
  // Far beyond anything real; keeps a silly number out of the table.
  return Math.min(value, 1000);
}

/**
 * What the room's meta map records, or 0. Only the schemas this server
 * knows count: any editor can write the meta map, and a stamp of 999 must
 * not lock the room for everyone. A future schema raises this bound with it.
 */
export function recordedSchema(ydoc: Y.Doc): number {
  const value = ydoc.getMap("meta").get(SCHEMA_KEY);
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= ROOM_SCHEMA_MATH ? value : 0;
}

/** Whether the room has been seeded or brought up to date by a build that knows math nodes. */
export function hasEditorModel(ydoc: Y.Doc): boolean {
  return ydoc.getMap("meta").get(MODEL_KEY) !== undefined;
}

/**
 * Whether one update sets the room's editor model (MODEL_KEY in the meta
 * map): a seed or a migration. Read from the update's own structs.
 */
export function updateClaimsModel(update: Uint8Array): boolean {
  try {
    const { structs } = Y.decodeUpdate(update);
    for (const struct of structs) {
      const item = struct as { parent?: unknown; parentSub?: unknown };
      if (item.parent === "meta" && item.parentSub === MODEL_KEY) return true;
    }
  } catch {
    // Not an update this can read.
  }
  return false;
}

/** Whether the rich fragment holds a node only schema 2 can represent. */
export function holdsMathNodes(ydoc: Y.Doc): boolean {
  const fragment = ydoc.getXmlFragment("default");
  if (fragment.length === 0) return false;
  // Only elements are looked into: a room whose "default" was written as
  // text by something else holds strings here, and is not a rich room.
  // Pushed one by one: spreading a node's children into push() overflows
  // the call stack past about 125,000 of them.
  const stack: unknown[] = fragment.toArray();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!(node instanceof Y.XmlElement)) continue;
    if (MATH_NODES.has(node.nodeName)) return true;
    for (const child of node.toArray()) stack.push(child);
  }
  return false;
}

/** The schema a room's whole state needs: on load, once. */
export function schemaOfRoom(ydoc: Y.Doc): number {
  return Math.max(recordedSchema(ydoc), holdsMathNodes(ydoc) ? ROOM_SCHEMA_MATH : 0);
}

/**
 * Whether one update inserts a node only schema 2 can represent. Read from
 * the update's own structs, so it costs what the update costs, not what the
 * document does.
 */
export function updateAddsMath(update: Uint8Array): boolean {
  try {
    const { structs } = Y.decodeUpdate(update);
    for (const struct of structs) {
      const content = (struct as { content?: { type?: unknown } }).content;
      const type = content?.type;
      if (type instanceof Y.XmlElement && MATH_NODES.has(type.nodeName)) return true;
    }
  } catch {
    // Not an update this can read; the meta map and the next load still are.
  }
  return false;
}

/** The close code for a socket the room has moved past. */
export function closeCodeFor(clientSchema: number): number {
  return clientSchema >= ROOM_SCHEMA_MATH ? CLOSE_ROOM_TOO_NEW : CLOSE_ACCESS_REVOKED;
}

// The ticket route (collab-tickets.ts) asks for a room's schema, and only
// collab.ts holds the rooms and their update log; collab.ts imports the
// ticket module, so it hands the lookup over here rather than the other way
// round. Until it does (a process with no collab socket), every room is open.
let lookup: (docId: string) => number = () => 0;

export function setRoomSchemaLookup(fn: (docId: string) => number): void {
  lookup = fn;
}

/**
 * The schema `docId`'s room needs, 0 for a room with nothing in it. A room
 * that cannot be read is taken to need math: that keeps out only the builds
 * that could be hurt by it.
 */
export function roomSchemaFor(docId: string): number {
  try {
    return lookup(docId);
  } catch {
    return ROOM_SCHEMA_MATH;
  }
}
