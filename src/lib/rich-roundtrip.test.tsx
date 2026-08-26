import { describe, expect, it } from "vitest";
import { probeRoundTrip, describeLossRisks } from "@/lib/rich-roundtrip";
import { splitFrontMatter, joinFrontMatter } from "@/lib/front-matter";
import { extractHoldAsides, restoreHoldAsides } from "@/lib/rich-hold-aside";

// Fixtures that MUST survive a parse-serialize round trip byte for byte
// (after Markie's deliberate table re-alignment, which the probe accepts).
const SAFE: Array<[string, string]> = [
  ["heading", "# Title\n\nBody text.\n"],
  ["nested list", "- one\n- two\n  - two.a\n"],
  ["fenced code", "```ts\nconst x = 1;\n```\n"],
  ["link and image", "[site](https://example.com)\n\n![alt](img.png)\n"],
  ["blockquote", "> quoted line\n"],
  ["simple table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n"],
  ["hr", "above\n\n---\n\nbelow\n"],
];

// Fixtures the current dependency set is expected to change when serialized
// raw. If one of these turns out to round-trip cleanly on this exact
// TipTap/tiptap-markdown version, move it to SAFE with a dated comment; the
// suite documents real behavior.
const LOSSY: Array<[string, string]> = [
  ["footnote", "Text with a note.[^1]\n\n[^1]: the note\n"],
  ["raw html block", "<div class=\"warn\">\n<b>html</b>\n</div>\n"],
  ["html comment", "before\n\n<!-- keep me -->\n\nafter\n"],
  ["display math", "$$\n\\frac{a}{b} \\, dx\n$$\n"],
  ["table alignment", "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n"],
  ["wrapped paragraph", "This paragraph is wrapped\nacross two lines.\n"],
  ["reference link", "See [the docs][ref].\n\n[ref]: https://example.com\n"],
  // Measured 2026-08-26 on tiptap-markdown 0.9.x: a tight task list comes back
  // LOOSE (a blank line between items) even with tightLists:true, because the
  // tightness pass does not reach taskItem nodes. Layer 2's run coalescing is
  // what keeps these documents editable.
  ["task list", "- [x] done\n- [ ] todo\n"],
  // Measured 2026-08-26: inline math backslashes double on serialize
  // ($e^{i\\pi}$ becomes $e^{i\\\\pi}$), the same escaping bug that corrupts
  // display math.
  ["inline math", "Euler: $e^{i\\pi}$ stays.\n"],
];

describe("probeRoundTrip", () => {
  for (const [name, md] of SAFE) {
    it(`round-trips: ${name}`, () => {
      const res = probeRoundTrip(md);
      expect(res.clean, `output was:\n${res.output}`).toBe(true);
    });
  }
  for (const [name, md] of LOSSY) {
    it(`detects raw loss: ${name}`, () => {
      expect(probeRoundTrip(md).clean).toBe(false);
    });
  }

  it("accepts table re-alignment as clean", () => {
    // Ragged pipes; formatMarkdownTables aligns them, which is Markie's
    // documented normalization on any rich edit.
    const ragged = "| a | b |\n|---|-----|\n| 1 | 2 |\n";
    expect(probeRoundTrip(ragged).clean).toBe(true);
  });
});

describe("describeLossRisks", () => {
  it("names each construct", () => {
    expect(describeLossRisks("x[^1]\n\n[^1]: n\n")).toContain("footnotes");
    expect(describeLossRisks("<div>x</div>\n")).toContain("raw-html");
    expect(describeLossRisks("<!-- c -->\n")).toContain("html-comments");
    expect(describeLossRisks("$$\nx\n$$\n")).toContain("display-math");
    expect(describeLossRisks("| a |\n| :--- |\n")).toContain("table-alignment");
    expect(describeLossRisks("---\nkey: v\n---\nbody\n")).toContain("front-matter");
    expect(describeLossRisks("[a][r]\n\n[r]: https://x.example\n")).toContain(
      "reference-links"
    );
  });
  it("finds nothing in plain prose", () => {
    expect(describeLossRisks("# T\n\nOne line.\n")).toEqual([]);
  });
});

describe("layer 1 pipeline (hold-aside)", () => {
  const PRESERVED: Array<[string, string]> = [
    [
      "front matter",
      "---\nmarkie:\n  project: Markie\n  block: organized-workspace\n---\n# Doc\n\nBody.\n",
    ],
    ["html comment", "before\n\n<!-- keep me -->\n\nafter\n"],
    ["raw html block", "intro\n\n<div class=\"warn\">\n<b>html</b>\n</div>\n\noutro\n"],
    ["footnote definition", "Note here.\n\n[^1]: the note\n"],
  ];

  // probeRoundTrip returns the RAW serializer output, and tiptap-markdown's
  // getMarkdown() never ends a document with a newline. Layer 1 alone cannot
  // put that byte back; layer 2 does, from the original block's own trailing
  // bytes, and its suite asserts exact byte identity. Here the assertion is
  // that the held constructs come back verbatim, in place.
  const endNl = (s: string) => s.replace(/\n*$/, "\n");

  for (const [name, md] of PRESERVED) {
    it(`survives a zero-edit round trip: ${name}`, () => {
      const { frontMatter, body } = splitFrontMatter(md);
      const { text, holds } = extractHoldAsides(body);
      const res = probeRoundTrip(text);
      expect(res.clean, `placeholder text was:\n${text}\ngot:\n${res.output}`).toBe(true);
      expect(
        endNl(joinFrontMatter(frontMatter, restoreHoldAsides(res.output, holds)))
      ).toBe(md);
    });
  }
});
