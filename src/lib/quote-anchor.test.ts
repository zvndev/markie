// A quote anchor is how a comment made on the phone's reading screen lands
// on the same sentence on the desktop. These pin down the contract both sides
// (and the Rust port) follow: what is remembered, and how it is found again.
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_START_POSITION,
  QUOTE_CONTEXT_MAX,
  QUOTE_EXACT_MAX,
  collapseWhitespace,
  describeQuote,
  isQuoteAnchor,
  locateQuote,
  quoteAnchor,
  quoteOf,
  type Quote,
} from "./quote-anchor";

const DOC = [
  "Launch plan",
  "We ship the beta on Friday. The budget is tight.",
  "Risks",
  "The budget is tight because hosting doubled. We ship the fix next week.",
].join("\n");

function quoteFor(text: string, words: string, nth = 0): Quote {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(words, at + 1);
  expect(at, `"${words}" #${nth} is in the text`).toBeGreaterThan(-1);
  return describeQuote(text, at, at + words.length)!;
}

function placed(text: string, quote: Quote): string | null {
  const range = locateQuote(text, quote);
  return range ? text.slice(range.start, range.end) : null;
}

describe("describing a selection", () => {
  it("keeps the words and a little of what is on each side", () => {
    const quote = quoteFor(DOC, "beta on Friday");
    expect(quote.exact).toBe("beta on Friday");
    expect(quote.prefix.endsWith("We ship the")).toBe(true);
    expect(quote.suffix.startsWith(". The budget")).toBe(true);
    expect(quote.prefix.length).toBeLessThanOrEqual(QUOTE_CONTEXT_MAX);
    expect(quote.suffix.length).toBeLessThanOrEqual(QUOTE_CONTEXT_MAX);
  });

  it("trims the selection and collapses the whitespace inside it", () => {
    const text = "One.\n\n  Two   words\there.  \nThree.";
    const quote = describeQuote(text, 4, text.indexOf("Three"))!;
    expect(quote.exact).toBe("Two words here.");
    expect(quote.prefix).toBe("One.");
    expect(quote.suffix).toBe("Three.");
  });

  it("counts what stood before it without the whitespace", () => {
    expect(describeQuote("a b\n\nc d", 7, 8)!.approxIndex).toBe(3);
  });

  it("has nothing to say about a selection of only whitespace", () => {
    expect(describeQuote("a   b", 1, 4)).toBeNull();
    expect(describeQuote("abc", 2, 2)).toBeNull();
  });

  it("takes the ends in either order and stays inside the text", () => {
    expect(describeQuote("Hello world", 99, 6)!.exact).toBe("world");
    expect(describeQuote("Hello world", -5, 5)!.exact).toBe("Hello");
  });

  it("keeps the start of a selection too long to carry", () => {
    const text = `Intro. ${"word ".repeat(600)}Outro.`;
    const quote = describeQuote(text, 7, text.length)!;
    expect(quote.exact.length).toBeLessThanOrEqual(QUOTE_EXACT_MAX);
    expect(quote.exact.startsWith("word word")).toBe(true);
    expect(placed(text, quote)!.startsWith("word word")).toBe(true);
  });

  it("never cuts an emoji in half at the limit", () => {
    const text = "x".repeat(QUOTE_EXACT_MAX - 1) + "😀 tail";
    const quote = describeQuote(text, 0, text.length)!;
    expect(quote.exact).toBe("x".repeat(QUOTE_EXACT_MAX - 1));
  });
});

describe("finding the words again", () => {
  it("finds them where they were", () => {
    expect(placed(DOC, quoteFor(DOC, "beta on Friday"))).toBe("beta on Friday");
  });

  it("picks the right repeat of a phrase by what surrounds it", () => {
    for (const nth of [0, 1]) {
      const quote = quoteFor(DOC, "The budget is tight", nth);
      const range = locateQuote(DOC, quote)!;
      let at = -1;
      for (let i = 0; i <= nth; i++) at = DOC.indexOf("The budget is tight", at + 1);
      expect(range).toEqual({ start: at, end: at + "The budget is tight".length });
    }
  });

  it("picks the right repeat of a single short word", () => {
    const quote = quoteFor(DOC, "ship", 1);
    const range = locateQuote(DOC, quote)!;
    expect(DOC.slice(range.start, range.end + 8)).toBe("ship the fix");
  });

  it("does not care how the renderer separates blocks", () => {
    // The phone reads rendered HTML, the desktop a ProseMirror document: the
    // same words with different whitespace between blocks and around marks.
    const quote = quoteFor(DOC, "Friday. The budget is tight.\nRisks\nThe budget");
    expect(quote.exact).toBe("Friday. The budget is tight. Risks The budget");
    const other = DOC.replace(/\n/g, "\n\n  ");
    expect(collapseWhitespace(placed(other, quote)!)).toBe(quote.exact);
    const none = DOC.replace(/\n/g, "");
    expect(placed(none, quote)).toBe("Friday. The budget is tight.RisksThe budget");
  });

  it("returns offsets into the text it was given, whitespace and all", () => {
    const text = "  Alpha\n\n\tBeta  gamma​ delta  ";
    const range = locateQuote(text, { exact: "Beta gamma delta", prefix: "Alpha", suffix: "", approxIndex: 5 })!;
    expect(text.slice(range.start, range.end)).toBe("Beta  gamma​ delta");
  });

  it("follows the words when text is added or removed before them", () => {
    const quote = quoteFor(DOC, "hosting doubled");
    const edited = DOC.replace("Launch plan", "Launch plan, second draft, with a much longer title than before");
    expect(placed(edited, quote)).toBe("hosting doubled");
    expect(placed(DOC.replace("We ship the beta on Friday. ", ""), quote)).toBe("hosting doubled");
  });

  it("survives an edit right beside the words, on one side", () => {
    const quote = quoteFor(DOC, "beta");
    expect(placed(DOC.replace("ship the beta", "ship our beta"), quote)).toBe("beta");
    expect(placed(DOC.replace("beta on Friday", "beta this Friday"), quote)).toBe("beta");
  });

  it("keeps a long quote that appears once, even with both sides rewritten", () => {
    const quote = quoteFor(DOC, "hosting doubled");
    const edited = DOC.replace("tight because hosting doubled. We", "tight. Our hosting doubled, so we");
    expect(placed(edited, quote)).toBe("hosting doubled");
  });

  it("says it lost its place when the words are gone", () => {
    const quote = quoteFor(DOC, "hosting doubled");
    expect(locateQuote(DOC.replace("hosting doubled", "costs rose"), quote)).toBeNull();
    expect(locateQuote("", quote)).toBeNull();
  });

  it("does not move to another copy of the phrase when its own sentence is deleted", () => {
    const text = `${DOC}\nSummary\nIn short: The budget is tight, and so is time.`;
    const quote = quoteFor(text, "The budget is tight", 0);
    const edited = text.replace("We ship the beta on Friday. The budget is tight.", "Nothing to report.");
    // Two copies are left, each in a different sentence from the one that
    // was commented on. Neither is it, so the thread is unplaced.
    expect(edited.split("The budget is tight").length - 1).toBe(2);
    expect(locateQuote(edited, quote)).toBeNull();
  });

  it("does not guess between repeats that all lost their surroundings", () => {
    const text = "red fish. blue fish. old fish. new fish.";
    const quote: Quote = { exact: "fish", prefix: "one", suffix: "two", approxIndex: 3 };
    expect(locateQuote(text, quote)).toBeNull();
  });

  it("does not hang a short word on its only other use", () => {
    const quote = quoteFor("We met on Monday to plan.", "plan");
    expect(locateQuote("A plan was made later.", quote)).toBeNull();
  });

  it("uses where the words were to choose between identical surroundings", () => {
    const row = "| yes | yes | yes | yes |";
    const text = `${row}\n${row}\n${row}`;
    const at = text.indexOf("yes", row.length * 2);
    const quote = describeQuote(text, at, at + 3)!;
    expect(locateQuote(text, quote)).toEqual({ start: at, end: at + 3 });
  });

  it("places a quote that is the whole document", () => {
    const quote = describeQuote("Hi", 0, 2)!;
    expect(quote).toEqual({ exact: "Hi", prefix: "", suffix: "", approxIndex: 0 });
    expect(locateQuote("Hi", quote)).toEqual({ start: 0, end: 2 });
  });

  it("handles a phrase that overlaps itself", () => {
    const text = "aaaa aaaa";
    const quote = describeQuote(text, 5, 7)!;
    expect(locateQuote(text, quote)).toEqual({ start: 5, end: 7 });
  });
});

describe("the anchor on the wire", () => {
  it("is tagged, carries the quote, and keeps from and to for older clients", () => {
    const quote = quoteFor(DOC, "beta on Friday");
    const anchor = quoteAnchor(quote);
    expect(anchor).toEqual({ kind: "quote", ...quote, from: DOCUMENT_START_POSITION, to: DOCUMENT_START_POSITION });
    // As the server stores it and hands it back.
    const wire = JSON.parse(JSON.stringify(anchor));
    expect(isQuoteAnchor(wire)).toBe(true);
    expect(quoteOf(wire)).toEqual(quote);
    expect(wire.from).toEqual({ tname: "default", assoc: -1 });
    expect(wire.to).toEqual({ tname: "default", assoc: -1 });
  });

  it("reads the quote off a live-room anchor that carries one", () => {
    const anchor = { from: { item: 1 }, to: { item: 2 }, exact: "beta", prefix: "the ", suffix: " on", approxIndex: 20 };
    expect(isQuoteAnchor(anchor)).toBe(false);
    expect(quoteOf(anchor)).toEqual({ exact: "beta", prefix: "the ", suffix: " on", approxIndex: 20 });
  });

  it("finds no quote in an anchor from before quotes, or in junk", () => {
    expect(quoteOf({ from: { item: 1 }, to: { item: 2 } })).toBeNull();
    expect(quoteOf(null)).toBeNull();
    expect(quoteOf("quote")).toBeNull();
    expect(quoteOf({ kind: "quote" })).toBeNull();
    expect(quoteOf({ kind: "quote", exact: "   " })).toBeNull();
    expect(quoteOf({ kind: "quote", exact: 7 })).toBeNull();
    expect(isQuoteAnchor({ kind: "quote", exact: "  " })).toBe(false);
  });

  it("fills in what a sparse anchor leaves out", () => {
    expect(quoteOf({ kind: "quote", exact: "beta", prefix: 3, approxIndex: "x" })).toEqual({ exact: "beta", prefix: "", suffix: "", approxIndex: 0 });
  });
});
