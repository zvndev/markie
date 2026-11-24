import { describe, expect, it } from "vitest";
import { CSV_FIXTURES } from "./csv-fixtures";
import { decodeTextDocument, encodeTextDocument } from "./document-formats";
import {
  cellValue, cellsToText, clipboardToCells, columnLetter, decodeField, deleteColumns, deleteRows, encodeField, firstRowIsHeader,
  insertColumn, insertRow, numericColumns, parseCsvDocument, parseNumber, plainEditorText, restoreTextShape, serializeCsvDocument,
  setCell, sniffDelimiter, viewRows,
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
