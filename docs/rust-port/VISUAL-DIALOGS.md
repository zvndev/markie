# Markie RS dialogs, sheets and settings: visual parity

Date: 2026-11-22. Branch: `t3/rust-dialogs-settings-parity`. Reference: Electron Markie 0.9.7 and its source in `src/components`.

## Status in one line

Every dialog in this area is rebuilt from the Electron source, and the unit tests pass. **The Markie RS side of the screenshot comparison is not done yet.** Kirby's Mac locked overnight while this ran, and a locked screen cannot be captured. The Electron reference captures exist; the Markie RS captures and the light-mode pairs are the first open item.

## How the dialogs are drawn

All dialogs now render on one overlay layer inside the window (`workspace/overlay.rs`), not through GPUI Kit's dialog. That layer:

- paints Electron's scrim over the whole window, title bar included;
- centres the panel, or anchors it 96 pt from the top for the command palette, as Electron does;
- closes on Escape and on a click on the scrim, and gives focus back to where it was;
- opens on the next frame, with no animation or async work in between.

Colours come from the active style template in the current tone, read from the same `themes/templates.json` the shell uses. `workspace/dialog_chrome.rs` ports the overlay classes from `src/app/globals.css`, with their dark and light rules: `.markie-overlay-panel`, `.markie-overlay-close`, `.markie-overlay-section`, `.markie-segmented-control`, `.markie-select-button`, `.markie-settings-group` and `.markie-banner`. It also draws Electron's `DocumentFormatMark` file icons from the same SVG paths.

## What now matches the source

| Surface | Electron source | Markie RS |
|---|---|---|
| Settings | `settings.tsx` | 680 pt panel with 20 pt padding, and the Account, Appearance, Files and Advanced tabs with the same underline. |
| Appearance | `AppearanceSection` | Light/Dark/System segmented control. The eight template cards draw their miniature page in each template's own colours and faces, with the blue ring and check on the selected card. Also the Typography group with the specimen, Customize colors, and the "Reset to template" footer. |
| Files | `default-apps-section.tsx` | "Open with Markie" list with format marks, extensions and notes. |
| Advanced | `BetaChannelSetting`, `LinkPreviewSetting`, `CrashReportingSetting`, `servers-setting.tsx` | Updates, Links, Error reporting and Servers, with Electron's wording. |
| Account | `sign-in.tsx` (signed out) | The signed-out form: Google, Apple, the "or" rule, the email field, "Email me a code", and "Use a password instead". Every control calls `Workspace::open_account`. |
| New document | `new-document-modal.tsx` | Up to 920 pt wide with an 18 pt radius. Writing has four columns, with Markdown and Darkmown spanning two. Data and source has two columns. All ten types, the hover arrow, and arrow, Home, End and Return keys. Word, RTF and ODT start as real blank files from `markie-office`. |
| Command palette | `command-palette.tsx`, `lib/commands.ts` | 480 pt panel, "Type a command…", rows with the small-caps group and the shortcut on the right, and "No commands match". The ranking is a port of `filterCommands` and `scoreMatch`. |
| Keyboard shortcuts | `shortcuts-help.tsx` | 560 pt sheet with groups in two columns, built from the same command list, so every shortcut shown works. |
| About | `{ role: "about" }` | The standard macOS About panel, the same as Electron. |
| Version history | `history-dialog.tsx` (stable) | 520 pt "History: name" dialog. Rows show the en-US timestamp, the author, the `+N  -M` line counts, Restore, and "Show older". Restore loads the version as unsaved and never writes. |
| Outside edit | `DiskChangeStrip` | The "↻ name changed on disk." strip with Reload. With unsaved edits, Reload opens the conflict dialog. |
| Save conflict | `DiskConflictDialog` | "Save a copy…" first, then the two-click "Overwrite the file" and "Discard my changes", and "Decide later". The summary is ported from `describeDiskChange`, and copy names from `copyNameFor`. |
| Recovered draft | `draft-strip.tsx` | "Markie recovered unsaved changes from N minutes ago." with Restore and Discard. It shows only for the open document, and Restore loads the draft as unsaved. |
| Trash | Library `DeleteFileDialog` | 380 pt "Delete “name”?" dialog, with Cancel and a red-outlined "Move to Trash". |

## What still differs, and why

| Difference | Why |
|---|---|
| No backdrop blur behind the scrim | GPUI has no backdrop filter. The dim is a little stronger (72% instead of 58% plus blur) so the panel separates the same way. |
| Section labels use hair spaces for letter spacing | GPUI text has no `letter-spacing`. A hair space between capitals stands in for 0.08em. |
| Typography, Customize colors, Updates, Link previews, Crash reports and default apps are greyed with "Not in Markie RS yet" | Markie RS has none of these features yet. The default apps stay off by design: the side build must never take over double-click. |
| The Account tab is a slot | Sign-in belongs to the cloud work. `account_slot.rs` draws the signed-out form and calls `Workspace::open_account`, which `account.rs` owns. |
| History adds a diff view | Click a row to see what that save changed against the version before it, in the green and red from `version-history.css`. Electron keeps that view for its nightly builds; this is the "a little more polished" allowance. |
| Rename and Move are dialogs | In Electron, rename is inline in the title bar, and move is in the Library. Markie RS offers them as palette and menu commands, using the Library dialog's shape. Move asks only when the name is already taken, and "Keep both" never overwrites. |
| An outside edit to a clean document now shows the strip instead of reloading at once | This matches Electron. Before this change, Markie RS reloaded on its own. |
| The palette omits commands Markie RS cannot run | Export, Split mode, Find, Share, Live Docs, Vault and Connect an Agent come back as those features land. It adds Markie RS's own few: Rename, Move, Trash, Star, Outline, Add folder, Rescan, Import and About. |
| The "Recovered from Markie" list is not built | Kirby deferred it. |

## Evidence

Electron 0.9.7 reference, dark, 1280x820, scratch profile, fixture passed on the command line, under `.autoloop/runs/dialogs/`:

- `e-main.png`, `e-settings-account.png`, `e-settings-appearance.png`, `e-settings-files.png`
- `e-palette.png`, `e-newdoc.png`, `e-shortcuts.png`, `e-history.png` (empty history)

`e-settings-advanced.png` is a second capture of the Files tab: the Advanced tab click did not register in Electron. Advanced was built from the source instead.

Markie RS captures: not taken. The screen locked before they could be made (`CGSSessionScreenIsLocked = 1`), and every window capture failed for 30 minutes.

## Open items

1. Take the Markie RS captures for every dialog above, in dark and light at 1280x820, and the light Electron set. Put them side by side with `rust/scripts/screen/side-by-side.py`, then fix what they show.
2. Check the template card faces (Iowan, Charter, New York) render as named in GPUI, and check `DocumentFormatMark` text glyphs through usvg.
3. Customize colors, typography and custom presets need theme work outside this area.
4. Wire Settings > Advanced to real switches as Markie RS gains link previews and crash reports.

## Files

`rust/crates/markie-app/src/workspace/`: `dialog_chrome.rs`, `overlay.rs`, `settings.rs`, `account_slot.rs`, `palette.rs`, `file_ops.rs`, `history_dialog.rs`, `strips.rs`, `shortcuts.rs`.

Small hooks elsewhere, named for the parent merge:

- `workspace.rs`: module list, the `dialogs` field, the dialog layer and actions in `render`, and `check_disk` no longer auto-reloads. `render_banner` now calls `render_strips`, and the old history side panel is removed.
- `actions.rs`: `ShowShortcuts`, `ShowAbout`, `RichMode`, `SourceMode`, `MoveDocument`.
- `main.rs`: ⌘1, ⌘2 and ⌘/; About, Move To… and a Help menu.
- `Cargo.toml`: the `NSApplication` feature for About.
