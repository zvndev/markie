#!/usr/bin/env bash
# Put Markie's MCP server into the public Mac app's Resources folder, so the
# path agents were set up with for Electron Markie keeps working:
#
#   node /Applications/Markie.app/Contents/Resources/mcp/markie-mcp.mjs
#
#   rust/scripts/stage-mcp.sh <Resources dir> [<commit>]
#
# Lays out:
#   mcp/markie-mcp.mjs     the path agents run: hands over to the adapter
#   markie-rs-mcp.mjs      the adapter (crates/markie-agent/mcp): Electron's
#                          server, pointed at this app's bridge, never Electron's
#   mcp-server/            Electron Markie's own MCP server, the files
#                          electron-builder.config.cjs ships, from one pinned
#                          commit of zvndev/markie (scripts/mcp/PIN)
#   app-identity.json      which app and data folder the adapter talks to
#
# The commit must be in this clone (`git fetch origin main` brings it). Nothing
# is downloaded. Used by bundle-mac.sh for MARKIE_VARIANT=public, and by the
# MCP end-to-end test (crates/markie-agent/tests/public_mcp.rs).
set -euo pipefail
RUST_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
RES="${1:?usage: stage-mcp.sh <Resources dir> [<commit>]}"
COMMIT="${2:-$(tr -d '[:space:]' < "$RUST_DIR/scripts/mcp/PIN")}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "stage-mcp: the pin must be a full commit id" >&2; exit 1; }
git -C "$RUST_DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null || { echo "stage-mcp: commit $COMMIT is not in this clone; run git fetch origin main" >&2; exit 1; }

# The runtime modules Electron ships in Resources/mcp, named one by one in
# electron-builder.config.cjs's extraResources filter, read at the same commit.
FILES=()
while IFS= read -r name; do FILES+=("$name"); done < <(
  git -C "$RUST_DIR" show "$COMMIT:electron-builder.config.cjs" |
    awk '/from: "mcp",/{inside=1} inside && /filter: \[/{list=1; next} list && /\]/{exit} list' |
    sed -n 's/^ *"\([A-Za-z0-9._-]*\)",\{0,1\} *$/\1/p'
)
(( ${#FILES[@]} >= 10 )) || { echo "stage-mcp: could not read the MCP file list at $COMMIT" >&2; exit 1; }
printf '%s\n' "${FILES[@]}" | grep -qx markie-mcp.mjs || { echo "stage-mcp: markie-mcp.mjs is not in the list" >&2; exit 1; }

rm -rf "$RES/mcp" "$RES/mcp-server"
mkdir -p "$RES/mcp" "$RES/mcp-server"
for name in "${FILES[@]}"; do
  git -C "$RUST_DIR" show "$COMMIT:mcp/$name" > "$RES/mcp-server/$name"
done
cp "$RUST_DIR/scripts/mcp/markie-mcp.mjs" "$RES/mcp/markie-mcp.mjs"
cp "$RUST_DIR/crates/markie-agent/mcp/markie-rs-mcp.mjs" "$RES/markie-rs-mcp.mjs"
# PROFILE_NAME of the public build in crates/markie-core/src/paths.rs.
printf '{"appName":"Markie","profileName":"Markie App"}\n' > "$RES/app-identity.json"
printf '%s\n' "$COMMIT" > "$RES/mcp-server/COMMIT"
echo "stage-mcp: ${#FILES[@]} files from zvndev/markie $COMMIT"
