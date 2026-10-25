// Every launch gate reads this after it launches a packaged app.
//
// main.js catches uncaughtException and unhandledRejection, logs them to
// markie-crash.log in the profile directory and keeps the process alive. That
// keeps a user's unsaved work open, and it also means a main process that died
// halfway through loading looks like an app that is just slow: no exit code,
// no window, and a gate that can only say "no window within 40s". 0.9.0 failed
// its release gate that way on a missing module, and the gate's message sent
// us after a locked screen. Reading the log turns that into the actual error,
// and fails a launch that did reach a window but threw on the way.
const fs = require("node:fs");
const path = require("node:path");

const CRASH_LOG = "markie-crash.log";
const STARTUP_ERROR = /^\[[^\]]*\] (uncaughtException|unhandledRejection) /;

// The entries are one line of header plus the stack; keep each whole.
function launchErrors(profileDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(profileDir, CRASH_LOG), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (/^\[[^\]]*\] /.test(line)) entries.push(line);
    else if (entries.length && line) entries[entries.length - 1] += `\n${line}`;
  }
  return entries.filter((entry) => STARTUP_ERROR.test(entry));
}

function describeLaunchErrors(errors, max = 2) {
  return errors
    .slice(0, max)
    .map((entry) => entry.split("\n").slice(0, 6).map((line) => `    ${line}`).join("\n"))
    .join("\n");
}

module.exports = { CRASH_LOG, launchErrors, describeLaunchErrors };
