# Markie RS: web islands, export and print

Date: 2026-11-22. Branch: `t3/markie-rs-web-export-parity`, merged from `rust/markie-rs` at 749c416.

Covers PARITY.md sections 18 (Darkmown `.wd`), 19 (Live Docs), 23 (export, print and converted copies) and the "Things that inherently need web content" summary.

## Summary

Exports are byte-identical to Electron where Electron's output is bytes, and laid out like Chromium where it is a page.

| Area | Result |
|---|---|
| Export HTML markup | Matches Electron's `renderMarkdownHTML` for every fixture, math and highlight tokens aside |
| Word, RTF, ODT, text, Markdown copies | Byte-identical to Electron's `convertForExport` for every fixture |
| Darkmown preview document | Byte-identical srcdoc and warnings for 29 fixtures in 5 frame variants |
| PDF | Typst driven with Chromium's CSS box model; every fixture line within 1 pt of Electron's, on the same page |
| Print | The macOS print sheet over the same PDF |
| Live Docs | Projects, tree, read and write with revisions, and the dev server, ported; no in-app panel yet |

## Crates and files

| Path | What it is |
|---|---|
| `rust/crates/markie-export` | Pure: Markdown to sanitized HTML, the export page, picture inlining, converted copies, PDF and Office PDF through Typst |
| `rust/crates/markie-web` | Pure: Darkmown limits, sanitizer and preview document, JavaScript-exact JSON, Live Docs projects and runner. Feature `wry`: the islands |
| `markie-app/src/workspace/export.rs` | `Workspace::export_document(kind)`, Print, the File menu actions |
| `markie-app/src/workspace/darkmown.rs` | The `.wd` editor: source, preview frame, trust, reset, warnings |

Shell files changed, each minimally: `chrome.rs` (its `export()` calls `export_document`; PDF, Word, RTF, ODT and the document-mode "Export PDF…" are enabled), `workspace.rs` (one field, one sync call, one render arm, four action handlers), `actions.rs` and `main.rs` (Print on ⌘P and a File > Export submenu).

## Section 18: Darkmown `.wd`

| Item | Status | Notes | Tests |
|---|---|---|---|
| Edit source, view a compiled preview: Source, Preview, Split | Matches | Split is the default. The mode switch is in the preview header; Electron switches through its view commands. | not yet seen in a window (see Evidence) |
| Compile | Matches | Electron's pinned `compiler-browser.mjs` runs once per edit in a disposable hidden web view with a hashed-script CSP and no network, the counterpart of Electron's worker. 10 s budget, same error texts. | `island::tests` |
| Source limits before compiling | Matches | `validateDarkmownPreviewSource` ported; same messages. | `darkmown_golden` (STOPS cases) |
| Sanitizer: what gets switched off | Matches | `sanitizeDarkmownBody` ported rule for rule; same warning text. `:fetch` is always removed (the Mac preview is offline in Electron too). | `darkmown_golden`: 29 fixtures × 5 variants, srcdoc byte for byte |
| Trust step, edits revoke trust, Reset state, Revoke trust, Retry preview | Matches | Trust is pinned to the exact text, as Electron pins epoch, text and generation. | not yet seen in a window (see Evidence) |
| Preview frame sandbox | Matches | Host page holds a `srcdoc` iframe with `sandbox="allow-scripts"` or empty, opaque origin, no navigation, no popups; non-persistent store, no devtools, no clipboard. Host CSP names only the pinned hashes. | `pinned_hashes_match_the_scripts` |
| Theme message into a running frame | Matches | Same `markie:preview-theme` message. | |
| "Make Interactive" (.md to unsaved .wd) | Not built | Needs unsaved documents in the shell's document model. | |
| Pictures beside the file, links to the browser [nightly] | Built, off by default | `MARKIE_RS_NIGHTLY=1` turns them on: random `markie-asset://wd-<hex>` scope per folder, link bridge checked by sender, shape and user activation, then `darkmownLinkTarget` again in Rust, one link per 400 ms. | `links::tests`, `darkmown_golden` (links variants) |
| Overlays over the frame | Differs | A system web view sits above GPUI, so the frame hides while a title-bar menu is open. Other GPUI overlays (palette, dialogs) can still be covered. | |

## Section 19: Live Docs

| Item | Status | Notes | Tests |
|---|---|---|---|
| Project list in the data folder, add, remove | Matches | Same store shape (`version: 1`), same refusals (`too-broad`, `not-a-project`, limit of 50). Stored in Markie RS's data folder, never Electron's. | `projects::tests` |
| Open project, tree, read, write with revision checks | Matches | Hidden names, symlinks, hard links, 2 MB cap, UTF-8 only, write only at the read revision, atomic rename. | `projects::tests` |
| Watch for outside changes | Not built | Electron uses `fs.watch`; the panel that would show it is not built. | |
| Run `darkmown dev`, Node through the login shell | Matches | Same PATH probe, Node 20 check, the watchdog script verbatim, loopback port, readiness probe on `/__wd/dev-client.js`, stop by process group. | `starts_and_stops_a_dev_server` (real Node, fake CLI) |
| Live site in a native view | Built, not wired | `island::SitePreview`: navigation only inside the server origin, web links to the browser, downloads refused. | |
| Live Docs panel (project tree, tabs) | Not built | Nightly in Electron. The shell has no Live Docs rail entry yet. | |

## Section 23: export, print and converted copies

| Item | Status | Notes | Tests |
|---|---|---|---|
| Markdown to export HTML | Matches | remark, GFM, strict math, rehype-raw, media, embeds, highlight, sanitize, contain-styles in Electron's order. Dollars pair by remark's strict rule, ported as a source pre-pass. | `render_golden` (all fixtures equal after normalising math and token spans) |
| Math | Differs by design | markie-math SVG (the editor's renderer, MATH.md) in KaTeX's wrappers, instead of KaTeX HTML and its 240 KB font CSS. Bad TeX shows red, as KaTeX does. | `math_is_svg_from_markie_math`, `bad_math_is_red_text_not_a_failure` |
| Code highlighting | Matches on the corpus | syntect scopes mapped to highlight.js classes with highlight.js's per-language choices and cross-token modes (parameters, arrow functions, class references, keys). Every character of 13 blocks in 11 languages gets Electron's colour. Other languages can still differ. | `code_colours_match_highlight_js`, `code_blocks_get_the_hljs_class` |
| Export HTML file | Matches | `buildPDFHTML` light page, CSS and fit script extracted verbatim; local pictures inlined by `inline-images.js`'s rules and limits. | `assets::tests` |
| PDF (Dark) and PDF (Light) | Matches | Typst laid out with Chromium's CSS box model, computed in Rust: line boxes from CoreText ascent and descent with the leading split around them, collapsed margins, borders and padding, table half-borders, orphans and widows of 2 with the three-line exception. A4, the 2 cm × 2.2 cm inset as page margin, dark page to the edges, SF Pro with CoreText's `trak` tracking, Menlo for code. Every line of every fixture lands on Electron's page within 1 pt (`.autoloop/runs/native-print/`). | `line_baselines_match_chromium`, `layout_rules_measured_from_chromium` |
| PDF: a picture that cannot load stops the export | Matches | Same message. Remote pictures load with an 8 s deadline. | `a_missing_picture_stops_the_export` |
| PDF: in-paragraph line boxes | Matches | A line holding a superscript, subscript or inline code grows as Chromium's does: each inline box's edges are given to Typst. | `line_baselines_match_chromium` |
| Video and audio in PDF | Differs | Drawn as a black 300 × 150 px box and a grey audio pill, where Chromium draws its player chrome. | |
| Print (⌘P) | Matches | Same PDF in the app's current tone on the macOS print sheet (PDFKit). Cancelling is not an error. | not yet seen in a window (see Evidence) |
| One export at a time, Electron's wording | Matches | `EXPORT_BUSY`, `Couldn't export this document as …`. 30 s layout deadline. | `one_export_at_a_time` |
| Word, RTF, ODT, text, Markdown copies | Matches | Byte for byte. | `convert_golden` |
| Word documents' own PDF and print | Matches | `docx-print.ts` ported to Typst with Chromium's layout rules: `canPrintDocx` rule for rule, page size and margins, Georgia 12 pt line boxes, min-height 1.4em, collapsed margins, unsplittable table rows, explicit and blank-page breaks. Same pages as Electron on 7 Electron-built fixtures. The 26 TypeScript print cases are not ported one by one. | `office_pdf::tests`, `word_pagination_matches_electron` |

## Things that need web content

| Item | How Markie RS does it |
|---|---|
| Darkmown preview | wry island with Electron's frame sandbox |
| Live Docs preview | wry island locked to the dev server origin (built, not yet in a panel) |
| YouTube and Vimeo | `island::VideoPlayer` plays the nocookie or Vimeo player; export cards use the thumbnail like Electron. Not yet hooked to the rich editor's embed card (editor agent's area). |
| PDF and print | No web view: Typst |
| KaTeX math | No web view: markie-math |
| Raw inline HTML | Sanitized and interpreted natively in exports (mark, u, sub, sup, colour, background, alignment, kbd) |

## Evidence

Under `.autoloop/runs/web-export/`:

- `pdf/sbs-everything-{light,dark}-{1,2,3}.png`: Chromium (left) and Markie RS (right), page by page.
- `pdf/*.chromium.pdf` and `pdf/*.rs.pdf`: the PDFs themselves. The Chromium ones are Electron's exact `buildPDFHTML` (with KaTeX CSS and inlined pictures, written by `scripts/electron-pdf-html.mjs`) printed by headless Chrome, the engine Electron's `printToPDF` uses.
- `render/`, `convert/`, `darkmown/`: written only when a golden test fails.
- `app/everything-wd-trace.log`: Markie RS opened `Everything.wd` with `MARKIE_RS_DEBUG_WD=1`. The preview frame was created, and Electron's pinned compiler ran in the hidden web view and returned the document in 414 ms.

### What could not be checked

Kirby's Mac was locked during this run (`IOConsoleLocked` was true). A locked console draws no windows, so `capture.sh` and `act.sh` refused every window, Markie RS's and Electron's alike. So:

- No screenshots of the `.wd` preview, the Export menu or the print sheet exist yet. The trace above shows the compile path working in the real app; the frame's drawing and the clicks (Trust, Reset, Revoke) are unverified on screen.
- The reference PDFs were not made by clicking Export in Electron. They are Electron's exact export HTML, from its own TypeScript, printed by headless Chrome (the Chromium engine `printToPDF` uses) with a scratch profile.

Next run with the screen unlocked: open `Everything.wd` and `everything.md` from a scratch HOME, capture the preview untrusted and trusted in light and dark, export each PDF from both apps through the menus, and lay them side by side.

## How to regenerate goldens

From the worktree root, with the repo's `node_modules` symlinked:

```sh
node --import ./rust/scripts/ts-run/register.mjs rust/crates/markie-export/scripts/goldens.mjs
node --import ./rust/scripts/ts-run/register.mjs --import ./rust/crates/markie-web/scripts/raw-hooks.mjs rust/crates/markie-web/scripts/goldens.mjs
node --import ./rust/scripts/ts-run/register.mjs rust/crates/markie-export/scripts/electron-pdf-html.mjs
```

## Open items

1. "Make Interactive" for Markdown files.
2. The Live Docs panel: project list, tree, tabs and the site island in the window.
3. Hooking `VideoPlayer` to the rich editor's embed card.
4. GPUI overlays other than title-bar menus can sit under a web island.
5. Port the 26 `docx-print.ts` cases one by one.
6. Math in the HTML export draws lighter than KaTeX's font glyphs (AUDIT-AGENTS-WEB.md row 23.3).
