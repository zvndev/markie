// Compare a renderer's results (markie-math by default) against KaTeX on the
// same formulas.
//
//   node scripts/katex-compare.mjs <dump.jsonl> [path/to/node_modules/katex]
//
// <dump.jsonl> comes from the corpus test (MARKIE_CORPUS_DUMP) or the KaTeX
// command probe (MARKIE_KATEX_PROBE_DUMP). Each line is
// {"tex", "display", "ok", "err"}. KaTeX runs with throwOnError, the way
// Markie's web app treats a formula it cannot draw.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [dumpPath, katexDir = "node_modules/katex"] = process.argv.slice(2);
const engine = process.env.ENGINE || "markie-math";
if (!dumpPath) {
  console.error("usage: node katex-compare.mjs <dump.jsonl> [katex dir]");
  process.exit(2);
}
const require = createRequire(path.resolve(katexDir, "package.json"));
const katex = require(path.resolve(katexDir));

const rows = readFileSync(dumpPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const seen = new Set();
const cells = { bothOk: 0, oursOnly: 0, katexOnly: 0, bothFail: 0 };
const katexOnly = [];
const oursOnly = [];
for (const r of rows) {
  const key = `${r.display ? "D" : "I"}${r.tex}`;
  if (seen.has(key)) continue;
  seen.add(key);
  let k = true;
  let kerr = null;
  try {
    katex.renderToString(r.tex, { displayMode: r.display, throwOnError: true, strict: "ignore", trust: false });
  } catch (e) {
    k = false;
    kerr = String(e.message || e).split("\n")[0];
  }
  if (k && r.ok) cells.bothOk++;
  else if (!k && !r.ok) cells.bothFail++;
  else if (k) {
    cells.katexOnly++;
    katexOnly.push({ tex: r.tex.slice(0, 140), ours: r.err });
  } else {
    cells.oursOnly++;
    oursOnly.push({ tex: r.tex.slice(0, 140), katex: kerr });
  }
}
const katexOk = cells.bothOk + cells.katexOnly;
console.log(`unique formulas: ${seen.size}`);
console.log(`KaTeX renders ${katexOk}; ${engine} renders ${cells.bothOk} of those (${((cells.bothOk * 100) / Math.max(1, katexOk)).toFixed(1)}%)`);
console.log(JSON.stringify(cells));
const show = (label, list, field) => {
  console.log(`\n${label} (${list.length}):`);
  for (const x of list.slice(0, Number(process.env.SHOW || 60))) console.log(`  ${JSON.stringify(x.tex)}\n      -> ${x[field]}`);
};
show(`KaTeX ok, ${engine} fails`, katexOnly, "ours");
show(`${engine} ok, KaTeX fails`, oursOnly, "katex");
