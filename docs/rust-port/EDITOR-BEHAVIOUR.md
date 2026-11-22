# Editor behaviour parity: PARITY.md sections 7, 8 and 24

Date: 2026-11-22. Branch: `t3/rust-editor-behavior-parity`, on top of `rust/markie-rs`. Reference: Markie 0.9.7 and its source.

This is about how the editors behave, not how they look. The look is another track.

## Status words

- **Matches**: does what Electron does, from the same source rules.
- **Differs**: works, with a stated difference.
- **Not built**: missing, with the reason.

## Where the code is

| Area | Files |
|---|---|
| Input rules, rule undo | `rust/crates/markie-rich/src/editor/rules.rs` |
| Code block keys | `rust/crates/markie-rich/src/editor/keys.rs` |
| Table commands | `rust/crates/markie-rich/src/editor/table.rs` |
| Keys, link clicks, right click, file drop | `rust/crates/markie-editor/src/behaviour.rs`, `attach.rs` |
| Table bar | `rust/crates/markie-editor/src/table_bar.rs` |
| Inline formula in place | `rust/crates/markie-editor/src/math_field.rs` |
| Spell check | `rust/crates/markie-editor/src/spell.rs` |
| Accessibility tree | `rust/crates/markie-editor/src/a11y.rs` |
| Link preview fetch and card | `rust/crates/markie-editor/src/link_preview.rs`, `link_card.rs` |
| Picture cache | `rust/crates/markie-editor/src/media.rs` |
| Format Tables, Find and Replace | `rust/crates/markie-core/src/format_tables.rs`, `rust/crates/markie-app/src/workspace/source.rs` |

Small edits in other agents' files, each a few lines: `markie-editor/src/render.rs` (hooks, embed card), `chrome.rs` (overlays), `element.rs` (spelling marks), `lib.rs`; `markie-app/src/workspace.rs` (two lines), `workspace/rich.rs` (events), `main.rs` (one line).

## Section 7: Source mode (CodeMirror)

| Item | Status | Notes | Tests |
|---|---|---|---|
| Edit raw source | Matches | GPUI Kit code editor. | existing app tests |
| ⌘1 / ⌘2 / ⌘3 mode keys | Differs | Markie RS uses ⌘E to toggle View and Source. Split mode is not built. Both belong to the window shell. | |
| Find (⌘F), next and previous | Matches | The editor's own search bar. Electron uses one app find bar for both panes. | |
| Find and Replace (⌥⌘F) | Matches | Opens the replace bar in Source, the find bar with replace in View. | |
| Format Tables (⌥⌘T) | Matches | Port of `format-tables.ts`, UTF-16 widths like JavaScript. Works in either mode. | `format_tables::tests` |
| Syntax highlighting, fenced languages | Matches | Tree-sitter Markdown with 10 fenced languages. `@codemirror/language-data` has more. | |
| Folding | Matches | GPUI Kit folds by default, with a gutter. | |
| Line numbers, active line, wrapping | Matches | `line_number(true)`, `soft_wrap(true)`. | |
| Multiple cursors | Differs | ⌘⌥↑ and ⌘⌥↓ add cursors. CodeMirror's ⌘-click and ⌥-drag rectangles are not there. | |
| Bracket matching, indent on input | Differs | GPUI Kit's own closing pairs and smart indent. | |
| Undo and redo | Matches | | |
| Large documents | Matches | Source only above 1 MB, as before. | |
| CSV table view, CSV and GFM conversion | Differs | Table view exists. Conversion is not built. | |
| No spell check in Source | Matches | CodeMirror sets `spellcheck=false`. | |
| ⌘⇧F in Source | Differs | GPUI Kit binds it to replace inside the editor. Electron keeps it for searching all documents. | |

## Section 8: View mode (TipTap)

### Typing and input rules

All from TipTap's own regular expressions, matched by hand in `rules.rs`.

| Item | Status | Notes | Tests |
|---|---|---|---|
| `**x**`, `__x__` bold; `*x*`, `_x_` italic | Matches | Needs the start or a space before. What is typed next is plain. | `behaviour::mark_rules`, `rules::tests` |
| `~~x~~`, `==x==`, `` `x` `` | Differs (code) | TipTap's code rule also deletes a letter typed right before the opening backtick. That is a TipTap bug that loses text, so it is not copied. | same |
| `# ` to `###### `, `#` then Enter | Matches | Rules run on Enter with `"\n"`, as TipTap does. | `behaviour::block_rules` |
| `- `, `+ `, `* `, `1. `, `[ ] `, `[x] `, `> ` | Matches | A new list joins the list before it. Ordered lists join only when the number follows on. | `a_new_list_joins_the_one_before` |
| ```` ``` ````/`~~~` with a language, then space or Enter | Matches | | `block_rules` |
| `---`, `—-`, `___ `, `*** ` rule | Matches | | `block_rules` |
| `![alt](src "title")` picture | Differs | A picture typed into an empty paragraph becomes the picture plus an empty paragraph for the caret. | `block_rules` |
| `$…$` formula | Matches | rich-math.ts's exact pattern. | `math_input_rule_makes_a_formula`, `rules::tests` |
| Autolink on space | Matches | Existing. | |
| Backspace right after a rule | Matches | Takes the rule back and keeps the typed characters (`undoInputRule`). After Enter it does not put a `\n` back. | `backspace_undoes_a_rule` |
| No rules in code or next to code | Matches | | |
| No rules while an input method composes | Matches | The view only runs rules on committed text. | |
| Smart quotes | Matches | Electron has no Typography extension, so neither has quotes. | |

### Keys

| Item | Status | Notes |
|---|---|---|
| Formatting shortcuts (⌘B, ⌘I, ⌘U, ⌘⇧X, ⌘E, ⌘⇧H, lists, align, ⌘⇧K, ⌘\\, ⌘⌥0–6, ⌘⌥C, ⌘⇧B) | Matches | Existing. |
| Enter, Tab, Shift-Tab in lists, Backspace lifting items | Matches | Existing. |
| Shift-Enter and ⌘Enter | Matches | A hard break, or `exitCode` in a code block. |
| ArrowDown at the end of a code block | Matches | Moves to the next node, or makes a paragraph. |
| Backspace in an empty code block | Matches | Becomes a paragraph. |
| Backspace at the start of an empty heading at the top | Matches | Becomes a paragraph. A non-empty one stays, as in TipTap. |
| ⌃A, ⌃E, ⌃H, ⌃K, ⌃B, ⌃F, ⌃P, ⌃N, ⌘⌦ | Matches | TipTap's macOS keymap and Chromium's Cocoa keys. |
| ⌘E in Source vs View | Differs | Unchanged from RICH-EDITOR.md. ⌘E is inline code in View. |

### Paste and drop

| Item | Status | Notes | Tests |
|---|---|---|---|
| Paste text as Markdown | Matches | Existing. | |
| Paste an address over a selection | Matches | Links the selection (`linkOnPaste`). | `an_address_pasted_over_a_selection_links_it` |
| Picture paste | Matches | Electron has no image paste handler either. Raw clipboard pictures do nothing in both. | |
| Drop a picture, clip or sound | Matches | `![stem](relative or absolute path)`, at the drop point. | `attach::tests` |
| Drop any other file | Matches | A link with the file name, then a space. | `attach::tests` |
| Drop a document (`.md`, `.txt`, `.csv` and so on) | Matches | Opens it. | |
| Drag selected text to move it | Not built | ProseMirror's drag and drop of text. | |

### Links, tables, formulas, media

| Item | Status | Notes | Tests |
|---|---|---|---|
| Click a web link | Matches | Opens in the browser on release, like `handleDocumentClick`. | `behaviour::tests` |
| Click a link to a file | Matches | Through `markie_core::links::classify_click`: documents open in Markie RS, other passive files in their app, programs and bundles only in Finder, files outside the document's folder refused. | `behaviour::tests` |
| Click a cloud document link | Matches | The cloud agent's event, kept in the merge. | |
| Link safety | Matches | Every activation (a click, the preview card, an embed card) goes through one `activation` function. `javascript:`, `data:`, `file:` to an app, `vscode:` and any unknown scheme never reach the system opener. | `scripts_bundles_and_other_schemes_never_reach_the_opener` |
| Keyboard activation of a link | Matches | Electron has none inside the editor either. |  |
| Table bar while in a table | Matches | Same eight buttons and titles. | `behaviour::table_bar` |
| Header row toggle | Differs | Disabled. A Markdown table always has one header row; Electron writes a headerless table as HTML. | |
| Row above the header | Differs | The new row becomes the header. TipTap makes two header rows, which Electron saves as HTML. | `table_bar` |
| Inline formula editing | Matches | A click opens a field in place with the whole `$…$`. Enter or leaving commits, Escape cancels, empty removes. Was a prompt bar on double click. | |
| Embed card picture and title | Matches | Fetched only after a 450 ms hover, through the guarded preview fetch, for YouTube and Vimeo. Markie RS used to fetch YouTube pictures on open. | |
| Remote picture cache | Matches | Kept on disk in Markie RS's own data folder for a week, at most 2,000 files. Electron gets this from Chromium's cache. | |

### Spell check, context menu, accessibility, input methods

| Item | Status | Notes | Tests |
|---|---|---|---|
| Spell check | Differs | macOS spell checker with the current language. Red dotted marks. The word at the caret is spared until you leave it. Addresses are skipped. Code blocks are not checked; Chromium checks them too. | `spell::tests` (runs the real checker) |
| Spelling suggestions | Matches | Electron has no context menu, so there are none. | |
| Context menu | Matches | Electron 0.9.7 installs none. A right click selects the word, as Chromium does. | |
| Accessibility tree | Differs | A multiline text input with one text run per leaf on screen and the selection. Built only while VoiceOver or another reader is connected. Headings and lists have no roles of their own yet. Not tried with VoiceOver. | `a11y::tests` |
| Japanese and Chinese input | Differs | The composing path is unchanged and rules skip composing text. Not driven by a real input method; see the manual check below. | |
| Find and replace in View | Matches | Existing find bar with replace and replace all. | |

### Collaboration-facing behaviour

The byte model is unchanged. Corpus and round-trip tests pass. Fuzz: undo restores the file in 900 of 900 runs.

The fuzz now feeds `**`, `_`, `~~`, `==`, ```` ``` ````, `---` and a picture. Edited blocks that read back as shown went from 94.7% to 93.4%. Nearly all of the drop is the fuzz now firing rules on multi-character inputs such as `- `, as TipTap does after an input method commit. With single characters only it is 94.2%.

## Section 24: Link previews on hover

| Item | Status | Notes | Tests |
|---|---|---|---|
| Card after a 450 ms rest on a web link | Matches | Leaving first cancels the request. | |
| Hides 180 ms after leaving link and card | Matches | Hides at once on a click elsewhere, a scroll, Escape or an edit. | |
| Card layout | Matches | 320 px wide. Picture 132 px high. Site, title (2 lines), description (3 lines), host with ↗. Below the link, or above it near the bottom. | `link_card::tests` |
| Click the card | Matches | Opens the page, hides the card. | |
| Address rules | Matches | `markie_core::link_preview::parse_target`, checked again on every redirect. | core tests |
| Fetch limits | Matches | Public addresses only, connection pinned to them, 512 KB page and picture, 6 s for everything, 4 redirects, compressed bodies refused, no proxy or cookies, Electron's user agent. | `link_preview::tests` (local server: redirect, cache, size cap, gzip refusal) |
| Cache | Matches | Memory only, 30 minutes, 200 entries, 8 MB, 4 at once. | same |
| Settings switch | Not built | `RichView::link_previews` exists and is on. The Settings row is the dialogs track. | |

## Evidence

The evidence is the test suite. A release bundle was built and started once with a scratch `HOME`, a scratch `MARKIE_RS_DATA_DIR` and one scratch fixture. Window capture and focus were both refused from this session ("could not create image from window", and `act.sh` could not bring the window forward), so there are no screenshots. The instance was stopped by PID. `.autoloop/runs/editor-behaviour/` is empty. Electron was not started, and no file of Kirby's was opened or shown.

## Manual check for Kirby

Input methods cannot be driven by scripts. Once, in Markie RS View mode:

1. Switch to Japanese (Romaji) input, type `nihongo`, press Space, then Enter.
2. Check that `日本語` lands once, with no stray letters.
3. Type `# ` with the input method on, and check that a heading appears after the commit, not during it.
4. Repeat with Pinyin: `zhongwen`, Space, Enter.

## Open items

- Split mode (⌘3) and ⌘1/⌘2 mode keys, with the window shell.
- Drag and drop of selected text.
- Spell check in code blocks.
- Heading and list roles in the accessibility tree, and a VoiceOver pass.
- CodeMirror's ⌘-click cursors and ⌥-drag rectangles.
- The link preview Settings switch.
- A refused file link is only logged; Electron shows its message in a toast.
- Screenshots and a side-by-side with Electron, once screen capture works for this session.
- ⌘⇧F inside Source opens replace, not search all.
