#!/usr/bin/env bash
# Build "Markie RS.app" for local testing on this Mac, or, with
# MARKIE_VARIANT=nightly, the bundle of the private "Markie Nightly" build.
#
# Markie RS (the default) is deliberately NOT part of any release pipeline:
#   - its own name and bundle id (com.zvn.markie.rs), so macOS never confuses
#     it with Markie and `open -a Markie` still opens the Electron app;
#   - no updater, no feed, no upload step, no signing identity;
#   - it claims no file types and no markie:// scheme, so it cannot take over
#     what double-clicking a .md file does or the links Markie answers;
#   - the one URL scheme it registers is its own, markie-rs://, for shared
#     links and the Google or Apple sign-in hand-back (app=markie-rs).
#
# Markie Nightly (MARKIE_VARIANT=nightly, MARKIE_NIGHTLY_VERSION=X.Y.Z-rs-nightly.N)
# is a third app beside those two: "Markie Nightly", com.zvn.markie.nightly,
# its own data folder, Keychain service and markie-nightly:// scheme, still no
# file types. This script only builds its bundle, ad-hoc signed. Signing with
# the Developer ID, notarizing and zipping are scripts/nightly-release.sh;
# docs/rust-port/NIGHTLY.md is the runbook.
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
    NAME="Markie Nightly"; BUNDLE_ID="com.zvn.markie.nightly"; SCHEME="markie-nightly"
    VERSION="${MARKIE_NIGHTLY_VERSION:-}"
    if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rs-nightly\.(0|[1-9][0-9]*)$ ]]; then
      echo "MARKIE_NIGHTLY_VERSION must be X.Y.Z-rs-nightly.N" >&2; exit 1
    fi
    if [[ "${VERSION%%-rs-nightly.*}" != "$CARGO_VERSION" ]]; then
      echo "MARKIE_NIGHTLY_VERSION must start with the workspace version $CARGO_VERSION" >&2; exit 1
    fi
    FEATURES=(--features nightly)
    # The binary carries its own version and commit (markie-core paths.rs).
    export MARKIE_NIGHTLY_VERSION="$VERSION"
    export MARKIE_NIGHTLY_COMMIT="${MARKIE_NIGHTLY_COMMIT:-$(git rev-parse HEAD)}"
    APP="${MARKIE_BUNDLE_DIR:-target/nightly/$VERSION}/$NAME.app"
    ;;
  *)
    echo "MARKIE_VARIANT must be rs or nightly" >&2; exit 1
    ;;
esac

cargo build --release -p markie-app ${FEATURES[@]+"${FEATURES[@]}"}

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/markie-rs "$APP/Contents/MacOS/markie-rs"
cp -R ../mcp "$APP/Contents/Resources/mcp"
cp crates/markie-agent/mcp/markie-rs-mcp.mjs "$APP/Contents/Resources/markie-rs-mcp.mjs"
if [[ "$VARIANT" == nightly ]]; then
  # Tells the MCP adapter beside it which app's data folder to talk to.
  printf '{"appName":"%s"}\n' "$NAME" > "$APP/Contents/Resources/app-identity.json"
fi
# The bundled fonts are inside the binary; each family's own license text
# ships beside it, readable without running the app.
mkdir -p "$APP/Contents/Resources/font-licenses"
for dir in ../src/assets/fonts/*/; do
  cp "$dir/LICENSE.txt" "$APP/Contents/Resources/font-licenses/$(basename "$dir").txt"
done
ICON_SRC="../build/icons/512x512.png"
if [[ -f "$ICON_SRC" ]]; then
  ICONSET="$(mktemp -d)/markie-rs.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/markie-rs.icns"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>markie-rs</string>
  <key>CFBundleIconFile</key><string>markie-rs</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>${BUNDLE_ID}</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>CFBundleURLSchemes</key><array><string>${SCHEME}</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
# Never markie://: that scheme belongs to the Electron app. And each variant
# claims only its own scheme, so the two Rust builds never answer for each other.
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
