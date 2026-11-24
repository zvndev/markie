# Markie in Rust: can it do everything?

> Archived 2026-11-24. Its question (can Rust do everything) is answered and the app is built, and parts of it no longer match the code, such as Sparkle for updates. Superseded by [PLATFORMS.md](../PLATFORMS.md) and [NIGHTLY.md](../NIGHTLY.md). Kept for history: do not plan from it.

Date: 2026-11-21. Branch: `rust/markie-rs`. Code: `rust/`.

## Answer

Yes. Every feature desktop Markie has today can be built in Rust.

Three features show web content by nature: Darkmown `.wd` previews, the Live Docs site preview, and playing a YouTube or Vimeo embed. In the Rust app these run in the operating system's own web view (WebKit on Mac, WebView2 on Windows, WebKitGTK on Linux), hosted from Rust through `wry`. No Electron, no Node, and no JavaScript app code ship in the Rust build. The JavaScript inside a `.wd` document is the document's own content.

The hard part is one piece: a native rich ("View" mode) editor that keeps Markdown byte for byte and shares live rooms with the web and phone apps. Nothing off the shelf does this in Rust. It is buildable, and the plan gates it behind a short spike before committing.

## What was proven today

The fork already runs as a native app:

- Opens Markdown and shows it rendered (View) or as highlighted source (Source), with ⌘E to switch.
- Edits and saves, keeping encoding, BOM and line endings exactly. Verified by typing into a file and diffing the bytes.
- Indexes the whole home folder in the background: 107,343 documents on this Mac, every format Markie opens, searchable instantly with type filters.
- Follows light and dark mode, and remembers the choice.
- Builds as `Markie RS.app` with its own bundle id and data folder.

| Measure | Electron Markie 0.9.7 | Markie RS today |
|---|---|---|
| App size on disk | 262 MB | 25 MB |
| Memory with 107k documents indexed | not measured | 268 MB |

Memory for the Electron app was not measured, because it was not running.

## Toolkit choice

| Option | Verdict |
|---|---|
| GPUI Kit (`gpui-kit` 0.10, Zed's GPU UI plus 75 components) | **Chosen.** Code editor with tree-sitter, Markdown and HTML views, virtual lists, dock, resizable panes, themes, UI tests. Used in a shipping commercial app. Built the first window with no compile errors. |
| iced 0.14 | Solid, but far fewer ready components. We would hand-build the editor chrome. |
| Slint, egui, Freya, Floem, Xilem | Smaller component sets, or immediate-mode, or alpha. |
| Tauri (Rust shell, keep React) | Fastest port, but not "fully Rust": the UI stays TypeScript. Rejected by the brief. |

GPUI Kit pins its own GPUI build (`gpui-pre` 0.3.12, updated 2026-11-16). It needs Rust 1.99, which `rust/rust-toolchain.toml` pins for this folder only. The global toolchain is unchanged.

## Crate map

| Markie feature | Rust building block |
|---|---|
| Source editor, find, highlighting | GPUI Kit `Editor` (tree-sitter) |
| Rendered Markdown | GPUI Kit `TextView` now, our own rich editor later |
| Markdown parsing, outline | `pulldown-cmark` (in use), `comrak` for round-trip work |
| Device index, registry | Our port of `mdindex.js`; `rusqlite` with the same tables |
| Live collaboration | `yrs` (Yjs in Rust, wire compatible) and its sync protocol |
| Cloud API | `reqwest`, `tokio-tungstenite` |
| Tokens | `keyring` (Keychain, Credential Manager, Secret Service) |
| File watching | `notify` |
| Math and PDF export | `typst` (renders math to SVG and documents to PDF) |
| Office codecs | Port our own TypeScript codecs; no third-party Office engine, per the 2026-10-14 engine decision |
| Vault crypto | RustCrypto `pbkdf2`, `aes-gcm`, `aes-kw` (same format) |
| Touch ID | LocalAuthentication through `objc2` |
| Terminal (hidden today) | `portable-pty` with `alacritty_terminal` |
| Web-content islands | `wry` |
| MCP server | Keep the Node one at first; port to Rust with `rmcp` later |
| Updates | Sparkle on Mac, own feed on Windows and Linux |

## Risks, worst first

1. **Rich editor.** It must round-trip Markdown byte for byte, map to the same Yjs `XmlFragment("default")` schema that TipTap uses so web and phone users share rooms, and keep comment anchors (Yjs relative positions) valid.
2. **Data in Chromium storage.** Sign-in tokens, themes, the encrypted vault and recovery records live in Electron's localStorage and IndexedDB. A one-time migration is mandatory before anyone switches, or vault contents are lost.
3. **Office engine.** About 6,500 lines of TypeScript codecs plus a Word page layout to port.
4. **Updater.** electron-updater feeds do not carry over. The last Electron build must hand users to the new feed.
5. **GPUI churn.** The toolkit moves fast. Pin exact versions and upgrade on purpose.

## Found along the way

The device index caps the whole walk at 200,000 files. One data folder on this Mac holds 167,000 JSON files, which used the entire budget, so 30,000 Markdown files never appeared. The Rust index now keeps at most 64 data files (JSON, YAML, XML, CSV) per folder and 20,000 overall. With that change the scan finished complete: 40,480 Markdown files instead of 10,748.

The Electron `electron/mdindex.js` walk has the same rule and no cap, so the shipping app very likely has the same problem. It deserves a fix in the main app.

## Feature inventory

The full list of what desktop Markie does, with the files, protocols and on-disk formats a Rust client must match, is in `docs/rust-port/PARITY.md`.
