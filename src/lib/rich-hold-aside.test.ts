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

describe("restoreHoldAsides", () => {
  it("puts a duplicated placeholder back as two copies of the block", () => {
    // Copying the placeholder line copies the block it stands for. That is
    // what the user did on screen, so it is what the file should say.
    const md = "a\n\n<!-- twice -->\n\nb\n";
    const { text, holds } = extractHoldAsides(md);
    const token = holds[0].token;
    const edited = text.replace(token, `${token}\n\n${token}`);
    const back = restoreHoldAsides(edited, holds);
    expect(back.match(/<!-- twice -->/g)).toHaveLength(2);
  });

  it("treats a token as literal text, never as a pattern", () => {
    // Tokens minted here are plain alphanumeric, but the lookup must not care:
    // a token holding regex punctuation matches only a line equal to it.
    const holds = [
      { token: "a.c", source: "<!-- held -->\n", kind: "html-comment" as const },
    ];
    expect(restoreHoldAsides("abc\n", holds)).toBe("abc\n");
    expect(restoreHoldAsides("a.c\n", holds)).toBe("<!-- held -->\n");
  });

  it("leaves an indented or extended placeholder line alone", () => {
    const md = "a\n\n<!-- keep -->\n\nb\n";
    const { text, holds } = extractHoldAsides(md);
    const token = holds[0].token;
    expect(restoreHoldAsides(text.replace(token, `  ${token}`), holds)).not.toContain(
      "<!--"
    );
    expect(restoreHoldAsides(text.replace(token, `${token} x`), holds)).not.toContain(
      "<!--"
    );
  });

  it("restores thousands of holds without rescanning the document each time", () => {
    // One whole-document replace per hold made this quadratic: a megabyte with
    // a couple of thousand comments or footnotes in it took seconds to
    // serialize, on every save. One pass over the lines does the same job.
    const filler = "lorem ipsum dolor sit amet consectetur ".repeat(13);
    const blocks: string[] = [];
    for (let i = 0; i < 2000; i += 1) {
      blocks.push(`${filler}\n\n<!-- hold ${i} -->\n\n`);
    }
    const md = blocks.join("");
    expect(md.length).toBeGreaterThan(1_000_000);

    const { text, holds } = extractHoldAsides(md);
    expect(holds).toHaveLength(2000);

    const started = performance.now();
    const back = restoreHoldAsides(text, holds);
    const elapsed = performance.now() - started;

    expect(back).toBe(md);
    expect(elapsed).toBeLessThan(200);
  });
});
