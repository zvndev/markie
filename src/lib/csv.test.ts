import { describe, it, expect } from "vitest";
import {
  parseCSV,
  serializeCSV,
  csvToMarkdownTable,
  markdownTableToCSV,
} from "./csv";

describe("parseCSV", () => {
  it("parses simple rows", () => {
    expect(parseCSV("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields with commas, quotes, and newlines", () => {
    expect(parseCSV('a,"x, y"\n"he said ""hi""","line1\nline2"')).toEqual([
      ["a", "x, y"],
      ['he said "hi"', "line1\nline2"],
    ]);
  });

  it("handles CRLF", () => {
    expect(parseCSV("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("serializeCSV", () => {
  it("round-trips with quoting where needed", () => {
    const rows = [
      ["a", "x, y"],
      ['he said "hi"', "plain"],
    ];
    expect(parseCSV(serializeCSV(rows))).toEqual(rows);
  });
});

describe("csv ↔ markdown table", () => {
  it("converts csv to a GFM table with header row", () => {
    const md = csvToMarkdownTable("name,age\nkirby,38\n");
    expect(md).toContain("| name");
    expect(md).toContain("| ---");
    expect(md).toContain("| kirby");
  });

  it("escapes pipes in cells", () => {
    const md = csvToMarkdownTable("a\nx|y\n");
    expect(md).toContain("x\\|y");
  });

  it("extracts the first markdown table back to csv", () => {
    const csv = markdownTableToCSV(
      "intro text\n\n| name | age |\n| --- | --- |\n| kirby | 38 |\n"
    );
    expect(parseCSV(csv)).toEqual([
      ["name", "age"],
      ["kirby", "38"],
    ]);
  });

  it("full round-trip preserves data", () => {
    const original = 'name,note\nkirby,"likes | pipes, and commas"\n';
    const md = csvToMarkdownTable(original);
    const back = markdownTableToCSV(md);
    expect(parseCSV(back)).toEqual(parseCSV(original));
  });
});
