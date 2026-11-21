# Markie RS: the Office engine port

Date: 2026-11-21. Circular task ENG-8734, phase 4.

The Office codecs run in Rust, in the crate `rust/crates/markie-office`. That crate has no UI and no GPUI dependency. The native Word page view is the crate `rust/crates/markie-office-view`, described in [The Word page view](#the-word-page-view) below.

## What is ported

Every codec in `src/lib/office` and `src/lib/document-import` is ported, except the print projection.

| TypeScript | Rust | What it does |
|---|---|---|
| `zip.ts` | `zip.rs` | Bounded ZIP reader and stored-entry writer |
| `xml.ts` | `xml.rs` | Bounded XML reader with source offsets, no DTDs or custom entities |
| `cfb.ts`, `cfb-write.ts` | `cfb.rs` | Compound-file reader and v3 root-stream writer |
| `legacy-doc*.ts` | `legacy_doc.rs` | Word 97 to 2003 text extraction, plain-story streams, off-thread import |
| `docx*.ts` | `docx/` | DOCX open, edit, review, pictures, links, page breaks, styles, theme, export |
| `rtf.ts` | `rtf.rs` | RTF read and same-format write |
| `odt.ts`, `odt-page-layout.ts`, `odt-readonly.ts` | `odt/` | ODT read, same-format write, page geometry, read-only display |
| `rich-text-model.ts`, `rich-text-types.ts`, `rich-range-types.ts`, `docx-types.ts` | `model.rs`, `rich_text_model.rs` | The shared document model and the simple RTF/ODT editor |
| `rich-document.ts` | `rich_document.rs` | One entry point over the three formats |
| `document-import/*` | `document_import/` | HTML, RTF and ODT to a new UTF-8 TXT copy |

The model the UI renders covers paragraphs, runs, direct and resolved styles, headings and named styles, lists, tables, pictures, hyperlinks, page breaks, page setup, comments and simple revisions.

Every limit and safety check is carried over with the same values. That includes ZIP bombs, entry counts, archive and entry sizes, compression ratio, path traversal and aliases, symlinks, XML size and depth, DTD and entity refusal, DOC input and time limits (32 MiB, 5 s), and the HTML, RTF and ODT import budgets.

An untouched DOCX, RTF or ODT exports its original bytes. DOCX edits splice only the XML they own, so unrelated parts and unrelated XML stay byte-identical.

## Dependencies and provenance

The only new dependency is `miniz_oxide`, for raw DEFLATE. The decision record calls browser decompression a generic platform primitive, and this crate stands in for it. ZIP framing, XML parsing and every Office format are our own code, written from the public specifications.

Two tables are generated from specification data files, not from libraries:

- HTML named character references, from the WHATWG `entities.json`.
- Windows single-byte code pages for RTF, from the WHATWG Encoding Standard indexes.

## Tests

The TypeScript tests and fixtures are ported to Rust. The counts below are vitest cases, so each row of an `it.each` counts once.

| Area | TypeScript cases | Ported | Not ported |
|---|---|---|---|
| ZIP | 19 | 19 | 0 |
| XML | 56 | 55 | 1 |
| CFB reader and writer | 63 | 58 | 5 |
| DOC extraction, writer, off-thread | 58 | 52 | 6 |
| HTML, RTF and ODT import | 77 | 77 | 0 |
| RTF codec | 69 | 68 | 1 |
| ODT codec, layout, read-only | 92 | 92 | 0 |
| DOCX | 317 | 316 | 1 |
| Rich model and dispatch | 27 | 25 | 2 |
| DOCX print projection | 26 | 0 | 26 |
| Total | 804 | 762 | 42 |

`cargo test -p markie-office` runs 396 Rust tests covering those 762 cases. All 396 pass.

The other 16 unported cases are mostly ones Rust types cannot express: lone UTF-16 surrogates, NaN or Infinity limits, untyped operation objects and forged `{ ...document }` snapshots. Two are document-session and library cases, which belong to the workspace layer. One is the Shift_JIS RTF row, now a test of the documented gap below.

## What behaves differently

- **Offsets are UTF-8 bytes.** The TypeScript measures text in UTF-16 code units. Range formatting, hyperlinks, page breaks and selections now take byte offsets, and any offset inside a character is rejected. The UI must convert caret positions before calling the engine.
- **Grapheme checks are approximate.** TypeScript uses `Intl.Segmenter`. Rust has no Unicode segmentation data without a new dependency, so `grapheme_boundary` covers combining marks, variation selectors, ZWJ emoji, skin tones, flags, Hangul jamo and CRLF.
- **HTML import has its own parser.** TypeScript parses inside an inert browser template. Rust uses a WHATWG-shaped tokenizer with the implied-end-tag rules that change text boundaries. Adoption-agency and foster-parenting repairs are not modeled. They can change element nesting in broken HTML, but not the inert, script-free guarantee.
- **Double-byte RTF code pages are not decoded.** Shift_JIS, GBK, EUC-KR and Big5 byte runs show U+FFFD and open read-only. Unicode `\u` text, which modern Word and TextEdit write, is unaffected.
- **DOC text replaces lone surrogates.** The extracted text uses U+FFFD for unpaired surrogates. The raw main story keeps the exact UTF-16 units in `raw_text`.
- **The DOC reader is not killed on timeout.** A Web Worker can be terminated; a Rust thread cannot. On timeout or cancel the caller returns at once and the bounded reader thread is left to finish alone.
- **Internationalized link hosts are refused.** The URL serializer would map them with IDNA. The port refuses them rather than guess. Non-ASCII paths are percent-encoded as before.
- **Reverted edits export original bytes.** RTF, ODT and DOCX compare values, not object identity, so an edit that is undone exports the original file.
- **Numbering reuse order.** When a document has several lists of the same kind, a new list item joins the one with the lowest id. TypeScript joins the first in document order.

## What remains

- **The print projection.** `docx-print.ts` builds Chromium print HTML. Phase 5 prints and exports PDF through Typst, so the gate (`canPrintDocx`) should move to that pipeline rather than ship as HTML. Its 26 test cases are not ported yet.
- **The document workspace layer.** Sessions, the local library and recovery, which the two skipped rich-document cases exercise.
- **CJK code pages, if wanted.** Only if Kirby accepts a decoding dependency or wants the WHATWG indexes generated into the crate (several MB).
- **A Word-generated corpus.** The decision record asks for real Word reopen, repair and layout checks before broad support is advertised. That needs Kirby's Word install.
- **The page view gaps** listed in its own section below.

## The Word page view

`markie-office-view` draws Office documents natively in GPUI and edits them only through the engine. `markie-app` opens DOCX, RTF, ODT and DOC with it. The app changes are one new module, `workspace/office.rs`, plus routing lines in `workspace.rs` and menu lines in `main.rs`.

### What works

Display:

- Pages at the document's paper size, orientation and margins, at 96 pixels per inch like Electron. Blocks are measured after layout and placed on pages; the second frame settles the page breaks.
- Continuous view, one sheet up to 960 px wide. Outline view, a heading list beside the page that jumps to a heading.
- Runs with bold, italic, underline, color, font family and size. Word's resolved styles win; headings fall back to fixed sizes when a file has no styles.
- Paragraph alignment, spacing before and after, line spacing, bullet and numbered lists with levels.
- Tables, with editable cells. PNG and JPEG pictures from the package bytes.
- Links in the link color, opened with Cmd-click, or a plain click when the file is read-only.
- Explicit page breaks start a new page. Continuous view marks them with a dashed rule.
- Comments and tracked changes in a margin beside each page, with Accept and Reject on each change. Paragraphs with pending changes get a change bar.
- Light paper in dark mode by default, with a Theme paper toggle. Authored run colors are adapted to the paper on screen only, a port of `word-colors.ts`. Save keeps the authored colors.

Editing:

- Typing and IME through `EntityInputHandler`. Marked text is drawn underlined in place and committed to the engine once, when the input method finishes. The platform sees UTF-16 offsets into the caret's paragraph; the engine sees UTF-8 byte offsets. Every conversion lands on a character boundary, and caret moves land on the engine's grapheme boundaries.
- Click, Shift-click, double-click word, triple-click paragraph, and drag selection across paragraphs. Arrows, Option-arrows, Cmd-arrows, Home, End, Backspace, Delete and Option-Backspace.
- Inside one paragraph, edits become run text edits, so untouched runs keep their XML. Enter, joins and cross-paragraph edits use the engine's source-preserving range edit (DOCX). RTF and ODT split paragraphs with replace-paragraph and insert-paragraph, as Electron does.
- Undo and redo of 100 snapshots, with the caret restored. Copy, cut and paste as plain text, read-only documents included for copy.
- The Format, Insert, Layout and Review menus from `document-menu-commands.json`, plus Word Layout items in the View menu. A command shows disabled when the selection does not allow it, using the same rules as Electron's `availableCommands`. A toolbar offers the same commands.
- The tool panel for Font, Picture, Table, Link and Page Breaks, Page Setup, Paragraph Spacing and Document Review: tracking, revision author, accept or reject all, final or original text, comments, and the engine's compatibility notes.
- Refused edits explain why in a banner and leave the document as it was.

Saving:

- Cmd-S writes the engine's export with an atomic write. An untouched or reverted document writes its original bytes, and a clean document is not written at all.
- Documents the engine opens read-only (unsupported RTF, ODT or DOCX features, pending deletions in a redline) show the engine's reason and are never written.
- DOC opens as extracted text, off the UI thread, with Electron's warnings. "Save a TXT copy" writes `name (converted).txt` next to the original, never over another file, and opens it.

### Tests

`cargo test -p markie-office-view` runs 57 tests. They cover:

- UTF-8 and UTF-16 caret mapping, surrogate pairs, grapheme steps, word moves and marked-text splicing.
- Typing, Backspace and Delete over graphemes, splits, joins, cross-paragraph replacement, multi-line paste, and RTF and ODT editing with a save and reopen.
- Formatting, headings, lists, alignment, page layout, tables, pictures, links, page breaks, comments, tracking and accept.
- Undo, redo and the dirty state, the original-bytes guarantee for untouched and reverted files, and read-only hosts.
- Menu availability for DOCX and RTF, pagination, run and paragraph looks, and color adaptation.

`cargo test -p markie-office -p markie-office-view -p markie-app` runs 455 tests, all passing.

### Checks in the running app

Run against copies in a scratch folder with `MARKIE_RS_DATA_DIR` set. No original file was opened by the app.

| File | Checked |
|---|---|
| A sample DOCX built through the engine (`examples/sample_docx.rs`) | Every feature drawn; click and type; Enter continues a bullet list; Shift-arrow selection and Cmd-B; undo and redo; Cmd-S writes the bold run; Cmd-Down scrolls to page 2 after an explicit break; Layout > Landscape from the native menu; Outline; Theme paper |
| A real lease DOCX with comments | Editable; untouched save and type-then-delete save both keep the original bytes; drag selection across paragraphs and Backspace; tracking from Review > Track Paragraph Text, tracked typing with a change bar, Accept all |
| A real redlined DOCX | Opens read-only with the engine's reason |
| The engine's RTF and ODT fixtures | Open read-only with their reasons |
| Engine-written RTF and ODT | Typing, Enter and Cmd-S on RTF; Option-Shift-Left and Cmd-B and Cmd-S on ODT, checked in the saved files |
| A spec-shaped DOC from the engine's own fixture builder | Text, separators and warnings shown; TXT copy written and opened |
| A real Word DOC with an extended FIB | Shows the engine's refusal (outside the Word 97 to 2003 scope) |

### Gaps

- **One text size per paragraph.** GPUI shapes a text element at a single size, so a paragraph uses the size most of its text has. Mixed sizes inside one paragraph show at that size; save keeps them.
- **Justified text shows left aligned.** GPUI has no justified alignment.
- **Pages never split a block.** A paragraph or table taller than the page gets its own page and runs over. A page break inside a paragraph's text is drawn after the paragraph.
- **Live IME is not verified.** The composition path is unit tested for its offsets, but no Japanese or Chinese input source was switched on for a live check, to avoid changing Kirby's input settings.
- **Picture insert was not driven through the file dialog.** The insert path is unit tested with real PNG bytes.
- **No autosave, drafts or version history for Office files.** Unsaved Office edits are saved when another document is opened, as text documents are.
- **Strikethrough stays disabled.** The engine has no strike property. Soft line breaks and tabs are refused, as in Electron.
- **Find and replace is not ported.** Electron's Word find tool is a stub too.
- **The margin and wide pages scroll sideways** when the window is narrow. The Library panel takes 300 px.
- **Paper in dark mode differs from Electron on screen.** Electron's on-screen page follows the theme and only print and PDF use white paper. The brief asked for light paper, so Markie RS defaults to light paper and offers Theme paper as a toggle. Kirby should pick the default.

### Estimate for the gaps

Agentic wall-clock time:

| Work | Estimate | Serial limit |
|---|---|---|
| Split long paragraphs and tables across pages | 1 to 1.5 days | One layout pass design, shared with print in phase 5 |
| Per-run font sizes | 1 day | Needs a line layout that mixes sizes; GPUI's `StyledText` cannot |
| Justified text | Half a day | Same custom line painter |
| Office autosave, drafts and history | 1 day | Uses the workspace layer above |
| Find and replace in Word documents | Half a day | None |
| Live IME and picture dialog checks | 1 hour | Kirby enables an input method, or approves a test-only input source |

With the print gate, the workspace layer and the Word corpus check above, that leaves phase 4 at about 4 to 6 days of wall-clock time, run in parallel with phase 2b.

## How to run it

```sh
cd rust
cargo test -p markie-office -p markie-office-view
cargo run -p markie-office-view --example sample_docx -- /tmp/sample.docx
MARKIE_RS_DATA_DIR=/tmp/markie-rs-data cargo run -p markie-app -- /tmp/sample.docx
```
