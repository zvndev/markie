import { describe, expect, it, vi } from "vitest";
import { createNativeDocumentFileAdapter, NativeDocumentFileError, type NativeDocumentDescriptor, type NativeDocumentFileApi, type NativeDocumentResult } from "./native-document-files";
const encode = (text: string) => new TextEncoder().encode(text);
const ok = <T>(value: T): NativeDocumentResult<T> => ({ ok: true, value });
function fixture(options: { writable?: boolean; name?: string; text?: string } = {}) {
  let descriptor: NativeDocumentDescriptor = { leaseId: "opaque", name: options.name ?? "source.txt", size: (options.text ?? "before").length, lastModified: 1, revision: "1", writable: options.writable ?? true }, bytes = encode(options.text ?? "before");
  const open = vi.fn(async () => ok(descriptor)), saveAs = vi.fn(async () => ok({ ...descriptor, name: "copy.txt", revision: null }));
  const read = vi.fn(async () => ok({ descriptor, bytes: new Uint8Array(bytes) }));
  const write = vi.fn(async (args: { leaseId: string; baseRevision: string | null; bytes: Uint8Array }): Promise<NativeDocumentResult<NativeDocumentDescriptor>> => {
    if (args.baseRevision !== descriptor.revision && args.baseRevision !== null) return { ok: false, error: { code: "conflict", message: "Disk changed." } };
    bytes = new Uint8Array(args.bytes); descriptor = { ...descriptor, revision: `${Number(descriptor.revision) + 1}`, size: bytes.length }; return ok(descriptor);
  });
  const release = vi.fn(async () => ok(null)), takeInitial = vi.fn(async () => ok<NativeDocumentDescriptor | null>(descriptor));
  const api: NativeDocumentFileApi = { open, saveAs, read, write, release, takeInitial };
  return { api, open, saveAs, read, write, release, takeInitial, bytes: () => bytes };
}

describe("native WebFileHandle-shaped workspace adapter", () => {
  it("opens typed byte payloads with an opaque reusable handle", async () => {
    const f = fixture(), adapter = createNativeDocumentFileAdapter(f.api), payload = await adapter.pickDocument();
    expect(payload).toMatchObject({ name: "source.txt", bytes: encode("before"), text: { text: "before" } }); expect(payload?.handle).toBeDefined();
    const one = new Uint8Array(await (await payload!.handle!.getFile()).arrayBuffer()); one.fill(0); expect(f.bytes()).toEqual(encode("before"));
  });
  it("buffers writes until close, preserves caller bytes, appends chunks and aborts without IPC", async () => {
    const f = fixture(), adapter = createNativeDocumentFileAdapter(f.api), payload = await adapter.pickDocument(), writer = await payload!.handle!.createWritable!();
    const first = encode("one"); await writer.write(first); first.fill(0); await writer.write(encode("two")); expect(f.write).not.toHaveBeenCalled(); await writer.close(); await writer.close();
    expect(f.write).toHaveBeenCalledTimes(1); expect(f.bytes()).toEqual(encode("onetwo"));
    const aborted = await payload!.handle!.createWritable!(); await aborted.write(encode("discard")); await aborted.abort!(); await expect(aborted.close()).rejects.toBeInstanceOf(NativeDocumentFileError); expect(f.write).toHaveBeenCalledTimes(1);
  });
  it("saves an existing handle and reports only confirmed file-system commits", async () => {
    const f = fixture(), adapter = createNativeDocumentFileAdapter(f.api), payload = await adapter.pickDocument();
    const saved = await adapter.saveDocument({ name: "source.txt", bytes: encode("changed"), handle: payload!.handle });
    expect(saved).toMatchObject({ method: "file-system", name: "source.txt" }); expect(f.saveAs).not.toHaveBeenCalled(); expect(f.bytes()).toEqual(encode("changed"));
  });
  it("returns canceled opens/Save As as null without a write or download fallback", async () => {
    const f = fixture(); f.api.open = async () => ok(null); f.api.saveAs = async () => ok(null); const adapter = createNativeDocumentFileAdapter(f.api);
    expect(await adapter.pickDocument()).toBeNull(); expect(await adapter.saveDocument({ name: "copy.txt", bytes: encode("unsaved") })).toBeNull(); expect(f.write).not.toHaveBeenCalled();
  });
  it("releases leases selected after caller cancellation and never starts a read", async () => {
    const f = fixture(); let finish: ((value: NativeDocumentResult<NativeDocumentDescriptor | null>) => void) | undefined;
    f.api.open = () => new Promise((resolve) => { finish = resolve; });
    const adapter = createNativeDocumentFileAdapter(f.api), controller = new AbortController(), pending = adapter.pickDocument({ signal: controller.signal }); controller.abort();
    finish!(ok({ leaseId: "canceled", name: "cancel.txt", size: 1, lastModified: 1, revision: "1", writable: true })); expect(await pending).toBeNull(); expect(f.release).toHaveBeenCalledWith({ leaseId: "canceled" }); expect(f.read).not.toHaveBeenCalled();
  });
  it("surfaces stale-writer and read-only failures without retrying elsewhere", async () => {
    const f = fixture(), adapter = createNativeDocumentFileAdapter(f.api), payload = await adapter.pickDocument();
    const a = await payload!.handle!.createWritable!(), b = await payload!.handle!.createWritable!(); await a.write(encode("winner")); await b.write(encode("stale")); await a.close(); await expect(b.close()).rejects.toMatchObject({ code: "conflict" }); expect(f.bytes()).toEqual(encode("winner")); expect(f.saveAs).not.toHaveBeenCalled();
    const readonly = fixture({ writable: false, name: "source.doc" }), readAdapter = createNativeDocumentFileAdapter(readonly.api), source = await readAdapter.pickDocument();
    await expect(readAdapter.saveDocument({ name: "source.doc", bytes: encode("changed"), handle: source!.handle })).rejects.toMatchObject({ code: "access-denied" }); expect(readonly.write).not.toHaveBeenCalled();
  });
  it("releases failed/mismatched Save As leases and keeps snapshot bytes before dialog awaits", async () => {
    const f = fixture(), adapter = createNativeDocumentFileAdapter(f.api);
    await expect(adapter.saveDocument({ name: "source.docx", bytes: encode("binary") })).rejects.toMatchObject({ code: "unsupported" }); expect(f.write).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalled();
    let finish: ((value: NativeDocumentResult<NativeDocumentDescriptor | null>) => void) | undefined;
    f.api.saveAs = () => new Promise((resolve) => { finish = resolve; }); const bytes = encode("owned"), pending = adapter.saveDocument({ name: "copy.txt", bytes }); bytes.fill(0);
    finish!(ok({ leaseId: "new", name: "copy.txt", revision: null, size: 0, lastModified: 0, writable: true })); expect(await pending).toMatchObject({ method: "file-system" }); expect(f.bytes()).toEqual(encode("owned"));
  });
  it("drains initial OS grants and invalidates released/disposed handle operations", async () => {
    const f = fixture(), adapter = createNativeDocumentFileAdapter(f.api), payload = await adapter.readInitialDocument(); expect(f.takeInitial).toHaveBeenCalledTimes(1);
    await adapter.releaseDocument(payload!.handle!); await expect(payload!.handle!.getFile()).rejects.toMatchObject({ code: "closed" });
    const another = await adapter.pickDocument(); await adapter.dispose(); await expect(another!.handle!.getFile()).rejects.toMatchObject({ code: "closed" }); await expect(adapter.pickDocument()).rejects.toMatchObject({ code: "closed" });
  });
  it("keeps exact UTF-16 BOM/CRLF bytes through initial native read and text classification", async () => {
    const f = fixture(), bytes = new Uint8Array([255, 254, 65, 0, 13, 0, 10, 0]);
    f.api.read = async () => ok({ descriptor: { leaseId: "opaque", name: "wide.txt", size: bytes.length, lastModified: 1, revision: "1", writable: true }, bytes });
    const payload = await createNativeDocumentFileAdapter(f.api).readInitialDocument(); expect(payload?.bytes).toEqual(bytes); expect(payload?.text?.encoding).toBe("utf-16le"); expect(bytes).toEqual(new Uint8Array([255, 254, 65, 0, 13, 0, 10, 0]));
  });
  it("maps optional native menu commands and removes each listener on cleanup", () => {
    const f = fixture(), listeners = new Map<string, () => void>(), cleaned: string[] = [], commands: string[] = [];
    const subscribe = (name: string) => (callback: () => void) => { listeners.set(name, callback); return () => { listeners.delete(name); cleaned.push(name); }; };
    const adapter = createNativeDocumentFileAdapter(f.api, { onMenuOpenFile: subscribe("open"), onMenuSave: subscribe("save"), onMenuSaveAs: subscribe("save-as"), onMenuNewFile: subscribe("new") });
    const cleanup = adapter.subscribeCommands((command) => commands.push(command)); for (const listener of listeners.values()) listener(); expect(commands).toEqual(["open", "save", "save-as", "new"]); cleanup(); expect(listeners.size).toBe(0); expect(cleaned).toHaveLength(4);
  });
  it("rejects invalid typed arrays before queuing bytes and returns no false save receipt", async () => {
    const f = fixture(), adapter = createNativeDocumentFileAdapter(f.api); await expect(adapter.saveDocument({ name: "copy.txt", bytes: new DataView(new ArrayBuffer(1)) as unknown as Uint8Array })).rejects.toMatchObject({ code: "too-large" }); expect(f.saveAs).not.toHaveBeenCalled();
  });
});
