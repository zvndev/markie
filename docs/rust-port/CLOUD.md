# Markie RS: the Markie Cloud client

Date: 2026-11-21. Circular task ENG-8733. Crate: `rust/crates/markie-cloud`.

The crate is the groundwork for Phase 3. It talks to Markie Cloud and self-hosted servers through the same API as the Electron app, web and phone. It has no UI and no GPUI dependency.

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

Tests: 54 unit tests, 11 HTTP tests against `wiremock`, and 1 end-to-end test against the real server. `cargo test -p markie-cloud` runs them all. The end-to-end test does nothing unless the script below starts a server for it.

Byte-level agreement with the JS is checked where it matters. The text fingerprint and peer colours match reference values computed with the TypeScript functions. Room numbers are written as Yjs integers, so `typeof version === "number"` still holds in the browser.

## Verified against the local server

`rust/crates/markie-cloud/scripts/local-server.sh` boots `server/` on localhost with a scratch database. Mail is in console mode, so every code is written to the server log and nothing is sent. All addresses are on the SES mailbox simulator. The test refuses any server that is not this computer.

It passed three runs in a row. Each run checks these steps:

1. The server is probed and added like a self-hosted server.
2. Two accounts sign up. An unproven address cannot sign in. The emailed code proves it and signs in.
3. Password sign-in works on a second device. `/api/me` confirms the account.
4. Code sign-in works through the legacy route, which is what a server without verified identities offers.
5. The desktop bridge returns a `markie://auth` link with our nonce and the server as issuer. The issuer check accepts it, and the token signs in as the right person.
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
| Deep link for Google and Apple | **Decision needed.** The server's bridge always returns `markie://auth`, and Markie RS does not claim `markie://` (PLAN.md ground rules). Options: a `markie-rs://` scheme plus a small server change, or a loopback redirect. |
| UI wiring | Sign-in sheet, Settings > Servers, Library cloud states, conflict strip and dialog, share dialog, people requests, comments panel, presence avatars, view-only banner. |
| Registry integration | Store `SyncRecord` fields in the markie-core registry. Push after save, background update checks, and landing cloud documents in `~/Documents/Markie/Cloud`. |
| Assets and links | Port `asset-sync.js`, `asset-cache.js` and `link-sync.js` on top of the `docs` calls. |
| Room supervisor | Reconnect with backoff and refresh the ticket in place every 2 minutes, using the rules in `collab/ticket.rs`. |
| Rich rooms | XmlFragment rooms and comment anchors (Y.RelativePosition). Waits on the Phase 2a spike. |
| Real sign-in tests | Google and Apple on real accounts need Kirby's sign-in. The Keychain store needs one manual check on his Mac. |
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
(cd ../server && npm ci)                              # once
crates/markie-cloud/scripts/local-server.sh           # end to end on localhost
```
