# Phase 2b: the native rich editor

Date: 2026-11-21. Circular: ENG-8732. Builds on Phase 2a (`SPIKE-2A.md`).

View mode in Markie RS is now a native rich editor. It edits Markdown in place and saves through the app's own autosave. Every block the user did not change keeps its bytes.

## Where the code is

| Crate | What it holds |
|---|---|
| `rust/crates/markie-rich` | The model, no UI. `src/editor/` is new: caret and selection, edits, undo, clipboard, find, outline. `src/html.rs` reads and writes TipTap's inline HTML. |
| `rust/crates/markie-editor` | New. The GPUI view: inline layout, the leaf element, blocks, toolbar, find and prompt bars, input method handler, pictures. |
| `rust/crates/markie-math` | TeX to SVG with mitex and typst. Its evaluation is in `MATH.md`. |
| `rust/crates/markie-app` | `workspace/rich.rs` is the glue. `workspace.rs`, `panels.rs` and `main.rs` changed by a few lines each. |

The view is its own crate because `markie-math`'s corpus test depends on `markie-rich`, and Cargo refuses the cycle a `gui` feature would make.

## What works

### Text input

- Typing goes through GPUI's `EntityInputHandler`, so the platform input method can compose text in place. Composing text is marked and underlined.
- The caret moves by character (grapheme), word and visual line, with Home, End, ⌘ and ⌥ chords, Page Up and Page Down. Up and Down keep their column.
- Mouse: click, Shift-click, drag, double-click for a word, triple-click for a block. Selection runs across blocks, lists, quotes and tables.
- Undo and redo (⌘Z, ⌘⇧Z). Changes group as ProseMirror's history groups them in Electron (`newGroupDelay` 500 ms): typing, deleting, Enter and paste at the caret are one undo until a pause of more than 500 ms or an edit somewhere else. Formatting is always its own undo, an input rule starts a new one, and one input method composition stays one. Undoing everything gives back the file byte for byte.
- ⌘C copies the selection as Markdown. Whole blocks are copied as their own bytes. ⌘⇧C copies plain text. ⌘V pastes text as Markdown, like TipTap's `transformPastedText`. One line pastes inline and keeps its marks.

### Blocks

- Paragraphs, headings 1 to 6, block quotes, horizontal rules.
- Bullet, numbered and task lists with nesting. Enter splits an item, Enter on an empty item lifts it, Tab and Shift-Tab indent and outdent, Backspace at an item's start lifts it, a click on a box checks it.
- Code blocks with syntax colours from GPUI Kit's highlighter, a language label that opens a prompt, and the third Enter on a blank last line leaves the block.
- Tables with column alignment. Tab and Shift-Tab move between cells. Tab in the last cell adds a row. Enter in a cell is a line break, written as `<br>`.
- Pictures, local, remote and `data:` URIs. A selected picture has a resize handle, and the width is written as TipTap writes it: `<img src alt width>`, or `<video width controls>` for a clip. Remote pictures load in the background with a 20 MB and 15 second cap.
- Display math drawn by `markie-math`. A click shows its TeX for editing, with the formula drawn live below it. Inline math is drawn in the line. A double click on it edits its TeX in the prompt bar. Typing the closing `$` of `$…$` makes a formula, as `rich-math.ts` does.
- YouTube and Vimeo links alone on a line are cards with a thumbnail (YouTube) and an Open button. Playback is phase 5.
- Front matter is held aside and never shown.
- Blocks the parser cannot model (raw HTML, footnote definitions, link definitions) show as source and edit as source. Their bytes are what the user typed.

### Marks

Bold, italic, strike, inline code, links, underline, highlight with colours, text colour, font family and font size. The names are TipTap's (`bold`, `italic`, `strike`, `code`, `link`, `underline`, `highlight {color}`, `textStyle {color, fontFamily, fontSize}`), so a room stays compatible. They are written as TipTap writes them: `<mark data-color …>`, `<span style="color: …; font-family: …; font-size: …;">`, `<u>`. Alignment is `textAlign` on paragraphs and headings, written as `<p style="text-align: center;">`.

GPUI's `StyledText` has one font size per text and no inline pictures. So the view lays lines out itself: each run is shaped by GPUI, words never split between runs, and each line takes its tallest run. That gives the `fontSize` mark and inline formulas.

### Toolbar and shortcuts

The toolbar follows `formatting-toolbar.tsx`: style menu, font, size, bold, italic, underline, strike, code, text colour and highlight palettes (the same colours), lists, alignment, link, picture, an insert menu (formula, display formula, table, rule), undo, redo and clear formatting.

Shortcuts follow `rich-keymap.ts` and `toolbar-shortcuts.ts`: ⌘B, ⌘I, ⌘U, ⌘⇧X strike, ⌘E code, ⌘⇧H highlight, ⌘⇧8, ⌘⇧7 and ⌘⇧9 lists, ⌘⇧L, ⌘⇧E and ⌘⇧R alignment, ⌘⇧K link, ⌘\ clear, ⌘⌥0 to ⌘⌥6 paragraph and headings, ⌘⌥C code block, ⌘⇧B quote. TipTap's input rules work too: `# `, `- `, `1. `, `[ ] `, `> `, and a typed address becomes a link on the next space.

### In the app

- Opening a Markdown file under 1 MB shows the rich editor. Larger files stay Source only, as before.
- Every edit marks the document edited and autosaves through `Workspace::write_text`, with the same version history and crash drafts.
- View to Source carries the rich editor's text over. Source to View parses it again.
- The outline panel jumps to the heading in View, with the caret on it.
- Zoom (⌘=, ⌘-, ⌘0) and page width (⌥⌘], ⌥⌘[) apply.
- ⌘F opens find in View, with highlights, next, previous, replace and replace all.
- Blocks far from the screen are drawn as space of their last height. A 430 KB document (1,140 blocks) renders in 0.4 ms per frame in a release build, down from 72 ms in a debug build before this.

### Ready for collaboration

The model is still the room's XML (`doc.nodes()`). Each undo step names the blocks it replaced, which is what a minimal Yjs update needs in phase 3. Positions stay UTF-16 in yrs (`ydoc::new_doc`).

## Byte preservation

After every edit the touched blocks are cut back into one block per top-level node. Any node equal to a block as it was opened gets that block's bytes back. So Enter at the end of a paragraph adds an empty one and leaves the first one's bytes alone, and typing a letter then deleting it restores the block exactly.

Edited blocks then pass a schema fix-up like ProseMirror's. A table cell holds one paragraph. A list item starts with a paragraph. Display math has no blank line inside. Markdown cannot hold anything else, so the editor never makes it.

## Test numbers

| Check | Result |
|---|---|
| `markie-rich` unit and integration tests | all pass (19 editor tests, 13 round trip, 5 spike edit, tree and HTML tests) |
| Fuzz, fixtures: 900 random edit runs of 60 steps | no panics. Undo restored the file in 900 of 900. |
| Fuzz, real files: 1,200 runs on 400 ZVN files | undo restored the file in 1,200 of 1,200. Edited blocks read back as shown: 9,603 of 9,685 (99.2%). |
| Corpus, ZVN (20,000 files) | zero-edit byte-identical 20,000 of 20,000. Editable blocks whose edit reads back as shown: 1,057,480 of 1,058,405 (99.91%). |
| Corpus, Bevrly holdout (2,446 files) | zero-edit 2,446 of 2,446. Blocks stable: 107,331 of 107,436 (99.90%, was 99.82% in 2a). |
| Interop, `interop/run.sh` | 34 of 34 both ways (10 new cases for the new marks, aligned blocks, sized media and nested lists). Live TipTap edit folds back, concurrent edits converge. |
| `markie-editor` tests | 4 of 4 (colours, sizes, fonts, picture sources, YouTube ids) |
| `markie-math` | see `MATH.md` (98 of 98 Markie formulas, corpus 100% of KaTeX-valid) |

Real keystrokes on the running app, with a scratch data folder and scratch copies only. Each autosave changed only the lines edited:

- typing at a click, double click then ⌘B, ⌘Z back to the exact bytes;
- Enter, Tab and Enter on an empty item in a list;
- a task checkbox click (one line changed);
- ⌘F, Enter, Escape, then typing at the match;
- ⌘⇧K on a selected word (`[wrote](https://euler.example)`);
- Tab through a table into a new row;
- Enter in a code block;
- pasting `café 🎉 日本語`;
- the outline jumping to a heading, then typing there;
- zoom; dragging a picture's resize handle (`width="240"` to a new width);
- View, Source, View, with edits made in each kept.

The fuzz test's whole-document read-back is 660 of 797 runs. The rest are runs that break Markdown on purpose (two lists of one kind made adjacent, reference definitions edited away). Those read back differently in the web app too.

## Known gaps

- The input method path is wired but not driven by a real input method. Scripted key events cannot compose text. Kirby should try Japanese or Chinese input once.
- No accessibility tree for the editor yet. VoiceOver reads nothing in View.
- No context menu, spell check, drag and drop of text, or picture paste and drop.
- Tables cannot add or remove columns, or delete rows, except by deleting their text. Column alignment has a model call but no button.
- Vimeo cards have no thumbnail (it needs an oEmbed fetch). Remote pictures are not cached across launches.
- Inline formulas are edited in the prompt bar, not inline.
- ⌘E is inline code while editing, as in TipTap, so the app's ⌘E View/Source toggle only works from Source. ⌘⇧L is align left while editing, not the theme toggle. The title bar and menus still reach both.
- The font and size controls act on the selection only. The document-wide font is the app's settings, not the toolbar's, unlike the web app.
- mitex accepts some broken TeX that KaTeX shows in red (for example `\frac{1}{`).
- Two lists of the same kind that end up in adjacent blocks read back as one list. TipTap has the same limit.
- Local undo is not yet yrs's `UndoManager`. Phase 3 should switch when edits go through the room.
- Opening a long document measures every block once on the first frame.

## Estimate for what is left

Agentic wall-clock time, agents in parallel:

| Track | Time |
|---|---|
| Accessibility tree, context menu, spell check | 1 to 1.5 days |
| Table column tools, picture paste and drop, Vimeo thumbnails, remote picture cache | 1 day |
| Inline formula editing in place | 0.5 day |
| Input method testing with Kirby, fixes | 0.5 day plus Kirby's time |
| Kirby's feel review and fixes | 1 day |

The real limits are Kirby's review of how typing feels, and serial GPUI builds. Collaboration (rooms, cursors, yrs undo) is phase 3 and is not in these numbers.

## How to run it

```sh
cd rust
cargo test -p markie-rich -p markie-editor
cargo test -p markie-rich --test editor_fuzz -- --nocapture
MARKIE_CORPUS_DIR=~/Documents cargo test --release -p markie-rich --test editor_fuzz fuzz_corpus -- --nocapture
MARKIE_CORPUS_DIR=~/Documents cargo test --release -p markie-rich --test corpus -- --nocapture
crates/markie-rich/interop/run.sh
MARKIE_RS_DATA_DIR=/tmp/markie-rs-scratch cargo run -p markie-app -- <file.md>
```

Set `MARKIE_RICH_DEBUG=1` to log clicks, inserted text and render times.
