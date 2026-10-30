import { describe, expect, it } from "vitest";
import {
  activeSectionIndex,
  clipSnippet,
  extractSections,
  levelsThatFit,
  plainInline,
  railWanted,
  tickPitch,
} from "@/lib/section-outline";

const outline = (md: string) => extractSections(md).map(({ level, text, line }) => [level, text, line]);

describe("extractSections", () => {
  it("lists H1 to H3 with their lines and skips H4 and deeper", () => {
    const md = ["# Title", "", "Intro.", "", "## Part", "### Detail", "#### Deep", "##### Deeper"].join("\n");
    expect(outline(md)).toEqual([
      [1, "Title", 0],
      [2, "Part", 4],
      [3, "Detail", 5],
    ]);
  });

  it("ignores hashes inside fenced code, both fence kinds and longer fences", () => {
    const md = [
      "# Real",
      "```sh",
      "# a shell comment",
      "```",
      "~~~",
      "## not a heading",
      "~~~",
      "````md",
      "```",
      "# still code, the inner fence is shorter",
      "```",
      "````",
      "## After",
    ].join("\n");
    expect(outline(md)).toEqual([
      [1, "Real", 0],
      [2, "After", 12],
    ]);
  });

  it("treats an unclosed fence as code to the end", () => {
    expect(outline("# One\n```\n# two\n## three")).toEqual([[1, "One", 0]]);
  });

  it("reads setext headings, including multi-line ones", () => {
    const md = ["Title", "=====", "", "Part one", "continues here", "---", "", "text", "", "---", "", "Not a heading after a break"].join("\n");
    expect(outline(md)).toEqual([
      [1, "Title", 0],
      [2, "Part one continues here", 3],
    ]);
  });

  it("does not turn a list item or quote above a rule into a heading", () => {
    expect(outline("- item\n---\n> quote\n---\n| a | b |\n|---|---|")).toEqual([]);
  });

  it("skips front matter but counts its lines", () => {
    const md = ["---", "title: x", "# not a heading", "---", "# Heading", "body"].join("\n");
    expect(outline(md)).toEqual([[1, "Heading", 4]]);
  });

  it("skips headings inside HTML comments", () => {
    const md = ["<!-- markie:tab", "# hidden", "-->", "# Shown", "<!-- one line --> ", "## Also"].join("\n");
    expect(outline(md)).toEqual([
      [1, "Shown", 3],
      [2, "Also", 5],
    ]);
  });

  it("keeps duplicate headings as separate sections", () => {
    const md = ["## Notes", "first", "## Notes", "second"].join("\n");
    const sections = extractSections(md);
    expect(sections.map((s) => [s.text, s.line, s.snippet])).toEqual([
      ["Notes", 0, "first"],
      ["Notes", 2, "second"],
    ]);
  });

  it("needs a space after the hashes, strips closing hashes and inline markdown, and skips empty headings", () => {
    const md = ["#hashtag", "## **Bold** and `code` ##", "### [Link](https://x.y) _it_", "#", "## ##"].join("\n");
    expect(outline(md)).toEqual([
      [2, "Bold and code", 1],
      [3, "Link it", 2],
    ]);
  });

  it("does not take headings indented as code", () => {
    expect(outline("    # code\n   # three spaces")).toEqual([[1, "three spaces", 1]]);
  });

  it("previews the start of each section as plain text, reading on into its subsections", () => {
    const md = [
      "## Intro",
      "",
      "Some **bold** words and a [link](https://example.com).",
      "",
      "- a list item",
      "> a quote",
      "#### Sub",
      "more",
      "## Next",
      "```",
      "code is not preview text",
      "```",
      "Prose.",
    ].join("\n");
    const [intro, next] = extractSections(md);
    expect(intro.snippet).toBe("Some bold words and a link. a list item a quote Sub more");
    expect(next.snippet).toBe("Prose.");
  });

  it("previews a heading that is followed straight by a subheading with the subsection", () => {
    const md = ["# Changelog", "## [1.2.0]", "### Added", "- Tabs.", "## [1.1.0]", "### Fixed", "- Crash."].join("\n");
    const [log, v12, added, v11] = extractSections(md);
    expect(v12.snippet).toBe("Added Tabs.");
    expect(added.snippet).toBe("Tabs.");
    expect(v11.snippet).toBe("Fixed Crash.");
    expect(log.snippet).toBe("[1.2.0] Added Tabs. [1.1.0] Fixed Crash.");
  });

  it("does not put a setext heading's own text into the previous preview", () => {
    const [first, second] = extractSections("## One\nbody\n\nTwo\n---\nmore");
    expect(first.snippet).toBe("body");
    expect(second).toMatchObject({ level: 2, text: "Two", snippet: "more" });
  });

  it("handles CRLF line endings", () => {
    expect(outline("# A\r\ntext\r\n## B\r\n")).toEqual([
      [1, "A", 0],
      [2, "B", 2],
    ]);
  });
});

describe("plainInline and clipSnippet", () => {
  it("removes images, links, emphasis, code, strikethrough and escapes", () => {
    expect(plainInline("![alt](a.png) [t](u) *a* __b__ ~~c~~ `d` \\#e <span>f</span>")).toBe("alt t a b c d #e f");
  });

  it("cuts long text on a word boundary with an ellipsis", () => {
    const text = "word ".repeat(100);
    const clipped = clipSnippet(text, 50);
    expect(clipped.length).toBeLessThanOrEqual(51);
    expect(clipped.endsWith("word…")).toBe(true);
    expect(clipSnippet("short")).toBe("short");
  });
});

describe("railWanted", () => {
  it("needs three headings and more than a screen and a half of content", () => {
    expect(railWanted(3, 1600, 1000)).toBe(true);
    expect(railWanted(2, 5000, 1000)).toBe(false);
    expect(railWanted(10, 1500, 1000)).toBe(false);
    expect(railWanted(10, 1500, 0)).toBe(false);
  });
});

describe("activeSectionIndex", () => {
  const tops = [0, 800, 1600, 2400];
  it("is the last heading at or above the reading line", () => {
    expect(activeSectionIndex(tops, 0, 1000, 3000)).toBe(0);
    expect(activeSectionIndex(tops, 750, 1000, 3000)).toBe(1);
    expect(activeSectionIndex(tops, 1550, 1000, 3000)).toBe(2);
  });

  it("is -1 above the first heading", () => {
    expect(activeSectionIndex([500, 900], 0, 1000, 3000)).toBe(-1);
    expect(activeSectionIndex([], 0, 1000, 3000)).toBe(-1);
  });

  it("lights the last section that is on screen at the end of the document", () => {
    expect(activeSectionIndex(tops, 2000, 1000, 3000)).toBe(3);
  });

  it("keeps a chosen section lit while its heading is at the top, even with a subheading close below", () => {
    const close = [0, 800, 840, 1600];
    expect(activeSectionIndex(close, 790, 1000, 3000)).toBe(2);
    expect(activeSectionIndex(close, 790, 1000, 3000, 1)).toBe(1);
    // Scrolled on past it: the pin no longer applies.
    expect(activeSectionIndex(close, 900, 1000, 3000, 1)).toBe(2);
    // At the end, a chosen section that cannot reach the top still wins.
    const tail = [0, 800, 1600, 2400, 2700];
    expect(activeSectionIndex(tail, 2000, 1000, 3000)).toBe(4);
    expect(activeSectionIndex(tail, 2000, 1000, 3000, 3)).toBe(3);
  });
});

describe("tickPitch and levelsThatFit", () => {
  it("keeps ticks 8px apart until the rail runs out of room, then tightens to 4px", () => {
    expect(tickPitch(10, 800)).toBe(8);
    expect(tickPitch(100, 600)).toBe(5);
    expect(tickPitch(300, 600)).toBeNull();
  });

  it("drops H3, then H2, while enough ticks remain", () => {
    const levels = [1, ...Array<2>(20).fill(2), ...Array<3>(200).fill(3)] as (1 | 2 | 3)[];
    expect(levelsThatFit(levels, 2000)).toBe(3);
    expect(levelsThatFit(levels, 400)).toBe(2);
    // One H1 and too many H2s: H1 alone is not an outline, so it scrolls with H2.
    expect(levelsThatFit(levels, 50)).toBe(2);
  });
});
