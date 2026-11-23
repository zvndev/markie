# One screen, many agents

Every agent that runs Markie RS or Electron Markie shares Kirby's one Mac screen. These rules keep agents out of each other's windows and out of Kirby's apps. They are not optional.

## Rules

1. **Target your own process by PID.** Never address an app by name or bundle id (`open -a`, `tell application "Markie RS"`, `pkill -f Markie`). Other agents run their own copies, and Kirby's real Markie is running.
2. **Launch the binary directly** so you know its PID:
   - Markie RS: `MARKIE_RS_DATA_DIR=<your scratch dir> "<your worktree>/rust/target/release/Markie RS.app/Contents/MacOS/markie-rs" <file> & echo $!`
   - Electron reference: `/Applications/Markie.app/Contents/MacOS/Markie --user-data-dir=<your scratch dir> <file> & echo $!`
   - Never start Electron Markie without `--user-data-dir`. Without it, it is Kirby's live app and profile.
3. **Hold the screen lock for anything that takes focus or sends input:** launching a window, clicks, keystrokes, resizing, minimizing, menus. Keep each hold short.
   - `rust/scripts/screen/with-screen-lock.sh <label> -- <command…>`
   - `rust/scripts/screen/act.sh` takes the lock for you.
4. **Send input only through `act.sh`.** It checks that your PID is the frontmost app before every click or keystroke and refuses otherwise.
   - `act.sh <pid> keys 'keystroke "n" using command down'`
   - `act.sh <pid> type 'Hello'`
   - `act.sh <pid> click <x> <y>` (points from your window's top-left)
   - `act.sh <pid> resize 1280 820`, `act.sh <pid> minimize`, `act.sh <pid> focus`
5. **Capture without the lock.** `capture.sh <pid> <out.png>` grabs your window even when another window covers it. It cannot capture a minimized window.
6. **Quit what you started, by PID:** `kill <pid>`. Never `killall`, `pkill -f`, or `osascript … quit`.
7. **Keep Kirby's folders out of the index.** Launch every scratch instance of either app with `env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME=<your scratch home>`, as well as its scratch data folder. The device index walks `$CLAUDE_CONFIG_DIR/skills` and the home folder, and Electron ignores a changed HOME, so in a scratch Electron never open or capture its Browse, Search or Library lists. Open only your own fixtures, passed on the command line.
8. **Scratch data only.** Fixtures, data dirs and profiles live in your own scratch folder. Never read or write `~/Library/Application Support/Markie`, Kirby's Keychain items, or his documents.

## Comparing with Electron

- Same window size on both: `act.sh <pid> resize 1280 820`.
- Same fixture file, same theme. Check light and dark.
- `side-by-side.py <electron.png> <rs.png> <out.png> [--diff <diff.png>]` lays the two captures next to each other. Use the pyenv `python3`, which has Pillow.
- Read exact sizes, colours, spacing and icons from the Electron source in `/Users/macbookpro-kirby/Desktop/Coding/ZVN/markdown-viewer-zvn/src` (read only). Screenshots confirm; the source is the spec.
- Keep evidence images under `.autoloop/runs/` in your worktree. That folder is gitignored.

Font smoothing differs slightly between Chromium and GPUI. Everything else should match: layout, sizes, colours, icons, spacing, wording and behaviour. A little more polished is fine. Different is not.

## When a click does nothing

A click that changes nothing is usually lost input, not a frozen app. Check before you debug the app.

1. **Look for event taps.** Another agent's computer-use service can hold a filtering session event tap that drops or delays mouse releases for every app. On 2026-11-22, Codex Computer Use (`SkyComputerUseService`) did exactly that, and both Electron and Markie RS saw presses without releases. List them with `rust/scripts/screen/taps.swift` (build line at its top). Never stop another agent's service; work around it.
2. **Press, then check.** `act.sh <pid> press <x> <y> <ms>` moves the pointer, waits, holds the button and releases. Do one press per step and capture before the next. A release can arrive seconds late, during your next press, so two quick presses on a toggle can cancel out.
3. **Electron's first click activates.** A click on an inactive Electron window only brings it forward. Press twice on idempotent controls, or check after each press.
4. **Trace Markie RS's input.** Launch with `MARKIE_RS_DEBUG_INPUT=1`. Each mouse press, release and key that AppKit hands the app is printed to stderr, with the window it targets, the key window and the first responder. A press with no AppKit release means the release never reached the app.
5. **Catch a real block.** `MARKIE_RS_WATCHDOG=1` (on in debug builds) appends to `main-thread-stalls.log` in the data folder when the main thread misses its beat for more than 2 s, and writes its stack beside it with `sample`. A stack idle in the event loop is labelled as a late timer.
6. **Keyboard paths are steadier.** ⌘K and the palette reach dialogs without a mouse press.

Coordinates for `act.sh` are points from the window's top-left. A 2560 px capture of a 1280 pt window is 2x, so halve pixel positions; a screenshot shown scaled to 2000 px wide maps to points by 0.64.
