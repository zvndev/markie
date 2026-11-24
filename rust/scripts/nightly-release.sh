#!/usr/bin/env bash
# Markie Nightly: build, sign, notarize, verify and zip one version.
# Mac arm64 only. Runbook: docs/rust-port/NIGHTLY.md.
#
#   MARKIE_NIGHTLY_VERSION=0.1.0-rs-nightly.1 rust/scripts/nightly-release.sh <step> [--dry-run]
#
# Steps, in order (`all` runs them all):
#   build     cargo build + bundle "Markie Nightly.app" (scripts/bundle-mac.sh)
#   sign      Developer ID, hardened runtime, secure timestamp
#   notarize  notarytool submit --wait, then staple the ticket to the app
#   verify    signature, exact team, bundle identity, Gatekeeper, the staple
#   zip       ditto ZIP of the verified app, checked again after unpacking
#
# It never uploads anything: publishing is scripts/nightly-publish.mjs.
#
# Credentials come from the environment and nowhere else:
#   sign      the "Developer ID Application" certificate in the login Keychain
#   notarize  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#             (or MARKIE_NOTARY_PROFILE, a `notarytool store-credentials` name)
#
# --dry-run builds for real, prints the sign and notarize commands instead of
# running them, and checks everything that needs no credential. Its output
# goes to a "-dry-run" folder and is never publishable: the publisher runs its
# own signature and notarization checks.
set -euo pipefail

IDENTITY="Developer ID Application: Kirby Campbell (3VU8SG5TD9)"
TEAM_ID="3VU8SG5TD9"
BUNDLE_ID="com.zvn.markie.nightly"
APP_NAME="Markie Nightly"
SCHEME="markie-nightly"
# The same requirement the updater checks before it swaps a download in
# (crates/markie-update/src/bundle.rs): this bundle id, Apple's Developer ID
# chain, this team.
REQUIREMENT="identifier \"$BUNDLE_ID\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$TEAM_ID\""

RUST_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$RUST_DIR"

die() { echo "nightly-release: $*" >&2; exit 1; }
say() { echo "nightly-release: $*"; }

STEP=""; DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    build|sign|notarize|verify|zip|all) [[ -z "$STEP" ]] || die "one step at a time"; STEP="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    *) die "unknown argument: $arg (steps: build sign notarize verify zip all; option: --dry-run)" ;;
  esac
done
[[ -n "$STEP" ]] || die "usage: MARKIE_NIGHTLY_VERSION=X.Y.Z-rs-nightly.N $0 <build|sign|notarize|verify|zip|all> [--dry-run]"

VERSION="${MARKIE_NIGHTLY_VERSION:-}"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rs-nightly\.(0|[1-9][0-9]*)$ ]] || die "MARKIE_NIGHTLY_VERSION must be X.Y.Z-rs-nightly.N"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || die "Markie Nightly is built on an Apple silicon Mac only"

if (( DRY_RUN )); then OUT="$RUST_DIR/target/nightly/$VERSION-dry-run"; else OUT="$RUST_DIR/target/nightly/$VERSION"; fi
APP="$OUT/$APP_NAME.app"
ZIP="$OUT/Markie-Nightly-$VERSION-arm64.zip"
COMMIT="$(git rev-parse HEAD)"

# Prints a command, quoted so it can be pasted. Secrets are never passed to it.
show() { printf '  '; printf '%q ' "$@"; printf '\n'; }

build() {
  # A published nightly names one exact commit. A dry run may build a dirty tree.
  if (( ! DRY_RUN )) && [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
    die "the working tree has uncommitted changes; a nightly is built from one exact commit"
  fi
  if [[ -e "$OUT" ]] && [[ -n "$(ls -A "$OUT")" ]]; then
    (( DRY_RUN )) || die "$OUT is not empty; a version is built once (choose the next N)"
    rm -rf "$OUT"
  fi
  mkdir -p "$OUT"
  MARKIE_VARIANT=nightly MARKIE_NIGHTLY_VERSION="$VERSION" MARKIE_NIGHTLY_COMMIT="$COMMIT" MARKIE_BUNDLE_DIR="$OUT" "$RUST_DIR/scripts/bundle-mac.sh"
}

need_app() { [[ -d "$APP" ]] || die "no bundle at $APP; run the build step first"; }

sign() {
  need_app
  # codesign refuses resource forks and Finder information; none belong in the bundle.
  local cmd=(/usr/bin/codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP")
  if (( DRY_RUN )); then
    say "DRY RUN, not signing. The real step runs:"
    show /usr/bin/xattr -cr "$APP"
    show "${cmd[@]}"
    return
  fi
  /usr/bin/xattr -cr "$APP"
  "${cmd[@]}"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
  say "signed with $IDENTITY"
}

notarize() {
  need_app
  local upload="$OUT/.notarize-upload.zip"
  if (( DRY_RUN )); then
    say "DRY RUN, not notarizing. The real step runs:"
    show /usr/bin/ditto -c -k --keepParent "$APP" "$upload"
    if [[ -n "${MARKIE_NOTARY_PROFILE:-}" ]]; then
      show /usr/bin/xcrun notarytool submit "$upload" --keychain-profile "$MARKIE_NOTARY_PROFILE" --wait
    else
      show /usr/bin/xcrun notarytool submit "$upload" --apple-id '$APPLE_ID' --team-id "$TEAM_ID" --password '$APPLE_APP_SPECIFIC_PASSWORD' --wait
    fi
    show /usr/bin/xcrun stapler staple "$APP"
    return
  fi
  local credentials
  if [[ -n "${MARKIE_NOTARY_PROFILE:-}" ]]; then
    credentials=(--keychain-profile "$MARKIE_NOTARY_PROFILE")
  else
    [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] || die "set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (or MARKIE_NOTARY_PROFILE)"
    [[ "$APPLE_TEAM_ID" == "$TEAM_ID" ]] || die "APPLE_TEAM_ID is not the reviewed team $TEAM_ID"
    credentials=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")
  fi
  rm -f "$upload"
  /usr/bin/ditto -c -k --keepParent "$APP" "$upload"
  local log="$OUT/.notarize.json" status
  # Never echoed: the argument list holds the app-specific password.
  /usr/bin/xcrun notarytool submit "$upload" "${credentials[@]}" --wait --output-format json > "$log" || { rm -f "$upload"; die "notarytool failed; its answer is in $log"; }
  rm -f "$upload"
  status="$(/usr/bin/plutil -extract status raw -o - "$log" 2>/dev/null || true)"
  [[ "$status" == Accepted ]] || die "Apple did not accept the build (status: ${status:-unknown}); see $log and \`xcrun notarytool log\`"
  /usr/bin/xcrun stapler staple "$APP"
  say "notarized and stapled"
}

plist() { /usr/bin/plutil -extract "$1" raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true; }

# What needs no credential: the bundle is the app it claims to be.
verify_shape() {
  need_app
  [[ "$(plist CFBundleIdentifier)" == "$BUNDLE_ID" ]] || die "bundle id is '$(plist CFBundleIdentifier)', not $BUNDLE_ID"
  [[ "$(plist CFBundleName)" == "$APP_NAME" ]] || die "bundle name is '$(plist CFBundleName)', not $APP_NAME"
  [[ "$(plist CFBundleShortVersionString)" == "$VERSION" && "$(plist CFBundleVersion)" == "$VERSION" ]] || die "bundle version is '$(plist CFBundleShortVersionString)', not $VERSION"
  # One URL scheme, its own. Never markie:// (Electron Markie) or markie-rs:// (the dev build).
  [[ "$(plist CFBundleURLTypes.0.CFBundleURLSchemes.0)" == "$SCHEME" ]] || die "the bundle does not claim $SCHEME://"
  [[ -z "$(plist CFBundleURLTypes.0.CFBundleURLSchemes.1)" && -z "$(plist CFBundleURLTypes.1)" ]] || die "the bundle claims more than one URL scheme"
  # No file types: a double-click in Finder keeps opening Markie.
  local key
  for key in CFBundleDocumentTypes UTExportedTypeDeclarations UTImportedTypeDeclarations; do
    /usr/bin/plutil -extract "$key" raw -o - "$APP/Contents/Info.plist" >/dev/null 2>&1 && die "the bundle declares $key; Markie Nightly claims no file types"
  done
  [[ "$(/usr/bin/lipo -archs "$APP/Contents/MacOS/markie-rs")" == arm64 ]] || die "the binary is not arm64 only"
  local reported expected="$APP_NAME $VERSION ($BUNDLE_ID) $COMMIT"
  reported="$("$APP/Contents/MacOS/markie-rs" --version)"
  [[ "$reported" == "$expected" ]] || die "the binary reports '$reported', expected '$expected' (rebuild from this commit)"
  [[ "$(cat "$APP/Contents/Resources/app-identity.json")" == "{\"appName\":\"$APP_NAME\"}" ]] || die "app-identity.json does not name $APP_NAME"
  [[ -z "$(find "$APP" -type l)" ]] || die "the bundle holds a symlink"
  say "shape ok: $expected"
}

# What a real release must pass: the checks the updater makes, plus the staple.
verify_signature() {
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$1" || die "the code signature is not valid"
  /usr/bin/codesign --verify --deep --strict -R="$REQUIREMENT" "$1" || die "not signed as $BUNDLE_ID by Developer ID team $TEAM_ID"
  local display
  display="$(/usr/bin/codesign --display --verbose=4 "$1" 2>&1)"
  [[ "$(sed -n 's/^Identifier=//p' <<<"$display" | head -1)" == "$BUNDLE_ID" ]] || die "signed identifier is not $BUNDLE_ID"
  [[ "$(sed -n 's/^TeamIdentifier=//p' <<<"$display" | head -1)" == "$TEAM_ID" ]] || die "TeamIdentifier is not exactly $TEAM_ID"
  [[ "$(sed -n 's/^Authority=//p' <<<"$display" | head -1)" == "$IDENTITY" ]] || die "the signing certificate is not '$IDENTITY'"
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\(([a-z-]+,)*runtime(,[a-z-]+)*\)' <<<"$display" || die "the hardened runtime is not on"
  grep -q '^Timestamp=' <<<"$display" || die "the signature has no secure timestamp"
  /usr/sbin/spctl --assess --type execute --verbose=2 "$1" || die "Gatekeeper does not accept the app"
  /usr/bin/xcrun stapler validate "$1" || die "the notarization ticket is not stapled"
}

verify() {
  verify_shape
  if (( DRY_RUN )); then
    say "DRY RUN, signature checks skipped. The real step requires all of:"
    show /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
    show /usr/bin/codesign --verify --deep --strict -R="$REQUIREMENT" "$APP"
    show /usr/bin/codesign --display --verbose=4 "$APP"
    show /usr/sbin/spctl --assess --type execute --verbose=2 "$APP"
    show /usr/bin/xcrun stapler validate "$APP"
    return
  fi
  verify_signature "$APP"
  say "verified: signed by $TEAM_ID, notarized, stapled"
}

zip() {
  verify
  rm -f "$ZIP"
  /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
  # Every entry is inside the bundle: the updater refuses a ZIP with anything else.
  local stray
  stray="$(/usr/bin/zipinfo -1 "$ZIP" | grep -v "^$APP_NAME\.app/" || true)"
  [[ -z "$stray" ]] || die "the ZIP holds entries outside $APP_NAME.app: $stray"
  # Plain ASCII names only, as the updater requires (crates/markie-update/src/archive.rs).
  if /usr/bin/zipinfo -1 "$ZIP" | LC_ALL=C grep -q '[^ -~]'; then die "the ZIP holds a file name that is not plain ASCII"; fi
  # What the updater will unpack must still be the verified app.
  local check
  check="$(mktemp -d "${TMPDIR:-/tmp}/markie-nightly-zip-check.XXXXXX")"
  /usr/bin/ditto -x -k "$ZIP" "$check"
  if (( DRY_RUN )); then
    /usr/bin/diff -r "$APP" "$check/$APP_NAME.app" >/dev/null || { rm -rf "$check"; die "the ZIP does not unpack to the same bundle"; }
    /usr/bin/codesign --verify --deep --strict "$check/$APP_NAME.app" || { rm -rf "$check"; die "the unpacked bundle's (ad-hoc) signature is broken"; }
  else
    (verify_signature "$check/$APP_NAME.app") || { rm -rf "$check"; die "the unpacked bundle does not pass verification"; }
  fi
  rm -rf "$check"
  local size
  size="$(/usr/bin/stat -f %z "$ZIP")"
  (( size > 0 && size <= 512 * 1024 * 1024 )) || die "the ZIP is $size bytes; the gateway takes at most 512 MiB"
  say "$ZIP"
  say "size $size, sha512 $(/usr/bin/openssl dgst -sha512 -binary "$ZIP" | /usr/bin/base64)"
  if (( DRY_RUN )); then say "DRY RUN: this ZIP is ad-hoc signed and not notarized. It cannot be published or installed as an update."; fi
}

case "$STEP" in
  build) build ;;
  sign) sign ;;
  notarize) notarize ;;
  verify) verify ;;
  zip) zip ;;
  all) build; sign; notarize; zip ;;
esac
