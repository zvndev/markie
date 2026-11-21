// List every math-mode command and environment KaTeX defines, each with the
// first argument shape KaTeX itself accepts, one probe per line:
//   I<TAB><tex>
//
//   node scripts/katex-probes.mjs [path/to/node_modules/katex] > probes.tsv
//
// Names come from KaTeX's own source (src/functions, src/symbols.ts,
// src/macros.ts, src/environments). The coverage test renders the probes
// (MARKIE_KATEX_PROBES) and dumps results for katex-compare.mjs.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const katexDir = path.resolve(process.argv[2] || "node_modules/katex");
const require = createRequire(path.join(katexDir, "package.json"));
const katex = require(katexDir);
const src = (p) => readFileSync(path.join(katexDir, "src", p), "utf8");

const names = new Set();
// Names are JS string literals; decode them properly so "\u00A9" becomes ©
// (a character, not a command) and "\\frac" becomes \frac.
const unescape = (s) => {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s.replace(/\\\\/g, "\\");
  }
};
// names: ["\\frac", ...] blocks in functions and environments
const listNames = (text) => {
  const out = [];
  for (const m of text.matchAll(/names:\s*\[([^\]]*)\]/g)) {
    for (const n of m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(unescape(n[1]));
  }
  return out;
};
for (const f of readdirSync(path.join(katexDir, "src", "functions"))) {
  if (f.endsWith(".ts")) for (const n of listNames(src(`functions/${f}`))) names.add(n);
}
// defineSymbol(math, font, group, char, "\\name", ...): math mode only
for (const m of src("symbols.ts").matchAll(/defineSymbol\(\s*math\s*,[^,]+,[^,]+,[^,]+,\s*"((?:[^"\\]|\\.)*)"/g)) {
  names.add(unescape(m[1]));
}
for (const m of src("macros.ts").matchAll(/defineMacro\(\s*"((?:[^"\\]|\\.)*)"/g)) names.add(unescape(m[1]));
const envs = new Set();
for (const f of readdirSync(path.join(katexDir, "src", "environments"))) {
  if (f.endsWith(".ts")) for (const n of listNames(src(`environments/${f}`))) envs.add(n);
}

const ok = (tex) => {
  try {
    katex.renderToString(tex, { throwOnError: true, strict: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const shapes = (c) => [
  `${c}`,
  `${c}{x}`,
  `${c}{x}{y}`,
  `${c}{x}{y}{z}`,
  `x ${c} y`,
  `${c}{red}{x}`,
  `${c}{1em}`,
  `${c}{1em}{x}`,
  `${c}[2]{x}`,
  `${c}( x \\right)`,
  `\\left( x ${c})`,
  `\\left( x ${c}| y \\right)`,
  `\\sum${c}_{i}`,
  `${c} x`,
];
const probes = [];
let skipped = 0;
for (const n of [...names].sort()) {
  if (!n.startsWith("\\") || n === "\\begin" || n === "\\end") continue;
  const hit = shapes(n).find(ok);
  if (hit) probes.push(hit);
  else skipped++;
}
for (const e of [...envs].sort()) {
  const bodies = ["a & b \\\\ c & d", "x &= y \\\\ &= z"];
  const args = ["", "{cc}", "{2}"];
  let hit = null;
  for (const a of args) for (const b of bodies) {
    const t = `\\begin{${e}}${a} ${b} \\end{${e}}`;
    if (!hit && ok(t)) hit = t;
  }
  if (hit) probes.push(hit);
  else skipped++;
}
for (const p of probes) console.log(`I\t${p}`);
console.error(`${probes.length} probes, ${skipped} names KaTeX rejects in every probed shape (text-only or special)`);
