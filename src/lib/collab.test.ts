import { describe, expect, it } from "vitest";
import {
  COLLAB_SCHEMA_VERSION,
  colorForName,
  initials,
  isSchemaMismatch,
  SCHEMA_MISMATCH_NOTICE,
  SEED_SETTLE_MS,
  shouldWarnSchema,
} from "./collab";

const PALETTE = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#14b8a6",
  "#eab308",
];

describe("colorForName", () => {
  it("always returns a colour from the peer palette", () => {
    for (const name of ["", "a", "Ada Lovelace", "ada@markie.app", "日本語", "x".repeat(200)]) {
      expect(PALETTE).toContain(colorForName(name));
    }
  });

  it("is stable for the same name", () => {
    expect(colorForName("Ada Lovelace")).toBe(colorForName("Ada Lovelace"));
  });

  it("spreads distinct names across the palette", () => {
    const distinct = new Set(
      ["Ada", "Grace", "Alan", "Barbara", "Katherine", "Edsger", "Linus", "Rich"].map(
        colorForName
      )
    );
    expect(distinct.size).toBeGreaterThan(3);
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada lovelace king")).toBe("AL");
  });

  it("takes two letters from a single word", () => {
    expect(initials("Ada")).toBe("AD");
    expect(initials("k")).toBe("K");
  });

  it("splits email addresses on @ and .", () => {
    expect(initials("ada.lovelace@markie.app")).toBe("AL");
    expect(initials("ada@markie.app")).toBe("AM");
  });

  it("falls back to ? for empty or punctuation-only names", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
    expect(initials("@.@")).toBe("?");
  });

  it("trims surrounding whitespace", () => {
    expect(initials("  Ada Lovelace  ")).toBe("AL");
  });
});

describe("collab schema version", () => {
  it("is a whole number so rooms can be compared across builds", () => {
    expect(Number.isInteger(COLLAB_SCHEMA_VERSION)).toBe(true);
    expect(COLLAB_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("leaves room for the winning seeder's update to arrive", () => {
    expect(SEED_SETTLE_MS).toBeGreaterThan(0);
  });
});

describe("isSchemaMismatch", () => {
  it("is false for a room this build wrote", () => {
    expect(isSchemaMismatch(COLLAB_SCHEMA_VERSION)).toBe(false);
  });

  it("is false for a room that carries no version at all", () => {
    // Rooms seeded before versioning existed are readable, not suspect.
    expect(isSchemaMismatch(undefined)).toBe(false);
    expect(isSchemaMismatch(null)).toBe(false);
  });

  it("ignores a version that is not a number", () => {
    expect(isSchemaMismatch("2")).toBe(false);
    expect(isSchemaMismatch({ v: 2 })).toBe(false);
  });

  it("is true for any other version, older or newer", () => {
    expect(isSchemaMismatch(COLLAB_SCHEMA_VERSION + 1)).toBe(true);
    expect(isSchemaMismatch(COLLAB_SCHEMA_VERSION - 1)).toBe(true);
  });
});

describe("shouldWarnSchema", () => {
  it("raises the notice on a first-seen mismatch", () => {
    expect(shouldWarnSchema(COLLAB_SCHEMA_VERSION + 1, false)).toBe(true);
  });

  it("stays quiet once the notice has already been said", () => {
    // The room's meta map fires the observer on every streamed edit; the notice
    // must not stack up.
    expect(shouldWarnSchema(COLLAB_SCHEMA_VERSION + 1, true)).toBe(false);
  });

  it("stays quiet for a room this build wrote, warned or not", () => {
    expect(shouldWarnSchema(COLLAB_SCHEMA_VERSION, false)).toBe(false);
    expect(shouldWarnSchema(undefined, false)).toBe(false);
  });
});

describe("SCHEMA_MISMATCH_NOTICE", () => {
  it("is a plain-language warning, not a code", () => {
    expect(SCHEMA_MISMATCH_NOTICE).toMatch(/different Markie version/i);
  });
});
