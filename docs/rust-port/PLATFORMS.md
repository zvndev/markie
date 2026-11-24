# Markie platforms plan

Written 2026-11-24, after Kirby set the platform map. Estimates are agent time, with the gates that only Kirby can clear named.

## The map

| Platform | App | State today |
|---|---|---|
| Mac | Markie RS, the Rust app | 95.6% parity. Becoming the Mac super-nightly now |
| Windows | Electron Markie | Shipping. Signed with Azure Trusted Signing, NSIS installer, its own feed |
| Linux | Electron Markie | Shipping (AppImage and .deb). Not in Kirby's note; assumed to stay on Electron |
| Web | The hosted app at markiedocs.com | Shipping |
| iPhone and iPad | Markie Docs (Capacitor) | 0.4.0 built, waits on store steps. iPad runs the phone layout stretched |
| Android phones and tablets | Markie Docs (Capacitor) | 0.4.0 bundle built. Nothing on Play yet. Tablets get the phone layout |

## 1. Mac: Rust takes over

In progress now.

1. **Rust becomes the super-nightly.** Kirby's Electron super-nightly updates itself into the Rust app through its normal updater. On first launch the Rust app imports settings, styles, library, sign-in and vault from a read-only copy of Electron's profile. Windows and Linux feeds are untouched.
2. **Dogfood.** Kirby uses it daily for a week. Close the last parity rows: Touch ID, one real Google or Apple sign-in, a pinch, and two short screen sessions.
3. **Public Mac cutover.** The final Electron release for Mac hands Mac users to the Rust app through the same updater path the nightly proved. Windows and Linux stay on Electron.

Gates: Kirby's dogfood week and his cutover call.

## 2. Phones: get them into the stores

The code is done (0.4.0). What's left is all store steps, and most are Kirby's:

1. A TestFlight internal tester group in App Store Connect.
2. The Push Notifications capability on App ID `com.zvn.markie.mobile`.
3. Play Console account verification. The Console is on Jaykasie's account.
4. The first Play upload by hand, accepting Play App Signing.
5. The Play signing fingerprint, which goes into the server's `ANDROID_APP_CERT_SHA256`.
6. Push keys: an APNs `.p8` key, and a Firebase project for Android.
7. markie-site PR 5 live. This has to happen before the build with the HTTPS sign-in return ships.

The server deploy these needed went out today (markie-api `f6bba2b7d689`).

Agent time once the gates clear: under a day to upload, check on devices and fix anything found.

## 3. Tablets: a real iPad and Android tablet layout

Today a tablet shows the phone screens, stretched. A tablet layout means:

- a sidebar with the document list, beside the open document
- the editor and reader using the width: a readable column, plus the outline or comments in a side panel
- hardware keyboard shortcuts and pointer hover
- portrait and landscape, iPad Split View and Slide Over, Android multi-window and foldables
- store screenshots for iPad and Android tablets (Apple requires iPad shots because the app already lists iPad)

Agent time: 3 to 5 days for layout and tests, plus a day for screenshots and store listings. It shares code across iPad and Android tablets, and none of it waits on Kirby until the store listing.

## 4. Windows: port the Rust app later (no rush, per Kirby)

GPUI, the UI framework Markie RS is built on, runs on Windows: Zed ships on it. Most of Markie RS is plain Rust and should build there. The Mac-only parts are 55 `#[cfg(target_os = "macos")]` sites in about 20 files:

| Mac piece | Windows replacement |
|---|---|
| Print and PDF through AppKit and PDFKit | Windows print dialog and the native PDF export already in `markie-export` |
| Spell check (NSSpellChecker) | Windows spell checking API |
| Touch ID for the vault | Windows Hello |
| Keychain | Windows Credential Manager |
| Clipboard concealment for vault copies | The Windows clipboard history exclusion format |
| Default apps, file types, `markie://` | Registry entries written by the installer |
| Self-update by bundle swap | An installer-based update; a running .exe can't swap itself |
| System font list (Core Text) | DirectWrite |
| Signing and notarization | Azure Trusted Signing, already set up for Electron |

Plan:

1. **Spike: 1 to 2 days.** Build Markie RS on a Windows CI runner, stub the Mac-only pieces, get it to launch and render the scene tests. That turns the estimate below into a measured one.
2. **Port: about 3 to 5 days of agent time.** Replace each row above, add a Windows installer and updater lane, and run the five parity audits on Windows. GPUI's Windows backend is mature, and only the Mac-only edges need new code; the long pole is testing on a real Windows machine.
3. **Cutover:** the same pattern as the Mac. Windows super-nightly first, then the Windows stable feed hands users over.

Gates: a Windows machine for Kirby's in-person checks (Windows Hello, the installer, the feel). A cloud Windows VM works if he has no PC.

Timing: the full port is best started after the Mac cutover, so it ports a settled app. The spike is cheap and can run any time.

## 5. iPad on Rust: possible, needs a spike

Zed's GPUI has an iOS backend (`gpui_ios`: windows, touch events, keyboard text input), and the GPUI build Markie RS uses already ships it. It is young, about 3,600 lines, and not proven in an App Store app. There is no Android backend, so Android tablets would stay on the mobile app.

Unknowns a 1 to 2 day spike answers: launching Markie RS on the iPad simulator, text input with autocorrect and selection handles, scrolling feel, the Files app and sandboxed documents, and how much of the desktop UI needs touch-sized targets and no-hover menus.

## Recommended order

1. Now: the Mac Rust super-nightly (running).
2. Now, in parallel: the tablet layout. It's pure agent work.
3. When Kirby clears the store steps: ship the phones to TestFlight and Play internal testing.
4. After the Mac dogfood week: the public Mac cutover.
5. Then the Windows spike, then the Windows port.

## Decisions for Kirby

| Question | Recommendation |
|---|---|
| Does Linux stay on Electron with Windows? | Yes. It ships today and nobody has asked for more |
| Start the tablet layout now? | Yes |
| Run the Windows spike now, or after the Mac cutover? | After the cutover, unless you want the number sooner. It costs 1 to 2 days |
| Do you have a Windows PC for checks? | If not, a cloud Windows VM |
