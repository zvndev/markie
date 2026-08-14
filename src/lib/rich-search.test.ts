import { describe, expect, it } from "vitest";
import { findMatches } from "./doc-search";
import { indexSegments, offsetToPos, rangesForMatches } from "./rich-search";

// Two runs of text in the same paragraph, as the rich editor stores
// "hello world" when half of it is bold. Positions are the editor's own: the
// paragraph opens at 0, so its first character sits at 1.
const boldHalf = [
  { pos: 1, text: "hello ", block: "p1" },
  { pos: 7, text: "world", block: "p1" },
];

// Two paragraphs. The second starts a new block.
const twoParagraphs = [
  { pos: 1, text: "end", block: "p1" },
  { pos: 6, text: "Start", block: "p2" },
];

describe("stitching the rich document into searchable text", () => {
  it("joins runs inside one block with nothing between them", () => {
    expect(indexSegments(boldHalf).text).toBe("hello world");
  });

  // Without the break, "end" + "Start" reads as "endStart" and a search for
  // "dSt" would match text that does not exist on screen.
  it("puts a line break between blocks", () => {
    expect(indexSegments(twoParagraphs).text).toBe("end\nStart");
  });

  it("ignores empty runs rather than emitting stray breaks", () => {
    const index = indexSegments([
      { pos: 1, text: "a", block: "p1" },
      { pos: 2, text: "", block: "p2" },
      { pos: 3, text: "b", block: "p1" },
    ]);
    expect(index.text).toBe("ab");
  });

  it("has nothing to search in an empty document", () => {
    expect(indexSegments([]).text).toBe("");
    expect(indexSegments([]).entries).toEqual([]);
  });
});

describe("mapping an offset back to an editor position", () => {
  const index = indexSegments(boldHalf);

  it("maps the start of the document", () => {
    expect(offsetToPos(index, 0)).toBe(1);
  });

  it("maps inside the first run", () => {
    expect(offsetToPos(index, 3)).toBe(4);
  });

  // Offset 6 is both the end of "hello " and the start of "world". Resolving to
  // the end of the earlier run keeps a match ending at a formatting change from
  // swallowing the first character of the next run.
  it("resolves a boundary to the end of the earlier run", () => {
    expect(offsetToPos(index, 6)).toBe(7);
  });

  it("maps inside the second run", () => {
    expect(offsetToPos(index, 8)).toBe(9);
  });

  it("refuses an offset that is not in the document", () => {
    expect(offsetToPos(index, -1)).toBeNull();
    expect(offsetToPos(index, 999)).toBeNull();
  });

  // The separator is not part of any run, so it has no position of its own.
  it("has no position for the break between blocks", () => {
    const index2 = indexSegments(twoParagraphs);
    expect(index2.text[3]).toBe("\n");
    expect(offsetToPos(index2, 4)).toBe(6);
  });
});

describe("matches found across formatting", () => {
  // The whole point: "hello world" is invisible to anything that searches one
  // formatting run at a time.
  it("finds a phrase that spans a bold boundary", () => {
    const index = indexSegments(boldHalf);
    const matches = findMatches(index.text, "hello world");
    expect(matches).toHaveLength(1);
    expect(rangesForMatches(index, matches)).toEqual([{ from: 1, to: 12 }]);
  });

  it("maps several matches in order", () => {
    const index = indexSegments([{ pos: 1, text: "one two one", block: "p1" }]);
    expect(rangesForMatches(index, findMatches(index.text, "one"))).toEqual([
      { from: 1, to: 4 },
      { from: 9, to: 12 },
    ]);
  });

  it("drops a match it cannot place rather than guessing a range", () => {
    const index = indexSegments(boldHalf);
    expect(rangesForMatches(index, [{ from: 500, to: 505 }])).toEqual([]);
    expect(rangesForMatches(index, [{ from: 3, to: 3 }])).toEqual([]);
  });

  it("finds nothing in an empty document without throwing", () => {
    const index = indexSegments([]);
    expect(rangesForMatches(index, findMatches(index.text, "anything"))).toEqual([]);
  });
});
