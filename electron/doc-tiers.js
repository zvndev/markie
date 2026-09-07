// How big a markdown file is allowed to be, decided before it is read.
//
// Opening a file used to run the whole text through three TipTap parses and
// two per-block sweeps on the renderer's main thread, with no size check
// anywhere on the way. A 4.4 MB file parsed in about 1.6 s and then wedged the
// renderer for a minute building DOM for 33,000 blocks; scrolling kept working
// because the compositor is a different thread, and nothing else did. Main is
// the one place every entry point passes through (rows, drops, `open -a`, the
// CLI, the MCP tool, Finder), so the size is settled here, from a stat, and
// the renderer only ever sees the decision.
//
// Two lines, both single constants:
//
//   LARGE_DOC_BYTES: at or above this the file opens in Source view only. The
//   rich pane, the reconstruction probe, the warm-up sweep and the crash
//   journal are all skipped; CodeMirror is virtualized and handles the size.
//   MAX_DOC_BYTES: at or above this Markie refuses the file and says so.
//
// The renderer keeps the same two numbers in src/lib/doc-tiers.ts; a test
// holds the two files to the same values.
"use strict";

const fs = require("fs");

const LARGE_DOC_BYTES = 1_000_000;
const MAX_DOC_BYTES = 100_000_000;

/** "ok" below the large line, "large" from there, "tooLarge" from the cap. */
function tierForSize(size) {
  if (!Number.isFinite(size) || size < 0) return "ok";
  if (size >= MAX_DOC_BYTES) return "tooLarge";
  if (size >= LARGE_DOC_BYTES) return "large";
  return "ok";
}

/**
 * Read a document the size-aware way: stat first, refuse before reading when
 * the file is over the cap, and flag a large one so the renderer can open it
 * in Source view. `io` exists for tests, which must not need a 100 MB file.
 *
 * Returns `{ tooLarge: true, size }` or `{ content, size, large }`. Throws
 * what fs throws for a path that cannot be read; the caller already turns
 * that into "nothing opened".
 *
 * @param {string} filePath
 * @param {{ statSync(p: string): { size: number }, readFileSync(p: string, encoding: "utf-8"): string }} [io]
 */
function readDocumentTiered(filePath, io = fs) {
  const size = io.statSync(filePath).size;
  const tier = tierForSize(size);
  if (tier === "tooLarge") return { tooLarge: true, size };
  const content = io.readFileSync(filePath, "utf-8");
  return { content, size, large: tier === "large" };
}

/**
 * "4.4 MB", "143 MB", "1.0 MB": one decimal under 10 MB, none above. The
 * renderer formats sizes the same way (src/lib/doc-tiers.ts), so a size named
 * in copy reads the same from either side.
 */
function formatMegabytes(bytes) {
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb).toString()} MB`;
}

module.exports = {
  LARGE_DOC_BYTES,
  MAX_DOC_BYTES,
  tierForSize,
  readDocumentTiered,
  formatMegabytes,
};
