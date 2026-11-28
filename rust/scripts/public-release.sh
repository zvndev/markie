#!/usr/bin/env bash
# Markie, the public Mac app for Apple silicon: build, sign, notarize, verify,
# ZIP and DMG one version. Runbook: docs/rust-port/PUBLIC.md.
#
#   rust/scripts/public-release.sh <version> [step] [--dry-run]
#
#   <version>  X.Y.Z, or X.Y.Z-rc.N for a release candidate; X.Y.Z must be the
#              workspace version in rust/Cargo.toml
#
# Steps, in order (no step, or `all`, runs them all):
#   build     cargo build --features public + bundle "Markie.app" (bundle-mac.sh)
#   sign      Developer ID, hardened runtime, secure timestamp
#   notarize  notarytool submit --wait, then staple the ticket to the app
#   verify    signature, exact team, bundle identity, Gatekeeper's notarized
#             source, the staple, the MCP layout, and the requirement an
#             installed Electron Markie checks before it installs this bundle
#   zip       Markie-<version>-arm64.zip, the file the updaters swap in,
#             checked again after unpacking
#   dmg       Markie-<version>-arm64.dmg for the download page: signed,
#             notarized and stapled itself, holding the verified app
#   manifest  release.json: {version, gitCommit, files: [{name, size, sha512}]},
#             sha512 in base64 as electron-builder writes it
#
# Everything lands in rust/target/public/<version>/. The Electron release
# tooling picks the ZIP, the DMG and release.json up from there, writes the
# feeds and uploads. This script never uploads anything and never touches
# /Applications.
#
# Credentials come from the environment and nowhere else, and are never printed:
#   sign      the "Developer ID Application" certificate in the login Keychain
#   notarize  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#             (or MARKIE_NOTARY_PROFILE, a `notarytool store-credentials` name)
#   build     MARKIE_GOOGLE_DESKTOP_CLIENT_ID (and _SECRET) to include Google
#             Docs import; without them it is hidden
#
# --dry-run builds for real, prints the sign and notarize commands instead of
# running them, and checks everything that needs no credential. Its output
# goes to a "-dry-run" folder and is never publishable.
set -euo pipefail

IDENTITY="Developer ID Application: Kirby Campbell (3VU8SG5TD9)"
TEAM_ID="3VU8SG5TD9"
BUNDLE_ID="com.zvn.markie"
APP_NAME="Markie"
SCHEME="markie"
PROFILE_NAME="Markie App"
# Electron Markie's designated requirement, as `codesign -d -r-` prints it for
# an installed copy. Squirrel.Mac, inside an installed Electron Markie,
# accepts an update only if the update's bundle satisfies this, and it is what
# this app's own updater checks before it swaps a download in
# (crates/markie-update/src/bundle.rs).
REQUIREMENT="identifier \"$BUNDLE_ID\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$TEAM_ID\""

RUST_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$RUST_DIR"

die() { echo "public-release: $*" >&2; exit 1; }
say() { echo "public-release: $*"; }

VERSION=""; STEP=""; DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    build|sign|notarize|verify|zip|dmg|manifest|all) [[ -z "$STEP" ]] || die "one step at a time"; STEP="$arg" ;;
    -*) die "unknown option: $arg" ;;
    *) [[ -z "$VERSION" ]] || die "one version at a time"; VERSION="$arg" ;;
  esac
done
STEP="${STEP:-all}"
[[ -n "$VERSION" ]] || die "usage: $0 <X.Y.Z|X.Y.Z-rc.N> [build|sign|notarize|verify|zip|dmg|manifest|all] [--dry-run]"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$ ]] || die "the version must be X.Y.Z or X.Y.Z-rc.N"
CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
[[ "${VERSION%%-*}" == "$CARGO_VERSION" ]] || die "the version must start with the workspace version $CARGO_VERSION"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || die "the Mac app is built on an Apple silicon Mac only"

if (( DRY_RUN )); then OUT="$RUST_DIR/target/public/$VERSION-dry-run"; else OUT="$RUST_DIR/target/public/$VERSION"; fi
APP="$OUT/$APP_NAME.app"
ZIP="$OUT/Markie-$VERSION-arm64.zip"
DMG="$OUT/Markie-$VERSION-arm64.dmg"
MANIFEST="$OUT/release.json"
COMMIT="$(git rev-parse HEAD)"

# Prints a command, quoted so it can be pasted. Secrets are never passed to it.
show() { printf '  '; printf '%q ' "$@"; printf '\n'; }

build() {
  # A release names one exact commit. A dry run may build a dirty tree. An
  # agent's AGENT_LOG.md at the root is never committed and never built.
  if (( ! DRY_RUN )) && [[ -n "$(git status --porcelain --untracked-files=all -- ':/' ':!/AGENT_LOG.md')" ]]; then
    die "the working tree has uncommitted changes; a release is built from one exact commit"
  fi
  if [[ -e "$OUT" ]] && [[ -n "$(ls -A "$OUT")" ]]; then
    (( DRY_RUN )) || die "$OUT is not empty; a version is built once (choose the next rc)"
    rm -rf "$OUT"
  fi
  mkdir -p "$OUT"
  MARKIE_GOOGLE_DESKTOP_CLIENT_ID="${MARKIE_GOOGLE_DESKTOP_CLIENT_ID:-}" MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET="${MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET:-}" \
    MARKIE_VARIANT=public MARKIE_PUBLIC_VERSION="$VERSION" MARKIE_PUBLIC_COMMIT="$COMMIT" MARKIE_BUNDLE_DIR="$OUT" "$RUST_DIR/scripts/bundle-mac.sh"
}

need_app() { [[ -d "$APP" ]] || die "no bundle at $APP; run the build step first"; }

sign() {
  need_app
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

# notary_submit <file>: submit, wait, require Accepted. The log keeps Apple's answer.
notary_submit() {
  local file="$1" log="$OUT/.notarize-$(basename "$1").json" status credentials
  if [[ -n "${MARKIE_NOTARY_PROFILE:-}" ]]; then
    credentials=(--keychain-profile "$MARKIE_NOTARY_PROFILE")
  else
    [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] || die "set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (or MARKIE_NOTARY_PROFILE)"
    [[ "$APPLE_TEAM_ID" == "$TEAM_ID" ]] || die "APPLE_TEAM_ID is not the reviewed team $TEAM_ID"
    credentials=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")
  fi
  # Never echoed: the argument list holds the app-specific password.
  /usr/bin/xcrun notarytool submit "$file" "${credentials[@]}" --wait --output-format json > "$log" || die "notarytool failed; its answer is in $log"
  status="$(/usr/bin/plutil -extract status raw -o - "$log" 2>/dev/null || true)"
  [[ "$status" == Accepted ]] || die "Apple did not accept $(basename "$file") (status: ${status:-unknown}); see $log and \`xcrun notarytool log\`"
  say "notarized: $(basename "$file") (submission $(/usr/bin/plutil -extract id raw -o - "$log" 2>/dev/null || echo unknown))"
}

notarize() {
  need_app
  local upload="$OUT/.notarize-upload.zip"
  if (( DRY_RUN )); then
    say "DRY RUN, not notarizing. The real step runs:"
    show /usr/bin/ditto -c -k --keepParent "$APP" "$upload"
    show /usr/bin/xcrun notarytool submit "$upload" --apple-id '$APPLE_ID' --team-id "$TEAM_ID" --password '$APPLE_APP_SPECIFIC_PASSWORD' --wait
    show /usr/bin/xcrun stapler staple "$APP"
    return
  fi
  rm -f "$upload"
  /usr/bin/ditto -c -k --keepParent "$APP" "$upload"
  notary_submit "$upload"
  rm -f "$upload"
  /usr/bin/xcrun stapler staple "$APP"
  say "app notarized and stapled"
}

plist() { /usr/bin/plutil -extract "$1" raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true; }
# A plist as sorted JSON, without the copyright line (it carries the build year).
as_json() { /usr/bin/plutil -convert json -o - "$1" | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); d.pop("NSHumanReadableCopyright", None); print(json.dumps(d, sort_keys=True))'; }

# What needs no credential: the bundle is the app it claims to be.
verify_shape() {
  need_app
  [[ "$(plist CFBundleIdentifier)" == "$BUNDLE_ID" ]] || die "bundle id is '$(plist CFBundleIdentifier)', not $BUNDLE_ID"
  [[ "$(plist CFBundleName)" == "$APP_NAME" ]] || die "bundle name is '$(plist CFBundleName)', not $APP_NAME"
  [[ "$(plist CFBundleShortVersionString)" == "$VERSION" && "$(plist CFBundleVersion)" == "$VERSION" ]] || die "bundle version is '$(plist CFBundleShortVersionString)', not $VERSION"
  [[ "$(plist CFBundleURLTypes.0.CFBundleURLSchemes.0)" == "$SCHEME" ]] || die "the bundle does not claim $SCHEME://"
  [[ -z "$(plist CFBundleURLTypes.0.CFBundleURLSchemes.1)" && -z "$(plist CFBundleURLTypes.1)" ]] || die "the bundle claims more than one URL scheme"
  local expected_plist
  expected_plist="$(mktemp "${TMPDIR:-/tmp}/markie-info-plist.XXXXXX")"
  node "$RUST_DIR/scripts/mac-info-plist.mjs" public "$VERSION" > "$expected_plist"
  if [[ "$(as_json "$APP/Contents/Info.plist")" != "$(as_json "$expected_plist")" ]]; then rm -f "$expected_plist"; die "Info.plist is not what scripts/mac-info-plist.mjs writes for this version"; fi
  rm -f "$expected_plist"
  [[ -n "$(plist CFBundleDocumentTypes.0.CFBundleTypeName)" ]] || die "the bundle declares no document types"
  [[ -f "$APP/Contents/Resources/icon.icns" ]] || die "the bundle has no icon.icns, which its document types name"
  # Squirrel.Mac names the installed app after CFBundleExecutable: anything but
  # Electron's "Markie" turns /Applications/Markie.app into another name.
  [[ "$(plist CFBundleExecutable)" == "$APP_NAME" ]] || die "the bundle executable is '$(plist CFBundleExecutable)', not $APP_NAME: Squirrel.Mac would install it as /Applications/$(plist CFBundleExecutable).app"
  [[ -f "$APP/Contents/MacOS/$APP_NAME" && -x "$APP/Contents/MacOS/$APP_NAME" ]] || die "Contents/MacOS/$APP_NAME is missing"
  [[ "$(ls "$APP/Contents/MacOS")" == "$APP_NAME" ]] || die "Contents/MacOS holds more than $APP_NAME"
  [[ "$(/usr/bin/lipo -archs "$APP/Contents/MacOS/$APP_NAME")" == arm64 ]] || die "the binary is not arm64 only"
  local reported expected="$APP_NAME $VERSION ($BUNDLE_ID) $COMMIT"
  reported="$("$APP/Contents/MacOS/$APP_NAME" --version)"
  [[ "$reported" == "$expected" ]] || die "the binary reports '$reported', expected '$expected' (rebuild from this commit)"
  # Agents keep the path they were set up with (scripts/stage-mcp.sh).
  local res="$APP/Contents/Resources"
  [[ "$(cat "$res/app-identity.json")" == "{\"appName\":\"$APP_NAME\",\"profileName\":\"$PROFILE_NAME\"}" ]] || die "app-identity.json does not name $APP_NAME and its data folder"
  cmp -s "$res/mcp/markie-mcp.mjs" "$RUST_DIR/scripts/mcp/markie-mcp.mjs" || die "Resources/mcp/markie-mcp.mjs is not the hand-over to the adapter"
  cmp -s "$res/markie-rs-mcp.mjs" "$RUST_DIR/crates/markie-agent/mcp/markie-rs-mcp.mjs" || die "the MCP adapter is not this commit's"
  [[ "$(cat "$res/mcp-server/COMMIT")" == "$(tr -d '[:space:]' < "$RUST_DIR/scripts/mcp/PIN")" ]] || die "the MCP server is not from the pinned commit"
  [[ -f "$res/mcp-server/markie-mcp.mjs" ]] || die "the MCP server is missing"
  [[ -z "$(find "$APP" -type l)" ]] || die "the bundle holds a symlink"
  say "shape ok: $expected"
}

# What a real release must pass: the checks the updaters make, plus the staple.
verify_signature() {
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$1" || die "the code signature is not valid"
  /usr/bin/codesign --verify --deep --strict --all-architectures -R="$REQUIREMENT" "$1" || die "not signed as $BUNDLE_ID by Developer ID team $TEAM_ID: an installed Electron Markie would refuse this update"
  local display assessment
  display="$(/usr/bin/codesign --display --verbose=4 "$1" 2>&1)"
  [[ "$(sed -n 's/^Identifier=//p' <<<"$display" | head -1)" == "$BUNDLE_ID" ]] || die "signed identifier is not $BUNDLE_ID"
  [[ "$(sed -n 's/^TeamIdentifier=//p' <<<"$display" | head -1)" == "$TEAM_ID" ]] || die "TeamIdentifier is not exactly $TEAM_ID"
  [[ "$(sed -n 's/^Authority=//p' <<<"$display" | head -1)" == "$IDENTITY" ]] || die "the signing certificate is not '$IDENTITY'"
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\(([a-z-]+,)*runtime(,[a-z-]+)*\)' <<<"$display" || die "the hardened runtime is not on"
  grep -q '^Timestamp=' <<<"$display" || die "the signature has no secure timestamp"
  assessment="$(/usr/sbin/spctl --assess --type execute --verbose=2 "$1" 2>&1)" || die "Gatekeeper does not accept the app: $assessment"
  grep -qx 'source=Notarized Developer ID' <<<"$assessment" || die "Gatekeeper accepts the app, but not as notarized: $assessment"
  /usr/bin/xcrun stapler validate "$1" >/dev/null || die "the notarization ticket is not stapled"
}

squirrel_finds() {
  local found=0 app
  while IFS= read -r app; do
    if [[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist" 2>/dev/null || true)" == "$BUNDLE_ID" ]]; then found=$((found + 1)); fi
  done < <(find "$1" -name '*.app' -type d -not -path '*.app/*')
  [[ "$found" == 1 ]]
}

installed_requirement_matches() {
  local installed="/Applications/Markie.app" theirs ours
  [[ -d "$installed" ]] || { say "no /Applications/Markie.app here to compare the requirement with"; return 0; }
  theirs="$(/usr/bin/codesign -d -r- "$installed" 2>/dev/null | sed -n 's/^designated => //p' | sed 's# /\* exists \*/##g')"
  ours="${REQUIREMENT// exists/}"
  [[ "$theirs" == "$ours" ]] || die "the installed Markie's designated requirement is not the one this script checks against: $theirs"
  say "the installed Markie's designated requirement is the one checked"
}

verify() {
  verify_shape
  installed_requirement_matches
  if (( DRY_RUN )); then
    say "DRY RUN, signature checks skipped."
    return
  fi
  verify_signature "$APP"
  say "verified: signed by $TEAM_ID, notarized (Gatekeeper source: Notarized Developer ID), stapled"
}

sha512_of() { /usr/bin/openssl dgst -sha512 -binary "$1" | /usr/bin/base64; }

zip() {
  verify
  rm -f "$ZIP"
  /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
  local stray
  stray="$(/usr/bin/zipinfo -1 "$ZIP" | grep -v "^$APP_NAME\.app/" || true)"
  [[ -z "$stray" ]] || die "the ZIP holds entries outside $APP_NAME.app: $stray"
  stray="$(/usr/bin/zipinfo -1 "$ZIP" | LC_ALL=C grep '[^ -~]' || true)"
  [[ -z "$stray" ]] || die "the ZIP holds a file name that is not plain ASCII: $stray"
  local check
  check="$(mktemp -d "${TMPDIR:-/tmp}/markie-public-zip-check.XXXXXX")"
  /usr/bin/ditto -x -k "$ZIP" "$check"
  squirrel_finds "$check" || { rm -rf "$check"; die "the ZIP does not unpack to exactly one $BUNDLE_ID bundle"; }
  if (( DRY_RUN )); then
    /usr/bin/diff -r "$APP" "$check/$APP_NAME.app" >/dev/null || { rm -rf "$check"; die "the ZIP does not unpack to the same bundle"; }
  else
    (verify_signature "$check/$APP_NAME.app") || { rm -rf "$check"; die "the unpacked bundle does not pass verification"; }
  fi
  rm -rf "$check"
  local size
  size="$(/usr/bin/stat -f %z "$ZIP")"
  (( size > 0 && size <= 512 * 1024 * 1024 )) || die "the ZIP is $size bytes; the updater takes at most 512 MiB"
  say "$ZIP"
  say "size $size, sha512 $(sha512_of "$ZIP")"
}

dmg() {
  need_app
  [[ -f "$ZIP" ]] || die "no ZIP at $ZIP; run the zip step first (it verifies the app)"
  local stage
  stage="$(mktemp -d "${TMPDIR:-/tmp}/markie-public-dmg.XXXXXX")"
  /usr/bin/ditto "$APP" "$stage/$APP_NAME.app"
  ln -s /Applications "$stage/Applications"
  rm -f "$DMG"
  /usr/bin/hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$stage" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG"
  rm -rf "$stage"
  if (( DRY_RUN )); then
    say "DRY RUN, the DMG is not signed or notarized. The real step runs:"
    show /usr/bin/codesign --force --timestamp --sign "$IDENTITY" "$DMG"
    show /usr/bin/xcrun notarytool submit "$DMG" --wait
    show /usr/bin/xcrun stapler staple "$DMG"
  else
    /usr/bin/codesign --force --timestamp --sign "$IDENTITY" "$DMG"
    notary_submit "$DMG"
    /usr/bin/xcrun stapler staple "$DMG"
    /usr/bin/codesign --verify --strict --verbose=2 "$DMG" || die "the DMG's signature is not valid"
    /usr/bin/xcrun stapler validate "$DMG" >/dev/null || die "the DMG's notarization ticket is not stapled"
    local assessment
    assessment="$(/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" 2>&1)" || die "Gatekeeper does not accept the DMG: $assessment"
    grep -qx 'source=Notarized Developer ID' <<<"$assessment" || die "Gatekeeper accepts the DMG, but not as notarized: $assessment"
  fi
  # The app inside is the verified one.
  local mount
  mount="$(mktemp -d "${TMPDIR:-/tmp}/markie-public-dmg-mount.XXXXXX")"
  /usr/bin/hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$mount" "$DMG"
  local ok=1
  /usr/bin/diff -r "$APP" "$mount/$APP_NAME.app" >/dev/null || ok=0
  [[ "$(readlink "$mount/Applications")" == /Applications ]] || ok=0
  /usr/bin/hdiutil detach -quiet "$mount" || true
  rmdir "$mount" 2>/dev/null || true
  (( ok )) || die "the DMG does not hold exactly the verified app and an Applications link"
  say "$DMG"
  say "size $(/usr/bin/stat -f %z "$DMG"), sha512 $(sha512_of "$DMG")"
}

manifest() {
  [[ -f "$ZIP" && -f "$DMG" ]] || die "the ZIP and the DMG must both exist; run the zip and dmg steps first"
  /usr/bin/python3 - "$MANIFEST" "$VERSION" "$COMMIT" "$ZIP" "$DMG" <<'PY'
import base64, hashlib, json, os, sys
out, version, commit, *paths = sys.argv[1:]
def entry(path):
    digest = hashlib.sha512()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return {"name": os.path.basename(path), "size": os.path.getsize(path), "sha512": base64.b64encode(digest.digest()).decode()}
data = {"version": version, "gitCommit": commit, "files": [entry(p) for p in paths]}
tmp = out + ".partial"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, out)
PY
  say "$MANIFEST"
  cat "$MANIFEST"
}

case "$STEP" in
  build) build ;;
  sign) sign ;;
  notarize) notarize ;;
  verify) verify ;;
  zip) zip ;;
  dmg) dmg ;;
  manifest) manifest ;;
  all) build; sign; notarize; zip; dmg; manifest ;;
esac
