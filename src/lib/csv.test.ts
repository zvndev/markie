import { describe, it, expect } from "vitest";
import {
  parseCSV,
  serializeCSV,
  csvToMarkdownTable,
  markdownTableToCSV,
  csvDropsContent,
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

describe("csvDropsContent", () => {
  it("reports no loss for a document that is only a table", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(csvDropsContent(md)).toEqual({
      drops: false,
      droppedLines: 0,
      hasTable: true,
    });
  });

  it("counts prose before and after the table", () => {
    const md = "# Notes\n\nIntro line.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nTrailing note.\n";
    const res = csvDropsContent(md);
    expect(res.drops).toBe(true);
    expect(res.hasTable).toBe(true);
    expect(res.droppedLines).toBe(3);
  });

  it("counts a second table as dropped content", () => {
    const md = "| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |\n";
    const res = csvDropsContent(md);
    expect(res.drops).toBe(true);
    expect(res.droppedLines).toBe(3);
  });

  it("reports everything dropped when there is no table at all", () => {
    const res = csvDropsContent("# Title\n\nJust prose.\n");
    expect(res).toEqual({ drops: true, droppedLines: 2, hasTable: false });
  });

  it("treats an empty document as lossless", () => {
    expect(csvDropsContent("")).toEqual({
      drops: false,
      droppedLines: 0,
      hasTable: false,
    });
  });

  it("agrees with what markdownTableToCSV actually keeps", () => {
    const md = "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nOutro.\n";
    expect(csvDropsContent(md).drops).toBe(true);
    expect(markdownTableToCSV(md)).toBe("a,b\n1,2\n");
  });
});
