# Sign in with Apple, and linking several Google and Apple accounts

Date: 2026-11-19. Branch `feat/apple-sign-in`.

## Where Markie stands

| Piece | Today |
|---|---|
| Google sign-in | Yes, on desktop (`/auth/google-start`) and the web sign-in page (`server/src/web-signin.ts`) |
| Linked sign-ins | Live in production (`MARKIE_ACCOUNT_IDENTITIES=1`). Settings, Manage linked sign-ins |
| Extra verified emails | Yes, several per account |
| Several Google accounts on one Markie account | Yes. Listed as "Google sign-in 1", "Google sign-in 2" with no address shown |
| Apple sign-in | No |
| Phone app | Email code only, no Google or Apple |

## Goal

1. Anyone can sign in with Apple on the desktop and on the web, the same way Google works.
2. Anyone can link one or more Apple IDs to their Markie account, next to their Google accounts.
3. The linked list shows which Google or Apple account each entry is, so several of one kind can be told apart.

## Done when

- A new person can make a Markie account with Sign in with Apple from the desktop app and from markiedocs.com.
- An existing person can link an Apple ID in Settings, sign out, and sign back in with it to the same account.
- Two Apple IDs and two Google accounts can sit on one account, each with its own address in the list, and each can be unlinked.
- An Apple sign-in whose email matches an existing account is refused with the same "link it instead" guidance Google gets. No accounts merge.
- A "Hide My Email" relay address receives Markie's sign-in codes and share invites.
- With no Apple keys configured, nothing about Apple shows anywhere, so the server and app can ship before the keys exist.

## Design

### Server

- `socialProviders.apple` in `server/src/auth.ts`, on only when `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` are all set.
- Apple's client secret is a JWT signed with our `.p8` key. Apple caps it at 6 months. The server signs a fresh one at boot and again before it ages out, so nobody has to rotate it by hand.
- Apple posts its callback from `https://appleid.apple.com`. It goes into the trusted origins. better-auth already turns that POST into a GET so the Lax cookies arrive.
- Callback: `https://api.markiedocs.com/api/auth/callback/apple`.
- `/auth/apple-start` for the desktop, beside `/auth/google-start`. Same state nonce and `markie://auth` bridge. Old builds keep using `google-start`, untouched.
- "Continue with Apple" on the web sign-in page.
- `/api/account/capabilities` adds `appleLinking`, and the identity listing adds `appleAvailable`.

### Linking

- `server/src/google-identity-links.ts` becomes one provider-generic module for `google` and `apple`. Same step-up code to the primary email, same one-use intent, same write fence, same "unlinking signs out every session" rule.
- The Google routes keep their paths and behavior. Apple gets the same routes under its own name.
- When a Google or Apple account is linked or used to sign up, its address is recorded beside the provider row, read from the provider's ID token. The list then shows `Google: kirby@zvndev.com` instead of `Google sign-in 1`. Rows linked before this show the old label.
- An Apple ID's relay address is shown as Apple gives it.

### Desktop app

- "Continue with Apple" under "Continue with Google" in the sign-in screen and the server settings, shown only when the server advertises Apple.
- Settings, Manage linked sign-ins: "Link Apple sign-in" beside "Link Google sign-in", Apple rows with Unlink, and the address on every provider row.

### Not in this round

- The phone app. Sign in with Apple and Google on iOS and Android need native sign-in flows and a store build. Once the iOS app offers Google, the App Store also requires a privacy-focused sign-in such as Apple's, so Apple comes first anyway.
- Managing linked sign-ins on the web app. It has no settings page today.
- Apple's server-to-server notifications. Nothing needs them until the iOS app offers Apple sign-in.

## Steps

| # | Step | Who | Waits on |
|---|---|---|---|
| 1 | Server: Apple provider, secret signing, trusted origin, `/auth/apple-start`, web button, capabilities | Agent | Nothing |
| 2 | Server: provider-generic linking, recorded addresses | Agent | 1 |
| 3 | Desktop: Apple buttons, linked sign-ins panel | Agent | 2 |
| 4 | Independent review, fixes, PR, CI | Agent, then me | 3 |
| 5 | Apple Developer setup in Arc | Me, driving Arc | Kirby's go-ahead |
| 6 | Keys into Keychain, zvn-infra env, deploy markie-api to box B, live test | Me | 5, Kirby's deploy OK |
| 7 | Desktop release with the Apple buttons | Me | 6, Kirby's "release it" |

## Browser work (step 5)

All in the Apple Developer account, team `3VU8SG5TD9`:

1. Create a Services ID, for example `com.zvn.markie.signin`, with Sign in with Apple on.
2. Point it at domain `api.markiedocs.com` and return URL `https://api.markiedocs.com/api/auth/callback/apple`.
3. Create a key with Sign in with Apple on, tied to the Markie app ID. Download the `.p8` once, note its Key ID.
4. In Sign in with Apple for Email Communication, register `markiedocs.com` and `support@markiedocs.com`, so relay addresses get our mail.

Google needs no changes: linking uses the existing Google client and callback.

## Secrets

- `.p8` into Keychain `markie-api-own-boxes`, account `APPLE_PRIVATE_KEY`, then the download is deleted.
- `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` are not secret and go in `deploy.yml`.
- `APPLE_PRIVATE_KEY` goes in `.kamal/secrets`, read from Keychain like `GOOGLE_CLIENT_SECRET`.

## Deploy note

markie-api failed over to box B on 2026-11-14 at 03:52 UTC and came back to box A at 04:23 UTC. Before deploying, read `/srv/apps/markie-api/writer` on both boxes and deploy to the one marked `writer`.
