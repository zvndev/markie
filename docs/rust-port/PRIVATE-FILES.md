# Private files

Make Private moves any local file into the vault, encrypted, so only Markie can open it. This page is the threat model: what is protected, what is not, and why.

## What the user does

- **Make Private…** is in File, the title bar's file menu, the right-click menu of a row in Recents, Browse and Projects, and the command palette.
- With no vault yet, the vault page asks the user to create one first. A locked vault asks for an unlock first.
- A sheet says what will happen: the file moves into the vault, the original is deleted, other apps can no longer open it, and earlier Time Machine or cloud-sync copies stay. A file with a Markie Cloud copy or a share gets one more line: the cloud copy stays, and only the copy on this Mac becomes private.
- Private files show under **Private files** in the vault list. They open, are edited and are saved there, encrypted.
- **Make Not Private…** puts the file back in its original folder, or one the user picks. It never overwrites a file of the same name. **Export…** writes a decrypted copy and keeps the private one.

## How it is stored

Private files are not `vault.json` records. They live in `private-files/` in Markie RS's data folder (`markie_vault::private`).

- `key.json` holds the private-files key: 32 random bytes under AES-256-GCM. The wrapping key comes from the vault passphrase by PBKDF2-HMAC-SHA256, 600,000 iterations, with the slot's own 16-byte salt.
- Each `<id>.mkpf` is one file. A fresh content key per write is wrapped under the private-files key with AES-KW. The metadata (name, media type, original folder, date) and the bytes are each under AES-256-GCM with their own IV. The additional data binds the file ID and the wrapped key, so a file renamed onto another ID does not open.
- Files and the folder are created 0600 and 0700. Every write goes to a temporary file, is synced and renamed.
- The limit is 256 MiB per file, because a file is encrypted in memory. The vault's own 8 MiB and 128-record limits do not apply.

## Backups

Settings → Backup writes `Markie Vault.markievault`. Since 2026-11-25 it carries the private files too, so a backup restored on a new Mac brings them back.

### Format

With no private files the backup is version 1: one JSON file, byte for byte what Electron writes and reads. With private files it is version 2 (`markie_vault::backup`), streamed to disk:

1. `MARKIE-VAULT-BACKUP 2` and a newline.
2. A one-line JSON manifest: `kind`, `version`, the size and SHA-256 of the vault part, `privateKey`, and for each private file only its random ID, size and SHA-256.
3. The vault part: the version 1 backup, unchanged.
4. Each private file's `.mkpf` bytes as stored, in the manifest's order.
5. The SHA-256 of every byte before it, 32 raw bytes.

- `privateKey` is `key.json` as stored: the private-files key wrapped under the passphrase. The key itself is never written.
- File names, media types, folders and contents stay inside the `.mkpf` ciphertext. The test `private_files_round_trip_and_the_backup_holds_no_plaintext_or_names` scans the backup's bytes for every made-up content marker, name and folder.
- The backup is written to a 0600 temporary file beside the destination and read back in full: length, every digest and the vault part. Only then is it renamed into place, so a failed backup never replaces an older one.
- There is no total size cap. The vault part keeps its old limit, each private file keeps its 256 MiB limit, and a backup holds at most 65,536 private files. Copying streams in 1 MiB chunks.
- The backup copies ciphertext only, so it works while private files are locked, as after a Touch ID unlock.

### Restore

Choosing a file reads it once to check its version, length and digests. A truncated, extended or altered file is refused before the passphrase is asked for. A version newer than 2 gets its own message: update Markie first.

After the passphrase, nothing is written until all of this holds: the passphrase opens the vault and the backup's private-files key, every vault record authenticates, and every private file decrypts under the backup's key. Each private file is read again from the backup when it is written, and its digest checked again.

Private files are merged, never overwritten:

- A file whose ID is not here comes back with its name, format and original folder.
- A file already here with the same ID and the same content is left alone. So is one an earlier restore already kept a copy of.
- A file whose ID is here but whose content differs is kept beside it, under a new ID.

The merged store ends up under one key, which the restored vault's passphrase opens:

- With no private files here, the backup's `key.json` is used.
- With private files here that the same passphrase opens, they keep their key, and the backup's files are re-encrypted under it.
- With private files here that are open under an earlier passphrase, their key is wrapped again under the restored passphrase.
- With private files here that are locked under another passphrase, the restore is refused and nothing changes. The user opens them first.

If anything fails, the files the restore added are removed and `key.json` is put back. The notice says how many private files came back, how many were already here, and how many were kept as a second copy.

A version 1 backup restores exactly as before. It leaves private files alone.

## Make Private, step by step

1. Refuse a symbolic link, a file with a second hard link, a folder, or a file over the limit. Nothing changes.
2. Encrypt and write the private copy.
3. Read the written copy back from disk, decrypt it and compare it with the original byte for byte. Any difference removes the copy.
4. Read the original again. If it changed meanwhile, remove the copy and stop.
5. Overwrite the original with zeros, sync it, then delete it.
6. Remove every copy Markie holds: history snapshots, the draft journal, office recovery, local comments, the registry rows (Recents, stars, Projects pins and assignments, metadata, the cloud record) and the Library snapshot entry, the body-text search cache, the card preview, the cloud binding and any open tab. The registry delete runs with SQLite `secure_delete` and then truncates the WAL, so freed pages hold no old rows.

`make_private_leaves_no_plaintext_in_the_data_folder` seeds every one of those stores with a made-up file, makes it private, then reads every byte under the data folder: neither the text nor the file name is left.

## Threat model

The bar: someone who has the Mac's disk and the macOS login password, but not the vault passphrase or Kirby's finger, cannot decrypt a private file.

### Protected

- **A stolen or imaged disk, with or without the login password.** The private-files key is only under the passphrase. Nothing on disk opens it without the passphrase.
- **Other apps and processes running as the user.** They see `.mkpf` ciphertext only. The original file is gone from its folder.
- **Markie's own copies.** None remain in the data folder (see above). The editor never writes plaintext of a private file to disk: no drafts, history, recovery or temporary files.
- **Tampering.** A changed byte, a swapped file or another store's key fails authentication; nothing opens.
- **The idle lock.** Five minutes without use, or a hidden window, checkpoints an open private file encrypted and forgets both keys.

### Not protected

- **Older backups.** A backup made while a file was private still holds it, encrypted under the passphrase, after Make Not Private or a deletion.
- **Copies made before Make Private:** Time Machine snapshots, iCloud Drive, Dropbox or other sync, email attachments, other apps' caches, and macOS's own QuickLook and Spotlight data from before. A cloud sync of the folder may keep a version history too.
- **The old blocks on disk.** APFS writes copy-on-write and SSDs remap blocks, so the overwrite in step 5 may not reach the bytes the file used to occupy. FileVault is what protects those blocks; it should be on.
- **A Markie Cloud copy.** It stays on the server, and people it is shared with keep access.
- **A Mac that is unlocked and running Markie with the vault open,** or malware running as the user while it is. That is out of scope for any app-level vault.
- **A weak passphrase.** PBKDF2 slows guessing but cannot save a short one. Markie requires 16 characters.

## Touch ID: the security audit

### Finding

On this build, Touch ID's device secret is not protected by Touch ID at the operating-system level.

- `KeychainSecretStore` (`markie-vault/src/device.rs`) stores the 32-byte device secret through the `keyring` crate's default v1 store, which is `apple-native-keyring-store::keychain`: the file-based login keychain (`login.keychain-db`).
- The file-based keychain ignores `kSecAttrAccessible` and access-control flags. The SDK's `SecItem.h` lists `kSecAttrAccessible` as honoured on macOS only "if kSecAttrSynchronizable and/or kSecUseDataProtectionKeychain set". Biometric access control (`SecAccessControlCreateWithFlags` with `.biometryCurrentSet`) is a feature of the data protection keychain only.
- The item's protection is its ACL, enforced by `securityd` at run time. Any other process can ask for it, for example `security find-generic-password -s "Markie RS Vault" -w` (the service is the profile name plus " Vault"). macOS then shows a prompt that the login keychain password answers.
- Offline, `login.keychain-db` is encrypted with a key derived from the login password. Someone with the disk and that password can decrypt every item in it without any prompt.
- The Touch ID check in Markie is an app-level `LAContext` evaluation before Markie reads the item. It does not stand between the item and anyone else.

So for the vault itself: with Touch ID turned on, the disk plus the login password opens the vault key, and with it every `vault.json` record. This was true before this branch and is the same in Electron Markie (`electron/vault-touch-id.js` uses `safeStorage`, also the login keychain).

### What was hardened

- **Private files do not depend on the device slot.** Their key is only under the passphrase (above). After a Touch ID unlock the vault opens, and the private files ask for the passphrase once (`TOUCH_ID_NOTE`). This meets the bar for private files on this build.
- Nothing was weakened. The vault format, the Electron byte compatibility and Kirby's existing vault are unchanged, and existing vaults open as before. A vault gets its private-files key the next time the passphrase unlocks it.

### What OS-enforced Touch ID needs

Either of these makes the secret unreadable without a current enrolled finger, enforced by the Secure Enclave:

1. A generic password in the data protection keychain (`kSecUseDataProtectionKeychain`) with `SecAccessControlCreateWithFlags(kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .biometryCurrentSet)` and `kSecAttrSynchronizable = false`.
2. A Secure Enclave P-256 key with the same access control, used to wrap the secret (ECIES), with only the wrapped secret stored.

Both need the data protection keychain, and that needs the app signed with an App ID. Without one, the call fails with `errSecMissingEntitlement` (-34018). For a Developer ID app outside the App Store that means:

- an explicit App ID for `com.zvn.markie` in the developer account, under team `$TEAM_ID`;
- a **Developer ID provisioning profile** for it, embedded as `Markie.app/Contents/embedded.provisionprofile`;
- entitlements at signing: `com.apple.application-identifier` = `<TEAM_ID>.com.zvn.markie`, `com.apple.developer.team-identifier` = `<TEAM_ID>`, and `keychain-access-groups` = `[<TEAM_ID>.com.zvn.markie]`.

Today `rust/scripts/bundle-mac.sh` signs ad hoc with no entitlements, and `rust/scripts/nightly-release.sh` signs with the Developer ID and hardened runtime but no entitlements file and no profile. So it cannot be OS-enforced in this build. The dev build (`Markie RS.app`, ad hoc) can never use it.

### Recommendation

- Keep Touch ID **off** for private files until the profile exists. That is what this branch ships.
- Once the profile and entitlements are in `nightly-release.sh`, add a second slot for the private-files key in the data protection keychain with `.biometryCurrentSet`. Then Touch ID can open private files, and the vault's own device slot should move there too, deleting the old login-keychain item.
- Until then, tell Kirby that the vault's Touch ID unlock is a convenience, not protection against someone with his login password. Turning it off in vault Settings removes the keychain item.

## KDF review

PBKDF2-HMAC-SHA256 at 600,000 iterations is OWASP's current recommendation for PBKDF2-SHA256 (2023 Password Storage Cheat Sheet). A memory-hard KDF such as Argon2id resists GPU guessing better. Changing the vault's KDF would break byte compatibility with Electron vaults and backups, so the vault keeps it. The private-files slot stores its KDF name and iteration count, so a later slot can move to Argon2id without touching existing files. No change was needed now.

## Still to check on the real screen

- A real Touch ID unlock, then opening a private file: the passphrase must be asked for. About 5 minutes in a scheduled session.
- Make Private from each entry point on a scratch file in a scratch profile, then Make Not Private. About 10 minutes.
