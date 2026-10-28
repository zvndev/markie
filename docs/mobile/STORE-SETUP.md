# Markie Mobile: getting onto TestFlight and Play internal testing

Status, 2026-10-27:

- **iOS:** the App Store Connect record **Markie Docs** exists, with bundle ID `com.zvn.markie.mobile` on team `3VU8SG5TD9`. The name "Markie" was taken. Builds 0.1.0 (1) and (2) are on TestFlight. Build 0.2.0 (3) adds editing, new documents and "Open in Markie" for files from other apps. The home-screen name is still "Markie".
- **Android:** a signed release bundle, 0.1.0 (versionCode 2) with the L3 brand icon, is built at `~/Desktop/Markie-mobile-0.1.0-2.aab`. It isn't uploaded yet.
- **Server:** the app's server is live, and `apple-app-site-association` and `assetlinks.json` are served.

What is left:

1. Upload the Android bundle to Play internal testing. This waits on the Play Console account verification.
2. Set `ANDROID_APP_CERT_SHA256` on the server to the Play app-signing key's SHA-256, once Play shows it.

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
   - Upload `Markie-mobile-0.1.0-2.aab`, the file Kirby sends.
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
- **Rebuilding:**
  - Android: run `apps/mobile/scripts/build-android-release.sh`.
  - iOS: Xcode archive of `apps/mobile/ios/App` with automatic signing on team `3VU8SG5TD9`.
