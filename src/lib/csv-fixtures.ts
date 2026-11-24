// The files the CSV round-trip tests open and save: every shape that an
// editor is tempted to "tidy". Written with explicit escapes so no tool that
// touches this file (git, an editor) can change a line ending or drop a BOM.
export interface CsvFixture { name: string; file: string; text: string; delimiter: "," | ";" | "\t" | "|"; rows: number; columns: number }

export const CSV_FIXTURES: readonly CsvFixture[] = [
  { name: "plain, trailing newline", file: "plain.csv", text: "name,qty,price\nApple,3,1.20\nPear,12,0.85\n", delimiter: ",", rows: 3, columns: 3 },
  { name: "no trailing newline", file: "no-newline.csv", text: "name,qty\nApple,3\nPear,12", delimiter: ",", rows: 3, columns: 2 },
  { name: "quoted newlines", file: "quoted-newlines.csv", text: "id,note\n1,\"line one\nline two\"\n2,\"a\r\nb\"\n3,plain\n", delimiter: ",", rows: 4, columns: 2 },
  { name: "embedded quotes", file: "embedded-quotes.csv", text: "id,quote\n1,\"She said \"\"hi\"\"\"\n2,\"\"\"\"\n3,\"a,b\"\n4,5\" pipe\n", delimiter: ",", rows: 5, columns: 2 },
  { name: "empty trailing cells", file: "empty-trailing.csv", text: "a,b,c,d\n1,,,\n,,,\n2,x,,\n", delimiter: ",", rows: 4, columns: 4 },
  { name: "ragged rows", file: "ragged.csv", text: "a,b,c\n1\n1,2\n1,2,3,4,5\n\n9,8,7\n", delimiter: ",", rows: 6, columns: 5 },
  { name: "BOM", file: "bom.csv", text: "﻿name,city\nZoë,Köln\nJosé,São Paulo\n", delimiter: ",", rows: 3, columns: 2 },
  { name: "CRLF", file: "crlf.csv", text: "name,qty\r\nApple,3\r\nPear,12\r\n", delimiter: ",", rows: 3, columns: 2 },
  { name: "CRLF, BOM, no trailing newline", file: "excel.csv", text: "﻿name,qty\r\nApple,3\r\nPear,12", delimiter: ",", rows: 3, columns: 2 },
  { name: "semicolon, decimal commas (European)", file: "european.csv", text: "Artikel;Menge;Preis\r\nApfel;3;1,20\r\nBirne;12;0,85\r\n\"Käse; alt\";1;12,50\r\n", delimiter: ";", rows: 4, columns: 3 },
  { name: "tab separated", file: "data.tsv", text: "name\tqty\tnote\nApple\t3\thas, comma\nPear\t12\t\"has\ttab\"\n", delimiter: "\t", rows: 3, columns: 3 },
  { name: "every field quoted", file: "quote-all.csv", text: "\"name\",\"qty\"\n\"Apple\",\"3\"\n\"Pear\",\"12\"\n", delimiter: ",", rows: 3, columns: 2 },
  { name: "mixed line endings", file: "mixed-eol.csv", text: "a,b\r\n1,2\n3,4\r5,6\r\n", delimiter: ",", rows: 4, columns: 2 },
  { name: "blank lines and spaces", file: "blank-lines.csv", text: "a,b\n\n 1 , 2 \n\n\n3,4\n\n", delimiter: ",", rows: 7, columns: 2 },
  { name: "malformed quotes", file: "malformed.csv", text: "a,b\n\"open,1\n2,\"x\"y,z\n3,\"never closed\n", delimiter: ",", rows: 3, columns: 2 },
  { name: "one column", file: "one-column.csv", text: "name\nApple\nPear\n", delimiter: ",", rows: 3, columns: 1 },
  { name: "pipe separated", file: "pipes.csv", text: "a|b|c\n1|2|3\n4|5|6\n", delimiter: "|", rows: 3, columns: 3 },
  { name: "empty file", file: "empty.csv", text: "", delimiter: ",", rows: 0, columns: 0 },
  { name: "only a newline", file: "newline.csv", text: "\n", delimiter: ",", rows: 1, columns: 1 },
];
