#!/usr/bin/env bash
# Run a command while holding the one-screen lock shared by every agent.
# Usage: with-screen-lock.sh <your-label> -- <command...>
# Hold it for anything that takes focus or sends input: launching or
# activating a window, clicks, keystrokes, minimizing, the menu bar. Keep it
# short: launch, act, release. Capturing a window with capture.sh needs no lock.
set -euo pipefail
label="$1"; shift; [[ "${1:-}" == "--" ]] && shift
# Already inside a held lock (act.sh nested in a locked script): just run.
if [[ "${MARKIE_SCREEN_LOCK_HELD:-}" == "1" ]]; then exec "$@"; fi
lock="$HOME/Library/Caches/markie-screen.lock"
deadline=$(( $(date +%s) + 1200 ))
while ! mkdir "$lock" 2>/dev/null; do
  holder_pid="$(cat "$lock/pid" 2>/dev/null || echo 0)"
  since="$(cat "$lock/since" 2>/dev/null || echo 0)"
  now=$(date +%s)
  if ! kill -0 "$holder_pid" 2>/dev/null || (( now - since > 600 )); then
    echo "screen lock: clearing stale lock from $(cat "$lock/label" 2>/dev/null || echo unknown)" >&2
    rm -rf "$lock"; continue
  fi
  if (( now > deadline )); then echo "screen lock: gave up waiting for $(cat "$lock/label" 2>/dev/null)" >&2; exit 75; fi
  sleep 1
done
echo $$ > "$lock/pid"; date +%s > "$lock/since"; echo "$label" > "$lock/label"
trap 'rm -rf "$lock"' EXIT
export MARKIE_SCREEN_LOCK_HELD=1
"$@"
