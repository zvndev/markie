# Agent links to phone: integration end-to-end report

Date: 2026-10-25. Branch: `feat/mobile-agent-links` at `83d290e` (all four workstreams plus `main`).
Contract: `docs/mobile/AGENT-LINKS-CONTRACT.md`.

Result: the owner's flow works end to end against the real server code. An agent holding only a token
made two documents through the hosted MCP and got a paste-ready link for each. The phone apps on iOS
and Android listed them under Recent with "from Claude on claude.ai". The links opened them in the
app, the markdown rendered, and the Darkmown document ran after trusting it. Every security spot check
passed.

Nothing here touched production. The server ran locally on a throwaway database. No deploy, no store
upload, no production data or secrets.

## Setup

| Item | Value |
| --- | --- |
| Server | `server/src/index.ts` from this branch, `NODE_ENV=development` |
| Port and origin | `8791`, `BETTER_AUTH_URL=http://localhost:8791` |
| Database | `DB_PATH=/tmp/markie-e2e/markie.db`, migrated with `server/src/migrate.ts` |
| Assets | `ASSETS_DIR=/tmp/markie-e2e/assets` |
| Email | Console mode (`server/src/email.ts`): no `RESEND_API_KEY`, so codes and notices print to the server log |
| iOS | Xcode 26.6, iOS 26.5 Simulator, iPhone 17 Pro, Debug build of `apps/mobile` (`npm run build:dev`, `cap sync`) |
| Android | Emulator `Medium_Phone_API_36.0`, Debug APK built with JDK 21 |
| Driving | `curl` for the API, JSON-RPC over HTTP for `/mcp`, Maestro for taps, `simctl` and `adb` for links and screenshots |

## Test suites after merging `main`

`origin/main` (#28 and #29) merged with no conflicts.

| Suite | Result |
| --- | --- |
| Root `npm test` | 313 files passed, 1 skipped. 5039 tests passed, 1 skipped. No flaky reruns needed |
| Root `npm run lint` | Clean |
| Root `npm run typecheck` | Clean |
| `node --test mcp/lib.test.mjs` | 105 passed |
| `server` `npm test` | 587 passed, 1 skipped, 0 failed |
| `apps/mobile` `npm test` | 9 files, 112 tests passed |
| `apps/mobile` `npm run typecheck` | Clean |

## Steps and results

### a. Sign up and sign in by email code: pass

The app's two calls were made directly:

1. `POST /api/auth/email-otp/send-verification-otp {email, type: "sign-in"}` returned 200.
2. The code was read from the server log.
3. `POST /api/auth/sign-in/email-otp {email, otp}` returned 200 with a `set-auth-token` header.

The account was created by that sign-in, with `emailVerified: true`.

### b. Mint an agent token through the Remote agents panel's API: pass

`POST /api/agent-tokens {"name": "Claude on claude.ai"}` with the session bearer returned 201. That is
the call `src/lib/agent-tokens.ts` makes for the desktop panel.

| Field | Value |
| --- | --- |
| prefix | `mk_agent_QwJ` |
| token length | 52 characters (`mk_agent_` plus 43 base64url characters) |

The captured notice email is in `evidence/mint-email.txt`.

- It names the token by prefix (`mk_agent_QwJ`) and creation time. Pass.
- The token's name appears nowhere in it. Pass.
- The full token appears nowhere in it. Pass.
- It contains the fixed line "Markie never creates agent tokens on its own...". It is not the last
  line: a paragraph on how to revoke follows it. See Gaps.

### c. Remote agent over the hosted MCP: pass

Acting with only the agent token against `http://localhost:8791/mcp`, protocol `2025-06-18`:

| Call | Result |
| --- | --- |
| No `Authorization` header | 401 with `WWW-Authenticate: Bearer realm="markie"` |
| `GET /mcp` | 405 |
| `initialize` | `protocolVersion 2025-06-18`, server `markie-cloud`, with instructions to paste `markdownLink` |
| `notifications/initialized` | 202 |
| `tools/list` | `markie_create_document`, `markie_update_document`, `markie_list_my_documents`, `markie_read_my_document`, `markie_guide` |
| `markie_guide` | 22,210 characters, the same guide as the local MCP |
| `markie_create_document` `Checkout options.md` | Created. Table, task list, note, highlighted code, a data URI picture and math, all from the guide's examples (`evidence/doc-rich.md`) |
| `markie_create_document` `Order total.wd` | Created. The guide's "Order total" Darkmown example, unchanged (`evidence/doc-order.wd`) |

Each create result has `privateLink` and `markdownLink`, in `structuredContent` and in the text, followed
by "Paste markdownLink into your reply. It opens in Markie on the user's phone, or in a browser after
they sign in."

### d. Recent feed: pass

`GET /api/docs/recent` with the session listed both, newest first, each with
`"origin": {"kind": "agent", "agent": "Claude on claude.ai"}`, the right `format` (`markdown`,
`darkmown`) and `privateLink` (`evidence/recent.json`).

### e. iOS Simulator: pass

- Signed in through the app with the server set under Advanced to `http://localhost:8791`.
- Recent showed both documents with "from Claude on claude.ai".
- `xcrun simctl openurl <sim> markie-mobile://d/<md id>` opened the document. The first time, iOS asks
  "Open in Markie?", which is the system's prompt for a custom scheme.
- The `.md` rendered fully: table with alignment, checkboxes, the note, highlighted code, the data URI
  picture and KaTeX math.
- The `.wd` opened behind "Trust this document". The static preview showed 14.03. After trusting,
  choosing 24.5 updated the total live to 26.46, which is correct (24.5 × 1.08).
- The http form, `xcrun simctl openurl <sim> http://localhost:8791/d/<id>`, opens Safari, not the app.
  That is expected: universal links need https and the association file on a real domain. Safari showed
  the server's web fallback page ("You need access to this document", Sign in, Get Markie).
- To test the app's own routing of an http link, the agent made a third document, `Links from chat.md`,
  containing the `.wd`'s `markdownLink` exactly as returned. Tapping it inside the app opened
  `Order total` in the app.

### f. Android emulator: pass

- Signed in with the server set to `http://10.0.2.2:8791`. The dev build accepted it.
- Recent showed all the agent documents with badges.
- `adb shell am start -a android.intent.action.VIEW -d markie-mobile://d/<id>` opened the `.md` and the
  `.wd`.
- The `.md` rendered as on iOS. The `.wd` ran after trusting it: 24.5 gave 26.46.
- `am start -d http://10.0.2.2:8791/d/<id>` opened Chrome, as expected for a host with no verified app
  link.
- A pasted link naming `localhost:8791` opened Chrome from inside the app. That is a local artefact: the
  emulator reaches the host as `10.0.2.2`, so the link names a different server from the one it signed
  in to. In production both are `api.markiedocs.com`.
- With the same link written for `10.0.2.2:8791`, tapping it inside the app opened `Order total` in the
  app. The app's routing works.

### g. Security spot checks: pass

Shared document closed to the token (`evidence/security-share.txt`):

| Check | Result |
| --- | --- |
| Token reads its own document before sharing | 200 |
| Owner shares it with `friend@e2e.test` as viewer | 200, invited |
| Token `GET /api/agent/docs/<id>` after sharing | 404 `{"error":"not found"}`, identical to a random id |
| Token `PUT` after sharing | 409 `shared`, with "Create a new document instead" |
| MCP `markie_read_my_document` | Error, "no such document among the ones this agent token created" |
| MCP `markie_list_my_documents` | The shared document is left out |
| Token on the session route `GET /api/docs/<id>` | 401 |
| Token minting a token | 403 |

Password reset by code (`evidence/security-reset.txt`):

| Check | Before | After |
| --- | --- | --- |
| `POST /api/auth/forget-password/email-otp`, then `/api/auth/email-otp/reset-password` | | 200 and 200 |
| Token `ping` on `/mcp` | 200 | 401 with `WWW-Authenticate` |
| Token `GET` of its own document | 200 | 401 |
| Session `GET /api/docs/recent` | 200 | 401 |
| Sessions in the database | 3 | 0 |
| Active agent tokens | 1 | 0 |

Both apps returned to Sign in cleanly when the next document was opened. Each showed "Your session
ended. Sign in again to continue." and "Sign in and the document you opened shows up right after."
On iOS, signing in again opened that document.

iOS cache: the app's `Library/Caches/com.zvn.markie.mobile/Cache.db` had 0 rows in
`cfurl_cache_response` and 0 in `cfurl_cache_receiver_data`. That held after browsing every document,
and again after the reset and the second sign-in. The session token, the agent token and the document
text appear nowhere in the app's data container.

### h. Desktop path, at the code level: pass

`markie_cloud_sync`'s description in `mcp/markie-mcp.mjs` covers `.wd`. It tells the agent to "paste
markdownLink into your reply exactly as returned".

`evidence/link-parity.mjs` loads the desktop's `markdownLinkFor` and `privateLinkFor` from
`electron/agent-cloud.js` (what `markie_cloud_sync` returns) and the server's from
`server/src/doc-meta.ts` (what `/mcp` returns). It compares their bytes (`evidence/link-parity.txt`).

- Both documents from step c: desktop output equals the live `/mcp` result, byte for byte.
- Names with brackets, angle brackets, backticks, backslashes, CR, LF, U+2028 and U+2029 runs,
  parentheses and emoji: identical.
- An id with parentheses: both give `%28` and `%29`.
- The desktop maps the legacy cloud origin to `https://api.markiedocs.com` (`electron/share-origin.js`),
  as the server does (`privateLinkOrigin`). Official links therefore agree too.

## The chat link an agent pastes

Format: `[<document name, escaped>](<server origin>/d/<document id>)`

On Markie Cloud:

```text
[Order total.wd](https://api.markiedocs.com/d/2e495e31-1e8e-4883-8ee7-5a18c7edcae5)
```

Exactly what this run's local server returned:

```text
[Checkout options.md](http://localhost:8791/d/b4bf4a9e-3dd4-4bb1-b3e6-1d1f46778744)
[Order total.wd](http://localhost:8791/d/2e495e31-1e8e-4883-8ee7-5a18c7edcae5)
```

The app's custom scheme form of the same link: `markie-mobile://d/<document id>`.

## Screenshots

iOS (`ios-*.png`):

| File | Shows |
| --- | --- |
| `ios-01-sign-in.png` | Sign in, first launch |
| `ios-02-advanced-server.png` | Advanced, server set to `http://localhost:8791` |
| `ios-03-code.png` | Code entry |
| `ios-04-recent.png` | Recent with both agent documents and badges |
| `ios-05-scheme-open-prompt.png` | iOS's "Open in Markie?" for `markie-mobile://` |
| `ios-06-md-rendered.png` | `Checkout options.md`: table, tasks, note |
| `ios-07-md-code-picture.png` | Same document: code, data URI picture, math |
| `ios-08-wd-before-trust.png` | `Order total.wd` before trust |
| `ios-09-wd-trusted.png` | Trusted |
| `ios-10-wd-running.png` | Running: 24.5 selected, total 26.46 |
| `ios-11-http-link-opens-safari.png` | http link from `simctl` opens Safari's fallback page |
| `ios-12-chat-link-in-doc.png` | Document holding the pasted `markdownLink` |
| `ios-13-chat-link-opened-in-app.png` | Tapping it opened `Order total` in the app |
| `ios-14-before-reset-recent.png` | Signed in, before the password reset |
| `ios-15-after-reset.png` | After the reset: back at Sign in, document pending |
| `ios-16-resignin-pending-doc-opens.png` | After signing in again, the pending document opened |

Android (`android-*.png`):

| File | Shows |
| --- | --- |
| `android-01-sign-in.png` | Sign in |
| `android-02-advanced-server.png` | Server set to `http://10.0.2.2:8791` |
| `android-03-code.png` | Code entry |
| `android-04-recent.png` | Recent with agent badges |
| `android-05-md-rendered.png` | `Checkout options.md` |
| `android-06-md-code-picture.png` | Code, picture, math |
| `android-07-wd-before-trust.png` | `Order total.wd` before trust |
| `android-08-wd-trusted.png` | Trusted |
| `android-09-wd-running.png` | Running: total 26.46 |
| `android-10-http-link-intent.png` | http intent opens Chrome |
| `android-11-chat-link-in-doc.png` | Document holding the `localhost` link |
| `android-12-chat-link-localhost-goes-to-chrome.png` | That link goes to Chrome, the local artefact above |
| `android-13-emulator-host-link-in-doc.png` | The same link written for `10.0.2.2` |
| `android-14-emulator-host-link-opened-in-app.png` | Tapping it opened `Order total` in the app |
| `android-15-before-reset-recent.png` | Before the reset |
| `android-16-after-reset.png` | After the reset: back at Sign in |

## Gaps

Not testable locally:

- Universal links (iOS) and verified app links (Android). Both need https and the association files
  served on `api.markiedocs.com` and `markiedocs.com`. The server's association routes pass their unit
  tests. On a device the owner should check with a long-press in Notes or `swcutil`, and with
  `adb shell pm get-app-links com.zvn.markie.mobile`.
- The desktop and local MCP path ran at the code level only. No live desktop app with Claude Code
  syncing through the bridge was driven in this run.
- Real phones, TestFlight and Play internal testing.

Small findings, none blocking:

1. The mint notice puts the fixed line second to last, with the revoke paragraph after it. The contract
   says it "ends with" that line. The text is right; only the order differs.
2. The hosted MCP ignores the agent's `clientInfo.name`. The badge shows the token's name, which is
   what the contract specifies, so a token is best named after the agent that will hold it.
3. Building the Android app needs `ANDROID_HOME` set, or an `android/local.properties`.
   `apps/mobile/README.md` does not say so.
4. Darkmown trust lasts for one viewing. Reopening a document asks again. That is deliberate
   (`apps/mobile/src/components/darkmown-view.tsx`) but worth knowing.
5. In the `.wd` radio row, each label sits closer to the next option's circle than to its own
   ("12.99○ 24.5○ 40"). This is cosmetic, the same on both platforms, and not traced to its source.
6. A `markie-mobile://` link opened through `simctl` shows iOS's "Open in Markie?" the first time. A
   universal link will not.

## Reproducing

```sh
# server, throwaway
export DB_PATH=/tmp/markie-e2e/markie.db ASSETS_DIR=/tmp/markie-e2e/assets PORT=8791 \
  BETTER_AUTH_URL=http://localhost:8791 BETTER_AUTH_SECRET=<any local value> NODE_ENV=development
(cd server && node --experimental-strip-types src/migrate.ts && node --experimental-strip-types src/index.ts)
# codes and notices print to that console

# apps
(cd apps/mobile && npm run build:dev && npx cap sync)
xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<sim udid>' -derivedDataPath /tmp/markie-e2e/dd build
ANDROID_HOME=$HOME/Library/Android/sdk JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
  apps/mobile/android/gradlew -p apps/mobile/android assembleDebug

# link parity
(cd server && node --experimental-strip-types ../docs/mobile/e2e-2026-10-25/evidence/link-parity.mjs "$(git rev-parse --show-toplevel)")
```

`link-parity.mjs` reads this run's saved `/mcp` results from `/tmp/markie-e2e`. On a fresh run, recreate
those files first, or delete that block.
