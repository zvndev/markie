# Document vault: experimental primitives and threat model

Status: experimental isolated local vault, October 15, 2026. `VaultPanel` now provides create/unlock/import/edit/save/search/delete/lock flows backed by a separate encrypted IndexedDB database. This does not encrypt existing ordinary workspace files or connect private content to the normal library, filesystem, registry, snapshots, cloud storage, comments, sharing, collaboration or MCP. Do not advertise existing files as protected by this work. Native biometrics and production security certification remain out of scope.

## Security objective and boundary

Protect document bytes and their name/media type against an attacker who obtains only the serialized vault header and encrypted record envelopes, assuming a strong secret passphrase, genuine Web Crypto, uncompromised client execution, and correct persistence/integration. Tampering fails authentication; it does not yield partially decrypted content. This is at-rest encryption, not a system for defending an unlocked app from its owner, malware or hostile JavaScript.

Not provided: biometric unlock, short-PIN protection, lost-passphrase reset, password change, rollback/deletion detection, membership/permissions, multiplayer encryption, searchable ciphertext, guaranteed backup against browser eviction, secure deletion, full-disk security, or protection from screenshots/clipboard/OS memory inspection. IDs, record count, ciphertext length, update timing, KDF parameters and correlation between versions remain visible. Random opaque IDs must not be replaced by filenames or hashes of names.

## API and ownership

`src/lib/vault/index.ts` exports a `Vault` controller, `createVaultDocumentId`, strict envelope parsers/serializers, types, limits and typed error codes. No key export or authentication-boolean API exists.

```ts
const vault = new Vault();
const header = await vault.create(strongPassphrase); // state: unlocked
const id = createVaultDocumentId();
const encrypted = await vault.encryptDocument(id, documentBytes, {
  name: "Letter.docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});
vault.lock();
await vault.unlock(header, strongPassphrase);
const document = await vault.decryptDocument(encrypted, id);
vault.lock();
document.bytes.fill(0); // Caller owns any returned plaintext and must clear it when finished.
```

The low-level controller deliberately performs no persistence; `VaultRepository` now owns atomic encrypted persistence through the `VaultStorage` boundary described below. Persist both header and encrypted envelopes, never the passphrase or unlocked controller/key. Keep one controller per open vault under a central lifecycle owner. Locking one controller cannot revoke a separately unlocked controller, other browser tab, worker, or another device.

## Isolated storage and usable panel

`src/lib/vault/storage.ts` implements the `VaultStorage.load/commit` contract using a separate origin-local IndexedDB database named `markie-encrypted-vault`, version 1, with one `vault` object store and `snapshot` key. Its sole value contains `{version,revision,header,records:[{id,envelope}]}`. Strict validation rejects extra fields, duplicate IDs and mismatched vault/document identities. No names, decrypted bodies, plaintext recovery copies, MIME metadata or keys are stored beside the encrypted envelopes. There is no silent localStorage or in-memory fallback when IndexedDB is unavailable.

Every commit replaces the header and all records together in one read-write transaction, using a compare-and-swap revision checked in that same transaction. Success is reported only from `transaction.oncomplete`, not an individual request's success event. `durability: strict` is requested. Abort signals abort pending transactions. Another window's committed revision causes a visible conflict rather than an overwrite. These guarantees follow the [IndexedDB transaction model](https://w3c.github.io/IndexedDB/#transaction-lifetime); browser site-data clearing, storage eviction, device failure and absent backups remain data-loss risks.

`VaultRepository` serializes operations, copies write inputs before queueing, bounds queued write buffers to four, and caps the combined durable/recovery set at 128 records and 32 MiB of serialized ciphertext. Each record still has the 8 MiB plaintext limit. Names are decrypted only during unlocked listing/search and are held only inside the panel's memory. The ordinary document library never receives private records, paths, titles or search text. Vault search currently matches filenames, not bodies. Writes/deletes use the revision-CAS adapter; failures leave the prior durable snapshot unchanged.

`VaultPanel` takes optional `{storage,onClose,onCloseGuard}` props and otherwise uses the real IndexedDB adapter. Parent navigation must call the registered close guard before unmounting a dirty editor or discarding volatile recovery; the callback exposes only a boolean decision, never private content. The panel uses a passphrase-only create/unlock form, imports an encrypted copy without deleting the original, edits literal UTF-8/UTF-16 text and supported original-engine DOCX runs, and preserves unsupported files as download-only bytes. Cmd/Ctrl-S is intercepted for encrypted saving, not the browser's Save Page. It never renders private HTML/images or follows external links. Changing filename extensions is not treated as format conversion; an incomplete rename does not prevent an automatic body checkpoint under the previous filename. Mixed line endings remain read-only to avoid normalization.

Save errors preserve the dirty editor. If encryption succeeded but durable commit failed, the repository retains a bounded ciphertext-only recovery envelope in memory, never plaintext storage. A failed new-document save exposes only its opaque recovery ID so retries use the same record instead of generating duplicates. After lock/unlock in the same mounted panel, recovery opens as unsaved and must be saved again; closing/unmounting the panel, closing the tab or crashing loses this volatile recovery. A successful later write atomically persists pending encrypted recoveries. This is not a lost-passphrase recovery mechanism or a durable backup promise.

Manual lock, close and document replacement ask before discarding unsaved edits. On tab hiding or five minutes of inactivity, the panel immediately shields plaintext UI and revokes pending download URLs, attempts an encrypted dirty checkpoint, then locks/releases the key. The checkpoint has a two-second timer; native operations and browser event-loop scheduling cannot guarantee real-time cancellation. If storage fails after encryption, only encrypted volatile recovery is retained and the locked UI says so. If encryption cannot finish before the bound, the last durable saved copy remains and the UI reports checkpoint failure. Authentication finishing in a hidden tab locks instead of displaying private entries. Save before closing; unload prompts and asynchronous browser shutdown are not guaranteed recovery.

An explicit, confirmed **Download unencrypted copy** action is the declassification boundary. It creates a local Blob URL, marks the downloaded file as outside the vault's protection, revokes URLs on lock/unmount, and does not mark unsaved edits as saved. Already downloaded files, original imports, clipboard histories, screenshots and external backups are not erased by locking/deleting the vault entry. No fake Touch ID checkbox or boolean-auth key release is present.

`state` is `locked`, `unlocking` or `unlocked`; `vaultId` is undefined when locked. An unlocked controller refuses create/unlock until explicitly locked. One KDF operation may run per controller. `lock()` invalidates pending create/unlock and in-flight document results using an epoch; they cannot silently unlock the controller or return a stale decrypted result later. Native crypto cannot be interrupted, and keys/temporary buffers already passed to it can remain in memory until the pending operation settles. `busy` means the caller must wait, not silently bypass the lock.

Document input bytes are copied before the first await. Temporary raw vault/passphrase/frame bytes are overwritten in `finally` blocks. Unlocked vault keys and unwrapped decryption keys are nonextractable `CryptoKey` objects. A newly generated content key must briefly be extractable so Web Crypto's standard `wrapKey` operation can serialize it; it is never returned or persisted unwrapped. JS strings, GC copies, engine/native buffers and plaintext already returned to callers cannot be reliably zeroized. `lock()` is not a claim of immediate memory erasure.

## Version 1 format and key hierarchy

Use standard primitives implemented by Web Crypto, not hand-written ciphers or another editor's code. The underlying [W3C Recommendation](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/) specifies PBKDF2, AES-GCM and AES-KW. AES-GCM authenticates both ciphertext and explicitly supplied additional data; AES-KW supplies the standardized wrapping operation. No new dependency is required.

1. Generate a random 256-bit vault key and random 128-bit vault ID and salt with `crypto.getRandomValues`.
2. Derive a nonextractable 256-bit AES-GCM wrapping key from the exact UTF-8 passphrase using PBKDF2-HMAC-SHA256, initially 600,000 iterations and the independent salt.
3. Encrypt the raw vault key under the wrapping key using AES-GCM, a random 96-bit IV and 128-bit authentication tag. Authenticate format kind/version, vault ID, KDF name/hash/work factor/salt, wrapping algorithm and IV. The vault key becomes a nonextractable AES-KW key.
4. Every document encryption generates a fresh random 256-bit AES-GCM content key, wraps it with AES-KW under the vault key, and uses a fresh random 96-bit IV/128-bit tag to encrypt a single frame containing both private metadata and content. Content keys are never reused across writes/retries. Authenticate kind/version, vault ID, document ID, cipher/wrap algorithms, wrapped key and IV. Expected vault/document IDs must match the caller's trusted selection.
5. The encrypted frame is a 4-byte unsigned big-endian metadata byte length, canonical UTF-8 JSON `{name,mediaType}`, then unchanged document bytes. Names and MIME types are not present in the outer envelope. No compression or document parsing occurs in this module.

JSON envelopes have exact fixed schemas, stable field order, unpadded canonical base64url and no duplicate/unknown fields. Parsers reject whitespace/reordered/noncanonical input instead of silently rewriting it. Serializers are for typed internal values; parsers are the trust boundary. Unsupported versions fail closed; no downgrade or plaintext fallback exists. Serialization is an experimental contract and may need a versioned migration before general release.

## Passphrases and denial-of-service limits

A stolen header permits unlimited offline password guessing. PBKDF2 adds cost, not entropy; client retry timers do not stop offline attacks. The API rejects fewer than 16 Unicode code points, malformed surrogate input and more than 1,024 UTF-8 bytes. This length floor does not prove a password is strong. Use independently generated random words or a password-manager-generated long secret. A 4–6 digit passcode is not acceptable for this portable wrapping mode. Spaces, case and Unicode normalization are not altered; losing the exact secret means losing access.

600,000 iterations is a provisional engineering parameter, not a universal strength claim. Before shipping, benchmark low-powered supported devices and obtain cryptographic review of parameters, migration, and whether a vetted memory-hard KDF should be introduced in a new format version. The dependency-free browser Web Crypto path currently uses PBKDF2, not a custom Argon2 implementation.

Limits are enforced before expensive crypto: 4,096 header characters; 12 MiB outer document characters; 8 MiB document bytes; 4,096 metadata bytes; 1,024 name UTF-16 units; 255 MIME characters; exact ID/salt/IV/wrapped-key lengths. Only integer PBKDF2 work factors from 600,000 through 1,000,000 are accepted. One pending unlock and at most four document operations per controller bound native-crypto work and copied frames. These are per-controller/per-call bounds, not a defense against hostile same-origin code creating thousands of controllers. Larger documents need a reviewed streaming/chunked format rather than unbounded buffer growth.

## Integration leak-prevention requirements

Before extending the isolated panel to any other app surface, audit every plaintext consumer. Existing Markdown storage and collaboration paths must not receive vault plaintext automatically.

| Surface | Required behavior before secure-area release |
| --- | --- |
| Search/index/sort | Exclude vault bodies, names, tags, paths and previews from the ordinary SQLite/FTS/Spotlight index and MCP/AI scans. Search while unlocked using isolated ephemeral data; clear on lock. Locked display cannot reveal titles through a separate plaintext index. Encrypted search is separate research. |
| Thumbnails, recent files, activity, notifications | Never persist private names, snippets, image previews or paths outside encrypted records. Show generic locked entries; explicitly disclose visible counts/lengths. |
| Autosave, undo, snapshots, recovery, temp/export | Encrypt before persistence, including attachments/comments/undo/recovery. Never route through existing plaintext snapshot/temp/PDF pipelines. Browser cache/service workers/localStorage must not retain decrypted documents or keys. Clear views and workers when locking. |
| Clipboard, drag/drop, printing, screenshots | Treat copying/exporting/printing as deliberate plaintext release and make that visible. Do not claim encryption retracts clipboard history, screenshots or external copies. Automatic clipboard clearing is not sufficient protection. |
| Logs, analytics, errors | Only constant error codes; no secret inputs, filenames, plaintext frames, key material, PRF output, document dumps or decrypted assertion objects. Redact telemetry and crash reports. |
| Multiplayer, comments, sharing, AI | Disabled for vault files until an independently reviewed recipient-key and encrypted-transport protocol exists. Existing Yjs/cloud plaintext channels are not end-to-end encrypted merely because storage is encrypted. Sharing is explicit declassification unless a real reviewed encrypted sharing system is built. Removing a member cannot erase copies they already received. |
| Import and deletion | Import may leave an original plaintext file, backups and filesystem snapshots. Never claim moving into the vault securely erases those. Any deletion must be explicit and recoverability understood. |
| App lifecycle | Lock on the chosen idle/window/OS/session policy, hide plaintext DOM/editor/undo/find state, terminate isolated processing and revoke object URLs. Prevent pending UI/editor work from restoring plaintext after lock. Controller epochs cover this module only. |

Active XSS, malicious extensions, untrusted renderer code and compromised app updates can read input secrets, invoke unlocked keys or steal plaintext. A nonextractable `CryptoKey` does not fix XSS. Require a restrictive CSP, no remote executable code, dependency/supply-chain review, isolated/unprivileged document rendering, Electron context isolation and narrow IPC. Document media and hyperlinks must not trigger external network requests revealing private content. Hostile package/XML parsing belongs in its own resource-limited boundary.

Replaying an older valid record or replacing an entire header+vault with an older valid version is not detected here. Identity authentication prevents record swapping between the caller's expected IDs, but freshness requires a separately trusted monotonic manifest/version scheme and an explicit conflict policy. Hostile storage can always delete or withhold records. Backups must include the header and authenticated encrypted records; browser site-data deletion can destroy the only copy. No password reset can recover a lost wrapping secret in this version; account reset is unrelated.

## Future biometric/platform adapters (not implemented)

macOS: protect actual wrapping-key material as a Keychain item with `SecAccessControl`, accessed through a narrow native broker. Apple's [Keychain biometric access guide](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id) and [accessibility guidance](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility) are the starting points. [`biometryCurrentSet`](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset) binds access to the enrolled set and invalidates the item when enrollment changes. Decide device-unlock/passcode fallback explicitly, handle canceled prompts and invalidation, and test broker access rules on signed builds. Calling `LAContext.evaluatePolicy` then setting `authenticated = true` does not cryptographically gate a key held elsewhere. Do not put raw vault keys into renderer IPC or use Electron safeStorage alone as a claim of per-vault Touch ID enforcement.

Web: the [W3C WebAuthn Level 3 PRF extension](https://www.w3.org/TR/webauthn-3/#prf-extension) can derive secret output associated with a credential, unlike an ordinary signed login assertion. A future adapter may use verified PRF output with reviewed domain separation/key derivation to protect the same random vault key. Require actual PRF results, correct origin/RP binding, user verification policy and credential/device lifecycle checks; a successful sign-in boolean or `prf.enabled` flag is not a decryption key. Keep PRF results out of authentication-server payloads/logs. Feature-detect actual authenticator/browser capability and handle unsupported devices without weakening encryption. RP-origin changes, credential deletion and synced-passkey loss require a preplanned recovery wrapping path. No universal biometric guarantee or cross-browser PRF support is claimed.

Neither future adapter is authorized to remove the passphrase wrapper silently. Device-specific convenience unlock, account auth, local OS auth and document decryption are separate trust decisions. Recovery and multiple wrappers require an authenticated versioned format addition and review.

## Verification and release gates

`npm test -- src/lib/vault` exercises genuine runtime Web Crypto: binary/Unicode/empty round trips, fresh keys/salts/IVs, metadata confidentiality, wrong secret, tampering/context and cross-vault substitution, exact formats/base64 and pre-KDF limits, short-PIN rejection, resource bounds, unavailable-crypto failure, concurrent unlocks, and lock during create/unlock/encrypt/decrypt. Race tests delay real crypto results rather than replacing encryption with a fake implementation. They also verify wiping of late decrypted temporary bytes. Tests of the native primitives are not an independent audit of the format or integration.

Repository/storage tests add atomic-CAS transaction completion, quota/abort rollback, cross-window conflict rejection, ciphertext-only failed-save recovery, stable new-draft retry identity, queued-write limits and lock/reopen behavior. `npm test -- src/components/documents/vault-panel.test.tsx` covers actual Web Crypto with create/edit/save/lock/reopen/search, private DOCX edits, failed save dirty retention, hidden checkpoint/recovery/timeout, hidden authentication, tampered-record failure, navigation guard, filename validation and explicit export/deletion confirmation. Browser probes should use an isolated synthetic database, never a user's real vault.

Independent milestone validation exercised real IndexedDB/Web Crypto in Firefox and WebKit, including an aborted write, lock/unlock, ciphertext-only volatile recovery and successful retry. An integrated Chromium UI probe exercised synthetic create/note/rename/save/lock/reload/unlock and canceled dirty navigation. Raw vault and ordinary-library storage contained none of the synthetic private title/body/passphrase, and lock removed private text/name DOM. This validates the tested local workflow, not a formal cryptographic audit, OS memory guarantees, signed native packaging or production account/security configuration.

Before production integration: independent cryptographic/security review; authenticated-manifest/rollback policy; reviewed passphrase/recovery UX; atomic persistence and crash/conflict tests; no-plaintext leak audit across all app surfaces; Safari/Firefox/Chromium and signed Electron tests; OS lock/lifecycle and multi-tab tests; real biometric/PRF adapter testing if included; accessible UX and explicit limitations. The present code is a foundation for those gates, not evidence that those gates have passed.
