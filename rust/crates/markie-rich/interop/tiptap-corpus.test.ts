// The Node half of the TipTap corpus check (tiptap-corpus.sh). Electron's own
// probeReconstruction and block normalizer, on the inputs Markie RS exported.
// MARKIE_TIPTAP_SKIP / MARKIE_TIPTAP_TAKE batch it: TipTap's setContent leaks
// in jsdom (see rich-roundtrip.corpus.test.tsx), so one process cannot do all.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBlockNormalizer, probeReconstruction } from "@/lib/rich-roundtrip";

const DIR = process.env.MARKIE_TIPTAP_DIR;
const run = DIR ? it : it.skip;

run("electron half", () => {
  const skip = Number(process.env.MARKIE_TIPTAP_SKIP ?? 0);
  const take = Number(process.env.MARKIE_TIPTAP_TAKE ?? 1e9);
  const lines = readFileSync(join(DIR!, "rs.jsonl"), "utf8").split("\n").filter(Boolean);
  const { normalize } = createBlockNormalizer();
  let n = 0;
  for (const line of lines.slice(skip, skip + take)) {
    const r = JSON.parse(line) as { path: string; md: string; blocks: { source: string }[] };
    const probe = probeReconstruction(r.md);
    const blocks = r.blocks.map((b) => normalize(b.source));
    appendFileSync(
      join(DIR!, "electron.jsonl"),
      JSON.stringify({ path: r.path, clean: probe.clean, output: probe.output, blocks }) + "\n"
    );
    n++;
  }
  expect(n).toBeGreaterThanOrEqual(0);
}, 3_600_000);
