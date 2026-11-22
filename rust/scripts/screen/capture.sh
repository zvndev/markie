#!/usr/bin/env bash
# Capture one app window to a PNG without focusing it, clicking or moving it.
# Usage: capture.sh <pid> <out.png> [window-name-substring]
# Picks the largest normal window owned by <pid>. Never target an app by name
# or bundle id: other agents run their own copies on the same screen.
set -euo pipefail
pid="$1"; out="$2"; match="${3:-}"
here="$(cd "$(dirname "$0")" && pwd)"
line="$(osascript -l JavaScript "$here/windows.js" "$pid" | { if [[ -n "$match" ]]; then grep -F "\"name\":\"" | grep -F "$match"; else cat; fi; } \
  | python3 -c 'import sys,json; rows=[json.loads(l) for l in sys.stdin if l.strip()]; rows.sort(key=lambda r: r["w"]*r["h"], reverse=True); print(rows[0]["id"] if rows else "")')"
if [[ -z "$line" ]]; then echo "no window for pid $pid" >&2; exit 1; fi
# -o drops the shadow, -x keeps it silent. Works while the window is covered,
# but not while it is minimized.
screencapture -x -o -l "$line" "$out"
echo "$out"
