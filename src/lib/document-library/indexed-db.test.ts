import { describe, expect, it } from "vitest";
import { createIndexedDbDocumentLibrary, type LibraryResult } from "./index";

// Scripted events test adapter commit boundaries, not an imitation IndexedDB engine.
// Actual reload/multi-connection persistence is verified by the leader in a browser.
interface RequestEvents {
  result: unknown;
  error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}
const request = (result?: unknown): RequestEvents => ({ result, error: null, onsuccess: null, onerror: null });
function scriptedFactory() {
  const open = { ...request(), onblocked: null as ((event: Event) => void) | null, onupgradeneeded: null as ((event: Event) => void) | null };
  let closed = 0;
  const transactions: ReturnType<typeof transaction>[] = [];
  function transaction() {
    const reads: RequestEvents[] = [], writes: { store: string; method: string; value: unknown }[] = [];
    const tx = {
      oncomplete: null as ((event: Event) => void) | null,
      onabort: null as ((event: Event) => void) | null,
      error: null as DOMException | null,
      aborted: false,
      objectStore(name: string) {
        return {
          keyPath: name === "documents" ? "id" : ["documentId", "revision"],
          getAll() { const r = request([]); reads.push(r); return r; },
          put(value: unknown) { writes.push({ store: name, method: "put", value }); return request(); },
          delete(value: unknown) { writes.push({ store: name, method: "delete", value }); return request(); },
        };
      },
      abort() { tx.aborted = true; tx.onabort?.(new Event("abort")); },
    };
    return { tx, reads, writes, deliver(documents: unknown[] = [], recovery: unknown[] = []) {
      reads[0].result = documents; reads[0].onsuccess?.(new Event("success"));
      reads[1].result = recovery; reads[1].onsuccess?.(new Event("success"));
    }, complete() { tx.oncomplete?.(new Event("complete")); }, fail(name: string) { tx.error = new DOMException("scripted failure", name); tx.abort(); } };
  }
  const db = {
    version: 1,
    objectStoreNames: { length: 2, contains: (name: string) => ["documents", "recovery"].includes(name) },
    close() { closed++; },
    transaction() { const t = transaction(); transactions.push(t); return t.tx; },
    onversionchange: null as (() => void) | null,
    onclose: null as (() => void) | null,
  };
  open.result = db;
  return { factory: { open: () => open } as unknown as IDBFactory, open, db, transactions, closed: () => closed, succeedOpen() { open.onsuccess?.(new Event("success")); } };
}
function value<T>(result: LibraryResult<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.value; }
const input = { id: "one", name: "note.txt", format: "text" as const, bytes: new Uint8Array([1, 2, 3]) };

describe("IndexedDB adapter explicit failure and transaction semantics", () => {
  it("validates Darkmown source and recovery in the existing schema without treating them as Markdown", async () => {
    const memory = (await import("./index")).createMemoryDocumentLibrary({ now: () => 10 });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(":state count = 0\r\n")]);
    const existing = value(await memory.put({ id: "counter", name: "Counter.wd", format: "darkmown", bytes }, null));
    const history = value(await memory.listRecovery(existing.id));
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.succeedOpen(); const repo = value(await opening);
    const reading = repo.list({ formats: ["darkmown"] }), tx = script.transactions.at(-1)!;
    tx.deliver([existing], history); tx.complete();
    expect(value(await reading)).toEqual([existing]);
    const recovering = repo.listRecovery(existing.id), recovery = script.transactions.at(-1)!;
    recovery.deliver([existing], history); recovery.complete();
    expect(value(await recovering)[0].record).toMatchObject({ schemaVersion: 1, format: "darkmown", bytes });
    expect(tx.writes).toEqual([]); expect(recovery.writes).toEqual([]);
  });
  it("does not acknowledge successful requests before the entire transaction commits", async () => {
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory, now: () => 10 });
    script.succeedOpen(); const repo = value(await opening);
    let settled = false;
    const saving = repo.put(input, null).then((result) => { settled = true; return result; });
    const tx = script.transactions.at(-1)!; tx.deliver();
    expect(tx.writes.filter((w) => w.method === "put").map((w) => w.store)).toEqual(["documents", "recovery"]);
    await Promise.resolve(); expect(settled).toBe(false);
    tx.complete(); expect(value(await saving)).toMatchObject({ id: "one", revision: 1 });
  });
  it("reports a late quota abort even after both document and recovery writes were scheduled", async () => {
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.succeedOpen(); const repo = value(await opening), saving = repo.put(input, null);
    const tx = script.transactions.at(-1)!; tx.deliver(); expect(tx.writes).toHaveLength(2); tx.fail("QuotaExceededError");
    expect(await saving).toMatchObject({ ok: false, error: { code: "storage-quota" } });
  });
  it("deletes the document and all matching recovery keys within one transaction", async () => {
    const memory = (await import("./index")).createMemoryDocumentLibrary({ now: () => 10 });
    const existing = value(await memory.put(input, null)), history = value(await memory.listRecovery(existing.id));
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.succeedOpen(); const repo = value(await opening), removing = repo.remove("one", 1);
    const tx = script.transactions.at(-1)!; tx.deliver([existing], history);
    expect(tx.writes).toEqual([{ store: "documents", method: "delete", value: "one" }, { store: "recovery", method: "delete", value: ["one", 1] }]);
    tx.complete(); expect(value(await removing)).toBeNull();
  });
  it("export confirmation changes only export state, not recovery or content revision", async () => {
    const memory = (await import("./index")).createMemoryDocumentLibrary({ now: () => 10 });
    const existing = value(await memory.put(input, null)), history = value(await memory.listRecovery(existing.id));
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.succeedOpen(); const repo = value(await opening), exporting = repo.markExported("one", 1);
    const tx = script.transactions.at(-1)!; tx.deliver([existing], history);
    expect(tx.writes).toHaveLength(1); expect(tx.writes[0]).toMatchObject({ store: "documents", method: "put", value: { exportedRevision: 1, revision: 1 } });
    tx.complete(); expect(value(await exporting)).toMatchObject({ exportedRevision: 1, revision: 1 });
  });
  it("aborts stale-revision transactions without scheduling any writes", async () => {
    const memory = (await import("./index")).createMemoryDocumentLibrary({ now: () => 10 });
    const existing = value(await memory.put(input, null));
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.succeedOpen(); const repo = value(await opening), saving = repo.put(input, null);
    const tx = script.transactions.at(-1)!; tx.deliver([existing]);
    expect(await saving).toMatchObject({ ok: false, error: { code: "conflict", actualRevision: 1 } });
    expect(tx.tx.aborted).toBe(true); expect(tx.writes).toEqual([]);
  });
  it("fails closed on corrupt stored rows, failed reads, and transaction aborts", async () => {
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.succeedOpen(); const repo = value(await opening);
    const bad = repo.list(), tx = script.transactions.at(-1)!; tx.deliver([{ schemaVersion: 99 }]);
    expect(await bad).toMatchObject({ ok: false, error: { code: "corrupt-storage" } }); expect(tx.writes).toEqual([]);
    const failed = repo.list(), next = script.transactions.at(-1)!;
    next.reads[0].error = new DOMException("not readable", "UnknownError"); next.reads[0].onerror?.(new Event("error")); next.fail("UnknownError");
    expect(await failed).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
  });
  it("returns an honest blocked-open error and closes a later successful connection", async () => {
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.open.onblocked?.(new Event("blocked")); expect(await opening).toMatchObject({ ok: false, error: { code: "storage-blocked" } });
    script.succeedOpen(); expect(script.closed()).toBe(1);
  });
  it("reports failed, throwing, unavailable and timed-out opens without memory fallback", async () => {
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.open.error = new DOMException("denied", "SecurityError"); script.open.onerror?.(new Event("error"));
    expect(await opening).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    const throwing = { open() { throw new DOMException("denied", "SecurityError"); } } as unknown as IDBFactory;
    expect(await createIndexedDbDocumentLibrary({ indexedDB: throwing })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    expect(await createIndexedDbDocumentLibrary({ indexedDB: null })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    expect(await createIndexedDbDocumentLibrary({ indexedDB: scriptedFactory().factory, openTimeoutMs: 1 })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
  });
  it("rejects unexpected database schemas and invalid options", async () => {
    const script = scriptedFactory(); script.db.objectStoreNames.length = 3;
    const opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory }); script.succeedOpen();
    expect(await opening).toMatchObject({ ok: false, error: { code: "corrupt-storage" } });
    expect(await createIndexedDbDocumentLibrary({ indexedDB: script.factory, databaseName: "" })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(await createIndexedDbDocumentLibrary({ indexedDB: script.factory, limits: { maxRecords: -1 } })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
  it("closes on versionchange and does not attempt further transactions", async () => {
    const script = scriptedFactory(), opening = createIndexedDbDocumentLibrary({ indexedDB: script.factory });
    script.succeedOpen(); const repo = value(await opening); script.db.onversionchange?.();
    expect(await repo.get("one")).toMatchObject({ ok: false, error: { code: "closed" } }); expect(script.closed()).toBe(1);
  });
});
