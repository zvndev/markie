// Where crashes go.
//
// One JSON object per line in <userData>/crash.log, appended. Newline-delimited
// JSON because a crash log is written under exactly the conditions that corrupt
// files — a process being killed mid-write — and a format where one bad line
// costs one report beats a single JSON array where it costs all of them.
//
// The log never leaves the machine. Markie is local-first, and a crash report
// carries file paths; shipping that anywhere is a product decision and a
// dependency, not a detail this module gets to make. Everything here is written
// so a remote sink could be added later without changing what is captured.
//
// Nothing in here throws. It runs on the failure path, where an exception turns
// a recoverable error into a silent one.

const path = require("node:path");

const CRASH_LOG_FILE = "crash.log";
// Enough for a long tail of real crashes, small enough that a crash loop
// writing a report per frame cannot fill someone's disk.
const CRASH_LOG_MAX_BYTES = 512 * 1024;

function logPath(dir) {
  return path.join(dir, CRASH_LOG_FILE);
}

/**
 * Keep the newest crashes that fit in half the cap, so an append always lands
 * under the ceiling and the log is not rewritten on every single crash.
 *
 * Bounded by bytes rather than by a line count: one crash can carry a very
 * large stack, and a single enormous line has no newlines to slice on, so a
 * line-count rotation silently keeps the whole file.
 */
function rotate(text) {
  const budget = Math.floor(CRASH_LOG_MAX_BYTES / 2);
  const lines = text.split("\n").filter((line) => line.trim());
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i]) + 1;
    // A lone line bigger than the whole budget is dropped rather than kept:
    // it is one crash, and keeping it would blow the ceiling by itself.
    if (used + size > budget) break;
    used += size;
    kept.unshift(lines[i]);
  }
  return kept.length ? `${kept.join("\n")}\n` : "";
}

/**
 * Append one crash record. Returns whether it was written, so a caller can
 * decide whether to tell the user their report was kept.
 */
function appendCrash(dir, record, { fs = require("node:fs") } = {}) {
  const file = logPath(dir);
  try {
    // Rotate before appending rather than after, so the cap is a real ceiling
    // and not a threshold we sit just above forever.
    try {
      if (fs.statSync(file).size > CRASH_LOG_MAX_BYTES) {
        fs.writeFileSync(file, rotate(String(fs.readFileSync(file, "utf-8"))), "utf-8");
      }
    } catch {
      // No file yet, or it cannot be read. Appending below still works.
    }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Every crash we still hold, oldest first. */
function readCrashes(dir, { fs = require("node:fs") } = {}) {
  let text;
  try {
    text = String(fs.readFileSync(logPath(dir), "utf-8"));
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written line from a hard kill. Losing it is fine; losing the
      // rest of the log because of it is not.
    }
  }
  return out;
}

module.exports = { CRASH_LOG_FILE, CRASH_LOG_MAX_BYTES, appendCrash, logPath, readCrashes };
