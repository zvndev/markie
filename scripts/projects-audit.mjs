#!/usr/bin/env node
// Runs the 0.5.0 organization engine against the REAL device index, read only,
// and reports what the taxonomy would show. This is the release gate for the
// clustering heuristic: if the numbers are junk, the heuristic gets tuned, not
// the report and not the gate.
//
// Usage: npm run projects:audit
//        node scripts/projects-audit.mjs [--db <registry.db>] [--home <dir>]
//                                        [--config <Projects.md>] [--json]
//                                        [--no-extract]
//
// Two deviations from the plan, both forced by the environment:
//   * better-sqlite3 cannot be required here. The prebuild in node_modules is
//     compiled for Electron's ABI (NODE_MODULE_VERSION 145), and plain Node is
//     137, so the require throws before any query runs. Node's own
//     node:sqlite reads the same file and opens it read only.
//   * --experimental-strip-types alone cannot resolve the engine's `@/`
//     imports, so the shared resolve hook in scripts/lib/ts-engine-hook.mjs
//     supplies the alias and the extensions. No source file is reshaped for
//     the convenience of this script.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { installTsEngineHook } from "./lib/ts-engine-hook.mjs";

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const jsonOnly = args.includes("--json");
const log = (...a) => { if (!jsonOnly) console.log(...a); };

const home = flag("--home") ?? homedir();
const dbPath =
  flag("--db") ??
  path.join(home, "Library", "Application Support", "markie", "registry.db");
// electron/workspace.js: the workspace root, and therefore Projects.md, lives
// at ~/Documents/Markie.
const configPath = flag("--config") ?? path.join(home, "Documents", "Markie", "Projects.md");

if (!fs.existsSync(dbPath)) {
  console.error(`No registry at ${dbPath}. Run Markie once, or pass --db.`);
  process.exit(2);
}

installTsEngineHook();
const { parseRules } = await import("../src/lib/projects/rules.ts");
const { buildTaxonomy } = await import("../src/lib/projects/taxonomy.ts");
const { buildAuditReport, evaluateGates } = await import("../src/lib/projects/audit.ts");

const db = new DatabaseSync(dbPath, { readOnly: true });
const query = (sql) => {
  try {
    return db.prepare(sql).all();
  } catch {
    return []; // pre-migration database: the projects tables do not exist yet
  }
};

const rows = query("SELECT path, name, mtime_ms FROM md_index_cache");
if (!rows.length) {
  console.error(`The index at ${dbPath} is empty. Open Markie and let it scan first.`);
  process.exit(2);
}
const metaRows = query("SELECT * FROM md_meta");
const pins = query("SELECT * FROM project_pins");
const blocks = query("SELECT * FROM project_blocks");
db.close();

const metaByPath = new Map(metaRows.map((m) => [m.path, m]));
const indexRows = rows.map((r) => ({
  path: r.path,
  name: r.name,
  dir: path.dirname(r.path),
  mtimeMs: r.mtime_ms,
}));

// A registry that has never run the metadata pass answers every question with
// null, and the taxonomy that falls out of that is not the one the app shows:
// with no repo names, 11,168 files collapse into one folder-derived project.
// Auditing that would be auditing a bug. So the audit runs the SAME extractor
// the main process runs (electron/mdmeta.js takes its registry as an argument,
// and imports nothing from electron), against an in-memory store. The owner's
// registry is never written to.
let extractedMs = 0;
if (!args.includes("--no-extract") && metaRows.length < indexRows.length) {
  const { refreshMeta } = require("../electron/mdmeta.js");
  const memory = new Map(metaRows.map((m) => [m.path, m]));
  const scannedAt = new Date().toISOString();
  const shim = {
    metaAll: () => [...memory.values()],
    metaUpsertMany: (list) => {
      for (const m of list) {
        memory.set(m.path, {
          path: m.path,
          mtime_ms: m.mtimeMs,
          birthtime_ms: m.birthtimeMs,
          fm_project: m.fmProject,
          fm_block: m.fmBlock,
          repo_name: m.repoName,
          scanned_at: scannedAt,
        });
      }
    },
  };
  const startedExtract = Date.now();
  const { updated } = refreshMeta(indexRows, { registry: shim, home });
  extractedMs = Date.now() - startedExtract;
  metaByPath.clear();
  for (const [k, v] of memory) metaByPath.set(k, v);
  log(`extracted metadata for ${updated} files in ${extractedMs}ms (in memory, nothing written)`);
}

const files = indexRows.map((r) => {
  const m = metaByPath.get(r.path);
  return {
    ...r,
    birthtimeMs: m ? m.birthtime_ms : null,
    fmProject: m ? m.fm_project : null,
    fmBlock: m ? m.fm_block : null,
    repoName: m ? m.repo_name : null,
  };
});

let rulesDoc = "";
try {
  rulesDoc = fs.readFileSync(configPath, "utf-8");
} catch {
  // No config document yet: the engine's defaults are what a new user gets,
  // and auditing those is the more useful reading anyway.
}
const parsed = parseRules(rulesDoc);
const rules = parsed.rules ?? parseRules("").rules;

const started = Date.now();
const taxonomy = buildTaxonomy(files, {
  pins: pins.map((p) => ({ path: p.path, project: p.project, block_id: p.block_id })),
  rules,
  priorAssignments: [],
  knownBlocks: blocks,
  home,
});
const engineMs = Date.now() - started;

const report = buildAuditReport(taxonomy, {
  indexedFiles: files.length,
  engineMs,
  rulesError: parsed.error,
});
const failures = evaluateGates(taxonomy, report, rules.clustering.maxBlocksPerProject);

log(`\nMarkie projects audit  (${report.indexedFiles} indexed files, engine ${engineMs}ms)`);
log(`database: ${dbPath}`);
log(`config:   ${fs.existsSync(configPath) ? configPath : configPath + "  (absent, engine defaults)"}`);
log(`metadata: ${metaByPath.size}/${rows.length} files (${metaRows.length} already in the registry)\n`);
log(
  `projects: ${report.projects}   blocks: ${report.blocks}   ` +
    `unfiled: ${report.unfiled} (${report.unfiledPct}% of ${report.organizedFiles} organized)   ` +
    `ignored: ${report.ignoredFiles}   singleton blocks: ${report.singletonBlockPct}%`
);
if (report.rulesError) log(`RULES ERROR: ${report.rulesError}`);

log("\nTop projects:");
for (const p of report.top20) {
  const lb = p.largestBlock ? `largest block ${p.largestBlock.files} (${p.largestBlock.sharePct}%)` : "";
  log(
    `  ${p.name.slice(0, 32).padEnd(32)} ${String(p.files).padStart(5)} files  ` +
      `${String(p.blocks).padStart(3)} blocks  ${lb.padEnd(30)} updated ${p.updated.slice(0, 10)}`
  );
}

log("\nSample tree (5 most recent projects):");
for (const p of taxonomy.projects.slice(0, 5)) {
  log(`  ${p.name}`);
  for (const b of p.blocks.slice(0, 6)) {
    log(`    [${b.name}]  ${b.files.length} files  updated ${new Date(b.updated).toISOString().slice(0, 10)}`);
    for (const f of b.files.slice(0, 3)) log(`      ${f.name}`);
  }
}

const outDir = path.join(process.cwd(), ".autoloop", "runs");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `projects-audit-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify({ ...report, failures }, null, 2));
log(`\nReport written to ${outFile}`);

if (jsonOnly) console.log(JSON.stringify({ ...report, failures }, null, 2));

for (const f of failures) console.error(`GATE FAILED (${f.gate}): ${f.message}`);
if (!failures.length) log("\nAll gates passed.");
process.exit(failures.length ? 1 : 0);
