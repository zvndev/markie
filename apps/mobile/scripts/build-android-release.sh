#!/bin/sh
# Builds a signed Play bundle (.aab) for upload. The upload keystore stays in
# ~/.markie-mobile-keys and its password in the macOS Keychain; neither is ever
# printed or committed. Run from apps/mobile.
set -eu
STORE="$HOME/.markie-mobile-keys/markie-upload.jks"
[ -f "$STORE" ] || { echo "No upload keystore at $STORE" >&2; exit 1; }
PASSWORD=$(security find-generic-password -a markie-upload -s markie-android-upload-keystore -w)
npm run sync
cd android
MARKIE_UPLOAD_STORE_FILE="$STORE" MARKIE_UPLOAD_STORE_PASSWORD="$PASSWORD" \
  ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" JAVA_HOME="${MARKIE_JAVA_HOME:-/opt/homebrew/opt/openjdk@21}" ./gradlew bundleRelease
echo "Built: $(pwd)/app/build/outputs/bundle/release/app-release.aab"
