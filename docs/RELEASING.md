# Releasing Markie (macOS, Apple Silicon)

Markie ships as a signed + notarized `.dmg`, and updates itself via
`electron-updater` reading a public feed on Backblaze B2.

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
   action.

3. With all the env vars above set:

   ```sh
   npm run electron:release
   ```

   This builds the static site, packages the arm64 app, signs it, notarizes +
   staples it, builds the `.dmg` and `.zip`, and uploads the artifacts +
   `latest-mac.yml` to the B2 bucket.

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
and the recipient just drags it to Applications. (Apple Silicon only.)
