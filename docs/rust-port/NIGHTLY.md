# The nightly is the Rust app

There is one nightly on the Mac, and it is the Rust app. Electron Markie's private channel, super-nightly, now carries the Rust build: Kirby's installed Electron super-nightly updates itself into it, and from then on the Rust app updates itself from the same channel.

It is not a side app. On the super-nightly channel the Rust build is Markie: the same name, bundle id, URL scheme and document types as Electron Markie, so macOS sees one app. What it does not share is data: it has a folder of its own, and it brings Electron's settings in by reading a copy.

This is the Mac only. Windows stays on Electron, and nothing here names or changes a Windows feed, a Windows build or the Windows updater.

## The three builds

| | Electron Markie (Mac, being replaced) | Markie, the Rust app on super-nightly | Markie RS (dev build) |
|---|---|---|---|
| Built with | electron-builder | `cargo build --features nightly` | `cargo build` |
| App | `Markie.app` | `Markie.app` | `Markie RS.app` |
| Bundle id | `com.zvn.markie` | `com.zvn.markie` | `com.zvn.markie.rs` |
| URL scheme | `markie://` | `markie://` | `markie-rs://` |
| Document types | Markdown, Darkmown, text, Word and the rest | the same, entry for entry | none |
| Data folder | `~/Library/Application Support/Markie Super-nightly` (stable: `markie`) | `~/Library/Application Support/Markie Nightly` | `…/Markie RS` |
| Keychain | "Markie Safe Storage" | services "Markie Nightly" and "Markie Nightly Vault" | "Markie RS", "Markie RS Vault" |
| Cloud folder | in its profile | `~/Documents/Markie Nightly/Cloud` | `~/Documents/Markie RS/Cloud` |
| Signing | Developer ID, notarized | Developer ID, notarized, same team | ad hoc |
| Updates from | super-nightly lane | super-nightly lane | nothing |
| Version | `0.9.8-super-nightly.2` was the last | `0.10.0-super-nightly.N` | `0.10.0` |

One switch decides which Rust build comes out: the cargo feature `nightly`, read in `rust/crates/markie-core/src/paths.rs`. That file separates two things:

- what the person and macOS see: `APP_NAME`, `BUNDLE_ID`, `URL_SCHEME`
- the build's own places: `PROFILE_NAME`, which names the data folder, the Keychain services and the cloud folder

`PROFILE_NAME` is never one of Electron's folders. Electron's stable profile is `markie`, which a Mac's disk also reads as `Markie`, so the data folder cannot be named for the app. A test in `paths.rs` compares the names the way the disk does.

## Where things are

| Part | Path |
|---|---|
| Identity, version, profile name | `rust/crates/markie-core/src/paths.rs` |
| Info.plist with Markie's document types | `rust/scripts/mac-info-plist.mjs`, reading `electron-builder.config.cjs` |
| Updater, no UI | `rust/crates/markie-update/` |
| When to check, the menu item, the Restart offer | `rust/crates/markie-app/src/updates.rs` |
| First-run import | `rust/crates/markie-app/src/electron_import.rs`, on `rust/crates/markie-migrate` |
| Bundle | `rust/scripts/bundle-mac.sh` with `MARKIE_VARIANT=nightly` |
| Build, sign, notarize, verify, zip | `rust/scripts/nightly-release.sh` |
| Feed, release verification, publish, re-point | `rust/scripts/nightly-publish.mjs` |
| The bridge, tested against Electron's own code | `rust/scripts/bridge.test.mjs` |
| Gateway lane | zvndev/markie `server/src/private-releases.ts`, unchanged |

## The channel

The Rust app ships on the existing super-nightly lane of the private gateway. The server did not change.

| | |
|---|---|
| Gateway | `https://markie-nightly.zvndev.com` |
| Prefix | `/private-releases/super-nightly/` |
| Feed | `super-nightly-mac.yml`, electron-builder's format |
| Artifact | `Markie-X.Y.Z-super-nightly.N-arm64.zip` |
| Blockmap | none. A private Electron build sets `disableDifferentialDownload`, and the Rust updater downloads whole files |
| Version | `0.10.0-super-nightly.N`, N from 1. `0.10.0` is the workspace version in `rust/Cargo.toml` |

`0.10.0` is above `0.9.8-super-nightly.2` by semver, which is how electron-updater compares. The publisher refuses any version that is not above `0.9.8-super-nightly.2`, because the installed Electron app would never see it as an update.

## The bridge: Electron updates itself into Rust

What happens on Kirby's Mac once the first Rust build is published:

1. The installed Electron super-nightly checks the channel ten seconds after launch and every six hours, or when asked. It asks the gateway for `super-nightly-mac.yml` with its Markie Cloud token.
2. electron-updater reads the feed, sees a version above its own, and downloads the arm64 ZIP from the same prefix. It checks the ZIP's SHA-512 against the feed.
3. Markie says an update is ready. Restart & Update hands the ZIP to Squirrel.Mac.
4. Squirrel.Mac unpacks it, takes the application bundle whose bundle identifier is `com.zvn.markie`, and checks its code signature against the running app's designated requirement.
5. ShipIt waits for Markie to quit, puts the new bundle at `/Applications/Markie.app`, and starts it. What starts is the Rust app.
6. The Rust app's first launch imports from the Electron profile ("First-run import" below).

### What is proved without publishing

| Claim | How it is proved |
|---|---|
| The Rust bundle's identity is Markie's | `rust/scripts/mac-info-plist.test.mjs`: bundle id, name, `markie://` and all 21 document types equal what Electron Markie 0.9.8-super-nightly.2's own Info.plist declares (a copy of those entries is `rust/scripts/fixtures/electron-markie-info.json`) |
| The requirement the Rust build is signed to satisfy is Electron's | The requirement in `nightly-release.sh` equals `codesign -d -r-` of the installed `/Applications/Markie.app`, and the `verify` step checks that again, read only, on the Mac it runs on |
| A bundle signed by this team under this bundle id satisfies it | In two halves, on real bundles, with the exact command the scripts run. A Rust bundle signed by the real signing step (the retired `0.1.0-rs-nightly.2`) passes every clause but the identifier: Apple's Developer ID chain and team `3VU8SG5TD9`. A Rust bundle built with the new identity passes the identifier clause. The installed Electron app passes the whole requirement; another identifier or team fails it |
| The Rust binary starts under the hardened runtime | The dry-run bundle, ad-hoc signed with the runtime flag, runs `--version`. No window was opened, so this covers loading, not the app running |
| electron-updater asks for our feed and reads it | `bridge.test.mjs` runs electron-updater 6.8.11 from a zvndev/markie checkout: its generic provider requests `super-nightly-mac.yml` under the lane prefix, parses the feed this publisher writes into the same fields as a feed Electron's own publisher wrote, and resolves the arm64 ZIP's URL under the only prefix the installed app allows |
| It sees the Rust version as an update | The same test, with electron-updater's own `semver`: `0.10.0-super-nightly.1` is above `0.9.8-super-nightly.2`, build numbers compare as numbers, and the reverse is never an update |
| The gateway takes the Rust build with no server change | The same test publishes with `nightly-publish.mjs` to the real gateway code in-process, beside an Electron build already on the lane, then reads both files back as the owner. Anyone else gets a 404 |
| The ZIP is laid out as Squirrel.Mac expects | The same test unpacks the ZIP and runs Squirrel's search: one application bundle, bundle id `com.zvn.markie`, nothing beside it. `nightly-release.sh zip` and `nightly-publish.mjs verify` repeat it on the real ZIP |
| Squirrel has no reason to refuse the version | The installed app has no `ElectronSquirrelPreventDowngrades` key, so Squirrel compares no versions. If it did, `0.9.8…` to `0.10.0…` is an upgrade under its numeric comparison |
| The Rust updater's checks pass a real signed bundle | Run by hand: its real `codesign`, `spctl` and plist checks accept the real, notarized Electron `0.9.8-super-nightly.2` ZIP. That is also the roll back direction |

### What only the real publish proves

- That a Developer ID signed Rust bundle passes the requirement. The signing step makes it true; `nightly-release.sh verify` checks it before any ZIP exists.
- That Squirrel.Mac and ShipIt install the Rust bundle over Electron and start it. This has never run. Their checks were read from Squirrel.Mac's source and from the framework inside the installed app, not exercised.
- That macOS keeps treating the swapped app as the same app: the Dock icon, the default-app choices, `markie://` links, and privacy grants.
- That the first-run import reads Kirby's real profile cleanly. It is tested on a profile Electron 42 wrote from made-up data, and an earlier read of a copy of his profile decoded without error (MIGRATION.md).
- That the Rust app then updates itself from the same feed. Each piece is tested; the whole has not run against the live gateway.

So the first publish is the test. Do it when Kirby can watch, with "Roll back" below open.

## How the Rust app updates itself

1. At launch (after 20 seconds), every 4 hours, and from Markie › Check for Updates…, it asks the gateway for `super-nightly-mac.yml` with the Markie Cloud token it holds. The first-run import carries that token over from Electron, so updates work from the first launch.
2. The gateway serves the feed only to the owner. Anyone else gets a 404. Signed out, the app asks nothing.
3. It reads the feed strictly and stops unless the version is above its own.
4. It downloads the arm64 ZIP the feed names, from the same origin, refusing redirects, and checks size and SHA-512.
5. It checks the ZIP's entry names (everything inside `Markie.app/`, plain ASCII, nothing through a link) and unpacks it into a private folder.
6. macOS verifies the bundle: the same designated requirement, the exact team, the hardened runtime, Gatekeeper. The Info.plist must carry `com.zvn.markie` and the feed's version.
7. The verified bundle and the installed one change places in one `renamex_np(RENAME_SWAP)`. The old bundle is kept at `~/Library/Application Support/Markie Nightly/updates/previous/Markie.app`.
8. It offers Restart Now or Later.

It installs whatever the channel publishes under Markie's identity. That is normally the next Rust build. It can be an Electron super-nightly with a higher version, which is the roll back.

A check that runs by itself is silent unless it installed something. Only the installed nightly updates itself: `cargo run`, a scratch `MARKIE_RS_DATA_DIR`, a local test server and the dev build have no updater.

## Release

Run from a clean checkout of `rust/markie-rs` at the commit to ship. In a worktree under `.worktrees/`, also set `CARGO_TARGET_DIR` to that worktree's `rust/target`.

Before the first Rust super-nightly, remove the retired side app, which nothing updates any more:

```sh
rm -rf "/Applications/Markie Nightly.app"
```

### 1. Build, sign, notarize, zip

```sh
export MARKIE_NIGHTLY_VERSION=0.10.0-super-nightly.1
# Supplied privately by the root agent, never written to a file here:
#   APPLE_ID  APPLE_APP_SPECIFIC_PASSWORD  APPLE_TEAM_ID=3VU8SG5TD9
rust/scripts/nightly-release.sh all
```

`all` runs `build`, `sign`, `notarize` and `zip`, and `zip` runs `verify` first. The result is `rust/target/nightly/<version>/Markie-<version>-arm64.zip`.

- `sign` needs the certificate `Developer ID Application: Kirby Campbell (3VU8SG5TD9)` in the login Keychain. Hardened runtime, secure timestamp, no entitlements.
- `notarize` needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, or `MARKIE_NOTARY_PROFILE` naming a `notarytool store-credentials` profile, which keeps the password out of the process list.
- `verify` needs nothing. It checks that the Info.plist is exactly what `mac-info-plist.mjs` writes, the commit the binary reports, the signature, the bridge requirement with Squirrel's flags (`--deep --strict --all-architectures -R`), the exact team, the hardened runtime, Gatekeeper and the staple. It also compares the requirement with the installed `/Applications/Markie.app`, read only.

`--dry-run` builds for real, prints the `sign` and `notarize` commands, and runs every check that needs no credential. Its output goes to `rust/target/nightly/<version>-dry-run/` and cannot be published.

The build folder holds a `Markie.app` with Markie's bundle id. Do not open it from there. Delete the folder's `Markie.app` once the ZIP is published, so macOS has one Markie to find.

### 2. Feed and verification

```sh
export MARKIE_PRIVATE_API_ORIGIN=https://markie-nightly.zvndev.com
node rust/scripts/nightly-publish.mjs feed
node rust/scripts/nightly-publish.mjs verify
(cd rust && MARKIE_NIGHTLY_ZIP="$PWD/target/nightly/$MARKIE_NIGHTLY_VERSION/Markie-$MARKIE_NIGHTLY_VERSION-arm64.zip" \
  cargo test -p markie-update the_updater_accepts_the_release_zip -- --ignored)
MARKIE_ELECTRON_CHECKOUT=~/Desktop/Coding/ZVN/markdown-viewer-zvn node --test rust/scripts/bridge.test.mjs
```

`feed` writes `super-nightly-mac.yml`. `verify` re-hashes the ZIP against it, checks the entry names, unpacks it and repeats the identity, signature, bridge, Gatekeeper and staple checks on what came out. The `cargo test` line runs the Rust updater's own checks on the same file. The last line runs the bridge tests against Electron's own updater and gateway code.

If any of the four fails, do not publish.

### 3. Publish

```sh
# MARKIE_PRIVATE_PUBLISH_KEY supplied privately by the root agent.
node rust/scripts/nightly-publish.mjs publish
```

The rules are the Electron lane's: the key only from `MARKIE_PRIVATE_PUBLISH_KEY`, one closed destination, the ZIP first with `If-None-Match: *`, the feed last, each file hashed again before its upload, no redirects, no public fallback. A publish run again is safe: a 409 on the ZIP means it is already there, and the gateway accepts the feed only if the ZIP it holds matches.

The moment the feed lands, the installed Electron super-nightly can see the update.

### 4. The hand-over on Kirby's Mac

Nothing is installed by hand. In the running Electron Markie: Markie › Check for Updates…, wait for "ready", Restart & Update. What comes back is the Rust app, as version `0.10.0-super-nightly.1` in About Markie.

On that first launch it imports from the Electron profile and says what it brought. The vault asks for its passphrase once.

### 5. Then check a Rust to Rust update

Publish `N+1`. In the running Rust app: Markie › Check for Updates…. It should say the new version is ready and offer Restart.

## First-run import

On its first launch the Rust nightly reads the Electron profile of its channel, `~/Library/Application Support/Markie Super-nightly`, and carries over what it can use. It is tried once; Import from Markie in the command palette runs it again.

Two rules hold throughout, and tests pin both:

- Electron's profile is only read. Its Chromium stores are copied into a scratch folder inside the Rust app's own data folder and decoded there, then the scratch folder is deleted. Its registry is copied before it is opened. Nothing in the Electron profile is created, changed or deleted.
- Nothing the Rust app already has is replaced. A setting is written only if unset, a sign-in only for a server with no session, the vault only if there is none, a file only if it is not there. A second import changes nothing.

### Carried

| What | From | To |
|---|---|---|
| Recent files, Library folders, stars | `registry.db` | the Rust registry |
| Theme and Markdown styles | localStorage `markie.themes.v1` | setting `themes.v1`, the same JSON |
| Light, dark or system | `markie.colormode.v1` | `color_mode` |
| This computer's code font | `markie.fonts.v1` | `fonts.v1` |
| Link previews on or off | `markie.linkPreviews.v1` | the same key |
| Cloud page source filters | `markie.cloud.sources.v1` | `cloud_sources` |
| The Markie Cloud sign-in, and sign-ins to added servers | `markie.token.v1` and friends | the Keychain, service "Markie Nightly". The confirmed account comes along only where the server had confirmed exactly that token |
| The vault | IndexedDB `markie-encrypted-vault` | `vault.json`, the same snapshot at the same revision, without its Touch ID slot |
| Version history | `snapshots/` | `snapshots/`, the same format |
| Unsaved drafts | `drafts/` | `drafts/` |
| Comments and notes kept beside documents | `doc-meta/` | `doc-meta/` |
| Added servers | `servers.json` | `servers.json` |
| What agents were allowed | `agent-permissions.json` | the same |
| Live Docs projects | `live-docs-projects.json` | the same |
| Documents kept inside the app | IndexedDB `markie-document-library` | files in `~/Library/Application Support/Markie Nightly/Imported Documents` |

### Not carried

| What | Why |
|---|---|
| Touch ID for the vault | Its secret sits under Electron's own Keychain item. The first unlock takes the passphrase, then Touch ID can be turned on again |
| The cloud sync switch | Sync starts off, so the first sync is one the person asks for |
| The private-build unlock | This app has no lock. Updates ask the gateway with the Markie Cloud sign-in |
| Window and panel layout | Library tab, Browse sort and filters, panel widths: this app keeps its own |
| Document zoom | Electron's per-document zoom has no counterpart setting here |
| Rich-mode consents | This app asks again when it would change a file's formatting |
| The media cache | Re-fetched on demand |
| Recovery copies of in-app documents | The documents themselves are carried; their older revisions are not |

The in-app documents land in the data folder, not in the Library. Putting 50 files into someone's Documents without asking is a product decision, so that one is Kirby's.

Both apps now hold the same Markie Cloud session. Signing out in one signs the other out too, which matters only for a roll back.

## Roll back

After the hand-over, an Electron build with a lower version just updates back into Rust: the feed is above it. So a roll back has to deal with the feed. There are two ways.

### A. Publish an Electron super-nightly above the Rust build

This moves every install back, by itself, the way it came. The Rust updater installs it like any other update: the bundle has Markie's identity and the team's signature, and its checks are known to pass a real Electron ZIP.

In zvndev/markie, at the Electron commit to go back to:

```sh
export MARKIE_PRIVATE_API_ORIGIN=https://markie-nightly.zvndev.com
export MARKIE_PRIVATE_VERSION=0.10.1-super-nightly.1   # above every Rust build published
node scripts/private-release.mjs build
node scripts/private-release.mjs verify
node scripts/private-release.mjs publish-private
```

Then in the running Rust app: Check for Updates…, Restart. Electron comes back and opens its own profile, untouched since the hand-over.

The next Rust build must then be above that: raise the workspace version in `rust/Cargo.toml` (say `0.10.2`) and publish `0.10.2-super-nightly.1`.

### B. Reinstall Electron by hand and point the feed back at it

For when the Rust app will not start or will not update.

```sh
# 1. Point the channel's feed back at the last Electron build. Its ZIP is still
#    on the gateway; this replaces the feed only. Electron then sees itself as
#    current, and no Rust install is offered anything.
export MARKIE_PRIVATE_API_ORIGIN=https://markie-nightly.zvndev.com
export MARKIE_NIGHTLY_REPOINT_FEED=~/Desktop/Coding/ZVN/markdown-viewer-zvn/.release/private-artifacts/0.9.8-super-nightly.2/super-nightly-mac.yml
# MARKIE_PRIVATE_PUBLISH_KEY supplied privately.
node rust/scripts/nightly-publish.mjs repoint

# 2. Quit Markie, then put the Electron build back.
rm -rf /Applications/Markie.app
ditto -x -k ~/Desktop/Coding/ZVN/markdown-viewer-zvn/.release/private-artifacts/0.9.8-super-nightly.2/Markie-0.9.8-super-nightly.2-arm64.zip /Applications
```

Do step 1 first. Without it the reinstalled Electron build updates back into Rust ten seconds after it starts.

`npm run markie:use -- public` in zvndev/markie is the other hand route: it installs the public Electron build, which never reads the private channel at all and opens the stable profile.

To go forward again after B, publish a Rust build as usual. Its feed replaces the re-pointed one.

### What a roll back does not undo

- The Rust app's data folder, `Markie Nightly`, stays. A later Rust build finds it and does not import again.
- Electron's profile was never written, so it is as it was at the hand-over. Anything done in the Rust app since then is in the Rust folder only. Documents are ordinary files and are the same for both.
- A Rust to Rust update can also be undone locally: the previous bundle is at `~/Library/Application Support/Markie Nightly/updates/previous/Markie.app`. Create `…/Markie Nightly/updates/paused` first, or the app updates again 20 seconds after launch.

## The public Mac lane

Built: [PUBLIC.md](PUBLIC.md). The public app is a third identity in `paths.rs` (the `public` feature): the same name, bundle id, scheme and document types, its own data folder `Markie App`, the import from Electron stable's `markie` profile, and the public store's `latest-mac.yml` and `beta-mac.yml` with no token. It takes only the arm64 ZIP; Intel Macs stay on Electron. Its bundle keeps Electron's MCP path, `Contents/Resources/mcp/markie-mcp.mjs`, working, and its Settings claim default apps. `rust/scripts/public-release.sh` builds it.

The nightly keeps its identity, its gateway feed, its bundle layout and `nightly-release.sh`. Two shared changes reach it too: the updater now also requires Gatekeeper to accept a download as `Notarized Developer ID`, which every published nightly is, and Settings › Files claims default apps on both Mac builds.

## Tests

```sh
cd rust
cargo test -p markie-update                       # feed, gateway, ZIP check, verification, swap, the whole check
cargo test -p markie-app updates                  # when it runs, what it says, the relaunch helper
cargo test -p markie-app electron_import          # the first-run import, on a synthetic Electron profile
cargo test -p markie-core --features nightly paths   # the nightly's identity and its data folder
node --test scripts/nightly-publish.test.mjs scripts/mac-info-plist.test.mjs
MARKIE_ELECTRON_CHECKOUT=<zvndev/markie checkout, npm ci done> node --test scripts/bridge.test.mjs
```

The import tests use only made-up data: the profile in `rust/crates/markie-migrate/tests/fixtures`, written by Electron 42 from the repo's own fixture generator, and a registry the test creates. No test reads a real profile.
