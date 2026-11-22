# Markie RS: visual parity for documents other than Markdown

Date: 2026-11-21. Reference: Electron Markie 0.9.7 (`/Applications/Markie.app`) with a scratch profile. Spec: `src/components/documents` and `src/components/formatting-toolbar.tsx` in the Electron source.

Every comparison was made at 1280 x 820, in light and dark, with the same fixture in both apps. Fixtures were generated in a scratch folder: a DOCX with mixed sizes, justified text, a comment, a tracked insertion, lists and a 31-row table; an editable DOCX with alignment, a page break and a table; engine-written RTF and DOCX; a LibreOffice RTF, ODT and DOC; a 40-row CSV; JSON, YAML, XML, HTML and TXT; and a 1.2 MB TXT.

## What now matches

### Word, RTF and ODT pages

- **One sheet, as Electron draws it.** Page view is one sheet at the paper width, with the page margins as padding, a minimum of one page tall, Electron's `0 1px 7px #0002` shadow and a 1 px border, on the surface-2 background with 30 px around it. Continuous view is a 960 px sheet that fills the view. Electron never splits a document into pages on screen, so neither does Markie RS.
- **Mixed text sizes in one paragraph.** A new paragraph painter, `markie-office-view/src/flow.rs`, lays runs out the way a browser lays out spans: each run keeps its own size, runs share a baseline, and every line keeps the paragraph's Georgia 12 pt strut at the paragraph's line height.
- **Justified text.** The same painter spreads justified lines across the column and leaves the last line ragged, as CSS `text-align: justify` does.
- **Paragraph spacing.** Space before and after collapse between neighbours, as CSS margins do. Paragraphs are at least 1.4 em tall, Electron's `min-height`, so single-spaced RTF and ODT lines sit 22.4 px apart like Electron's.
- **Tables.** 1 px rules in the border color and 7 px cell padding on every side, with no extra space around the table.
- **Page breaks.** Electron's dashed "Page break" marker sits inside the paragraph, followed by its empty line, at the same place and spacing.
- **The toolbar.** It is Electron's `FormattingToolbar` as the Word editor configures it: page setup and paragraph spacing buttons, undo and redo, zoom with the 100% label, the paragraph style and font pickers, size with minus and plus, bold, italic, underline, text color, link and picture, bullet and numbered lists, left, center and right alignment, and clear formatting. The icons are Electron's own SVG paths at 15 px with a 1.8 stroke. Button size, hover, pressed and disabled states, dividers and spacing follow the source. When the row is too narrow, groups move into a More menu in Electron's order and by its width rules. RTF and ODT drop the same controls Electron drops.
- **Banners.** Pending revisions, tracking and Original view show as Electron's blue notes. The read-only strip is Electron's yellow on the surface color. Order, sizes and padding match.
- **No margin cards or change bars.** Electron shows comments and tracked changes only in the Review tool, not beside the page, so Markie RS does the same. Accept and Reject remain in Review.
- **No caret on a read-only page.** Electron's read-only paragraphs are not editable, so they show no caret.
- **Theme paper by default.** The page follows the theme, as Electron's does. White paper is still one click away, now under View > Word Layout > Light Paper instead of in the toolbar.

### CSV

Electron shows a CSV as a table in the rich page column. Markie RS now draws its CSV view the same way:

- The table sits in the page column.
- Each column is as wide as its widest text plus padding, with a 3 rem minimum.
- The header is bold and centered.
- Rows are 65 px tall, with one rule between rows and no column lines.
- Rows highlight on hover.

Column widths are measured once per table from the first 2,000 rows, and rows stay virtualized, so a large CSV costs nothing per frame.

### TXT, JSON, YAML and XML

Electron shows these in its `TextDocumentEditor`. Markie RS now matches it:

- The toolbar row reads "JSON · Literal text", then Find, the encoding and newline ("UTF-8 · LF"), undo and redo, zoom, the Monospace picker, and size.
- The text is 14 px monospace at line height 1.85, padded 64 px.
- There are no line numbers and no syntax colors.

### Large documents

A file over 1 MB opens in Source under Electron's strip: "≡ Large document (1.2 MB). Opened in source view; rich editing and live collaboration are off for files over 1.0 MB." The wording, size, color and padding match.

### Fixed on the way

A file the Office engine refused at launch made Markie RS abort, because it pushed a notification before the window was ready. The notification now waits one frame. The refused-file placeholder still said the Office engine was future work. It now shows Electron's red error strip and an "Open in default app" button.

## What still differs, and why

- **The toolbar has no History button.** Electron's clock opens Word version history, which is another agent's work in Markie RS. It goes in when that lands.
- **The read-only strip says "Saving keeps the unchanged original."** Electron says "You can export the unchanged original." Markie RS has no Export yet (phase 5), so copying the wording would promise something that is not there.
- **The size field cannot be typed into.** It shows the size, and minus and plus change it. Typing a size uses Format > Font…. The Monospace picker in the text toolbar is a label; size and zoom work.
- **CSV is read-only in View mode.** Electron turns a CSV into a Markdown table in its rich editor, lets you edit cells there, and writes CSV back on save. Doing that in Markie RS means routing CSV through the rich editor and adding CSV round-trip saving, which belong to the window shell and editor agents. Editing in Source works. The table toolbar Electron shows above a table (+ Row, + Col, Header) is part of that rich editor.
- **CSV columns run slightly wide.** Widths are measured from glyph advances in the theme font, so columns differ from Chromium's table layout by a few pixels each.
- **DOC and HTML open differently.** Electron asks "Import a text copy?" and, if you agree, opens a new TXT copy. Markie RS shows the DOC's text in the page view with a "Save a TXT copy" button, and shows HTML as a read-only rendered page. Matching Electron needs a modal and changes to the open flow in `workspace.rs`, which the window shell and dialogs agents own.
- **The large-document editor keeps the shared Source editor.** Electron's large-file Source view is its Markdown source editor. The column, gutter and current-line look belong to the editor agent.
- **The selection highlight does not fill the extra space in a justified line.** The painter shades each run's own glyphs, so a selection shows small gaps where justification widened the spaces.
- **Dashes and font smoothing.** GPUI draws the page-break rule with shorter dashes than Chromium. Text antialiasing differs slightly, as SCREEN.md expects.

Not mine but visible in every capture: the window shell (title bar, Library panel, status bar) differs from Electron's activity bar and title bar. With the Library open, the Word toolbar is narrower than Electron's, so it moves a few groups into More, just as Electron would at that width.

## Performance

- Shaping a paragraph goes through GPUI's line-layout cache. Runs of one size are shaped once and then split at break points, so no glyph is shaped twice in a frame.
- The painter keeps its layout for carets and clicks. It re-lays out only when the wrap width changes.
- The one-sheet view drops the old page-height measuring pass, which could request extra frames while pages settled.
- CSV widths are cached per table.
- The toolbar measures its own width with one canvas callback. It asks for a new frame only when that width changes.

## Tests

- `cargo test --workspace`: 654 passed, 0 failed, 1 ignored.
- Office engine and view tests pass unchanged, including the byte-for-byte save of untouched and reverted files.

## Evidence

Each image has Electron on the left and the Markie RS release build on the right, at 1280 x 820. The images are under `.autoloop/runs/visual-formats/`.

| Fixture | Light | Dark |
|---|---|---|
| DOCX with mixed sizes, justify, review notes, table | `light-sample-docx.png` | `dark-sample-docx.png` |
| Editable DOCX with alignment, page break, table | `light-edit-docx.png` | `dark-edit-docx.png` |
| Engine-written RTF (continuous view) | `light-engine-rtf.png` | `dark-engine-rtf.png` |
| CSV | `light-people-csv.png` | `dark-people-csv.png` |
| JSON | `light-config-json.png` | `dark-config-json.png` |
| 1.2 MB TXT | `light-big-txt.png` | `dark-big-txt.png` |

## Files

- `rust/crates/markie-office-view/src/flow.rs`: new. The paragraph painter.
- `rust/crates/markie-office-view/src/icons.rs`: new. Electron's toolbar SVG paths.
- `rust/crates/markie-office-view/src/view.rs`: the sheet, toolbar, pickers, banners and caret.
- `rust/crates/markie-office-view/src/commands.rs` and `actions.rs`: the Light Paper command.
- `rust/crates/markie-app/src/workspace/office.rs`: toolbar zoom.
- `rust/crates/markie-app/src/workspace/text_view.rs`: new. The literal text view and the large-document strip.
- Window shell files, kept to small edits:
  - `workspace/panels.rs`: the body of `render_csv` and a width helper.
  - `workspace.rs`: the text, engine and large arms of `render_document`, and three lines in `open_path`. Those three lines turn off line numbers and syntax colors for literal text and defer the refusal notification.
