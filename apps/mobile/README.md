# Markie for iOS and Android

A Capacitor 8 app that opens Markie Cloud documents on a phone, including the ones agents make.
It follows `docs/mobile/AGENT-LINKS-CONTRACT.md` ("Mobile app" and "Link contract").

- Bundle ID and Android package: `com.zvn.markie.mobile`. Display name: Markie. Apple team: `3VU8SG5TD9`.
- Screens: Sign in (email code), Recent, Document (markdown, text, Darkmown), Settings.
- The session token is stored in the iOS Keychain or, on Android, encrypted with an Android Keystore key
  (`@aparajita/capacitor-secure-storage`, wrapped by `src/lib/secure-store.ts`). It is never written to
  `localStorage`, Preferences or a cookie jar, and no response is kept in an HTTP cache: requests send
  `Cache-Control: no-store`, the server answers API calls with it, and iOS's URLSession cache has no
  capacity (`ios/App/App/MarkieBridgeViewController.swift`). Capacitor's plugin logging is off, so it
  never reaches a device log either. Signing out clears it at once; the server is told afterwards.
- The iOS Keychain outlives an uninstall. On the first launch after an install the app clears what an
  earlier install left there (`ios/App/App/AppDelegate.swift`), so a reinstall starts signed out.

## How the renderer is shared

The app does not fork the desktop renderer. `vite.config.ts` points the `@` alias at the repo's `src/`,
so the app imports the same modules the desktop and the share pages use:

- `@/lib/markdown-html` turns markdown into sanitized HTML, styled by the desktop's `.markdown-body` rules.
- `@/lib/darkmown` compiles `.wd` documents and builds the sandboxed frame with the same pinned
  runtime, the same trust choice and the same frame sandbox policy (`src/lib/darkmown/frame.ts`).

Shared modules resolve their dependencies from the root `node_modules`, so install the root first.
React always resolves from this app, so there is one copy of it.

The app stays out of the root `npm test`, lint, tsconfig and electron-builder globs. It has its own
`package.json`, lockfile, tsconfig, Vite config and test command.

## Run

```sh
npm ci                      # at the repo root, for the shared renderer's dependencies
cd apps/mobile && npm ci
npm run mock                # mock server on http://127.0.0.1:8790, every code is 123456
npm run dev                 # the app in a desktop browser at http://localhost:5174
```

In the browser, requests use `fetch` and the session is kept in memory only.
On a device, requests go through Capacitor's native HTTP stack, because the server grants CORS to no web view.

On the Sign in screen, open "Advanced" and set the server:

- iOS Simulator: `http://localhost:8790`
- Android emulator: `http://10.0.2.2:8790`. Only a development web build (`npm run build:dev` or
  `npm run sync:dev`) accepts that address; `npm run build`, the one that ships, refuses it. The Android
  debug network config also allows plain http to localhost, 127.0.0.1 and 10.0.2.2 only.

The default server is `https://api.markiedocs.com`.

To try the real server instead of the mock, run it locally on a throwaway database
(`server/src/migrate.ts` once, then `server/src/index.ts` with `DB_PATH`, `PORT` and
`BETTER_AUTH_URL` set). Outside production it prints sign-in codes to its console.
Seed documents with an agent token through `POST /api/agent/docs`.

## Build

Needs Xcode 26 with an iOS 26 simulator runtime, the Android SDK, and JDK 21 (Capacitor 8's Android build requires it).

```sh
npm run sync                # web build, then cap sync into ios/ and android/
npm run sync:dev            # the same, accepting the emulator's http://10.0.2.2 (development only)
npm run ios                 # build and run on a simulator or device
npm run android             # build and run on an emulator or device

# Or by hand:
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath /tmp/markie-mobile-dd build
JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./android/gradlew -p android assembleDebug
```

## Test

```sh
npm test                    # vitest: API client, deep-link router, token storage, recent list, mock server, CSP
npm run typecheck
```

End to end, with Maestro, a booted simulator, a running emulator and the mock server:

```sh
IOS_DEVICE=<simulator udid> ANDROID_DEVICE=emulator-5554 e2e/screenshots.sh
```

That builds both apps, signs in on each, walks every screen in light and dark, and writes
`screenshots/<platform>-<tone>-<n>-<screen>.png`.

## Deep links

The mock server seeds markdown documents (one with a synced picture), Darkmown documents and a text file.
Their ids are printed at startup.

```sh
xcrun simctl openurl booted markie-mobile://d/<id>
adb shell am start -a android.intent.action.VIEW -d "markie-mobile://d/<id>"
```

Accepted links:

- `https://api.markiedocs.com/d/<id>` and `https://markiedocs.com/d/<id>`
- `https://api.markiedocs.com/s/<token>` and `https://markiedocs.com/s/<token>`
- `markie-mobile://d/<id>` and `markie-mobile://s/<token>`
- `/d` and `/s` links on the server the user signed in to

A link that arrives before sign-in is remembered and opens after sign-in.
A document the user cannot read shows the server's message and a way back to Recent.
An https link on a Markie host that the app cannot route (a raw download) opens in the default browser.
Any other URL another app sends is ignored.

## Links and pictures inside a document

- Markie document links open in the app. Other web links open in the device's default browser, not an
  in-app browser sheet (DESIGN.md: "Ordinary HTTP(S) links use the device's default browser").
- A picture the author's Markie synced (`![](shots/a.png)`) is fetched from the document's asset route
  with the session token, never cached, and shown as a `blob:` URL. A public share's pictures come from
  the share's own asset route. Video and audio beside the document are not fetched on a phone.

## Ship checklist (owner)

Each step needs a person with the account. Current status, and what is still left, is in
`docs/mobile/STORE-SETUP.md`.

Signing and identity:

1. In the Apple Developer account for team `3VU8SG5TD9`, register the App ID `com.zvn.markie.mobile`
   with the Associated Domains capability.
2. In Xcode, open `ios/App/App.xcodeproj`, choose the team, and let Xcode manage signing.
   Set the version and build number.
3. Create an Android upload keystore and keep it out of the repo. Configure release signing
   in `android/app/build.gradle` through local properties or environment variables, never committed values.
4. Enroll the app in Play App Signing. Note both the upload key and the app signing key SHA-256 fingerprints.

Link association:

5. Set `ANDROID_APP_CERT_SHA256` on the server to the Play app signing fingerprint
   (and the upload key's, comma-separated, for testing sideloaded release builds).
6. Check that `https://api.markiedocs.com/.well-known/apple-app-site-association` and
   `/.well-known/assetlinks.json` return JSON with no redirect and no auth.
   The AASA must list, in order: exclude `/d/*/*`, exclude `/s/*/*`, include `/d/*` and `/s/*`.
7. Proxy `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` on
   `markiedocs.com` to the same server, next to the existing `/d`, `/s` and `/download` proxies.
   Without that, links on `markiedocs.com` open in the browser.
8. On a device, check with Apple's `swcutil` or a long-press on a link in Notes, and on Android with
   `adb shell pm get-app-links com.zvn.markie.mobile`.

Store setup:

9. Create the App Store Connect record and the Play Console app. See `docs/mobile/STORE-SETUP.md`.
10. Privacy: the app collects an email address for sign-in and stores a session token on the device.
    It has no analytics and no tracking.
11. Screenshots for the listings can start from `screenshots/`, retaken on the required device sizes.
12. Upload to TestFlight and an internal Play track first. Test sign-in, a universal link,
    an app link and a Darkmown document on real phones before any public release.
