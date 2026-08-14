import { describe, expect, it } from "vitest";
import {
  applyReplacements,
  findMatches,
  matchAtOrAfter,
  matchLabel,
  stepMatch,
} from "./doc-search";

describe("finding text in a document", () => {
  it("finds every occurrence, left to right", () => {
    expect(findMatches("one two one", "one")).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 11 },
    ]);
  });

  it("ignores case by default and respects it when asked", () => {
    expect(findMatches("Cat cat CAT", "cat")).toHaveLength(3);
    expect(findMatches("Cat cat CAT", "cat", { caseSensitive: true })).toEqual([
      { from: 4, to: 7 },
    ]);
  });

  it("returns nothing for an empty query rather than matching everywhere", () => {
    expect(findMatches("anything", "")).toEqual([]);
  });

  // Overlapping matches cannot be stepped through or replaced coherently:
  // replacing both would corrupt the text.
  it("does not overlap matches", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
  });

  // A markdown document is full of regex punctuation, so the query has to be
  // literal or searching for "a.b" would match "axb".
  it("treats the query as literal text, not a pattern", () => {
    expect(findMatches("axb a.b", "a.b")).toEqual([{ from: 4, to: 7 }]);
    expect(findMatches("cost is $5 (approx)", "$5 (approx)")).toHaveLength(1);
    expect(findMatches("a*b", "*")).toEqual([{ from: 1, to: 2 }]);
  });

  it("matches across accents and non-latin scripts", () => {
    expect(findMatches("café CAFÉ", "café")).toHaveLength(2);
    expect(findMatches("наш дом", "дом")).toHaveLength(1);
  });

  describe("whole word", () => {
    it("skips matches inside longer words", () => {
      expect(findMatches("cat concatenate cat", "cat", { wholeWord: true })).toEqual([
        { from: 0, to: 3 },
        { from: 16, to: 19 },
      ]);
    });

    // Stepping past a rejected match by its whole length would swallow a real
    // match that begins one character later.
    it("still finds a real word right after a rejected one", () => {
      expect(findMatches("xxcat cat", "cat", { wholeWord: true })).toEqual([
        { from: 6, to: 9 },
      ]);
    });

    it("counts punctuation and whitespace as boundaries, digits as word", () => {
      expect(findMatches("(cat) cat.", "cat", { wholeWord: true })).toHaveLength(2);
      expect(findMatches("cat5", "cat", { wholeWord: true })).toEqual([]);
      expect(findMatches("cat_x", "cat", { wholeWord: true })).toEqual([]);
    });
  });
});

describe("stepping between matches", () => {
  it("wraps forwards and backwards", () => {
    expect(stepMatch(3, 0, 1)).toBe(1);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
  });

  it("starts at either end when nothing is current yet", () => {
    expect(stepMatch(3, -1, 1)).toBe(0);
    expect(stepMatch(3, -1, -1)).toBe(2);
  });

  it("has nothing to step to when there are no matches", () => {
    expect(stepMatch(0, -1, 1)).toBe(-1);
    expect(stepMatch(0, 0, -1)).toBe(-1);
  });
});

describe("picking the first match from the caret", () => {
  const matches = [
    { from: 5, to: 8 },
    { from: 20, to: 23 },
  ];

  it("lands on the next match after the caret", () => {
    expect(matchAtOrAfter(matches, 0)).toBe(0);
    expect(matchAtOrAfter(matches, 9)).toBe(1);
  });

  it("wraps to the top when the caret is past the last match", () => {
    expect(matchAtOrAfter(matches, 999)).toBe(0);
  });

  it("reports nothing when there is nothing to find", () => {
    expect(matchAtOrAfter([], 0)).toBe(-1);
  });
});

describe("the count shown under the box", () => {
  it("counts from one, the way people do", () => {
    expect(matchLabel(12, 2)).toBe("3 of 12");
  });

  it("says so plainly when there is nothing", () => {
    expect(matchLabel(0, -1)).toBe("No results");
  });
});

describe("replacing", () => {
  it("replaces every match", () => {
    const text = "one two one";
    const out = applyReplacements(text, findMatches(text, "one"), "1");
    expect(out).toBe("1 two 1");
  });

  // Replacing left to right would invalidate every later position as soon as
  // the replacement changed the length.
  it("survives a replacement longer than what it replaces", () => {
    const text = "a a a";
    const out = applyReplacements(text, findMatches(text, "a"), "LONGER");
    expect(out).toBe("LONGER LONGER LONGER");
  });

  it("replaces one match without touching the others", () => {
    const text = "one two one";
    const matches = findMatches(text, "one");
    expect(applyReplacements(text, [matches[1]], "1")).toBe("one two 1");
  });

  it("can replace with nothing", () => {
    const text = "keep drop keep";
    expect(applyReplacements(text, findMatches(text, "drop "), "")).toBe(
      "keep keep"
    );
  });

  it("does not re-match its own replacement", () => {
    const text = "aa";
    const out = applyReplacements(text, findMatches(text, "a"), "aa");
    expect(out).toBe("aaaa");
  });
});
