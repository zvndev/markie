#!/usr/bin/env bash
# Draw one Markie RS scene to a PNG in the background: no window on screen,
# no focus, no input. See docs/rust-port/SCREEN.md.
#
# Usage: scene.sh <scene> <out.png> [light|dark] [args-json] [file...]
#   SCENE_BIN   the binary (default: rust/target/release/markie-rs built with
#               `cargo build --release -p markie-app --features scene`)
#   SCENE_HOME  scratch folder for HOME and the data folder (default: a new
#               temporary folder, removed afterwards)
#
# Prints the frontmost app and the pointer before and after, and fails if
# either changed while the scene ran.
set -euo pipefail
scene="$1"; out="$2"; theme="${3:-light}"; args="${4:-{\}}"; shift $(( $# < 4 ? $# : 4 ))
here="$(cd "$(dirname "$0")" && pwd)"
bin="${SCENE_BIN:-$here/../../target/release/markie-rs}"
[[ -x "$bin" ]] || { echo "scene.sh: no binary at $bin (build with --features scene)" >&2; exit 1; }
own_home=0
if [[ -z "${SCENE_HOME:-}" ]]; then SCENE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/markie-scene.XXXXXX")"; own_home=1; fi
mkdir -p "$SCENE_HOME/home" "$SCENE_HOME/data" "$SCENE_HOME/downloads" "$SCENE_HOME/documents"
mkdir -p "$(dirname "$out")"

front() { lsappinfo info -only name "$(lsappinfo front)" | sed -E 's/.*="?([^"]*)"?/\1/'; }
pointer() {
  if command -v cliclick >/dev/null; then cliclick p; else
    osascript -l JavaScript -e 'ObjC.import("AppKit"); var p=$.NSEvent.mouseLocation; Math.round(p.x)+","+Math.round(p.y)'; fi
}
before_app="$(front)"; before_ptr="$(pointer)"

log="$SCENE_HOME/scene-$scene.log"
env -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u MARKIE_RS_CLOUD_SERVER \
  HOME="$SCENE_HOME/home" MARKIE_RS_DATA_DIR="$SCENE_HOME/data" \
  MARKIE_RS_DOWNLOADS_DIR="$SCENE_HOME/downloads" MARKIE_RS_DOCUMENTS_DIR="$SCENE_HOME/documents" \
  ${SCENE_SERVER:+MARKIE_RS_CLOUD_SERVER=$SCENE_SERVER} \
  MARKIE_RS_SCENE="$scene" MARKIE_RS_SCENE_ARGS="$args" MARKIE_RS_SCENE_OUT="$out" MARKIE_RS_SCENE_THEME="$theme" \
  "$bin" "$@" >"$log" 2>&1 &
pid=$!
for _ in $(seq 1 240); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$pid" 2>/dev/null; then kill "$pid"; echo "scene.sh: $scene timed out (pid $pid killed)" >&2; fi
wait "$pid" 2>/dev/null && status=0 || status=$?

after_app="$(front)"; after_ptr="$(pointer)"
echo "frontmost before: $before_app, after: $after_app; pointer before: $before_ptr, after: $after_ptr"
grep 'markie-rs scene' "$log" || true
[[ $own_home == 1 ]] && rm -rf "$SCENE_HOME"
if [[ "$before_app" != "$after_app" || "$before_ptr" != "$after_ptr" ]]; then
  echo "scene.sh: the frontmost app or the pointer changed during the scene; stop and check the harness" >&2
  exit 3
fi
exit "$status"
