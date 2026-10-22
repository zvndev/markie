// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { createMemoryDocumentLibrary } from "./index";

describe("cross-realm byte ownership", () => {
  it("roundtrips actual foreign Uint8Arrays through jsdom and structuredClone recovery", async () => {
    const repo = createMemoryDocumentLibrary({ createId: () => "foreign" });
    const bytes = runInNewContext("new Uint8Array([255, 254, 65, 0, 13, 0, 10, 0])") as Uint8Array;
    expect(bytes instanceof Uint8Array).toBe(false);
    const pending = repo.put({ name: "a.txt", format: "text", bytes }, null); bytes.fill(0);
    const saved = await pending; expect(saved.ok).toBe(true); if (!saved.ok) return;
    expect([...saved.value.bytes]).toEqual([255, 254, 65, 0, 13, 0, 10, 0]);
    const read = await repo.get("foreign"), history = await repo.listRecovery("foreign");
    expect(read.ok).toBe(true); expect(history.ok).toBe(true);
    const restored = await repo.restoreRecovery("foreign", 1, 1); expect(restored.ok).toBe(true);
    if (restored.ok) expect([...restored.value.bytes]).toEqual([255, 254, 65, 0, 13, 0, 10, 0]);
  });
  it("rejects signed/clamped/wide arrays, DataView, proxies and spoofed byte objects", async () => {
    const signed = new Int8Array([1]); Object.defineProperty(signed, Symbol.toStringTag, { value: "Uint8Array" });
    const candidates = [signed, new Uint8ClampedArray([1]), new Uint16Array([1]), new DataView(new ArrayBuffer(4)), new Proxy(new Uint8Array([1]), {}), { buffer: new ArrayBuffer(1), byteLength: 1, [Symbol.toStringTag]: "Uint8Array" }];
    const repo = createMemoryDocumentLibrary();
    for (const bytes of candidates) expect(await repo.put({ name: "a.txt", format: "text", bytes: bytes as Uint8Array }, null)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
});
