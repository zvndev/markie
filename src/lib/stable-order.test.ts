import { describe, expect, it } from "vitest";
import { matchesFilter, stableOrder } from "./stable-order";

const key = (f: { path: string }) => f.path;
const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe("stableOrder", () => {
  it("keeps the remembered order even when the source reorders", () => {
    const remembered = ["/a.md", "/b.md", "/c.md"];
    // The registry has re-sorted because /c.md was just opened.
    const reordered = files("/c.md", "/a.md", "/b.md");
    expect(stableOrder(reordered, key, remembered).map(key)).toEqual([
      "/a.md",
      "/b.md",
      "/c.md",
    ]);
  });

  // The bug this exists to prevent: click a row, the row moves.
  it("does not move a file to the top because it was opened", () => {
    const remembered = ["/a.md", "/b.md", "/c.md"];
    const afterOpeningC = files("/c.md", "/a.md", "/b.md");
    expect(stableOrder(afterOpeningC, key, remembered).map(key)[0]).toBe("/a.md");
  });

  it("leads with files it has never seen before", () => {
    const remembered = ["/a.md", "/b.md"];
    const withNew = files("/new.md", "/b.md", "/a.md");
    expect(stableOrder(withNew, key, remembered).map(key)).toEqual([
      "/new.md",
      "/a.md",
      "/b.md",
    ]);
  });

  it("keeps several new files in the order they arrived", () => {
    const remembered = ["/a.md"];
    const withNew = files("/n1.md", "/n2.md", "/a.md");
    expect(stableOrder(withNew, key, remembered).map(key)).toEqual([
      "/n1.md",
      "/n2.md",
      "/a.md",
    ]);
  });

  it("drops files that are gone without disturbing the rest", () => {
    const remembered = ["/a.md", "/b.md", "/c.md"];
    expect(stableOrder(files("/c.md", "/a.md"), key, remembered).map(key)).toEqual([
      "/a.md",
      "/c.md",
    ]);
  });

  it("passes items through untouched before an order is remembered", () => {
    const incoming = files("/c.md", "/a.md");
    expect(stableOrder(incoming, key, []).map(key)).toEqual(["/c.md", "/a.md"]);
  });

  it("handles an empty list", () => {
    expect(stableOrder([], key, ["/a.md"])).toEqual([]);
  });
});

describe("matchesFilter", () => {
  const item = { name: "Q3.md", path: "/Users/k/work/plans/Q3.md" };

  it("matches on name, case-insensitively", () => {
    expect(matchesFilter(item, "q3")).toBe(true);
    expect(matchesFilter(item, "Q3")).toBe(true);
  });

  it("matches on a folder in the path", () => {
    expect(matchesFilter(item, "plans")).toBe(true);
  });

  it("returns everything for an empty or whitespace query", () => {
    expect(matchesFilter(item, "")).toBe(true);
    expect(matchesFilter(item, "   ")).toBe(true);
  });

  it("rejects a non-match", () => {
    expect(matchesFilter(item, "budget")).toBe(false);
  });

  it("tolerates a missing path", () => {
    expect(matchesFilter({ name: "a.md", path: null }, "a")).toBe(true);
    expect(matchesFilter({ name: "a.md" }, "zzz")).toBe(false);
  });
});
