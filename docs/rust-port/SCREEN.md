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
