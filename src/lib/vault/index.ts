import {
  VAULT_LIMITS, VaultError, decodeBase64, deviceSlotContext, documentContext, encodeBase64, headerContext,
  metadataBytes, parseMetadata, parseVaultDeviceSlot, parseVaultDocument, parseVaultHeader,
  serializeVaultDeviceSlot, serializeVaultDocument, serializeVaultHeader, validateVaultId,
  type VaultDeviceSlot, type VaultDocumentEnvelope, type VaultDocumentMetadata, type VaultHeader,
} from "./envelope";

export {
  VAULT_DEVICE_SLOT_VERSION, VAULT_LIMITS, VaultError, parseVaultDeviceSlot, parseVaultDocument, parseVaultHeader,
  serializeVaultDeviceSlot, serializeVaultDocument, serializeVaultHeader,
} from "./envelope";
export type { VaultDeviceSlot, VaultDocumentEnvelope, VaultDocumentMetadata, VaultErrorCode, VaultHeader } from "./envelope";

/** Length of the device secret the OS keychain holds for a device slot. */
export const VAULT_DEVICE_SECRET_BYTES = 32;

function provider(): Crypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle || !crypto.getRandomValues) throw new VaultError("unavailable");
  return crypto;
}

function random(bytes: number): Uint8Array<ArrayBuffer> {
  return provider().getRandomValues(new Uint8Array(bytes));
}

/** Opaque ID only: do not put a filename, title or path in public envelope fields. */
export function createVaultDocumentId(): string {
  return encodeBase64(random(16));
}

function passphraseBytes(passphrase: string): Uint8Array<ArrayBuffer> {
  if (typeof passphrase !== "string" || passphrase.length > VAULT_LIMITS.passphraseBytes ||
      Array.from(passphrase).length < VAULT_LIMITS.minimumPassphraseCodePoints ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(passphrase)) {
    throw new VaultError("invalid-passphrase");
  }
  const bytes = new TextEncoder().encode(passphrase);
  if (bytes.length > VAULT_LIMITS.passphraseBytes) {
    bytes.fill(0);
    throw new VaultError("invalid-passphrase");
  }
  return bytes;
}

async function wrappingKey(passphrase: string, header: VaultHeader): Promise<CryptoKey> {
  const bytes = passphraseBytes(passphrase);
  try {
    const key = await provider().subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey"]);
    return await provider().subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256",
      salt: decodeBase64(header.kdf.salt), iterations: header.kdf.iterations }, key,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { bytes.fill(0); }
}

/** The caller owns `secret`: hand it to the keychain, then zero it. */
export interface VaultDeviceEnrollment {
  readonly slot: string;
  readonly secret: Uint8Array<ArrayBuffer>;
}

export interface DecryptedVaultDocument {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly metadata: VaultDocumentMetadata;
}

/**
 * A single owner for unlocked keys. No persistence, UI, network, logging or plaintext cache.
 * lock() invalidates pending results; it cannot erase plaintext already returned to callers.
 */
export class Vault {
  #key: CryptoKey | undefined;
  #vaultId: string | undefined;
  #epoch = 0;
  #pendingUnlock = false;
  #pendingEnrollment = false;
  #documentOperations = 0;
  #state: "locked" | "unlocking" | "unlocked" = "locked";

  get state(): "locked" | "unlocking" | "unlocked" { return this.#state; }
  get vaultId(): string | undefined { return this.#vaultId; }

  lock(): void {
    this.#epoch++;
    this.#key = undefined;
    this.#vaultId = undefined;
    this.#state = "locked";
  }

  #assertEpoch(epoch: number): void {
    if (epoch !== this.#epoch) throw new VaultError("locked");
  }

  #beginUnlock(): number {
    if (this.#pendingUnlock) throw new VaultError("busy");
    if (this.#key) throw new VaultError("busy");
    this.#pendingUnlock = true;
    this.#state = "unlocking";
    return this.#epoch;
  }

  #finishUnlock(): void {
    this.#pendingUnlock = false;
    if (!this.#key) this.#state = "locked";
  }

  /** Returns the complete key-wrapping header. Persist it alongside encrypted records. */
  async create(passphrase: string): Promise<string> {
    // Validate before marking a request pending or starting any asynchronous work.
    const check = passphraseBytes(passphrase);
    check.fill(0);
    const epoch = this.#beginUnlock();
    let rawKey: Uint8Array<ArrayBuffer> | undefined;
    try {
      rawKey = random(32);
      const header: VaultHeader = { kind: "markie-vault", version: 1, vaultId: createVaultDocumentId(),
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: VAULT_LIMITS.kdfIterations, salt: encodeBase64(random(16)) },
        wrap: { name: "AES-GCM", iv: encodeBase64(random(12)), ciphertext: "" } };
      const wrapper = await wrappingKey(passphrase, header);
      this.#assertEpoch(epoch);
      const ciphertext = await provider().subtle.encrypt({ name: "AES-GCM", iv: decodeBase64(header.wrap.iv),
        additionalData: headerContext(header), tagLength: 128 }, wrapper, rawKey);
      this.#assertEpoch(epoch);
      const key = await provider().subtle.importKey("raw", rawKey, "AES-KW", false, ["wrapKey", "unwrapKey"]);
      this.#assertEpoch(epoch);
      const serialized = serializeVaultHeader({ ...header, wrap: { ...header.wrap, ciphertext: encodeBase64(new Uint8Array(ciphertext)) } });
      this.#key = key;
      this.#vaultId = header.vaultId;
      this.#state = "unlocked";
      return serialized;
    } finally {
      rawKey?.fill(0);
      this.#finishUnlock();
    }
  }

  /** Decrypts the raw vault key with the passphrase. The caller must zero the result. */
  async #passphraseKey(header: VaultHeader, passphrase: string, epoch: number): Promise<Uint8Array<ArrayBuffer>> {
    const wrapper = await wrappingKey(passphrase, header);
    this.#assertEpoch(epoch);
    let rawKey: Uint8Array<ArrayBuffer>;
    try {
      rawKey = new Uint8Array(await provider().subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(header.wrap.iv),
        additionalData: headerContext(header), tagLength: 128 }, wrapper, decodeBase64(header.wrap.ciphertext)));
    } catch { throw new VaultError("authentication-failed"); }
    try { this.#assertEpoch(epoch); }
    catch (error) { rawKey.fill(0); throw error; }
    return rawKey;
  }

  async #adoptRawKey(rawKey: Uint8Array<ArrayBuffer>, vaultId: string, epoch: number): Promise<void> {
    const key = await provider().subtle.importKey("raw", rawKey, "AES-KW", false, ["wrapKey", "unwrapKey"]);
    this.#assertEpoch(epoch);
    this.#key = key;
    this.#vaultId = vaultId;
    this.#state = "unlocked";
  }

  async unlock(serializedHeader: string, passphrase: string): Promise<void> {
    const header = parseVaultHeader(serializedHeader);
    const epoch = this.#beginUnlock();
    let rawKey: Uint8Array<ArrayBuffer> | undefined;
    try {
      rawKey = await this.#passphraseKey(header, passphrase, epoch);
      await this.#adoptRawKey(rawKey, header.vaultId, epoch);
    } finally {
      rawKey?.fill(0);
      this.#finishUnlock();
    }
  }

  /**
   * Checks the passphrase against the header while unlocked, without changing
   * the held key. The decrypted raw key is zeroed at once.
   */
  async verifyPassphrase(serializedHeader: string, passphrase: string): Promise<void> {
    const header = parseVaultHeader(serializedHeader);
    if (!this.#key || header.vaultId !== this.#vaultId) throw new VaultError("locked");
    (await this.#passphraseKey(header, passphrase, this.#epoch)).fill(0);
  }

  /**
   * Unlocks through the device slot. Takes ownership of `secret`: it is copied and the
   * caller's buffer is zeroed before any asynchronous work, whatever the outcome.
   */
  async unlockWithDeviceSecret(serializedHeader: string, serializedSlot: string, secret: Uint8Array): Promise<void> {
    let ownSecret: Uint8Array<ArrayBuffer> | undefined;
    let header: VaultHeader;
    let slot: VaultDeviceSlot;
    try {
      if (!(secret instanceof Uint8Array)) throw new VaultError("authentication-failed");
      ownSecret = new Uint8Array(secret);
      header = parseVaultHeader(serializedHeader);
      slot = parseVaultDeviceSlot(serializedSlot);
      if (slot.vaultId !== header.vaultId || ownSecret.length !== VAULT_DEVICE_SECRET_BYTES) throw new VaultError("authentication-failed");
    } catch (error) {
      ownSecret?.fill(0);
      throw error;
    } finally {
      if (secret instanceof Uint8Array) secret.fill(0);
    }
    let epoch: number;
    try { epoch = this.#beginUnlock(); }
    catch (error) { ownSecret.fill(0); throw error; }
    let rawKey: Uint8Array<ArrayBuffer> | undefined;
    try {
      let deviceKey: CryptoKey;
      try { deviceKey = await provider().subtle.importKey("raw", ownSecret, "AES-GCM", false, ["decrypt"]); }
      finally { ownSecret.fill(0); }
      this.#assertEpoch(epoch);
      try {
        rawKey = new Uint8Array(await provider().subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(slot.iv),
          additionalData: deviceSlotContext(slot), tagLength: 128 }, deviceKey, decodeBase64(slot.ciphertext)));
      } catch { throw new VaultError("authentication-failed"); }
      this.#assertEpoch(epoch);
      await this.#adoptRawKey(rawKey, header.vaultId, epoch);
    } finally {
      rawKey?.fill(0);
      this.#finishUnlock();
    }
  }

  /**
   * Creates a device slot for the vault that is unlocked now. It needs the passphrase again,
   * so the raw key only exists for the length of this call and no extractable key is kept.
   */
  async enrollDevice(serializedHeader: string, passphrase: string): Promise<VaultDeviceEnrollment> {
    const header = parseVaultHeader(serializedHeader);
    const { vaultId, epoch } = this.#unlocked();
    if (header.vaultId !== vaultId) throw new VaultError("authentication-failed");
    if (this.#pendingEnrollment) throw new VaultError("busy");
    this.#pendingEnrollment = true;
    let rawKey: Uint8Array<ArrayBuffer> | undefined;
    let secret: Uint8Array<ArrayBuffer> | undefined;
    try {
      rawKey = await this.#passphraseKey(header, passphrase, epoch);
      secret = random(VAULT_DEVICE_SECRET_BYTES);
      const deviceKey = await provider().subtle.importKey("raw", secret, "AES-GCM", false, ["encrypt"]);
      this.#assertEpoch(epoch);
      const slot: VaultDeviceSlot = { kind: "markie-vault-device-slot", version: 1, vaultId, iv: encodeBase64(random(12)), ciphertext: "" };
      const ciphertext = await provider().subtle.encrypt({ name: "AES-GCM", iv: decodeBase64(slot.iv),
        additionalData: deviceSlotContext(slot), tagLength: 128 }, deviceKey, rawKey);
      this.#assertEpoch(epoch);
      const enrollment = { slot: serializeVaultDeviceSlot({ ...slot, ciphertext: encodeBase64(new Uint8Array(ciphertext)) }), secret };
      secret = undefined;
      return enrollment;
    } finally {
      rawKey?.fill(0);
      secret?.fill(0);
      this.#pendingEnrollment = false;
    }
  }

  #unlocked(): { key: CryptoKey; vaultId: string; epoch: number } {
    if (!this.#key || !this.#vaultId) throw new VaultError("locked");
    return { key: this.#key, vaultId: this.#vaultId, epoch: this.#epoch };
  }

  #beginDocumentOperation(): { key: CryptoKey; vaultId: string; epoch: number } {
    const session = this.#unlocked();
    if (this.#documentOperations >= VAULT_LIMITS.concurrentDocumentOperations) throw new VaultError("busy");
    this.#documentOperations++;
    return session;
  }

  async encryptDocument(documentId: string, bytes: Uint8Array, metadata: VaultDocumentMetadata): Promise<string> {
    const { key, vaultId, epoch } = this.#beginDocumentOperation();
    let frame: Uint8Array<ArrayBuffer> | undefined;
    try {
      validateVaultId(documentId);
      if (!(bytes instanceof Uint8Array)) throw new VaultError("invalid-envelope");
      if (bytes.length > VAULT_LIMITS.contentBytes) throw new VaultError("limit-exceeded");
      const encodedMetadata = metadataBytes(metadata);
      frame = new Uint8Array(4 + encodedMetadata.length + bytes.length);
      new DataView(frame.buffer).setUint32(0, encodedMetadata.length, false);
      frame.set(encodedMetadata, 4);
      frame.set(bytes, 4 + encodedMetadata.length);
      encodedMetadata.fill(0);
      // A fresh content key for every encryption; never reused after an edit or retry.
      const contentKey = await provider().subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      this.#assertEpoch(epoch);
      const wrappedKey = await provider().subtle.wrapKey("raw", contentKey, key, "AES-KW");
      this.#assertEpoch(epoch);
      const envelope: VaultDocumentEnvelope = { kind: "markie-vault-document", version: 1, vaultId, documentId,
        cipher: "AES-GCM", keyWrap: "AES-KW", wrappedKey: encodeBase64(new Uint8Array(wrappedKey)), iv: encodeBase64(random(12)), ciphertext: "" };
      const ciphertext = await provider().subtle.encrypt({ name: "AES-GCM", iv: decodeBase64(envelope.iv),
        additionalData: documentContext(envelope), tagLength: 128 }, contentKey, frame);
      this.#assertEpoch(epoch);
      return serializeVaultDocument({ ...envelope, ciphertext: encodeBase64(new Uint8Array(ciphertext)) });
    } finally {
      frame?.fill(0);
      this.#documentOperations--;
    }
  }

  async decryptDocument(serialized: string, expectedDocumentId: string): Promise<DecryptedVaultDocument> {
    const { key, vaultId, epoch } = this.#beginDocumentOperation();
    let frame: Uint8Array<ArrayBuffer> | undefined;
    try {
      validateVaultId(expectedDocumentId);
      const envelope = parseVaultDocument(serialized);
      if (envelope.vaultId !== vaultId || envelope.documentId !== expectedDocumentId) throw new VaultError("authentication-failed");
      let contentKey: CryptoKey;
      try {
        contentKey = await provider().subtle.unwrapKey("raw", decodeBase64(envelope.wrappedKey), key, "AES-KW",
          { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      } catch { throw new VaultError("authentication-failed"); }
      this.#assertEpoch(epoch);
      try {
        frame = new Uint8Array(await provider().subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(envelope.iv),
          additionalData: documentContext(envelope), tagLength: 128 }, contentKey, decodeBase64(envelope.ciphertext)));
      } catch { throw new VaultError("authentication-failed"); }
      this.#assertEpoch(epoch);
      if (frame.length < 4) throw new VaultError("invalid-envelope");
      const metadataLength = new DataView(frame.buffer).getUint32(0, false);
      if (metadataLength > VAULT_LIMITS.metadataBytes || metadataLength > frame.length - 4 ||
          frame.length - 4 - metadataLength > VAULT_LIMITS.contentBytes) throw new VaultError("invalid-envelope");
      const metadata = parseMetadata(frame.subarray(4, 4 + metadataLength));
      return { bytes: frame.slice(4 + metadataLength), metadata };
    } finally {
      frame?.fill(0);
      this.#documentOperations--;
    }
  }
}
