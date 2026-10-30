import { describe, expect, it } from "vitest";
import {
  CONTEXT_CHARS,
  findAll,
  isAnchor,
  locateQuote,
  makeAnchor,
  resolveAnchor,
} from "./text-anchor.mjs";

const DOC = "# Plan\n\nShip the comments panel this week.\n\nThen ship the history panel.\n";

function anchorOn(text: string, quote: string, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(quote, at + 1);
  const anchor = makeAnchor(text, at, at + quote.length);
  if (!anchor) throw new Error("no anchor");
  return anchor;
}

describe("makeAnchor", () => {
  it("keeps the quote, its context on both sides, and where it was", () => {
    const a = anchorOn(DOC, "comments panel");
    expect(a.exact).toBe("comments panel");
    expect(a.prefix.length).toBeLessThanOrEqual(CONTEXT_CHARS);
    expect(a.prefix.endsWith("Ship the ")).toBe(true);
    expect(a.suffix.startsWith(" this week.")).toBe(true);
    expect(a.start).toBe(DOC.indexOf("comments panel"));
    expect(isAnchor(a)).toBe(true);
  });

  it("refuses an empty or out-of-range selection", () => {
    expect(makeAnchor(DOC, 3, 3)).toBeNull();
    expect(makeAnchor(DOC, -1, 4)).toBeNull();
    expect(makeAnchor(DOC, 0, DOC.length + 1)).toBeNull();
  });
});

describe("resolveAnchor", () => {
  it("finds the quote after an edit above it moves every offset", () => {
    const a = anchorOn(DOC, "comments panel");
    const edited = "Intro paragraph added by an agent.\n\n" + DOC;
    const hit = resolveAnchor(edited, a)!;
    expect(edited.slice(hit.start, hit.end)).toBe("comments panel");
    expect(hit.start).toBe(a.start + "Intro paragraph added by an agent.\n\n".length);
  });

  it("is unmoved by an edit below it", () => {
    const a = anchorOn(DOC, "comments panel");
    const hit = resolveAnchor(DOC + "\nMore at the end.\n", a)!;
    expect(hit.start).toBe(a.start);
  });

  it("tells duplicate quotes apart by their context", () => {
    // "ship the" twice, but only the second is followed by "history".
    const a = anchorOn(DOC, "ship the");
    expect(a.suffix.startsWith(" history")).toBe(true);
    // Swap the paragraphs so position alone would pick the wrong one.
    const swapped = "# Plan\n\nThen ship the history panel.\n\nShip the comments panel this week. Also ship the docs.\n";
    const hit = resolveAnchor(swapped, a)!;
    expect(swapped.slice(hit.end, hit.end + 8)).toBe(" history");
  });

  it("falls back to the nearest copy when the context matches none", () => {
    const text = "aaa word bbb\n".repeat(3);
    const a = { exact: "word", prefix: "zzz ", suffix: " yyy", start: text.lastIndexOf("word") };
    expect(resolveAnchor(text, a)!.start).toBe(text.lastIndexOf("word"));
  });

  it("detaches (null) when the quoted text is deleted", () => {
    const a = anchorOn(DOC, "comments panel");
    expect(resolveAnchor(DOC.replace("comments panel", "sidebar"), a)).toBeNull();
  });

  it("survives a rewrap that only changes whitespace", () => {
    const text = "One two three four five six.\n";
    const a = anchorOn(text, "three four five");
    const rewrapped = "One two three\nfour   five six.\n";
    const hit = resolveAnchor(rewrapped, a)!;
    expect(rewrapped.slice(hit.start, hit.end)).toBe("three\nfour   five");
  });

  it("rejects a malformed anchor instead of throwing", () => {
    expect(resolveAnchor(DOC, { exact: "", prefix: "", suffix: "", start: 0 })).toBeNull();
    expect(resolveAnchor(DOC, null as never)).toBeNull();
  });
});

describe("locateQuote (agent comments)", () => {
  const text = "Alpha beta.\nGamma beta.\nDelta beta.\n";

  it("finds a unique quote", () => {
    const at = locateQuote(text, "Gamma");
    expect(at).toMatchObject({ ok: true, start: text.indexOf("Gamma") });
  });

  it("refuses an ambiguous quote and says how to choose", () => {
    const at = locateQuote(text, "beta");
    expect(at.ok).toBe(false);
    if (!at.ok) {
      expect(at.count).toBe(3);
      expect(at.error).toMatch(/occurrence/);
    }
  });

  it("picks by occurrence, prefix or suffix", () => {
    expect(locateQuote(text, "beta", { occurrence: 2 })).toMatchObject({ ok: true, start: text.indexOf("beta", 10) });
    expect(locateQuote(text, "beta", { prefix: "Delta" })).toMatchObject({ ok: true, start: text.lastIndexOf("beta") });
    expect(locateQuote(text, "beta.", { suffix: "Gamma" })).toMatchObject({ ok: true, start: text.indexOf("beta") });
  });

  it("refuses an occurrence out of range and a quote that is not there", () => {
    expect(locateQuote(text, "beta", { occurrence: 4 }).ok).toBe(false);
    expect(locateQuote(text, "omega").ok).toBe(false);
    expect(locateQuote(text, "   ").ok).toBe(false);
  });

  it("matches a quote whose line breaks differ from the file", () => {
    const at = locateQuote("The quick brown\nfox jumps.", "quick brown fox");
    expect(at.ok).toBe(true);
  });
});

describe("findAll", () => {
  it("prefers exact matches over whitespace-loose ones", () => {
    expect(findAll("a b\na  b", "a b")).toEqual([{ start: 0, end: 3 }]);
  });
});
