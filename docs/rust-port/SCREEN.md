# Comparing screens without Kirby's screen

Kirby uses his Mac while agents compare Markie RS with Electron Markie. Comparisons run in the background and never touch his display. These rules are not optional.

## The rule (Kirby, 2026-11-23)

"Stop driving my screen for comparing. Just compare, and if you need the screen, schedule it with me."

- **Never take focus or send input on Kirby's display.** That means no `act.sh` clicks, keys, typing, presses, resizing, focusing or minimizing. No `osascript` UI scripting or synthetic events. No window that activates itself or becomes key. No moving the pointer.
- **Record the frontmost app and the pointer before and after every run.** `scene.sh` does this and fails if either changed. Reading them is allowed: `lsappinfo front`, `cliclick p`.
- Kirby moves his own mouse while scenes run. If the pointer moved, sample it with nothing running to see whether he is moving it. Markie RS never warps the pointer, and a scene never shows a window.
- **If something cannot be compared without his screen, don't do it.** List it as "needs a scheduled screen session" with how long it would take, and ask Kirby for a time.

## The default way to compare

Both apps draw off screen. Markie RS draws its own frame to a PNG from a hidden window. Electron's own React components draw in headless Chromium.

### 1. Scratch servers and data

```sh
S=<your scratch dir>
rust/scripts/screen/scene/servers.sh start $S   # :18991 primary, :18995 "Dana's server"
node rust/scripts/screen/scene/seed.mjs $S      # writes $S/seed.json (throwaway tokens)
```

The servers are this repo's `server/` with scratch databases and console mail, so no mail leaves the Mac. The seed makes Alice (owner of "Quarterly plan.md", shared with Bob and Carol, plus one pending invite to `success@simulator.amazonses.com`) and Dana on the second server. Stop them with `servers.sh stop $S`.

For the Recent and Cloud page scenes, `node rust/scripts/screen/scene/seed-home.mjs $S [a.docx]` writes made-up documents of every kind to `$S/docs` and the scene arguments to `$S/home.json` (`--local` skips the servers). On the primary server Alice owns six documents and shares one, Bob shares two with her, Carol and Frank each have a request waiting, and Erin's account is empty. Keep Alice's `SCENE_HOME` between runs, so her synced files bind once.

### 2. Markie RS: scene mode

Build once with the `scene` feature. It is off by default and must never be in a shipped build.

```sh
(cd rust && cargo build --release -p markie-app --features scene)
SCENE_SERVER=http://localhost:18991 rust/scripts/screen/scene.sh <scene> <out.png> <light|dark> '<args-json>' [file]
```

`MARKIE_RS_SCENE` makes the app an accessory app (no Dock icon, no menu bar, never active). Its window is never shown and never key. The scene puts the window in a state from code, through the same functions the buttons call, then writes the frame GPUI drew with `Window::render_to_image`. The window server is never asked for pixels, so the window never has to be on screen. A scratch `MARKIE_RS_DATA_DIR` is required, so sessions stay in memory and the Keychain is never read. Servers must be on localhost.

| Scene | Args | State |
|---|---|---|
| `doc` | none | The file passed on the command line |
| `live` | none; needs `MARKIE_RS_TEST_SESSION` (made by `scene/seed-live.mjs`) | The file passed on the command line in a live session on the scratch server, once the room is claimed, with any live note under the title bar |
| `style-settings` | optional `editor: true`, `group` (an element id such as `tables`), `edit` (choices to change first, `{"tableStyle": "zebra"}`), `face` (`body`, `heading`, `code`, `style-body`) | Settings › Appearance with the Markdown style section; the style editor, one of its elements and a font menu, opened the way their buttons open them |
| `csv` | optional `header: false`, `filter`, `sort: [column, "asc" or "desc"]`, `cursor: [row, column]`, `anchor: [row, column]`, `scroll: [x, y]`, `resize: [[column, width]]`, `hover: [row, column]`, `scrollbars: true`, `edit: true`, `text: true`; `keys` (keystrokes for the grid's own handler, `{"type": "…"}` to fill an open cell, `{"op": …}` for `commit`, `commit-right`, `cancel`, `tab`, `add-row`, `add-column`, `delete-row`, `delete-column`, `undo`, `redo`, `select-all`, `clear`, `sort`); in the same list `{"jump": "B4"}` for the name box and `{"bar": "…"}` to type in the formula bar and press Enter, and the ops `select-column` and `select-row`; `cursor` is the active cell and `anchor` the other corner of a block; `report: true` prints the file's text, cursor, the active cell's name and value, the status bar and what ⌘C would copy as a `markie-csv-state` line in the scene log; `bench: true` times a large file (PERF.md) | The CSV or TSV passed on the command line as its table, or as its text. Rows count from 0 on screen and -1 is the header. A scene never writes the pasteboard |
| `share` | `token`, `doc_id`, `file_name`, optional `pending` (addresses), `query`, `role: "editor"`, `menu`, `look: "on"` (turn on "Readers see my look" and wait for the server) | Share dialog for a cloud document, loaded |
| `office-cloud` | `token`, optional `upload: true` | The open office file's cloud dialog, before or after Create a cloud copy |
| `servers` | `token`, `second_origin`, `email`, `password`, optional `stop` (`confirm`, `added`, `form`) | Settings › Advanced with the second server added and signed in |
| `vault` | `state`: `none`, `create`, `create-error`, `locked`, `locked-touch`, `locked-error`, `unlocking`, `empty`, `items`, `few`, `search`, `note`, `file`, `env`, `env-revealed`, `env-copied`, `gate`, `settings`, `settings-touch`, `restore` | The vault page on a scratch vault with synthetic items. Touch ID and the clipboard are in-memory doubles, so the Keychain and pasteboard are never touched |
| `browse` | optional `state`: `scanning`, `rescanning`, `empty`, `truncated`; `filter` (words); `type`: `markdown`, `docx`; `starred: true`; `open` (folders to open in the tree); `select` (the folder on show); `cursor` (the highlighted row). Paths are relative to the scratch home | Browse, "Documents on this Mac", over a synthetic home folder. See below |
| `recent` | `recents` (`[{path, hours_ago, star?}]`, seeded into the scratch registry); optional `tab: "starred"`, `view: "list"`, `filter` (words), `type: "markdown"`, `sort`: `name`, `type`; `cursor` (n, the keyboard cursor); `menu`: `type`, `sort`, `row` | The Recent page: document cards grouped by day, once every thumbnail is in. A path with no file is a "Missing on disk" card |
| `launch` | as `recent` | What a launch with no file shows after the first one: the Recent page over the empty page. With no `recents`, the empty state |
| `library` | `recents` | The Library panel's Recent list beside the file passed on the command line |
| `skills` | optional `width` (the panel's width), `filter` (words), `full: true` (the `~/` toggle), `star` (labels to star), `closed` and `open` (kind labels to fold or unfold, such as `Skills`), `cursor` (the label the keyboard cursor is on, which shows its toolbar), `menu` (a label whose row menu is open, where Shift-F10 opens it), `confirm` (a label whose Remove is asking) | The Skills panel over a synthetic agent tree. Fill the scratch data folder first with `scene/skills-fixture.py $S/data`, and keep `$S` out of `/tmp`, which the Skills view skips as a cache |
| `cloud` | optional `token` (signed out without it), `recents`, `sync` (local files to turn sync on for), `snapshots` (office files to upload once), `min_docs`, `min_requests`, `second_origin` with `email` and `password` (adds and signs in to a second server first); then `requests_open: true`, `view: "list"`, `sources` (`only-me`, `by-me`, `with-me`), `menu`: `area`, `type`, `sort`, `row` | The Cloud page: signed out, empty, or signed in with documents, share requests and snapshots, once every thumbnail is in |
| `google` | optional `connected: false`, `importing: true`, `waiting: true`, `empty: true`, `notice` (a warning line) | Settings › Files with the Google Docs row: made-up synced Docs, one with an error, and the import progress. No network; the grant is in memory (GOOGLE-DOCS.md) |

Every scene also takes `style` (a Markdown style preset id, or a whole style store as JSON), `template` (a colour template id) and `code_font`. `MARKIE_RS_SCENE_SIZE=1280x1000` sets the window size; macOS keeps a window no taller than the screen. The Markdown style gallery (`scene/style-gallery.py`, [STYLES-FONTS.md](STYLES-FONTS.md)) draws the Lighthouse sample in four parts for that reason.

#### Browse scenes

Browse lists the home folder, so its scenes need a made-up one. A scratch `MARKIE_RS_DATA_DIR` already stands in for home in the index; fill it first, and put the documents folder inside it:

```sh
python3 rust/scripts/screen/scene/browse-fixture.py $S/data     # about 330 synthetic files
SCENE_HOME=$S SCENE_DOCUMENTS=$S/data/Documents rust/scripts/screen/scene.sh browse out.png light '{"select":"Documents/Work"}'
```

- Every name in a Browse capture must come from `browse-fixture.py`. Never run a Browse scene without a scratch `SCENE_HOME`, and never point one at a real folder.
- The scene drops the data folder's own files (the registry, drafts) from the list, since a real home folder has none.
- A `select` or `open` path that does not exist shows the "no longer there" notice. `empty` needs an empty scratch data folder to look right from launch.
- Electron's Browse may not be captured (rule 7 below), so these scenes compare Markie RS with itself, before and after.

### 3. Electron: headless renderer

```sh
cd rust/scripts/screen/scene/electron
MARKIE_ELECTRON_SRC=/Users/macbookpro-kirby/Desktop/Coding/ZVN/markdown-viewer-zvn \
PLAYWRIGHT_CORE=<a playwright-core folder> SCENE_CACHE=$S/vite-cache SCENE_FIXTURES=<fixtures dir> \
node shoot.mjs <jobs.json>
```

- Never launch the real Electron app window for a comparison.
- `vite.config.mjs` serves the Electron checkout's own source, read only, plus one page, `scene-main.tsx`, that mounts a single component (`ShareDialog`, `DocumentCloudDialog` or `Settings`). Vite's cache goes to `SCENE_CACHE`, so nothing is written into the checkout.
- `shoot.mjs` opens headless Chromium at 1280×820 and 2x scale, puts the sessions in `localStorage` before the page loads, and for Settings adds the few `preload.js` calls it needs. A job's `steps` fill, press, select and click inside the page. Headless Chromium never touches the display. `blur: true` drops focus before the shot, to match a Markie RS scene, whose window is never active.
- `PLAYWRIGHT_CORE` can be any copy of `playwright-core`. The browser is the newest headless shell in `~/Library/Caches/ms-playwright`, or `SCENE_CHROMIUM`.
- The headless frame was checked against a real 0.9.7 capture of the share dialog (capture pass 2): same panel, fonts, selects and spacing.

### 4. Compare

```sh
rust/scripts/screen/scene/compare.py <electron.png> <rs.png> <out-prefix> [x y w h]
```

The box is in points. It writes a labelled side by side and an amplified difference image, and prints the share of pixels that differ. Use the pyenv `python3`, which has Pillow.

- Read exact sizes, colours, spacing and icons from the Electron source in `/Users/macbookpro-kirby/Desktop/Coding/ZVN/markdown-viewer-zvn/src`, read only. Screenshots confirm; the source is the spec.
- Check light and dark.
- Keep evidence under `.autoloop/runs/` in your worktree. That folder is gitignored.
- Font smoothing differs slightly between Chromium and GPUI. Everything else should match: layout, sizes, colours, icons, spacing, wording and behaviour. A little more polished is fine. Different is not.
- The page behind a dialog differs: Markie RS draws its window, the harness draws an empty page. Crop to the dialog.

### Adding a scene

1. Markie RS: add a match arm in `scene_step` (`rust/crates/markie-app/src/workspace/scene.rs`). Reach the state through the functions the controls call. Put any helper that needs a module's private fields in that module, behind `#[cfg(feature = "scene")]`. Return true once the state is ready; the runner settles, draws and quits.
2. Electron: add the component to `scene-main.tsx`, with the props the app passes it.
3. Seed any data in `seed.mjs`, never by hand on a real server.

## Old flow: needs a scheduled session with Kirby

Everything below drives the real windows on Kirby's screen. Use it only in a session Kirby has scheduled, for something a scene cannot reach (a native menu or popup, drag and drop, the trackpad, Touch ID, window chrome, real focus behaviour).

1. **Target your own process by PID.** Never address an app by name or bundle id (`open -a`, `tell application "Markie RS"`, `pkill -f Markie`). Kirby's real Markie is running.
2. **Launch the binary directly** so you know its PID:
   - Markie RS: `MARKIE_RS_DATA_DIR=<your scratch dir> "<your worktree>/rust/target/release/Markie RS.app/Contents/MacOS/markie-rs" <file> & echo $!`
   - Electron reference: `/Applications/Markie.app/Contents/MacOS/Markie --user-data-dir=<your scratch dir> <file> & echo $!`
   - Never start Electron Markie without `--user-data-dir`. Without it, it is Kirby's live app and profile.
3. **Hold the screen lock** for anything that takes focus or sends input: `rust/scripts/screen/with-screen-lock.sh <label> -- <command…>`. `act.sh` takes it for you.
4. **Send input only through `act.sh`**, which checks that your PID is frontmost before every click or keystroke.
5. **Capture without the lock.** `capture.sh <pid> <out.png>` grabs your window even when it is covered, but GPUI stops drawing an occluded window, so a covered Markie RS window shows a stale frame. Scenes avoid this.
6. **Quit what you started, by PID:** `kill <pid>`. Never `killall`, `pkill -f`, or `osascript … quit`.
7. **Keep Kirby's folders out of the index.** Launch scratch instances with `env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME=<your scratch home>`. Electron ignores a changed HOME, so never open or capture its Browse, Search or Library lists.
8. **Scratch data only.** Never read or write `~/Library/Application Support/Markie`, Kirby's Keychain items, or his documents.

### When a click does nothing (scheduled sessions only)

1. **Look for event taps.** Another agent's computer-use service can hold an event tap that drops mouse releases (`rust/scripts/screen/taps.swift`). Never stop another agent's service.
2. **Press, then check.** One press per step, and capture before the next.
3. **Electron's first click activates** an inactive window.
4. **Trace Markie RS's input** with `MARKIE_RS_DEBUG_INPUT=1`.
5. **Catch a real block** with `MARKIE_RS_WATCHDOG=1`, which writes `main-thread-stalls.log` in the data folder.
