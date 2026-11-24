# Markie Mobile: getting onto TestFlight and Play internal testing

Status, 2026-11-23.

## What is built

- **The app is at 0.4.0 (build 5)** in the source: `apps/mobile/package.json`, its lockfile, the Xcode project and `android/app/build.gradle`.
- 0.4.0 is the first build with the work from the original mobile plan: public links with no account, "Shared by me", comments on the reading screen, offline reading with queued edits and the conflict sheet, export as a file, HTML or PDF, push notifications (off until its keys exist), password, Google and Apple sign-in, files on the phone, the system text size, and a document's pinned theme.
- It was run on a headless iPhone simulator (iOS 26.5) and a headless Android emulator (Android 16) before the version was set. What was proven, and what still needs a real phone, is in the pull request for 0.4.0.
- **Nothing for 0.4.0 has been built for upload or uploaded.** No signed archive and no signed bundle exist for it yet.

## What was uploaded, and when

This is what the repository's own records say (`PROGRESS.md`, earlier versions of this page, the commit history). Confirm in App Store Connect before uploading, because both stores refuse a build number they have already seen.

| Platform | Build | Record |
|---|---|---|
| iOS | 0.1.0 (1) | Uploaded to App Store Connect as "Markie Docs", 2026-10-25, from Xcode Organizer. |
| iOS | 0.1.0 (2) | Uploaded 2026-10-27 with the new icons. |
| iOS | 0.2.0 (3) | Uploaded 2026-10-27. Editing, new documents, "Open in Markie". |
| iOS | 0.3.0 (4) | Numbered in the source. No upload is recorded anywhere. |
| Android | all | Nothing is on Play. Signed bundles are on Kirby's Desktop: `Markie-mobile-0.1.0-1.aab`, `0.1.0-2`, `0.2.0-3` and `0.3.0-4` (built 2026-11-20). |

The App Store Connect record is **Markie Docs**, bundle ID `com.zvn.markie.mobile`, team `3VU8SG5TD9`. The name "Markie" was taken. The home-screen name is "Markie".

## What waits on Kirby

In the order that unblocks the most:

1. **A TestFlight internal tester group** in App Store Connect. Builds have been uploaded since October and no group has ever been recorded, so nobody outside Xcode has installed one.
2. **The Push Notifications capability on the App ID** `com.zvn.markie.mobile`, in the Apple Developer account. Since 0.4.0 the app carries the `aps-environment` entitlement, and a signed archive fails without the capability. Associated Domains is already on.
3. **Play Console account verification.** Nothing can be uploaded to Play until it clears. The Console belongs to Jaykasie's account.
4. **The first Play upload, by hand**, with Play App Signing accepted (below).
5. **The Play app-signing fingerprint** (SHA-256), from App integrity. It goes into `ANDROID_APP_CERT_SHA256` on the server, before the upload key's fingerprint that is already there. Until then a tapped link on Android opens the browser, and the Google and Apple sign-in return uses the custom scheme.
6. **The push keys**, as `docs/mobile/PUSH.md` describes: an APNs auth key (`.p8`, key ID) for team `3VU8SG5TD9`, and a Firebase project with a service account for the server and `google-services.json` for the Android build. Without them the app runs and simply never gets a notification.
7. **A server deploy** from `ZVN-DEV/zvn-infra`. The live server does not have these yet:
   - the phone's device routes (`POST /api/me/devices`, `DELETE /api/me/devices/:token`);
   - the Google and Apple hand-off for phones (`/auth/mobile-start`, `/auth/mobile-bridge`, `/auth/mobile-exchange`, and `signIn.mobile` in `/api/server-info`);
   - `/auth/mobile-return` in the association files;
   - `Retry-After` on rate-limited sign-ins, and the session lifetime written down (no change in behaviour).

   The 0.4.0 app is quiet against the current server: it offers no Google or Apple button, and a refused device registration shows nothing. The site rewrite in `ZVN-DEV/markie-site` PR 5 must be live before a build that uses the HTTPS sign-in return ships.
8. **Optional:** an App Store Connect API key, so an agent can upload without Xcode's signed-in account (Apple, step 2).

## Apple: Kirby Campbell's App Store Connect

1. **Done: create the app record.** At appstoreconnect.apple.com, go to Apps, then "+", then New App:
   - Platform: iOS
   - Name: "Markie" (if it's taken, use "Markie Docs")
   - Language: English (U.S.)
   - Bundle ID: `com.zvn.markie.mobile` (it's already in the list)
   - SKU: `markie-mobile`
2. **Upload access.** Build 0.1.0 (1) went up from Xcode Organizer. Build 0.1.0 (2) went up with `xcodebuild -exportArchive` (destination `upload`, `-allowProvisioningUpdates`) on the account Xcode is signed in to. For uploads by an agent later, do either one:
   - **Option A, preferred:** go to Users and Access, then Integrations, then Team Keys, then "+". Name it "Markie mobile CI" with role App Manager, and download the `.p8` into `~/Downloads`. Tell Claude the Key ID and the Issuer ID shown on that page. These are identifiers, not secrets, and Claude moves the file without ever printing it.
   - **Option B:** open Xcode, go to Settings, then Accounts, choose "+", and add the Apple account kirby@zvndev.com. That's the Kirby Campbell team account, not kirby@bevrly.com.
3. **Done: upload the build to TestFlight.** Export compliance: the app uses only standard HTTPS. `Info.plist` sets `ITSAppUsesNonExemptEncryption` to false, so App Store Connect answers it for every build.

## Google: Jaykasie's Play Console

1. **Create the app.** At play.google.com/console, choose Create app:
   - App name: "Markie"
   - Default language: English (United States)
   - App or game: App
   - Free or paid: Free
   - Accept the declarations.
2. **Upload the first build by hand.** Go to Testing, then Internal testing, then Create new release.
   - Accept Play App Signing.
   - Upload the newest signed bundle, the file Kirby sends. That is 0.4.0 (5) once it is built; older ones are on his Desktop.
   - Add testers by email list and roll out.
   - Google needs the first upload done in the Console before the API can upload later ones.
3. **Send Claude the app-signing fingerprint.** Go to Test and release, then App integrity, then App signing, and copy the SHA-256 of the **app signing key**. It goes into the server's `ANDROID_APP_CERT_SHA256`, which makes tapped links open the app.
4. **Optional, for automatic uploads later:** in Google Cloud, create a service account and download its JSON key into Kirby's `~/Downloads`. Then in Play Console, go to Users and permissions, invite the service account's email, and give it Release permissions for Markie.

**Upload key fingerprint (SHA-256), for reference:**

```
2E:2A:2E:72:DC:73:89:21:49:CC:1B:E6:DD:1B:90:4B:BC:2B:78:41:B3:CD:BE:DB:B7:A9:20:BE:3B:BE:54:FA
```

## Before testers get a useful app

Done: PR #31 is merged, the server is deployed, and `/.well-known/apple-app-site-association` and `assetlinks.json` are served on markiedocs.com and api.markiedocs.com. Android app links still need `ANDROID_APP_CERT_SHA256` (Google step 3).

## Keys and where they live

- **Android upload keystore:** `~/.markie-mobile-keys/markie-upload.jks`. Its password is in the macOS Keychain under `markie-android-upload-keystore`. Back both up to the password manager. A lost upload key can be reset through Play support, but it takes days.
## Building for upload

The version lives in four places and is changed by hand: `apps/mobile/package.json`, `apps/mobile/package-lock.json`, `ios/App/App.xcodeproj/project.pbxproj` (`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`, twice each) and `android/app/build.gradle` (`versionName`, `versionCode`). The root `npm run release:version` is for the desktop and does not touch them.

Both builds need the root `npm ci` and `npm ci` in `apps/mobile` first. Uploading is a person's decision each time.

### Android

```sh
cd apps/mobile
scripts/build-android-release.sh
# writes android/app/build/outputs/bundle/release/app-release.aab
```

It runs `npm run sync` (the shipping web build), reads the upload keystore and takes its password from the macOS Keychain. It needs JDK 21. There is no upload command: the bundle goes up by hand in Play Console, under Testing, Internal testing.

### iOS

There is no script. These are the commands, from `apps/mobile`:

```sh
npm run sync                # the shipping web build, then cap sync into ios/ and android/
OUT=$(mktemp -d)
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Markie.xcarchive" \
  -allowProvisioningUpdates archive
```

Checked on 2026-11-23 for 0.4.0 (5), into a scratch folder, with nothing uploaded:

- The same `archive` command with signing turned off (`CODE_SIGNING_ALLOWED=NO`) succeeds: the Release build of 0.4.0 (5) compiles and archives.
- With signing on, and without `-allowProvisioningUpdates`, it stops with: `Provisioning profile "iOS Team Provisioning Profile: com.zvn.markie.mobile" doesn't include the Push Notifications capability` and `doesn't include the aps-environment entitlement`. That is item 2 under "What waits on Kirby".
- `-allowProvisioningUpdates` lets Xcode turn the capability on and make a new profile by itself. It changes the Apple Developer account, so it was not run. Either add the capability by hand first, or run the command above knowing it will.

To upload the archive to App Store Connect, which nobody should run without Kirby's word:

```sh
cat > "$OUT/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>3VU8SG5TD9</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$OUT/Markie.xcarchive" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" \
  -allowProvisioningUpdates
```

- It signs with the Apple account Xcode is signed in to on this Mac, on team `3VU8SG5TD9`, with automatic signing.
- The export options file is not in the repo. The one above is a reconstruction of what build 0.1.0 (2) went up with, and the export step has not been run since.
- The entitlements file says `aps-environment` is `development`. Signing for the App Store rewrites it to `production`, which is also what `APNS_ENV` on the server must say for TestFlight and App Store builds.
- There is no mobile CI workflow in `.github/workflows`.
