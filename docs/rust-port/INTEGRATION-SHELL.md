# Markie RS: shell, formats and web integration

Date: 2026-11-22. Branch: `t3/markie-rs-shell-format-parity`, from `rust/markie-rs` at fb2654e.

This closes the ten open items the shell, formats and web export reports left in the window shell. The reference is Electron Markie 0.9.7. Its source is the spec.

## Summary

| # | Item | Status | Commit |
|---|---|---|---|
| 1 | ⌘1, ⌘2, ⌘3 view modes and Split | Done | 70eacac |
| 2 | Unsaved, untitled documents; Make Interactive | Done for text kinds | 9fbb8fb |
| 3 | Library and Browse leftovers | Done, two menu entries left | 718c233 |
| 4 | `.doc` and HTML as text copies | Done | 272e3cd |
| 5 | CSV editing in View, saved as CSV | Done | 99499b5 |
| 6 | Typed font size in the Word toolbar | Done | fc953e6 |
| 7 | Live Docs page and site preview | Done (nightly) | 283b6f5 |
| 8 | Web views under GPUI overlays | Done for every Markie layer | 46424fb |
| 9 | Print button and ⌘P | Done | ddb5ecb |
| 10 | ⌘⇧F in Source searches all documents | Done | 9a110a0 |

`cargo test --workspace`: 919 passed, 0 failed, 2 ignored.

## Screen evidence

None. Kirby's Mac was locked for the whole run. `ioreg -n Root -d1` reported `IOConsoleLocked = Yes` at the start and again before the final commit. A locked console draws no windows, so neither app could be captured or driven. Every item below was verified by unit tests and builds only.

These surfaces still need a side-by-side capture with Electron, light and dark, at 1280 x 820:

1. Split mode on a Markdown file, and on a CSV.
2. A new Markdown document: the title bar with no name, and the recovery strip after relaunch.
3. Make Interactive, with `MARKIE_RS_NIGHTLY=1`.
4. The Library row with its sync icon and the ⋯ menu, signed out and signed in.
5. The panel resizer: hover line, drag, double-click.
6. Browse's nested tree, its stars and "Show N more".
7. The "Import a text copy?" dialog, and a `.doc` opened as its converted copy with the warning strip.
8. A CSV in View: cell editing and the table toolbar.
9. The Word toolbar's size field while typing.
10. The Live Docs home, a project with tabs, and the preview panel over a running `darkmown dev`.
11. The `.wd` preview hiding under the palette, a dialog and the share sheet.
12. The print sheet from the toolbar button.

## Items

### 1. View modes and Split

- ⌘1 is Rich Text, ⌘2 Markdown Source, ⌘3 Split. The View menu and the palette carry all three, as `electron/main.js` and page.tsx do.
- Split lays the source pane on the left at 0.96fr with its 1 px border, and the rich pane on the right at 1.04fr. That is `markie-document-area--split`.
- Both panes edit. A source edit re-parses into the rich pane and keeps its scroll. A rich edit copies its Markdown into the source pane. Saving takes the pane edited last, Electron's `lastPane`.
- Like `requestMode`, large and literal text documents stay in Source. Markdown and CSV split.
- Tests: `mode_tests` (allowed modes per format), `key_tests::view_modes_are_cmd_1_2_3`.
- Differs: Electron draws one formatting row above both panes. Markie RS shows the rich editor's own toolbar over the rich pane only, because that toolbar lives inside `markie-editor`, which another agent owns.

### 2. Untitled documents and Make Interactive

- New Markdown, plain text, Darkmown, CSV, JSON, YAML and XML documents open as an unsaved buffer, as `handleNewFile` does. The title bar shows no name and "Open file…".
- Autosave keeps the buffer in the draft journal under the untitled key. ⌘S is Save As. Leaving the buffer for another document journals it without a dialog, as `useSaveGuard().settle()` does.
- A launch that opens no file offers the untitled journal entry through the recovery strip.
- Rename, duplicate, move, trash, reveal, copy path and star do nothing on an untitled buffer. Save a Copy and export suggest the Library's first folder.
- File > Make Interactive and the palette's "Make interactive" open the Markdown on screen as an unsaved `.wd`, named by `interactiveCopyName`. The Markdown file is not written. Both are behind the super-nightly switch, as in Electron.
- Tests: `untitled::tests` (copy names, which formats convert).
- Open: new Word, RTF and ODT documents still ask where to go first. The Office view and its autosave write to the document's path, so an unsaved Office buffer needs changes there.

### 3. Library and Browse

- Library rows end like Electron's: the type badge, a 13 px sync icon in its status colour with its label on hover, then a ⋯ button shown on hover.
- ⋯ or a right-click opens `FileMenu` with `rowMenuEntries`' order and rules: Copy path, the sync action the state calls for, Manage sharing…, Stop syncing to cloud…, and Delete file… on its own.
- The sync state is read from `cloud.rs`'s own row label. Sync actions open the document and hand it to the cloud work's sheet (`show_text_sync`, `open_share`). Electron runs some of them in place from the menu.
- The panel resizer follows `panel-width.ts`: 200 to 520 px, at most 45% of the window, Escape cancels a drag, double-click resets to 252, and the width is kept between launches.
- Browse is `folder-tree.ts`'s nested tree. Single-child chains fold into one label and hairlines mark each level. The first branching level opens until the person opens or closes a folder, and their choices are kept. A filter opens the tree to its matches, Updated sorts newest first, and a folder over 200 rows shows "Show N more".
- Every Browse folder and file row has its ☆.
- Tests: `folder_tree::tests`, `library_rows::tests`, `panel_width_tests`, `count_tests`.
- Open: Copy link and the two Live Doc address entries are not in the menu. They need the cloud agent's link builder.

### 4. `.doc` and HTML

- A `.doc` opens as a new unsaved `<name> (converted).txt`, read off the main thread. Electron's warnings sit above it in the yellow `docs-warning` strip, as `importSession` does.
- An HTML file asks "Import a text copy?" with Electron's wording, Cancel import and Create text copy. Create text copy opens an unsaved `<stem> converted.txt` from `convert_additional_document`.
- The source file is never written.
- Tests: `import_copy::tests`.

### 5. CSV in View

- A CSV loads into the rich editor as its first table in GFM, as page.tsx's `fromDisk` does. Cells edit in place with the table toolbar. Source shows the table's Markdown, as in Electron.
- Every write goes through `markdownTableToCSV`: ⌘S, autosave, Save As to `.csv` and Save a Copy to `.csv`. The disk watcher and version history keep the CSV bytes.
- A manual save that leaves prose or a later table out says so with Electron's "Saved as CSV: …" wording.
- The hand-drawn CSV table is gone.
- Tests: `csv_doc::tests` (CSV to table, first table back, round trip, save notes).

### 6. Word font size field

- The size between minus and plus is a field: 38 x 28, Electron's border, 11 px centered text.
- It shows the selection's size, or nothing under an Auto or Mixed placeholder.
- A value Electron's number field accepts (1 to 400 points, half steps) applies as it is typed. The field stops following the selection while it has focus.
- Tests: `size_field_tests`.

### 7. Live Docs

Behind `MARKIE_RS_NIGHTLY=1`, as Electron gates it.

- The Live Docs page opens from its own rail button. The home lists projects under "On this Mac", with Add Project… and Remove, which asks first.
- A project shows `live-docs-area.tsx`'s layout: back, name and location, a 240 px tree, up to twelve tabs, one editor, the reload and keep-mine strips, and the footer. ⌘S writes only at the revision the tab read.
- Outside edits reach the tree and the tabs through a two-second look. A file is read again only when its size or change time moved.
- "Open Darkmown project preview…" asks for a folder, checks it, and runs the project's own `darkmown dev`. The site shows in `SitePreview` laid over the panel body. Escape or × stops the server.
- The project list is `live-docs-projects.json` in Markie RS's own data folder.
- Tests: `live_docs::tests` (tree order, first open folders, grammars, tabs, outside-change rules). `markie-web` keeps its own project and dev-server tests.
- Differs: Electron watches with `fs.watch`; Markie RS polls. The tree walk runs on the main thread.

### 8. Web views and overlays

- `Workspace::web_views_covered` names every layer that can sit over the document area. That is title-bar menus, Markie's dialogs and the palette, ⇧⌘F search, the share sheet, GPUI Kit dialogs and sheets, and the Cloud, Vault and Live Docs pages or a version preview.
- The `.wd` preview and the Live Docs site view hide while any of these is open. The `.wd` preview also hides under the Live Docs preview panel.
- Tests: `cover_tests`.
- Open: GPUI Kit toasts and right-click context menus can still sit under a web view.

### 9. Print

- The rich toolbar's Print button and the More menu's Print emit `RichEvent::Print`. The workspace sends that to `on_print`, the path ⌘P takes: the PDF on the macOS print sheet.
- This is the one hook in `markie-editor/src/chrome.rs` the task allowed.
- Tests: `key_tests::cmd_p_prints`.

### 10. ⌘⇧F in Source

- GPUI Kit's code editor bound ⌘⇧F to its replace bar. Markie RS now binds ⌘⇧F to FocusSearch in that context too, after `gpui_kit::init`, so search all documents wins. Replace stays on ⌥⌘F, as in Electron.
- Tests: `key_tests::cmd_shift_f_searches_all_documents_inside_the_source_editor`.

## Files

Mine:

- `markie-app`: `main.rs`, `actions.rs`, `icons.rs`, `workspace.rs`.
- `markie-app/src/workspace/`: `rail.rs`, `chrome.rs`, `panels.rs`, `overlay.rs`, `palette.rs`, `file_ops.rs`, `export.rs`, `strips.rs`, `rich.rs`, `darkmown.rs`.
- New in `markie-app/src/workspace/`: `untitled.rs`, `import_copy.rs`, `csv_doc.rs`, `folder_tree.rs`, `library_rows.rs`, `live_docs.rs`.
- `markie-office-view/src/view.rs`.

Outside my list, kept small:

- `markie-editor/src/chrome.rs`: the Print button and the More menu's Print emit `RichEvent::Print` (item 9, as allowed).
- `workspace/rich.rs`, `strips.rs`, `palette.rs`, `overlay.rs`, `export.rs`, `file_ops.rs`, `darkmown.rs`: hooks only. `cloud.rs`, `cloud_ui.rs` and `share.rs` are read, not changed.

## Open items

1. Screen captures of every surface listed under Screen evidence.
2. Unsaved Word, RTF and ODT documents.
3. Copy link and the Live Doc address entries in the Library row menu.
4. One formatting row above both panes in Split.
5. Toasts and context menus over web views.
6. Live Docs: file watching instead of the poll, and the tree walk off the main thread.
