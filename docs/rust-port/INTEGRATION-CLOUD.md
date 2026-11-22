# Markie RS: sign-in, Cloud sync, collaboration and the agent bridge, wired together

Date: 2026-11-22. Branch `t3/markie-rs-cloud-integration`, on top of `rust/markie-rs` at fb2654e. Reference: Markie 0.9.7 and its source.

Six agents built sign-in ([CLOUD.md](CLOUD.md)), Cloud sync ([CLOUD-SYNC.md](CLOUD-SYNC.md)), collaboration ([COLLAB.md](COLLAB.md)) and the agent bridge ([AGENTS-BRIDGE.md](AGENTS-BRIDGE.md)) separately. This work connects them and closes their open items. All eight items on the list are done. Item 8 was proven end to end against the local server; the screen could not be captured or driven from this session, so there is no side-by-side with Electron yet.

## The list

| # | Item | Status | Commit | Tests | Evidence |
|---|---|---|---|---|---|
| 1 | Re-check access as soon as sync turns on, so a live room starts | Done | 0cb2fe2 | `only_sync_on_and_off_recheck_collaboration` | Integration run: sync on finds Bob as a member and the room starts at once |
| 2 | Share requests panel on the Cloud page | Done | 094e951 | build; requests counted in the run | Integration run: Bob's share to Alice shows as one request waiting |
| 3 | Cloud page: type and order menus, source chips, snapshots section | Done | 618cd56 | `cloud_page` unit tests (6) | No screen evidence (capture refused) |
| 4 | Agent bridge on the signed-in account and Markie RS's registry; agent comments | Done | 672231e | markie-agent `comments` tests (3), bridge tests | Integration run: agent status, comment and sync through the real `mcp/agent-client.mjs` |
| 5 | Sign-in leftovers: backdrop, linked sign-ins, people, sync switch | Done | 6975ed4 | account `failure()` table, link-page check, wiremock linking flow, backdrop colours | Mock server only for linking; no screen evidence |
| 6 | Collaboration leftovers: multi-line composer, Source highlights, caret only while focused | Done | 1dddb81 | `source_marks_cover_the_quote_in_bytes` | Integration run: the unfocused window publishes no caret |
| 7 | One token store for the sign-in sheet and Cloud sync in every mode | Done | 8367d8e | `a_sign_in_in_the_shared_store_is_a_sync_scope`, `token_home` test, registry pin test | Integration run: a scratch sign-in lists the synced library at once |
| 8 | Prove 1, 4 and 7 end to end on the local server | Done | 7f9ec80 (driver and scripts), with script fixes in the report commit | `scripts_parse_every_step` | `.autoloop/runs/cloud-integration/` (run 1 and the final run) |

### 1. Sync on starts the live room

When a sync on, pause or delete finishes for the open document, `collab_after_sync_change` runs `collab_recheck`, as the Library's `onSyncChanged` runs `refreshCollab` in Electron. A sign-in or sign-out in the sheet re-resolves the open document from scratch ("sign-in/out changes live eligibility" in page.tsx). With no cloud copy left, the check now stops a running session and drops the role, so turning sync off leaves a plain local file.

A room still starts only when the document has at least one member, as in Electron. A freshly synced, unshared document gets its Owner role and no room.

### 2. Share requests on the Cloud page

`render_share_requests` sits between the source chips and the list, where cloud-view.tsx puts `ShareRequestsPanel`. It loads with every Cloud listing, for the server and account the page shows, and its list is dropped when that account changes. Accepting or blocking someone lists the cloud again, because their documents land or leave (`onPeopleChanged`).

### 3. The Cloud page

`workspace/cloud_page.rs` ports library.tsx's workspace presentation, cloud-view.tsx and document-cloud-library.tsx:

- Filters: the Cloud area picker (a select with the area chips), the search field, the Document type and Sort menus with Electron's labels, and Clear filters.
- Synced and shared files: the summary band ("5 documents", "2 of 5 documents", the loading and incomplete lines), the All / Only me / Shared by me / Shared with me chips with counts, remembered like `markie.cloud.sources.v1`, then one list of Library rows. Each row has the format icon and badge, the sync state icon, "Shared by …" lines, and the source badge ("Only you", "Shared with 2 · 1 invited", "Shared with you"), with Manage on rows you share.
- Snapshots: "N of M snapshots" with Refresh, then cards in two columns with the format mark, role, version, size and age, and Electron's state cards for loading, errors and empty lists.

The listing now also reads `GET /api/docs/shared-by-me` and keeps the snapshot list's error. The page header says Connected with the green dot when signed in.

### 4. The agent bridge

Agent Cloud requests use the window's own Cloud workspace. A file already in the cloud keeps its server and account; a new one goes to the primary server, as Electron's `syncOn` does. After a sync the record is stored with `store_binding`, the file joins Recent, the cloud is listed again, and the open document's access is re-checked when this was its first cloud copy. A record the bridge kept under the old `agent-cloud:` settings moves into the registry the first time an agent asks about that file. The Remote agents dialog uses the primary server's account.

`comments_list`, `comments_add`, `comments_reply` and `comments_resolve` port electron/agent-comments.js in `markie-agent/src/comments.rs`, on top of `LocalComments::add_from_agent`, `reply` and `set_status`. They run only with the super-nightly switch on (`MARKIE_RS_NIGHTLY=1` or the `nightly` setting); otherwise they return the stable "nothing was saved" sentence, as Electron's stable build does.

### 5. The account sheet

- Backdrop: every GPUI Kit dialog draws `.markie-scrim`, the template background at 72%. Chromium blurs it at 58%; GPUI has no backdrop blur, so the dim is the stronger one `dialog_chrome` already uses.
- Manage linked sign-ins runs linked-identities.tsx's whole flow: a primary-email code per change, link another email, link Google or Apple in the browser with the 5 s status check, unlink an email, and unlink a provider, which signs out. The error sentences are account-identities.ts's `failure()`, word for word. A linking page must be the server's own `/account/link-<provider>#<intent>.<secret>` before it opens.
- Accepted people have Remove and Block behind Electron's confirm sentences; Blocked has Unblock.
- "Sync my documents to the cloud" is a working switch, stored like `markie.sync.v1`. Electron also only stores it.

### 6. Collaboration

- The comment composer is a two-row text area: Enter sends, Shift+Enter starts a new line, Escape cancels a new comment.
- Local comments are tinted in Source as source-comments.ts does: `rgba(96,165,250,0.14)`, 0.32 for the active thread, with a 2 px `rgba(96,165,250,0.7)` underline. The tint is redrawn when the threads, the active thread or Source's text change, and cleared while the document is live.
- The live caret follows y-tiptap's `updateCursorInfo`: it is published on moves only while the rich editor has focus, and taken out of awareness when focus leaves.

### 7. One token store

`account::shared_tokens()` is the only token store in the process. The sign-in sheet, the Cloud sync workspace, the agent bridge and deep links all use it.

| Run | Store |
|---|---|
| Scratch data folder (`MARKIE_RS_DATA_DIR`) | Memory, for this run only. Parallel scratch copies cannot read each other's sessions or raise a Keychain prompt. |
| Real run | Keychain service "Markie RS" |
| Real run with `MARKIE_RS_CLOUD_SERVER` | Keychain service "Markie RS Test" |

The sync workspace pins the local test server for the run, without writing it to `servers.json`, so a sign-in on that server is a sync scope at once.

## End to end on the local server (item 8)

This session may neither capture nor send input to app windows: `screencapture -l` answered "could not create image from window" and `act.sh` could not bring the window to the front. So the clicks are replaced by a loopback-only driver that calls exactly what the clicks call:

- `MARKIE_RS_TEST_DRIVE=<script.json>` (`workspace/cloud_drive.rs`) runs the sign-in sheet's email-code route, with the code read from the console-mail log, and the sync opt-in sheet's Turn on sync and Stop syncing. It is honoured only with a scratch data folder and a server on this computer.
- `rust/scripts/cloud-integration/run.sh <scratch>` boots the local server, runs Markie RS under that script, signs up Bob and shares the document with him from a second session of Alice's account, starts the TipTap peer (`markie-editor/interop/peer.test.ts`) as Bob, has Bob share a document with Alice, and drives the agent bridge through the repo's own `mcp/agent-client.mjs`.

The scratch data folder is a short `mktemp` folder under `/tmp`, because the bridge socket path must stay under the macOS limit (AGENTS-BRIDGE.md); the script deletes it at the end. The scratch `HOME` and the server's files stay in the scratch folder given to the script. Instances are launched with `env -u CLAUDE_CONFIG_DIR -u CODEX_HOME` and stopped by PID.

Accounts: Alice is `success@simulator.amazonses.com`; Bob is `success+markie-rs-integration-bob@simulator.amazonses.com` on the same SES simulator mailbox. Mail is console only. No token was printed; token files are 0600 in the scratch folder and deleted at the end.

### What the run showed

Final run: `.autoloop/runs/cloud-integration/20261122-032825/` (exit 0). The first run, before the script existed, is in `run1/`: the same flow, before item 6's caret change, so its peer still saw a caret from the unfocused window.

| Step | What `app.log` and the other files show |
|---|---|
| Sign in through the sheet's code route (item 7) | `listed http://localhost:18931 for this account: 0 documents` right after the sign-in: the sync workspace saw the sheet's session at once, in a scratch run |
| Turn sync on, no members yet (item 1) | `sync changed: re-checking access`, then `access Owner, 0 members`; no room, as in Electron |
| Pause, share with Bob from a second session, Bob accepts, turn sync on again (item 1) | `sync changed: re-checking access`, `access Owner, 1 members`, `start live: rich true`, `status Connected`, `claim: 495 bytes`, `ready`: the room starts the moment sync is on, without reopening |
| The TipTap peer joins as Bob | `peer-sees.json`: Markie RS's presence with its colour, `cursor: false` (the window never had focus, so no caret is published: item 6), `writer: false`. Bob's sentence reached `plan-after.md` with every other line unchanged |
| Bob shares a document with Alice, who has not accepted him (item 2) | `1 share requests waiting for this account` with the next Cloud listing |
| Agent `cloud_status` on the synced file (item 4) | `agent-status.json`: `synced`, server `http://localhost:18931`, role `owner`: the record the window made |
| Agent `comments_add` and `comments_list` (item 4) | `agent-comment.json`: anchored on "quick brown fox" under "Claude Code"; `comments.json` in the scratch data folder; the list shows 1 thread, 0 detached |
| Agent `cloud_sync` of a new file (item 4) | `agent-sync.json`: `synced` on the signed-in account; the window listed the cloud again (`2 documents`); `server-docs.txt` has `notes.md` beside `plan.md` |

No token, code or ticket is in the evidence: the server log's codes are replaced, and the files were checked for bearer headers and tickets.

## Changes outside this work's files

Each is a few lines, named here for the owners:

- `markie-app/src/workspace/rail.rs` (window shell): the signed-in Cloud header says Connected with the green dot and is not a button, as library.tsx.
- `markie-app/src/workspace.rs` (window shell): module lines for `cloud_drive` and `cloud_page`, the Cloud filter placeholder "Filter by name or folder", and one subscription for the rich editor's focus.
- `markie-app/src/themes.rs` (shell): the GPUI Kit theme's `overlay` colour, the dialog backdrop.
- `markie-app/src/icons.rs` (shell): the sync state, people and refresh icons from library.tsx and document-cloud-library.tsx.
- `markie-app/src/deeplinks.rs` (platform): `session_store()` returns the shared token store.

## Findings

- The background reconcile pushes a live document's stored copy when the room has written newer text to the file (run 1: version 3 held the TipTap peer's sentence). Electron's `reconcile.js` has no live check either, so this matches; it is noted because COLLAB.md says the desktop never writes the stored copy while live, which holds only for the save path.
- A background window runs its timers slowly under App Nap, so each scripted step took seconds instead of milliseconds. Nothing failed because of it.

## Open items

| Item | Notes |
|---|---|
| Side-by-side with Electron for the Cloud page, the account sheet, the composer and the Source tint | Needs a session with Screen Recording and input. The run script sets up the signed-in state; Electron's packaged app refuses a local server, so the Cloud page comparison needs a staging server or Kirby's real account. |
| Linked sign-ins against a real server | The local server has none; proven against wiremock. Google and Apple need Kirby's accounts. |
| Creating a cloud area from the area picker | Electron's picker has a New area field. The RS picker chooses among existing areas. |
| "Comment" on a Source selection | Electron's local comments panel also works from a Source selection. Markie RS tints passages in Source; adding a comment still happens in View. |
| A scratch session does not survive a relaunch | By design: scratch runs keep sessions in memory. |

## Tests

`cargo test --workspace` from `rust/` passed before the final commit: 902 tests in 64 suites, none failed, 2 ignored (the opt-in Keychain test and one other opt-in test). The log is in the agent's scratch folder; the integration evidence is under `.autoloop/runs/cloud-integration/`.

## How to run

```sh
cd rust
cargo test --workspace
cargo build -p markie-app
scripts/cloud-integration/run.sh <scratch dir>      # needs node_modules and server/node_modules
```
