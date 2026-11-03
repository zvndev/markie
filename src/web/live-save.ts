// What a save refused with 409 during a live session may do (web-document.tsx).
//
// The web app has no file of its own, so unlike the desktop it must keep
// saving the document's snapshot while live: the hosted page, the phone and
// agents read that snapshot. Peers in the same room save the same converged
// text a moment apart, so a refusal is routine there, and the merged text may
// go over a version a peer wrote. A version written from outside the room
// (an agent through MCP, the phone, another device not in the session) holds
// text the room never had, and saving over it would silently drop that edit.
//
// So the tab remembers fingerprints of the texts it has seen in the room, its
// own edits and its peers' alike, and saves over the server's version only
// when that version's text is one of them. Anything else is surfaced as a
// conflict, which is never wrong: at worst it asks about a peer's save that
// raced ahead of what this tab had seen.

/** A 53-bit fingerprint of a text (cyrb53): cheap, and never stored or sent. */
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

/** The texts this tab has seen in the room, newest last, bounded. */
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
  /** A peer's room state: save the merged text over it. */
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
