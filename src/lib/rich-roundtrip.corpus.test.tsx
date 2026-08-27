// Opt-in corpus audit. Run:
//   MARKIE_CORPUS_DIR=~/Documents npx vitest run src/lib/rich-roundtrip.corpus.test.tsx
// Reports the share of real documents the pipeline cannot reconstruct (which is
// exactly the share that opens read-only in Rich) and asserts the release
// target: well under 5%.
//
// MARKIE_CORPUS_SKIP walks past the first N files so a large corpus can be
// audited in batches. That is not a convenience: measured 2026-08-26, TipTap's
// setContent retains roughly 600 times a document's own size in this jsdom
// environment, and neither destroying the editor nor forcing GC gives it back,
// so a single process runs out of heap somewhere past 700 real files. Batch it
// and add the counts up.
import { describe, expect, it } from "vitest";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { probeReconstruction, describeLossRisks } from "@/lib/rich-roundtrip";

const dir = process.env.MARKIE_CORPUS_DIR;
const MAX_FILES = Number(process.env.MARKIE_CORPUS_MAX ?? 5000);
const SKIP_FILES = Number(process.env.MARKIE_CORPUS_SKIP ?? 0);
// vitest hides console output for a PASSING test, and the share is the whole
// point of this audit, so it is also appended to MARKIE_CORPUS_REPORT when set.
const REPORT = process.env.MARKIE_CORPUS_REPORT;

function* walk(d: string): Generator<string> {
  for (const name of readdirSync(d)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(d, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) yield* walk(p);
      else if (/\.(md|markdown)$/i.test(name) && st.size < 2_000_000) yield p;
    } catch {
      // unreadable entries are skipped
    }
  }
}

describe.skipIf(!dir)("corpus reconstruction audit", () => {
  it(
    "keeps the read-only fallback share well under 5%",
    () => {
      const files: string[] = [];
      let seen = 0;
      for (const f of walk(dir!)) {
        if (seen++ < SKIP_FILES) continue;
        files.push(f);
        if (files.length >= MAX_FILES) break;
      }
      expect(files.length).toBeGreaterThan(0);
      let failed = 0;
      const byRisk = new Map<string, number>();
      const failures: string[] = [];
      const started = Date.now();
      for (const f of files) {
        const md = readFileSync(f, "utf8");
        if (!probeReconstruction(md).clean) {
          failed++;
          if (failures.length < 50) failures.push(f);
          for (const r of describeLossRisks(md)) {
            byRisk.set(r, (byRisk.get(r) ?? 0) + 1);
          }
        }
      }
      const share = failed / files.length;
      const elapsed = Date.now() - started;
      console.log(
        `[corpus] ${files.length} files, ${failed} gated (${(share * 100).toFixed(2)}%)`
      );
      console.log(
        `[corpus] ${elapsed}ms total, ${(elapsed / files.length).toFixed(1)}ms per document`
      );
      console.log("[corpus] risks among gated files:", Object.fromEntries(byRisk));
      console.log("[corpus] sample gated files:", failures);
      if (REPORT) {
        appendFileSync(
          REPORT,
          JSON.stringify({
            dir,
            skip: SKIP_FILES,
            files: files.length,
            gated: failed,
            share,
            msPerDoc: elapsed / files.length,
            byRisk: Object.fromEntries(byRisk),
            failures,
          }) + "\n"
        );
      }
      expect(share).toBeLessThan(0.05);
    },
    600_000 // timeout: real corpora take a while
  );
});
