import { afterEach, describe, expect, it, vi } from "vitest";
import { VAULT_DEVICE_SECRET_BYTES, Vault, createVaultDocumentId, parseVaultDeviceSlot, serializeVaultDeviceSlot } from "./index";
import { decodeBase64, encodeBase64 } from "./envelope";
import { VaultDeviceError, VaultRepository, type VaultDeviceFailure, type VaultDeviceKeeper } from "./repository";
import { validateStoredVault, VaultStorageError, type StoredVault, type VaultStorage } from "./storage";

const passphrase = "quartz maple orbit lantern harbor";
const metadata = { name: "Keys.env", mediaType: "text/plain" };
const body = new TextEncoder().encode("API_TOKEN=secret\n");

afterEach(() => { vi.restoreAllMocks(); });

class TestStorage implements VaultStorage {
  value: StoredVault | null = null;
  fail: VaultStorageError | null = null;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async commit(expected: number | null, next: StoredVault) {
    if (this.fail) throw this.fail;
    if ((this.value?.revision ?? null) !== expected) throw new VaultStorageError("conflict");
    this.value = structuredClone(validateStoredVault(next));
  }
}

/** Stands in for the main process: a keychain behind a biometric check. */
function keychain() {
  const secrets = new Map<string, Uint8Array>();
  const released: Uint8Array[] = [];
  const stored: Uint8Array[] = [];
  let refuse: VaultDeviceFailure | null = null;
  const keeper: VaultDeviceKeeper = {
    release: vi.fn(async (vaultId: string) => {
      if (refuse) return { ok: false as const, reason: refuse };
      const secret = secrets.get(vaultId);
      if (!secret) return { ok: false as const, reason: "missing" as const };
      const copy = new Uint8Array(secret);
      released.push(copy);
      return { ok: true as const, secret: copy };
    }),
    store: vi.fn(async (vaultId: string, secret: Uint8Array) => {
      if (refuse) return { ok: false as const, reason: refuse };
      stored.push(secret);
      secrets.set(vaultId, new Uint8Array(secret));
      return { ok: true as const };
    }),
    remove: vi.fn(async (vaultId: string) => { secrets.delete(vaultId); }),
  };
  return { keeper, secrets, released, stored, refuse: (reason: VaultDeviceFailure | null) => { refuse = reason; } };
}

async function vaultWithFile() {
  const storage = new TestStorage();
  const repository = new VaultRepository(storage);
  await repository.create(passphrase);
  const id = await repository.save(null, body, metadata);
  return { storage, repository, id };
}

describe("device slot crypto", () => {
  it("enrolls during a passphrase check, then unlocks with only the device secret", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    const id = createVaultDocumentId();
    const envelope = await vault.encryptDocument(id, body, metadata);
    const { slot, secret } = await vault.enrollDevice(header, passphrase);
    expect(secret.length).toBe(VAULT_DEVICE_SECRET_BYTES);
    expect(slot).not.toContain(encodeBase64(secret));
    const parsed = parseVaultDeviceSlot(slot);
    expect(parsed.vaultId).toBe(vault.vaultId);
    vault.lock();
    const handed = new Uint8Array(secret);
    await vault.unlockWithDeviceSecret(header, slot, handed);
    expect(vault.state).toBe("unlocked");
    expect(handed.every((byte) => byte === 0)).toBe(true);
    expect((await vault.decryptDocument(envelope, id)).bytes).toEqual(body);
  });

  it("fails cleanly for a wrong, short or missing secret and stays locked", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    const { slot, secret } = await vault.enrollDevice(header, passphrase);
    vault.lock();
    const wrong = new Uint8Array(secret);
    wrong[0] ^= 1;
    await expect(vault.unlockWithDeviceSecret(header, slot, wrong)).rejects.toMatchObject({ code: "authentication-failed" });
    expect(wrong.every((byte) => byte === 0)).toBe(true);
    await expect(vault.unlockWithDeviceSecret(header, slot, new Uint8Array(16))).rejects.toMatchObject({ code: "authentication-failed" });
    await expect(vault.unlockWithDeviceSecret(header, slot, undefined as unknown as Uint8Array)).rejects.toMatchObject({ code: "authentication-failed" });
    expect(vault.state).toBe("locked");
    await vault.unlockWithDeviceSecret(header, slot, secret);
    expect(vault.state).toBe("unlocked");
  });

  it("binds the slot to its vault: another vault's header or a moved slot does not open", async () => {
    const a = new Vault();
    const b = new Vault();
    const headerA = await a.create(passphrase);
    const headerB = await b.create(passphrase);
    const { slot, secret } = await a.enrollDevice(headerA, passphrase);
    a.lock();
    b.lock();
    await expect(b.unlockWithDeviceSecret(headerB, slot, new Uint8Array(secret))).rejects.toMatchObject({ code: "authentication-failed" });
    // Relabelling the slot with B's ID passes the ID check but fails authentication.
    const relabelled = serializeVaultDeviceSlot({ ...parseVaultDeviceSlot(slot), vaultId: JSON.parse(headerB).vaultId });
    await expect(b.unlockWithDeviceSecret(headerB, relabelled, new Uint8Array(secret))).rejects.toMatchObject({ code: "authentication-failed" });
    expect(b.state).toBe("locked");
  });

  it("cannot enroll while locked, with a wrong passphrase, or for another vault", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    await expect(vault.enrollDevice(header, "a different strong passphrase")).rejects.toMatchObject({ code: "authentication-failed" });
    const other = new Vault();
    await expect(vault.enrollDevice(await other.create(passphrase), passphrase)).rejects.toMatchObject({ code: "authentication-failed" });
    vault.lock();
    await expect(vault.enrollDevice(header, passphrase)).rejects.toMatchObject({ code: "locked" });
  });

  it("zeroes the decrypted vault key and drops an enrollment that finishes after lock", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let raw: ArrayBuffer | undefined;
    vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => (raw = await decrypt(...args)));
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      const result = await encrypt(...args);
      vault.lock();
      return result;
    });
    await expect(vault.enrollDevice(header, passphrase)).rejects.toMatchObject({ code: "locked" });
    expect(new Uint8Array(raw!).every((byte) => byte === 0)).toBe(true);
  });

  it("keeps the unlocked keys non-extractable on the device path", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    const { slot, secret } = await vault.enrollDevice(header, passphrase);
    vault.lock();
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    await vault.unlockWithDeviceSecret(header, slot, secret);
    expect(importKey.mock.calls.length).toBe(2);
    expect(importKey.mock.calls.every((call) => call[3] === false)).toBe(true);
  });

  it("does not adopt a device unlock that completes after lock, and refuses a second unlock", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    const { slot, secret } = await vault.enrollDevice(header, passphrase);
    vault.lock();
    const unlocking = vault.unlockWithDeviceSecret(header, slot, new Uint8Array(secret));
    await expect(vault.unlockWithDeviceSecret(header, slot, new Uint8Array(secret))).rejects.toMatchObject({ code: "busy" });
    vault.lock();
    await expect(unlocking).rejects.toMatchObject({ code: "locked" });
    expect(vault.state).toBe("locked");
  });

  it("rejects malformed slots strictly", () => {
    const slot = { kind: "markie-vault-device-slot", version: 1, vaultId: createVaultDocumentId(), iv: encodeBase64(new Uint8Array(12)), ciphertext: encodeBase64(new Uint8Array(48)) };
    expect(parseVaultDeviceSlot(JSON.stringify(slot)).vaultId).toBe(slot.vaultId);
    for (const invalid of [
      JSON.stringify({ ...slot, version: 2 }), JSON.stringify({ ...slot, extra: 1 }), ` ${JSON.stringify(slot)}`,
      JSON.stringify({ ...slot, ciphertext: encodeBase64(new Uint8Array(47)) }), JSON.stringify({ ...slot, iv: encodeBase64(decodeBase64(slot.iv).subarray(0, 8)) }),
    ]) expect(() => parseVaultDeviceSlot(invalid)).toThrow();
  });
});

describe("Touch ID through the repository", () => {
  it("enrolls, locks and unlocks with the device secret, zeroing what it handled", async () => {
    const { storage, repository, id } = await vaultWithFile();
    const chain = keychain();
    await repository.enrollDevice(passphrase, chain.keeper);
    expect(storage.value?.deviceSlot).toBeTypeOf("string");
    expect(repository.hasDeviceSlot).toBe(true);
    expect(chain.secrets.size).toBe(1);
    expect(chain.stored[0].every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(storage.value)).not.toContain(encodeBase64([...chain.secrets.values()][0]));
    repository.lock();
    const reopened = new VaultRepository(storage);
    await reopened.inspect();
    expect(reopened.hasDeviceSlot).toBe(true);
    await reopened.unlockWithDevice(chain.keeper);
    expect(reopened.unlocked).toBe(true);
    expect(chain.released[0].every((byte) => byte === 0)).toBe(true);
    expect((await reopened.read(id)).bytes).toEqual(body);
    // Edits keep the slot.
    await reopened.save(id, new TextEncoder().encode("API_TOKEN=rotated\n"), metadata);
    expect(storage.value?.deviceSlot).toBeTypeOf("string");
  });

  it("falls back cleanly when the keychain item is missing, declined or stale", async () => {
    const { storage, repository } = await vaultWithFile();
    const chain = keychain();
    await repository.enrollDevice(passphrase, chain.keeper);
    repository.lock();
    chain.refuse("cancelled");
    await expect(repository.unlockWithDevice(chain.keeper)).rejects.toMatchObject({ reason: "cancelled" });
    chain.refuse(null);
    const [vaultId, secret] = [...chain.secrets][0];
    chain.secrets.set(vaultId, crypto.getRandomValues(new Uint8Array(32)));
    await expect(repository.unlockWithDevice(chain.keeper)).rejects.toMatchObject({ reason: "stale" });
    chain.secrets.clear();
    await expect(repository.unlockWithDevice(chain.keeper)).rejects.toBeInstanceOf(VaultDeviceError);
    expect(repository.unlocked).toBe(false);
    secret.fill(0);
    await repository.unlock(passphrase);
    expect(repository.unlocked).toBe(true);
    expect(storage.value?.deviceSlot).toBeTypeOf("string");
  });

  it("turning Touch ID off deletes both the slot and the keychain secret", async () => {
    const { storage, repository } = await vaultWithFile();
    const chain = keychain();
    await repository.enrollDevice(passphrase, chain.keeper);
    await repository.removeDevice(chain.keeper);
    expect(chain.secrets.size).toBe(0);
    expect(storage.value && "deviceSlot" in storage.value).toBe(false);
    expect(repository.hasDeviceSlot).toBe(false);
    repository.lock();
    await expect(repository.unlockWithDevice(chain.keeper)).rejects.toMatchObject({ reason: "missing" });
  });

  it("leaves no keychain secret when the user cancels enrollment or the slot cannot be saved", async () => {
    const { storage, repository } = await vaultWithFile();
    const chain = keychain();
    chain.refuse("cancelled");
    await expect(repository.enrollDevice(passphrase, chain.keeper)).rejects.toMatchObject({ reason: "cancelled" });
    chain.refuse(null);
    storage.fail = new VaultStorageError("quota");
    await expect(repository.enrollDevice(passphrase, chain.keeper)).rejects.toMatchObject({ code: "quota" });
    expect(chain.secrets.size).toBe(0);
    expect(storage.value && "deviceSlot" in storage.value).toBe(false);
    await expect(repository.enrollDevice("the wrong strong passphrase", chain.keeper)).rejects.toMatchObject({ code: "authentication-failed" });
    expect(chain.keeper.store).toHaveBeenCalledTimes(2);
  });

  it("opens a vault saved before Touch ID existed (migration)", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    const id = createVaultDocumentId();
    const envelope = await vault.encryptDocument(id, body, metadata);
    vault.lock();
    // The exact shape every earlier build wrote: four keys, no device slot.
    const legacy = { version: 1, revision: 3, header, records: [{ id, envelope }] };
    expect(Object.keys(validateStoredVault(legacy))).toEqual(["version", "revision", "header", "records"]);
    const storage = new TestStorage();
    storage.value = legacy as StoredVault;
    const repository = new VaultRepository(storage);
    expect(await repository.inspect()).toBe(true);
    expect(repository.hasDeviceSlot).toBe(false);
    await expect(repository.unlockWithDevice(keychain().keeper)).rejects.toMatchObject({ reason: "missing" });
    await repository.unlock(passphrase);
    expect((await repository.read(id)).bytes).toEqual(body);
    // Ordinary writes keep the legacy shape; only enrolling adds the key.
    await repository.save(id, body, metadata);
    expect(Object.keys(storage.value!)).toEqual(["version", "revision", "header", "records"]);
    await repository.enrollDevice(passphrase, keychain().keeper);
    expect(Object.keys(storage.value!)).toEqual(["version", "revision", "header", "records", "deviceSlot"]);
  });

  it("rejects a stored slot for another vault or a malformed one", async () => {
    const { storage, repository } = await vaultWithFile();
    await repository.enrollDevice(passphrase, keychain().keeper);
    const other = await vaultWithFile();
    await other.repository.enrollDevice(passphrase, keychain().keeper);
    expect(() => validateStoredVault({ ...storage.value!, deviceSlot: other.storage.value!.deviceSlot })).toThrow(VaultStorageError);
    expect(() => validateStoredVault({ ...storage.value!, deviceSlot: 42 })).toThrow(VaultStorageError);
    expect(() => validateStoredVault({ ...storage.value!, deviceSlot: undefined })).toThrow(VaultStorageError);
  });
});
