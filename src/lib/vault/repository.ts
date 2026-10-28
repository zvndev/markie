import { Vault, VaultError, VAULT_LIMITS, createVaultDocumentId, parseVaultDocument, parseVaultHeader, type DecryptedVaultDocument, type VaultDocumentMetadata } from "./index";
import { validateStoredVault, type StoredVault, type VaultStorage, VaultStorageError } from "./storage";
import { parseVaultBackup, serializeVaultBackup } from "./backup";

export interface VaultEntry {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly recovery: boolean;
}

export interface VaultReadResult extends DecryptedVaultDocument { readonly recovery: boolean }

/** Exposes only an opaque ID so a failed new-document retry does not duplicate recovery. */
export class VaultSaveError extends Error {
  constructor(readonly documentId: string, readonly failure: unknown) {
    super("The encrypted document could not be committed.");
    this.name = "VaultSaveError";
  }
}

export type VaultDeviceFailure = "missing" | "cancelled" | "unavailable" | "busy";

/** Where a device secret lives between unlocks: the OS keychain behind Touch ID, via the main process. */
export interface VaultDeviceKeeper {
  /** Resolves only after the user passed the biometric check. The repository zeroes the returned bytes. */
  release(vaultId: string): Promise<{ ok: true; secret: Uint8Array } | { ok: false; reason: VaultDeviceFailure }>;
  /** Must copy `secret`: the repository zeroes it as soon as this settles. */
  store(vaultId: string, secret: Uint8Array): Promise<{ ok: true } | { ok: false; reason: VaultDeviceFailure }>;
  remove(vaultId: string): Promise<void>;
}

/** `stale`: the keychain secret no longer opens this vault's device slot. */
export class VaultDeviceError extends Error {
  constructor(readonly reason: VaultDeviceFailure | "stale") {
    super(`Device unlock failed: ${reason}`);
    this.name = "VaultDeviceError";
  }
}

function withoutDeviceSlot(snapshot: StoredVault): StoredVault {
  return { version: snapshot.version, revision: snapshot.revision, header: snapshot.header, records: snapshot.records };
}

/** No plaintext cache, global index, ordinary library, telemetry or network calls. */
export class VaultRepository {
  #vault = new Vault();
  #snapshot: StoredVault | null = null;
  #epoch = 0;
  #controller = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #queuedWrites = 0;
  // Failed saves retain encrypted, memory-only recovery. Never clear this merely on lock.
  readonly #recovery = new Map<string, string>();

  constructor(readonly storage: VaultStorage) {}
  get unlocked(): boolean { return this.#vault.state === "unlocked"; }
  get hasVolatileRecovery(): boolean { return this.#recovery.size > 0; }
  /** Opaque ID of the stored vault, known after inspect() without unlocking. Not secret. */
  get vaultId(): string | null { return this.#snapshot ? parseVaultHeader(this.#snapshot.header).vaultId : null; }
  /** Whether the stored vault has a device slot. The keychain half is checked separately. */
  get hasDeviceSlot(): boolean { return typeof this.#snapshot?.deviceSlot === "string"; }

  lock(): void {
    this.#epoch++;
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#vault.lock();
  }

  #check(epoch: number): void {
    if (epoch !== this.#epoch) throw new VaultError("locked");
  }

  #run<T>(work: (epoch: number, signal: AbortSignal) => Promise<T>): Promise<T> {
    const epoch = this.#epoch;
    const signal = this.#controller.signal;
    const running = this.#queue.catch(() => {}).then(async () => {
      this.#check(epoch);
      return work(epoch, signal);
    });
    this.#queue = running.catch(() => {});
    return running;
  }

  #unlocked(): StoredVault {
    if (!this.unlocked || !this.#snapshot) throw new VaultError("locked");
    return this.#snapshot;
  }

  inspect(): Promise<boolean> {
    return this.#run(async (epoch, signal) => {
      const snapshot = await this.storage.load(signal);
      this.#check(epoch);
      this.#snapshot = snapshot ? validateStoredVault(snapshot) : null;
      return snapshot !== null;
    });
  }

  create(passphrase: string): Promise<void> {
    return this.#run(async (epoch, signal) => {
      if (this.unlocked) throw new VaultError("busy");
      if (await this.storage.load(signal)) throw new VaultStorageError("conflict");
      this.#check(epoch);
      try {
        const header = await this.#vault.create(passphrase);
        this.#check(epoch);
        const next: StoredVault = { version: 1, revision: 1, header, records: [] };
        await this.storage.commit(null, next, signal);
        this.#check(epoch);
        this.#snapshot = validateStoredVault(next);
      } catch (error) { this.#vault.lock(); throw error; }
    });
  }

  unlock(passphrase: string): Promise<void> {
    return this.#run(async (epoch, signal) => {
      if (this.unlocked) throw new VaultError("busy");
      const snapshot = await this.storage.load(signal);
      this.#check(epoch);
      if (!snapshot) throw new VaultStorageError("unavailable");
      const validated = validateStoredVault(snapshot);
      await this.#vault.unlock(validated.header, passphrase);
      this.#check(epoch);
      this.#adoptSnapshot(validated);
    });
  }

  /** Touch ID path. A missing, declined or stale keychain secret leaves the vault locked. */
  unlockWithDevice(keeper: VaultDeviceKeeper): Promise<void> {
    return this.#run(async (epoch, signal) => {
      if (this.unlocked) throw new VaultError("busy");
      const snapshot = await this.storage.load(signal);
      this.#check(epoch);
      if (!snapshot) throw new VaultStorageError("unavailable");
      const validated = validateStoredVault(snapshot);
      this.#snapshot = validated;
      if (!validated.deviceSlot) throw new VaultDeviceError("missing");
      const vaultId = parseVaultHeader(validated.header).vaultId;
      const released = await keeper.release(vaultId);
      if (!released.ok) throw new VaultDeviceError(released.reason);
      try {
        this.#check(epoch);
        await this.#vault.unlockWithDeviceSecret(validated.header, validated.deviceSlot, released.secret);
      } catch (error) {
        if (error instanceof VaultError && error.code === "authentication-failed") throw new VaultDeviceError("stale");
        throw error;
      } finally { released.secret.fill(0); }
      this.#check(epoch);
      this.#adoptSnapshot(validated);
    });
  }

  /** Turns on Touch ID. Needs the passphrase again; the vault must already be unlocked. */
  enrollDevice(passphrase: string, keeper: VaultDeviceKeeper): Promise<void> {
    return this.#run(async (epoch, signal) => {
      const snapshot = this.#unlocked();
      const vaultId = parseVaultHeader(snapshot.header).vaultId;
      const { slot, secret } = await this.#vault.enrollDevice(snapshot.header, passphrase);
      try {
        this.#check(epoch);
        const stored = await keeper.store(vaultId, secret);
        if (!stored.ok) throw new VaultDeviceError(stored.reason);
      } finally { secret.fill(0); }
      try {
        this.#check(epoch);
        await this.#commit({ ...withoutDeviceSlot(this.#unlocked()), revision: this.#unlocked().revision + 1, deviceSlot: slot }, epoch, signal);
      } catch (error) {
        // A keychain secret with no slot opens nothing, but do not leave it behind.
        await keeper.remove(vaultId).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Rejects with authentication-failed unless this is the unlocked vault's passphrase. Changes nothing. */
  verifyPassphrase(passphrase: string): Promise<void> {
    return this.#run(async (epoch) => {
      const snapshot = this.#unlocked();
      await this.#vault.verifyPassphrase(snapshot.header, passphrase);
      this.#check(epoch);
    });
  }

  /** Turns off Touch ID: deletes the keychain secret and the stored device slot. */
  removeDevice(keeper: VaultDeviceKeeper): Promise<void> {
    return this.#run(async (epoch, signal) => {
      const snapshot = this.#unlocked();
      let failure: unknown;
      try { await keeper.remove(parseVaultHeader(snapshot.header).vaultId); }
      catch (error) { failure = error; }
      this.#check(epoch);
      if (snapshot.deviceSlot) await this.#commit({ ...withoutDeviceSlot(snapshot), revision: snapshot.revision + 1 }, epoch, signal);
      if (failure) throw failure;
    });
  }

  /** The stored ciphertext as one backup file. Never includes the device slot or memory-only recovery. */
  backup(): Promise<string> {
    return this.#run(async (epoch, signal) => {
      const current = this.#unlocked();
      const stored = await this.storage.load(signal);
      this.#check(epoch);
      if (!stored || stored.header !== current.header) throw new VaultStorageError("conflict");
      return serializeVaultBackup(withoutDeviceSlot(validateStoredVault(stored)));
    });
  }

  /**
   * Replaces local storage with a backup, but only after its passphrase unlocks it and every
   * record authenticates. An existing vault is kept unless `replace` is set. Leaves the restored
   * vault unlocked. Returns the replaced vault's ID so its keychain secret can be deleted.
   */
  restore(serializedBackup: string, passphrase: string, { replace = false }: { replace?: boolean } = {}): Promise<{ replacedVaultId: string | null }> {
    let backup: ReturnType<typeof parseVaultBackup>;
    try { backup = parseVaultBackup(serializedBackup); }
    catch (error) { return Promise.reject(error); }
    return this.#run(async (epoch, signal) => {
      const current = await this.storage.load(signal);
      this.#check(epoch);
      if (current && !replace) throw new VaultStorageError("conflict");
      const candidate = new Vault();
      let adopted = false;
      try {
        await candidate.unlock(backup.header, passphrase);
        this.#check(epoch);
        for (const record of backup.records) {
          (await candidate.decryptDocument(record.envelope, record.id)).bytes.fill(0);
          this.#check(epoch);
        }
        const next = validateStoredVault({ version: 1, revision: (current?.revision ?? 0) + 1, header: backup.header, records: backup.records });
        await this.storage.commit(current?.revision ?? null, next, signal, { replaceHeader: true });
        this.#check(epoch);
        this.#vault.lock();
        this.#vault = candidate;
        adopted = true;
        this.#adoptSnapshot(next);
        return { replacedVaultId: current ? parseVaultHeader(current.header).vaultId : null };
      } finally { if (!adopted) candidate.lock(); }
    });
  }

  #adoptSnapshot(validated: StoredVault): void {
    this.#snapshot = validated;
    // An externally replaced vault must never receive another vault's draft.
    const vaultId = parseVaultHeader(validated.header).vaultId;
    for (const [id, envelope] of this.#recovery) {
      if (parseVaultDocument(envelope).vaultId !== vaultId) this.#recovery.delete(id);
    }
  }

  async #commit(next: StoredVault, epoch: number, signal: AbortSignal): Promise<void> {
    const validated = validateStoredVault(next);
    const previous = this.#unlocked();
    this.#check(epoch);
    await this.storage.commit(previous.revision, validated, signal);
    this.#check(epoch);
    this.#snapshot = validated;
  }

  save(id: string | null, bytes: Uint8Array, metadata: VaultDocumentMetadata): Promise<string> {
    if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== "[object Uint8Array]" || bytes.length > VAULT_LIMITS.contentBytes) {
      return Promise.reject(new VaultError("limit-exceeded"));
    }
    if (this.#queuedWrites >= VAULT_LIMITS.concurrentDocumentOperations) return Promise.reject(new VaultError("busy"));
    this.#queuedWrites++;
    // Snapshot inputs at invocation, not later when a preceding write leaves the queue.
    const copy = new Uint8Array(bytes);
    const privateMetadata = { ...metadata };
    const signal = this.#controller.signal;
    const erase = () => copy.fill(0);
    signal.addEventListener("abort", erase, { once: true });
    return this.#run(async (epoch, operationSignal) => {
      const snapshot = this.#unlocked();
      const documentId = id ?? createVaultDocumentId();
      if (id && !snapshot.records.some((record) => record.id === id) && !this.#recovery.has(id)) throw new VaultStorageError("conflict");
      const envelope = await this.#vault.encryptDocument(documentId, copy, privateMetadata);
      this.#check(epoch);
      const merged = new Map(snapshot.records.map((record) => [record.id, record.envelope]));
      for (const [recoveryId, recoveryEnvelope] of this.#recovery) merged.set(recoveryId, recoveryEnvelope);
      merged.set(documentId, envelope);
      const next = validateStoredVault({ ...snapshot, revision: snapshot.revision + 1,
        records: Array.from(merged, ([recordId, recordEnvelope]) => ({ id: recordId, envelope: recordEnvelope })) });
      this.#recovery.set(documentId, envelope);
      try { await this.#commit(next, epoch, operationSignal); }
      catch (failure) { throw new VaultSaveError(documentId, failure); }
      this.#recovery.clear();
      return documentId;
    }).finally(() => { signal.removeEventListener("abort", erase); erase(); this.#queuedWrites--; });
  }

  read(id: string): Promise<VaultReadResult> {
    return this.#run(async (epoch) => {
      const snapshot = this.#unlocked();
      const recovery = this.#recovery.get(id);
      const envelope = recovery ?? snapshot.records.find((record) => record.id === id)?.envelope;
      if (!envelope) throw new VaultStorageError("conflict");
      const document = await this.#vault.decryptDocument(envelope, id);
      try { this.#check(epoch); }
      catch (error) { document.bytes.fill(0); throw error; }
      return { ...document, recovery: recovery !== undefined };
    });
  }

  list(query = ""): Promise<VaultEntry[]> {
    return this.#run(async (epoch) => {
      const snapshot = this.#unlocked();
      const entries: VaultEntry[] = [];
      const records = new Map(snapshot.records.map((record) => [record.id, record.envelope]));
      for (const [id, envelope] of this.#recovery) records.set(id, envelope);
      for (const [id, envelope] of records) {
        const document = await this.#vault.decryptDocument(envelope, id);
        try {
          this.#check(epoch);
          if (document.metadata.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) entries.push({
            id, name: document.metadata.name, mediaType: document.metadata.mediaType, bytes: document.bytes.length,
            recovery: this.#recovery.has(id),
          });
        } finally { document.bytes.fill(0); }
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  remove(id: string): Promise<void> {
    return this.#run(async (epoch, signal) => {
      const snapshot = this.#unlocked();
      if (!snapshot.records.some((record) => record.id === id) && !this.#recovery.has(id)) throw new VaultStorageError("conflict");
      await this.#commit({ ...snapshot, revision: snapshot.revision + 1, records: snapshot.records.filter((record) => record.id !== id) }, epoch, signal);
      this.#recovery.delete(id);
    });
  }

  discardRecovery(id: string): void {
    this.#unlocked();
    this.#recovery.delete(id);
  }
}
