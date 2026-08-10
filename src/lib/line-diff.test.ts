import { describe, it, expect } from "vitest";
import { lineDiff, describeDiff, MAX_DIFF_LINES } from "./line-diff";

describe("lineDiff", () => {
  it("reports nothing for identical content", () => {
    expect(lineDiff("a\nb\nc\n", "a\nb\nc\n")).toEqual({
      added: 0,
      removed: 0,
      same: 3,
    });
  });

  // A "behind" flag can be stale: the server version moved but the content did
  // not. All-zeros is how the caller knows not to prompt.
  it("reports nothing when only the version moved", () => {
    const d = lineDiff("# Notes\n", "# Notes\n");
    expect(d.added + d.removed).toBe(0);
  });

  it("counts a pure insertion as added only", () => {
    expect(lineDiff("a\nb\n", "a\nnew\nb\n")).toEqual({
      added: 1,
      removed: 0,
      same: 2,
    });
  });

  it("counts a pure deletion as removed only", () => {
    expect(lineDiff("a\ngone\nb\n", "a\nb\n")).toEqual({
      added: 0,
      removed: 1,
      same: 2,
    });
  });

  it("counts a replaced line as one of each", () => {
    expect(lineDiff("a\nold\nc\n", "a\nnew\nc\n")).toEqual({
      added: 1,
      removed: 1,
      same: 2,
    });
  });

  it("treats an empty local file as all-added", () => {
    expect(lineDiff("", "a\nb\n")).toEqual({ added: 2, removed: 0, same: 0 });
  });

  it("treats an empty server file as all-removed", () => {
    expect(lineDiff("a\nb\n", "")).toEqual({ added: 0, removed: 2, same: 0 });
  });

  // A file that ends in a newline has the same number of lines as one that
  // does not; counting the terminator as a line would report a phantom change
  // on every save that only touched the last character.
  it("does not invent a line for a trailing newline", () => {
    expect(lineDiff("a\nb", "a\nb\n")).toEqual({ added: 0, removed: 0, same: 2 });
  });

  it("never reports a negative count", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["a", ""],
      ["", "a"],
      ["a\na\na\n", "a\n"],
      ["a\n", "a\na\na\n"],
    ];
    for (const [local, remote] of cases) {
      const d = lineDiff(local, remote);
      expect(d.added).toBeGreaterThanOrEqual(0);
      expect(d.removed).toBeGreaterThanOrEqual(0);
      expect(d.same).toBeGreaterThanOrEqual(0);
    }
  });

  it("stays sane past the size guard, where it stops using LCS", () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, i) => `line ${i}`);
    const local = big.join("\n");
    const remote = [...big.slice(0, -3), "changed", "changed too"].join("\n");
    const d = lineDiff(local, remote);
    expect(d.added).toBeGreaterThanOrEqual(0);
    expect(d.removed).toBeGreaterThanOrEqual(0);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(3);
  });

  it("agrees with itself on identical content past the size guard", () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join("\n");
    expect(lineDiff(big, big)).toMatchObject({ added: 0, removed: 0 });
  });
});

describe("describeDiff", () => {
  it("leads with what the user loses", () => {
    const s = describeDiff({ added: 12, removed: 8, same: 40 });
    expect(s).toBe(
      "Pulling replaces 8 lines of yours and brings in 12 lines from the server."
    );
    expect(s.indexOf("replaces")).toBeLessThan(s.indexOf("brings in"));
  });

  it("does not mention losing anything when nothing is lost", () => {
    expect(describeDiff({ added: 3, removed: 0, same: 10 })).toBe(
      "Pulling brings in 3 lines from the server."
    );
  });

  it("does not mention gaining anything when nothing is gained", () => {
    expect(describeDiff({ added: 0, removed: 1, same: 10 })).toBe(
      "Pulling replaces 1 line of yours."
    );
  });

  it("says so when the copies match", () => {
    expect(describeDiff({ added: 0, removed: 0, same: 5 })).toBe(
      "The two copies are identical."
    );
  });

  it("keeps the singular singular", () => {
    expect(describeDiff({ added: 1, removed: 1, same: 0 })).toBe(
      "Pulling replaces 1 line of yours and brings in 1 line from the server."
    );
  });
});
