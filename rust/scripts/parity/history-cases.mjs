// Electron's version history and draft rules (electron/history.js,
// snapshots.js, drafts.js) on generated inputs, as the fixture markie-core's
// history and drafts tests hold Markie RS to. Regenerate:
//
//   node rust/scripts/parity/history-cases.mjs > rust/crates/markie-core/tests/fixtures/history_electron.json
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(repo, "package.json"));
const { planRetention, msForStamp, cleanName, slugFor, stampFor, DEFAULT_CAPS } = require(path.join(repo, "electron/history.js"));
const { keyFor } = require(path.join(repo, "electron/drafts.js"));

// A small fixed PRNG so the fixture is stable.
let seed = 0x9e3779b9;
const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);

const HOUR = 3600_000, DAY = 24 * HOUR;
const now = Date.UTC(2026, 10, 22, 12, 0, 0);
const retention = [];
for (let run = 0; run < 60; run++) {
  const n = 1 + Math.floor(rand() * 260);
  const small = run % 3 === 0;
  const caps = small ? { keepNewest: 2, maxPerFile: 12 } : {};
  const entries = [];
  for (let i = 0; i < n; i++) {
    const age = Math.floor(rand() * (rand() < 0.5 ? 2 * DAY : 45 * DAY));
    const undated = rand() < 0.03;
    // A stray file no stamp parser can date. (V8's legacy Date.parse reads
    // some odd names, "odd-0-8" for one, as local dates; Markie never writes
    // such names, so the fixture leaves that quirk out.)
    const letters = (k) => (k < 26 ? "" : letters(Math.floor(k / 26) - 1)) + String.fromCharCode(97 + (k % 26));
    const stamp = undated ? `stray-${letters(run * 300 + i)}` : `${stampFor(new Date(now - age))}${rand() < 0.05 ? "-2" : ""}`;
    if (entries.some((e) => e.stamp === stamp)) continue;
    entries.push({ stamp, ms: msForStamp(stamp), named: rand() < 0.05 });
  }
  retention.push({ now, caps, entries, drop: [...planRetention(entries, now, caps)].sort() });
}

const stamps = [
  "2026-11-22T12-00-00.000Z", "2026-11-22T12-00-00.000Z-2", "2026-11-22T12-00-00.000Z-17", "2026-01-02T03-04-05Z",
  "2026-11-22T12-00-00.5Z", "not-a-stamp", "2026-13-01T00-00-00.000Z", "",
];
const names = [
  "  Launch\ndraft ", "a‮b­c\u{e0041}d", "  x   y  ", "tab\there", "😀".repeat(130), "a".repeat(119) + "  b",
  "\u0000\u0007bell", "zero​width", "", "   ", "é", "﻿bom",
];
const paths = [
  "/Users/k/notes/a.md", "/Users/k/notes/Read me (draft).md", "/tmp/日本語のメモ.md", "/tmp/" + "x".repeat(80) + ".md",
  "/tmp/émoji 😀.md", "/tmp/.hidden", "/tmp/a/b/../c.md",
];

console.log(JSON.stringify({
  defaultCaps: DEFAULT_CAPS,
  retention,
  msForStamp: stamps.map((s) => ({ stamp: s, ms: msForStamp(s) })),
  stampFor: [0, 1, 999, now, now + 123].map((ms) => ({ ms, stamp: stampFor(new Date(ms)) })),
  cleanName: names.map((n) => ({ raw: n, out: cleanName(n) })),
  slugFor: paths.map((p) => ({ path: p, slug: slugFor(p), draftKey: keyFor(p) })),
}));
