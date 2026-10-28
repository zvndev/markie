import { describe, expect, it } from "vitest";
import { VAULT_LIMITS, VaultError } from "./index";
import { VaultRepository, VaultSaveError } from "./repository";
import { validateStoredVault, VaultStorageError, type StoredVault, type VaultStorage } from "./storage";

const secret = "harbor maple quartz orbit lantern";
const metadata = { name: "Secret strategy 秘密.txt", mediaType: "text/plain" };
const bytes = new TextEncoder().encode("private body never indexed");

class TestStorage implements VaultStorage {
  value: StoredVault | null = null;
  fail: VaultStorageError | null = null;
  beforeCommit: (() => Promise<void>) | null = null;
  commits = 0;
  async load(signal?: AbortSignal) { if (signal?.aborted) throw new VaultStorageError("aborted"); return this.value ? structuredClone(this.value) : null; }
  async commit(expected: number | null, next: StoredVault, signal?: AbortSignal) {
    await this.beforeCommit?.();
    if (signal?.aborted) throw new VaultStorageError("aborted");
    if (this.fail) throw this.fail;
    if ((this.value?.revision ?? null) !== expected) throw new VaultStorageError("conflict");
    this.value = structuredClone(validateStoredVault(next));
    this.commits++;
  }
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  return { waiting: new Promise<void>((resolve) => { release = resolve; }), started: new Promise<void>((resolve) => { entered = resolve; }),
    release: () => release(), entered: () => entered() };
}

describe("encrypted durable vault repository", () => {
  it("checks the passphrase while unlocked without changing the vault, and refuses while locked", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    await repository.create(secret);
    const id = await repository.save(null, bytes, metadata);
    const before = JSON.stringify(storage.value);
    await expect(repository.verifyPassphrase(secret)).resolves.toBeUndefined();
    await expect(repository.verifyPassphrase("not the vault passphrase at all")).rejects.toMatchObject({ code: "authentication-failed" });
    expect(repository.unlocked).toBe(true);
    expect((await repository.read(id)).bytes).toEqual(bytes);
    expect(JSON.stringify(storage.value)).toBe(before);
    repository.lock();
    await expect(repository.verifyPassphrase(secret)).rejects.toMatchObject({ code: "locked" });
  });

  it("creates/imports/locks/reopens/searches/edits and deletes without persisting names or plaintext", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    expect(await repository.inspect()).toBe(false);
    await repository.create(secret);
    const id = await repository.save(null, bytes, metadata);
    const serialized = JSON.stringify(storage.value);
    expect(serialized).not.toContain(metadata.name);
    expect(serialized).not.toContain("private body");
    expect(serialized).not.toContain(secret);
    repository.lock();
    await expect(repository.list()).rejects.toMatchObject({ code: "locked" });
    await expect(repository.read(id)).rejects.toMatchObject({ code: "locked" });
    const reopened = new VaultRepository(storage);
    expect(await reopened.inspect()).toBe(true);
    await reopened.unlock(secret);
    expect(await reopened.list("STRATEGY")).toMatchObject([{ id, name: metadata.name, recovery: false }]);
    expect((await reopened.read(id)).bytes).toEqual(bytes);
    const changed = new TextEncoder().encode("updated body");
    await reopened.save(id, changed, { ...metadata, name: "Renamed.txt" });
    reopened.lock();
    await reopened.unlock(secret);
    expect((await reopened.read(id)).bytes).toEqual(changed);
    await reopened.remove(id);
    expect(await reopened.list()).toEqual([]);
    expect(storage.value?.records).toEqual([]);
  });

  it("does not replace an existing vault and wrong passwords cannot disclose metadata", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    await repository.create(secret);
    await repository.save(null, bytes, metadata);
    repository.lock();
    const original = JSON.stringify(storage.value);
    await expect(repository.create(secret)).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.unlock("a different strong passphrase")).rejects.toMatchObject({ code: "authentication-failed" });
    await expect(repository.list()).rejects.toMatchObject({ code: "locked" });
    expect(JSON.stringify(storage.value)).toBe(original);
  });

  it("serializes concurrent writes and snapshots arguments before the queue runs", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    await repository.create(secret);
    const a = new Uint8Array(bytes);
    const writing = repository.save(null, a, metadata);
    a.fill(0);
    const other = repository.save(null, bytes, { ...metadata, name: "Other.txt" });
    const [id, otherId] = await Promise.all([writing, other]);
    expect(id).not.toBe(otherId);
    expect((await repository.read(id)).bytes).toEqual(bytes);
    expect(storage.value?.revision).toBe(3);
    expect(storage.value?.records.length).toBe(2);
  });

  it("keeps failed saves as ciphertext-only recovery with stable retry IDs", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    await repository.create(secret);
    storage.fail = new VaultStorageError("quota");
    let recoveryId: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await repository.save(recoveryId, bytes, metadata); }
      catch (error) {
        expect(error).toBeInstanceOf(VaultSaveError);
        recoveryId = (error as VaultSaveError).documentId;
      }
      expect((await repository.list()).length).toBe(1);
    }
    expect(repository.hasVolatileRecovery).toBe(true);
    expect(storage.value?.records).toEqual([]);
    repository.lock();
    await repository.unlock(secret);
    expect(await repository.list()).toMatchObject([{ id: recoveryId, recovery: true }]);
    expect((await repository.read(recoveryId!)).bytes).toEqual(bytes);
    storage.fail = null;
    await repository.save(recoveryId, bytes, metadata);
    expect(repository.hasVolatileRecovery).toBe(false);
    expect(storage.value?.records.length).toBe(1);
  });

  it("preserves durable state after failed edit/delete and reports cross-window conflicts", async () => {
    const storage = new TestStorage();
    const first = new VaultRepository(storage);
    await first.create(secret);
    const id = await first.save(null, bytes, metadata);
    const second = new VaultRepository(storage);
    await second.unlock(secret);
    await first.save(id, new TextEncoder().encode("newer in first window"), metadata);
    const committed = JSON.stringify(storage.value);
    await expect(second.save(id, bytes, metadata)).rejects.toMatchObject({ failure: { code: "conflict" } });
    expect(JSON.stringify(storage.value)).toBe(committed);
    storage.fail = new VaultStorageError("quota");
    await expect(first.remove(id)).rejects.toMatchObject({ code: "quota" });
    expect(JSON.stringify(storage.value)).toBe(committed);
  });

  it("aborts an uncommitted write on lock and retains only encrypted recovery", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    await repository.create(secret);
    const pause = gate();
    storage.beforeCommit = async () => { pause.entered(); await pause.waiting; };
    const writing = repository.save(null, bytes, metadata);
    const rejected = expect(writing).rejects.toMatchObject({ failure: { code: "aborted" } });
    await pause.started;
    repository.lock();
    pause.release();
    await rejected;
    expect(storage.value?.records).toEqual([]);
    storage.beforeCommit = null;
    await repository.unlock(secret);
    expect(await repository.list()).toMatchObject([{ recovery: true }]);
  });

  it("does not resurrect a late unlock or expose queued reads after lock", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    await repository.create(secret);
    const id = await repository.save(null, bytes, metadata);
    repository.lock();
    const unlocking = repository.unlock(secret);
    const rejected = expect(unlocking).rejects.toBeInstanceOf(VaultError);
    repository.lock();
    await rejected;
    expect(repository.unlocked).toBe(false);
    await repository.unlock(secret);
    const reading = repository.read(id);
    const readingRejected = expect(reading).rejects.toMatchObject({ code: "locked" });
    repository.lock();
    await readingRejected;
  });

  it("rejects oversized inputs before allocation and bounds queued writes", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    await repository.create(secret);
    await expect(repository.save(null, new Uint8Array(VAULT_LIMITS.contentBytes + 1), metadata)).rejects.toMatchObject({ code: "limit-exceeded" });
    const writes = Array.from({ length: 4 }, () => repository.save(null, bytes, metadata));
    await expect(repository.save(null, bytes, metadata)).rejects.toMatchObject({ code: "busy" });
    await Promise.all(writes);
  });

  it("rejects corrupt snapshots/extra plaintext fields instead of normalizing them", async () => {
    const storage = new TestStorage();
    const repository = new VaultRepository(storage);
    await repository.create(secret);
    await repository.save(null, bytes, metadata);
    const snapshot = storage.value!;
    expect(() => validateStoredVault({ ...snapshot, name: metadata.name })).toThrow(VaultStorageError);
    expect(() => validateStoredVault({ ...snapshot, records: [...snapshot.records, ...snapshot.records] })).toThrow(VaultStorageError);
    expect(() => validateStoredVault({ ...snapshot, records: [{ ...snapshot.records[0], name: metadata.name }] })).toThrow(VaultStorageError);
    expect(() => validateStoredVault({ ...snapshot, revision: NaN })).toThrow(VaultStorageError);
    repository.lock();
    storage.value = { ...snapshot, header: "bad header" };
    await expect(repository.unlock(secret)).rejects.toMatchObject({ code: "corrupt" });
  });
});
