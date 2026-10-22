import { afterEach, describe, expect, it, vi } from "vitest";
import { compileDarkmownOffThread } from "./compiler-worker-client";
import { validateDarkmownPreviewSource } from "./compiler-types";

class FakeWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();
  result(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
function fixture() {
  const worker = new FakeWorker();
  return { worker, createWorker: () => worker as unknown as Worker };
}
const result = { bodyHtml: "<main>Counter</main>", title: "Counter", warnings: [], requiresRuntime: true, hasCode: false };
afterEach(() => vi.useRealTimers());

describe("bounded off-thread Darkmown preview compiler", () => {
  it("compiles only the supplied source and disposes after a valid response", async () => {
    const f = fixture(), source = ":state count = 0";
    const pending = compileDarkmownOffThread(source, f);
    expect(f.worker.postMessage).toHaveBeenCalledExactlyOnceWith(source);
    f.worker.result({ ok: true, result });
    expect(await pending).toEqual(result);
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });

  it("disposes hung work on the hard time budget and ignores late results", async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = compileDarkmownOffThread("# Counter", { ...f, timeoutMs: 20 });
    const rejected = expect(pending).rejects.toThrow("time budget");
    await vi.advanceTimersByTimeAsync(20); await rejected;
    f.worker.result({ ok: true, result });
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });

  it("allows bounded cold worker startup but terminates at the default ten-second budget", async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = compileDarkmownOffThread("# Counter", f);
    const rejected = expect(pending).rejects.toThrow("time budget");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });

  it("cancels before creation or in flight and disposes exactly once", async () => {
    const controller = new AbortController(), f = fixture();
    const pending = compileDarkmownOffThread("# Counter", { ...f, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    const createWorker = vi.fn();
    await expect(compileDarkmownOffThread("# Counter", { createWorker, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("never falls back to synchronous compilation when a worker is unavailable", async () => {
    await expect(compileDarkmownOffThread("# Counter", { createWorker: () => { throw new Error("unavailable"); } })).rejects.toThrow("worker is unavailable");
    await expect(compileDarkmownOffThread("# Counter", { timeoutMs: 0 })).rejects.toThrow("time limit");
  });

  it("retains bounded compiler errors and rejects malformed worker output", async () => {
    const first = fixture(), invalid = compileDarkmownOffThread("# Counter", first);
    first.worker.result({ ok: true, result: { ...result, bodyHtml: "x".repeat(1_000_001) } });
    await expect(invalid).rejects.toThrow("invalid result");
    const second = fixture(), coded = compileDarkmownOffThread(":state", second);
    second.worker.result({ ok: false, error: "[WD201] Missing state arguments" });
    await expect(coded).rejects.toThrow("WD201");
    const third = fixture(), failed = compileDarkmownOffThread("# Counter", third);
    third.worker.dispatchEvent(Object.assign(new Event("error"), { message: "internal payload" }));
    await expect(failed).rejects.toThrow("local preview compiler failed");
    expect(third.worker.terminate).toHaveBeenCalledOnce();
  });

  it("refuses static, reactive and nested expansion before constructing a worker", async () => {
    const createWorker = vi.fn();
    const examples = [
      "@loop meta.tags into row\nRepeated\n@endloop",
      ":state rows = []\n@loop rows into row\nRepeated\n@endloop",
      "::: section\n@loop meta.tags into row\n@loop meta.tags into item\nRepeated\n@endloop\n@endloop\n:::",
      "@include /other.wd",
      "# Windows\r\n@loop meta.tags into row\r\nRepeated\r\n@endloop",
    ];
    for (const source of examples) await expect(compileDarkmownOffThread(source, { createWorker })).rejects.toThrow("not available");
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("follows compiler fence semantics for literal directive examples", () => {
    expect(() => validateDarkmownPreviewSource("````wd\n```\n@loop meta.tags into row\n````\n# Safe")).not.toThrow();
    expect(() => validateDarkmownPreviewSource("~~~wd\n@loop rows into row\n~~~\n# Safe")).not.toThrow();
    expect(() => validateDarkmownPreviewSource("\\@loop rows into row\n    @loop rows into row")).not.toThrow();
    expect(() => validateDarkmownPreviewSource("```wd\nLiteral\n```\n@loop rows into row")).toThrow("not available");
  });

  it("rejects exponential computed concatenation before executing the compiler", async () => {
    const createWorker = vi.fn();
    const source = ':state x0 = "' + "a".repeat(1_000) + '"\n' + Array.from({ length: 13 }, (_, index) => `:computed x${index + 1} = x${index} + x${index}`).join("\n") + "\n\n{ x13 }";
    await expect(compileDarkmownOffThread(source, { createWorker })).rejects.toThrow("concatenation");
    expect(createWorker).not.toHaveBeenCalled();
    expect(() => validateDarkmownPreviewSource("---\ntitle: Counter\n```\n---\n:computed x = x + x")).toThrow("concatenation");
    expect(() => validateDarkmownPreviewSource(":state count = 0\n:computed doubled = count * 2\n{ doubled }")).not.toThrow();
  });

  it("rejects amplifying format pipelines and repeated large bindings before worker creation", async () => {
    const createWorker = vi.fn();
    for (const source of [':state list = []\n{ list | join:"long separator" }', ':state list = []\n{ list \\| join:"long separator" }', '{ meta.title | upper }']) {
      await expect(compileDarkmownOffThread(source, { createWorker })).rejects.toThrow("pipelines");
    }
    const repeated = ':state text = "' + "a".repeat(10_000) + '"\n' + "{ text }\n".repeat(100);
    await expect(compileDarkmownOffThread(repeated, { createWorker })).rejects.toThrow("complexity budget");
    expect(createWorker).not.toHaveBeenCalled();
    expect(() => validateDarkmownPreviewSource("```wd\n{ rows | join:\", \" }\n:computed y = x + x\n```")).not.toThrow();
  });
});
