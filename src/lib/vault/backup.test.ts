import { describe, expect, it, vi } from "vitest";
import { VaultBackupError, parseVaultBackup, serializeVaultBackup, vaultBackupBytes, vaultBackupText } from "./backup";
import { VaultRepository, type VaultDeviceKeeper } from "./repository";
import { validateStoredVault, VaultStorageError, type StoredVault, type VaultStorage } from "./storage";

const passphrase = "harbor maple quartz orbit lantern";
const metadata = { name: "Secret plan.txt", mediaType: "text/plain" };
const body = new TextEncoder().encode("private body");

class TestStorage implements VaultStorage {
  value: StoredVault | null = null;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async commit(expected: number | null, next: StoredVault, _signal?: AbortSignal, options?: { replaceHeader?: boolean }) {
    if ((this.value?.revision ?? null) !== expected) throw new VaultStorageError("conflict");
    if (this.value && this.value.header !== next.header && !options?.replaceHeader) throw new VaultStorageError("conflict");
    this.value = structuredClone(validateStoredVault(next));
  }
}

const keeper: VaultDeviceKeeper = {
  release: async () => ({ ok: false, reason: "missing" }),
  store: async () => ({ ok: true }),
  remove: async () => undefined,
};

async function populated() {
  const storage = new TestStorage();
  const repository = new VaultRepository(storage);
  await repository.create(passphrase);
  const id = await repository.save(null, body, metadata);
  await repository.save(null, new TextEncoder().encode("second"), { ...metadata, name: "Second.txt" });
  return { storage, repository, id };
}

describe("encrypted vault backup", () => {
  it("round-trips: back up, wipe storage, restore, then unlock with the same passphrase", async () => {
    const { storage, repository, id } = await populated();
    await repository.enrollDevice(passphrase, keeper);
    const text = await repository.backup();
    // Ciphertext only: no names, contents, passphrase or device slot.
    for (const secret of ["Secret plan", "private body", passphrase, "deviceSlot", "device-slot"]) expect(text).not.toContain(secret);
    const parsed = parseVaultBackup(vaultBackupText(vaultBackupBytes(text)));
    expect(parsed.header).toBe(storage.value!.header);
    expect(parsed.records).toEqual(storage.value!.records);
    repository.lock();

    const wiped = new TestStorage();
    const restored = new VaultRepository(wiped);
    expect(await restored.inspect()).toBe(false);
    expect(await restored.restore(text, passphrase)).toEqual({ replacedVaultId: null });
    expect(restored.unlocked).toBe(true);
    expect(wiped.value).toMatchObject({ revision: 1, header: parsed.header, records: parsed.records });
    expect(wiped.value && "deviceSlot" in wiped.value).toBe(false);
    restored.lock();

    const fresh = new VaultRepository(wiped);
    await fresh.unlock(passphrase);
    expect((await fresh.list()).map((entry) => entry.name)).toEqual(["Second.txt", "Secret plan.txt"]);
    expect((await fresh.read(id)).bytes).toEqual(body);
  });

  it("refuses to overwrite an existing vault unless asked, and then only after the passphrase works", async () => {
    const { repository } = await populated();
    const text = await repository.backup();
    const other = await populated();
    const before = JSON.stringify(other.storage.value);
    other.repository.lock();
    await expect(other.repository.restore(text, passphrase)).rejects.toMatchObject({ code: "conflict" });
    await expect(other.repository.restore(text, "a different strong passphrase", { replace: true })).rejects.toMatchObject({ code: "authentication-failed" });
    expect(JSON.stringify(other.storage.value)).toBe(before);
    const { replacedVaultId } = await other.repository.restore(text, passphrase, { replace: true });
    expect(replacedVaultId).toBe(JSON.parse(JSON.parse(before).header).vaultId);
    expect(other.storage.value?.header).toBe(parseVaultBackup(text).header);
    expect(other.storage.value?.revision).toBe(JSON.parse(before).revision + 1);
    expect((await other.repository.list()).length).toBe(2);
  });

  it("does not write anything when a record in the backup fails to authenticate", async () => {
    const { repository } = await populated();
    const backup = JSON.parse(await repository.backup());
    const envelope = JSON.parse(backup.records[0].envelope);
    envelope.ciphertext = (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
    backup.records[0].envelope = JSON.stringify(envelope);
    const target = new VaultRepository(new TestStorage());
    await expect(target.restore(JSON.stringify(backup), passphrase)).rejects.toMatchObject({ code: "authentication-failed" });
    expect((target.storage as TestStorage).value).toBeNull();
    expect(target.unlocked).toBe(false);
  });

  it("can restore while the current vault is unlocked, and keeps it unlocked if restoring fails", async () => {
    const { repository } = await populated();
    const text = await repository.backup();
    const other = await populated();
    await expect(other.repository.restore(text, "not the backup's passphrase", { replace: true })).rejects.toMatchObject({ code: "authentication-failed" });
    expect(other.repository.unlocked).toBe(true);
    await other.repository.restore(text, passphrase, { replace: true });
    expect(other.repository.vaultId).toBe(JSON.parse(parseVaultBackup(text).header).vaultId);
    expect((await other.repository.list()).length).toBe(2);
  });

  it("validates the backup format strictly", async () => {
    const { storage } = await populated();
    const text = serializeVaultBackup(storage.value!);
    const value = JSON.parse(text);
    for (const invalid of [
      "", "{}", "null", "[]", ` ${text}`, `${text}\n`, text.replace('"version":1', '"version":2'),
      JSON.stringify({ ...value, extra: true }), JSON.stringify({ ...value, kind: "markie-vault" }),
      JSON.stringify({ ...value, deviceSlot: "x" }), JSON.stringify({ ...value, records: [{ ...value.records[0], name: "Secret plan.txt" }] }),
      JSON.stringify({ ...value, records: [...value.records, value.records[0]] }), JSON.stringify({ ...value, header: "bad" }),
      JSON.stringify({ header: value.header, kind: value.kind, version: 1, records: value.records }),
    ]) expect(() => parseVaultBackup(invalid), invalid.slice(0, 40)).toThrow(VaultBackupError);
    expect(() => vaultBackupText(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(VaultBackupError);
    expect(parseVaultBackup(text).records.length).toBe(2);
  });

  it("backs up exactly what storage holds, not memory-only recovery", async () => {
    const { storage, repository } = await populated();
    const commit = vi.spyOn(storage, "commit").mockRejectedValueOnce(new VaultStorageError("quota"));
    await expect(repository.save(null, body, { ...metadata, name: "Unsaved.txt" })).rejects.toBeTruthy();
    commit.mockRestore();
    expect(repository.hasVolatileRecovery).toBe(true);
    expect(parseVaultBackup(await repository.backup()).records.length).toBe(2);
  });
});
