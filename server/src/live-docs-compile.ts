// Compiling a hosted Live Doc without letting the source hurt the server.
//
// Every compile runs in a fresh child process (live-docs-child.ts), never in
// this one. A worker thread's heap limit is not an isolation boundary: when a
// worker runs out of heap, V8 can abort the whole process, and it did, in CI,
// on Node 22. A child process that runs out of heap dies alone. So each
// compile gets its own process with:
//
// - a V8 heap ceiling (--max-old-space-size, a small young generation);
// - an empty environment, so none of the server's secrets are in it;
// - Node's permission model: it may read only its own script, the pinned
//   compiler and the sanitizer's node_modules, and may not write files, start
//   processes or workers, or load addons (on Node 26 it may not open network
//   connections either; Node 22 has no network permission, so the child
//   removes the network globals);
// - no code generation from strings;
// - a wall-clock limit, after which it is killed with SIGKILL;
// - capped stdout and stderr, and a strict one-line JSON reply that is
//   validated field by field before anything uses it.
//
// The source is size-checked here first, with the same limits the Mac preview
// applies, so an oversized or over-complex source never starts a process. At
// most a few compiles run at once and a few more may wait; past that the page
// answers "busy" rather than queueing without bound.
//
// Output is cached by the source's SHA-256 and the pinned compiler version,
// so an unchanged Live Doc compiles once, not on every load, and the cost of
// starting a process is paid once per change. Compile errors are cached the
// same way (they are a property of the source); a timeout, a crash or a full
// queue is not, so a slow moment never sticks to a document.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DARKMOWN_OUTPUT_LIMIT, validateDarkmownPreviewSource } from "./generated/darkmown/darkmown-limits.mjs";
import type { LiveDocPage } from "./live-docs-child.ts";

const PROVENANCE = JSON.parse(readFileSync(new URL("./generated/darkmown/PROVENANCE.json", import.meta.url), "utf8")) as {
  commit: string;
  version: string;
};
/** Part of every cache key, so a new pinned compiler never serves an old compile. */
export const LIVE_DOC_COMPILER_VERSION = `${PROVENANCE.version}+${PROVENANCE.commit.slice(0, 12)}`;

// The Mac preview's outer cap (preview.ts). The shared validator then holds
// the source to 128,000 characters, 5,000 lines and its complexity budget.
export const LIVE_DOC_SOURCE_LIMIT = 200_000;
export const LIVE_DOC_COMPILE_TIMEOUT_MS = 8_000;

export interface LiveDocHeap {
  /** V8 old generation, in MB (--max-old-space-size). */
  maxOldSpaceMb: number;
  /** One V8 semi-space, in MB (--max-semi-space-size). The young generation is a few of these. */
  maxSemiSpaceMb: number;
}
// The largest source the shared limits accept, 127,000 characters of prose,
// needs about 20 MB of old generation in a child, so 64 MB is about three
// times that. A compile process peaks near 95 MB resident in the server image
// (Node, its TypeScript stripper and the compiler; measured 2026-11-03), and
// a heap at its ceiling adds about 50 MB more, so two compiles at once stay
// under 300 MB at worst, none of it in the server's own heap.
export const LIVE_DOC_HEAP: LiveDocHeap = { maxOldSpaceMb: 64, maxSemiSpaceMb: 4 };

/** The most a child may write to stdout: its one reply, with room for JSON escaping. */
export const LIVE_DOC_REPLY_BYTES = 16 * DARKMOWN_OUTPUT_LIMIT;
/** The most of a child's stderr that is kept. It is only read to recognise an out-of-memory abort. */
export const LIVE_DOC_STDERR_BYTES = 64 * 1024;

const CHILD_SCRIPT = fileURLToPath(new URL("./live-docs-child.ts", import.meta.url));
const COMPILER_DIR = fileURLToPath(new URL("./generated/darkmown/", import.meta.url));
// The sanitizer's dependencies (unified, rehype-*) resolve from the server's
// node_modules. Found by resolving one of them, not assumed from a layout.
const NODE_MODULES_DIR = (() => {
  const unified = fileURLToPath(import.meta.resolve("unified"));
  const marker = `${sep}node_modules${sep}`;
  return unified.slice(0, unified.lastIndexOf(marker) + marker.length);
})();

/** Current Node spells it --permission; early Node 22 releases know only the experimental name. */
export const LIVE_DOC_PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has("--permission")
  ? "--permission"
  : "--experimental-permission";

// Real paths, because the permission model checks the resolved path of every
// read. A folder ends in a separator, so the grant names that folder and not a
// sibling that shares its prefix.
const realDir = (dir: string) => `${realpathSync(dir)}${sep}`;

function childArgs(script: string, heap: LiveDocHeap): string[] {
  const entry = realpathSync(script);
  const readable = [entry, realDir(COMPILER_DIR), realDir(NODE_MODULES_DIR)];
  return [
    "--experimental-strip-types",
    "--no-warnings",
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${heap.maxOldSpaceMb}`,
    `--max-semi-space-size=${heap.maxSemiSpaceMb}`,
    LIVE_DOC_PERMISSION_FLAG,
    ...readable.map((path) => `--allow-fs-read=${path}`),
    entry,
  ];
}

export interface LiveDocChildOptions {
  /** The script to run. Tests point this at probes; the server always runs live-docs-child.ts. */
  script?: string;
  timeoutMs: number;
  heap: LiveDocHeap;
  stdoutBytes?: number;
  stderrBytes?: number;
  /** Test seam: told each child's process id as it starts. */
  onSpawn?: (pid: number) => void;
}

export interface LiveDocChildRun {
  pid: number | undefined;
  /** How the run ended. "exited" covers every exit, clean or not, that this side did not cause. */
  end: "exited" | "timeout" | "overflow" | "spawn-failed";
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs one child under the sandbox with `input` on its stdin and resolves only
 * once the process has exited and its pipes have closed, so a resolved run
 * never leaves a process behind.
 */
export function runLiveDocChild(input: string, options: LiveDocChildOptions): Promise<LiveDocChildRun> {
  const stdoutBytes = options.stdoutBytes ?? LIVE_DOC_REPLY_BYTES;
  const stderrBytes = options.stderrBytes ?? LIVE_DOC_STDERR_BYTES;
  return new Promise((resolve) => {
    const script = options.script ?? CHILD_SCRIPT;
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, childArgs(script, options.heap), {
        cwd: dirname(script),
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ pid: undefined, end: "spawn-failed", code: null, signal: null, stdout: "", stderr: "" });
      return;
    }
    let end: LiveDocChildRun["end"] = "exited";
    let settled = false;
    const stop = (why: "timeout" | "overflow") => {
      if (end === "exited") end = why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);

    const collect = (stream: NodeJS.ReadableStream | null, limit: number, onOverflow: () => void) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream?.on("error", () => {});
      stream?.on("data", (chunk: Buffer) => {
        if (size > limit) return;
        size += chunk.length;
        if (size > limit) {
          chunks.push(chunk.subarray(0, Math.max(0, limit - (size - chunk.length))));
          onOverflow();
          return;
        }
        chunks.push(chunk);
      });
      return () => Buffer.concat(chunks).toString("utf8");
    };
    // Past its cap, stdout can no longer hold a valid reply, so the child is stopped.
    const stdout = collect(child.stdout, stdoutBytes, () => stop("overflow"));
    // Stderr is only read to recognise an out-of-memory abort, which V8 writes
    // in its first few hundred bytes, so the rest is dropped, not acted on.
    const stderr = collect(child.stderr, stderrBytes, () => {});

    const finish = (run: Omit<LiveDocChildRun, "pid" | "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pid: child.pid, ...run, stdout: stdout(), stderr: stderr() });
    };
    // Every "error" needs a listener, or it would be thrown in this process.
    // Only a process that never started ends here; any other error (a failed
    // kill) still ends in "close" once the process is gone.
    child.on("error", () => {
      if (child.pid === undefined) finish({ end: "spawn-failed", code: null, signal: null });
    });
    child.once("close", (code, signal) => finish({ end, code, signal }));
    if (child.pid !== undefined) options.onSpawn?.(child.pid);

    // A child that dies before reading its input closes the pipe under us.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ source: input }));
  });
}

export type LiveDocCompile =
  | { ok: true; page: LiveDocPage }
  /** The source itself was refused: too large, too complex, or not valid Darkmown. Cached. */
  | { ok: false; kind: "refused"; message: string }
  /**
   * The compile did not finish: timed out, ran out of memory or crashed.
   * Remembered for LIVE_DOC_FAILED_TTL_MS, since the same source under the
   * same limits fails the same way, and a reload must not start a new process.
   */
  | { ok: false; kind: "failed"; message: string; transient?: true }
  /** Too many compiles in flight, overall or for this owner. Not cached; the next load tries again. */
  | { ok: false; kind: "busy"; message: string };

const PAGE_KEYS = "bodyHtml,network,seeds,title,warnings";
// What a page's network list may hold: https origins only, written exactly as
// darkmownFetchOrigin writes them. The child is trusted for none of it.
const NETWORK_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
export const LIVE_DOC_NETWORK_LIMIT = 20;

function validPage(value: unknown): value is LiveDocPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== PAGE_KEYS) return false;
  const page = value as Record<string, unknown>;
  return typeof page.bodyHtml === "string" && page.bodyHtml.length <= 2 * DARKMOWN_OUTPUT_LIMIT
    && typeof page.title === "string" && page.title.length <= 10_000
    && Array.isArray(page.seeds) && page.seeds.length <= 1_000 && page.seeds.every((seed) => typeof seed === "string" && seed.length <= 200_000)
    && Array.isArray(page.warnings) && page.warnings.length <= 5_000 && page.warnings.every((warning) => typeof warning === "string" && warning.length <= 128_000)
    && Array.isArray(page.network) && page.network.length <= 1_000 && page.network.every((origin) => typeof origin === "string" && NETWORK_ORIGIN.test(origin));
}

/** The child's reply, if it is exactly one line of the protocol in live-docs-child.ts; null otherwise. */
function parseReply(stdout: string): LiveDocCompile | null {
  if (stdout.indexOf("\n") !== stdout.length - 1) return null;
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return null;
  const keys = Object.keys(reply).sort().join(",");
  const { ok, result, error } = reply as { ok?: unknown; result?: unknown; error?: unknown };
  if (ok === true && keys === "ok,result" && validPage(result)) return { ok: true, page: result };
  if (ok === false && keys === "error,ok" && typeof error === "string" && error.length <= 4096) {
    return { ok: false, kind: "refused", message: error };
  }
  return null;
}

// What V8 prints when a heap limit ends the process: "Reached heap limit",
// "LocalHeap: allocation failed", "Ineffective mark-compacts near heap limit",
// each followed by "Allocation failed - JavaScript heap out of memory".
const OUT_OF_MEMORY = /heap out of memory|Allocation failed/i;

const failed = (message: string): LiveDocCompile => ({ ok: false, kind: "failed", message });

/** What a finished child run means for the page. Exported for the protocol tests. */
export function interpretLiveDocChildRun(run: LiveDocChildRun): LiveDocCompile {
  // The host could not start a process: nothing to do with this source, so
  // it is never remembered against it.
  if (run.end === "spawn-failed") return { ok: false, kind: "failed", message: "The Live Doc compiler could not start.", transient: true };
  if (run.end === "timeout") return failed("This Live Doc took too long to compile, so it was stopped.");
  if (run.code !== 0 && OUT_OF_MEMORY.test(run.stderr)) return failed("This Live Doc needed too much memory to compile, so it was stopped.");
  if (run.end === "overflow") return failed("The Live Doc compiler returned an invalid result.");
  if (run.signal) return failed("The Live Doc compiler stopped before it finished.");
  if (run.code !== 0) return failed("The Live Doc compiler failed.");
  return parseReply(run.stdout) ?? failed("The Live Doc compiler returned an invalid result.");
}

/**
 * How long a source that failed to compile is answered from memory. Long
 * enough that reloading a broken Live Doc starts no new process, short enough
 * that a compile that timed out under a load spike gets a fresh try soon.
 */
export const LIVE_DOC_FAILED_TTL_MS = 60 * 1000;

export interface LiveDocCompilerOptions {
  timeoutMs?: number;
  heap?: LiveDocHeap;
  maxConcurrent?: number;
  maxQueued?: number;
  /** Compiles one owner may have running at once. Their others wait. */
  maxRunningPerOwner?: number;
  /** Compiles one owner may have running or waiting. Past it, "busy" for them alone. */
  maxInFlightPerOwner?: number;
  /** New (uncached) compiles one owner may start a minute. */
  maxStartsPerOwnerPerMinute?: number;
  failedTtlMs?: number;
  failedEntries?: number;
  cacheEntries?: number;
  cacheBytes?: number;
  /** Test seam: told each compile process's id as it starts. */
  onSpawn?: (pid: number) => void;
}

export function createLiveDocCompiler(options: LiveDocCompilerOptions = {}) {
  const timeoutMs = options.timeoutMs ?? LIVE_DOC_COMPILE_TIMEOUT_MS;
  const heap = options.heap ?? LIVE_DOC_HEAP;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const maxQueued = options.maxQueued ?? 16;
  const cacheEntries = options.cacheEntries ?? 200;
  const cacheBytes = options.cacheBytes ?? 64 * 1024 * 1024;
  const maxRunningPerOwner = options.maxRunningPerOwner ?? 1;
  // Three per owner, against 16 waiting places: it takes six accounts at once
  // to fill the queue, and each is also held to its starts a minute.
  const maxInFlightPerOwner = options.maxInFlightPerOwner ?? 3;
  const maxStartsPerOwnerPerMinute = options.maxStartsPerOwnerPerMinute ?? 30;
  const failedTtlMs = options.failedTtlMs ?? LIVE_DOC_FAILED_TTL_MS;
  const failedEntries = options.failedEntries ?? 1_000;

  // Insertion-ordered, so the first key is the least recently used.
  const cache = new Map<string, { result: LiveDocCompile; bytes: number }>();
  let cachedBytes = 0;
  const inFlight = new Map<string, Promise<LiveDocCompile>>();
  let running = 0;
  // Who may take the next free slot: the first waiter whose owner is under
  // their running limit, so one owner's queue never stands in front of others.
  const waiting: Array<{ owner: string | undefined; start: () => void }> = [];
  const runningBy = new Map<string, number>();
  const inFlightBy = new Map<string, number>();
  // Sources whose compile failed, with when they may be tried again.
  const failures = new Map<string, { result: LiveDocCompile; until: number }>();
  // When each owner's recent uncached compiles started, oldest first.
  const startsBy = new Map<string, number[]>();
  const overStartRate = (owner: string, now = Date.now()) => {
    const recent = (startsBy.get(owner) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= maxStartsPerOwnerPerMinute) {
      startsBy.set(owner, recent);
      return true;
    }
    recent.push(now);
    startsBy.set(owner, recent);
    // Owners with nothing recent drop out, so the map stays the size of the active set.
    if (startsBy.size > 10_000) for (const [key, times] of startsBy) if (!times.some((at) => at > now - 60_000)) startsBy.delete(key);
    return false;
  };
  let childrenStarted = 0;

  const bump = (counts: Map<string, number>, owner: string, by: number) => {
    const next = (counts.get(owner) ?? 0) + by;
    if (next > 0) counts.set(owner, next);
    else counts.delete(owner);
  };

  const rememberFailure = (key: string, result: LiveDocCompile) => {
    failures.delete(key);
    failures.set(key, { result, until: Date.now() + failedTtlMs });
    for (const oldest of failures.keys()) {
      if (failures.size <= failedEntries) break;
      failures.delete(oldest);
    }
  };

  const remember = (key: string, result: LiveDocCompile) => {
    if (!result.ok && result.kind === "failed") {
      if (!result.transient) rememberFailure(key, result);
      return;
    }
    if (!result.ok && result.kind !== "refused") return;
    const bytes = result.ok
      ? result.page.bodyHtml.length + result.page.seeds.reduce((sum, seed) => sum + seed.length, 0) + result.page.title.length
      : result.message.length;
    if (bytes > cacheBytes) return;
    cache.set(key, { result, bytes });
    cachedBytes += bytes;
    for (const [oldest, entry] of cache) {
      if (cache.size <= cacheEntries && cachedBytes <= cacheBytes) break;
      cache.delete(oldest);
      cachedBytes -= entry.bytes;
    }
  };

  const runChild = async (source: string): Promise<LiveDocCompile> => {
    childrenStarted += 1;
    return interpretLiveDocChildRun(await runLiveDocChild(source, { timeoutMs, heap, onSpawn: options.onSpawn }));
  };

  // `owner` undefined means no per-owner limit (tests, and any caller that
  // does not know whose document it is); only the global limits apply.
  const underOwnerLimit = (owner: string | undefined) => owner === undefined || (runningBy.get(owner) ?? 0) < maxRunningPerOwner;
  const mayStart = (owner: string | undefined) => running < maxConcurrent && underOwnerLimit(owner);

  const startNext = () => {
    while (running < maxConcurrent) {
      const index = waiting.findIndex((waiter) => underOwnerLimit(waiter.owner));
      if (index === -1) return;
      const [waiter] = waiting.splice(index, 1);
      running += 1;
      if (waiter!.owner !== undefined) bump(runningBy, waiter!.owner, 1);
      waiter!.start();
    }
  };

  const BUSY: LiveDocCompile = { ok: false, kind: "busy", message: "Live Docs are busy. Try again in a moment." };

  const withSlot = async (source: string, owner: string | undefined): Promise<LiveDocCompile> => {
    if (owner !== undefined && (inFlightBy.get(owner) ?? 0) >= maxInFlightPerOwner) return BUSY;
    if (!mayStart(owner) && waiting.length >= maxQueued) return BUSY;
    if (owner !== undefined && overStartRate(owner)) return BUSY;
    // Counted from the moment it is accepted, waiting included, so an owner's
    // queue is bounded too.
    if (owner !== undefined) bump(inFlightBy, owner, 1);
    try {
      if (mayStart(owner)) {
        running += 1;
        if (owner !== undefined) bump(runningBy, owner, 1);
      } else {
        await new Promise<void>((start) => waiting.push({ owner, start }));
      }
      try {
        return await runChild(source);
      } finally {
        running -= 1;
        if (owner !== undefined) bump(runningBy, owner, -1);
        startNext();
      }
    } finally {
      if (owner !== undefined) bump(inFlightBy, owner, -1);
    }
  };

  /**
   * The compiled, sanitized page for this source, from cache when it has not
   * changed. `owner` is whose document it is, so one account cannot hold
   * every compile slot.
   */
  async function compile(source: string, owner?: string): Promise<LiveDocCompile> {
    if (typeof source !== "string" || source.length > LIVE_DOC_SOURCE_LIMIT) {
      return { ok: false, kind: "refused", message: "Live Docs can be up to 200,000 characters." };
    }
    const key = `${LIVE_DOC_COMPILER_VERSION}:${createHash("sha256").update(source, "utf8").digest("hex")}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.result;
    }
    const failure = failures.get(key);
    if (failure) {
      if (failure.until > Date.now()) return failure.result;
      failures.delete(key);
    }
    // The cheap closed-subset checks, before any process exists.
    try {
      validateDarkmownPreviewSource(source);
    } catch (error) {
      const refused: LiveDocCompile = { ok: false, kind: "refused", message: error instanceof Error ? error.message : "This Live Doc cannot be hosted." };
      remember(key, refused);
      return refused;
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const run = withSlot(source, owner).then((result) => {
      // The page never shows compiler warnings, so neither the cache nor the
      // caller keeps them: thousands of them would otherwise sit in memory
      // outside the cache's byte budget.
      const kept: LiveDocCompile = result.ok ? { ok: true, page: { ...result.page, warnings: [] } } : result;
      remember(key, kept);
      return kept;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  return {
    compile,
    /** Test seam: how many compile processes this compiler has started. */
    childrenStarted: () => childrenStarted,
    clearCache: () => {
      cache.clear();
      cachedBytes = 0;
      failures.clear();
      startsBy.clear();
    },
  };
}

export type LiveDocCompiler = ReturnType<typeof createLiveDocCompiler>;
