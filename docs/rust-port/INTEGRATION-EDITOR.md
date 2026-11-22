# Editor integration: the closed list

Date: 2026-11-22. Branch: `t3/markie-rs-editor-parity`, from `rust/markie-rs` at 4dd0ab3, with `rust/markie-rs` merged again at e8691b0 for item 13. Reference: Markie 0.9.7 and its source.

The Mac was locked for the whole run (`IOConsoleLocked = Yes`). There are no screenshots or side-by-sides. Behaviour was checked against the Electron source and covered by tests. Every capture still owed is listed at the end.

## Status

| # | Item | Status | Tests | Commit |
|---|---|---|---|---|
| 1 | Typed size box | Done, one stated difference | `chrome::tests` (2) | d93b9cf |
| 2 | Rail magnify and preview card | Done | `rail::tests` (3) | 2d328ef |
| 3 | "More" shows the real controls | Done, one stopgap row | `chrome::tests` (2) | b7d48e7 |
| 4 | Drag selected text to move it | Done | `editor::drag::tests` (6) | 2bfb3d6 |
| 5 | Spell check in code blocks | Done | `spell::tests` (real checker) | e989ad6 |
| 6 | Heading and list roles | Built and unit tested; the live AX read was blocked by the lock | `a11y::tests` (2) | 44f4454 |
| 7 | Source ⌘-click and ⌥-drag | Done | `source::tests` (2) | 1bdf48b |
| 8 | "Preview links on hover" switch | Done, persisted | `link_preview_tests` (1) | a97adac |
| 9 | Refused file link message | Done | wording covered by `markie_core::links` tests | a99bba0 |
| 10 | Table header-row toggle | Disabled, with Electron's reason | `table_bar::tests` (1) | 29917d0 |
| 11 | Video card plays in markie-web | Done | `video::tests` (1) | 41d4c12, 37aaac5 |
| 12 | Template fonts load | Fixed: New York and SF Mono were not loading | `font_tests` (1), `scripts/fonts-check.swift` | 0579272 |
| 13 | One toolbar across both Split panes | Done | cargo check; no view test harness | 51b4545 |

`cargo test --workspace`: 946 passed, 0 failed, exit 0. That includes the byte model's `corpus` (1), `editor_fuzz` (2) and `roundtrip` (13) suites.

## Each item

### 1. Size box

The size box in the toolbar is now a GPUI Kit input. Electron's is `<input type="number">` with min 1, max 400 and step 0.5, and each value goes through `clampFontSize`, which gives 11 to 32 px in whole pixels. With text selected, it sizes the selection. With nothing selected, it sizes the whole document. Up and Down step by one.

Difference: Electron applies and clamps every keystroke. Typing "14" there passes through 11 and ends at 32. With text selected, its `focus()` call also sends the second keystroke into the document. Markie RS applies a value while typing only once it is already 11 to 32. Enter or leaving the box applies and clamps any other value.

### 2. Section rail

These match `section-rail.tsx` and `section-outline.ts`:

- The tick under the pointer grows by 20 px. Its neighbours grow by 75, 45 and 22% of that.
- Ticks for the part on screen lose their extra pixel and their brightness while the pointer is on the rail.
- The tick under the pointer draws at 92%.
- The card is 320 px wide and sits 6 px past the longest tick, centred on its tick and kept 8 px inside the window. It shows the heading in 13 px semibold, `H1` to `H3` in 10 px mono, and the preview clamped to three lines. With no preview it reads "No text before the next heading."
- The card opens after 180 ms, then follows the pointer from tick to tick with no delay. It closes 120 ms after the pointer leaves.
- The preview follows `readRichSections`. It reads top-level blocks up to the next heading at the same level or higher, leaves code out, and is clipped like `clipSnippet`.

Not copied: the 160 ms ease of the tick length. GPUI has no CSS transform transition.

### 3. "More" popover

The "more" button now opens a 320 px popover with the real controls, as Electron's `OverflowTools` portal does:

- 8 px corners, surface-2, border and shadow, at most 60% of the window high.
- Each part that left the row is one wrapping row, in Electron's DOM order, with a rule between rows.
- Buttons show their `aria-label` after the icon in 11 px. Selects and colour pickers work as they do in the row.
- A click on a button, on the backdrop, or Escape closes it.

Stopgap: Formula, Display formula, Table and Horizontal rule are Electron's format rail buttons (`format-rail.tsx`). Markie RS has no format rail yet, so they stay as the popover's last row.

The Print button is live after the merge (the shell track's `RichEvent::Print`).

### 4. Drag to move

This is ProseMirror's drag of a text selection:

- A press inside the selection waits. A click puts the caret there.
- A drag of more than 4 px shows the caret where the text would land.
- Release moves the text there, or copies it with ⌥ (`dragCopyModifier` on macOS).
- The text that lands is selected, and one undo takes the whole move back.

Within one leaf, the units themselves move, so marks and spaces at the ends travel exactly. Across leaves, the slice travels as Markdown, as cut and paste would carry it.

Drop points are mapped through a linear position. Deleting the source shifts later positions by exactly its own length. Whole paragraphs follow ProseMirror's semantics: one empty paragraph stays behind, and the open slice joins the paragraph it lands in.

A picture drag is a node drag in ProseMirror and is not part of this.

### 5. Spell check in code

Code blocks now go through the same macOS checker and cache. Raw source blocks and the display formula's source still do not. That matches Electron, where the formula field sets `spellcheck = false`. A test runs the real checker on a two-line code block.

### 6. Accessibility roles

Each text run now sits in the containers Chromium builds for the same HTML:

- `Heading`, with its level
- `Paragraph`
- `Code`, which macOS reads as `AXCodeStyleGroup`
- `List` and `ListItem`, nested as the document nests them
- `Blockquote`

The text runs keep the `TextRun` role. AccessKit reads caret and selection ranges only from TextRun nodes, so they cannot take other roles. The unit test builds the tree for a heading, a paragraph, a nested list, a quote and a code block. It checks every role, the level and the nesting, and that no node has two parents.

The VoiceOver-free check: a debug build of Markie RS was started with a scratch `HOME` and data folder, and its tree was read through `AXUIElement` (`rust/scripts/screen/ax-tree.swift`). On the locked session, every query answered with the application element itself. The window list, the focused element and a hit test at the window's centre all came back that way, so AccessKit never activated (`MARKIE_RS_A11Y_DUMP` logged `a11y active: false`). The instance was stopped by PID. Rerun once the Mac is unlocked:

```
MARKIE_RS_A11Y_DUMP=<scratch>/ax.json <scratch launch of target/debug/markie-rs> <fixture>
swift rust/scripts/screen/ax-tree.swift <pid>
```

### 7. Source mode multiple cursors

Electron's basic setup has `allowMultipleSelections`, `rectangularSelection` and `crosshairCursor`. Source mode now takes the two mouse gestures in the capture phase, before GPUI Kit's handlers:

- ⌘-click adds a cursor.
- ⌥-drag selects a rectangle, one range per line. A line too short to reach the left column gets nothing. A rectangle with no width puts a cursor on every line.

GPUI Kit's own ⌥⇧-drag block and ⌘⌥↑ and ⌘⌥↓ still work. The Split source pane has the same gestures.

Differences:

- Columns are characters on logical lines, so a soft-wrapped line counts as one line.
- The crosshair pointer while ⌥ is held is not drawn.

### 8. Link previews switch

Settings › Advanced › Links is now Electron's `LinkPreviewSetting`. A click toggles it, and the editor follows at once. Turning it off hides a card that is up and stops a waiting fetch.

The setting is stored in Markie RS's own registry under Electron's key name, `markie.linkPreviews.v1`. Only an explicit "0" means off, as `getLinkPreviewsEnabled` reads it. Markie RS never reads Electron's storage.

### 9. Refused link message

A refused link now shows Electron's message on the page instead of writing to stderr. It is the `role="status"` pill: centred 8 px from the top, 6 px corners, 11.5 px text, gone after 6 s. The words come from `classify_click`.

A program or installer link is shown in Finder, not run. It now also says "Shown in Finder. Markie doesn't run programs or installers from a document link.", as `openAsLocalFile` does.

### 10. Table header row

Electron's Header button runs `toggleHeaderRow`. A table without a header row then fails `isMarkdownTable`, and `writeTableHTML` saves it as an HTML `<table>`. Markie RS reads HTML tables as source blocks, so the same toggle would turn the table into raw HTML on the next open.

The button stays where Electron has it, disabled. Its title gives the reason: "Toggle header row - A table without a header row can only be saved as HTML, so Markdown tables keep theirs."

### 11. Video card

A click on the card opens Electron's video lightbox (`image-lightbox.tsx`, a video with a frame):

- The window dims with the strong scrim, the page colour at 72%.
- The player sits in the middle at 16:9: `min(1120, window − 48, (window height − 96) × 16/9)` wide.
- The player is markie-web's `VideoPlayer` island: the provider's origin only, incognito storage, and links out handed to the browser.
- The round 36 px × button sits at the top right.
- Escape, the × or a click on the scrim closes it.

After the merge, the player hides whenever `Workspace::web_views_covered` is true, and while the rich pane is not shown.

Differences:

- The scrim has no 12 px backdrop blur.
- The web view has square corners.
- Escape pressed inside the player belongs to the player, as inside Electron's iframe.

### 12. Template fonts

`rust/scripts/fonts-check.swift` asks CoreText for each family the way GPUI does (font-kit's `select_family_by_name`). Results on this Mac:

| Face | Family asked for | Faces found |
|---|---|---|
| Charter | `Charter` | 6 |
| Iowan | `Iowan Old Style` | 7 |
| Georgia, Avenir, Helvetica, Optima | their names | 4, 12, 14, 5 |
| New York | `New York` | **0**, so it fell back to the system sans |
| New York | `.AppleSystemUIFontSerif` | 12 |
| SF Mono | `SF Mono` | 0 |
| SF Mono | `.AppleSystemUIFontMonospaced` | 12 |

Electron's New York stack starts with `ui-serif`. Chromium resolves that to the system serif design, `.AppleSystemUIFontSerif` (`.NewYork-Regular`). Its SF Mono stack reaches `ui-monospace`, which is `.AppleSystemUIFontMonospaced`.

Markie RS now asks for those two system names in three places:

- the page
- Settings' template previews
- selection font marks whose stack names SF Mono, `ui-monospace`, New York or `ui-serif`

Charter and Iowan load by name. No face needed Electron's further fallback (Georgia, Palatino).

### 13. One toolbar in Split

In Split, Electron draws one formatting row above both panes, and it formats the rich editor. The Split layout now asks the rich view for `split_toolbar()` and draws it above both panes. The rich pane leaves its own row out on that frame.

Unlike the row above Source, this one keeps formatting live.

## Files outside the editor crates

These are small edits in other tracks' files:

| File | Change |
|---|---|
| `markie-app/src/workspace.rs` | Source editor wrapped in `source_mouse` (item 7). One `load_link_previews` call at start (item 8). `render_split` draws the shared row and wraps its source pane (item 13). Three lines after `sync_darkmown` hide the video player (item 11). |
| `markie-app/src/workspace/rich.rs` | The `Reveal` and `Refuse` arms of `open_rich_link` (item 9). |
| `markie-app/src/workspace/settings.rs` | The links switch (item 8). The New York and mono families in the template previews (item 12). |
| `markie-web/src/island.rs` | `VideoPlayer::set_visible` (item 11). |
| `markie-editor/Cargo.toml` | Now depends on `markie-web` (wry) and `markie-export` (item 11). |

There was one merge conflict, in `markie-editor/src/chrome.rs`. The shell track enabled Print in the old toolbar code, which item 3 had rebuilt. The resolution keeps the new code with Print enabled.

## Still needs the screen

Each of these needs a capture at 1280 by 820, Electron on the left, light and dark:

1. The size box: typing, Up and Down, with and without a selection.
2. The section rail: magnified ticks and the card, at the top, middle and bottom of a long document.
3. The "more" popover at 900 px and at the narrowest width.
4. Drag and drop of a word and of two paragraphs, including the drop caret.
5. Red marks in a code block.
6. The live AX tree (`ax-tree.swift`), then the VoiceOver check below.
7. ⌘-click cursors and an ⌥-drag rectangle in Source and in Split.
8. The Settings switch, then a hovered link with it off.
9. The refused-link pill.
10. The table bar's disabled Header button and its title.
11. A YouTube card playing, then a Vimeo card, then the ⌘K palette opened over the player, which should hide it.
12. The New York template's page, next to Electron's.
13. Split with one row across both panes.

## Manual VoiceOver check for Kirby

About two minutes, in Markie RS View mode, on a document with a heading, a list and a quote:

1. Press ⌘F5 to turn VoiceOver on.
2. Press VO-⌘H (Control-Option-Command-H). VoiceOver should say "heading level 1" with the heading's text. Press it again for the next heading.
3. Press VO-⌘X. VoiceOver should jump to the list and say "list, 2 items" or similar.
4. Use VO-Right inside the list. Each item should be read on its own.
5. Type a letter in a paragraph. VoiceOver should echo it, and the caret should stay where you typed.
6. Press ⌘F5 to turn VoiceOver off.

## Unchanged on purpose

Kirby will decide these two:

- Highlighted text uses dark ink in dark mode.
- The code block's language label shows while the caret is in the block.
