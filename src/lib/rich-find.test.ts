import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { findMatches } from "./doc-search";
import { collectSegments } from "./rich-find";
import { indexSegments, rangesForMatches } from "./rich-search";

// A document model small enough to reason about but shaped like the real one:
// nested blocks (list items hold paragraphs), a mark that splits text into
// runs, and a leaf node that holds no text at all.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*" },
    bullet_list: { group: "block", content: "list_item+" },
    list_item: { content: "paragraph+" },
    image: { group: "inline", inline: true },
    text: { group: "inline" },
  },
  marks: { bold: {} },
});

const { paragraph, heading, bullet_list, list_item, image, doc } = schema.nodes;
const bold = schema.marks.bold.create();
const t = (s: string) => schema.text(s);
const b = (s: string) => schema.text(s, [bold]);

describe("reading text out of the rich document", () => {
  it("gives each run the position the editor stores it at", () => {
    // <p> opens at 0, so "hi" starts at 1.
    const document = doc.create(null, [paragraph.create(null, [t("hi")])]);
    expect(collectSegments(document)).toEqual([
      { pos: 1, text: "hi", block: 0 },
    ]);
  });

  it("keeps the runs of one paragraph together", () => {
    const document = doc.create(null, [
      paragraph.create(null, [t("hello "), b("world")]),
    ]);
    const segments = collectSegments(document);
    expect(segments.map((s) => s.block)).toEqual([0, 0]);
    expect(indexSegments(segments).text).toBe("hello world");
  });

  it("separates runs that are in different blocks", () => {
    const document = doc.create(null, [
      heading.create(null, [t("Title")]),
      paragraph.create(null, [t("Body")]),
    ]);
    const segments = collectSegments(document);
    expect(new Set(segments.map((s) => s.block)).size).toBe(2);
    expect(indexSegments(segments).text).toBe("Title\nBody");
  });

  it("reaches text nested inside lists", () => {
    const document = doc.create(null, [
      bullet_list.create(null, [
        list_item.create(null, [paragraph.create(null, [t("first")])]),
        list_item.create(null, [paragraph.create(null, [t("second")])]),
      ]),
    ]);
    expect(indexSegments(collectSegments(document)).text).toBe("first\nsecond");
  });

  it("skips inline nodes that carry no text", () => {
    const document = doc.create(null, [
      paragraph.create(null, [t("before"), image.create(), t("after")]),
    ]);
    expect(collectSegments(document).map((s) => s.text)).toEqual([
      "before",
      "after",
    ]);
  });

  it("has nothing to report for an empty document", () => {
    expect(collectSegments(doc.create(null, [paragraph.create()]))).toEqual([]);
  });
});

describe("matches map back onto the document", () => {
  // The reason any of this exists: bold splits a sentence into two text nodes,
  // and searching them one at a time would never find a phrase that crosses the
  // boundary.
  it("finds a phrase that spans a formatting change", () => {
    const document = doc.create(null, [
      paragraph.create(null, [t("hello "), b("world")]),
    ]);
    const index = indexSegments(collectSegments(document));
    const ranges = rangesForMatches(index, findMatches(index.text, "lo wor"));
    expect(ranges).toEqual([{ from: 4, to: 10 }]);
    // The document itself agrees: those positions hold exactly that text.
    expect(document.textBetween(4, 10)).toBe("lo wor");
  });

  it("never lands on a range that spans a block boundary", () => {
    const document = doc.create(null, [
      paragraph.create(null, [t("end")]),
      paragraph.create(null, [t("Start")]),
    ]);
    const index = indexSegments(collectSegments(document));
    expect(findMatches(index.text, "endStart")).toEqual([]);
    expect(findMatches(index.text, "dSt")).toEqual([]);
  });

  it("places a match in the second of two paragraphs", () => {
    const document = doc.create(null, [
      paragraph.create(null, [t("one")]),
      paragraph.create(null, [t("two")]),
    ]);
    const index = indexSegments(collectSegments(document));
    const [range] = rangesForMatches(index, findMatches(index.text, "two"));
    expect(document.textBetween(range.from, range.to)).toBe("two");
  });

  it("places every match in a list", () => {
    const document = doc.create(null, [
      bullet_list.create(null, [
        list_item.create(null, [paragraph.create(null, [t("cat one")])]),
        list_item.create(null, [paragraph.create(null, [t("cat two")])]),
      ]),
    ]);
    const index = indexSegments(collectSegments(document));
    const ranges = rangesForMatches(index, findMatches(index.text, "cat"));
    expect(ranges).toHaveLength(2);
    for (const range of ranges) {
      expect(document.textBetween(range.from, range.to)).toBe("cat");
    }
  });
});
