import { parseVaultDeviceSlot, parseVaultDocument, parseVaultHeader } from "./index";

export const VAULT_DATABASE_NAME = "markie-encrypted-vault";
export const VAULT_STORAGE_LIMITS = Object.freeze({ records: 128, encryptedCharacters: 32 * 1024 * 1024 });

/**
 * Only ciphertext and non-secret, opaque IDs/revisions cross this boundary.
 * `deviceSlot` is optional and absent from vaults written before Touch ID, so those still load;
 * the key is written only while a slot exists.
 */
export interface StoredVault {
  readonly version: 1;
  readonly revision: number;
  readonly header: string;
  readonly records: ReadonlyArray<Readonly<{ id: string; envelope: string }>>;
  readonly deviceSlot?: string;
}

export interface VaultCommitOptions {
  /** Restoring a backup is the only write allowed to swap the header (and so the vault). */
  readonly replaceHeader?: boolean;
}

export type VaultStorageErrorCode = "unavailable" | "corrupt" | "conflict" | "quota" | "aborted" | "storage-failed";
export class VaultStorageError extends Error {
  constructor(readonly code: VaultStorageErrorCode) {
    super(`Vault storage: ${code}`);
    this.name = "VaultStorageError";
  }
}

export interface VaultStorage {
  load(signal?: AbortSignal): Promise<StoredVault | null>;
  /** Resolve only after atomic commit. A mismatch or abort must change nothing. */
  commit(expectedRevision: number | null, next: StoredVault, signal?: AbortSignal, options?: VaultCommitOptions): Promise<void>;
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Strict validation rejects accidental plaintext fields before any persistence. */
export function validateStoredVault(value: unknown): StoredVault {
  try {
    const withSlot = !!value && typeof value === "object" && Object.hasOwn(value, "deviceSlot");
    if (!exactObject(value, withSlot ? ["version", "revision", "header", "records", "deviceSlot"] : ["version", "revision", "header", "records"]) || value.version !== 1 ||
        !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !Array.isArray(value.records) ||
        value.records.length > VAULT_STORAGE_LIMITS.records || typeof value.header !== "string") throw new Error();
    const header = parseVaultHeader(value.header);
    const ids = new Set<string>();
    let size = value.header.length;
    const records = value.records.map((record: unknown) => {
      if (!exactObject(record, ["id", "envelope"]) || typeof record.id !== "string" || typeof record.envelope !== "string") throw new Error();
      size += record.envelope.length;
      if (size > VAULT_STORAGE_LIMITS.encryptedCharacters) throw new Error();
      const envelope = parseVaultDocument(record.envelope);
      if (envelope.vaultId !== header.vaultId || envelope.documentId !== record.id || ids.has(record.id)) throw new Error();
      ids.add(record.id);
      return Object.freeze({ id: record.id, envelope: record.envelope });
    });
    const stored = { version: 1 as const, revision: value.revision as number, header: value.header, records: Object.freeze(records) };
    if (!withSlot) return Object.freeze(stored);
    if (typeof value.deviceSlot !== "string" || parseVaultDeviceSlot(value.deviceSlot).vaultId !== header.vaultId) throw new Error();
    return Object.freeze({ ...stored, deviceSlot: value.deviceSlot });
  } catch { throw new VaultStorageError("corrupt"); }
}

function storageFailure(error: unknown): VaultStorageError {
  if (error instanceof VaultStorageError) return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError") return new VaultStorageError("quota");
  if (error instanceof DOMException && error.name === "AbortError") return new VaultStorageError("aborted");
  return new VaultStorageError("storage-failed");
}

/** Separate origin-local database. There is no localStorage or memory fallback. */
export class IndexedDbVaultStorage implements VaultStorage {
  constructor(private readonly factory?: IDBFactory) {}

  #open(signal?: AbortSignal): Promise<IDBDatabase> {
    if (signal?.aborted) return Promise.reject(new VaultStorageError("aborted"));
    const factory = this.factory ?? globalThis.indexedDB;
    if (!factory) return Promise.reject(new VaultStorageError("unavailable"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = factory.open(VAULT_DATABASE_NAME, 1);
      const abort = () => { settled = true; reject(new VaultStorageError("aborted")); };
      const finish = (error?: unknown) => {
        signal?.removeEventListener("abort", abort);
        if (settled) { if (!error) request.result.close(); return; }
        settled = true;
        if (error) reject(storageFailure(error));
        else resolve(request.result);
      };
      signal?.addEventListener("abort", abort, { once: true });
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("vault")) request.result.createObjectStore("vault");
      };
      request.onerror = () => finish(request.error);
      request.onblocked = () => finish(new VaultStorageError("unavailable"));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        finish();
      };
    });
  }

  async load(signal?: AbortSignal): Promise<StoredVault | null> {
    const database = await this.#open(signal);
    return new Promise((resolve, reject) => {
      let failure: unknown;
      let result: StoredVault | null = null;
      const transaction = database.transaction("vault", "readonly");
      const abort = () => { try { transaction.abort(); } catch { /* Already completed. */ } };
      const cleanup = () => { signal?.removeEventListener("abort", abort); database.close(); };
      transaction.oncomplete = () => {
        cleanup();
        if (signal?.aborted) reject(new VaultStorageError("aborted"));
        else resolve(result);
      };
      transaction.onabort = () => { cleanup(); reject(storageFailure(failure ?? transaction.error ?? new VaultStorageError("aborted"))); };
      transaction.onerror = () => { failure = transaction.error; };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const request = transaction.objectStore("vault").get("snapshot");
      request.onsuccess = () => {
        try { result = request.result === undefined ? null : validateStoredVault(request.result); }
        catch (error) { failure = error; abort(); }
      };
    });
  }

  async commit(expectedRevision: number | null, next: StoredVault, signal?: AbortSignal, options: VaultCommitOptions = {}): Promise<void> {
    const snapshot = validateStoredVault(next);
    if ((expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) ||
        snapshot.revision !== (expectedRevision ?? 0) + 1) throw new VaultStorageError("conflict");
    const database = await this.#open(signal);
    return new Promise((resolve, reject) => {
      let failure: unknown;
      const transaction = database.transaction("vault", "readwrite", { durability: "strict" });
      const abort = () => { try { transaction.abort(); } catch { /* The commit may already have completed. */ } };
      const cleanup = () => { signal?.removeEventListener("abort", abort); database.close(); };
      transaction.oncomplete = () => { cleanup(); resolve(); };
      transaction.onabort = () => { cleanup(); reject(storageFailure(failure ?? transaction.error ?? new VaultStorageError("aborted"))); };
      transaction.onerror = () => { failure = transaction.error; };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const store = transaction.objectStore("vault");
      const current = store.get("snapshot");
      current.onsuccess = () => {
        try {
          const previous = current.result === undefined ? null : validateStoredVault(current.result);
          if ((previous?.revision ?? null) !== expectedRevision || (previous && previous.header !== snapshot.header && !options.replaceHeader)) {
            throw new VaultStorageError("conflict");
          }
          // The header and every encrypted record are one transactionally replaced value.
          store.put(snapshot, "snapshot");
        } catch (error) { failure = error; abort(); }
      };
    });
  }
}

/**
 * Asks the browser not to evict the vault database under storage pressure. Resolves to whether
 * storage is persistent, or null when the browser cannot say.
 */
export async function requestPersistentStorage(manager: Pick<StorageManager, "persist" | "persisted"> | undefined = globalThis.navigator?.storage): Promise<boolean | null> {
  if (!manager?.persist) return null;
  try {
    if (await manager.persisted?.()) return true;
    return await manager.persist();
  } catch { return null; }
}
