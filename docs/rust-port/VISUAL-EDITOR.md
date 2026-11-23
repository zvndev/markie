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
| Task lists | 16 px box, 2 px accent edge, 4 px corners; checked is the link blue with a check in the page colour |
| Quotes | 3 px `#c084fc` rule, surface fill, right corners 6 px, muted text, 0.3 em paragraph gaps |
| Code blocks | Surface fill, doc-rule edge, 8 px corners, 1 em by 1.2 em padding, SF Mono at 0.87 em, one ink, line spacing set by the page's line height |
| Inline code | SF Mono at 0.88 em, status yellow, surface fill, doc-rule edge, 5 px corners, 0.4 em side padding |
| Links | The template's link colour, no underline |
| Marks | Strong at weight 650; strikethrough muted; underline; colour; highlight |
| Tables | Columns sized to their text; bold header cells, centred unless aligned; 0.55 em by 1 em body padding; a doc-rule line under each body row; row hover in the surface |
| Rules | 1 px doc rule, 2 em above and below |
| Pictures | Natural size, 8 px corners; selected shows a 2 px blue outline 2 px off the edge |
| Math | Display formulas centred with 1 em margins; inline formulas sit in the line |
| Video cards | 16:9, surface-2 fill, border, 8 px corners, the 68 by 48 play button, the strip with the address and the site in capitals |

### Find and section rail

- Find is the floating card at the top right: surface-2, 8 px corners, shadow, disclosure, 26 px field with `Aa` and `ab`, the count in 64 px, previous, next and close, and the replace row behind the disclosure. Match case and whole word work. The search runs once per change, not once per frame.
- The section rail draws one tick per h1, h2 and h3, 10, 6 and 4 px long, 14 px in from the page's left edge. Ticks are 24% ink at rest and 58% for the sections on screen. The rail shows from three sections and a page taller than one and a half screens, and drops deeper levels when the ticks do not fit. A click scrolls to the heading.

### Themes

All eight templates come from `themes/templates.json`, which is generated from `src/lib/theme.ts`. The page reads each template's typography and doc rule from that file, so Paper's Charter and Iowan, Studio's mono headings and 880 px column, and the rest follow without separate code. Light and dark follow the system appearance and the manual toggle, as in Electron.

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
- Tables shape each cell's text once a frame, through GPUI's line cache, and only for tables on screen.
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
