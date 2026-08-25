// One safety net for every ipcMain.handle channel.
//
// An unguarded handler that throws rejects the renderer's invoke(). Almost no
// call site in the renderer has a .catch(), so the visible result is a spinner
// that never stops or a menu that never closes — the failure is invisible and
// permanent. Every channel answers instead, and the answer is readable.

// Chromium and Node both prefix their messages; a person reading a toast does
// not need "Error:" in front of it.
function errorMessage(err) {
  if (err == null) return "Something went wrong.";
  const raw =
    typeof err === "string"
      ? err
      : typeof err.message === "string"
        ? err.message
        : String(err);
  return raw.replace(/^Error:\s*/, "").trim() || "Something went wrong.";
}

// handle(channel, fn) registers a handler that never rejects.
//
// By default a failure answers `{ error }`. Channels whose success value is a
// payload the renderer truth-tests (a file payload, a cached row) pass
// `onFailure` — usually `() => null` — so a failure reads as "nothing" rather
// than as a payload with undefined fields.
function createIpcHandler({ ipcMain, onError } = {}) {
  return function handle(channel, fn, options = {}) {
    const onFailure = options.onFailure;
    ipcMain.handle(channel, async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        try {
          if (onError) onError(channel, err);
        } catch {
          // the reporter is not allowed to break the report
        }
        if (onFailure) return onFailure(err);
        return { error: errorMessage(err) };
      }
    });
  };
}

module.exports = { createIpcHandler, errorMessage };
