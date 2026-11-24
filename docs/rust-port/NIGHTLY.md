# Markie Nightly

Markie Nightly is the private, self-updating build of Markie RS. It exists so Kirby can live on the Rust app, beside Electron Markie, while he approves it for the full release. It is for his Mac only: Apple silicon, one account, one gateway.

It is a third app, not a replacement for either of the other two.

| | Electron Markie | Markie RS (dev build) | Markie Nightly |
|---|---|---|---|
| Bundle id | `com.zvn.markie` | `com.zvn.markie.rs` | `com.zvn.markie.nightly` |
| App | `Markie.app` | `Markie RS.app` | `Markie Nightly.app` |
| Data folder | `~/Library/Application Support/Markie` (and `Markie Super-nightly`) | `…/Markie RS` | `…/Markie Nightly` |
| URL scheme | `markie://` | `markie-rs://` | `markie-nightly://` |
| Keychain service | Electron's own | `Markie RS` | `Markie Nightly` |
| Cloud folder | `~/Documents/Markie` | `~/Documents/Markie RS/Cloud` | `~/Documents/Markie Nightly/Cloud` |
| File types claimed | yes | none | none |
| Signing | Developer ID, notarized | ad hoc | Developer ID, notarized |
| Updates | public or super-nightly feed | none | the `rs-nightly` lane of the private gateway |
| Version | `X.Y.Z` | `X.Y.Z` | `X.Y.Z-rs-nightly.N` |

Both Rust builds come from the same source. The cargo feature `nightly` (in `markie-core`, forwarded by `markie-app`) switches the name, bundle id, scheme and version in one place, `rust/crates/markie-core/src/paths.rs`. Nothing else in the code names the app.

## Where things are

| Part | Path |
|---|---|
| Identity and version | `rust/crates/markie-core/src/paths.rs` |
| Updater, no UI | `rust/crates/markie-update/` |
| When to check, the menu item, the Restart offer | `rust/crates/markie-app/src/updates.rs` |
| Bundle | `rust/scripts/bundle-mac.sh` with `MARKIE_VARIANT=nightly` |
| Build, sign, notarize, verify, zip | `rust/scripts/nightly-release.sh` |
| Feed, release verification, publish | `rust/scripts/nightly-publish.mjs` |
| Gateway lane | zvndev/markie `server/src/private-releases.ts`, `docs/PRIVATE_RELEASES.md` |

## How an update happens

1. At launch (after 20 seconds), every 4 hours, and from Markie Nightly › Check for Updates…, the app asks `https://markie-nightly.zvndev.com/private-releases/rs-nightly/rs-nightly-mac.yml` for the feed. It sends the Markie Cloud bearer token it already holds for `api.markiedocs.com`.
2. The gateway checks that token against Markie Cloud and serves the feed only to the owner. Anyone else gets a 404. Signed out, the app asks nothing.
3. The app reads the feed strictly and stops unless the version is newer than its own.
4. It downloads the one ZIP the feed names, from the same origin, and checks size and SHA-512 against the feed. Redirects are refused, not followed.
5. It checks the ZIP's entry names (everything inside `Markie Nightly.app/`, nothing through a link), then unpacks it into a private folder under its data folder.
6. macOS verifies the bundle: `codesign --verify --deep --strict`, the same against a requirement naming `com.zvn.markie.nightly`, Apple's Developer ID chain and team `3VU8SG5TD9`, the exact `TeamIdentifier`, the hardened runtime, and `spctl --assess`. The Info.plist must carry the bundle id and the feed's version.
7. The verified bundle is moved beside the installed one and the two change places in one `renamex_np(RENAME_SWAP)` call. The old bundle is kept at `~/Library/Application Support/Markie Nightly/updates/previous/Markie Nightly.app`.
8. The app offers Restart Now or Later. Until the restart, the old version keeps running.

A check that runs by itself says nothing unless it installed something. Signed out, not the owner, offline and a refused download are all silent. A check Kirby asks for always answers.

Only an installed nightly updates itself: the `nightly` feature, running from a `.app` bundle, with its real data folder and Markie Cloud. `cargo run`, a scratch `MARKIE_RS_DATA_DIR`, a local test server and the dev Markie RS build have no updater and no menu item.

## Versions

`X.Y.Z-rs-nightly.N`. `X.Y.Z` is the workspace version in `rust/Cargo.toml`. `N` counts up from 1 for each published build of that base, with no leading zero. A version is built and published once: the gateway never overwrites a ZIP, and the release script refuses a non-empty output folder.

The app shows the version in About Markie Nightly and in Settings.

## Release

Run from the checkout of `rust/markie-rs` that holds the commit to ship, with a clean tree. In a worktree under `.worktrees/`, also set `CARGO_TARGET_DIR` to that worktree's `rust/target`.

### 1. Build, sign, notarize, zip

```sh
export MARKIE_NIGHTLY_VERSION=0.1.0-rs-nightly.1
# Supplied privately by the root agent, never written to a file here:
#   APPLE_ID  APPLE_APP_SPECIFIC_PASSWORD  APPLE_TEAM_ID=3VU8SG5TD9
rust/scripts/nightly-release.sh all
```

`all` runs `build`, `sign`, `notarize` and `zip`, and `zip` runs `verify` first. Each is also a step of its own, in that order. The result is `rust/target/nightly/<version>/Markie-Nightly-<version>-arm64.zip`, beside the app it was made from.

What the steps need:

- `sign`: the certificate `Developer ID Application: Kirby Campbell (3VU8SG5TD9)` in the login Keychain. It signs with the hardened runtime and a secure timestamp. There are no entitlements: the app has no JIT, no sandbox and no nested code.
- `notarize`: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. The password is passed to `notarytool` as an argument, as electron-builder does for Electron Markie. To keep it out of the process list, store a profile once with `xcrun notarytool store-credentials` and set `MARKIE_NOTARY_PROFILE` to its name instead.
- `verify`: nothing. It checks the bundle's identity, version, single URL scheme, absence of file types, arm64 only, the commit the binary reports, then the signature, exact team, hardened runtime, timestamp, Gatekeeper and the stapled ticket.

`--dry-run` builds for real, prints the `sign` and `notarize` commands instead of running them, and runs every check that needs no credential. Its output goes to `rust/target/nightly/<version>-dry-run/` and cannot be published.

### 2. Feed and verification

```sh
export MARKIE_PRIVATE_API_ORIGIN=https://markie-nightly.zvndev.com
node rust/scripts/nightly-publish.mjs feed
node rust/scripts/nightly-publish.mjs verify
```

`feed` writes `rs-nightly-mac.yml` from the ZIP's size and SHA-512, then verifies. `verify` re-reads the feed, re-hashes the ZIP, checks its entry names, unpacks it to a temporary folder and repeats the signature, team, Gatekeeper and staple checks on what came out. It also requires that the binary reports this version and the checked-out commit.

Then run the updater's own checks on the same file. This is what an installed nightly will do with it, short of the swap:

```sh
(cd rust && MARKIE_NIGHTLY_ZIP="$PWD/target/nightly/$MARKIE_NIGHTLY_VERSION/Markie-Nightly-$MARKIE_NIGHTLY_VERSION-arm64.zip" \
  cargo test -p markie-update the_updater_accepts_the_release_zip -- --ignored)
```

If that fails, do not publish: installed copies would download the ZIP and refuse it.

### 3. Publish

```sh
# MARKIE_PRIVATE_PUBLISH_KEY supplied privately by the root agent.
node rust/scripts/nightly-publish.mjs publish
```

The same rules as the Electron lane (`scripts/private-release.mjs`):

- The key is read only from `MARKIE_PRIVATE_PUBLISH_KEY`. It is never an argument and never printed.
- One destination: `https://markie-nightly.zvndev.com/private-releases/rs-nightly/:filename`. Any other origin is refused before the key is used.
- The ZIP goes first with `If-None-Match: *`. The feed goes last.
- Each file is hashed again right before its upload. A file that changed since `verify` stops the publish.
- No redirect is followed. There is no public fallback.

A publish that is run again is safe. A 409 on the ZIP means an earlier attempt already put it there; the script goes on to the feed, and the gateway accepts the feed only if the ZIP it holds has exactly the feed's size and SHA-512.

The gateway needs the `rs-nightly` lane, which arrives with zvndev/markie PR #153. Until an image built from a commit with that PR is deployed, every publish answers 404.

### 4. First install on Kirby's Mac

The first copy is installed by hand. After that the app updates itself.

```sh
ditto -x -k rust/target/nightly/0.1.0-rs-nightly.1/Markie-Nightly-0.1.0-rs-nightly.1-arm64.zip /Applications
```

That makes `/Applications/Markie Nightly.app`. `ditto` from a terminal does not quarantine it, so macOS runs it from where it is. Kirby opens it himself and signs in to Markie Cloud in Settings with an email code. Updates begin once he is signed in.

It starts with an empty data folder of its own. The Library points at `~/Documents/Markie`, the same documents Electron Markie and Markie RS show, so nothing has to be moved.

Do not drag the app out of a Downloads folder that a browser filled: a quarantined copy runs from a temporary read-only place and cannot update itself. Check for Updates… says so when that is the case.

### 5. Check an update end to end

Publish `N+1`, then in the running `N`: Markie Nightly › Check for Updates…. It should answer that the new version is ready and offer Restart. After the restart, About shows `N+1`.

## Roll back

The updater only moves forward, so a bad nightly is fixed by publishing a good one. To get back to the previous build in the meantime:

```sh
# 1. Stop automatic checks, or the bad version comes back 20 seconds after launch.
touch "$HOME/Library/Application Support/Markie Nightly/updates/paused"
# 2. Quit Markie Nightly, then put the kept bundle back.
rm -rf "/Applications/Markie Nightly.app"
ditto "$HOME/Library/Application Support/Markie Nightly/updates/previous/Markie Nightly.app" "/Applications/Markie Nightly.app"
```

One previous bundle is kept, the one replaced by the last update. Any older version can be reinstalled from its ZIP with the `ditto -x -k` line above; a ZIP stays on the gateway and in `rust/target/nightly/<version>/`.

While `paused` exists the app checks only when asked. Then build the fix as the next `N` from a good commit, publish it, and remove the file:

```sh
rm "$HOME/Library/Application Support/Markie Nightly/updates/paused"
```

Data is not rolled back. The data folder is shared by every version of Markie Nightly.

## Tests

```sh
cd rust
cargo test -p markie-update          # feed, gateway, ZIP check, verification, swap, the whole check
cargo test -p markie-app updates     # when it runs, what it says, the relaunch helper
cargo test -p markie-core --features nightly paths   # the nightly's identity
node --test scripts/nightly-publish.test.mjs         # feed, verification, publish against a mock gateway
```

`markie-update` runs the real `ditto`, `plutil`, `codesign` and `spctl` on fixture bundles that are unsigned, ad-hoc signed and tampered, and each is refused. A fixture cannot be Developer ID signed, so the accepting path uses scripted answers for `codesign` and `spctl`; the first real signed build is what proves it.

The gateway's own tests are in zvndev/markie, `server/src/private-releases.test.ts`.

## Not yet proven

- A real signed and notarized nightly going through download, verification, swap and Restart. Step 5 above is that proof.
- Google and Apple sign-in. Markie Cloud answers `app=markie-nightly` only after zvndev/markie PR #155 deploys with markie-api. Until then the nightly signs in with an email code, and the sign-in sheet says so.
- Intel Macs, Windows and Linux are out of scope for this lane.
