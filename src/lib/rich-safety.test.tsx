import { beforeEach, describe, expect, it } from "vitest";
import {
  cachedReconstruction,
  clearReconstructionCache,
  resolveReconstruction,
} from "@/lib/rich-safety";

// Reference-link definitions with an intervening block are consumed by the
// parser, so the pipeline cannot put them back: this is the gated shape.
const GATED = "See [the docs][ref].\n\nUnrelated paragraph.\n\n[ref]: https://example.com\n";
const CLEAN = "Wrapped\nprose.[^1]\n\n[^1]: the note\n";

beforeEach(() => clearReconstructionCache());

describe("reconstruction verdict cache", () => {
  it("does not answer for a document it has never seen", () => {
    expect(cachedReconstruction(CLEAN)).toBeNull();
  });

  it("remembers the answer the probe gave, both ways", () => {
    expect(resolveReconstruction(CLEAN)).toBe(true);
    expect(cachedReconstruction(CLEAN)).toBe(true);
    expect(resolveReconstruction(GATED)).toBe(false);
    expect(cachedReconstruction(GATED)).toBe(false);
  });

  it("keys on the document's own bytes, so one edit is a different question", () => {
    resolveReconstruction(CLEAN);
    expect(cachedReconstruction(CLEAN + "more\n")).toBeNull();
  });

  it("evicts least-recently-used once past the entry cap", () => {
    // 24 is the cap; make 30 documents that each reconstruct cleanly.
    const docs = Array.from({ length: 30 }, (_, i) => `Paragraph number ${i}.\n`);
    for (const d of docs) resolveReconstruction(d);
    expect(cachedReconstruction(docs[29])).toBe(true);
    expect(cachedReconstruction(docs[0])).toBeNull();
  });

  it("keeps a document alive when it is the one being reopened", () => {
    const docs = Array.from({ length: 30 }, (_, i) => `Paragraph number ${i}.\n`);
    for (let i = 0; i < 20; i++) resolveReconstruction(docs[i]);
    for (let i = 20; i < 30; i++) {
      resolveReconstruction(docs[i]);
      // Keep asking about the first one, so it is never the least recent.
      expect(cachedReconstruction(docs[0])).toBe(true);
    }
  });

  it("re-answers from cache without running the probe again", () => {
    // A second resolve of a big document is orders of magnitude faster than
    // the first: the assertion is the cache hit, not a wall-clock threshold.
    const big = Array.from({ length: 400 }, (_, i) => `Para ${i} is\nwrapped by hand.`).join("\n\n") + "\n";
    const first = performance.now();
    resolveReconstruction(big);
    const cold = performance.now() - first;
    const second = performance.now();
    resolveReconstruction(big);
    const warm = performance.now() - second;
    expect(warm).toBeLessThan(cold);
    expect(cachedReconstruction(big)).not.toBeNull();
  });
});
