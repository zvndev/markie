#!/usr/bin/env bash
# Send input to ONE app window, owned by <pid>, and nothing else.
#   act.sh <pid> focus
#   act.sh <pid> keys '<AppleScript keystroke args>'   e.g. 'keystroke "n" using command down'
#   act.sh <pid> type '<text>'
#   act.sh <pid> click <x> <y>        points from the window's top-left corner
#   act.sh <pid> press <x> <y> <ms>   move there, wait, press, hold <ms>, release
#   act.sh <pid> minimize
#   act.sh <pid> resize <w> <h>       window size in points, top-left kept
#   act.sh <pid> scroll <x> <y> <dy> <count> <gap-ms>
#                                     wheel events over the window at x,y (points
#                                     from its top-left); stops if the pointer
#                                     leaves the window (rust/scripts/bench)
# Takes the shared screen lock for itself unless the caller already holds it.
# Before every input it checks that <pid> is the frontmost app and refuses
# otherwise, so a keystroke can never land in another agent's window or in
# Kirby's own apps.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [[ "${MARKIE_SCREEN_LOCK_HELD:-}" != "1" ]]; then
  exec "$here/with-screen-lock.sh" "act-$1" -- "$0" "$@"
fi
pid="$1"; verb="$2"; shift 2
kill -0 "$pid" 2>/dev/null || { echo "act: pid $pid is not running" >&2; exit 1; }
se() { osascript -e "tell application \"System Events\" to $1"; }
front() { se 'get unix id of first process whose frontmost is true'; }
focus() {
  se "set frontmost of (first process whose unix id is $pid) to true" >/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do [[ "$(front)" == "$pid" ]] && return 0; sleep 0.2; done
  echo "act: could not bring pid $pid to the front; refusing to send input" >&2; exit 2
}
guard() { [[ "$(front)" == "$pid" ]] || focus; }
bounds() { osascript -l JavaScript "$here/windows.js" "$pid" | python3 -c 'import sys,json; r=sorted((json.loads(l) for l in sys.stdin if l.strip()), key=lambda r:r["w"]*r["h"], reverse=True); print(int(r[0]["x"]), int(r[0]["y"])) if r else sys.exit("no window")'; }
case "$verb" in
  focus) focus ;;
  keys) guard; se "$1" ;;
  type) guard; se "keystroke $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")" ;;
  click) guard; read -r wx wy < <(bounds); cliclick "c:$((wx + $1)),$((wy + $2))" ;;
  press) guard; read -r wx wy < <(bounds); x=$((wx + $1)); y=$((wy + $2)); cliclick "m:$x,$y" "w:150" "dd:$x,$y" "w:$3" "du:$x,$y" ;;
  minimize) guard; se "set value of attribute \"AXMinimized\" of window 1 of (first process whose unix id is $pid) to true" ;;
  scroll)
    tool="$here/../../target/bench-tools/postscroll"
    [[ -x "$tool" ]] || { mkdir -p "$(dirname "$tool")"; swiftc -O -target arm64-apple-macos13 "$here/../bench/postscroll.swift" -o "$tool"; }
    guard; read -r wx wy < <(bounds); cliclick "m:$((wx + $1)),$((wy + $2))"; "$tool" "$pid" "$3" "$4" "$5" ;;
  resize) guard; se "set size of window 1 of (first process whose unix id is $pid) to {$1, $2}" ;;
  *) echo "act: unknown verb $verb" >&2; exit 64 ;;
esac
