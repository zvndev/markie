#!/usr/bin/env bash
# Profile one Markie RS launch with samply, holding the screen lock while the
# window opens. Needs a build with symbols:
#   CARGO_PROFILE_RELEASE_STRIP=false CARGO_PROFILE_RELEASE_DEBUG=line-tables-only \
#     cargo build --release -p markie-app --target-dir target/prof
# Usage: profile.sh <file> <seconds> <out-prefix> [data-dir]
# Writes <out-prefix>.json(.syms.json) and prints the hottest functions.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rust="$(cd "$here/../.." && pwd)"
file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; secs="$2"; out="$3"
data="${4:-$(dirname "$out")/data-profile}"
mkdir -p "$data/home"  # scratch HOME: the index never walks Kirby's folders
bin="$rust/target/prof/release/markie-rs"
"$rust/scripts/screen/with-screen-lock.sh" bench-profile -- bash -c '
  env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME="$1/home" MARKIE_RS_DATA_DIR="$1" MARKIE_RS_PERF=1 samply record --save-only --unstable-presymbolicate -o "$2.json" -- "$3" "$4" 2>"$2.stderr" &
  sp=$!
  sleep "$5"
  app="$(pgrep -P "$sp" || true)"
  [[ -n "$app" ]] && kill "$app"
  wait "$sp" || true
' _ "$data" "$out" "$bin" "$file" "$secs"
python3 "$here/hot.py" "$out.json" | head -60
