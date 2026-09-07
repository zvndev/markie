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
 * Read a document the size-aware way: measure first, refuse before reading
 * when the file is over the cap, and flag a large one so the renderer can
 * open it in Source view. One descriptor serves both the measurement and the
 * read: an editor or agent renaming a different file over the path between a
 * stat and a read would otherwise hand back that file's bytes under the first
 * file's size, which is how something over the cap could slip through. The
 * bytes that came back are classified again before they are decoded: a file
 * appended to in place between the stat and the read is not the size that
 * was measured, and the tier has to describe what the renderer would get.
 * `io` exists for tests, which must not need a 100 MB file.
 *
 * Returns `{ tooLarge: true, size }` or `{ content, size, large }`. Throws
 * what fs throws for a path that cannot be opened; the caller already turns
 * that into "nothing opened".
 *
 * @param {string} filePath
 * @param {{ openSync(p: string, flags: "r"): number, fstatSync(fd: number): { size: number }, readSync(fd: number, buffer: Buffer, offset: number, length: number, position: null): number, closeSync(fd: number): void }} [io]
 */
function readDocumentTiered(filePath, io = fs) {
  const fd = io.openSync(filePath, "r");
  try {
    const measured = io.fstatSync(fd).size;
    if (tierForSize(measured) === "tooLarge") return { tooLarge: true, size: measured };
    // Read at most the cap. A file that grows under the stat is refused at
    // the cap rather than read whole and decoded first: a writer on the same
    // machine must not be able to make main allocate whatever it likes. One
    // byte past the measured size is room to notice growth at all.
    let buffer = Buffer.allocUnsafe(Math.min(measured + 1, MAX_DOC_BYTES));
    let size = 0;
    for (;;) {
      if (size === buffer.length) {
        if (buffer.length >= MAX_DOC_BYTES) {
          return { tooLarge: true, size: Math.max(io.fstatSync(fd).size, MAX_DOC_BYTES) };
        }
        buffer = Buffer.concat([buffer], Math.min(buffer.length * 2, MAX_DOC_BYTES));
      }
      const n = io.readSync(fd, buffer, size, buffer.length - size, null);
      if (n === 0) break;
      size += n;
    }
    return { content: buffer.toString("utf-8", 0, size), size, large: tierForSize(size) === "large" };
  } finally {
    io.closeSync(fd);
  }
}

/**
 * The size, mtime and tier of a file, without reading it. For the moment a
 * write is about to happen and the question is only whether what is on disk
 * has grown past the cap, and for telling Markie's own write over the cap
 * from someone else's by its stat (electron/disk-memory.js). Throws what fs
 * throws.
 *
 * @param {string} filePath
 * @param {{ statSync(p: string): { size: number, mtimeMs: number } }} [io]
 */
function statDocument(filePath, io = fs) {
  const { size, mtimeMs } = io.statSync(filePath);
  return { size, mtimeMs, tier: tierForSize(size) };
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
  statDocument,
  formatMegabytes,
};
