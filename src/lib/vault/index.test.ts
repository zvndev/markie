import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VAULT_LIMITS, Vault, createVaultDocumentId, parseVaultDocument, parseVaultHeader,
  serializeVaultDocument, serializeVaultHeader,
} from "./index";
import { decodeBase64, documentContext, encodeBase64, headerContext } from "./envelope";

const passphrase = "quartz maple orbit lantern harbor";
const metadata = { name: "Private letter 秘密 🔒.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
const content = new TextEncoder().encode("A private document — café, שלום, 日本語.");

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function changedBase64(value: string): string {
  const bytes = decodeBase64(value);
  bytes[0] ^= 1;
  return encodeBase64(bytes);
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  return { wait: new Promise<void>((resolve) => { release = resolve; }),
    started: new Promise<void>((resolve) => { entered = resolve; }),
    release: () => release(), entered: () => entered() };
}

describe("experimental vault encryption", () => {
  it("round-trips binary content and Unicode metadata after a fresh unlock", async () => {
    const vault = new Vault();
    expect(vault.state).toBe("locked");
    const header = await vault.create(passphrase);
    const documentId = createVaultDocumentId();
    const bytes = new Uint8Array([...content, 0, 255, 128]);
    const envelope = await vault.encryptDocument(documentId, bytes, metadata);
    expect(vault.state).toBe("unlocked");
    vault.lock();
    expect(vault.state).toBe("locked");
    expect(vault.vaultId).toBeUndefined();
    await vault.unlock(header, passphrase);
    const result = await vault.decryptDocument(envelope, documentId);
    expect(result.bytes).toEqual(bytes);
    expect(result.metadata).toEqual(metadata);
    expect(bytes.at(-1)).toBe(128); // Caller-owned bytes are not zeroed by the vault.
  });

  it("round-trips empty documents and treats passphrases as exact Unicode", async () => {
    const vault = new Vault();
    const unicode = "  復元コード élève 🍁 bateau  ";
    const header = await vault.create(unicode);
    const id = createVaultDocumentId();
    const envelope = await vault.encryptDocument(id, new Uint8Array(), { name: "", mediaType: "text/plain" });
    vault.lock();
    await expect(vault.unlock(header, unicode.trim())).rejects.toMatchObject({ code: "authentication-failed" });
    await vault.unlock(header, unicode);
    expect((await vault.decryptDocument(envelope, id)).bytes.length).toBe(0);
  });

  it("keeps filenames, MIME metadata and content out of both persisted envelopes", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    const envelope = await vault.encryptDocument(createVaultDocumentId(), content, metadata);
    for (const serialized of [header, envelope]) {
      expect(serialized).not.toContain(metadata.name);
      expect(serialized).not.toContain(metadata.mediaType);
      expect(serialized).not.toContain("private document");
      expect(serialized).not.toContain(passphrase);
    }
    expect(Object.keys(parseVaultDocument(envelope))).toEqual([
      "kind", "version", "vaultId", "documentId", "cipher", "keyWrap", "wrappedKey", "iv", "ciphertext",
    ]);
  });

  it("uses independently random vault salts, wrapping IVs and per-write content keys/IVs", async () => {
    const first = new Vault();
    const second = new Vault();
    const a = parseVaultHeader(await first.create(passphrase));
    const b = parseVaultHeader(await second.create(passphrase));
    expect(a.vaultId).not.toBe(b.vaultId);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.wrap.iv).not.toBe(b.wrap.iv);
    const id = createVaultDocumentId();
    const documents: string[] = [];
    for (let batch = 0; batch < 3; batch++) {
      documents.push(...await Promise.all(Array.from({ length: 4 }, () => first.encryptDocument(id, content, metadata))));
    }
    for (const field of ["iv", "wrappedKey", "ciphertext"] as const) {
      expect(new Set(documents.map((value) => parseVaultDocument(value)[field])).size).toBe(12);
    }
  });

  it("fails closed for a wrong passphrase or changed header context", async () => {
    const vault = new Vault();
    const serialized = await vault.create(passphrase);
    vault.lock();
    await expect(vault.unlock(serialized, "wrong passphrase with adequate length")).rejects.toMatchObject({ code: "authentication-failed" });
    expect(vault.state).toBe("locked");
    for (const change of [
      (header: ReturnType<typeof parseVaultHeader>) => ({ ...header, vaultId: createVaultDocumentId() }),
      (header: ReturnType<typeof parseVaultHeader>) => ({ ...header, wrap: { ...header.wrap, ciphertext: changedBase64(header.wrap.ciphertext) } }),
      (header: ReturnType<typeof parseVaultHeader>) => ({ ...header, kdf: { ...header.kdf, salt: changedBase64(header.kdf.salt) } }),
      (header: ReturnType<typeof parseVaultHeader>) => ({ ...header, wrap: { ...header.wrap, iv: changedBase64(header.wrap.iv) } }),
    ]) {
      await expect(vault.unlock(serializeVaultHeader(change(parseVaultHeader(serialized))), passphrase))
        .rejects.toMatchObject({ code: "authentication-failed" });
      expect(vault.state).toBe("locked");
    }
  });

  it("rejects ciphertext, wrapped-key, nonce and identity substitution", async () => {
    const vault = new Vault();
    await vault.create(passphrase);
    const id = createVaultDocumentId();
    const envelope = parseVaultDocument(await vault.encryptDocument(id, content, metadata));
    for (const field of ["ciphertext", "wrappedKey", "iv"] as const) {
      await expect(vault.decryptDocument(serializeVaultDocument({ ...envelope, [field]: changedBase64(envelope[field]) }), id))
        .rejects.toMatchObject({ code: "authentication-failed" });
    }
    const otherId = createVaultDocumentId();
    await expect(vault.decryptDocument(serializeVaultDocument(envelope), otherId)).rejects.toMatchObject({ code: "authentication-failed" });
    await expect(vault.decryptDocument(serializeVaultDocument({ ...envelope, documentId: otherId }), otherId))
      .rejects.toMatchObject({ code: "authentication-failed" });
    await expect(vault.decryptDocument(serializeVaultDocument({ ...envelope, vaultId: createVaultDocumentId() }), id))
      .rejects.toMatchObject({ code: "authentication-failed" });
  });

  it("cannot decrypt a record with another vault's key", async () => {
    const a = new Vault();
    const b = new Vault();
    await a.create(passphrase);
    await b.create(passphrase);
    const id = createVaultDocumentId();
    const envelope = parseVaultDocument(await a.encryptDocument(id, content, metadata));
    await expect(b.decryptDocument(serializeVaultDocument({ ...envelope, vaultId: b.vaultId! }), id))
      .rejects.toMatchObject({ code: "authentication-failed" });
  });

  it("uses the specified AES-KW / AES-GCM hierarchy with nonextractable unlocked keys", async () => {
    const importSpy = vi.spyOn(crypto.subtle, "importKey");
    const vault = new Vault();
    const serialized = await vault.create(passphrase);
    const header = parseVaultHeader(serialized);
    const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    const wrapper = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: header.kdf.iterations,
      salt: decodeBase64(header.kdf.salt) }, passwordKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(header.wrap.iv),
      additionalData: headerContext(header), tagLength: 128 }, wrapper, decodeBase64(header.wrap.ciphertext)));
    const key = await crypto.subtle.importKey("raw", raw, "AES-KW", false, ["wrapKey", "unwrapKey"]);
    raw.fill(0);
    expect(importSpy.mock.calls.filter((call) => call[2] === "AES-KW").every((call) => call[3] === false)).toBe(true);
    const id = createVaultDocumentId();
    const envelope = parseVaultDocument(await vault.encryptDocument(id, content, metadata));
    const contentKey = await crypto.subtle.unwrapKey("raw", decodeBase64(envelope.wrappedKey), key, "AES-KW",
      { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    expect(contentKey.extractable).toBe(false);
    const frame = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(envelope.iv),
      additionalData: documentContext(envelope), tagLength: 128 }, contentKey, decodeBase64(envelope.ciphertext)));
    const metadataLength = new DataView(frame.buffer).getUint32(0, false);
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + metadataLength)))).toEqual(metadata);
    expect(frame.subarray(4 + metadataLength)).toEqual(content);
    frame.fill(0);

    // Even authenticated records from another writer cannot bypass inner framing limits.
    const writerKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const wrapped = encodeBase64(new Uint8Array(await crypto.subtle.wrapKey("raw", writerKey, key, "AES-KW")));
    const badMetadata = new TextEncoder().encode('{"name":"Title","mediaType":"text/plain","extra":true}');
    const invalidFrames = [new Uint8Array(4), new Uint8Array(4 + badMetadata.length), new Uint8Array(4101)];
    new DataView(invalidFrames[1].buffer).setUint32(0, badMetadata.length, false);
    invalidFrames[1].set(badMetadata, 4);
    new DataView(invalidFrames[2].buffer).setUint32(0, 4097, false);
    for (const invalid of invalidFrames) {
      const changed = { ...envelope, wrappedKey: wrapped, iv: encodeBase64(crypto.getRandomValues(new Uint8Array(12))) };
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: decodeBase64(changed.iv),
        additionalData: documentContext(changed), tagLength: 128 }, writerKey, invalid);
      await expect(vault.decryptDocument(serializeVaultDocument({ ...changed, ciphertext: encodeBase64(new Uint8Array(ciphertext)) }), id))
        .rejects.toMatchObject({ code: "invalid-envelope" });
    }
  });

  it("snapshots caller-owned input before asynchronous crypto starts", async () => {
    const vault = new Vault();
    await vault.create(passphrase);
    const id = createVaultDocumentId();
    const bytes = new Uint8Array(content);
    const mutableMetadata = { ...metadata };
    const encrypting = vault.encryptDocument(id, bytes, mutableMetadata);
    bytes.fill(0);
    mutableMetadata.name = "Changed later";
    const result = await vault.decryptDocument(await encrypting, id);
    expect(result.bytes).toEqual(content);
    expect(result.metadata).toEqual(metadata);
  });
});

describe("strict limits and state transitions", () => {
  it("rejects short PINs, oversized passphrases and unpaired surrogate input before KDF", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    for (const input of ["123456", "short words", "x".repeat(1025), "🔒".repeat(300), "a".repeat(20) + "\uD800"]) {
      const vault = new Vault();
      await expect(vault.create(input)).rejects.toMatchObject({ code: "invalid-passphrase" });
      expect(vault.state).toBe("locked");
    }
    expect(derive).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, versions, duplicate keys and noncanonical encodings before KDF", async () => {
    const vault = new Vault();
    const serialized = await vault.create(passphrase);
    vault.lock();
    const header = JSON.parse(serialized);
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    for (const invalid of [
      JSON.stringify({ ...header, extra: true }), JSON.stringify({ ...header, version: 2 }),
      serialized.replace('"version":1', '"version":1,"version":1'), ` ${serialized}`,
      serialized.replace(header.kdf.salt, `${header.kdf.salt}=`),
      JSON.stringify({ ...header, kdf: { ...header.kdf, iterations: Number.MAX_SAFE_INTEGER } }),
      JSON.stringify({ ...header, kdf: { ...header.kdf, iterations: 1 } }),
      JSON.stringify({ ...header, kdf: { ...header.kdf, iterations: 600000.5 } }),
      "[".repeat(4097),
    ]) await expect(vault.unlock(invalid, passphrase)).rejects.toMatchObject({ name: "VaultError" });
    expect(derive).not.toHaveBeenCalled();
    expect(vault.state).toBe("locked");
  });

  it("rejects noncanonical base64 trailing bits and document sizes before decryption", async () => {
    const vault = new Vault();
    await vault.create(passphrase);
    const id = createVaultDocumentId();
    const envelope = parseVaultDocument(await vault.encryptDocument(id, content, metadata));
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const idIndex = alphabet.indexOf(id.at(-1)!);
    const noncanonicalId = id.slice(0, -1) + alphabet[idIndex + 1];
    for (const invalid of [
      JSON.stringify({ ...envelope, documentId: noncanonicalId }),
      JSON.stringify({ ...envelope, iv: "A" }),
      JSON.stringify({ ...envelope, ciphertext: "A".repeat(VAULT_LIMITS.documentCharacters + 1) }),
      JSON.stringify({ ...envelope, ciphertext: "AA" }),
      JSON.stringify({ ...envelope, cipher: "AES-CBC" }),
      JSON.stringify({ ...envelope, extra: { deeply: "nested" } }),
    ]) await expect(vault.decryptDocument(invalid, id)).rejects.toMatchObject({ name: "VaultError" });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("bounds content and metadata before generating keys", async () => {
    const vault = new Vault();
    await vault.create(passphrase);
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    await expect(vault.encryptDocument(createVaultDocumentId(), new Uint8Array(VAULT_LIMITS.contentBytes + 1), metadata))
      .rejects.toMatchObject({ code: "limit-exceeded" });
    await expect(vault.encryptDocument(createVaultDocumentId(), content, { ...metadata, name: "x".repeat(1025) }))
      .rejects.toMatchObject({ code: "invalid-envelope" });
    await expect(vault.encryptDocument(createVaultDocumentId(), content, { ...metadata, name: "\u0000".repeat(1024) }))
      .rejects.toMatchObject({ code: "limit-exceeded" });
    await expect(vault.encryptDocument("filename.docx", content, metadata)).rejects.toMatchObject({ code: "invalid-envelope" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses all document operations after lock", async () => {
    const vault = new Vault();
    await vault.create(passphrase);
    const id = createVaultDocumentId();
    const envelope = await vault.encryptDocument(id, content, metadata);
    vault.lock();
    vault.lock();
    await expect(vault.encryptDocument(id, content, metadata)).rejects.toMatchObject({ code: "locked" });
    await expect(vault.decryptDocument(envelope, id)).rejects.toMatchObject({ code: "locked" });
  });

  it("bounds concurrent document allocations and releases capacity after failure", async () => {
    const vault = new Vault();
    await vault.create(passphrase);
    const id = createVaultDocumentId();
    const operations = Array.from({ length: VAULT_LIMITS.concurrentDocumentOperations }, () => vault.encryptDocument(id, content, metadata));
    await expect(vault.encryptDocument(id, content, metadata)).rejects.toMatchObject({ code: "busy" });
    await expect(vault.decryptDocument("bad envelope", id)).rejects.toMatchObject({ code: "busy" });
    const encrypted = await Promise.all(operations);
    for (let failure = 0; failure < 6; failure++) {
      await expect(vault.decryptDocument("bad envelope", id)).rejects.toMatchObject({ code: "invalid-envelope" });
    }
    expect((await vault.decryptDocument(encrypted[0], id)).bytes).toEqual(content);
  });

  it("does not adopt keys from an unlock completing after lock and serializes KDF work", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    vault.lock();
    const pause = gate();
    const original = crypto.subtle.deriveKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "deriveKey").mockImplementationOnce(async (...args) => {
      pause.entered();
      const result = await original(...args);
      await pause.wait;
      return result;
    });
    const unlocking = vault.unlock(header, passphrase);
    const rejected = expect(unlocking).rejects.toMatchObject({ code: "locked" });
    await pause.started;
    expect(vault.state).toBe("unlocking");
    await expect(vault.unlock(header, passphrase)).rejects.toMatchObject({ code: "busy" });
    vault.lock();
    await expect(vault.create(passphrase)).rejects.toMatchObject({ code: "busy" });
    pause.release();
    await rejected;
    expect(vault.state).toBe("locked");
    await vault.unlock(header, passphrase);
    expect(vault.state).toBe("unlocked");
  });

  it("does not return a newly created vault after lock during KDF", async () => {
    const vault = new Vault();
    const creating = vault.create(passphrase);
    vault.lock();
    await expect(creating).rejects.toMatchObject({ code: "locked" });
    expect(vault.state).toBe("locked");
  });

  it("discards an encrypted result that finishes after lock", async () => {
    const vault = new Vault();
    await vault.create(passphrase);
    const pause = gate();
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      pause.entered();
      await pause.wait;
      return result;
    });
    const encrypting = vault.encryptDocument(createVaultDocumentId(), content, metadata);
    const rejected = expect(encrypting).rejects.toMatchObject({ code: "locked" });
    await pause.started;
    vault.lock();
    pause.release();
    await rejected;
  });

  it("zeroes decrypted temporary bytes and rejects a decrypt completing after lock", async () => {
    const vault = new Vault();
    await vault.create(passphrase);
    const id = createVaultDocumentId();
    const envelope = await vault.encryptDocument(id, content, metadata);
    const pause = gate();
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    let temporary: ArrayBuffer | undefined;
    vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
      temporary = await original(...args);
      pause.entered();
      await pause.wait;
      return temporary;
    });
    const decrypting = vault.decryptDocument(envelope, id);
    const rejected = expect(decrypting).rejects.toMatchObject({ code: "locked" });
    await pause.started;
    vault.lock();
    pause.release();
    await rejected;
    expect(new Uint8Array(temporary!).every((byte) => byte === 0)).toBe(true);
  });

  it("cannot replace an unlocked vault without explicitly locking first", async () => {
    const vault = new Vault();
    const header = await vault.create(passphrase);
    const originalId = vault.vaultId;
    await expect(vault.create(passphrase)).rejects.toMatchObject({ code: "busy" });
    await expect(vault.unlock(header, passphrase)).rejects.toMatchObject({ code: "busy" });
    expect(vault.vaultId).toBe(originalId);
  });

  it("remains usable after crypto is unavailable instead of retaining a pending unlock", async () => {
    const vault = new Vault();
    const nativeCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    await expect(vault.create(passphrase)).rejects.toMatchObject({ code: "unavailable" });
    expect(vault.state).toBe("locked");
    vi.stubGlobal("crypto", nativeCrypto);
    await vault.create(passphrase);
    expect(vault.state).toBe("unlocked");
  });
});
