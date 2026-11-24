# Markie RS

The native Rust build of desktop Markie, on branch `rust/markie-rs`. It is taking over from Electron on the Mac. Built with `--features nightly` it is Markie itself on the Mac super-nightly channel. The default build is the dev app, `Markie RS.app`, with its own name and data. It is not part of the Electron release pipeline.

- Every Rust-port doc, with its status (current, reference or archived): `docs/rust-port/README.md`. Check it before planning from a doc.
- The platform plan: `docs/rust-port/PLATFORMS.md`
- The parity score: `docs/rust-port/SCORE.md`
- What desktop Markie does today, feature by feature: `docs/rust-port/PARITY.md`
- Markdown styles and the font library, and how their data is regenerated from Electron: `docs/rust-port/STYLES-FONTS.md`
- The nightly: this app as Markie itself on the Mac super-nightly channel, how Electron Markie updates into it, the first-run import and the roll back: `docs/rust-port/NIGHTLY.md`

## Layout

| Path | What it is |
|---|---|
| `crates/markie-core` | No UI. Formats and lossless text decoding, the device index, search, atomic save, outline, stats, the registry. |
| `crates/markie-app` | The GPUI window: Library, document pane, status bar, menus and shortcuts. |
| `scripts/bundle-mac.sh` | Builds `target/release/Markie RS.app` for local testing. |
| `crates/markie-update` | The updater of the Mac app on the super-nightly channel: feed, download, verification, atomic swap. No UI. |
| `crates/markie-migrate` | Reads a copy of an Electron Markie profile. The first-run import (`markie-app` `electron_import.rs`) is built on it. |
| The other `crates/markie-*` | The rich editor (`markie-rich`, `markie-editor`), math, the Office engine and page view, export, the cloud client, the vault, web islands and the agent bridge. The docs index names the doc for each. |
| `scripts/nightly-release.sh`, `scripts/nightly-publish.mjs`, `scripts/mac-info-plist.mjs` | Build, sign, notarize, zip and publish the Mac app (`--features nightly`) on the super-nightly channel. Runbook: `docs/rust-port/NIGHTLY.md`. |
| `rust-toolchain.toml` | Pins Rust 1.99 for this folder only. GPUI Kit needs it. |

## Commands

```sh
cargo test -p markie-core
cargo run -p markie-app -- path/to/file.md
./scripts/bundle-mac.sh
```

`MARKIE_RS_DATA_DIR=/some/folder` keeps a test run's registry out of the real data folder.

## Shortcuts

| Keys | Action |
|---|---|
| ⌘O | Open |
| ⇧⌘O | Add a folder to the Library |
| ⌘N | New document |
| ⌘S | Save |
| ⌘E | Switch View and Source |
| ⌘1, ⌘2, ⌘3 | View, Source, Split |
| ⌘K | Command palette |
| ⇧⌘F | Search all documents |
| ⌘P | Print |
| ⌘L | Show or hide the Library |
| ⌘R | Rescan |
| ⇧⌘L | Light or dark |
