# Releasing Markie

Markie currently publishes a signed + notarized Apple Silicon macOS `.dmg`, and
updates itself via `electron-updater` reading a public feed on Backblaze B2.
The repo also defines local packaging targets for Intel macOS, Windows x64, and
Linux x64 so those artifacts can be prepared and verified before any public
release work.

## Desktop artifact matrix

| Platform | Local target(s) | Public release status |
| --- | --- | --- |
| macOS Apple Silicon | `dmg`, `zip` | Current signed/notarized release path |
| macOS Intel | `dmg`, `zip` | Local packaging config exists; public release not yet shipped |
| Windows x64 | `nsis`, `zip` | Local packaging config exists; code signing/feed work still required |
| Linux x64 | `AppImage`, `deb` | Local packaging config exists; distribution decision still required |

Safe local packaging commands:

```sh
npm run electron:pack:mac:arm64
npm run electron:pack:mac:x64
npm run electron:pack:win
npm run electron:pack:linux
```

These commands pass `--publish never` through `scripts/local-electron-builder.mjs`,
which also sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and strips local signing /
notarization credentials. For macOS local builds it also adds
`-c.mac.identity=null`, so these are not Developer ID signing, notarization,
release, or upload commands. Apple Silicon binaries may still report an ad-hoc
linker signature; that is not a distributable release signature.
After a local package command, smoke the unpacked artifact structure before
making any platform-readiness claim:

```sh
npm run electron:smoke:mac:arm64
npm run electron:smoke:mac:x64
npm run electron:smoke:win
npm run electron:smoke:linux
```

The macOS local package path also runs the `build/preflight.cjs` window smoke
gate during `afterPack`; Apple Silicon hosts with Rosetta can launch-smoke the
Intel macOS package. Windows and Linux currently get deterministic structure
checks locally; OS-level launch evidence still needs a matching Windows or
Linux host before public release.

## One-time setup

### 1. Apple notarization credentials (env)
Create an app-specific password at appleid.apple.com → Sign-In & Security →
App-Specific Passwords. Then export (or put in a local, gitignored `.env`):

```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="3VU8SG5TD9"
```

Signing uses the **Developer ID Application: Kirby Campbell (3VU8SG5TD9)**
certificate already in the login keychain.

### 2. Backblaze B2 release bucket (public)
Create a **public** bucket named `markie-releases` (separate from the private
`Markie` backups bucket), region `us-east-005`. Create an application key with
write access to it, then export:

```sh
export AWS_ACCESS_KEY_ID="<b2 keyID>"
export AWS_SECRET_ACCESS_KEY="<b2 applicationKey>"
```

electron-builder uploads via B2's S3-compatible API (see `build.publish` in
package.json); the app reads the feed back over public HTTPS at
`https://s3.us-east-005.backblazeb2.com/markie-releases/mac/`.

## Cutting a release

1. Bump `version` in `package.json`.
2. Run the safe local preflight without release credentials:

   ```sh
   npm run release:preflight
   ```

   This checks package metadata, required release files, renderer/Electron
   tests, MCP tests, server tests, lint, and the static build. It stops before
   signing, notarization, upload, publish, deploy, or any credentialed network
   action. It also verifies that local packaging and package-smoke scripts exist
   for the desktop matrix; run the relevant `electron:pack:*` and
   `electron:smoke:*` commands separately when proving an artifact on a host.

3. With all the env vars above set:

   ```sh
   npm run electron:release
   ```

   This builds the static site, packages the configured macOS targets, signs
   them, notarizes + staples them, builds the `.dmg` and `.zip`, and uploads the
   artifacts + `latest-mac.yml` to the B2 bucket. Do not use this command for
   Windows or Linux until their signing, update feeds, and public download URLs
   have been explicitly approved.

4. Verify: `spctl -a -vvv -t install dist/mac-arm64/Markie.app` should report
   `accepted` / `source=Notarized Developer ID`.

## How auto-update works at runtime

- On launch (+10s) and every 6h, the app checks `latest-mac.yml` on the feed.
- A newer build downloads in the background (`update-downloaded`), and the
  renderer shows a "Restart to update" toast (`UpdateToast`).
- Squirrel.Mac swaps the app on quit; updates only install if signed+notarized,
  which is why the zip target and notarization are required.

## Sharing a build manually

`dist/Markie-<version>-arm64.dmg` is a normal notarized DMG — AirDrop / send it
and the recipient just drags it to Applications. Intel Mac, Windows, and Linux
artifacts should stay private/local until their release checklist is complete.
