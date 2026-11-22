#!/usr/bin/env bash
# Build "Markie RS.app" for local testing on this Mac.
#
# This is deliberately NOT part of the Markie release pipeline:
#   - its own name and bundle id (com.zvn.markie.rs), so macOS never confuses
#     it with Markie and `open -a Markie` still opens the Electron app;
#   - no updater, no feed, no upload step, no signing identity;
#   - it claims no file types and no markie:// scheme, so it cannot take over
#     what double-clicking a .md file does.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release -p markie-app

APP="target/release/Markie RS.app"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/markie-rs "$APP/Contents/MacOS/markie-rs"
cp -R ../mcp "$APP/Contents/Resources/mcp"
cp crates/markie-agent/mcp/markie-rs-mcp.mjs "$APP/Contents/Resources/markie-rs-mcp.mjs"
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
  <key>CFBundleName</key><string>Markie RS</string>
  <key>CFBundleDisplayName</key><string>Markie RS</string>
  <key>CFBundleIdentifier</key><string>com.zvn.markie.rs</string>
  <key>CFBundleExecutable</key><string>markie-rs</string>
  <key>CFBundleIconFile</key><string>markie-rs</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
# Ad-hoc signature only, so Gatekeeper lets it run on this Mac.
codesign --force --sign - "$APP" >/dev/null
du -sh "$APP"
echo "Built $(pwd)/$APP"
