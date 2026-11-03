import { describe, expect, it } from "vitest";
import { richRoomCannotCarry } from "@/lib/live-room-carry";
import { liveSnapshotRefusal } from "@/lib/live-snapshot";

// One table for every writer of a live document's text: the desktop's own
// file (richRoomCannotCarry, src/app/page.tsx) and the stored cloud copy the
// web app and the phone write (liveSnapshotRefusal). They must refuse exactly
// the same texts.
const REFUSED: Array<[string, string]> = [
  ["front matter", "---\ntitle: x\n---\n\n# Doc\n"],
  ["a raw HTML block", "# Doc\n\n<div align=\"center\">\n  hi\n</div>\n"],
  ["an HTML comment", "# Doc\n\n<!-- note -->\n"],
  ["a footnote definition", "Text.[^1]\n\n[^1]: The note.\n"],
];
const CARRIED: Array<[string, string]> = [
  ["plain markdown", "# Doc\n\n- one\n- two\n\n**bold** and `code`.\n"],
  ["HTML inside a code fence", "```html\n<div>x</div>\n<!-- c -->\n```\n"],
  ["an empty document", ""],
];

describe("one live-room rule for desktop, web and phone", () => {
  it.each(REFUSED)("refuses a text with %s", (_label, text) => {
    expect(richRoomCannotCarry(text)).toBe(true);
    expect(liveSnapshotRefusal(text, "rich")).toBe("held-constructs");
    // A plain text room is byte-faithful, so it carries anything.
    expect(liveSnapshotRefusal(text, "text")).toBeNull();
  });

  it.each(CARRIED)("lets %s through", (_label, text) => {
    expect(richRoomCannotCarry(text)).toBe(false);
    expect(liveSnapshotRefusal(text, "rich")).toBeNull();
  });
});
