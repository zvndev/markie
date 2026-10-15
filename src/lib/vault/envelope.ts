/** Experimental, local-only vault format. Not connected to Markie's document storage. */
export const VAULT_LIMITS = Object.freeze({
  contentBytes: 8 * 1024 * 1024,
  metadataBytes: 4096,
  headerCharacters: 4096,
  documentCharacters: 12 * 1024 * 1024,
  passphraseBytes: 1024,
  minimumPassphraseCodePoints: 16,
  kdfIterations: 600_000,
  maximumKdfIterations: 1_000_000,
  concurrentDocumentOperations: 4,
});

export type VaultErrorCode = "invalid-envelope" | "limit-exceeded" | "invalid-passphrase" | "authentication-failed" | "locked" | "busy" | "unavailable";

export class VaultError extends Error {
  constructor(public readonly code: VaultErrorCode) {
    super(`Vault operation failed: ${code}`);
    this.name = "VaultError";
  }
}

export interface VaultHeader {
  readonly kind: "markie-vault";
  readonly version: 1;
  readonly vaultId: string;
  readonly kdf: {
    readonly name: "PBKDF2";
    readonly hash: "SHA-256";
    readonly iterations: number;
    readonly salt: string;
  };
  readonly wrap: {
    readonly name: "AES-GCM";
    readonly iv: string;
    readonly ciphertext: string;
  };
}

export interface VaultDocumentEnvelope {
  readonly kind: "markie-vault-document";
  readonly version: 1;
  readonly vaultId: string;
  readonly documentId: string;
  readonly cipher: "AES-GCM";
  readonly keyWrap: "AES-KW";
  readonly wrappedKey: string;
  readonly iv: string;
  readonly ciphertext: string;
}

export interface VaultDocumentMetadata {
  readonly name: string;
  readonly mediaType: string;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new VaultError("invalid-envelope");
  if (value.length > Math.ceil(maximum * 4 / 3)) throw new VaultError("limit-exceeded");
  const remainder = value.length % 4;
  const last = alphabet.indexOf(value.at(-1) ?? "");
  const bytes = Math.floor(value.length * 3 / 4);
  if (!/^[A-Za-z0-9_-]+$/.test(value) || remainder === 1 || bytes < minimum || bytes > maximum ||
      (remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0)) {
    throw new VaultError("invalid-envelope");
  }
  return value;
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  // Only call after the format-specific length and canonical-encoding validation.
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function validateVaultId(value: unknown): string {
  return base64(value, 16, 16);
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new VaultError("invalid-envelope");
  }
  return value as Record<string, unknown>;
}

function json(serialized: string, maximum: number): unknown {
  if (typeof serialized !== "string") throw new VaultError("invalid-envelope");
  if (serialized.length > maximum) throw new VaultError("limit-exceeded");
  try { return JSON.parse(serialized); } catch { throw new VaultError("invalid-envelope"); }
}

export function serializeVaultHeader(header: VaultHeader): string {
  return JSON.stringify({ kind: header.kind, version: header.version, vaultId: header.vaultId,
    kdf: { name: header.kdf.name, hash: header.kdf.hash, iterations: header.kdf.iterations, salt: header.kdf.salt },
    wrap: { name: header.wrap.name, iv: header.wrap.iv, ciphertext: header.wrap.ciphertext } });
}

export function parseVaultHeader(serialized: string): VaultHeader {
  const value = object(json(serialized, VAULT_LIMITS.headerCharacters), ["kind", "version", "vaultId", "kdf", "wrap"]);
  const kdf = object(value.kdf, ["name", "hash", "iterations", "salt"]);
  const wrap = object(value.wrap, ["name", "iv", "ciphertext"]);
  if (value.kind !== "markie-vault" || value.version !== 1 || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || wrap.name !== "AES-GCM" ||
      !Number.isSafeInteger(kdf.iterations) || (kdf.iterations as number) < VAULT_LIMITS.kdfIterations ||
      (kdf.iterations as number) > VAULT_LIMITS.maximumKdfIterations) throw new VaultError("invalid-envelope");
  const header: VaultHeader = Object.freeze({ kind: "markie-vault", version: 1, vaultId: validateVaultId(value.vaultId),
    kdf: Object.freeze({ name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations as number, salt: base64(kdf.salt, 16, 16) }),
    wrap: Object.freeze({ name: "AES-GCM", iv: base64(wrap.iv, 12, 12), ciphertext: base64(wrap.ciphertext, 48, 48) }) });
  // One wire encoding rejects duplicate keys, alternative key order, trailing data and ambiguous JSON.
  if (serializeVaultHeader(header) !== serialized) throw new VaultError("invalid-envelope");
  return header;
}

export function serializeVaultDocument(envelope: VaultDocumentEnvelope): string {
  return JSON.stringify({ kind: envelope.kind, version: envelope.version, vaultId: envelope.vaultId,
    documentId: envelope.documentId, cipher: envelope.cipher, keyWrap: envelope.keyWrap,
    wrappedKey: envelope.wrappedKey, iv: envelope.iv, ciphertext: envelope.ciphertext });
}

export function parseVaultDocument(serialized: string): VaultDocumentEnvelope {
  const value = object(json(serialized, VAULT_LIMITS.documentCharacters),
    ["kind", "version", "vaultId", "documentId", "cipher", "keyWrap", "wrappedKey", "iv", "ciphertext"]);
  if (value.kind !== "markie-vault-document" || value.version !== 1 || value.cipher !== "AES-GCM" || value.keyWrap !== "AES-KW") {
    throw new VaultError("invalid-envelope");
  }
  const envelope: VaultDocumentEnvelope = Object.freeze({ kind: "markie-vault-document", version: 1,
    vaultId: validateVaultId(value.vaultId), documentId: validateVaultId(value.documentId), cipher: "AES-GCM", keyWrap: "AES-KW",
    wrappedKey: base64(value.wrappedKey, 40, 40), iv: base64(value.iv, 12, 12),
    ciphertext: base64(value.ciphertext, 20, VAULT_LIMITS.contentBytes + VAULT_LIMITS.metadataBytes + 20) });
  if (serializeVaultDocument(envelope) !== serialized) throw new VaultError("invalid-envelope");
  return envelope;
}

export function metadataBytes(metadata: VaultDocumentMetadata): Uint8Array<ArrayBuffer> {
  const value = object(metadata, ["name", "mediaType"]);
  if (typeof value.name !== "string" || value.name.length > 1024 || typeof value.mediaType !== "string" || value.mediaType.length > 255 ||
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value.mediaType)) {
    throw new VaultError("invalid-envelope");
  }
  const encoded = new TextEncoder().encode(JSON.stringify({ name: value.name, mediaType: value.mediaType }));
  if (encoded.length > VAULT_LIMITS.metadataBytes) throw new VaultError("limit-exceeded");
  return encoded;
}

export function parseMetadata(bytes: Uint8Array): VaultDocumentMetadata {
  if (bytes.length > VAULT_LIMITS.metadataBytes) throw new VaultError("limit-exceeded");
  let value: VaultDocumentMetadata;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new VaultError("invalid-envelope"); }
  const canonical = metadataBytes(value);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    throw new VaultError("invalid-envelope");
  }
  return Object.freeze({ name: value.name, mediaType: value.mediaType });
}

export function headerContext(header: VaultHeader): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([header.kind, header.version, header.vaultId,
    header.kdf.name, header.kdf.hash, header.kdf.iterations, header.kdf.salt, header.wrap.name, header.wrap.iv]));
}

export function documentContext(envelope: VaultDocumentEnvelope): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([envelope.kind, envelope.version, envelope.vaultId,
    envelope.documentId, envelope.cipher, envelope.keyWrap, envelope.wrappedKey, envelope.iv]));
}
