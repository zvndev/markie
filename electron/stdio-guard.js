// Keep a dead stdout/stderr from turning into a crash loop.
//
// Launched from a terminal or from WSL, Markie's stdout and stderr are pipes
// back to whatever started it. When that side goes away (the terminal closes,
// WSL shuts down) every later write fails with EPIPE, and the failure is
// emitted as an 'error' event on the stream. With no listener that is an
// uncaught exception, so it lands in logCrash, which writes it to the console:
// the same dead stderr. Node's stdio streams undo their own destroy after an
// error, so that write fails and emits again, and the handler runs again,
// thousands of times a second, until the process is killed. The window stops
// responding and the crash log rotates every half second.
//
// A standing 'error' listener ends that at the first write: nothing on a dead
// pipe is worth reporting, and there is nowhere to report it to anyway.

const BROKEN_PIPE_CODES = new Set(["EPIPE", "EOF", "ERR_STREAM_DESTROYED"]);

function noop() {}

function guardStdio(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    if (stream && typeof stream.on === "function") stream.on("error", noop);
  }
}

// True for the error a write to a closed console produces. logCrash uses it to
// skip the console for exactly the failure the console caused.
function isBrokenPipeError(error) {
  return Boolean(error) && BROKEN_PIPE_CODES.has(error.code);
}

module.exports = { guardStdio, isBrokenPipeError };
