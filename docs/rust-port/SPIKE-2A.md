# Phase 2a: rich editor spike

Date: 2026-11-21. Circular: ENG-8731. Code: `rust/crates/markie-rich`.

## Verdict: GO

A native Rust editor model keeps Markdown byte for byte and shares the web app's Yjs rooms in both directions. Both gate questions pass with evidence. Markie RS can stay fully Rust.

## Question 1: byte-for-byte round trip

The model keeps every top-level block's source bytes. An untouched block is written back from those bytes, so a zero-edit save is the file by construction. Only blocks the user changed go through the serializer.

### Ported TipTap fixtures

These are the cases of `src/lib/rich-roundtrip.test.tsx`, ported to `tests/roundtrip.rs`.

| Suite | Rust result | TipTap today |
|---|---|---|
| SAFE, raw parse then serialize | 11/11 | 11/11 |
| LOSSY, zero-edit save | 6/6 exact | 0/6 raw; needs hold-aside |
| PRESERVED (layer 1) | 4/4 exact | 4/4 |
| CORPUS_SHAPED (layer 2) | 10/10 exact | 10/10 |
| CLEAN (layer 3) | 5/5 exact | 5/5 |
| GATED (reference link at a distance) | 1/1 exact and editable | opens read-only |
| Edit one paragraph of a 400-line file | pass: every other line identical | pass |
| Fixture blocks whose edit reads back as shown | 54/54 | not measured |

All 13 round-trip tests and 5 editing tests pass.

### Real files

`tests/corpus.rs` is the Rust side of `rich-roundtrip.corpus.test.tsx`. It ran on two trees on this Mac.

| Corpus | Files | Zero-edit byte-identical | Blocks whose edit reads back as shown | Speed |
|---|---|---|---|---|
| ZVN (first 20,000 files) | 20,000 | 20,000 | 1,057,410 of 1,058,360 (99.91%) | 2.0 ms per file |
| Bevrly (holdout) | 2,446 | 2,446 | 107,224 of 107,420 (99.82%) | 1.3 ms per file |

The unstable blocks are the known gaps listed under phase 2b. Examples are linked badge images, inline HTML, and lists mixing task and plain items. They are only at risk when the user edits that block.

## Question 2: collaboration interop

The model maps 1:1 onto y-prosemirror's XML for the TipTap schema: `XmlFragment("default")`, element per node, typed attributes, marks as text formatting. `interop/run.sh` runs Rust, then the repo's own `yjs`, `@tiptap/y-tiptap` and extension list in vitest, then Rust again. There is no server and no mocks.

| Check | Result |
|---|---|
| Rust room read in Node equals the room TipTap seeds from the same Markdown | 24/24 |
| That room through tiptap-markdown equals TipTap's own Markdown | 24/24 |
| TipTap-seeded room read in Rust gives the same blocks, and folds back onto the file byte for byte | 24/24 |
| A real TipTap editor with the Collaboration extension edits a room Rust seeded; Rust folds it into the file | pass: only the two touched blocks change |
| Rust and TipTap edit the same base at once; both sides converge to the same room | pass |
| Converged room folded onto the file keeps every untouched block's bytes | pass |

The 24 cases cover the SAFE fixtures, the corpus-shaped ones a room can carry, all marks, tables with alignment, task lists, math, embeds, Unicode and TipTap's whitespace quirks.

### Real files, room for room

This check compares the room Rust writes with the room TipTap seeds, for real documents a room can carry.

| Corpus | Documents identical | Blocks identical |
|---|---|---|
| ZVN | 397 of 400 | 9,429 of 9,432 |
| Bevrly (holdout) | 393 of 400 | 6,405 of 6,412 |
| Markie repo docs | 31 of 31 | 661 of 661 |

Every remaining difference is content TipTap loses and Rust keeps:

- a badge image inside a link becomes an empty paragraph in TipTap;
- text that looks like an HTML tag (`"Loaded ENG-x <id>"`) cuts the paragraph short.

The web schema renders what Rust writes in those cases, so this does not break a shared room.

### Things the spike found

- yrs counts text offsets in UTF-8 bytes by default. Yjs counts UTF-16 units. Every Rust document must use `OffsetKind::Utf16` (`ydoc::new_doc`), or every edit after a non-ASCII character lands in the wrong place.
- yrs writes a text run's format attributes in hash order. ProseMirror sorts marks by rank when it reads a room, so editors see the same document. Byte-level Yjs state can differ in attribute order only.
- TipTap's room is what markdown-it plus ProseMirror's DOM parse make of the text. Matching it meant copying these rules:
  - Markie's own `$` math scanner, which is not pulldown's;
  - linkify-it 5.0.2's host, path and TLD rules;
  - tiptap-markdown's `normalizeBlocks` and its dropped newline after inline elements;
  - the Code mark's `excludes: "_"`.

  These are in `parse.rs` and `linkify.rs`, each tied to its source.

## UI proof and recommended approach

`examples/rich_editor.rs` (feature `gui`) is a GPUI window over the model.

- You can type, select with Shift and the arrows, bold, italicize, set headings, split and join paragraphs, and save.
- Driven by real keystrokes, it bolded a word in a heading and saved.
- The file changed by exactly that one line.
- The status line counts blocks rewritten against blocks kept.

Run it with:

```sh
cd rust
cargo run -p markie-rich --features gui --example rich_editor -- <file.md>
```

**Recommendation: approach (a), a block editor of styled text runs.**

- (a) maps one to one onto the Yjs room. Every editor operation is already a model operation, and the model is the room's XML.
- GPUI has what (a) needs. `StyledText::with_runs` takes weight, style, color, background and strikethrough per run. Block size comes from the container. `TextLayout::index_for_position` and `position_for_index` give caret and click mapping.
- (b), live preview over source in GPUI Kit's `Editor`, cannot look like a rich editor without forking the toolkit. `TextDecoration` only carries a `HighlightStyle`, so it can color, bold or fade the `**` but not hide it. There is no per-range font size, so headings stay body size. Folding hides whole rows only.
- (b) also fits collaboration badly. A source buffer has to be re-parsed and diffed against the room on every keystroke.
- Keep GPUI Kit's `Editor` for Source mode, where it already works.

The cost of (a) is that we own text input: IME, mouse selection, undo, clipboard and accessibility. GPUI's `EntityInputHandler` and Zed's own editor show these primitives are enough.

## What remains for phase 2b

Editor surface:
- IME through `EntityInputHandler`, mouse caret and drag selection through `TextLayout`, selection across blocks.
- Undo through yrs `UndoManager` (shared with collab), clipboard as Markdown and HTML.
- Editing lists, task lists, tables, code blocks, quotes; image resize; embed cards; links UI.
- Math drawn with `typst`; virtualized rendering for long files; find; accessibility.

Model:
- Inline HTML marks TipTap has: highlight, color, font family and size, underline (`textStyle`, `highlight`).
- Aligned paragraphs and headings (`<p align>`), sized media (`<img width>`), linked images.
- Display math inside lists and quotes, punycode hosts, mixed task and plain lists.
- Preservation inside a list: today, editing one item rewrites the whole list block.

Collaboration:
- Map editor operations to minimal Yjs operations (insert and format at a UTF-16 offset) instead of replacing a block.
- Observe deep Yjs events back into the model.
- y-sync and awareness over `tokio-tungstenite`, peer cursors, `meta` map and schema version, seed election.
- Comment anchors as relative positions, room migration.

## Estimate for phase 2b

Agentic wall-clock time, with agents running in parallel:

| Track | Wall-clock |
|---|---|
| Editor surface: input, IME, selection, undo, clipboard | 1.5 to 2 days |
| Block types: lists, tables, code, images, math with typst (in parallel) | 1.5 to 2 days |
| Live collaboration binding, y-sync, awareness, comments (in parallel) | 1.5 days |
| Model gaps from the list above (in parallel) | 0.5 to 1 day |
| Wire into `markie-app`, Kirby feel review, fixes | 1 day |
| Total | about 4 to 6 days |

The real limits are serial GPUI builds (one to two minutes per incremental build), and Kirby's review of how the editor feels. Feel is the one thing tests cannot settle.

## How to run the evidence

```sh
cd rust
cargo test -p markie-rich                                    # fixtures, edits, yrs round trip
MARKIE_CORPUS_DIR=~/Documents cargo test --release -p markie-rich --test corpus -- --nocapture
crates/markie-rich/interop/run.sh                            # needs the repo's node_modules
MARKIE_INTEROP_CORPUS=~/Documents crates/markie-rich/interop/run.sh
```

Reports land in `rust/target/interop/node/report.json` and `rust/target/interop/rust/import-report.json`.
