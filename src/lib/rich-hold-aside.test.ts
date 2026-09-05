import { describe, expect, it } from "vitest";
import { extractHoldAsides, restoreHoldAsides } from "@/lib/rich-hold-aside";

const roundTrip = (md: string) => {
  const { text, holds } = extractHoldAsides(md);
  return { text, holds, back: restoreHoldAsides(text, holds) };
};

describe("extractHoldAsides", () => {
  it("lifts a block-level HTML comment and restores it verbatim", () => {
    const md = "before\n\n<!-- keep\nme -->\n\nafter\n";
    const { text, holds, back } = roundTrip(md);
    expect(holds).toHaveLength(1);
    expect(holds[0].kind).toBe("html-comment");
    expect(text).not.toContain("<!--");
    expect(text).toMatch(/markie-hold-\d+-[0-9a-f]{8}/);
    expect(back).toBe(md);
  });

  it("lifts a raw HTML block (start tag to blank line) verbatim", () => {
    const md = "intro\n\n<div class=\"warn\">\n<b>html</b>\n</div>\n\noutro\n";
    const { holds, back } = roundTrip(md);
    expect(holds).toHaveLength(1);
    expect(holds[0].kind).toBe("raw-html");
    expect(holds[0].source).toBe("<div class=\"warn\">\n<b>html</b>\n</div>\n");
    expect(back).toBe(md);
  });

  it("leaves one sized picture or clip on its own line to the editor", () => {
    // The editor has a node for these (rich-extensions.ts) and writes them
    // back the same way. Held aside, the picture would vanish from the pane.
    for (const tag of [
      '<img src="demo/shot.png" alt="beside" width="240">',
      '<video src="demo/clip.mp4" width="320" controls></video>',
    ]) {
      const md = `before\n\n${tag}\n\nafter\n`;
      const { holds, text } = extractHoldAsides(md);
      expect(holds).toHaveLength(0);
      expect(text).toBe(md);
    }
  });

  it("still holds a media tag that is part of something wider", () => {
    for (const block of [
      '<img src="a.png">\n<img src="b.png">\n',
      '<div><img src="a.png"></div>\n',
      '<img src="a.png"> with words after it\n',
    ]) {
      const md = `before\n\n${block}\nafter\n`;
      const { holds, back } = roundTrip(md);
      expect(holds, block).toHaveLength(1);
      expect(holds[0].kind).toBe("raw-html");
      expect(back).toBe(md);
    }
  });

  it("lifts a footnote definition with its indented continuation", () => {
    const md = "Text.[^1]\n\n[^1]: the note\n    continued\n\nmore\n";
    const { holds, back } = roundTrip(md);
    expect(holds).toHaveLength(1);
    expect(holds[0].kind).toBe("footnote-def");
    expect(holds[0].source).toBe("[^1]: the note\n    continued\n");
    expect(back).toBe(md);
  });

  it("never extracts from inside fenced code", () => {
    const md = "```html\n<!-- not a comment to us -->\n<div>x</div>\n```\n";
    const { holds, back } = roundTrip(md);
    expect(holds).toHaveLength(0);
    expect(back).toBe(md);
  });

  it("leaves inline HTML and inline footnote references alone", () => {
    const md = "Some <b>bold</b> text with a note[^1] inline.\n";
    const { holds, text } = extractHoldAsides(md);
    expect(holds).toHaveLength(0);
    expect(text).toBe(md);
  });

  it("a deleted placeholder deletes the held block", () => {
    const md = "a\n\n<!-- gone -->\n\nb\n";
    const { text, holds } = extractHoldAsides(md);
    const edited = text.replace(/markie-hold-\d+-[0-9a-f]{8}\n\n/, "");
    expect(restoreHoldAsides(edited, holds)).not.toContain("<!--");
  });

  it("extracts multiple constructs in order with distinct tokens", () => {
    const md = "<!-- one -->\n\n<div>\nx\n</div>\n\n[^a]: n\n";
    const { text, holds, back } = roundTrip(md);
    expect(holds.map((h) => h.kind)).toEqual([
      "html-comment",
      "raw-html",
      "footnote-def",
    ]);
    expect(new Set(holds.map((h) => h.token)).size).toBe(3);
    expect(back).toBe(md);
    expect(text).not.toMatch(/[<>[]/);
  });
});
