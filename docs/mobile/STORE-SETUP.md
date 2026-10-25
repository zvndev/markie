# Markie Mobile: getting onto TestFlight and Play internal testing

Status, 2026-10-25:

- **iOS:** the App Store Connect record **Markie Docs** exists, with bundle ID `com.zvn.markie.mobile` on team `3VU8SG5TD9`. The name "Markie" was taken. Build 0.1.0 (1) was uploaded from Xcode Organizer on 2026-10-25. The home-screen name is still "Markie".
- **Android:** a signed release bundle is built at `~/Desktop/Markie-mobile-0.1.0-1.aab`. It isn't uploaded yet.

## Apple: Kirby Campbell's App Store Connect

1. **Done: create the app record.** At appstoreconnect.apple.com, go to Apps, then "+", then New App:
   - Platform: iOS
   - Name: "Markie" (if it's taken, use "Markie Docs")
   - Language: English (U.S.)
   - Bundle ID: `com.zvn.markie.mobile` (it's already in the list)
   - SKU: `markie-mobile`
2. **Give the agent upload access.** Do either one:
   - **Option A, preferred:** go to Users and Access, then Integrations, then Team Keys, then "+". Name it "Markie mobile CI" with role App Manager, and download the `.p8` into `~/Downloads`. Tell Claude the Key ID and the Issuer ID shown on that page. These are identifiers, not secrets, and Claude moves the file without ever printing it.
   - **Option B:** open Xcode, go to Settings, then Accounts, choose "+", and add the Apple account kirby@zvndev.com. That's the Kirby Campbell team account. Xcode currently has only kirby@bevrly.com, which is the Bevrly account.
3. **Claude then:**
   - uploads the build;
   - fills in export compliance (the app uses only standard HTTPS);
   - creates an internal TestFlight group with you in it.

## Google: Jaykasie's Play Console

1. **Create the app.** At play.google.com/console, choose Create app:
   - App name: "Markie"
   - Default language: English (United States)
   - App or game: App
   - Free or paid: Free
   - Accept the declarations.
2. **Upload the first build by hand.** Go to Testing, then Internal testing, then Create new release.
   - Accept Play App Signing.
   - Upload `Markie-mobile-0.1.0-1.aab`, the file Kirby sends.
   - Add testers by email list and roll out.
   - Google needs the first upload done in the Console before the API can upload later ones.
3. **Send Claude the app-signing fingerprint.** Go to Test and release, then App integrity, then App signing, and copy the SHA-256 of the **app signing key**. It goes into the server's `ANDROID_APP_CERT_SHA256`, which makes tapped links open the app.
4. **Optional, for automatic uploads later:** in Google Cloud, create a service account and download its JSON key into Kirby's `~/Downloads`. Then in Play Console, go to Users and permissions, invite the service account's email, and give it Release permissions for Markie.

**Upload key fingerprint (SHA-256), for reference:**

```
2E:2A:2E:72:DC:73:89:21:49:CC:1B:E6:DD:1B:90:4B:BC:2B:78:41:B3:CD:BE:DB:B7:A9:20:BE:3B:BE:54:FA
```

## Before testers get a useful app

These are separate approvals, and they aren't done yet:

1. **Merge PR #31 into `main`.**
2. **Deploy the server to production.** The app signs in and lists documents against it.
3. **Serve `/.well-known/apple-app-site-association` and `assetlinks.json` on markiedocs.com.** Without them, a tapped `https` link opens the web page instead of the app.

## Keys and where they live

- **Android upload keystore:** `~/.markie-mobile-keys/markie-upload.jks`. Its password is in the macOS Keychain under `markie-android-upload-keystore`. Back both up to the password manager. A lost upload key can be reset through Play support, but it takes days.
- **Rebuilding:**
  - Android: run `apps/mobile/scripts/build-android-release.sh`.
  - iOS: Xcode archive of `apps/mobile/ios/App` with automatic signing on team `3VU8SG5TD9`.
