#!/bin/sh
# Rebuilds tests/fixtures/electron-userdata from fresh, made-up data.
# Needs the repo's node_modules (with Electron) next to the repo root, or
# MARKIE_FIXTURE_ELECTRON naming the Electron binary of the version Markie
# ships (package-lock.json), for example one unpacked from Electron's own
# download cache after checking its SHA-256 against
# node_modules/electron/checksums.json.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../../.." && pwd)
electron="${MARKIE_FIXTURE_ELECTRON:-$repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron}"
"$electron" --version
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
node --import "$repo/rust/scripts/ts-run/register.mjs" "$here/gen.ts" "$scratch/data.json"
"$electron" "$here/electron-main.cjs" "$scratch/data.json" "$scratch/userData" 1
"$electron" "$here/electron-main.cjs" "$scratch/data.json" "$scratch/userData" 2
out="$here/../../tests/fixtures"
rm -rf "$out/electron-userdata"
mkdir -p "$out/electron-userdata"
# Only the two storage folders the migration reads, without lock files.
cp -R "$scratch/userData/Local Storage" "$scratch/userData/IndexedDB" "$out/electron-userdata/"
find "$out/electron-userdata" \( -name LOCK -o -name LOG -o -name LOG.old \) -delete
cp "$scratch/data.json" "$out/fixture-data.json"
echo "fixture written to $out"
