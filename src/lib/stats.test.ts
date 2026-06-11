import { describe, it, expect } from "vitest";
import { computeStats } from "./stats";

describe("computeStats", () => {
  it("returns all zeros for empty content", () => {
    expect(computeStats("")).toEqual({
      words: 0,
      chars: 0,
      charsNoSpaces: 0,
      lines: 0,
      headings: 0,
      codeBlocks: 0,
      links: 0,
      readingTimeMin: 0,
    });
  });

  it("counts words, chars, and lines", () => {
    const s = computeStats("hello world\nsecond line");
    expect(s.words).toBe(4);
    expect(s.chars).toBe(23);
    expect(s.charsNoSpaces).toBe(20);
    expect(s.lines).toBe(2);
  });

  it("counts markdown structures", () => {
    const md = [
      "# Title",
      "## Sub",
      "a [link](https://x.com) and [two](https://y.com)",
      "```js",
      "code();",
      "```",
    ].join("\n");
    const s = computeStats(md);
    expect(s.headings).toBe(2);
    expect(s.links).toBe(2);
    expect(s.codeBlocks).toBe(1);
  });

  it("reading time is at least 1 minute for any non-empty text", () => {
    expect(computeStats("one two three").readingTimeMin).toBe(1);
  });

  it("reading time scales at 200 wpm", () => {
    const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    expect(computeStats(words).readingTimeMin).toBe(3);
  });
});
