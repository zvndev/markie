import type { LegacyDocResult } from "./legacy-doc";

const MAX_INPUT = 32 * 1024 * 1024;
const MAX_TEXT = 8 * 1024 * 1024;
interface LegacyDocWorkerOptions { signal?: AbortSignal; timeoutMs?: number; createWorker?: () => Worker }

function validResult(value: unknown): value is LegacyDocResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (result.ok === false) {
    const error = result.error as Record<string, unknown> | undefined;
    return !!error && ["malformed", "unsupported", "encrypted", "limit-exceeded"].includes(String(error.code)) && typeof error.message === "string" && error.message.length <= 4096;
  }
  return result.ok === true && result.kind === "text-extraction" && result.canWrite === false
    && typeof result.text === "string" && result.text.length <= MAX_TEXT
    && typeof result.rawText === "string" && result.rawText.length <= MAX_TEXT
    && Array.isArray(result.warnings) && result.warnings.length <= 100
    && result.warnings.every((warning) => typeof warning === "string" && warning.length <= 4096);
}

/** One disposable local worker per import. Transfers only an owned copy. */
export function extractLegacyDocTextOffThread(bytes: Uint8Array, options: LegacyDocWorkerOptions = {}): Promise<LegacyDocResult> {
  if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== "[object Uint8Array]" || bytes.byteLength > MAX_INPUT) return Promise.reject(new Error("Legacy DOC exceeds the 32 MiB import limit."));
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return Promise.reject(new Error("Invalid DOC import time limit."));
  if (options.signal?.aborted) return Promise.reject(new DOMException("DOC import canceled.", "AbortError"));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = options.createWorker ? options.createWorker() : new Worker(new URL("./legacy-doc.worker.ts", import.meta.url), { type: "module" });
    } catch { reject(new Error("A local document worker is unavailable. This DOC was not opened or uploaded.")); return; }
    let settled = false;
    const finish = (result?: LegacyDocResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      worker.removeEventListener("message", received);
      worker.removeEventListener("error", failed);
      worker.removeEventListener("messageerror", failed);
      worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const aborted = () => finish(undefined, new DOMException("DOC import canceled.", "AbortError"));
    const failed = (event: Event) => { event.preventDefault(); finish(undefined, new Error("The local DOC reader failed. Your open document and original file are unchanged.")); };
    const received = (event: MessageEvent) => {
      if (!validResult(event.data)) finish(undefined, new Error("The local DOC reader returned an invalid result."));
      else finish(event.data);
    };
    const timer = setTimeout(() => finish(undefined, new Error("DOC import exceeded its time budget. The local reader was stopped; the original is unchanged.")), timeoutMs);
    worker.addEventListener("message", received);
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", failed);
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) { aborted(); return; }
    try {
      const owned = new Uint8Array(bytes);
      worker.postMessage(owned, [owned.buffer]);
    } catch { failed(new Event("error")); }
  });
}
