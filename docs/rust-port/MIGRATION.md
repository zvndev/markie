# Markie RS: moving data out of Electron, and the vault

Date: 2026-11-21. Circular task ENG-8736. Crates: `rust/crates/markie-vault` and `rust/crates/markie-migrate`.

This covers PARITY.md risk 2. If it is wrong, people lose vault contents or sign-ins at cutover. Both crates have no UI and no GPUI dependency.

## Status

| Part | State |
|---|---|
| Vault format in Rust | Done. Opens Electron vaults, and Electron opens Rust vaults. |
| `.env` parser, backup file, passphrase guide | Done, checked against the TypeScript. |
| Touch ID and Keychain for the device slot | Done behind traits. The Keychain half was run once against a test service. A real Touch ID sheet is untested. |
| Secret clipboard with auto-clear | Done, with the macOS pasteboard. |
| Reading Chromium localStorage and IndexedDB | Done, from a copy. Reads a real Electron 42 profile and Kirby's real profile copy. |
| Wiring into Markie RS first run | Done since: the nightly's first-run import, `markie-app/src/electron_import.rs`. See [NIGHTLY.md](NIGHTLY.md). |

## What is read

The migration copies two stores out of the Electron userData folder (`~/Library/Application Support/Markie`; the nightly reads `Markie Super-nightly`) into a scratch folder. That plain file read is the only access to the live profile. Every decoder runs on the copy and refuses a path inside the live profile.

| Source | Records produced |
|---|---|
| `Local Storage/leveldb`, origin `app://markie` | Sign-ins per server, the theme store, color mode, rich-mode consent paths, every other `markie.*` key raw |
| IndexedDB `markie-encrypted-vault`, store `vault`, key `snapshot` | The vault snapshot, validated exactly as `storage.ts` does |
| IndexedDB `markie-document-library`, stores `documents` and `recovery` | Library records and their recovery history, validated as `model.ts` does |
| `IndexedDB/app_markie_0.indexeddb.blob` | Values over 64 KiB, which Chromium moves to blob files. Large vaults land here. |

Sign-ins follow the TypeScript rules:

- `markie.token.v1` belongs to the primary server. That is `markie.server.v1` if set, else Markie Cloud.
- `markie.token.v1@<origin>` keys belong to other servers.
- A confirmed account is kept only if its binding names exactly the stored token at exactly that server. A rotated token comes over unconfirmed.
- Markie Cloud's old Railway address reads as its current origin, from `electron/cloud-origin.json`.

Not carried over, on purpose:

- `markie.authstate.v1`, the single-use sign-in nonce.
- Other localStorage origins, such as `http://localhost:3000` from dev builds and `devtools://`.
- The Touch ID device secret. See "Touch ID at cutover".
- The private-release credential, which never lived in localStorage.

## How the storage is read

`markie-migrate` has its own small LevelDB reader instead of a crate.

- `rusty-leveldb` (MIT, maintained) opens a database for writing. It also needs Chromium's IndexedDB comparator (`idb_cmp1`) before it will open that store, and it turns logs into new tables on open.
- The reader here only reads. It replays `CURRENT` and the `MANIFEST` to find the live tables and logs. It reads snappy and plain blocks with checksums, and keeps the newest entry per key, so deletions hide older values.
- A torn log tail is dropped, as LevelDB's own recovery does, and counted in the report. A bad table checksum stops the migration.

On top of it:

- `local_storage.rs` decodes Chromium's `_<origin>\0<key>` keys and their Latin-1 or UTF-16 strings.
- `idb.rs` decodes IndexedDB key prefixes, database and store names, IDB keys, and blob references.
- `v8.rs` reads Blink's envelope around V8's structured clone. It accepts only the shapes Markie stores: plain objects, arrays, strings, numbers, booleans, null and `Uint8Array`. Anything else fails with `Unsupported`, so an unexpected shape stops the migration instead of losing data.

## What is proven compatible

### The vault, both ways

`rust/crates/markie-vault/compat/vault-compat.ts` runs the repo's own `src/lib/vault` TypeScript against the crate's `vault-compat` example binary. All 12 check groups pass:

1. A TypeScript vault opens in Rust by passphrase, by device secret, and by restoring its backup. The wrong passphrase fails the same way.
2. A Rust vault opens in TypeScript by passphrase, by device secret and by backup. The Rust storage JSON is byte-identical to `JSON.stringify` of the snapshot `storage.ts` validates.
3. 80 malformed or valid headers, envelopes, device slots, backups and snapshots get the same accept or reject decision, with the same error code.
4. Metadata JSON escaping, `.env` parsing and edits, and passphrase strength match on test corpora.

The documents in these checks include a 70 KB binary, an empty file, and names with quotes, control characters and emoji.

### The Chromium readers

The fixture in `rust/crates/markie-migrate/tests/fixtures` was written by Electron 42.11.18, the version Markie ships. The data is made up by the repo's TypeScript (`fixtures/generate/gen.ts`) with a test passphrase and fake tokens. Electron writes it in two sessions with filler in between. That covers tables, a live log, overwrites, deletions and a blob-wrapped vault.

The Rust tests check that the migration returns exactly what the TypeScript wrote:

- The phase 2 vault snapshot, which then unlocks with the passphrase.
- Every library record and its bytes.
- Every `markie.*` key, including a removed one staying removed.

They also check that a damaged table and a missing blob file both fail loudly.

### Kirby's real profile, read once

On 2026-11-21 a scratch copy of the real profile was read with `examples/migration-report.rs`, which prints counts and key names only. Everything decoded with no unsupported shape and no torn log.

| Found | Count |
|---|---|
| `markie.*` localStorage keys | 25 |
| Other keys in `app://markie` | 30 |
| Sign-ins | 1, confirmed |
| Theme store, color mode | Present |
| Vault records | 1, no device slot |
| Library documents and recovery records | 53 and 56 |

The real profile has a `vault-touch-id` folder but no device slot in the vault. Touch ID is effectively off there, so nothing is lost by not migrating it.

## Choices that differ from Electron

- **Vault storage.** Markie RS keeps the snapshot as one JSON file with the same fields, replaced atomically with a revision check (`FileVaultStorage`). The bytes are the same as before, only the container changes.
- **Touch ID keeper.** Electron encrypts the device secret with safeStorage into a file. Markie RS stores it as a Keychain generic password, service `<app name> Vault`, account the vault ID. It is released only after LocalAuthentication passes. Keychain access control with biometry needs a signed data-protection entitlement that an ad-hoc build lacks, so the biometric gate stays in the app as in Electron.
- **Clipboard.** The secret is also marked `org.nspasteboard.ConcealedType`, so clipboard managers skip it. Electron did not do this.
- **Lone surrogates.** A vault document name with a lone UTF-16 surrogate opens in TypeScript and is rejected in Rust. macOS file names cannot hold one, so this should never occur.
- **List order.** The Rust repository sorts entries by code point. The TypeScript uses `localeCompare`. The UI should sort again for display.

## Touch ID at cutover

The Electron device secret is encrypted under the "Markie Safe Storage" Keychain item. Reading it from Markie RS would raise a Keychain password sheet and tie Markie RS to Electron's item.

Recommendation: import the vault without its device slot, using `StoredVault::without_device_slot`. The first unlock takes the passphrase. Then Markie RS offers to turn Touch ID on again, which writes a fresh slot. The passphrase stays the master key throughout.

## Since then

The first-run import in the nightly build now does this work ([NIGHTLY.md](NIGHTLY.md), "First-run import"). The calls this section once left open were made:

| Question | What was built |
|---|---|
| Sessions | Copied into the nightly's Keychain service. Both apps share one server session, so signing out in one signs out both |
| Library records | Land as files in the nightly's data folder, under `Imported Documents` |
| Vault | Imported without its device slot. The first unlock takes the passphrase, then Touch ID can be turned on again |
| Theme and settings | The keys the app uses are mapped, listed in NIGHTLY.md |

Still worth doing before the public Mac cutover: regenerate the fixture with the last Electron build (`fixtures/generate/make-fixture.sh`) and run the tests again.

## Risks

1. **Chromium changes its storage.** A later Electron could change the IndexedDB value wrapping or move IndexedDB to SQLite, which Chromium has been working on. The reader fails loudly on what it does not know. Regenerate the fixture with the last shipped Electron before cutover.
2. **Copying while Electron runs.** A store can change mid-copy, and localStorage writes are flushed lazily. Require Electron to be quit. The copy flags a running app.
3. **Keychain prompts on ad-hoc builds.** Each rebuild of an ad-hoc signed app has a new signature, so macOS may ask again for its own Keychain items. This goes away with a Developer ID signature.
4. **A real Touch ID sheet** has not been shown. The objc2 call compiles and follows Apple's API, but needs one manual check on Kirby's Mac.
5. **Shared sessions** if tokens are copied. See the decision above.

## How to run it

```sh
cd rust
cargo test -p markie-vault -p markie-migrate

# Both directions against the repo's TypeScript (needs the repo's node_modules)
cargo build -q -p markie-vault --example vault-compat
node --import ./scripts/ts-run/register.mjs crates/markie-vault/compat/vault-compat.ts

# Counts and key names only, from a fresh copy of a profile
cargo run -p markie-migrate --example migration-report -- --copy-from <userData> <empty scratch dir>

# Rebuild the Chromium fixture with the repo's Electron
crates/markie-migrate/fixtures/generate/make-fixture.sh

# Keychain round trip under a test service, deleted afterwards
cargo test -p markie-vault -- --ignored
```
