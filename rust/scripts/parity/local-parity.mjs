// Run Electron's own global search and Projects code on the rows Markie RS
// indexed, and compare with what Markie RS produced. Read-only: it opens the
// fixture folder and nothing else.
//
//   node --import ./rust/scripts/ts-run/register.mjs rust/scripts/parity/local-parity.mjs <rs.json> <home>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(repo, "package.json"));
const docText = require(path.join(repo, "mcp/doc-text.cjs"));
const { extractMarkieMeta } = require(path.join(repo, "electron/frontmatter.js"));
const { findRepoRoot } = require(path.join(repo, "electron/mdmeta.js"));
const { buildTaxonomy } = await import(path.join(repo, "src/lib/projects/taxonomy.ts"));
const { parseRules } = await import(path.join(repo, "src/lib/projects/rules.ts"));

const [rsFile, home] = process.argv.slice(2);
const rs = JSON.parse(readFileSync(rsFile, "utf8"));
let failures = 0;
// Key order is not data: serde_json sorts keys, JavaScript keeps insertion order.
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const check = (label, a, b) => {
  const same = JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  if (!same) failures++;
  console.log(`${same ? "MATCH" : "DIFF "} ${label}`);
  if (!same) console.log("  electron:", JSON.stringify(a), "\n  rs:      ", JSON.stringify(b));
};

for (const s of rs.searches) {
  const res = await docText.searchDocuments(rs.rows, s.query, { supersede: false, cache: docText.createTextCache(), ...(rs.unbounded ? { maxMs: 3_600_000 } : {}) });
  console.log(`  "${s.query}": electron scanned ${res.scanned}${res.partial ? " (partial)" : ""}, rs scanned ${s.scanned}${s.partial ? " (partial)" : ""}`);
  check(`search "${s.query}" order`, res.results.map((r) => r.path), s.results.map((r) => r.path));
  check(`search "${s.query}" name hits`, res.results.map((r) => r.nameHit), s.results.map((r) => r.nameHit));
  check(`search "${s.query}" excerpts`, res.results.map((r) => r.excerpt ?? null), s.results.map((r) => r.excerpt ?? null));
}

const fs = await import("node:fs");
const files = rs.rows.filter((r) => r.format === "markdown").map((r) => {
  const head = fs.readFileSync(r.path, "utf8").slice(0, 4096);
  const meta = extractMarkieMeta(head);
  const st = fs.statSync(r.path);
  return { path: r.path, name: r.name, dir: r.dir, mtimeMs: r.mtimeMs, birthtimeMs: st.birthtimeMs > 0 ? st.birthtimeMs : null,
    fmProject: meta.project, fmBlock: meta.block, repoName: findRepoRoot(r.dir, { home }) };
});
const tax = buildTaxonomy(files, { pins: [], rules: parseRules("").rules, priorAssignments: [], knownBlocks: [], projectNames: [], home });
const shape = (projects) => projects.map((p) => ({ key: p.key, name: p.name, fileCount: p.fileCount,
  blocks: p.blocks.map((b) => ({ id: b.id, name: b.name, files: b.files.map((f) => f.path) })), loose: p.looseFiles.map((f) => f.path) }));
check("projects tree (keys, names, blocks, ids, files, order)", shape(tax.projects), rs.projects);
check("ignored count", tax.ignoredCount, rs.ignored);
console.log(failures ? `${failures} difference(s)` : "all match");
process.exit(failures ? 1 : 0);
