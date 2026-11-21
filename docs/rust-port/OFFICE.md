# Markie RS: the Office engine port

Date: 2026-11-21. Circular task ENG-8734, phase 4, codec half.

The Office codecs now run in Rust, in the crate `rust/crates/markie-office`. The crate has no UI and no GPUI dependency. The native Word page view is the other half of phase 4 and is not part of this work.

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
- **The native Word page view.** GPUI page, continuous and outline views, the Format, Insert, Layout and Review menus (49 command ids), and caret mapping into the byte offsets above.
- **The document workspace layer.** Sessions, the local library and recovery, which the two skipped rich-document cases exercise.
- **CJK code pages, if wanted.** Only if Kirby accepts a decoding dependency or wants the WHATWG indexes generated into the crate (several MB).
- **A Word-generated corpus.** The decision record asks for real Word reopen, repair and layout checks before broad support is advertised. That needs Kirby's Word install.

## Estimate

Agentic wall-clock time, with agents running in parallel:

| Work | Estimate | Serial limit |
|---|---|---|
| Print gate on the Typst path | Half a day | Waits on phase 5's Typst setup |
| Word page view in GPUI | 4 to 6 days | One canvas design; shares GPUI text layout with the rich editor (phase 2b) |
| Menus and command wiring | 1 day, parallel with the page view | Needs the page view's selection model |
| Workspace sessions and recovery | 1 to 2 days, parallel | Reads the Electron registry format |
| Word corpus check | Half a day of agent time | Kirby runs real Word reopen and repair |

That leaves phase 4 at about 1 to 1.5 weeks of wall-clock time, mostly the page view.

## How to run it

```sh
cd rust
cargo test -p markie-office
```
