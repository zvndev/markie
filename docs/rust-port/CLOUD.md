# Markie RS: the Markie Cloud client

Date: 2026-11-21, sign-in UI added 2026-11-22. Circular task ENG-8733. Crate: `rust/crates/markie-cloud`. App: `rust/crates/markie-app/src/workspace/account.rs`.

The crate talks to Markie Cloud and self-hosted servers through the same API as the Electron app, web and phone. It has no UI and no GPUI dependency. The app module on top of it signs Kirby in and shows his account and Cloud documents.

## Sign in to Markie Cloud in Markie RS

Markie RS keeps its own session. It never reads, copies or changes the Electron app's sign-in.

| Piece | Where | Matches Electron |
|---|---|---|
| Account sheet | `account.rs`: `AccountSheet`, opened by `Workspace::open_account` from the rail's account button, Markie RS › Sign In…, and the palette's "Sign In…" | Settings opened on its Account tab: same 680 pt panel, header, tabs and spacing |
| Sign-in form | `SignInForm` | `sign-in.tsx`: Google, Apple (when the server offers it), email code, password, create account, address proof after sign-up, forgot password, every label and error sentence. Polish pass (2026-11-22): Markie RS's own note, "Google and Apple sign-in in Markie RS wait for a Markie Cloud update…", wraps inside the panel with its switch on the line under it, where it ran past the edge (`.autoloop/runs/polish/rs-signin-*.png`). The code field takes the caret when the code view opens, after "Email me a code" or an address proof. Electron's `sign-in.tsx` sets no autofocus there, so this is a small polish. It was not driven live, because sending a code emails a real address. |
| Error wording | `markie-cloud/src/auth_errors.rs` | `auth-errors.ts`, word for word |
| Signed-in account | `AccountSection` | Settings › Account: name, email, Sign out, the sync row (shown switched off), Accepted people and Manage linked sign-ins, both read only |
| Rail account button | `rail.rs` asks `account.rs` | Initials on the account colour with a green dot when signed in; "Sign in" otherwise |
| Cloud page | `CloudPanel`, shown by the rail's Cloud destination and View › Cloud | `library.tsx` cloud workspace header ("Connected" or "Sign in"), filter, band and one row per document. A row opens the document read only. No sync |
| Session | Keychain, service "Markie RS", one item per server | Restored at launch through `/api/me`; Sign out ends the server session and deletes the item |
| Google and Apple hand-back | `markie-rs://auth`, registered in `scripts/bundle-mac.sh` and again at each launch by `open_urls::register_url_scheme` | Same nonce and issuer checks as `auth-state.ts`. The start URL adds `app=markie-rs` |

`AccountSection` is its own entity, so Settings can host it in its Account tab instead of opening the sheet.

### Google and Apple wait for the server deploy

Markie Cloud answers `app=markie-rs` with a `markie-rs://` link only after zvndev/markie#136 is deployed. It is merged, not deployed. Until then production answers `markie://`, which the Electron app owns, so:

- Markie RS refuses every `markie://` link and never registers that scheme.
- Google and Apple are off by default. The sheet shows them greyed with one line: "Google and Apple sign-in in Markie RS wait for a Markie Cloud update. Use an email code for now." Under it, "Server updated? Turn them on" saves the setting `cloud_browser_sign_in = on`.
- No public route shows the change without signing in, so `crates/markie-cloud/scripts/probe-hand-back.sh` reads the deployed commit from `/health` and checks it for the change in git. On 2026-11-22 it said "not yet" (commit `bccfb617b3d6`).

### Kirby's steps: email

1. After the parent merges this branch, build in the main worktree: `cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/markie-rs/rust && ./scripts/bundle-mac.sh`.
2. Open `target/release/Markie RS.app` from Finder.
3. Click the account button at the bottom of the rail, or choose Markie RS › Sign In….
4. Type your email and click "Email me a code". Enter the 6-digit code from the email and click Verify. With a password, use "Use a password instead" and Sign in.
5. macOS asks once whether markie-rs may use the "Markie RS" Keychain item. Choose Always Allow. It asks again after each rebuild, because the build is signed ad hoc.

Signed in, the sheet shows your name and email, the rail shows your initials with a green dot, and Cloud shows "Connected" with your documents. Click one to read it. Quit and reopen: you stay signed in.

### Kirby's steps: Google and Apple, after the deploy

1. Run `git fetch origin && rust/crates/markie-cloud/scripts/probe-hand-back.sh` from the main worktree. Go on when it prints "live".
2. Keep your Markie RS open. Quit any Markie RS an agent is running, so macOS hands the link to yours.
3. Open the account sheet and click "Server updated? Turn them on".
4. Click Continue with Google or Continue with Apple and finish in the browser. The page says "Returning you to Markie RS…", and Markie RS comes to the front signed in.

If the page says "Returning you to Markie…" instead, the server is not updated yet. Electron Markie may come to the front and ignore the link, because it started no sign-in. Its own session is untouched.

### Verified in the app, against the local server

Run with `MARKIE_RS_CLOUD_SERVER=http://localhost:18787` (localhost only), which also switches the Keychain service to "Markie RS Test". The server was the PR #136 server from `scripts/local-server.sh` with console mail, and every address was on the SES mailbox simulator.

1. Create account, address proof by the emailed code, signed in. A second code went out, as in Electron.
2. Session in the Keychain under "Markie RS Test", restored after quitting and relaunching.
3. Manage linked sign-ins shows Electron's "This server does not support linked sign-ins" line, since a local server has none.
4. Cloud lists the account's two documents. One opens read only.
5. Sign out: the server's session count for the account went from 2 to 1 (the other was the test's own curl session), and the Keychain item was deleted.
6. Google hand-back: the app minted the start URL with `app=markie-rs`. The bridge, called with the account's session, answered "Returning you to Markie RS…" and a `markie-rs://auth` link. `open` on that link reached the running copy through Launch Services. It came to the front, closed the sheet and signed in.
7. A forged `markie-rs://auth` link with a wrong nonce was refused and logged. The session stayed.
8. Dark and light, side by side with Electron 0.9.7 on a scratch profile.

Evidence, in `.autoloop/runs/cloud-sign-in/` (gitignored). Library lists are blurred:

- `side-by-side-account-signed-out-dark.png`, `side-by-side-account-signed-out-light.png`, `side-by-side-account-password-dark.png`, `side-by-side-cloud-signed-out-dark.png`
- `rs-signup-filled-dark.png`, `rs-signup-prove-address-dark.png`, `rs-account-signed-in-dark.png`, `rs-account-signed-in-light.png`, `rs-account-linked-sign-ins-dark.png`, `rs-account-restored-after-relaunch-dark.png`
- `rs-cloud-signed-in-dark.png`, `rs-cloud-signed-in-light.png`, `rs-cloud-doc-read-only-dark.png`, `rs-account-browser-enabled-dark.png`, `rs-hand-back-signed-in-dark.png`, `rs-forged-link-ignored-dark.png`
- Electron references: `electron-account-signed-out-dark.png`, `electron-account-signed-out-light.png`, `electron-account-password-dark.png`, `electron-cloud-signed-out-dark.png`

### Still different from Electron

- The backdrop under the sheet is dimmed but not blurred: GPUI has no backdrop blur, so the dim is 72% instead of Chromium's 58% with a blur. (Was: no backdrop. Fixed in [INTEGRATION-CLOUD.md](INTEGRATION-CLOUD.md).)
- The Cloud page now has the area picker, type and order menus, source chips, share requests and the snapshots section (INTEGRATION-CLOUD.md). Creating a new cloud area from the picker is not built.
- Linking and unlinking sign-ins, removing, blocking and unblocking people, and the sync switch are built (INTEGRATION-CLOUD.md). Linking was proven against a mock server only; a local server has no linked sign-ins.
- Scratch runs (`MARKIE_RS_DATA_DIR`) keep the session in memory, shared by every part of the app; only a real run uses the Keychain. A scratch session does not survive a relaunch.
- Production's verified-identity code flow is covered by mock tests only. The local server offers the legacy code route.
- Reset password works in the crate's end-to-end test; the form was not driven through it on screen.
- A browser sign-in does not survive quitting Markie RS before it comes back. The nonce is in memory.
- With several Markie RS builds on one Mac, macOS hands `markie-rs://` to the copy that launched last.

The later desktop file-sync and byte-snapshot work is tracked in [CLOUD-SYNC.md](CLOUD-SYNC.md).

## What is done

| Module | What it does | Ported from |
|---|---|---|
| `origin` | Origin pinning, Cloud aliases, loopback rules, the typed-address check, share base and untrusted-origin rules. | `electron/share-origin.js`, `servers.js` |
| `registry` | The trusted server list: probe, confirm, add, remove, persist, the reserved-name check, Cloud's Apple flag refresh. | `electron/servers.js` |
| `http` | The one place requests leave: no redirects, timeouts, response size caps, the API path check. | `electron/server-request.js` |
| `tokens` | One session per origin behind a `TokenStore` trait. `KeyringTokenStore` for the app, `MemoryTokenStore` for tests. | `src/lib/server-sessions.ts` |
| `client` | `CloudClient`, bound to one origin. It sends only that origin's token, only while the origin is trusted, and takes a rotated `set-auth-token`. | `server-request.js`, `auth-client.ts` |
| `auth` | Email and password sign-in and sign-up, email codes (verified identities and the legacy route), verify email, password reset, sign-out, `/api/me`, the Google and Apple start URLs, the single-use nonce and the deep link issuer check. | `src/lib/auth-client.ts`, `auth-state.ts` |
| `docs` | Documents, links and asset REST calls. | `electron/sync.js`, `asset-sync.js` |
| `sync` | The state machine (`local-only`, `synced`, `unpushed`, `conflict`, `paused`), base versions, 409 handling, keep both, take cloud, overwrite, landing names, listing fingerprints, role and exposure knowledge. Pure rules first, then `SyncEngine` on top. | `electron/sync.js` |
| `sharing` | Access, members, invites, public links, Live Doc address, people and share requests, collab tickets. | `makeSharesClient`, `makePeopleClient` |
| `comments` | Thread list, create, reply, resolve, delete. The anchor is passed through unchanged. | `src/lib/comments.ts` |
| `collab` | Live text rooms with `yrs`: ticket policy, the text binding with UTF-16 indices, seeding with the text-room stamp, presence, the snapshot writer election, the `storedCopy` record, the live 409 rules, close codes 4403 and 4426. | `collab.ts`, `text-collab.ts`, `live-snapshot.ts`, `text-collab-editor.tsx` |

Tests: 62 unit tests, 11 HTTP tests against `wiremock`, and 1 end-to-end test against the real server. `cargo test -p markie-cloud` runs them all. The end-to-end test does nothing unless the script below starts a server for it.

Byte-level agreement with the JS is checked where it matters. The text fingerprint and peer colours match reference values computed with the TypeScript functions. Room numbers are written as Yjs integers, so `typeof version === "number"` still holds in the browser.

## Verified against the local server

`rust/crates/markie-cloud/scripts/local-server.sh` boots `server/` on localhost with a scratch database. Mail is in console mode, so every code is written to the server log and nothing is sent. All addresses are on the SES mailbox simulator. The test refuses any server that is not this computer.

It passed three runs in a row. Each run checks these steps:

1. The server is probed and added like a self-hosted server.
2. Two accounts sign up. An unproven address cannot sign in. The emailed code proves it and signs in.
3. Password sign-in works on a second device. `/api/me` confirms the account.
4. Code sign-in works through the legacy route, which is what a server without verified identities offers.
5. The desktop bridge, asked with `app=markie-rs`, returns a `markie-rs://auth` link with our nonce and the server as issuer. The issuer check accepts it, and the token signs in as the right person. Against a server without PR #136 it returns `markie://auth`, which the resolver refuses; the test checks both.
6. Sign-out ends the session at the server, not just locally.
7. Sync creates a document at version 1 and pushes version 2. A stale second device gets a 409 and turns `conflict`. Keep both returns the cloud text and the right copy name.
8. Sync off with delete leaves the row local-only, and the cloud copy answers 404.
9. Sharing to someone who has not accepted the sender becomes a request. Accepting it lists the document as shared, with editor access.
10. Members, shared by me, contacts, and a public link create, read and revoke.
11. Comments open, reply, resolve and delete.
12. A live text room: the first editor seeds the empty room. Edits travel both ways. Presence carries the server-stamped name. Exactly one client is elected snapshot writer, and its write lands as version 3.
13. Removing the collaborator closes their socket with 4403, and the room stops taking edits.

## Verified only with mocks

- The verified-identity code flow. A local server only offers it with real mail delivery, which this task must not use.
- Redirects not followed, the 2 MB answer cap, and token rotation through `set-auth-token`.
- A token never sent to another origin, and a removed server refused before the network.
- The legacy collab-ticket answer and the "this server issues tickets" memory.

## Choices that differ from Electron

- No `?token=` collab fallback. It puts the session token in a URL that proxies log. A server too old for tickets gets no live editing from Markie RS.
- The pending sign-in nonce is held in memory. A browser sign-in does not survive an app relaunch.
- Keychain entries are under the service name the app passes in, for example "Markie RS". The Rust build never reads the Electron app's sign-in.
- The session stored per origin is the token plus the confirmed account, in one Keychain entry.

## What remains for Phase 3

| Work | Notes |
|---|---|
| Google and Apple live | `markie-rs://` is built and tested locally. Turn it on after the PR #136 deploy (steps above). |
| UI wiring | Done: sign-in sheet, account, Cloud list and read-only open. Left: Settings > Servers, share dialog, people requests, comments panel, presence avatars, view-only banner. |
| Registry integration | Done in CLOUD-SYNC.md: sync records in the registry, push after save, background checks, conflict strip, cloud documents land in `~/Documents/Markie RS/Cloud`. |
| Assets and links | Port `asset-sync.js`, `asset-cache.js` and `link-sync.js` on top of the `docs` calls. |
| Room supervisor | Reconnect with backoff and refresh the ticket in place every 2 minutes, using the rules in `collab/ticket.rs`. |
| Rich rooms | XmlFragment rooms and comment anchors (Y.RelativePosition). Waits on the Phase 2a spike. |
| Real sign-in tests | Kirby's email sign-in on production, then Google and Apple after the deploy. The Keychain round trip passed with a marked test item. |
| Token migration | Moving existing tokens out of Chromium localStorage belongs to Phase 6. |

## Estimate

Agentic wall-clock time, with agents in parallel:

| Phase | Time | Serial limit |
|---|---|---|
| Deep link decision and its server change | Half a day after Kirby decides | Kirby's call, then a Markie Cloud deploy he approves |
| Registry integration, assets and links, room supervisor | 2 to 3 days | Runs in parallel with UI wiring |
| UI wiring | 3 to 4 days | GPUI screens share one app shell, so they merge one at a time |
| Real-account checks | Half a day | Kirby's Google, Apple and Keychain prompts |
| Rich rooms and anchors | Part of Phase 2b | The rich editor spike outcome |

Phase 3 without rich rooms: about 4 to 6 days.

## How to run it

```sh
cd rust
cargo test -p markie-cloud                            # unit and mock tests
cargo test -p markie-cloud -- --ignored keychain      # Keychain round trip, marked test item, deleted after
(cd ../server && npm ci)                              # once
crates/markie-cloud/scripts/local-server.sh           # end to end on localhost
MARKIE_SERVER_DIR=<other server/> crates/markie-cloud/scripts/local-server.sh   # against another server checkout
crates/markie-cloud/scripts/probe-hand-back.sh        # is markie-rs:// live on Markie Cloud?
```
