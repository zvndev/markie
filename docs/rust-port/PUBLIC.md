# The public Mac lane: Markie RS for Apple silicon

From 0.10.0, Markie on an Apple silicon Mac is the Rust app. Intel Macs stay on Electron, which becomes "Markie for Intel Macs". Windows and Linux stay on Electron. This is the runbook for the Rust side of that release; the nightly lane is [NIGHTLY.md](NIGHTLY.md), and the Electron side follows the same contract in zvndev/markie.

## Which Macs get what

| Mac | From 0.10.0 | Feed entry it takes |
|---|---|---|
| Apple silicon | Markie RS | `Markie-<v>-arm64.zip` |
| Intel | Electron, "Markie for Intel Macs" | `Markie-<v>-x64.zip` |

Both come from the same two feeds. An installed Electron Markie on Apple silicon picks the arm64 ZIP by name and updates itself into the Rust app through Squirrel.Mac, exactly as the nightly bridge proved. An Intel Mac picks the x64 ZIP and stays on Electron.

## Identity

| | Electron Markie stable | Markie RS, public | Markie RS, nightly |
|---|---|---|---|
| Built with | electron-builder | `cargo build --features public` | `cargo build --features nightly` |
| App, bundle id | `Markie.app`, `com.zvn.markie` | the same | the same |
| URL scheme, document types | `markie://`, Markie's 21 | the same, entry for entry | the same |
| Data folder | `~/Library/Application Support/markie` | `~/Library/Application Support/Markie App` | `…/Markie Nightly` |
| Keychain services | "Markie Safe Storage" | "Markie App", "Markie App Vault" | "Markie Nightly", "Markie Nightly Vault" |
| Cloud folder | in its profile | `~/Documents/Markie App/Cloud` | `~/Documents/Markie Nightly/Cloud` |
| Signing | Developer ID 3VU8SG5TD9, notarized | the same, hardened runtime, stapled | the same |
| Architectures | arm64 and x64 | arm64 only | arm64 only |
| Version | `0.9.x` | `0.10.0`, `0.10.0-rc.N` for candidates | `0.10.0-super-nightly.N` |
| Updates from | `latest-mac.yml` or `beta-mac.yml` | the same files | the private gateway |

The same name and bundle id make the switch an in-place update. macOS keeps the Dock icon, the default-app claims and the privacy grants, because to macOS it is the same app.

`rust/crates/markie-core/src/paths.rs` holds the identity. The `public` feature selects it; `nightly` and `public` together do not compile.

### The data folder: "Markie App"

The public app keeps its own folder, so a roll back to Electron finds Electron's profile exactly as it was.

- Not "Markie": the Mac's disk ignores letter case, so that is Electron's `markie`.
- Not "Markie RS" or "Markie Nightly": the dev build and the nightly may be on the same Mac, and their data must not mix with the public app's.
- "Markie App" reads plainly where people see it: Application Support, Keychain Access and Documents. It also stays right once Electron is gone from Apple silicon Macs.

A test in `paths.rs` checks that no two Rust folders, and no Rust folder and Electron folder, are the same to the disk.

## The feeds

The public app reads the same objects installed Electron Mac apps read. electron-builder's S3 provider builds the URL from `server/download-manifest.json`'s endpoint and bucket:

| | |
|---|---|
| Origin | `https://s3.us-east-005.backblazeb2.com` |
| Prefix | `/markie-releases/mac/` |
| Stable feed | `latest-mac.yml` |
| Early access | `beta-mac.yml`, when "Get new versions early" is on |
| Token | none. No sign-in, no gateway, no owner check |

`https://markiedocs.com/download` is the website's route to the DMGs. It does not serve the feeds (`/download/mac/latest-mac.yml` answers 404), so the app does not read it.

Each feed lists, as electron-builder writes it for both architectures:

```yaml
version: 0.10.0
files:
  - url: Markie-0.10.0-x64.zip      # Electron for Intel Macs
  - url: Markie-0.10.0-arm64.zip    # Markie RS
  - url: Markie-0.10.0-x64.dmg
  - url: Markie-0.10.0-arm64.dmg
path: Markie-0.10.0-x64.zip
```

### What the app takes, and what it checks first

`rust/crates/markie-update`, with the public lanes in `lib.rs`:

1. Read the feed with no token, no redirects, HTTPS only. A 404 is "no update".
2. The version must be `X.Y.Z`, `X.Y.Z-beta.N` or `X.Y.Z-rc.N`, and above the running version by semver. A super-nightly version is refused.
3. Take `Markie-<version>-arm64.zip` and nothing else. An x64 ZIP, a DMG or any other name is never downloaded. A feed without the arm64 ZIP offers nothing.
4. Download it from the same origin and prefix. Its size and SHA-512 must be the feed's.
5. Check the ZIP's entry names, unpack it privately, and check the bundle:
   - bundle id `com.zvn.markie`;
   - signed by Developer ID team `3VU8SG5TD9`, on Apple's chain, with the hardened runtime;
   - Gatekeeper accepts it with `source=Notarized Developer ID`;
   - its Info.plist version is the feed's.
6. Swap it in place in one step, keeping the old bundle in `~/Library/Application Support/Markie App/updates/previous/`, and offer Restart.

Checks run 20 seconds after launch, every 4 hours, and from Markie › Check for Updates…. An automatic check speaks only when it installed something.

### Early access

Settings › Advanced › "Get new versions early" is Electron's switch, and it is stored the way Electron stores it: `update-channel.json` in the data folder, `{"beta": true}`. Only a literal `true` opts in; a missing or broken file is the stable feed. The first-run import carries Electron's opt-in over, and only an explicit yes.

Electron also walks a user who leaves early access back down to stable (`leftEarlyFrom`). The Rust app does not: it never installs a lower version. A user who turns early access off stays on their build until stable passes it. Releases are promoted to stable under the same version, so this only matters for a build that is pulled from early access.

## First-run import

On its first launch the public app reads Electron stable's profile, `~/Library/Application Support/markie`, from a copy, and carries what the nightly carries: the library, settings and styles, the Markie Cloud sign-in, version history, drafts, the vault without its Touch ID slot, and the in-app documents. The full tables are in [NIGHTLY.md](NIGHTLY.md), "First-run import".

It adds one thing: the early-access choice, as above.

It never reads the super-nightly's profile, `Markie Super-nightly`. The source is `paths::ELECTRON_PROFILE`, which is `markie` for this build, and `electron_import::source_in` accepts only Electron's own folder names. Tests run the import on a made-up stable profile with a made-up nightly profile beside it, and check that nothing came from the nightly's and that neither profile changed.

## Agents: the MCP path keeps working

People have set up agents with:

```sh
claude mcp add markie -- node /Applications/Markie.app/Contents/Resources/mcp/markie-mcp.mjs
```

The public bundle keeps that path. `rust/scripts/stage-mcp.sh` lays out `Contents/Resources`:

| Path | What it is |
|---|---|
| `mcp/markie-mcp.mjs` | The path in people's settings. It hands over to the adapter |
| `markie-rs-mcp.mjs` | The adapter (`crates/markie-agent/mcp`). It runs Electron's server against this app's bridge, never Electron's, and never launches anything |
| `mcp-server/` | Electron Markie's own MCP server: the files `electron-builder.config.cjs` ships, read from one pinned commit of zvndev/markie |
| `app-identity.json` | `{"appName":"Markie","profileName":"Markie App"}`: which app and folder the adapter talks to |

The pin is `rust/scripts/mcp/PIN`. To move it, put a newer zvndev/markie commit there, fetch it (`git fetch origin main`), and run the MCP test below. The adapter refuses a server source it cannot adapt, so an incompatible change fails the test rather than a user's agent.

The nightly bundle keeps its own layout, unchanged.

`crates/markie-agent/tests/public_mcp.rs` stages that exact layout, starts a real Rust bridge in the data folder the build names, and talks MCP JSON-RPC over stdio to `node mcp/markie-mcp.mjs` with a scratch home: initialize, tools/list, a cloud call and an open call that reach the bridge, a file read through Electron's own code, and "Markie isn't running" once the bridge is gone.

## Default apps

Settings › Files › "Open with Markie" works on the public app. "Use Markie" on a format, or "Use Markie for all", calls `LSSetDefaultRoleHandlerForContentType` for every content type of the format, all roles, with `com.zvn.markie`, as Electron's `default-apps.js` does. The formats are Electron's six: Markdown, plain text, Darkmown, Word, Rich Text, OpenDocument. A test reads `electron/default-apps.js` and checks the lists match. The dev build still shows the buttons disabled.

## Release

Run from a clean checkout of the branch at the commit to ship. Only the root `AGENT_LOG.md` may be untracked.

### 1. Build, sign, notarize, ZIP, DMG, manifest

```sh
cd rust
# In a subshell, so the values reach this one command and nothing else.
# Apple's three notary values come from the Electron checkout's .env; the
# Google client, which turns on Google Docs import, is optional.
(
  set -a
  eval "$(grep -E '^(APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID)=' ~/Desktop/Coding/ZVN/markdown-viewer-zvn/.env)"
  MARKIE_GOOGLE_DESKTOP_CLIENT_ID="$(cat ~/.markie-secrets/google-desktop-client-2026-11-26/client_id)"
  MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET="$(cat ~/.markie-secrets/google-desktop-client-2026-11-26/client_secret)"
  set +a
  scripts/public-release.sh 0.10.0
)
```

Nothing prints the values: the script passes the password to `notarytool` in its argument list and never echoes the command.

The steps, in order: `build`, `sign`, `notarize`, `verify` (inside `zip`), `zip`, `dmg`, `manifest`. Each can be run alone as a second argument. `--dry-run` builds for real, skips signing and notarizing, and writes to a `-dry-run` folder that cannot be published.

The output, in `rust/target/public/<version>/`:

| File | For |
|---|---|
| `Markie-<version>-arm64.zip` | The updaters: installed Electron on Apple silicon and the Rust app itself |
| `Markie-<version>-arm64.dmg` | The download page. Signed, notarized and stapled itself |
| `release.json` | `{version, gitCommit, files: [{name, size, sha512}]}`, sha512 in base64 as electron-builder writes it |
| `Markie.app` | The verified bundle. Do not open it from here; delete it once the release is published |

`verify` requires, on the app and again on the app unpacked from the ZIP:

- the Info.plist is exactly what `scripts/mac-info-plist.mjs public` writes;
- the binary is arm64 only and reports this name, version, bundle id and commit;
- the MCP layout is the staged one, from the pinned commit;
- the signature is valid, by `Developer ID Application: Kirby Campbell (3VU8SG5TD9)`, with the hardened runtime and a secure timestamp;
- it satisfies Electron Markie's designated requirement with Squirrel's flags;
- Gatekeeper accepts it as `Notarized Developer ID`, and the ticket is stapled.

The script never uploads anything.

### 2. Check the ZIP the way an installed Markie will

```sh
(cd rust && MARKIE_RELEASE_ZIP="$PWD/target/public/0.10.0/Markie-0.10.0-arm64.zip" \
  cargo test -p markie-update the_updater_accepts_the_release_zip -- --ignored)
```

### 3. Publish

The Electron release tooling in zvndev/markie takes the folder: it builds Electron for Intel, writes `latest-mac.yml` and `beta-mac.yml` with the arm64 entries from `release.json` and the x64 entries from its own build, and uploads to `markie-releases`, early access first, then stable after the soak (`docs/RELEASING.md`). Publishing is Kirby's checkpoint.

There is no blockmap for the arm64 ZIP. electron-updater in an installed Electron app tries a differential download, finds no blockmap, and downloads the whole ZIP.

## Tests

```sh
cd rust
cargo test --workspace
cargo test -p markie-update                                   # feeds, lanes, download, bundle checks, the whole check
cargo test -p markie-app updates electron_import default_apps # lanes per build, early access, the stable import, claims
cargo test -p markie-core --features public paths            # the public identity and its data folder
cargo test -p markie-app --features public updates electron_import
cargo test -p markie-agent --test public_mcp                  # MCP over stdio, dev identity
cargo test -p markie-agent --features markie-core/public --test public_mcp   # the public identity
node --test scripts/mac-info-plist.test.mjs
```

The import tests use only made-up data: markie-migrate's fixture, written by Electron 42.11.18 from the repo's generator (regenerated for this release, MIGRATION.md), and registries the tests create.

## What only the real release proves

- That an installed Electron 0.9.x on Apple silicon takes the arm64 ZIP from the public feed and Squirrel.Mac installs the Rust bundle. The nightly proved the same path on the private lane.
- That the first-run import reads a real stable profile cleanly. It is tested on Electron-written made-up data.
- That macOS keeps the default-app claims, the Dock icon and privacy grants across the swap.
- That `LSSetDefaultRoleHandlerForContentType` takes every type on a current macOS. It is the call Electron makes, but no test claims a real type on a real Mac.

## Roll back

The ways are the nightly's ([NIGHTLY.md](NIGHTLY.md), "Roll back"), on the public feeds:

- Publish an Electron arm64 build with a higher version. The Rust updater installs it like any update: Markie's bundle id, the team's signature, notarized.
- Or point the feeds back at the last Electron release and reinstall Electron by hand.

Electron's `markie` profile was only ever read, so Electron comes back to it as it was. The Rust app's `Markie App` folder stays, and a later Rust build does not import again.
