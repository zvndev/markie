import { describe, expect, it } from "vitest";
import { CSV_FIXTURES } from "./csv-fixtures";
import { decodeTextDocument, encodeTextDocument } from "./document-formats";
import {
  cellReference, cellValue, cellsToText, clipboardToCells, columnLetter, decodeField, deleteColumns, deleteRows, encodeField, firstRowIsHeader,
  formatCell, insertColumn, insertRow, isDateValue, numericColumns, parseCellReference, parseCsvDocument, parseNumber, plainEditorText, rangeStats,
  restoreTextShape, serializeCsvDocument, setCell, sniffDelimiter, viewRows,
} from "./csv-table";

const open = (text: string, name = "file.csv") => parseCsvDocument(text, { name });
const bytesOf = (text: string) => Array.from(new TextEncoder().encode(text));

describe("open and save without edits", () => {
  for (const fixture of CSV_FIXTURES) {
    it(`${fixture.name} is byte for byte the same`, () => {
      const doc = open(fixture.text, fixture.file);
      expect(bytesOf(serializeCsvDocument(doc))).toEqual(bytesOf(fixture.text));
      expect(doc.delimiter).toBe(fixture.delimiter);
      expect(doc.rows.length).toBe(fixture.rows);
      expect(doc.columnCount).toBe(fixture.columns);
    });

    it(`${fixture.name} survives the documents workspace's decode and encode`, () => {
      // The workspace hands the table decoded text and encodes what comes back.
      const bytes = new TextEncoder().encode(fixture.text);
      const decoded = decodeTextDocument(bytes);
      const saved = encodeTextDocument(serializeCsvDocument(open(decoded.text, fixture.file)), decoded);
      expect(Array.from(saved)).toEqual(Array.from(bytes));
    });

    it(`${fixture.name} is unchanged by an edit that changes nothing`, () => {
      const doc = open(fixture.text, fixture.file);
      let same = doc;
      for (let r = 0; r < doc.rows.length; r++) for (let c = 0; c < doc.rows[r].length; c++) same = setCell(same, r, c, cellValue(doc, r, c));
      expect(same).toBe(doc);
    });
  }

  it("UTF-16 with a BOM round-trips through the workspace's codec", () => {
    const text = "name;qty\r\nÄpfel;3\r\n";
    const bytes = encodeTextDocument(text, { encoding: "utf-16le", bom: true });
    const decoded = decodeTextDocument(bytes);
    expect(Array.from(encodeTextDocument(serializeCsvDocument(open(decoded.text)), decoded))).toEqual(Array.from(bytes));
  });
});

describe("reading", () => {
  it("reads quoted cells as their values", () => {
    const doc = open(CSV_FIXTURES.find((f) => f.file === "embedded-quotes.csv")!.text);
    expect(cellValue(doc, 1, 1)).toBe('She said "hi"');
    expect(cellValue(doc, 2, 1)).toBe('"');
    expect(cellValue(doc, 3, 1)).toBe("a,b");
    expect(cellValue(doc, 4, 1)).toBe('5" pipe');
  });

  it("keeps a line break inside a quoted cell in the cell", () => {
    const doc = open(CSV_FIXTURES.find((f) => f.file === "quoted-newlines.csv")!.text);
    expect(cellValue(doc, 1, 1)).toBe("line one\nline two");
    expect(cellValue(doc, 2, 1)).toBe("a\r\nb");
  });

  it("reads a cell a short row does not have as empty", () => {
    const doc = open("a,b,c\n1\n");
    expect(cellValue(doc, 1, 2)).toBe("");
  });

  it("finds the delimiter", () => {
    expect(sniffDelimiter("a;b;c\n1,5;2;3\n")).toBe(";");
    expect(sniffDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(sniffDelimiter("a,b\n\"x;y;z\",2\n")).toBe(",");
    expect(sniffDelimiter("just one column\nof text\n")).toBe(",");
    expect(sniffDelimiter("one\ntwo\n", "list.tsv")).toBe("\t");
    // A .tsv whose cells hold commas is still tab separated.
    expect(sniffDelimiter("a, b\tc, d, e\n1, 2\t3, 4, 5\n", "x.tsv")).toBe("\t");
  });

  it("decodes and encodes a field", () => {
    expect(decodeField('"a ""b"" c"')).toBe('a "b" c');
    expect(decodeField('"x"y')).toBe("xy");
    expect(decodeField('"open')).toBe("open");
    expect(encodeField("plain", ",")).toBe("plain");
    expect(encodeField("a,b", ",")).toBe('"a,b"');
    expect(encodeField("a,b", ";")).toBe("a,b");
    expect(encodeField('say "hi"', ",")).toBe('"say ""hi"""');
    expect(encodeField("two\nlines", "\t")).toBe('"two\nlines"');
  });
});

describe("editing changes only the cells it touches", () => {
  it("rewrites one cell and leaves the rest of the file alone", () => {
    const text = "﻿id;name;note\r\n1;\"Käse; alt\";\"x\"\r\n2;Brot;\r\n3;\"a \"\"b\"\"\";z";
    const next = serializeCsvDocument(setCell(open(text), 2, 1, "Brötchen"));
    expect(next).toBe("﻿id;name;note\r\n1;\"Käse; alt\";\"x\"\r\n2;Brötchen;\r\n3;\"a \"\"b\"\"\";z");
  });

  it("keeps a quoted cell quoted and quotes a value that needs it", () => {
    const doc = open("a,b\n\"x\",y\n");
    expect(serializeCsvDocument(setCell(doc, 1, 0, "z"))).toBe("a,b\n\"z\",y\n");
    expect(serializeCsvDocument(setCell(doc, 1, 1, "1,5"))).toBe("a,b\n\"x\",\"1,5\"\n");
    expect(serializeCsvDocument(setCell(doc, 1, 1, "two\nlines"))).toBe("a,b\n\"x\",\"two\nlines\"\n");
  });

  it("does not quote a comma in a semicolon file", () => {
    expect(serializeCsvDocument(setCell(open("a;b\n1;2\n"), 1, 1, "1,5"))).toBe("a;b\n1;1,5\n");
  });

  it("follows a file that quotes every field", () => {
    const doc = open("\"a\",\"b\"\n\"1\",\"2\"\n");
    expect(serializeCsvDocument(insertRow(doc, 2))).toBe("\"a\",\"b\"\n\"1\",\"2\"\n\"\",\"\"\n");
    expect(serializeCsvDocument(insertColumn(doc, 2))).toBe("\"a\",\"b\",\"\"\n\"1\",\"2\",\"\"\n");
  });

  it("grows a short row only as far as the cell", () => {
    expect(serializeCsvDocument(setCell(open("a,b,c\n1\n2,3,4\n"), 1, 2, "x"))).toBe("a,b,c\n1,,x\n2,3,4\n");
  });

  it("adds a row with the file's line ending", () => {
    expect(serializeCsvDocument(insertRow(open("a,b\r\n1,2\r\n"), 1))).toBe("a,b\r\n,\r\n1,2\r\n");
    expect(serializeCsvDocument(insertRow(open("a,b\r\n1,2\r\n"), 2, ["x", "y,z"]))).toBe("a,b\r\n1,2\r\nx,\"y,z\"\r\n");
  });

  it("keeps a file without a trailing newline without one", () => {
    expect(serializeCsvDocument(insertRow(open("a,b\n1,2"), 2))).toBe("a,b\n1,2\n,");
    expect(serializeCsvDocument(deleteRows(open("a,b\n1,2\n3,4"), [2]))).toBe("a,b\n1,2");
    expect(serializeCsvDocument(deleteRows(open("a,b\n1,2\n3,4\n"), [2]))).toBe("a,b\n1,2\n");
  });

  it("deletes rows and columns", () => {
    const doc = open("a,b,c\n1,2,3\n4,5,6\n7,8,9\n");
    expect(serializeCsvDocument(deleteRows(doc, [1, 3]))).toBe("a,b,c\n4,5,6\n");
    expect(serializeCsvDocument(deleteColumns(doc, [1]))).toBe("a,c\n1,3\n4,6\n7,9\n");
    expect(deleteColumns(doc, [0, 2]).columnCount).toBe(1);
  });

  it("adds a column without touching blank lines or rows too short to reach it", () => {
    expect(serializeCsvDocument(insertColumn(open("a,b\n\n1\n3,4\n"), 2))).toBe("a,b,\n\n1\n3,4,\n");
    expect(serializeCsvDocument(insertColumn(open("a,b\n1,2\n"), 0))).toBe(",a,b\n,1,2\n");
  });

  it("starts an empty file with one row", () => {
    expect(serializeCsvDocument(insertRow(open(""), 0, ["x"]))).toBe("x\n");
  });
});

describe("the view", () => {
  it("reads numbers the way the file writes them", () => {
    expect(parseNumber("42")).toBe(42);
    expect(parseNumber("-3.5")).toBe(-3.5);
    expect(parseNumber("1,234.50")).toBe(1234.5);
    expect(parseNumber("1.234,50")).toBe(1234.5);
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("1,234", true)).toBe(1.234);
    expect(parseNumber("12,50", true)).toBe(12.5);
    expect(parseNumber("$1,200")).toBe(1200);
    expect(parseNumber("45%")).toBe(45);
    expect(parseNumber("1 234 567")).toBe(1234567);
    expect(parseNumber("2024-01-05")).toBeNull();
    expect(parseNumber("555 1234")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });

  it("knows which columns are numbers", () => {
    expect(numericColumns(open("name,qty,price\nA,3,1.20\nB,12,0.85\n"), 1)).toEqual([false, true, true]);
    expect(numericColumns(open("Artikel;Preis\nA;1,20\nB;0,85\n"), 1)).toEqual([false, true]);
  });

  it("takes the first row as the header unless it is clearly data", () => {
    expect(firstRowIsHeader(open("name,qty\nApple,3\nPear,12\n"))).toBe(true);
    expect(firstRowIsHeader(open("1,Apple,3\n2,Pear,12\n"))).toBe(false);
    expect(firstRowIsHeader(open("name,city\nZoë,Köln\n"))).toBe(true);
    expect(firstRowIsHeader(open(""))).toBe(false);
  });

  it("sorts numbers as numbers, text as text, and empty cells last", () => {
    const doc = open("name,qty\nb,10\na,9\nc,\nd,100\n");
    const numeric = numericColumns(doc, 1);
    expect(viewRows(doc, 1, "", { column: 1, direction: "asc" }, numeric)).toEqual([2, 1, 4, 3]);
    expect(viewRows(doc, 1, "", { column: 1, direction: "desc" }, numeric)).toEqual([4, 1, 2, 3]);
    expect(viewRows(doc, 1, "", { column: 0, direction: "asc" }, numeric)).toEqual([2, 1, 3, 4]);
    expect(viewRows(doc, 1, "", null, numeric)).toEqual([1, 2, 3, 4]);
  });

  it("filters across every cell, ignoring case, and never changes the document", () => {
    const doc = open("name,note\nApple,\"red, round\"\nPear,green\nPlum,\"dark RED\"\n");
    const before = serializeCsvDocument(doc);
    expect(viewRows(doc, 1, "red", null)).toEqual([1, 3]);
    expect(viewRows(doc, 1, "  PEAR ", { column: 0, direction: "desc" })).toEqual([2]);
    expect(viewRows(doc, 0, "name", null)).toEqual([0]);
    expect(serializeCsvDocument(doc)).toBe(before);
  });

  it("names columns by letter", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("names a cell by its letter and its line in the file, and reads the name back", () => {
    expect(cellReference(3, 1)).toBe("B4");
    expect(cellReference(0, 27)).toBe("AB1");
    expect(parseCellReference("b4")).toEqual({ row: 3, column: 1 });
    expect(parseCellReference(" AB1 ")).toEqual({ row: 0, column: 27 });
    for (const text of ["", "4", "B", "B0", "B-1", "hello world", "A1:B2"]) expect(parseCellReference(text)).toBeNull();
  });
});

describe("how a cell is shown", () => {
  const kind = (value: string, decimalComma = false) => formatCell(value, decimalComma).kind;

  it("reads accounting brackets as a negative number", () => {
    expect(parseNumber("(1,234.50)")).toBe(-1234.5);
    expect(parseNumber("($12)")).toBe(-12);
    expect(parseNumber("(-3)")).toBeNull();
    expect(parseNumber("((3))")).toBeNull();
    expect(parseNumber("(see note)")).toBeNull();
  });

  it("tells numbers, percents and money apart, and marks the negative ones", () => {
    expect(formatCell("1,234.50")).toEqual({ kind: "number", negative: false, text: "1,234.50" });
    expect(formatCell("-3")).toEqual({ kind: "number", negative: true, text: "-3" });
    expect(formatCell("(250.00)")).toEqual({ kind: "number", negative: true, text: "(250.00)" });
    expect(formatCell("12.5%")).toEqual({ kind: "percent", negative: false, text: "12.5%" });
    expect(formatCell("-4%").negative).toBe(true);
    expect(kind("$1,200")).toBe("currency");
    expect(kind("-€ 12,50", true)).toBe("currency");
    expect(kind("12 €")).toBe("currency");
    expect(kind("0")).toBe("number");
    expect(formatCell("0").negative).toBe(false);
  });

  it("knows a date when it sees one", () => {
    for (const value of ["2026-11-24", "2026-11-24 09:30", "2026-11-24T09:30:00Z", "2026-11-24T09:30:00.250+01:00", "2026/11/24", "11/24/2026", "24.11.2026", "24-11-26",
      "11/24/2026 9:30 PM", "Nov 24, 2026", "24 Nov 2026", "November 24", "24-Nov-26", "Tue, 24 Nov 2026", "November 2026", "09:30", "9:30:15 pm"]) {
      expect(isDateValue(value), value).toBe(true);
      expect(kind(value), value).toBe("date");
    }
    for (const value of ["2026-13-01", "2026-11-32", "13/13/2026", "1.5", "2026", "v1.2.3", "May", "March on", "12:5", "A-12", "1-2", "Room 12/3/4"]) expect(isDateValue(value), value).toBe(false);
  });

  it("shows TRUE and FALSE, links and blanks for what they are, and leaves the rest alone", () => {
    expect(formatCell("true")).toEqual({ kind: "boolean", negative: false, text: "TRUE" });
    expect(formatCell(" False ")).toEqual({ kind: "boolean", negative: false, text: "FALSE" });
    expect(kind("truely")).toBe("text");
    expect(formatCell("https://markiedocs.com/download?x=1")).toEqual({ kind: "url", negative: false, text: "https://markiedocs.com/download?x=1" });
    expect(kind("HTTP://example.com")).toBe("url");
    expect(kind("https://example.com and more")).toBe("text");
    expect(kind("javascript:alert(1)")).toBe("text");
    expect(kind("ftp://example.com")).toBe("text");
    expect(formatCell("   ")).toEqual({ kind: "empty", negative: false, text: "" });
    expect(formatCell("")).toEqual({ kind: "empty", negative: false, text: "" });
    // The text a cell shows is the file's own, spaces and all.
    expect(formatCell(" Pear ")).toEqual({ kind: "text", negative: false, text: " Pear " });
  });

  it("sums, averages and counts the numbers in a block", () => {
    const doc = open("name,qty,price\nApple,3,1.20\nPear,12,\"0.85\"\nPlum,,n/a\nFig,(5),50%\n");
    expect(rangeStats(doc, [1, 2, 3, 4], 1, 2)).toEqual({ count: 6, sum: 62.05, average: 10.3416666667 });
    expect(rangeStats(doc, [1, 2], 1, 1)).toEqual({ count: 2, sum: 15, average: 7.5 });
    expect(rangeStats(doc, [1, 2, 3], 0, 0)).toBeNull();
    expect(rangeStats(open("a\n0.1\n0.2\n"), [1, 2], 0, 5)).toEqual({ count: 2, sum: 0.3, average: 0.15 });
  });
});

describe("clipboard", () => {
  it("copies a block as TSV or CSV", () => {
    const doc = open("a,b\n\"x,y\",2\n\"two\nlines\",4\n");
    expect(cellsToText(doc, [1, 2], [0, 1], "\t")).toBe("x,y\t2\n\"two\nlines\"\t4");
    expect(cellsToText(doc, [1, 2], [0, 1], ",")).toBe("\"x,y\",2\n\"two\nlines\",4");
  });

  it("reads a pasted block", () => {
    expect(clipboardToCells("a\tb\r\nc\td\r\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(clipboardToCells("one, two")).toEqual([["one, two"]]);
    expect(clipboardToCells("x\t\"multi\nline\"")).toEqual([["x", "multi\nline"]]);
  });
});

describe("the raw text view", () => {
  it("gives an editor plain lines and puts the file's shape back", () => {
    const original = "﻿a,b\r\n1,2\r\n";
    expect(plainEditorText(original)).toBe("a,b\n1,2\n");
    expect(restoreTextShape(original, "a,b\n1,2\n3,4\n")).toBe("﻿a,b\r\n1,2\r\n3,4\r\n");
    expect(restoreTextShape("a,b\n1,2\n", "a,b\n1,2\n3,4\n")).toBe("a,b\n1,2\n3,4\n");
    expect(restoreTextShape(original, plainEditorText(original))).toBe(original);
  });
});

describe("a large file", () => {
  it("opens, edits and saves 100,000 rows", () => {
    const lines = ["id,name,amount,note"];
    for (let i = 1; i <= 100_000; i++) lines.push(`${i},Name ${i},${(i * 1.5).toFixed(2)},"note, ${i}"`);
    const text = lines.join("\n") + "\n";
    const doc = open(text);
    expect(doc.rows.length).toBe(100_001);
    expect(serializeCsvDocument(doc)).toBe(text);
    const edited = setCell(doc, 50_000, 1, "Changed");
    expect(serializeCsvDocument(edited).length).toBe(text.length - "Name 50000".length + "Changed".length);
    expect(viewRows(doc, 1, "name 99999", null)).toEqual([99_999]);
  });
});
