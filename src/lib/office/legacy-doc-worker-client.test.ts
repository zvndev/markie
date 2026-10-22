import { afterEach, describe, expect, it, vi } from "vitest";
import { extractLegacyDocTextOffThread } from "./legacy-doc-worker-client";
class FakeWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();
  result(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
function fixture() {
  const worker = new FakeWorker();
  return { worker, createWorker: () => worker as unknown as Worker };
}
const success = { ok: true, kind: "text-extraction", canWrite: false, text: "Synthetic text", rawText: "Synthetic text", warnings: [] };
afterEach(() => vi.useRealTimers());
describe("bounded off-thread original DOC reader", () => {
  it("transfers an owned copy and terminates after receiving a valid result", async () => {
    const f = fixture(), source = new Uint8Array([1, 2, 3]);
    const pending = extractLegacyDocTextOffThread(source, f);
    const [copy, transfers] = f.worker.postMessage.mock.calls[0];
    expect(copy).not.toBe(source); expect(copy).toEqual(source); expect(transfers).toEqual([copy.buffer]);
    f.worker.result(success);
    expect(await pending).toEqual(success); expect(f.worker.terminate).toHaveBeenCalledOnce();
    expect(source).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("preserves typed unsupported/encrypted outcomes", async () => {
    const f = fixture(), pending = extractLegacyDocTextOffThread(new Uint8Array(), f);
    const result = { ok: false, error: { code: "encrypted", message: "Encrypted DOC is not supported." } };
    f.worker.result(result); expect(await pending).toEqual(result);
  });
  it("terminates a hung import on its time budget and ignores late results", async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = extractLegacyDocTextOffThread(new Uint8Array(), { ...f, timeoutMs: 20 });
    const rejected = expect(pending).rejects.toThrow("time budget");
    await vi.advanceTimersByTimeAsync(20); await rejected;
    f.worker.result(success); expect(f.worker.terminate).toHaveBeenCalledOnce();
  });
  it("cancels and disposes without detaching the source", async () => {
    const f = fixture(), controller = new AbortController(), source = new Uint8Array([7]);
    const pending = extractLegacyDocTextOffThread(source, { ...f, signal: controller.signal });
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.worker.terminate).toHaveBeenCalledOnce(); expect(source[0]).toBe(7);
  });
  it("never creates a worker for canceled, excessive or invalid input", async () => {
    const createWorker = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(extractLegacyDocTextOffThread(new Uint8Array(), { createWorker, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(extractLegacyDocTextOffThread(new Uint8Array(32 * 1024 * 1024 + 1), { createWorker })).rejects.toThrow("32 MiB");
    await expect(extractLegacyDocTextOffThread(new Uint8Array(), { createWorker, timeoutMs: 0 })).rejects.toThrow("time limit");
    expect(createWorker).not.toHaveBeenCalled();
  });
  it("fails explicitly when workers are unavailable instead of parsing on the UI thread", async () => {
    await expect(extractLegacyDocTextOffThread(new Uint8Array(), { createWorker: () => { throw new Error("unavailable"); } })).rejects.toThrow("worker is unavailable");
  });
  it("rejects malformed responses and worker errors without leaking their content", async () => {
    const first = fixture(), pending = extractLegacyDocTextOffThread(new Uint8Array(), first);
    first.worker.result({ ...success, rawText: 7 }); await expect(pending).rejects.toThrow("invalid result");
    const second = fixture(), failed = extractLegacyDocTextOffThread(new Uint8Array(), second);
    second.worker.dispatchEvent(Object.assign(new Event("error"), { message: "private synthetic payload" }));
    await expect(failed).rejects.toThrow("local DOC reader failed"); expect(second.worker.terminate).toHaveBeenCalledOnce();
  });
});
