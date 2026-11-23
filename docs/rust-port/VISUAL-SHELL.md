# Window shell: Markie RS against Electron Markie 0.9.7

Written 2026-11-21. Covers the title bar, the activity rail, the side panels it opens, the Cloud and Vault pages, and ⇧⌘F search. The formatting toolbar row and the document page belong to the editor work and are not judged here.

Both apps were compared at 1280x820, light and dark, on the same fixture folder (`welcome.md`, `table.csv`, `notes.txt`). The specification is the Electron source: `src/components/toolbar.tsx`, `activity-bar.tsx`, `library.tsx`, `library-document-filters.tsx`, `browse-view.tsx`, `global-search.tsx`, `format-badge.tsx` and `src/app/globals.css`.

## What now matches

### Title bar
- 40px tall, 82px left inset, traffic lights at x 14, y 14.
- The wordmark at 64px: the lettering in the text colour at 90% and the underline in brand red. Both layers are the same vector paths as `src/lib/brand.ts`.
- Open (or "Open file…" without a document), the file name, Export with its chevron, Copy all, the commands button, the System/Light/Dark switch, the theme palette button and Share. Each uses Electron's sizes: 28px controls, 13px and 15px icons, 12px labels, 6px radius.
- A Word, RTF, ODT or `.wd` document puts the bar in Electron's document mode: "Save file" before Export, no Copy all, and Export offers Save a Copy… (and Export PDF… when the document can print). Added 2026-11-22.
- Every icon is Electron's own SVG path, drawn from `src/icons.rs`.
- Dark mode draws the same left-to-right surface gradient. Light mode uses the flat surface.
- Clicking the file name renames the file. A dirty document shows the muted dot after its name.
- The Export menu has Electron's rows and wording: Save a Copy…, an EXPORT AS section, PDF (Dark), PDF (Light), HTML (.html), the converted formats, and the RTF and ODT note. Office documents get Save a Copy…, Export PDF… and the document PDF note.
- The commands button opens the command palette (⌘K), as Electron's does.

### Colour mode
- System, Light and Dark persist in the `color_mode` setting.
- System follows macOS through `observe_window_appearance`, including a change while the app runs.
- ⇧⌘L still toggles dark mode and stores the explicit choice, as before.
- The palette button opens a menu of the eight style templates, with swatches, descriptions and a check on the current one. A pick is stored in `style_template`.

### Activity rail
- 52px wide. It holds New file, Search, a rule, Library, Browse, Cloud, Skills, Vault, a rule and the pencil. Agents, Keyboard shortcuts and the account circle sit at the bottom.
- Buttons are 36px with a 9px radius and 18px icons.
- The active state matches Electron: the accent fill and the 3px blue bar with its glow.
- Labels appear instantly to the right on hover, with Electron's wording.
- Clicking the open panel's icon closes it. The pencil toggles back to the last panel, as in `selectLeftView`.
- ⌘L toggles the Library.

### Library panel
- 252px wide: the uppercase header with + and collapse, then the Recent and Projects segmented control.
- New document…, then the filter field ("Filter by name or folder") and the All types and Default order menus with Electron's options.
- Then the "N ON THIS DEVICE / All clear" band, the "ON THIS DEVICE" section with its count, and rows with the coloured format icon, the name, the type badge and the on-device icon.
- The signed-in prompt card sits at the bottom.
- The type and sort menus filter and sort live. Clear filters resets both.

### Other panels and pages
- Browse has the search field, the Type menu, the Name and Updated sort, the starred-only toggle, the `~/` full-path toggle and rescan.
- Browse lists folders with counts and files with Electron's "updated" wording: just now, 20m ago, 3h ago, yesterday, a weekday, a date, then a year.
- ⇧⌘F search shows Electron's scrim and 760px panel, the placeholder, the esc key cap and the eleven type chips. It lists "Recently changed" until you type and "Results" after. Rows carry the format icon, the name, the relative time and the compact folder, and ↑ ↓ ↵ esc work. The footer shows the indexed count.
- The Cloud and Vault pages take over the document area, as Cloud does in Electron. Each has the 40px icon tile, the title and a yellow "Sign in" status.
- Skills, Projects, Agents and Keyboard shortcuts show faithful empty or informational states.

### Layout
- No status bar, as in Electron. The dirty state lives in the title bar.

## What still differs, and why

### Rendering
- Text renders slightly heavier and brighter in GPUI than in Chromium. This is font smoothing, which SCREEN.md accepts.
- GPUI has no letter spacing, so the uppercase labels (LIBRARY, ON THIS DEVICE, EXPORT AS) are a little tighter than Tailwind's `tracking-wide`.
- The dark rail and panel drop Electron's faint 4px scanline texture and some inset highlight shadows. GPUI has no repeating gradients.

### Features not built yet
- Export: PDF and Word, RTF and ODT show disabled. Markie RS has no writer for them yet. HTML, Plain text, Markdown and Save a Copy… work.
- Share calls `Workspace::open_share` (`workspace/chrome.rs`). Today it only shows a notification. The cloud work replaces the body.
- The account circle calls `Workspace::open_account`, a stub in `workspace/account.rs` for the cloud sign-in work. It shows the signed-out circle; no avatar or signed-in state yet.
- Library rows have no ⋯ menu, no cloud sync states and no drag-to-import. Projects shows an empty state. Every row shows "on this device".
- The panel has a fixed 252px width; Electron's resizer is not ported.
- Browse groups files by their folder, one level, rather than Electron's nested folder tree. It also has no per-row star buttons. Folders start open, as in Electron, until you toggle one.
- Search matches names, paths and the indexed snippet through `markie_core::search`. It does not highlight matched words, and the footer does not count documents read.
- Agents and Keyboard shortcuts open GPUI Kit dialogs. Electron draws its own overlay. The Agents dialog now takes `.markie-overlay-panel`'s colours, border, shadow, centring and padding (2026-11-22); Keyboard shortcuts keeps GPUI Kit's panel chrome.
- Title bar tooltips use GPUI Kit's delayed tooltip. Electron uses native titles there too, so they are equally slow.

### Deliberate deviation
- The palette button opens a menu of the eight templates instead of Settings › Appearance, as the task asked.

### Not verified live
- System appearance following a macOS change while the app runs is wired through the window appearance observer but was not exercised. Switching macOS appearance would change Kirby's whole screen.

## Evidence

All under `.autoloop/runs/visual-shell/` in this worktree:

| Image | What it shows |
|---|---|
| `sbs-dark-start.png`, `diff-dark-start.png` | Electron and RS side by side at launch, dark |
| `cmp-tb-left.png`, `cmp-tb-right.png` | Title bar halves, Electron above RS, at 2x |
| `cmp-library-dark.png` | Library panel, Electron left, RS right, dark |
| `sbs-light-library.png` | Whole window with the Library open, light |
| `electron-dark-start.png`, `rs-dark-start.png` | The single captures behind the first pair |
| `rs-release-light-library.png`, `rs-release-dark-library.png` | The release bundle with the Library open, light and dark |
| `rs-browse.png`, `rs-search.png`, `rs-export-menu.png`, `rs-theme-menu.png`, `rs-cloud.png`, `rs-grid.png` | Markie RS's Browse, search, Export menu, theme menu and Cloud page |

Electron's Browse and search are not captured. Electron ignores a changed `HOME` and indexes the real home folder, so its Browse lists the owner's own documents. Captures of it would leak them.
