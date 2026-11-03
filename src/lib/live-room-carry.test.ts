import { describe, expect, it } from "vitest";
import { richRoomCannotCarry } from "@/lib/live-room-carry";

describe("richRoomCannotCarry", () => {
  it.each([
    ["front matter", "---\ntitle: x\n---\n\n# Doc\n"],
    ["a raw HTML block", "# Doc\n\n<div align=\"center\">\n  hi\n</div>\n"],
    ["an HTML comment", "# Doc\n\n<!-- note -->\n"],
    ["a footnote definition", "Text.[^1]\n\n[^1]: The note.\n"],
  ])("refuses a text with %s", (_label, text) => {
    expect(richRoomCannotCarry(text)).toBe(true);
  });

  it.each([
    ["plain markdown", "# Doc\n\n- one\n- two\n\n**bold** and `code`.\n"],
    ["HTML inside a code fence", "```html\n<div>x</div>\n<!-- c -->\n```\n"],
    ["an empty document", ""],
  ])("lets %s through", (_label, text) => {
    expect(richRoomCannotCarry(text)).toBe(false);
  });
});
