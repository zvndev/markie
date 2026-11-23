# Markie for iOS and Android

A Capacitor 8 app that opens Markie Cloud documents on a phone, including the ones agents make.
It also opens, edits and saves the person's own files on the phone, with no account ("Files on this phone").
It follows `docs/mobile/AGENT-LINKS-CONTRACT.md` ("Mobile app" and "Link contract").

- Bundle ID and Android package: `com.zvn.markie.mobile`. Display name: Markie. Apple team: `3VU8SG5TD9`.
- Screens: Sign in (email code, password, Google and Apple), Recent (search, "Shared with you", "Shared by me" and type filters), Document (markdown, text,
  Darkmown), Word/RTF/OpenDocument, Editor (rich, source, live), Comments, Share (with export as a file,
  HTML or PDF), New document, an incoming file, On this phone (files and folders, signed in or not), Settings.
- The session token is stored in the iOS Keychain or, on Android, encrypted with an Android Keystore key
  (`@aparajita/capacitor-secure-storage`, wrapped by `src/lib/secure-store.ts`). It is never written to
  `localStorage`, Preferences or a cookie jar, and no response is kept in an HTTP cache: requests send
  `Cache-Control: no-store`, the server answers API calls with it, and iOS's URLSession cache has no
  capacity (`ios/App/App/MarkieBridgeViewController.swift`). Capacitor's plugin logging is off, so it
  never reaches a device log either. Signing out clears it at once; the server is told afterwards.
- Documents the person opens are kept on the phone so they open with no network. What is kept, where,
  what protects it and what wipes it is under "What is kept on the phone" below. The token is never
  kept with them.
- The iOS Keychain outlives an uninstall. On the first launch after an install the app clears what an
  earlier install left there (`ios/App/App/AppDelegate.swift`), so a reinstall starts signed out.

## What is kept on the phone

Through 0.3.0 the app kept nothing: every document was read from the network and held in memory. That
changed on purpose, so that an opened document still opens on a plane and an edit made there is not
lost. This section is the whole of it.

What is stored (`src/lib/offline-store.ts`, behind `src/lib/offline-api.ts`):

- Every Markdown, text and Darkmown document this account opens: its text as the server gave it,
  where its relative links point, and the pictures it shows that the author's Markie synced.
- A public share the person opens while signed in, the same way.
- The last Recent list (names, dates, roles; no document text).
- Edits the server has not taken: the text, and the version it started from.
- Not stored: the session token (it stays in the Keychain or Keystore), Word, RTF and OpenDocument
  files, comments, who a document is shared with, and anything about another account.

Where, and what protects it:

- IndexedDB in the app's own web view, database `markie-offline-v1`. Never `localStorage`, never a
  shared or external folder.
- iOS: WebKit keeps it under `Library/WebKit` in the app's container. The container is sandboxed from
  other apps and encrypted by iOS Data Protection with a key tied to the device passcode (the default
  class, readable after the first unlock following a restart). `AppDelegate.swift` marks that folder
  as excluded from backup on every launch, so the copies go to neither iCloud nor a Finder backup.
- Android: the app's private data directory, readable by this app's user only and encrypted by the
  device's file-based encryption. The manifest already turns backup off (`allowBackup="false"`) and
  excludes everything from cloud backup and device-to-device transfer (`data_extraction_rules.xml`).
- A device with no passcode, or one that is rooted or jailbroken, has none of the encryption above.
  That is the same protection the system gives any app's files, and no more.

What wipes it:

- Signing out: documents, pictures, the list and unsent edits all go, before the server is told and
  whether or not there is a network. If an edit has not been sent, Settings says so first and the
  button reads "Sign out and delete".
- A different account signing in, on the same server or another.
- A launch that finds no session, which covers a reinstall on iOS (the container is deleted with the
  app, and the Keychain session is cleared on first launch).
- A document the server says this account can no longer read (403 or 404 when it is opened again) is
  removed on the spot.
- One exception, on purpose: when the server ends the session on its own (a 401), everything goes
  except edits that were never sent. Those are held for the same account's next sign-in, because
  dropping them would destroy the only copy. The sign-in screen says how many are held. Anyone else
  signing in wipes them.

How much: at most 200 documents and 64 MB (text and pictures together). A document over 8 MB or a
picture over 4 MB is read from the network each time. When the cap is reached the least recently
opened documents go first. A document with an unsent edit is never evicted.

Offline, the screens say so: Recent shows the last list with a small arrow on the documents that
open, a document says it is the copy kept on the phone, and neither says "failed".

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
npm test                    # vitest: API client, deep-link router, token storage, recent list, writing, incoming files, export, mock server, CSP, push,
                            # the phone's store: the wipe, the cap, the edit queue, the conflict choices,
                            # and local files with the native plugin faked (test/local-files.test.ts)
npm run typecheck
```

End to end, with Maestro, a booted simulator, a running emulator and the mock server:

```sh
IOS_DEVICE=<simulator udid> ANDROID_DEVICE=emulator-5554 e2e/screenshots.sh
```

That builds both apps, signs in on each, walks every screen in light and dark, and writes
`screenshots/<platform>-<tone>-<n>-<screen>.png` (or to `OUT=<dir>`). Besides Recent, the documents,
the error links, Settings and Sign in, it covers wide content (`e2e/wide.yaml`: a transcript, a
nine-column table, a log), Requests and the share sheet (`e2e/sharing.yaml`), and the writing screens
(`e2e/writing.yaml`), all from the mock's seed data. Live editing, comments and Word files need a local
real server (below), so they are not in the walk.

## Deep links

The mock server seeds markdown documents (one with a synced picture, one shared with three people,
three wide ones), Darkmown documents, text files and three share requests.
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

With nobody signed in, a public share (`/s/<token>`) opens to read at once, through a client that holds
no token (`src/screens/public-doc.tsx`). It offers "Sign in", and nothing that needs an account.
A private document (`/d/<id>`) never opens signed out: the server decides who may read it, and can only
do that for an account. Either kind is remembered for an hour and opens after sign-in.
In the desktop browser (`npm run dev` only), `http://localhost:5174/?link=<url>` stands in for a tapped link.
A document the user cannot read shows the server's message and a way back to Recent.
An https link on a Markie host that the app cannot route (a raw download) opens in the default browser.
Any other URL another app sends is ignored.

## Signing in

The sign-in screen offers an emailed code, the account's password ("Use a password instead"), and
Google and Apple where the chosen server offers them. No account is created with a password on the
phone: a new address signs in with a code.

Google and Apple (`src/lib/provider-sign-in.ts`, `server/src/mobile-auth.ts`):

- The app asks the server what it supports (`GET /api/server-info`). It shows Google or Apple only
  when the answer has `signIn.mobile: true` and names that provider. A server that does not answer,
  or one from before the hand-off, gets neither. This holds for a self-hosted server under Advanced.
- On iOS, Google shows only where Apple shows too, with Apple first (App Store guideline 4.8).
- The provider's screen opens in the phone's browser, never in a web view inside the app.
- The app makes a random secret and keeps it in the Keychain or Keystore. The browser is sent to
  `/auth/mobile-start` with the secret's SHA-256 and a random state. That opens a sign-in on the
  server, tied to that browser by a cookie and to that one trip to the provider.
- Only that trip's own callback, arriving in the browser that opened the sign-in, can finish it.
  A session the browser already had, a callback from another start, or the right callback in
  somebody else's browser finishes nothing. The browser is known by a `__Host-` cookie, which
  another site on a sibling name cannot set. The session the provider step makes is ended at
  the callback and its cookie is never sent, so the browser is left signed out of nothing and
  into nothing.
- The server's page then shows who signed in and a "Return to Markie" button. The link carries a
  code that lasts two minutes and works once, the state, and the server's origin as `iss`. It
  never carries a session token.
  - On Markie Cloud the link is `https://markiedocs.com/auth/mobile-return#code=...`, a universal
    link on iOS and an app link on Android, so only this app can be handed it. The pieces ride the
    fragment, which no server is sent. Android uses it once `ANDROID_APP_CERT_SHA256` is set on the
    server, and the custom scheme until then.
  - A self-hosted server, whose host the app cannot claim, uses
    `markie-mobile://auth?code=...&state=...&iss=...`.
- The app accepts the link only when the state is its own, `iss` is the server it started on, and
  it carries a well-formed code or a refusal. It then posts the code and the secret to
  `/auth/mobile-exchange` on that server and gets a session of its own back over HTTPS. Any other
  link is ignored, and a sign-in under way is left alone.
- Signing in another way, or changing the server, cancels a sign-in that is waiting on the
  browser. An answer that arrives after that is dropped, and the session it brought is ended.

A link that leaks, or that another app receives, is a code with no secret. It opens nothing, and
trying it spends it. On the custom scheme, an app that opened the sign-in itself and got someone to
finish it and tap the button would hold the secret too. The verified link is what closes that, which
is why Markie Cloud uses it. The result goes through the same `signedIn` path as every other
sign-in, so the offline store's rules for a changed account hold.

Accepted, open risk. An app that pretends to be Markie can run the whole sign-in inside a web view
of its own and read the code from the page. It made the secret, so the exchange gives it a session.
The verified link does not help there: it only protects a sign-in that runs in a real browser.
Two things would close it, and neither is built:

- Device attestation on the exchange (App Attest on iOS, Play Integrity on Android), so the server
  only answers the real app.
- Apple's and Google's native sign-in, which never shows a page another app can host.

Until one of them exists, the defence is the person's own: the page is the provider's, in their
browser, and it names the account that signed in.

In the desktop browser (`npm run dev` only), `http://localhost:5174/?link=<url>` stands in for a tapped link.
A document the user cannot read shows the server's message and a way back to Recent.
An https link on a Markie host that the app cannot route (a raw download) opens in the default browser.
Any other URL another app sends is ignored.

## Signing in

The sign-in screen offers an emailed code, the account's password ("Use a password instead"), and
Google and Apple where the chosen server offers them. No account is created with a password on the
phone: a new address signs in with a code.

Google and Apple (`src/lib/provider-sign-in.ts`, `server/src/mobile-auth.ts`):

- The app asks the server what it supports (`GET /api/server-info`). It shows Google or Apple only
  when the answer has `signIn.mobile: true` and names that provider. A server that does not answer,
  or one from before the hand-off, gets neither. This holds for a self-hosted server under Advanced.
- On iOS, Google shows only where Apple shows too, with Apple first (App Store guideline 4.8).
- The provider's screen opens in the phone's browser, never in a web view inside the app.
- The app makes a random secret and keeps it in the Keychain or Keystore. The browser is sent to
  `/auth/mobile-start` with the secret's SHA-256 and a random state.
- After the provider, the server's page shows who signed in and a "Return to Markie" button. Its
  link is `markie-mobile://auth?code=...&state=...&iss=...`. The code lasts two minutes and works
  once. The link never carries a session token.
- The app accepts the link only when the state is its own and `iss` is the server it started on.
  It then posts the code and the secret to `/auth/mobile-exchange` on that server and gets the
  session back over HTTPS. Any other link is ignored, and a sign-in under way is left alone.

A link that leaks, or that another app receives, is a code with no secret. It opens nothing, and
trying it spends it. The result goes through the same `signedIn` path as every other sign-in, so the
offline store's rules for a changed account hold.

In the desktop browser (`npm run dev` only), a `markie-dev-link` window event carrying the link
stands in for the tap, without the reload that would lose the secret.

## Writing

The phone edits with the desktop's own editors, reached through the `@` alias like the renderer:

- Markdown opens in the desktop's rich view (`@/components/rich-view`), with Rich and Source one tap
  apart. The row above the keyboard runs the desktop format rail's own commands
  (`COMMON` in `src/components/format-rail.tsx`): headings, bold, italic, lists, tasks, quotes, code,
  tables, rules and links, plus undo and redo. Source has the plain text and the Markdown shortcuts.
- Solo: a document nobody else is on saves through `PUT /api/docs/:id` with the version it started
  from, the same route and hash (SHA-256 of the text) the desktop's sync uses.
- Offline: a save the server never received is kept on the phone as an unsent edit ("unpushed", the
  desktop's own word in `electron/sync.js`) with the version it started from. It goes out when the
  connection is back, also after the app was closed, and always with that same version: a queued save
  can never overwrite a newer cloud copy, the server refuses it and it becomes a conflict. A new
  document made offline is created the same way. A live document closed while offline is kept the same
  way instead of being dropped.
- Conflicts: when both copies changed, the conflict sheet (`src/components/conflict-sheet.tsx`, the
  desktop's `conflict-dialog.tsx` as a sheet) reads the cloud copy and states the cost in lines with
  the desktop's `@/lib/line-diff`. "Keep both" is first and focused: it saves the person's version as
  a second document named like the desktop's ("Plan (my version).md", then "(my version 2)"), and only
  then puts the cloud copy in the original. "Keep mine" reads the cloud version again and saves on top
  of it. "Take the cloud copy" drops their version, and is refused while the edit is unpushed. Nothing
  is ever merged.
- An edit the server refuses outright (access removed, document deleted, storage full) stays on the
  phone, with "Save as a new document" and "Delete my edit".
- Live: the desktop's rule decides (`src/lib/live.ts`). Once anyone else is on a Markdown or plain-text
  document (`GET /api/docs/:id/shares` is not empty) and it is under 1 MB, the editor joins the
  desktop's room for it over `/collab/<id>`: Markdown through the rich view, text through
  `@/components/text-collab-editor`. Others' names and carets show, and their edits arrive as they type.
  The socket's only credential is a five-minute pass from `POST /api/docs/:id/collab-ticket`; the
  session token never goes in its URL, and the phone never takes the desktop's "legacy" token path.
  Typing waits until the room has synced and holds the document. The room's text is written back as the
  stored version a few seconds after a change, under the policy the web app shares
  (`@/lib/live-snapshot`):
  - only by the room's one writer
  - never over a stored copy with front matter or raw HTML, which a live rich room can't keep
  - never over a version written from outside the room, which shows as a conflict instead

  A session whose pass never comes drops to editing alone. Source is read-only while live, exactly as on
  the desktop. When the server closes the room because the person's access was removed (close code
  4403), the editor says access changed and goes read-only. It does not say "offline".
- Comments work on the reading screen of any Markdown document that is shared, with no live room
  needed. Open threads are highlighted on their words, and the Comments button counts them. Select
  words and tap Comment to start a thread. Its anchor is the quoted words with a little text on each
  side (`@/lib/quote-anchor`), and the desktop finds those words in its own editor
  (`@/lib/comment-anchors`). A thread whose words can't be found is listed as "Not placed", never hidden.
- In a live Markdown document comments are anchored in the room, as on the desktop: select text, tap the
  comment button above the keyboard. Those anchors carry their words too, so the reading screen places them.
- Either sheet replies, resolves, reopens and deletes through `/api/docs/:id/threads`. Viewers read and
  comment; owners and editors resolve. Someone whose share was removed is told "You no longer have
  access" on their next comment action, and the document comes off the screen.
- Text, Darkmown, Word, RTF and OpenDocument files have no comments, here or on the desktop.
- Comments are not kept on the phone. Offline, the document still opens from the phone's store and the
  comment sheet says comments need a connection. Nothing about comments is queued.
- Share (people icon on a document): send the link, invite by email, change a role (sharing again with
  the new role, as the desktop does), remove someone, through `/api/docs/:id/shares`. The owner also sees
  General access: a document is private until they tap "Make public", which creates the public link
  (`POST /api/docs/:id/public-link`); "Make private" turns it off. Nothing else creates one.
- New document (+ on Recent): the desktop's centered chooser (`@/components/new-document-modal`) with
  every format it offers. Markdown, text, Darkmown, CSV, JSON, YAML and XML go to the Markdown and text
  store and reach the server on Create. Word, Rich Text and OpenDocument are made blank by the desktop's
  writers and saved to the document platform as files of their own format, then open to write in.
- Word, RTF and OpenDocument files from the document platform (`/api/document-platform`) are listed on
  Recent, drawn by the desktop's Word editor, and edited and saved as a new version of their own bytes
  through the desktop's `DocumentCloudClient`, sent over the app's own transport.
- Version history is not on the phone: the desktop's history panel is local (`electron/history.js`).
- Text being typed lives in memory until Save. Leaving the editor without saving drops it, as before.
- The mock server has no live rooms and no document platform. Use a local real server for those.

## Files on this phone

Local mode works with nobody signed in. From the sign-in screen ("Open a file from this phone") or the
New document chooser, a person opens a file or adds a folder from the device, reads it, edits it and
saves it back to the same file. Nothing about a local file is sent anywhere. Signed in, "Save a copy
to Markie Cloud" is a button they tap on purpose. Local files are never put in the phone's store of
cloud documents, and signing out does not touch them or the list of what was granted.

The pieces:

- `src/lib/local-files.ts`: what a file is and what may be written back. `src/lib/local-editing.ts`
  and `src/components/local-conflict-sheet.tsx`: the editor's save and the "this file changed" sheet.
  `src/screens/local*.tsx`: On this phone, a folder, a file, and how they stack (`local.tsx`).
- The native plugin `MarkieLocalFiles`: `ios/App/App/LocalFilesStore.swift` with
  `MarkieLocalFilesPlugin.swift`, and `android/.../LocalFilesPlugin.java`. It is local to this app,
  registered in `MarkieBridgeViewController.swift` and `MainActivity.java`, not an npm package.
- The page never names a path or a URI. It names a grant by id and, in a folder, an entry inside it.

What a grant is:

- iOS: a security-scoped bookmark of the URL the document picker (or "Open in Markie") handed over,
  kept in `Application Support/LocalFiles/grants.json` (excluded from backup). A folder's bookmark
  covers everything in it. Access is opened for one operation and always closed again.
- Android: a persisted Storage Access Framework permission (`takePersistableUriPermission`) on the
  document or tree URI, with its name in the app's private preferences. The app asks for no storage
  permission.
- Single files are remembered as recents, 50 at most, oldest out first. Folders are never evicted.
- A grant the system took back (data cleared, folder deleted, provider removed) is still listed, as
  "Markie can't reach this folder any more", with "Choose it again" and "Remove".

How a save stays safe:

- Only text is saved in place, in the encoding (UTF-8 with or without a mark, UTF-16) and line
  endings the file came in. A file that is not valid text is refused, never repaired. Word, RTF,
  OpenDocument and HTML open as a converted copy and are never written back over the original.
- Every save carries the SHA-256 of the bytes it started from. The native side reads the file again
  inside the write and compares. If another app or iCloud changed it, nothing is written and the
  sheet asks: Keep both (a second file beside it, in a folder), Keep mine, or Take the file's
  version. Nothing is merged.
- iOS: every read and write goes through `NSFileCoordinator`. The new bytes are written whole to a
  scratch file and swapped in with `replaceItemAt`, so the original is never cut short or half
  written. What is on disk is read back and compared before the save counts.
- Android: the new bytes are whole in memory before the file is opened, and it is opened `"rwt"`,
  which truncates (plain `"w"` leaves the end of the old text behind when the new text is shorter).
  The result is read back and compared. The Storage Access Framework has no atomic replace, so a
  phone that dies mid-write can leave a short file; the text is still on screen until the save is
  confirmed.
- A path inside a folder is checked on iOS to still be inside it after links are followed, and on
  Android the system refuses a document that is not under the granted tree.
- A failed save says so and leaves the text in the editor.

Not built: pictures beside a local Markdown file are not shown, a new file can't be started in a
folder from the app, and there is no iCloud Drive folder of Markie's own (the plan's
`NSUbiquitousContainers`), which needs an iCloud container on the App ID.

## Files from other apps

iOS lists Markie under "Open in" and the share sheet for Markdown, Darkmown, text, CSV, JSON, YAML, XML,
HTML, Word (.docx), RTF and ODT (`CFBundleDocumentTypes` in `ios/App/App/Info.plist`, the same claims and
ranks as the Mac app). Android takes the same kinds through an `ACTION_VIEW` filter. "Open a file from
your phone" on the New document screen does the same through the system file picker.

- In place where the system allows it. iOS: "Open in Markie" from Files hands over the file itself
  (`LSSupportsOpeningDocumentsInPlace`); `SceneDelegate.swift` keeps a bookmark for it before the
  page sees the URL. Android: when the sending app lends write access, the file is edited where it
  is, for good if the permission can be kept and until the app closes otherwise. Such a file opens as
  a local file (above) and saves back to itself.
- Otherwise a copy, as before. iOS copies the file into the app's `Documents/Inbox` (Mail, AirDrop)
  and opens a `file://` URL; Android sends a read-only `content://` URI. The page reads either
  through `Capacitor.convertFileSrc` (`src/lib/incoming-file.ts`). Copies older than a day are
  removed at launch (`AppDelegate.swift`).
- Text arrives as it is. Word becomes Markdown; RTF, ODT and HTML become plain text with the desktop's
  importers. The original file is never changed.
- A copy shows first, with Save (to Markie Cloud) and Edit. Signed out, a copy opens to read at once
  and waits in memory to be saved after sign-in.

Try it on a simulator: copy a file into the app's data container under `Documents/Inbox`, then
`xcrun simctl openurl booted "file://<container>/Documents/Inbox/<name>"`.

## Export

The share sheet on a document has an Export group (`src/lib/export.ts`, `ExportSection` in
`src/components/share-sheet.tsx`). Each row makes a real file and hands it to the system share sheet, so
it can be saved to Files, AirDropped or mailed. A signed-out reader of a public link gets the same rows.

| Document | Copy of the file | HTML | PDF |
| --- | --- | --- | --- |
| Markdown, text and data files | Its own text, under its own name | The desktop's export page, pictures folded in | Light and dark |
| Live Doc (`.wd`) | Its source | A still copy: the controls are there and don't run | A still copy, light and dark |
| Word, RTF, OpenDocument | The original bytes | Not offered | Only when the desktop's print view supports the file, on its own page setup |
| Old Word (`.doc`) | The original bytes | Not offered | Not offered |

- HTML and PDF are built by the desktop's exporters through the `@` alias: `@/lib/markdown-html` and
  `@/lib/pdf-styles` for Markdown and text, `@/lib/darkmown/preview` (not trusted, so scriptless) for a
  Live Doc, `@/lib/office/docx-print` for Word. Nothing renders a second way.
- A document's own pictures are fetched from its asset route and folded into the page as `data:` URIs.
  One the phone can't fetch becomes a line naming it. A picture on the web keeps its address.
- PDF is printed off screen by the app's own plugin, `MarkiePdf`, with each platform's web view printing:
  `ios/App/App/MarkiePdfPlugin.swift` (a `WKWebView` behind the window, `UIPrintPageRenderer`) and
  `android/app/src/main/java/com/zvn/markie/mobile/MarkiePdfPlugin.java` (a `WebView` that is never
  attached, `createPrintDocumentAdapter`; `android/print/MarkiePdfWriter.java` exists only because the
  adapter's callbacks can be made only from that package). Android prints the desktop's page as it is.
  iOS keeps the same inset as real margins and paints the paper itself (`printJobFor`).
- Files are written to `shared/` in the app's cache, the one folder the Android FileProvider may hand
  out, and never backed up. A file is removed when the share sheet is done with it (on Android, five
  minutes after a successful share, since the chosen app may still be reading it), and the whole folder
  is cleared at every launch (`sweepShareFiles`).
- In the desktop browser the file and HTML rows download, and PDF opens the page in a print window.

## Links and pictures inside a document

- Markie document links open in the app. Other web links open in the device's default browser, not an
  in-app browser sheet (DESIGN.md: "Ordinary HTTP(S) links use the device's default browser").
- A picture the author's Markie synced (`![](shots/a.png)`) is fetched from the document's asset route
  with the session token, kept in the phone's store with its document (never in an HTTP cache), and
  shown as a `blob:` URL. A public share's pictures come from
  the share's own asset route. Video and audio beside the document are not fetched on a phone.

## Push notifications

The app is told when somebody comments on a document: `src/lib/push.ts` on the phone,
`server/src/devices.ts` and `server/src/push.ts` on the server. What is sent, the server's
settings, and where each secret comes from are in `docs/mobile/PUSH.md`.

- Permission is asked once, after a first comment, reply or share, never at launch. Settings has
  the switch after that.
- A tapped notification's link goes through the same entry point as any other link (`openPushLink`
  in `src/app.tsx`), and carries the thread as `?thread=<id>`.
- Push is off until the server has its keys. The Android app builds and runs with no
  `android/app/google-services.json`, and never calls Firebase without it
  (`PushAvailabilityPlugin.java`).
- In a desktop browser every push call does nothing.

## Ship checklist (owner)

Each step needs a person with the account. Current status, and what is still left, is in
`docs/mobile/STORE-SETUP.md`.

Signing and identity:

1. In the Apple Developer account for team `3VU8SG5TD9`, register the App ID `com.zvn.markie.mobile`
   with the Associated Domains and Push Notifications capabilities. The build carries the
   `aps-environment` entitlement, so signing fails without the second one.
2. In Xcode, open `ios/App/App.xcodeproj`, choose the team, and let Xcode manage signing.
   Set the version and build number.
3. Create an Android upload keystore and keep it out of the repo. Configure release signing
   in `android/app/build.gradle` through local properties or environment variables, never committed values.
4. Enroll the app in Play App Signing. Note both the upload key and the app signing key SHA-256 fingerprints.

Link association:

5. Set `ANDROID_APP_CERT_SHA256` on the server to the Play app signing fingerprint
   (and the upload key's, comma-separated, for testing sideloaded release builds).
   Today it holds the upload key's only, so a build installed from Play, which Google re-signs,
   still opens links in the browser. A debug build is signed with neither and never verifies:
   on an emulator, turn links on by hand with
   `adb shell pm set-app-links-user-selection --user cur --package com.zvn.markie.mobile true all`.
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
    If the person turns notifications on, the server also keeps the phone's push token until they
    sign out or turn them off. It also keeps the documents the person opens on the device, for
    reading offline, until they sign out. It has no analytics and no tracking.
11. Screenshots for the listings can start from `screenshots/`, retaken on the required device sizes.
12. Upload to TestFlight and an internal Play track first. Test sign-in, a universal link,
    an app link and a Darkmown document on real phones before any public release.
