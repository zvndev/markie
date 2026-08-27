import { describe, expect, it } from "vitest";
import {
  splitTopLevelBlocks,
  joinBlocks,
  preserveBlocks,
} from "@/lib/rich-block-preserve";
import { createBlockNormalizer } from "@/lib/rich-roundtrip";

const SPLIT_FIXTURES: Array<[string, string, number]> = [
  ["two paragraphs", "one\n\ntwo\n", 2],
  ["wrapped paragraph is one block", "line a\nline b\n\nnext\n", 2],
  ["blank line inside a fence does not split", "```\na\n\nb\n```\n\npara\n", 2],
  ["tilde fence", "~~~\nx\n\ny\n~~~\n", 1],
  ["unterminated fence swallows the rest", "```\na\n\nb\n", 1],
  ["multiple blank separators preserved", "a\n\n\n\nb\n", 2],
  ["no trailing newline", "a\n\nb", 2],
  ["CRLF document", "a\r\n\r\nb\r\n", 2],
  ["leading blank lines", "\n\na\n", 1],
];

describe("splitTopLevelBlocks", () => {
  for (const [name, md, count] of SPLIT_FIXTURES) {
    it(`splits and rejoins losslessly: ${name}`, () => {
      const blocks = splitTopLevelBlocks(md);
      expect(joinBlocks(blocks)).toBe(md);
      expect(blocks.filter((b) => b.text.trim() !== "").length).toBe(count);
    });
  }
});

describe("preserveBlocks", () => {
  // A normalize stub for pure splitter-level tests: identity modulo
  // trailing newlines, with one designated rewrite.
  const stubNormalize = (rewrites: Record<string, string>) => (b: string) => {
    const key = b.replace(/\n+$/, "");
    return rewrites[key] ?? key;
  };

  it("emits original bytes for every unchanged block", () => {
    const original = "wrapped\nparagraph\n\nsecond block\n";
    // The serializer joined the wrap; normalize(original block) matches it.
    const serialized = "wrapped paragraph\n\nsecond block\n";
    const out = preserveBlocks(
      original,
      serialized,
      stubNormalize({ "wrapped\nparagraph": "wrapped paragraph" })
    );
    expect(out).toBe(original);
  });

  it("keeps serializer output only for the changed block", () => {
    const original = "wrapped\none\n\nwrapped\ntwo\n\nwrapped\nthree\n";
    // The user edited block two; blocks one and three serialize to their
    // normalized (joined) forms, block two to new content.
    const serialized = "wrapped one\n\nEDITED two\n\nwrapped three\n";
    const out = preserveBlocks(
      original,
      serialized,
      stubNormalize({
        "wrapped\none": "wrapped one",
        "wrapped\ntwo": "wrapped two",
        "wrapped\nthree": "wrapped three",
      })
    );
    expect(out).toBe("wrapped\none\n\nEDITED two\n\nwrapped\nthree\n");
  });

  it("a deleted block stays deleted", () => {
    const original = "a\n\nb\n\nc\n";
    const serialized = "a\n\nc\n";
    const out = preserveBlocks(original, serialized, stubNormalize({}));
    expect(out).toBe("a\n\nc\n");
  });

  it("an inserted block uses serializer output", () => {
    const original = "a\n\nc\n";
    const serialized = "a\n\nNEW\n\nc\n";
    const out = preserveBlocks(original, serialized, stubNormalize({}));
    expect(out).toBe("a\n\nNEW\n\nc\n");
  });

  it("coalesces a run of source blocks the serializer merged", () => {
    // tightLists joins a loose list into one output block; the unchanged
    // run must still come back verbatim.
    const original = "- one\n\n- two\n";
    const serialized = "- one\n- two\n";
    const normalize = (b: string) => {
      const key = b.replace(/\n+$/, "");
      if (key === "- one\n\n- two") return "- one\n- two";
      return key;
    };
    expect(preserveBlocks(original, serialized, normalize)).toBe(original);
  });

  it("coalesces one source block the serializer split into a run", () => {
    // The mirror case, and the one that matters on real files: a TIGHT task
    // list comes back LOOSE from tiptap-markdown, so one source block lands
    // as several output blocks. Measured 2026-08-26; see rich-roundtrip.test.
    const original = "- [x] done\n- [ ] todo\n";
    const serialized = "- [x] done\n\n- [ ] todo\n";
    const normalize = (b: string) => {
      const key = b.replace(/\n+$/, "");
      if (key === "- [x] done\n- [ ] todo") return "- [x] done\n\n- [ ] todo";
      return key;
    };
    expect(preserveBlocks(original, serialized, normalize)).toBe(original);
  });

  it("falls back to serializer output when nothing matches (never guesses)", () => {
    const original = "See [docs][ref].\n\n[ref]: https://example.com\n";
    const serialized = "See [docs](https://example.com).\n";
    const out = preserveBlocks(original, serialized, stubNormalize({}));
    expect(out).toBe(serialized);
  });

  it("keeps the source document's trailing newline when the last block changed", () => {
    // The serializer never ends a document with a newline. Restoring the
    // source's own convention is not a guess: it is an observable property
    // of the bytes that came in.
    const original = "a\n\nlast block\n";
    const serialized = "a\n\nEDITED last";
    const out = preserveBlocks(original, serialized, stubNormalize({}));
    expect(out).toBe("a\n\nEDITED last\n");
  });
});

describe("createBlockNormalizer (real editor)", () => {
  it("normalizes a wrapped paragraph to its serialized form and memoizes", () => {
    const { normalize, destroy } = createBlockNormalizer();
    try {
      const a = normalize("wrapped\nparagraph");
      expect(a).toBe("wrapped paragraph");
      expect(normalize("wrapped\nparagraph")).toBe(a);
    } finally {
      destroy();
    }
  });

  it("end to end: one-block edit leaves every other block byte-identical", () => {
    const { normalize, destroy } = createBlockNormalizer();
    try {
      const original =
        "First para is\nwrapped by hand.\n\n| a | b |\n| :--- | ---: |\n| 1 | 2 |\n\nThird para also\nwrapped.\n";
      // Simulate the serializer's whole-document output after the user
      // edited only the third paragraph: blocks 1 and 2 serialize to their
      // normalized forms, block 3 to new text.
      const serialized =
        [
          normalize("First para is\nwrapped by hand."),
          normalize("| a | b |\n| :--- | ---: |\n| 1 | 2 |"),
          "Third para rewritten.",
        ].join("\n\n") + "\n";
      const out = preserveBlocks(original, serialized, normalize);
      expect(out).toBe(
        "First para is\nwrapped by hand.\n\n| a | b |\n| :--- | ---: |\n| 1 | 2 |\n\nThird para rewritten.\n"
      );
    } finally {
      destroy();
    }
  });
});
