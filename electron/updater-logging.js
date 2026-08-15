// A logger for electron-updater that cannot take the app down.
//
// electron-updater logs through `console` by default, and console writes are
// not safe: writing to a closed pipe throws EPIPE. That turns a debug line into
// an uncaught exception in the main process, and Electron answers an uncaught
// exception with a modal dialog containing a raw stack trace.
//
// During quitAndInstall that dialog is worse than ugly, it is blocking. The app
// never quits, so Squirrel sits waiting for a process that will never exit, the
// update never installs, and the button says "Restarting…" forever. A log line
// should not be able to do that.

const LEVELS = ["error", "warn", "info", "debug"];

// Wrap a console-shaped object so every method swallows its own failures.
// electron-updater checks whether `debug` exists before calling it, so a level
// the sink does not implement is left undefined rather than stubbed, which
// keeps its behaviour unchanged.
function guardedLogger(sink = console) {
  const logger = {};
  for (const level of LEVELS) {
    if (typeof sink?.[level] !== "function") continue;
    logger[level] = (...args) => {
      try {
        sink[level](...args);
      } catch {
        // Nothing to report it to. The sink is what just failed.
      }
    };
  }
  return logger;
}

module.exports = { LEVELS, guardedLogger };
