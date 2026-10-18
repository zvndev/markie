import { DARKMOWN_OUTPUT_LIMIT, validateDarkmownPreviewSource, type CompiledDarkmownDocument } from "./compiler-types";

interface DarkmownWorkerOptions { signal?: AbortSignal; timeoutMs?: number; createWorker?: () => Worker }

function validResult(value: unknown): value is CompiledDarkmownDocument {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.bodyHtml === "string" && result.bodyHtml.length <= DARKMOWN_OUTPUT_LIMIT
    && typeof result.title === "string" && result.title.length <= 128_000
    && typeof result.requiresRuntime === "boolean" && typeof result.hasCode === "boolean"
    && Array.isArray(result.warnings) && result.warnings.length <= 5_000
    && result.warnings.every((warning) => typeof warning === "string" && warning.length <= 128_000);
}

/** One disposable local compiler worker. Never falls back to the UI thread. */
export function compileDarkmownOffThread(source: string, options: DarkmownWorkerOptions = {}): Promise<CompiledDarkmownDocument> {
  try { validateDarkmownPreviewSource(source); } catch (error) { return Promise.reject(error); }
  // Includes cold module loading/translation, not only compilation. Keep a hard
  // budget without making the first preview unreliable on slower desktops.
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return Promise.reject(new Error("Invalid interactive preview time limit."));
  if (options.signal?.aborted) return Promise.reject(new DOMException("Interactive preview canceled.", "AbortError"));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = options.createWorker ? options.createWorker() : new Worker(new URL("./compiler.worker.ts", import.meta.url), { type: "module" });
    } catch { reject(new Error("A local preview worker is unavailable. Your source remains available to edit and save.")); return; }
    let settled = false;
    const finish = (result?: CompiledDarkmownDocument, error?: Error) => {
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
    const aborted = () => finish(undefined, new DOMException("Interactive preview canceled.", "AbortError"));
    const failed = (event: Event) => { event.preventDefault(); finish(undefined, new Error("The local preview compiler failed. Your source remains available to edit and save.")); };
    const received = (event: MessageEvent) => {
      const data = event.data;
      if (data?.ok === true && validResult(data.result)) finish(data.result);
      else if (data?.ok === false && typeof data.error === "string" && data.error.length <= 4096) finish(undefined, new Error(data.error));
      else finish(undefined, new Error("The local preview compiler returned an invalid result."));
    };
    const timer = setTimeout(() => finish(undefined, new Error("Interactive preview exceeded its time budget. The local compiler was stopped; your source remains available to edit and save.")), timeoutMs);
    worker.addEventListener("message", received);
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", failed);
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) { aborted(); return; }
    try { worker.postMessage(source); } catch { failed(new Event("error")); }
  });
}
