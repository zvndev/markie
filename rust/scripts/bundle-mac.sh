#!/usr/bin/env bash
# Build "Markie RS.app" for local testing on this Mac, or, with
# MARKIE_VARIANT=nightly or public, the bundle of the Mac app itself, "Markie.app".
#
# Markie RS (the default) is deliberately NOT part of any release pipeline:
#   - its own name and bundle id (com.zvn.markie.rs), so macOS never confuses
#     it with Markie and `open -a Markie` still opens Markie;
#   - no updater, no feed, no upload step, no signing identity;
#   - it claims no file types and no markie:// scheme, so it cannot take over
#     what double-clicking a .md file does or the links Markie answers;
#   - the one URL scheme it registers is its own, markie-rs://, for shared
#     links and the Google or Apple sign-in hand-back (app=markie-rs).
#
# Markie (MARKIE_VARIANT=nightly, MARKIE_NIGHTLY_VERSION=X.Y.Z-super-nightly.N)
# is the Mac app on the super-nightly channel. It carries Markie's identity,
# com.zvn.markie, markie:// and Markie's document types, because the installed
# Electron super-nightly updates itself into it. Its data folder is its own.
# This script only builds the bundle, ad-hoc signed, into a folder of its
# own; it never touches /Applications. Signing with the Developer ID,
# notarizing and zipping are scripts/nightly-release.sh;
# docs/rust-port/NIGHTLY.md is the runbook.
#
# Markie (MARKIE_VARIANT=public, MARKIE_PUBLIC_VERSION=X.Y.Z or X.Y.Z-rc.N)
# is the public Mac app for Apple silicon: the same identity as the nightly,
# its own data folder ("Markie App"), and Electron Markie's MCP server laid out
# so the path agents already use keeps working (scripts/stage-mcp.sh). Signing,
# notarizing, the ZIP and the DMG are scripts/public-release.sh;
# docs/rust-port/PUBLIC.md is the runbook.
#
# CARGO_TARGET_DIR is honoured: the binary is taken from its release folder.
set -euo pipefail
cd "$(dirname "$0")/.."

CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
VARIANT="${MARKIE_VARIANT:-rs}"
case "$VARIANT" in
  rs)
    NAME="Markie RS"; BUNDLE_ID="com.zvn.markie.rs"; SCHEME="markie-rs"
    VERSION="$CARGO_VERSION"
    FEATURES=()
    APP="target/release/$NAME.app"
    ;;
  nightly)
    NAME="Markie"; BUNDLE_ID="com.zvn.markie"; SCHEME="markie"
    VERSION="${MARKIE_NIGHTLY_VERSION:-}"
    if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-super-nightly\.(0|[1-9][0-9]*)$ ]]; then
      echo "MARKIE_NIGHTLY_VERSION must be X.Y.Z-super-nightly.N" >&2; exit 1
    fi
    if [[ "${VERSION%%-super-nightly.*}" != "$CARGO_VERSION" ]]; then
      echo "MARKIE_NIGHTLY_VERSION must start with the workspace version $CARGO_VERSION" >&2; exit 1
    fi
    FEATURES=(--features nightly)
    # The binary carries its own version and commit (markie-core paths.rs).
    export MARKIE_NIGHTLY_VERSION="$VERSION"
    export MARKIE_NIGHTLY_COMMIT="${MARKIE_NIGHTLY_COMMIT:-$(git rev-parse HEAD)}"
    APP="${MARKIE_BUNDLE_DIR:-target/nightly/$VERSION}/$NAME.app"
    ;;
  public)
    NAME="Markie"; BUNDLE_ID="com.zvn.markie"; SCHEME="markie"
    VERSION="${MARKIE_PUBLIC_VERSION:-}"
    if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(rc|beta)\.(0|[1-9][0-9]*))?$ ]]; then
      echo "MARKIE_PUBLIC_VERSION must be X.Y.Z, X.Y.Z-rc.N or X.Y.Z-beta.N" >&2; exit 1
    fi
    if [[ "${VERSION%%-*}" != "$CARGO_VERSION" ]]; then
      echo "MARKIE_PUBLIC_VERSION must start with the workspace version $CARGO_VERSION" >&2; exit 1
    fi
    FEATURES=(--features public)
    export MARKIE_PUBLIC_VERSION="$VERSION"
    export MARKIE_PUBLIC_COMMIT="${MARKIE_PUBLIC_COMMIT:-$(git rev-parse HEAD)}"
    APP="${MARKIE_BUNDLE_DIR:-target/public/$VERSION}/$NAME.app"
    ;;
  *)
    echo "MARKIE_VARIANT must be rs, nightly or public" >&2; exit 1
    ;;
esac

# Google Docs import (crates/markie-google config.rs) is compiled in only
# when the Desktop OAuth client is in the environment; without it the
# feature is hidden. The values are never printed.
export MARKIE_GOOGLE_DESKTOP_CLIENT_ID="${MARKIE_GOOGLE_DESKTOP_CLIENT_ID:-}"
export MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET="${MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET:-}"
if [[ -n "$MARKIE_GOOGLE_DESKTOP_CLIENT_ID" ]]; then echo "Google Docs import: on"; else echo "Google Docs import: off (no MARKIE_GOOGLE_DESKTOP_CLIENT_ID)"; fi

cargo build --release -p markie-app ${FEATURES[@]+"${FEATURES[@]}"}

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "${CARGO_TARGET_DIR:-target}/release/markie-rs" "$APP/Contents/MacOS/markie-rs"
if [[ "$VARIANT" == public ]]; then
  # Contents/Resources/mcp/markie-mcp.mjs, the path in people's agent
  # settings, hands over to the adapter; Electron's server, from a pinned
  # commit, sits in mcp-server/; app-identity.json names "Markie App".
  scripts/stage-mcp.sh "$APP/Contents/Resources"
else
  cp -R ../mcp "$APP/Contents/Resources/mcp"
  cp crates/markie-agent/mcp/markie-rs-mcp.mjs "$APP/Contents/Resources/markie-rs-mcp.mjs"
fi
if [[ "$VARIANT" == nightly ]]; then
  # Tells the MCP adapter beside it which app it is and where its data lives
  # (PROFILE_NAME in crates/markie-core/src/paths.rs).
  printf '{"appName":"%s","profileName":"Markie Nightly"}\n' "$NAME" > "$APP/Contents/Resources/app-identity.json"
fi
# The bundled fonts are inside the binary; each family's own license text
# ships beside it, readable without running the app.
mkdir -p "$APP/Contents/Resources/font-licenses"
for dir in ../src/assets/fonts/*/; do
  cp "$dir/LICENSE.txt" "$APP/Contents/Resources/font-licenses/$(basename "$dir").txt"
done
if [[ "$VARIANT" == nightly || "$VARIANT" == public ]]; then
  # Markie's own icon, under the name its document types refer to.
  cp ../build/icon.icns "$APP/Contents/Resources/icon.icns"
else
  ICON_SRC="../build/icons/512x512.png"
  if [[ -f "$ICON_SRC" ]]; then
    ICONSET="$(mktemp -d)/markie-rs.iconset"
    mkdir -p "$ICONSET"
    for size in 16 32 128 256 512; do
      sips -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    done
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/markie-rs.icns"
  fi
fi
# One generator for every variant. The Mac app's document types come from
# electron-builder.config.cjs, the file Electron Markie's own plist is made from.
node scripts/mac-info-plist.mjs "$VARIANT" "$VERSION" > "$APP/Contents/Info.plist"
/usr/bin/plutil -lint "$APP/Contents/Info.plist" >/dev/null
# Each variant claims exactly one URL scheme, its own: the dev build never
# markie://, the Mac app never markie-rs://.
SCHEMES="$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$APP/Contents/Info.plist" | { grep -E '^ *markie' || true; } | tr -d ' ' | sort | tr '\n' ' ')"
if [[ "$SCHEMES" != "$SCHEME " ]]; then
  echo "Info.plist claims '$SCHEMES', expected only $SCHEME" >&2; exit 1
fi
# The binary must agree with the bundle about what it is. No window opens.
REPORTED="$("$APP/Contents/MacOS/markie-rs" --version)"
case "$REPORTED" in
  "$NAME $VERSION ($BUNDLE_ID)"*) ;;
  *) echo "The binary reports '$REPORTED', the bundle is $NAME $VERSION ($BUNDLE_ID)" >&2; exit 1 ;;
esac
# Ad-hoc signature only, so Gatekeeper lets it run on this Mac.
codesign --force --sign - "$APP" >/dev/null
du -sh "$APP"
echo "Built $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
