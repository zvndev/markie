import { describe, it, expect } from "vitest";
import { formatMarkdownTables } from "./format-tables";

describe("formatMarkdownTables", () => {
  it("aligns ragged columns", () => {
    const input = "| a | long header |\n|---|---|\n| first | b |";
    expect(formatMarkdownTables(input)).toBe(
      "| a     | long header |\n| ----- | ----------- |\n| first | b           |"
    );
  });

  it("preserves alignment colons", () => {
    const input = "| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |";
    const out = formatMarkdownTables(input);
    expect(out).toContain("| :-- |");
    expect(out).toContain("| :-: |");
    expect(out).toContain("| --: |");
  });

  it("leaves non-table content untouched", () => {
    const input = "# Title\n\nplain | pipe in text\n";
    expect(formatMarkdownTables(input)).toBe(input);
  });

  it("ignores tables inside code fences", () => {
    const input = "```\n| a | b |\n|---|---|\n```\n";
    expect(formatMarkdownTables(input)).toBe(input);
  });

  it("handles multiple tables independently", () => {
    const input =
      "| a |\n|---|\n| 1 |\n\ntext\n\n| bb | cc |\n|---|---|\n| 2 | 3 |";
    const out = formatMarkdownTables(input);
    expect(out).toContain("| a   |\n| --- |\n| 1   |");
    expect(out).toContain("| bb  | cc  |");
  });
});
