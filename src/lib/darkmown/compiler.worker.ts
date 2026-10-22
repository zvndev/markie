import { compileDarkmown } from "./compiler";

const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<string>) => void) | null; postMessage(value: unknown): void };
worker.onmessage = (event) => {
  try { worker.postMessage({ ok: true, result: compileDarkmown(event.data) }); }
  catch (error) {
    worker.postMessage({ ok: false, error: (error instanceof Error ? error.message : "The local preview compiler failed.").slice(0, 4096) });
  }
};
