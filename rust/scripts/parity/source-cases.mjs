// Electron's Format Tables (src/lib/format-tables.ts) and CSV conversions
// (src/lib/csv.ts) on a battery of inputs, as the fixture the Rust tests hold
// Markie RS to. Regenerate:
//
//   node --import ./rust/scripts/ts-run/register.mjs rust/scripts/parity/source-cases.mjs > rust/crates/markie-app/tests/fixtures/source_electron.json
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { formatMarkdownTables } = await import(path.join(repo, "src/lib/format-tables.ts"));
const { computeStats } = await import(path.join(repo, "src/lib/stats.ts"));
const { csvToMarkdownTable, markdownTableToCSV, csvDropsContent } = await import(path.join(repo, "src/lib/csv.ts"));

const tables = [
  "| a | b |\n|---|---|\n| 1 | 22 |\n",
  "|a|b|\n|:-|-:|\n|long cell|x|\n",
  "| a | b | c |\n|:---:|---|--:|\n| 1 |\n| 1 | 2 | 3 | 4 |\n",
  "a | b\n--- | ---\nc | d\n",
  "| 日本 | é |\n|---|---|\n| 😀 | x |\n",
  "| a \\| b | c |\n|---|---|\n| `x | y` | z |\n",
  "text\n\n| a |\n|---|\n| b |\n\nmore text\n",
  "```\n| not | a table |\n|---|---|\n```\n",
  "    | indented | code |\n    |---|---|\n",
  "> | a | b |\n> |---|---|\n> | c | d |\n",
  "| a |\n| b |\n",
  "| a | b |\r\n|---|---|\r\n| c | d |\r\n",
  "~~~\n| a |\n|---|\n~~~\n| x | y |\n|-|-|\n",
  "no tables here\n",
];

const csvs = [
  "a,b\n1,2\n",
  "name,note\n\"Smith, J\",\"said \"\"hi\"\"\"\n",
  "a,b\n1\n1,2,3\n",
  "a|b,c\nx,y\n",
  "multi,line\n\"one\ntwo\",x\n",
  "",
  "﻿a,b\r\n1,2\r\n",
  "a,b\n\n",
];

const markdowns = [
  "| a | b |\n|---|---|\n| 1 | 2 |\n",
  "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n| c |\n|---|\n| 3 |\n",
  "| a \\| b | c |\n|---|---|\n| x, y | \"q\" |\n",
  "| a<br>b | c |\n|---|---|\n| 1 | 2 |\n",
  "just text\n",
  "",
];

const texts = [
  "", "   ", "# Title\n\nSome words here.\n## Two", "#\nnot a heading?\n####### seven\n###\ttab",
  "```js\ncode\n```\n\n```\nunclosed", "[a](b) [c]() [](d) ![img](e) [x](y)(z)", "日本語 😀 é\u00a0word\ufeffjoin",
  "line\r\n# crlf heading\r\n", "a\u2028# after LS", "word ".repeat(450), "tabs\tand\nnew\n\nlines  ",
];

console.log(JSON.stringify({
  stats: texts.map((i) => ({ in: i, out: computeStats(i) })),
  formatTables: tables.map((i) => ({ in: i, out: formatMarkdownTables(i) })),
  csvToMarkdown: csvs.map((i) => ({ in: i, out: csvToMarkdownTable(i) })),
  markdownToCsv: markdowns.map((i) => ({ in: i, out: markdownTableToCSV(i), drops: csvDropsContent(i) })),
}, null, 1));
