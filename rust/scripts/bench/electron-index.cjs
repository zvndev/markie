// Electron Markie's device index scan and Library filter, timed in Node.
//
//   node electron-index.cjs <repo-root> [runs] [query…]
//
// MARKIE_BENCH_HOME=<dir> scans that folder as the home instead.
// Runs the app's own `electron/mdindex.js` rescan over the home folder (read
// only, its default budget), then the Library filter from
// `src/components/browse-view.tsx` (path, snippet and format substring
// match) over the result. Node is the same V8 the Electron main process
// runs; the renderer's tree build and React render after the filter are not
// included, so Electron's real search latency is higher than this.
const path = require("node:path");

const repo = process.argv[2];
const runs = Number(process.argv[3] || 5);
let queries = process.argv.slice(4);
if (!queries.length) queries = ["readme", "plan", "markie perf", "zzzz-no-match", "a"];
const mdindex = require(path.join(repo, "electron", "mdindex.js"));

// browse-view.tsx `rowFormat`: the row's format, else its extension.
const rowFormat = (r) => (r.format || path.extname(r.path).slice(1) || "").toLowerCase();
function filter(rows, filterText) {
  const q = filterText.trim().toLowerCase();
  return rows.filter((r) => {
    if (!q) return true;
    return r.path.toLowerCase().includes(q) || (r.snippet ?? "").toLowerCase().includes(q) || rowFormat(r).includes(q);
  });
}

(async () => {
  const scans = [];
  let snap = null;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    snap = await mdindex.rescan(process.env.MARKIE_BENCH_HOME ? { roots: [], home: process.env.MARKIE_BENCH_HOME } : { roots: [] });
    scans.push(performance.now() - t);
  }
  const rows = snap.files;
  const queryRows = queries.map((q) => {
    const ms = [];
    let hits = 0;
    for (let i = 0; i < Math.max(5, runs); i++) {
      const t = performance.now();
      hits = filter(rows, q).length;
      ms.push(performance.now() - t);
    }
    return { query: q, ms, hits };
  });
  console.log(JSON.stringify({
    scan_ms: scans,
    files: rows.length,
    snippets: rows.filter((r) => r.snippet).length,
    truncated: snap.truncatedReason || null,
    queries: queryRows,
  }));
})();
