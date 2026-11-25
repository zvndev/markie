# The Markdown page: Markie RS against Electron Markie

Date: 2026-11-22. Branch: `t3/rust-editor-visual-parity`. Reference: Electron Markie 0.9.7.

Scope: the document toolbar, the page in View mode, Source mode's frame, the find bar and the section rail. The window shell (title bar, activity bar, panels) is another agent's work.

The spec was the Electron source: `formatting-toolbar.tsx`, `doc-toolbar.tsx`, `rich-view.tsx`, `find-bar.tsx`, `section-rail.tsx`, `globals.css` and `src/lib/theme.ts`. Screenshots confirmed it. Both apps ran at 1280 by 820 on the same fixture, with every block type.

## What now matches

### Toolbar

| Part | Electron | Markie RS |
|---|---|---|
| Order | undo, redo, print, history, zoom out, percent, zoom in, narrower, width label, wider, style, font, size stepper, B I U, colour, highlight, strike, code, link, image, bullet, numbered, task, three alignments, clear | Same |
| Buttons | 28 px, 4 px corners, muted ink, accent when on, 35% when disabled | Same |
| Selects | 28 px fields, 7 px corners, 140 px wide, 112 and 104 px when compact | Same |
| Labels | Zoom `100%` in 38 px, width `Default` in 52 px, both 11 px muted | Same |
| Fitting | Below 1296 px the dividers go and "more" appears; groups that do not fit move into it, in Electron's order | Same rule, same widths |
| Steps | Zoom 50, 75, 90, 100, 110, 125, 150, 200%. Width Default, 900, 1040, 1200 px, Full | Same, from the toolbar and from the shortcuts |
| Font and size | With text selected they style the selection. With none they set the whole document's face and size, never the file | Same |
| Source mode | The row stays; zoom, width and history work, formatting has no editor | Same |

### Page

| Part | Value, from `globals.css` |
|---|---|
| Padding | clamp(1.25rem, 3vw, 2.25rem) above, clamp(1.5rem, 4vw, 3rem) at the sides |
| Column | min(100%, the template's width), centred |
| Spacing | CSS margin collapsing between blocks; an `h1` first on the page has no top margin |
| Type | The template's body face, heading face, line height, paragraph gap and size |
| Headings | 2, 1.5, 1.25, 1.1, 1 em; weights 700, 650, 600; h5 and h6 muted; hairline in the doc rule under h1 and h2 |
| Paragraphs | The template's gap above and below |
| Lists | Disc and decimal markers in the muted ink, in a 1.8 em gutter |
| Task lists | 16 px box, 2 px accent edge, 4 px corners; checked is the link blue with a check in the page colour; a finished item follows the style's `taskDone` (plain, muted, or muted and struck through every run in it, marks included) |
| Quotes | 3 px `#c084fc` rule, surface fill, right corners 6 px, muted text, 0.3 em paragraph gaps |
| Code blocks | Surface fill, doc-rule edge, 8 px corners, 1 em by 1.2 em padding, SF Mono at 0.87 em, one ink, line spacing set by the page's line height |
| Inline code | SF Mono at 0.88 em, status yellow, surface fill, doc-rule edge, 5 px corners, 0.4 em side padding |
| Links | The template's link colour, no underline |
| Marks | Strong at weight 650 in the page's ink, even inside a quote or a finished task; strikethrough muted; underline; colour; highlight |
| Tables | Chromium's automatic table layout: each column between its widest word and its longest line, sharing the room in proportion, with `min-width: 3rem` (`table_layout.rs`). One list of widths sizes the cells, the rows, the grid and the header. Words break after hyphens. Bold header cells, centred unless aligned; every cell centred top to bottom; 0.55 em by 1 em body padding; a doc-rule line under each body row; row hover in the surface. A table its words cannot fit scrolls sideways inside its box, as `display: block; overflow-x: auto` does |
| Rules | 1 px doc rule, 2 em above and below |
| Pictures | Natural size, 8 px corners; selected shows a 2 px blue outline 2 px off the edge |
| Math | Display formulas centred with 1 em margins; inline formulas sit in the line |
| Video cards | 16:9, surface-2 fill, border, 8 px corners, the 68 by 48 play button, the strip with the address and the site in capitals |

### Find and section rail

- Find is the floating card at the top right: surface-2, 8 px corners, shadow, disclosure, 26 px field with `Aa` and `ab`, the count in 64 px, previous, next and close, and the replace row behind the disclosure. Match case and whole word work. The search runs once per change, not once per frame.
- The section rail draws one tick per h1, h2 and h3, 10, 6 and 4 px long, 14 px in from the page's left edge. Ticks are 24% ink at rest and 58% for the sections on screen. The rail shows from three sections and a page taller than one and a half screens, and drops deeper levels when the ticks do not fit. A click scrolls to the heading.

### Themes

All eight templates come from `themes/templates.json`, which is generated from `src/lib/theme.ts`. The page reads each template's typography and doc rule from that file, so Paper's Charter and Iowan, Studio's mono headings and 880 px column, and the rest follow without separate code. Light and dark follow the system appearance and the manual toggle, as in Electron.

### History page (2026-11-25)

File › History… (⌥⌘Y) for a text document is Electron's super-nightly `version-history-view.tsx`, compared off screen with it (`.autoloop/runs/history-page/`, both apps' own code, the same made-up versions, 1280 by 820, light and dark):

| Part | Electron nightly | Markie RS |
|---|---|---|
| Header | 40 pt, past the traffic lights; Back arrow, the version's heading ("Today, 7:53 AM", bold when named) and the file name in 12 pt muted; Copy text; blue "Restore this version" unless it is the current version | Same |
| Document | The version full size, its changes against the version before it: words added in green, removed struck in red; a block only one side has in a green or red band with a 3 pt edge | Same marks and bands. The version is drawn by the rich view, so tables and lists look as the editor draws them, where Electron uses its HTML reading style (small-caps table headers, tighter lists) |
| Panel | 300 pt on the right: "Version history", "Which versions" (All, Named), sections Today, Yesterday, This week, months; runs of autosaves folded under a chevron; author dots; ⋯ menu (Name, Remove name, Restore, Copy text); "Highlight changes" at the foot | Same, plus Older and Newer arrows beside the title |
| Selection | Blue 16% fill (11% light) with a 70% edge | Same |

A row selects on the press. The arrows and ↑ ↓ step through the rows; the arrows dim at the ends.

### Source: Go to Line (⌥⌘G)

A strip across the top of the Source pane, as GPUI Kit's find bar is drawn there: the popover fill, a bottom hairline, "Go to line" in small muted text and a 220 pt field. Enter goes, Escape closes (`.autoloop/runs/source-keys/rs-source-goto.png`). Electron's is CodeMirror's panel at the bottom of the editor.

### Title bar: Back and Forward

Two chevrons after the wordmark, the title bar's 28 pt icon buttons with their hover; dimmed to 35% with nowhere to go (`.autoloop/runs/nav/bars.png`). Electron has none. The title bar is the shell's (VISUAL-SHELL.md); the row is library audit 29.12.

## What still differs, and why

| Difference | Why |
|---|---|
| Highlighted text is dark ink on the highlight in dark mode. Electron keeps the page's white ink on yellow, which is hard to read. | Deliberate polish. |
| Code blocks show their language only while the caret is in them. Electron never shows it. | Markie RS needs the label to change the language. |
| The size field shows the size but cannot be typed into. | The stepper and the menus set it. A typed field is the behaviour agent's to add. |
| Print is shown and disabled. | Printing arrives with phase 5's PDF export. |
| Section rail ticks do not magnify under the pointer, and there is no preview card. | Only brighten on hover so far. |
| Video thumbnails need the network, like Electron's. Vimeo has none. | Unchanged from phase 2b. |
| Display formulas come from typst, not KaTeX. Glyph shapes differ slightly; the size is tuned to match on screen. | `MATH.md`. |
| Font smoothing differs slightly. | Chromium and GPUI rasterise text differently. |
| The "more" menu lists the hidden controls by name, not the controls themselves. | GPUI Kit menus hold items, not controls. Electron moves the real controls into a popover. |
| The New York face (one template's body) needs CoreText's system serif name, and is not yet checked on screen. | macOS hides New York from font lists. |

For the window shell agent: `themes.rs` sets `link.foreground`, but GPUI Kit's key is `link`, so `theme.link` stays the default. The page now reads the link colour from the template directly, so documents are right either way.

## Speed

Nothing here adds per-frame work over what phase 2b did:

- Block margins are a match on each block's first and last node, inside the loop that already places blocks.
- The section rail reads the block tops from that same loop, and an outline cached per document version.
- Tables shape each cell's text once a frame, through GPUI's line cache, and only for tables on screen. Since the table styles pass they also measure each cell's widest word and longest line each frame, from the same shaped runs. A table is laid out for the width its box had in the last frame, and asks for one more frame when that width changes.
- Code blocks lost syntax highlighting, which was the most expensive leaf.
- The page's template style is looked up once per theme change, not per frame.

## Evidence

Under `.autoloop/runs/visual-editor/` in this worktree. Electron is on the left in each pair.

| Image | What |
|---|---|
| `sbs-dark-1.png` | Dark, top of the fixture: toolbar, headings, marks, inline code and math, lists |
| `sbs-dark-2.png` | Dark, middle: tasks, quote, code block, table, rule, h4, display math |
| `sbs-light-1.png` | Light, top |
| `sbs-light-2.png` | Light, middle |
| `rs-2c.png`, `e-2.png` | Dark, bottom: picture, video card, h5 |
| `rs-0.png`, `e-0.png` | Before this work, for comparison |

Each pair was captured at 1280 by 820 with the same `rich.md` fixture. It holds every block type: three heading levels and two more, bold, italic, strike, code, link, underline, highlight, colour, inline and display math, bullet, nested, numbered and task lists, a quote, a code block, an aligned table, a rule, a picture and a video link.

The pairs were taken before the window shell's rewrite was merged in, so the panels around the page differ. The page and toolbar are this work.

Captured in the capture pass on 2026-11-22 (`.autoloop/runs/capture-pass/`, Electron 0.9.7, 1280 by 820):

- The toolbar above Source mode matches. Source's rows were GPUI Kit's 1.5 and are now CodeMirror's 1.4 (20 pt, since GPUI rounds line heights; Electron's are 19.6 pt). Still different: Electron centres Source's text in the page column, Markie RS runs it full width (`sbs-source-dark.png`).
- The page inside the window shell matches (`sbs-rail-on-dark.png`, `sbs-pics-dark.png`).
- All eight templates match in light and dark, the New York face included (`sbs-tpl-<id>-<mode>.png`). Two fixes came out of it: list discs drawn as Chromium draws them, and struck text keeping its ink.

Polish pass on 2026-11-22 (`.autoloop/runs/polish/`, Electron 0.9.7, 1280 by 820, light and dark):

- Source's first line now sits within 1 pt of CodeMirror's. It was 12 pt high.
- Source no longer reserves Electron's 24 pt section rail column on documents too short for the rail. That had put the text 12 pt right of Electron's (`sbs-source-dark.png`, `sbs-source-light.png`).
- A `.txt`, `.text` or `.log` file opened from disk now shows as Electron's main viewer shows it: the Source editor with line numbers and the page column, and no formatting row (`sbs-txt-dark.png`, `sbs-txt-light.png`). A new text document, and JSON, YAML, XML and CSV, keep the documents workspace layout with its toolbar row, as in Electron.
- Still different, all limits of GPUI Kit 0.10.0, with the detail in `AUDIT-EDITORS.md` row 8.4:
  - The line numbers sit beside the column. GPUI Kit keeps its fold chevrons beside the text and offers no fold toggle, so a gutter at the pane's edge would split the numbers from their chevrons.
  - A scrolled document clips 20 pt below the toolbar.
  - Long lines break after `/` inside an address, where Chromium breaks before `(`. GPUI Kit wraps by UAX 14 and has no hook for another rule.

Task list pass on 2026-11-25 (`.autoloop/runs/task-list-style/`, Electron `main`, 1280 by 820):

- A tight list item that opened with bold, italic, strike or a link (`- [ ] **Lead.** text`) used to show its whole list as raw source in a bordered box. It never depended on the Markdown style: the old parser made that list unreadable in all six styles, Spacious included (`rs-before-sheet.png`). It is fixed in the parser, so every style and face gets it.
- Task items with every mark, nested, ordered and quoted task lists match Electron in all six styles, light and dark (`sbs/<style>-<mode>-sbs.png`, `rs-after-sheet.png`), and in 25 body faces (`rs-fonts-sheet.png`).
- Two drawing fixes came out of it: bold keeps the page's ink inside a muted quote or finished task, and Minimal's struck finished item strikes its bold, italic and code too.

## Table styles pass (2026-11-25)

Kirby saw rows, fills and the header stop short of a table's text in View, in the Default style with the Skills panel open, and one cell sitting higher than its row. Two causes:

- Column widths, row widths and the grid were sized from different numbers, which disagreed whenever the room changed (style, font, size, zoom, page width, pane width). They now share one list of widths from `table_layout.rs`.
- Pixel snapping shaved up to half a point off a narrow column, so a word measured to the hair wrapped onto a second line. Its row grew a line and the other cells centred in it. Each cell keeps a point of slack (`cell_edge`).

Off screen checks:

| Check | Result |
|---|---|
| `table-sweep.py run` on `fixtures/tables.md`, 75 combinations | Every table reports `ok`: rows no wider than a box that does not scroll, no cell text past the right edge, no cell narrower than a word |
| `shoot.mjs` `doc` scene, six styles at 640 and 1280 | Header alignment, vertical centring, row lines, grid and hyphen breaks match Electron's `RichView` |
| Forced overflow, zoom 150 % in a 700 pt window with the panel open | The wide table reports `scrolls` inside its own box |

Not checked: a real trackpad scroll of an overflowing table, which needs the real screen.

