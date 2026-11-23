# Push notifications

The phone app is told when somebody comments on a document. This page says what is sent, how the
server is set up to send it, and what the app does with it.

Push is off until its secrets are set. A server with none of them boots and behaves exactly as
before: phones can still register, nothing is sent, and nothing is logged.

## What is sent, and to whom

One kind of notification: a new comment or a reply.

It goes to the same people as the comment email (`server/src/comments.ts` `notify`): the document's
owner and everyone who has written in that thread, if they can still read the document. It never
goes to the person who wrote the comment.

On top of that, a phone only counts while the session that registered it is alive. Signing out, a
password reset that ends every session, or removing the account removes the phone's row. An
expired session gets nothing.

## What a notification contains

A notification passes through Apple or Google on its way to the phone, so it carries as little as
it can.

| Field | Value |
|---|---|
| Title | `New comment` |
| Body | `<name> commented on a document.` |
| Link | `https://<server>/d/<document id>?thread=<thread id>` |

- The comment's text is never sent.
- The document's text is never sent.
- The document's name is sent only to a phone whose owner turned on **Show document names** in the
  app's Settings. The body then reads `<name> commented on "<document name>".`
- The commenter is named by display name. An account with no name shows as `Someone`. An email
  address is never sent.

Tapping the notification opens the link in the app. It takes the same road as any other Markie
link, so it obeys the same sign-in and server rules.

## Server settings

All by environment variable, read in `server/src/runtime-config.ts` `pushSettings`.

| Variable | What it is |
|---|---|
| `APNS_KEY` | The text of Apple's `.p8` key file. Literal `\n` escapes are accepted, so it fits one line |
| `APNS_KEY_ID` | The key's 10-character Key ID |
| `APNS_TEAM_ID` | The Apple Developer Team ID. For Markie: `3VU8SG5TD9` |
| `APNS_BUNDLE_ID` | The app's bundle ID: `com.zvn.markie.mobile` |
| `APNS_ENV` | Optional. `production` (the default) for TestFlight and App Store builds. `development` for a build run from Xcode |
| `FCM_SERVICE_ACCOUNT` | The Firebase service account JSON file, as it is or base64-encoded so it fits one line |

iOS is on when the first four are all set. Android is on when `FCM_SERVICE_ACCOUNT` is set. Each
platform is independent. Some of the `APNS_` values without the rest, or a key that cannot be
read, leaves that platform off with one warning in the log that names the variable and never its
value.

When either platform is on, the server logs one line at its first use: `push: on for iOS and
Android`.

### Where the Apple values come from

1. Sign in at <https://developer.apple.com/account> as the account holder for team `3VU8SG5TD9`.
2. Open **Certificates, Identifiers & Profiles**, then **Identifiers**, then
   `com.zvn.markie.mobile`. Tick **Push Notifications** and save.
3. Open **Keys** and press **+**. Name it `Markie push`. Tick **Apple Push Notifications service
   (APNs)**. Choose **Sandbox & Production** and continue.
4. Press **Download**. The `.p8` file can be downloaded once. Its text is `APNS_KEY`.
5. The **Key ID** shown on that page is `APNS_KEY_ID`.

This key is separate from the Sign in with Apple key (`APPLE_PRIVATE_KEY`).

### Where the Firebase value comes from

1. Sign in at <https://console.firebase.google.com> and press **Add project**. Name it `Markie`.
   Analytics is not needed.
2. In the project, press the Android icon to add an app. The package name is
   `com.zvn.markie.mobile`.
3. Download `google-services.json`. Put it at `apps/mobile/android/app/google-services.json`. It
   is not a secret. Commit it or keep it local: the Android build works with or without it.
4. Open **Project settings**, then **Service accounts**. Press **Generate new private key**. The
   downloaded JSON file is `FCM_SERVICE_ACCOUNT`.
5. Still in **Project settings**, open **Cloud Messaging** and check that **Firebase Cloud
   Messaging API (V1)** is enabled.

## What a deploy needs

- The server: the variables above, set where Markie Cloud's other secrets are set. The database
  change is one new table, `device_tokens`, made at boot. Nothing existing is altered.
- iOS: the build carries the `aps-environment` entitlement, so the provisioning profile must
  include Push Notifications (step 2 above). Xcode's automatic signing picks that up.
- Android: a build made with `google-services.json` in place. Without the file the app builds and
  runs, and never calls Firebase.

## Routes

Both need a session. An agent token is refused.

- `POST /api/me/devices` with `{ "platform": "ios" | "android", "token": "...", "showNames": false }`.
  Registers the phone, or refreshes it. A token another account registered moves to the caller.
  An account keeps its 10 most recently seen phones. Answers `{ "ok": true, "delivers": true }`,
  where `delivers` says whether this server is set up to send to that platform.
- `DELETE /api/me/devices/:token` forgets one of the caller's phones.

## In the app

`apps/mobile/src/lib/push.ts`.

- The permission question is never asked at launch. It is asked once, the first time the person
  writes a comment, replies, or shares a document. After that, **Settings**, **Notifications**
  turns it on or off.
- The token is sent to the server after sign-in, at each launch, and whenever it changes.
- Signing out removes the phone from the server before the session is ended.
- On Android the app asks its own small native plugin (`MarkiePush`) whether Firebase is
  configured, and never calls the push plugin's `register` when it is not.
- In a desktop browser, or where push is unavailable, every call does nothing.
