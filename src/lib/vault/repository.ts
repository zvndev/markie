import { Vault, VaultError, VAULT_LIMITS, createVaultDocumentId, parseVaultDocument, parseVaultHeader, type DecryptedVaultDocument, type VaultDocumentMetadata } from "./index";
import { validateStoredVault, type StoredVault, type VaultStorage, VaultStorageError } from "./storage";

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

/** No plaintext cache, global index, ordinary library, telemetry or network calls. */
export class VaultRepository {
  readonly #vault = new Vault();
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
      this.#snapshot = validated;
      // An externally replaced vault must never receive another vault's draft.
      const vaultId = parseVaultHeader(validated.header).vaultId;
      for (const [id, envelope] of this.#recovery) {
        if (parseVaultDocument(envelope).vaultId !== vaultId) this.#recovery.delete(id);
      }
    });
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
