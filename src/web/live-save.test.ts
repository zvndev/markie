import { describe, expect, it } from "vitest";
import { RoomTexts, resolveLiveConflict, textFingerprint } from "./live-save";

// A refused save during a live session: a peer's room state may be saved
// over, a version written from outside the room never is.

describe("resolveLiveConflict", () => {
  const room = new RoomTexts();
  room.add("# Notes\n\nA");
  room.add("# Notes\n\nA B");

  it("takes the server's version when it already holds this text", () => {
    expect(resolveLiveConflict({ content: "# Notes\n\nA B C", name: "n.md" }, { content: "# Notes\n\nA B C", name: "n.md" }, room)).toBe("adopt");
  });

  it("saves the merged text over a version a peer wrote from the room", () => {
    expect(resolveLiveConflict({ content: "# Notes\n\nA B", name: "n.md" }, { content: "# Notes\n\nA B C", name: "n.md" }, room)).toBe("write");
  });

  it("never saves over a version with text the room never had", () => {
    // An agent's MCP write, the phone, another device outside the session.
    expect(resolveLiveConflict({ content: "# Notes\n\nAgent rewrote this", name: "n.md" }, { content: "# Notes\n\nA B C", name: "n.md" }, room)).toBe("conflict");
    // A rename elsewhere is not something to save over either.
    expect(resolveLiveConflict({ content: "# Notes\n\nA B", name: "renamed.md" }, { content: "# Notes\n\nA B C", name: "n.md" }, room)).toBe("conflict");
  });
});

describe("RoomTexts", () => {
  it("is bounded, forgetting the oldest first", () => {
    const room = new RoomTexts(3);
    for (const text of ["a", "b", "c", "d"]) room.add(text);
    expect(room.has("a")).toBe(false);
    expect(room.has("d")).toBe(true);
    room.add("b"); // seen again: now the newest
    room.add("e");
    expect(room.has("b")).toBe(true);
    expect(room.has("c")).toBe(false);
  });

  it("fingerprints distinguish near texts", () => {
    expect(textFingerprint("abc")).not.toBe(textFingerprint("abd"));
    expect(textFingerprint("")).toBe(textFingerprint(""));
  });
});
