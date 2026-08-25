// A crash log the user can actually hand over.
//
// Electron's answer to a dead renderer or an uncaught main-process exception is
// a console line nobody sees in a packaged build. This writes the same thing to
// a file under userData so "Reveal Crash Log" in the Help menu has something to
// point at, and so the next session can explain what happened to the last one.
//
// Deliberately dependency-free and injectable: nothing here touches Electron,
// so it can be unit tested without the binary (see lazy-electron.test.ts).

const nodeFs = require("fs");
const nodePath = require("path");

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB, then one generation of history
const FILE_NAME = "markie-crash.log";

// A log line has to survive being handed an Error, a string, an object the
// renderer sent, or nothing at all — this is called from failure paths, so it
// is the last place that should throw.
function describe(detail) {
  if (detail == null) return "";
  if (detail instanceof Error) {
    return detail.stack || `${detail.name}: ${detail.message}`;
  }
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function createCrashLog(options = {}) {
  const {
    dir,
    maxBytes = DEFAULT_MAX_BYTES,
    fs = nodeFs,
    path = nodePath,
    now = () => new Date(),
  } = options;

  const file = path.join(dir, FILE_NAME);
  const previous = `${file}.1`;

  // Keep one generation. Rotating instead of truncating means the entries that
  // explain a crash loop are still there after the loop writes over the cap.
  function rotateIfNeeded(incomingBytes) {
    try {
      const size = fs.statSync(file).size;
      if (size + incomingBytes <= maxBytes) return;
    } catch {
      return; // no file yet: nothing to rotate
    }
    try {
      fs.rmSync(previous, { force: true });
    } catch {
      // an unremovable previous generation is not worth losing the new entry
    }
    try {
      fs.renameSync(file, previous);
    } catch {
      try {
        fs.writeFileSync(file, "", "utf-8");
      } catch {
        // give up quietly; the append below will fail or succeed on its own
      }
    }
  }

  function log(kind, detail) {
    let entry;
    try {
      entry = `[${now().toISOString()}] ${String(kind)} ${describe(detail)}\n`;
    } catch {
      entry = `[unknown time] ${String(kind)}\n`;
    }
    try {
      rotateIfNeeded(Buffer.byteLength(entry, "utf8"));
      fs.appendFileSync(file, entry, "utf-8");
      return true;
    } catch {
      // The log is a convenience. Failing to write it must never be the reason
      // an error path turns into a second error.
      return false;
    }
  }

  // Make sure there is a file to reveal, so "Reveal Crash Log" on a healthy
  // install opens Finder on an empty log rather than on nothing.
  function ensure() {
    try {
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, "", "utf-8");
      }
    } catch {
      // reveal will simply fail to find it; nothing else depends on this
    }
    return file;
  }

  function read() {
    try {
      return fs.readFileSync(file, "utf-8");
    } catch {
      return "";
    }
  }

  return { log, ensure, read, path: file, previousPath: previous };
}

module.exports = { createCrashLog, FILE_NAME };
