// Stopping on SIGTERM or SIGINT: stop taking requests, let the ones in flight
// finish, release what the process holds, and exit, all within a few seconds.
//
// Without a handler, Node as PID 1 in a container ignores SIGTERM entirely, so
// `docker stop` waited out its whole timeout and then killed the process with
// the database open. Fly sends SIGINT and kills after 5 s, so the deadline here
// stays well inside that.
//
// Dependency-free on purpose: the private-release gateway image copies this
// file on its own (Dockerfile.private-release) and must not pull in the app.

/** What the stop needs from an HTTP server. node:http's Server has all of it. */
export interface StoppableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface GracefulStopOptions {
  /** For the log lines. */
  name: string;
  server: StoppableServer;
  /** Runs first, before the server closes: stop timers, hang up long-lived sockets. */
  stopAccepting?: () => void;
  /** Runs if requests are still open at the deadline, just before they are cut. */
  force?: () => void;
  /** Runs once HTTP is closed, or at the deadline: close databases. */
  release?: () => void;
  /**
   * Runs after release, before the exit: send what is still in memory (error
   * and request reports). Waited on for at most flushTimeoutMs, and its
   * failure never changes the exit.
   */
  flush?: () => Promise<unknown>;
  /** How long the flush gets. */
  flushTimeoutMs?: number;
  /** How long requests in flight get. */
  deadlineMs?: number;
  log?: (line: string) => void;
  exit?: (code: number) => void;
}

export const STOP_DEADLINE_MS = 3000;
export const FLUSH_DEADLINE_MS = 2000;

/**
 * Returns the stop itself, which the signals call. A second signal while
 * stopping changes nothing; the deadline already bounds the stop.
 *
 * The exit code is always 0. On Fly the server runs under `litestream
 * replicate -exec`, which does its final sync to the replica only when its
 * child exits cleanly or by a signal; a non-zero exit makes it return before
 * that sync.
 */
export function gracefulStop(options: GracefulStopOptions): (signal: string) => Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = options.deadlineMs ?? STOP_DEADLINE_MS;
  const run = (what: string, step: (() => void) | undefined) => {
    if (!step) return;
    try {
      step();
    } catch (err) {
      log(`${options.name}: ${what} failed while stopping: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  let stopping: Promise<void> | undefined;
  return (signal: string) => {
    if (stopping) return stopping;
    stopping = new Promise<void>((resolve) => {
      const started = Date.now();
      log(`${options.name}: ${signal} received, stopping`);
      run("stopAccepting", options.stopAccepting);
      let done = false;
      const finish = (cut: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (cut) {
          run("force", options.force);
          run("closeAllConnections", () => options.server.closeAllConnections?.());
        }
        run("release", options.release);
        const end = () => {
          log(`${options.name}: stopped in ${Date.now() - started} ms${cut ? ", open requests were cut at the deadline" : ""}`);
          exit(0);
          resolve();
        };
        if (!options.flush) return end();
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const flushed = new Promise<void>((settle) => {
          flushTimer = setTimeout(settle, options.flushTimeoutMs ?? FLUSH_DEADLINE_MS);
          try {
            Promise.resolve(options.flush!()).then(() => settle(), (err: unknown) => {
              log(`${options.name}: flush failed while stopping: ${err instanceof Error ? err.message : String(err)}`);
              settle();
            });
          } catch (err) {
            log(`${options.name}: flush failed while stopping: ${err instanceof Error ? err.message : String(err)}`);
            settle();
          }
        });
        void flushed.then(() => {
          clearTimeout(flushTimer);
          end();
        });
      };
      const timer = setTimeout(() => finish(true), deadlineMs);
      options.server.close(() => finish(false));
      // Keep-alive sockets with no request on them would hold close() open
      // until they time out on their own.
      run("closeIdleConnections", () => options.server.closeIdleConnections?.());
    });
    return stopping;
  };
}

/** gracefulStop, wired to SIGTERM and SIGINT. */
export function installGracefulStop(options: GracefulStopOptions): (signal: string) => Promise<void> {
  const stop = gracefulStop(options);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void stop(signal));
  }
  return stop;
}
