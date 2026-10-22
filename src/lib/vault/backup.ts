import { VAULT_STORAGE_LIMITS, VaultStorageError, validateStoredVault, type StoredVault } from "./storage";

/**
 * One encrypted file holding the vault header and every record exactly as stored. It carries no
 * device slot, so it opens with the passphrase only, on any machine.
 */
export interface VaultBackup {
  readonly kind: "markie-vault-backup";
  readonly version: 1;
  readonly header: string;
  readonly records: StoredVault["records"];
}

export const VAULT_BACKUP_FILE_NAME = "Markie Vault.markievault";
export const VAULT_BACKUP_MEDIA_TYPE = "application/octet-stream";
/** JSON escaping roughly adds one character per quote; records hold a few dozen each. */
export const VAULT_BACKUP_MAX_CHARACTERS = VAULT_STORAGE_LIMITS.encryptedCharacters + 1024 * 1024;

export class VaultBackupError extends Error {
  constructor() {
    super("This is not a Markie vault backup.");
    this.name = "VaultBackupError";
  }
}

export function serializeVaultBackup(stored: StoredVault): string {
  const valid = validateStoredVault(stored);
  return JSON.stringify({ kind: "markie-vault-backup", version: 1, header: valid.header,
    records: valid.records.map((record) => ({ id: record.id, envelope: record.envelope })) });
}

/** Strict: exact keys, canonical encoding, and every header and record validated as storage would. */
export function parseVaultBackup(serialized: string): VaultBackup {
  try {
    if (typeof serialized !== "string" || serialized.length > VAULT_BACKUP_MAX_CHARACTERS) throw new Error();
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
    const keys = Object.keys(value);
    const record = value as Record<string, unknown>;
    if (keys.length !== 4 || !["kind", "version", "header", "records"].every((key) => Object.hasOwn(value, key)) ||
        record.kind !== "markie-vault-backup" || record.version !== 1) throw new Error();
    const stored = validateStoredVault({ version: 1, revision: 1, header: record.header, records: record.records });
    const backup: VaultBackup = Object.freeze({ kind: "markie-vault-backup", version: 1, header: stored.header, records: stored.records });
    if (serializeVaultBackup({ ...stored }) !== serialized) throw new Error();
    return backup;
  } catch (error) {
    if (error instanceof VaultStorageError && error.code !== "corrupt") throw error;
    throw new VaultBackupError();
  }
}

export function vaultBackupBytes(serialized: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(serialized);
}

export function vaultBackupText(bytes: Uint8Array): string {
  if (bytes.length > VAULT_BACKUP_MAX_CHARACTERS * 4) throw new VaultBackupError();
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new VaultBackupError(); }
}
