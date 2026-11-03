// Compiling a hosted Live Doc without letting the source hurt the server.
//
// Every compile runs in a fresh worker thread (live-docs-worker.ts) with a
// memory ceiling (resourceLimits), a wall-clock limit after which the worker
// is terminated, and an empty environment. The source is size-checked here
// first, with the same limits the Mac preview applies, so an oversized or
// over-complex source never starts a worker at all. At most a few compiles
// run at once and a few more may wait; past that the page answers "busy"
// rather than queueing without bound.
//
// Output is cached by the source's SHA-256 and the pinned compiler version,
// so an unchanged Live Doc compiles once, not on every load. Compile errors
// are cached the same way (they are a property of the source); a timeout, a
// crash or a full queue is not, so a slow moment never sticks to a document.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Worker, type ResourceLimits } from "node:worker_threads";
import { DARKMOWN_OUTPUT_LIMIT, validateDarkmownPreviewSource } from "./generated/darkmown/darkmown-limits.mjs";
import type { LiveDocWorkerResult } from "./live-docs-worker.ts";

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
// A 126,000-character Live Doc compiles in 32 MB of old generation in under
// 100 ms (2026-11-03), so 64 MB is double what the largest accepted source
// needs. With two compiles at once that is about 200 MB at worst, on top of a
// markie-api container that runs in 1 GB and peaks near 325 MB.
export const LIVE_DOC_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  codeRangeSizeMb: 16,
  stackSizeMb: 4,
};

// Below this old-generation size a worker's isolate cannot even start, and
// Node then aborts the whole process rather than failing the worker (seen on
// Node 26 with 1 MB). Every configured limit is raised to at least this, so
// no setting can turn a compile limit into a server crash.
export const LIVE_DOC_MIN_OLD_GENERATION_MB = 8;

function safeLimits(limits: ResourceLimits): ResourceLimits {
  return {
    ...limits,
    maxOldGenerationSizeMb: Math.max(LIVE_DOC_MIN_OLD_GENERATION_MB, limits.maxOldGenerationSizeMb ?? LIVE_DOC_MIN_OLD_GENERATION_MB),
  };
}

export type LiveDocCompile =
  | { ok: true; page: LiveDocWorkerResult }
  /** The source itself was refused: too large, too complex, or not valid Darkmown. Cached. */
  | { ok: false; kind: "refused"; message: string }
  /** The compile did not finish: timed out, ran out of memory or crashed. Not cached. */
  | { ok: false; kind: "failed"; message: string }
  /** Too many compiles in flight. Not cached; the next load tries again. */
  | { ok: false; kind: "busy"; message: string };

const WORKER_URL = new URL("./live-docs-worker.ts", import.meta.url);

function validPage(value: unknown): value is LiveDocWorkerResult {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return typeof page.bodyHtml === "string" && page.bodyHtml.length <= 2 * DARKMOWN_OUTPUT_LIMIT
    && typeof page.title === "string" && page.title.length <= 10_000
    && Array.isArray(page.seeds) && page.seeds.length <= 1_000 && page.seeds.every((seed) => typeof seed === "string" && seed.length <= 200_000)
    && Array.isArray(page.warnings) && page.warnings.length <= 5_000 && page.warnings.every((warning) => typeof warning === "string" && warning.length <= 128_000);
}

export interface LiveDocCompilerOptions {
  timeoutMs?: number;
  resourceLimits?: ResourceLimits;
  maxConcurrent?: number;
  maxQueued?: number;
  cacheEntries?: number;
  cacheBytes?: number;
}

export function createLiveDocCompiler(options: LiveDocCompilerOptions = {}) {
  const timeoutMs = options.timeoutMs ?? LIVE_DOC_COMPILE_TIMEOUT_MS;
  const resourceLimits = safeLimits(options.resourceLimits ?? LIVE_DOC_RESOURCE_LIMITS);
  const maxConcurrent = options.maxConcurrent ?? 2;
  const maxQueued = options.maxQueued ?? 16;
  const cacheEntries = options.cacheEntries ?? 200;
  const cacheBytes = options.cacheBytes ?? 64 * 1024 * 1024;

  // Insertion-ordered, so the first key is the least recently used.
  const cache = new Map<string, { result: LiveDocCompile; bytes: number }>();
  let cachedBytes = 0;
  const inFlight = new Map<string, Promise<LiveDocCompile>>();
  let running = 0;
  const waiting: Array<() => void> = [];
  let workersStarted = 0;

  const remember = (key: string, result: LiveDocCompile) => {
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

  const runWorker = (source: string): Promise<LiveDocCompile> =>
    new Promise((resolve) => {
      let worker: Worker;
      try {
        workersStarted += 1;
        worker = new Worker(WORKER_URL, { resourceLimits, env: {}, stdout: true, stderr: true });
      } catch {
        resolve({ ok: false, kind: "failed", message: "The Live Doc compiler could not start." });
        return;
      }
      // Its output is not ours to print: nothing the source does should land in the server log.
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const finish = (result: LiveDocCompile) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, kind: "failed", message: "This Live Doc took too long to compile, so it was stopped." }),
        timeoutMs
      );
      worker.once("message", (data: unknown) => {
        const message = data as { ok?: unknown; result?: unknown; error?: unknown } | null;
        if (message?.ok === true && validPage(message.result)) finish({ ok: true, page: message.result });
        else if (message?.ok === false && typeof message.error === "string") finish({ ok: false, kind: "refused", message: message.error.slice(0, 4096) });
        else finish({ ok: false, kind: "failed", message: "The Live Doc compiler returned an invalid result." });
      });
      worker.once("error", (error: Error & { code?: string }) => {
        finish({
          ok: false,
          kind: "failed",
          message: error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "This Live Doc needed too much memory to compile, so it was stopped."
            : "The Live Doc compiler failed.",
        });
      });
      worker.once("exit", () => finish({ ok: false, kind: "failed", message: "The Live Doc compiler stopped before it finished." }));
      worker.postMessage(source);
    });

  const withSlot = async (source: string): Promise<LiveDocCompile> => {
    if (running >= maxConcurrent) {
      if (waiting.length >= maxQueued) return { ok: false, kind: "busy", message: "Live Docs are busy. Try again in a moment." };
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await runWorker(source);
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };

  /** The compiled, sanitized page for this source, from cache when it has not changed. */
  async function compile(source: string): Promise<LiveDocCompile> {
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
    // The cheap closed-subset checks, before any worker exists.
    try {
      validateDarkmownPreviewSource(source);
    } catch (error) {
      const refused: LiveDocCompile = { ok: false, kind: "refused", message: error instanceof Error ? error.message : "This Live Doc cannot be hosted." };
      remember(key, refused);
      return refused;
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const run = withSlot(source).then((result) => {
      remember(key, result);
      return result;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  return {
    compile,
    /** Test seam: how many workers this compiler has started. */
    workersStarted: () => workersStarted,
    clearCache: () => {
      cache.clear();
      cachedBytes = 0;
    },
  };
}

export type LiveDocCompiler = ReturnType<typeof createLiveDocCompiler>;
