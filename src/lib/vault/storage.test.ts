import { afterEach, describe, expect, it, vi } from "vitest";
import { Vault, createVaultDocumentId } from "./index";
import { IndexedDbVaultStorage, VAULT_DATABASE_NAME, VaultStorageError, requestPersistentStorage, type StoredVault } from "./storage";

/** Transactional event harness: native browser IndexedDB is covered by the browser smoke. */
function databaseHarness() {
  let value: unknown;
  let upgraded = false;
  let hold = false;
  let quota = false;
  let closed = 0;
  let active: { finish: () => void } | undefined;
  const requests: Array<{ name: string; version: number | undefined }> = [];
  const database = {
    objectStoreNames: { contains: () => upgraded },
    createObjectStore: () => { upgraded = true; },
    close: () => { closed++; },
    onversionchange: null as null | (() => void),
    transaction: (_store: string, mode: IDBTransactionMode) => {
      let aborted = false;
      let completed = false;
      let queued = 0;
      let next: unknown = value;
      const transaction = {
        oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void), error: null as DOMException | null,
        abort: () => { if (completed) throw new DOMException("done", "InvalidStateError"); aborted = true; queueMicrotask(() => transaction.onabort?.()); },
        objectStore: () => ({
          get: () => {
            const request = { result: undefined as unknown, onsuccess: null as null | (() => void) };
            queued++;
            queueMicrotask(() => {
              if (aborted) return;
              request.result = value === undefined ? undefined : structuredClone(value);
              request.onsuccess?.();
              queued--;
              maybeFinish();
            });
            return request;
          },
          put: (snapshot: unknown) => {
            if (quota) throw new DOMException("full", "QuotaExceededError");
            next = structuredClone(snapshot);
          },
        }),
      };
      const finish = () => {
        if (aborted || completed || queued) return;
        completed = true;
        if (mode === "readwrite") value = next;
        transaction.oncomplete?.();
      };
      const maybeFinish = () => { if (!hold || mode === "readonly") queueMicrotask(finish); };
      active = { finish };
      return transaction;
    },
  };
  const factory = {
    open: (name: string, version?: number) => {
      requests.push({ name, version });
      const request = { result: database, error: null, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null, onblocked: null };
      queueMicrotask(() => { if (!upgraded) request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, requests, read: () => value, inject: (next: unknown) => { value = next; },
    hold: (next: boolean) => { hold = next; }, quota: (next: boolean) => { quota = next; },
    finish: () => active?.finish(), closed: () => closed };
}

async function snapshot(): Promise<StoredVault> {
  const vault = new Vault();
  const header = await vault.create("quartz maple harbor lantern orbit");
  const id = createVaultDocumentId();
  const envelope = await vault.encryptDocument(id, new TextEncoder().encode("private body"), { name: "Private.txt", mediaType: "text/plain" });
  vault.lock();
  return { version: 1, revision: 1, header, records: [{ id, envelope }] };
}

afterEach(() => vi.unstubAllGlobals());

describe("real IndexedDB vault adapter transaction contract", () => {
  it("uses only its separate database and writes header+records in one committed snapshot", async () => {
    const harness = databaseHarness();
    const storage = new IndexedDbVaultStorage(harness.factory);
    expect(await storage.load()).toBeNull();
    const next = await snapshot();
    await storage.commit(null, next);
    expect(await storage.load()).toEqual(next);
    expect(harness.requests.every((request) => request.name === VAULT_DATABASE_NAME && request.version === 1)).toBe(true);
    expect(JSON.stringify(harness.read())).not.toContain("Private.txt");
    expect(harness.closed()).toBe(3);
  });

  it("does not report success before the transaction completes", async () => {
    const harness = databaseHarness();
    const storage = new IndexedDbVaultStorage(harness.factory);
    const next = await snapshot();
    harness.hold(true);
    let settled = false;
    const writing = storage.commit(null, next).then(() => { settled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(harness.read()).toBeUndefined();
    harness.finish();
    await writing;
    expect(harness.read()).toEqual(next);
  });

  it("rolls back the entire pending transaction when lock aborts it", async () => {
    const harness = databaseHarness();
    const storage = new IndexedDbVaultStorage(harness.factory);
    const original = await snapshot();
    await storage.commit(null, original);
    harness.hold(true);
    const controller = new AbortController();
    const writing = storage.commit(1, { ...original, revision: 2, records: [] }, controller.signal);
    const rejected = expect(writing).rejects.toMatchObject({ code: "aborted" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await rejected;
    expect(harness.read()).toEqual(original);
  });

  it("rejects stale revisions, replacement headers and quota writes without partial state", async () => {
    const harness = databaseHarness();
    const storage = new IndexedDbVaultStorage(harness.factory);
    const original = await snapshot();
    await storage.commit(null, original);
    await expect(storage.commit(null, original)).rejects.toMatchObject({ code: "conflict" });
    const unrelated = await snapshot();
    await expect(storage.commit(1, { ...unrelated, revision: 2 })).rejects.toMatchObject({ code: "conflict" });
    harness.quota(true);
    await expect(storage.commit(1, { ...original, revision: 2, records: [] })).rejects.toMatchObject({ code: "quota" });
    expect(harness.read()).toEqual(original);
  });

  it("does not silently recreate malformed storage or fall back when storage is unavailable", async () => {
    const harness = databaseHarness();
    const storage = new IndexedDbVaultStorage(harness.factory);
    harness.inject({ version: 1, revision: 1, header: "private plaintext", records: [] });
    await expect(storage.load()).rejects.toMatchObject({ code: "corrupt" });
    expect(harness.read()).toMatchObject({ header: "private plaintext" });
    vi.stubGlobal("indexedDB", undefined);
    await expect(new IndexedDbVaultStorage().load()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("handles an already-aborted open without creating a connection", async () => {
    const harness = databaseHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(new IndexedDbVaultStorage(harness.factory).load(controller.signal)).rejects.toBeInstanceOf(VaultStorageError);
    expect(harness.requests).toEqual([]);
  });

  it("loads a snapshot written before device slots and adds or drops a slot without touching the header", async () => {
    const harness = databaseHarness();
    const storage = new IndexedDbVaultStorage(harness.factory);
    const legacy = await snapshot();
    harness.inject(structuredClone(legacy));
    expect(await storage.load()).toEqual(legacy);
    const vault = new Vault();
    await vault.unlock(legacy.header, "quartz maple harbor lantern orbit");
    const { slot, secret } = await vault.enrollDevice(legacy.header, "quartz maple harbor lantern orbit");
    secret.fill(0);
    await storage.commit(1, { ...legacy, revision: 2, deviceSlot: slot });
    expect(await storage.load()).toEqual({ ...legacy, revision: 2, deviceSlot: slot });
    await storage.commit(2, { ...legacy, revision: 3 });
    expect(Object.keys(harness.read() as object)).toEqual(["version", "revision", "header", "records"]);
  });

  it("replaces the header only for an explicit restore", async () => {
    const harness = databaseHarness();
    const storage = new IndexedDbVaultStorage(harness.factory);
    const original = await snapshot();
    await storage.commit(null, original);
    const other = await snapshot();
    await expect(storage.commit(1, { ...other, revision: 2 })).rejects.toMatchObject({ code: "conflict" });
    await expect(storage.commit(null, other, undefined, { replaceHeader: true })).rejects.toMatchObject({ code: "conflict" });
    await storage.commit(1, { ...other, revision: 2 }, undefined, { replaceHeader: true });
    expect(await storage.load()).toEqual({ ...other, revision: 2 });
  });
});

describe("persistent storage request", () => {
  it("asks once, reports the answer, and survives browsers without the API", async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persist, persisted: async () => false })).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    const again = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persist: again, persisted: async () => true })).toBe(true);
    expect(again).not.toHaveBeenCalled();
    expect(await requestPersistentStorage({ persist: async () => false, persisted: async () => false })).toBe(false);
    expect(await requestPersistentStorage({} as unknown as StorageManager)).toBeNull();
    expect(await requestPersistentStorage({ persist: async () => { throw new Error("denied"); }, persisted: async () => false })).toBeNull();
  });
});
