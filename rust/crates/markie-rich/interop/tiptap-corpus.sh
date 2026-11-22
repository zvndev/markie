#!/usr/bin/env bash
# The TipTap round-trip corpus against Markie RS, byte for byte.
#
#   MARKIE_CORPUS_DIR=<folder> rust/crates/markie-rich/interop/tiptap-corpus.sh
#
# MARKIE_CORPUS_MAX caps the files (default 5000). MARKIE_TIPTAP_BATCH sets
# how many files each Node process takes (default 400; TipTap leaks in jsdom).
# Needs the repo's node_modules (a worktree can symlink the main checkout's).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
export MARKIE_TIPTAP_DIR="${MARKIE_TIPTAP_DIR:-$repo/rust/target/tiptap-corpus}"
batch="${MARKIE_TIPTAP_BATCH:-400}"
rm -rf "$MARKIE_TIPTAP_DIR"
mkdir -p "$MARKIE_TIPTAP_DIR"

echo "== 1. Markie RS writes its outputs"
(cd "$repo/rust" && MARKIE_TIPTAP_PHASE=export cargo test -q --release -p markie-rich --test tiptap_corpus -- --nocapture)

total=$(wc -l < "$MARKIE_TIPTAP_DIR/rs.jsonl" | tr -d ' ')
echo "== 2. Electron's pipeline on the same $total files"
skip=0
while [ "$skip" -lt "$total" ]; do
  (cd "$repo" && MARKIE_TIPTAP_SKIP=$skip MARKIE_TIPTAP_TAKE=$batch NODE_OPTIONS="--max-old-space-size=8192" \
    npx vitest run --config rust/crates/markie-rich/interop/vitest.config.mts rust/crates/markie-rich/interop/tiptap-corpus.test.ts >/dev/null)
  skip=$((skip + batch))
  echo "   $(wc -l < "$MARKIE_TIPTAP_DIR/electron.jsonl" | tr -d ' ') of $total"
done

echo "== 3. Compare"
(cd "$repo/rust" && MARKIE_TIPTAP_PHASE=compare cargo test -q --release -p markie-rich --test tiptap_corpus -- --nocapture)
echo "Report: $MARKIE_TIPTAP_DIR/compare.json"
