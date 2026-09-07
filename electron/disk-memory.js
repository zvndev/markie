// What Markie last saw on disk, per path, so a save or a watcher poll can
// tell "nothing moved underneath me" from "something rewrote this file while
// it was open", which is the normal case when an agent is working in the same
// repo. Without it, saving blind-writes the buffer over the newer file.
//
// Extracted from main.js so the one exception to "over the cap is refused" is
// a tested fact: a file Markie itself just wrote is not a foreign change,
// however big it is. A write over the cap is allowed (refusing the user's
// bytes is the loss), and the next poll and the next save must not then treat
// Markie's own file as something that overtook the document.
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const docTiers = require("./doc-tiers");

// Bounded: one entry per file the session has read or written, and a long
// session in a large repo reads a lot of them.
const LAST_SEEN_LIMIT = 500;

function hashOf(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * @param {{ io?: typeof fs, limit?: number }} [options] `io` exists for tests, which must not need a 100 MB file.
 */
function createDiskMemory({ io = fs, limit = LAST_SEEN_LIMIT } = {}) {
  /** path -> { hash, ownWrite: { size, mtimeMs } | null } */
  const seen = new Map();

  /**
   * Record what is on disk at this path. `ownWrite` means Markie wrote these
   * bytes itself a moment ago: the file's size and mtime are kept beside the
   * hash, so a file too big to read back can still be recognised as ours.
   * Both fields, because a same-size rewrite by something else would match
   * the size alone. A read is never stamped: the stat would describe whatever
   * is on disk by then, not what was read.
   */
  function remember(filePath, content, { ownWrite = false } = {}) {
    let stamp = null;
    if (ownWrite) {
      try {
        const { size, mtimeMs } = docTiers.statDocument(filePath, io);
        stamp = { size, mtimeMs };
      } catch {
        // Without the stamp the file is treated like any other over the cap,
        // which is refused; the hash still serves under it.
      }
    }
    // Delete-then-set moves the key to the end, so the eviction below drops
    // the least recently recorded path rather than an arbitrary one.
    seen.delete(filePath);
    seen.set(filePath, { hash: hashOf(content), ownWrite: stamp });
    while (seen.size > limit) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  /** The stat describes the bytes Markie wrote, on both counts. */
  function isOwnWrite(known, stat) {
    const own = known?.ownWrite;
    return !!own && own.size === stat.size && own.mtimeMs === stat.mtimeMs;
  }

  /**
   * What is on disk when it differs from what we last saw: the text and its
   * size (the renderer settles the document's tier again from it, see
   * electron/doc-tiers.js), or, for a file that has grown past the cap, a
   * refusal without reading it, unless the file over the cap is the one
   * Markie wrote. Null when it matches, is unknown to us, or cannot be read.
   */
  function changedSince(filePath) {
    const known = seen.get(filePath);
    if (!known) return null; // never read it here; nothing to compare against
    let stat;
    try {
      stat = docTiers.statDocument(filePath, io);
    } catch {
      return null; // gone or unreadable; the write itself will report the failure
    }
    if (stat.tier === "tooLarge") {
      return isOwnWrite(known, stat) ? null : { tooLarge: true, size: stat.size };
    }
    let doc;
    try {
      doc = docTiers.readDocumentTiered(filePath, io);
    } catch {
      return null;
    }
    if (doc.tooLarge) return { tooLarge: true, size: doc.size };
    return hashOf(doc.content) === known.hash ? null : { content: doc.content, size: doc.size };
  }

  /**
   * `{ tooLarge: true, size }` when the file at this path is over the cap and
   * is not Markie's own write, else null (including when it cannot be
   * stat'ed: the write reports that itself). For the forced save, whose
   * conflict dialog showed bytes that may no longer be what is on disk.
   */
  function overCapOnDisk(filePath) {
    let stat;
    try {
      stat = docTiers.statDocument(filePath, io);
    } catch {
      return null;
    }
    if (stat.tier !== "tooLarge") return null;
    return isOwnWrite(seen.get(filePath), stat) ? null : { tooLarge: true, size: stat.size };
  }

  return { remember, changedSince, overCapOnDisk };
}

module.exports = { createDiskMemory, LAST_SEEN_LIMIT };
