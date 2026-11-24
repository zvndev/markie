#!/usr/bin/env bash
# Build "Markie RS.app" for local testing on this Mac.
#
# This is deliberately NOT part of the Markie release pipeline:
#   - its own name and bundle id (com.zvn.markie.rs), so macOS never confuses
#     it with Markie and `open -a Markie` still opens the Electron app;
#   - no updater, no feed, no upload step, no signing identity;
#   - it claims no file types and no markie:// scheme, so it cannot take over
#     what double-clicking a .md file does or the links Markie answers;
#   - the one URL scheme it registers is its own, markie-rs://, for shared
#     links and the Google or Apple sign-in hand-back (app=markie-rs).
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
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.zvn.markie.rs</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>CFBundleURLSchemes</key><array><string>markie-rs</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
# Never markie://: that scheme belongs to the Electron app.
if /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$APP/Contents/Info.plist" | grep -Eq '^ *markie$'; then
  echo "Info.plist claims markie://, which belongs to Markie" >&2; exit 1
fi
# Ad-hoc signature only, so Gatekeeper lets it run on this Mac.
codesign --force --sign - "$APP" >/dev/null
du -sh "$APP"
echo "Built $(pwd)/$APP"
