#!/usr/bin/env bash
# Markie RS <-> TipTap Yjs interop, both directions.
#
#   rust/crates/markie-rich/interop/run.sh            # the cases in cases.json
#   MARKIE_INTEROP_CORPUS=~/Documents run.sh           # plus real files
#
# Needs the repo's node_modules (a worktree can symlink the main checkout's).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
export MARKIE_INTEROP_DIR="${MARKIE_INTEROP_DIR:-$repo/rust/target/interop}"
rm -rf "$MARKIE_INTEROP_DIR"
mkdir -p "$MARKIE_INTEROP_DIR"

echo "== 1. Rust writes rooms (yrs)"
(cd "$repo/rust" && MARKIE_INTEROP_PHASE=export cargo test -q -p markie-rich --test interop -- --nocapture)

echo "== 2. Node reads them with yjs + y-tiptap + the TipTap schema, writes its own"
(cd "$repo" && NODE_OPTIONS="--max-old-space-size=8192" npx vitest run --config rust/crates/markie-rich/interop/vitest.config.mts)

echo "== 3. Rust reads TipTap's rooms and a real editor's edit"
(cd "$repo/rust" && MARKIE_INTEROP_PHASE=import cargo test -q -p markie-rich --test interop -- --nocapture)

echo "Reports: $MARKIE_INTEROP_DIR/node/report.json, $MARKIE_INTEROP_DIR/rust/import-report.json"
