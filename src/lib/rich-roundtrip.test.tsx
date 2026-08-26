import { describe, expect, it } from "vitest";
import {
  probeRoundTrip,
  describeLossRisks,
  createBlockNormalizer,
  probeReconstruction,
} from "@/lib/rich-roundtrip";
import { splitFrontMatter, joinFrontMatter } from "@/lib/front-matter";
import { extractHoldAsides, restoreHoldAsides } from "@/lib/rich-hold-aside";
import {
  preserveBlocks,
  splitTopLevelBlocks,
} from "@/lib/rich-block-preserve";

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

const key = (s: string) => s.replace(/(?:\r?\n)+$/, "");

describe("layer 2 pipeline (block preservation)", () => {
  // The whole zero-edit path: hold aside, parse, serialize, preserve blocks,
  // restore. By construction the output must be the input, byte for byte.
  const zeroEditPipeline = (md: string) => {
    const { frontMatter, body } = splitFrontMatter(md);
    const { text, holds } = extractHoldAsides(body);
    const raw = probeRoundTrip(text); // raw serializer output
    const { normalize, destroy } = createBlockNormalizer();
    try {
      const preserved = preserveBlocks(text, raw.output, normalize);
      return joinFrontMatter(frontMatter, restoreHoldAsides(preserved, holds));
    } finally {
      destroy();
    }
  };

  const CORPUS_SHAPED: Array<[string, string]> = [
    [
      "hand-wrapped prose",
      "# Notes\n\nThis paragraph was wrapped\nby hand at eighty columns\nlike most real files.\n\nAnother wrapped\nparagraph follows.\n",
    ],
    ["aligned table", "| left | right |\n| :--- | ---: |\n| 1 | 2 |\n"],
    ["loose list", "- one\n\n- two\n\n- three\n"],
    ["tight task list", "- [x] done\n- [ ] todo\n- [ ] later\n"],
    ["inline math", "Euler: $e^{i\\pi} + 1 = 0$ stays put.\n"],
    ["display math", "$$\n\\frac{a}{b} \\, dx\n$$\n"],
    ["footnote pair", "Text with a note.[^1]\n\n[^1]: the note\n"],
    [
      // The dominant residue on real files: a list whose items are separated
      // by blank lines parses as ONE loose list, and the serializer then
      // loosens every nested sub-list too. Normalizing a single item in
      // isolation cannot see that context, so only a run match saves it.
      "ordered list with nested sub-lists",
      "## Priorities\n\n1. Web-first product truth\n   - Inspect the app first.\n   - Keep desktop work tied to runtime.\n\n2. Portfolio task import\n   - Use the guarded artifacts.\n   - Avoid direct writes.\n\n## After\n",
    ],
    [
      // A numbered step with an indented continuation paragraph. The step
      // itself round-trips byte for byte, so it anchors and strands the
      // continuation, which in isolation reads as an indented code block.
      // Only re-testing the region WITH its anchors can match it.
      "list item with an indented continuation paragraph",
      "1. Open the panel.\n\n2. Select the package from the list.\n\n    The manager picks a version for you.\n\n3. Press Install.\n",
    ],
    [
      "mixed document",
      "---\ntitle: Mixed\nmarkie:\n  project: Markie\n---\n# Heading\n\n<!-- a comment that must survive -->\n\nProse wrapped\nby hand across lines.\n\n| a | b |\n| :--- | ---: |\n| 1 | 2 |\n\n<div class=\"note\">\n<b>raw</b>\n</div>\n\nClosing line.\n",
    ],
  ];

  for (const [name, md] of CORPUS_SHAPED) {
    it(`zero-edit output is byte-identical: ${name}`, () => {
      expect(zeroEditPipeline(md)).toBe(md);
    });
  }

  it("zero-edit output is byte-identical for hand-wrapped prose", () => {
    const md =
      "# Notes\n\nThis paragraph was wrapped\nby hand at eighty columns\nlike most real files.\n\nAnother wrapped\nparagraph follows.\n";
    expect(zeroEditPipeline(md)).toBe(md);
  });

  it("editing one paragraph of a 400-line hand-wrapped document leaves every other line byte-identical", () => {
    // The release's success criterion, stated as a test.
    const PARAGRAPHS = 120;
    const EDITED = 42;
    const paragraphs: string[] = [];
    for (let i = 0; i < PARAGRAPHS; i++) {
      paragraphs.push(
        `Paragraph ${i} opens here and\nis wrapped by hand across\nthree separate source lines.`
      );
    }
    const md = paragraphs.join("\n\n") + "\n";
    expect(md.split("\n").length).toBeGreaterThan(400);
    // Each paragraph is three lines plus a blank separator.
    const firstLine = EDITED * 4;

    const { text, holds } = extractHoldAsides(splitFrontMatter(md).body);
    const { normalize, destroy } = createBlockNormalizer();
    try {
      // What the serializer emits once the user has retyped paragraph 42:
      // every other block comes back in its normalized (rewrapped) form.
      const serialized =
        splitTopLevelBlocks(text)
          .filter((b) => b.text !== "")
          .map((b, i) =>
            i === EDITED
              ? "Paragraph 42 was rewritten by hand."
              : normalize(key(b.text))
          )
          .join("\n\n") + "\n";
      const outMd = restoreHoldAsides(
        preserveBlocks(text, serialized, normalize),
        holds
      );

      const before = md.split("\n");
      const after = outMd.split("\n");
      // Everything above the edited paragraph is untouched.
      expect(after.slice(0, firstLine)).toEqual(before.slice(0, firstLine));
      // The three wrapped lines collapsed to the one line the user typed.
      expect(after[firstLine]).toBe("Paragraph 42 was rewritten by hand.");
      // Everything below it is untouched too, shifted by the two lines lost.
      expect(after.slice(firstLine + 1)).toEqual(before.slice(firstLine + 3));
    } finally {
      destroy();
    }
  });
});

describe("probeReconstruction (the layer-3 gate)", () => {
  const CLEAN: Array<[string, string]> = [
    ["wrapped prose", "Wrapped\nby hand.\n\nMore wrapped\ntext here.\n"],
    ["front matter + body", "---\nkey: v\n---\n# T\n\nBody.\n"],
    ["comment + footnote def", "x[^1]\n\n<!-- c -->\n\n[^1]: n\n"],
    ["aligned table untouched", "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n"],
    ["loose list", "- one\n\n- two\n"],
  ];
  const GATED: Array<[string, string]> = [
    // The parser consumes the definition and inlines the link. With an
    // unrelated matched block in between, neither plain alignment nor the
    // coalescing pass can reproduce the source without guessing, so this
    // must gate. (The adjacent two-block case may be rescued by coalescing;
    // it is intentionally not pinned either way.)
    [
      "reference link with distance",
      "See [the docs][ref].\n\nUnrelated paragraph.\n\n[ref]: https://example.com\n",
    ],
  ];

  for (const [name, md] of CLEAN) {
    it(`reconstructs byte for byte: ${name}`, () => {
      const res = probeReconstruction(md);
      expect(res.clean, `output was:\n${res.output}`).toBe(true);
    });
  }
  for (const [name, md] of GATED) {
    it(`gates: ${name}`, () => {
      expect(probeReconstruction(md).clean).toBe(false);
    });
  }

  it("treats an empty document as safe", () => {
    expect(probeReconstruction("").clean).toBe(true);
    expect(probeReconstruction("   \n").clean).toBe(true);
  });
});
