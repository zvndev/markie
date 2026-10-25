#!/usr/bin/env bash
# Builds the app, installs it on an iOS Simulator and an Android emulator, and
# screenshots every screen in light and dark against dev/mock-server.mjs.
#
# Needs: Maestro, Xcode, the Android SDK, JDK 21 (Capacitor 8's Android build needs it), a booted simulator and a
# running emulator, and the mock server on port 8790 (npm run mock).
#   IOS_DEVICE=<simulator udid> ANDROID_DEVICE=emulator-5554 e2e/screenshots.sh
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
OUT="$APP_DIR/screenshots"
IOS_DEVICE=${IOS_DEVICE:?set IOS_DEVICE to a booted simulator udid}
ANDROID_DEVICE=${ANDROID_DEVICE:-emulator-5554}
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
DERIVED=${DERIVED:-/tmp/markie-mobile-dd}

mkdir -p "$OUT"
npm run build:dev
npx cap sync

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$IOS_DEVICE" -derivedDataPath "$DERIVED" build -quiet
xcrun simctl install "$IOS_DEVICE" "$DERIVED/Build/Products/Debug-iphonesimulator/App.app"

(cd android && ./gradlew assembleDebug -q)
"$ADB" -s "$ANDROID_DEVICE" install -r android/app/build/outputs/apk/debug/app-debug.apk
# Start signed out. The emulator reaches the mock server as 10.0.2.2.
"$ADB" -s "$ANDROID_DEVICE" shell pm clear com.zvn.markie.mobile

shoot() { # platform device tone
  local platform=$1 device=$2 tone=$3
  if [ "$platform" = ios ]; then
    xcrun simctl ui "$device" appearance "$tone"
  else
    "$ADB" -s "$device" shell cmd uimode night "$([ "$tone" = dark ] && echo yes || echo no)"
  fi
  # Signed out at the end of the previous pass, or on first run: sign in.
  maestro --device "$device" test "e2e/sign-in-$platform.yaml" || { sleep 3; maestro --device "$device" test "e2e/sign-in-$platform.yaml" || true; }
  maestro --device "$device" test -e OUT="$OUT" -e NAME="$platform-$tone" e2e/screens.yaml
  maestro --device "$device" test -e OUT="$OUT" -e NAME="$platform-$tone" e2e/links.yaml
  maestro --device "$device" test -e OUT="$OUT" -e NAME="$platform-$tone" e2e/settings.yaml
}

for tone in light dark; do
  shoot ios "$IOS_DEVICE" "$tone"
  shoot android "$ANDROID_DEVICE" "$tone"
done
ls "$OUT"
