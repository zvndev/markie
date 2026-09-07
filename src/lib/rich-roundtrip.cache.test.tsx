// The block memo (src/lib/rich-roundtrip.ts) must hold every block of a
// document under the large line at once. The cooperative probe warms a
// document's blocks in idle slices and then normalizes them all again in one
// piece; a memo too small for the document evicted the first blocks while the
// last went in, and that final pass re-parsed nearly everything.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LARGE_DOC_BYTES } from "@/lib/doc-tiers";
import {
  blockCacheLimits,
  blockCacheSize,
  clearBlockCache,
  createBlockNormalizer,
  setBlockCacheBudgetForTests,
} from "@/lib/rich-roundtrip";

beforeEach(() => clearBlockCache());
afterEach(() => {
  setBlockCacheBudgetForTests(null);
  clearBlockCache();
});

describe("block memo bounds", () => {
  it("is sized for every block of a document under the large line", () => {
    // Measured markdown runs about 7,400 blocks per MB (the 950 KB check
    // fixture has 6,989, and the old cap was 4,000 entries). Characters are
    // the working bound: a document's blocks plus their normalized output is
    // about twice its size, and several documents must fit at once.
    const { entries, chars } = blockCacheLimits();
    expect(chars).toBeGreaterThanOrEqual(4 * LARGE_DOC_BYTES);
    expect(entries).toBeGreaterThanOrEqual(8 * 7_400);
  });

  it("is budgeted in characters held, sized for whole documents", () => {
    // 8 x the large line: a document under the line, with its normalized
    // output, fits several times over.
    setBlockCacheBudgetForTests(60);
    const { normalize } = createBlockNormalizer();
    normalize("first paragraph"); // 15 + 15 chars
    normalize("second paragraph"); // 16 + 16: 62 held, over budget
    expect(blockCacheSize()).toBe(1);
    normalize("second paragraph"); // a hit, nothing evicted
    expect(blockCacheSize()).toBe(1);
    expect(LARGE_DOC_BYTES).toBe(1_000_000);
  });

  it("evicts least recently used first", () => {
    setBlockCacheBudgetForTests(100);
    const { normalize } = createBlockNormalizer();
    normalize("alpha block"); // 22
    normalize("beta block"); // 20
    normalize("gamma block"); // 22, 64 held
    normalize("alpha block"); // hit: alpha is now the newest
    normalize("delta block, a little longer one"); // 64: 128 held, evict beta then gamma
    expect(blockCacheSize()).toBe(2);
    normalize("alpha block");
    expect(blockCacheSize()).toBe(2); // alpha survived, so this was a hit
  });
});
