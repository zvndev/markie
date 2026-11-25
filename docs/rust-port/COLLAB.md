# Markie RS: live collaboration, comments and sharing

Date: 2026-11-22. Covers PARITY.md sections 11, 12 and 14. Branch `t3/markie-rs-collaboration-comments-sharing`, merged onto `rust/markie-rs`.

## Summary

Markie RS joins the same live rooms as the web app, the phone and Electron, and they converge. This was proved on the real server running on this computer, with a TipTap client running the web app's own code.

- A Rust client and a TipTap client edited the same paragraph at the same moment. Both wrote the same Markdown and held the same room, three runs in a row.
- Each side's caret resolved to the same word on the other side, and each side's comment anchor resolved to the same words.
- A viewer removed mid-session got close code 4403 and stayed closed.

The window was run against the same server with a TipTap peer. As the owner it seeded the room, kept its presence and caret visible to the peer, and wrote the peer's edits into its file; as a viewer it joined read-only; removed, it got 4403. That run found one real bug, now fixed: presence vanished after 30 s (see "On screen").

The share sheet, the comment margin, local comments, presence avatars, remote carets and the view-only banner are built in the window, but there are no screenshots: macOS refused window capture to this session. They are not yet compared with Electron side by side.

## Where the code is

| Layer | Files | What it does |
|---|---|---|
| Live session | `markie-cloud/src/collab/session.rs`, `runtime.rs` | y-websocket protocol, the ticket rules of `connectWithTicket`, reconnect with backoff, presence. Room updates wait in an inbox until the editor's thread pumps them. |
| Rich binding | `markie-editor/src/collab/` (`mod.rs`, `ydiff.rs`, `positions.rs`, `relpos.rs`, `editor_pos.rs`, `ytree.rs`) | The editor bound to `XmlFragment("default")`: minimal Yjs edits, folding the room back with byte preservation, y-tiptap's position mapping, Y.RelativePosition JSON, shared undo, room claims. No rendering. |
| Comments | `markie-cloud/src/comments/` (`mod.rs`, `anchor.rs`, `local.rs`, `project.rs`) | Cloud threads (REST), local comments in Electron's `doc-meta` format, quote anchors, and the View-mode text projection. |
| Sharing | `markie-cloud/src/sharing/` (`mod.rs`, `view.rs`) | Access, members, invites, public links, people and requests (REST), and the dialog's rules and wording. |
| Window | `markie-app/src/workspace/collab.rs`, `comments.rs`, `share.rs` | Role checks, the live session in the window, presence, banner, comment margin and panel, the share sheet, people lists. |
| Proof | `markie-cloud/tests/session_supervisor.rs`, `markie-editor/tests/live_interop.rs`, `markie-editor/interop/` | The supervisor against a scripted socket server; Rust and TipTap on the real server. |

Small changes in other agents' files, each a few lines:

- `markie-app/src/workspace/chrome.rs` (window shell, then cloud sync): `Workspace::open_share` now lives in `share.rs`. It opens the share sheet for a document with a cloud copy, and otherwise the sync work's opt-in sheet (`show_text_sync`) or Office snapshot (`show_office_upload`), which is what that work's version of the button did. The title bar shows `render_presence` before the colour-mode switch, where `toolbar.tsx` puts the live dot and avatars.
- `markie-app/src/workspace/cloud.rs` (cloud sync): `cloud_after_save` does not push the stored copy while a live room runs, as Electron's desktop never does.
- `markie-app/src/workspace.rs` (window shell): three module lines, one `collab` field, `collab_on_open` after a document opens, `live_source_edit` at the top of `on_edit`, the live banner, the comment overlay and the share sheet in `render`.
- `markie-app/src/workspace/rich.rs` (editor look): the rich editor's events go to the live room first; undo and redo events; the file is not written while a live room cannot carry it.
- `markie-app/src/icons.rs` (window shell): six icons from `comments.tsx` and `share-dialog.tsx`.
- `markie-editor/src/lib.rs`, `element.rs`, `render.rs`, `chrome.rs` (editor look): peers' carets, name tags and selections, tinted commented passages, `remote_changed`, `caret_rect`, `viewport`, and undo routed to the host in a live room.

## Section 11: live collaboration

| Item | Status | Notes | Tests and evidence |
|---|---|---|---|
| Edit together in real time, rich Markdown | Matches | Room is `XmlFragment("default")`. Local edits go in as y-prosemirror's `updateYFragment` would write them: equal children kept from both ends, same-named elements updated in place, text diffed. Untouched blocks keep their Yjs items and their Markdown bytes. | `collab::tests::{an_edit_touches_only_its_block, concurrent_edits_in_one_paragraph_converge}`; `live_interop` |
| Edit together, plain text | Matches (engine); window path not checked on screen | `Text("content")` room with the existing whole-string binding, under the new supervisor. Seeding stamps `schemaVersion: 1` and `contentKind: "text"` in one transaction. | markie-cloud `local_server` (text room, run by an earlier agent); `two_bindings_merge_concurrent_edits` |
| Peer avatars | Built | Title bar, after the commands button: live dot (emerald, amber, zinc) with "LIVE", up to four 20 px avatars with initials, "+N". Tooltips "Live session: …" and the name. | no screenshot (capture refused) |
| Peer cursors (rich) | Built; resolves exactly | TipTap's CollaborationCaret look: a 2 px bar in the peer's colour, a 10 px semibold name tag that shows for 2.4 s after a move (fading from 62%), the selection at alpha 0x70. Positions use y-tiptap's `relativePositionToAbsolutePosition`. | `live_interop` (TipTap's caret on "dog" resolves in Rust; Rust's caret resolves to "lazy" in TipTap); `cursors_resolve_on_the_other_side` |
| Our cursor in awareness | Matches | `cursor: {anchor, head}` as `JSON.stringify` of y-tiptap's relative positions, every field present. | same |
| Plain-text rooms show names only | Matches | Electron's text pane has no carets either. | |
| Wire protocol | Matches | `ws(s)://<server>/collab/<docId>?ticket=`, message 0 sync, 1 awareness, step 1 on open, then presence. | `session_supervisor`, `live_interop` |
| Ticket, schema 2, refreshed in place every 2 min | Matches | First ticket retried after 1, 3 and 6 s on a transient failure; a refusal or a legacy server is "unavailable". Refresh every 2 min, and on a close when the last ask is over 30 s old; a 4000-4999 close stops refreshing. | `session_supervisor::{a_blip_on_the_first_ticket_is_retried_and_a_refusal_is_unavailable, a_room_too_new_is_final_and_4000s_stop_ticket_refresh}`, `ticket` unit tests |
| `?token=` fallback for servers without tickets | Differs, by choice | Not sent: it puts the session token in a URL. Such a server gets no live editing (as CLOUD.md recorded). | `a_blip_on_the_first_ticket…` (legacy is unavailable) |
| Reconnect with backoff (room supervisor) | Matches | y-websocket's `min(2^n × 100, 2500)` ms, `n` counting closes since the last sync; 30 s without a message closes the socket; presence renewed every 15 s; peers silent for 30 s dropped; everyone else dropped on disconnect. | `session_supervisor::drops_reconnect_with_backoff_and_4403_is_final`, `backoff_follows_y_websocket` |
| Close 4403 | Matches | Final. The editor locks and the banner shows Electron's access-removed line, in red. | `live_interop` (Carol removed), `session_supervisor`, window run (`carol-viewer.log`) |
| Close 4426 | Matches | Final; back to the local copy with "The live session could not load. You are editing your copy alone." | `session_supervisor::a_room_too_new_is_final…` |
| Other 4400-4499 closes | Matches | Final, as y-websocket's default `shouldReconnect`. | `only_4400s_are_final` |
| Seeding: one seeder, 150 ms settle, 15 s claim | Matches | After the first sync and `SEED_SETTLE_MS`, the first editor sends the room's content and stamps (`editorModel: 2`, `schemaVersion`) as one update built on a copy, never applied locally, exactly like `migrationUpdate`. Typing waits until the server sends it (or the winner's) back; 15 s without it goes back to the local copy with "Couldn't join the live session. You're editing the local copy." Viewers never seed; a viewer in an empty room keeps the synced copy. | `a_seeded_room_reads_back_as_the_file`, `live_interop` (seed comes back as the file byte for byte) |
| Schema version | Matches | 2 when the content holds a formula or the copy has front matter, never lower than the room's; an unknown stamp reads as 0. | `math_and_front_matter_raise_the_schema` |
| A room this build cannot draw | Matches | A node or mark the model lacks refuses the room and goes back to the local copy. | `an_unknown_node_is_refused` |
| Rooms an older build seeded (no `editorModel`) | Differs | Claimed as they are, with this model's stamps, when Markie RS can draw them. Electron's `rich-room-migrate.ts` also turns `$…$` text into formula nodes and handles front matter; that conversion is not ported. | |
| Meta map | Matches | `schemaVersion`, `editorModel`, `contentKind`; `storedCopy` is read and written by the existing snapshot code. | `stored_record_round_trips_in_the_meta_map` |
| Snapshot writer | Matches | The desktop offers `markieSnapshotWriter: false` and never writes the stored copy while live, as Electron (`live-snapshot.ts`). The writer rules stay available for other clients. | |
| The desktop file while live | Matches, with a simpler guard; the note is an improvement | The file is written from the room after remote edits. When the document has something a room cannot hold (raw HTML, an HTML comment, a footnote, a link definition, a picture in a heading or a table cell) the file is left alone. Electron's guard is the generic one (seed, serialize, compare bytes); Markie RS checks for held-aside blocks (`markie_rich::document::room_refusals`). Untouched blocks keep their bytes either way. Electron's note lists every possible cause whether the file has it or not. Markie RS names this file's first one by line, in one line with Save a copy: "Edits here reach the live session, not this file. Line 40 has a footnote, which live editing can't keep." (`sharing::view::live_file_note`). Fixed 2026-11-24: a tight list item that opened with bold, italic, struck text or a link was refused, so ordinary reports got the note. | `concurrent_edits…` (table bytes kept), `markie-rich/tests/live_room.rs`, `the_live_file_note_names_this_files_reason_and_nothing_else` |
| Source while a rich room is live | Matches | Read-only mirror with "Live session. Edit in Rich." | |
| Peer colours | Matches | `colorForName`, stamped by the server. | `colours_match_the_js_hash`; `live_interop` (stamped colour) |
| Collaborative undo | Matches | A yrs `UndoManager` over the fragment that tracks only this client's transactions, 500 ms grouping like TipTap's `yUndoPlugin`. ⌘Z and ⌘⇧Z in a live room take back only your edits; a peer's edit made in between survives. | `undo_takes_back_only_this_clients_edit` |
| Caret kept through remote edits | Matches | The caret is held as relative positions across each remote update. | `a_remote_edit_keeps_the_local_caret_on_its_character` |
| When a document goes live | Matches | A cloud copy (the sync binding's signed-in scope, `CloudWorkspace::bound_scope`), a server answer, at least one member, and not a large document (page.tsx). Read-only while checking; an offline role proved before for this account still counts. Membership changes from the share sheet re-check without restarting a running session. | window run (`alice-owner.log`: "access Owner, 2 members") |
| Presence renewal | Matches (fixed in this work) | Every 15 s the local state is set again with its clock raised, as y-protocols' renewal does. Resending the same clock was ignored by the server and peers, which dropped Markie RS after 30 s and then left its socket silent enough to reconnect. | `renewing_presence_raises_its_clock`; `live_interop` waits 36 s and checks both peers are still present with no reconnect |
| Cursor published only while focused | Matches | As y-tiptap's `updateCursorInfo`: published on moves only while the rich editor has focus, removed from awareness when focus leaves (INTEGRATION-CLOUD.md). | integration run: an unfocused window shows the peer no caret |

## Section 12: comments

### Cloud comments

| Item | Status | Notes | Tests and evidence |
|---|---|---|---|
| Add, reply, resolve, reopen, delete | Built | Margin layer over a live rich document, as `comments.tsx`: bubbles at anchors (24 px, author colour, comment count, 30 px apart), the thread card at the bubble, "Comment" on a selection, the composer, "N resolved ▾" list. Delete shows for your own comments, and for the owner on any. | REST: markie-cloud `local_server`; layer not yet screenshot |
| Anchor format, Y.RelativePosition JSON | Matches | Made with y-tiptap's `absolutePositionToRelativePosition` and written as `Y.relativePositionToJSON` writes it; read back with `relativePositionToAbsolutePosition`. A deleted passage hides the bubble, as the web does. | `live_interop` (TipTap's anchor on "fox" resolves in Rust; Rust's anchor on "quick brown" resolves in TipTap); `comment_anchors_survive_edits_before_them`, `every_position_round_trips_through_a_relative_position` |
| Poll every 15 s | Matches | Pausing while the window is hidden is not built. | |
| Composer keys | Matches | A two-row text area: Enter sends, Shift+Enter starts a new line, Escape cancels a new comment (INTEGRATION-CLOUD.md). | |
| Shown only in live rich sessions | Matches | As RichView mounts the layer. | |

### Local comments

| Item | Status | Notes | Tests and evidence |
|---|---|---|---|
| Where they are stored | Matches | `<Markie RS data>/doc-meta/<sha256(abs)[:8]>-<basename>/comments.json` plus `doc.json`, written atomically, Electron's shape key for key. Markie RS's data folder is its own. | `comments::local::tests::{threads_round_trip_on_disk_in_electrons_shape, electron_files_load, slugs_match_electron}` |
| Quote anchors | Matches | `text-anchor.mjs` ported in UTF-16 offsets: context of 32, whitespace-collapsed fallback, prefix and suffix scoring, nearest hint, the agent's `locateQuote` with its exact error strings. | `comments::anchor::tests` |
| Detached threads | Matches | Listed apart with "The text these were on has changed or been removed."; never dropped. | `threads_round_trip…` |
| Panel, toggle, highlights in View | Built | 300 px panel, "Comments" toggle at 40 px from the top, "Comment" on a selection, passages tinted `rgba(96,165,250,0.14)` (0.32 when active). View-to-Markdown mapping is `local-comments.ts`'s projection, byte for byte. | `comments::project::tests` (matches the TypeScript output); panel not yet screenshot |
| Highlights in Source | Matches | GPUI Kit's decoration collections tint each open, anchored passage as source-comments.ts does (INTEGRATION-CLOUD.md). "Comment" on a Source selection is not built. | `source_marks_cover_the_quote_in_bytes` |
| An agent's comment shows without a reload | Matches in effect | The panel re-reads `comments.json` when its modification time changes (checked each second) instead of an IPC event. | |
| Agents add, reply and resolve through MCP | Matches | The bridge's `comments_*` methods port agent-comments.js on top of `LocalComments` (INTEGRATION-CLOUD.md). | markie-agent `comments` tests; live bridge run |
| Records follow a rename or move | Not wired | `LocalComments::move_records` ports `doc-meta.js` `move()`, including `.replaced-N`; the rename and move code (another agent) has to call it. | `threads_round_trip…` (rename case) |
| Super-nightly gate | Matches | Off unless `MARKIE_RS_NIGHTLY=1` or the `nightly` setting is `1`, as `nightlyFeaturesEnabled`. Hidden while a document is live. | |

## Section 14: sharing, people, roles and public links

| Item | Status | Notes | Tests and evidence |
|---|---|---|---|
| Share button opens a gate | Built | Always opens: unsaved file, checking, only on this Mac (the sync opt-in), or the dialog. | no screenshot (capture refused) |
| "Sync and share" | Matches in effect | A local text file opens the sync work's opt-in sheet from Share; an Office file opens its snapshot upload. | |
| Invite by email as viewer or editor | Built | Chips, `,` `;` and Enter finish an address, suggestions from contacts (six, minus people already on it), role picker with "Can read and comment" / "Can edit and comment", Send with Electron's result lines ("Shared with…", "Asked…", "Invited…"); failures stay as chips. | `sharing::view::tests`; REST in `local_server` and `live_interop` |
| People with access, change role, remove | Built | Owner row "(you)", member rows with "Invited, not joined yet" and "Waiting for them to accept", role menu with Remove access. A removal that rotates the public link shows the new link and Electron's note. | |
| General access and public link | Built | Restricted or Anyone with the link, which publishes at once; "See what a stranger sees"; Live Doc variants with Electron's two lines. | `links` |
| Copy link | Matches | The public page when there is one (never for a Live Doc), else `/d/:id` on the docs origin; "Link copied" for 2 s. | `links` |
| Files on this computer note | Matches | `localAssetCount` ported; same sentence. | `local_files_are_counted_like_attach_ts` |
| Accept, decline, block, unblock, remove people | Built | Requests (Accept, Decline, Block) sit on the Cloud page; Remove, Block and Unblock are in the account sheet (INTEGRATION-CLOUD.md). | REST in `local_server`; requests counted in the integration run |
| Shared by me, shared with me | Built | The Cloud page's source chips and badges, from the listing and `GET /api/docs/shared-by-me` (INTEGRATION-CLOUD.md). | `cloud_page` tests |
| View-only banner | Matches | "Shared with you · view only" (with "by …" when known), "Checking your access…", the unreachable line, and Make a copy (duplicates the file). | `roles_and_banners` |
| Role remembered offline per account | Matches | Kept in Markie RS's registry settings as `share_role:<path>` = `role|userId`, read only for the same account. | |
| Hosted Live Doc address | Not built | `SharesClient::live_doc_address` exists; Live Docs are a nightly area owned elsewhere. | |
| Private and public page links | Matches | `/d/:id`, `/s/:token`. | `links` |

## On screen

The scenario script sets up a live document on the local server and leaves it running: Alice owns it (Markie RS), Bob edits it from TipTap, Carol may only view it.

```sh
S=<scratch folder>
rust/crates/markie-editor/interop/scenario.sh "$S"            # server + accounts + document
env -u CLAUDE_CONFIG_DIR -u CODEX_HOME MARKIE_RS_DATA_DIR="$S/data" HOME="$S/home" MARKIE_RS_TEST_SESSION="$S/alice-session.json" \
  "rust/target/release/Markie RS.app/Contents/MacOS/markie-rs" "$S/live.md" & echo $!
MARKIE_LIVE_PEER="$S/bob.json" npx vitest run --config rust/crates/markie-editor/interop/vitest.config.mts \
  rust/crates/markie-editor/interop/peer.test.ts                # Bob, until: touch "$S/stop"
```

`MARKIE_RS_TEST_SESSION` only accepts a server on this computer. It never touches the Keychain.

### What the window run showed

The window ran from the debug and release builds with a scratch `HOME` and data folder, `MARKIE_RS_TEST_SESSION` and `MARKIE_RS_COLLAB_DEBUG=1`, against the local server from `scenario.sh`. Bob was the TipTap peer (`peer.test.ts`). Evidence: `.autoloop/runs/collab-app/20261122-0140/`.

| Check | Result | Evidence |
|---|---|---|
| The owner opens a shared document | Access Owner with 2 members, live session started, connected, settled, claimed the empty room (483 bytes), ready when the claim came back | `alice-owner.log` |
| A TipTap peer joins 50 s later | Bob sees the room as the file, and sees "Alice Rust" with her server-stamped colour and a published caret, `markieSnapshotWriter: false` | `bob-sees.json` |
| The peer types | Bob's sentence reaches the window and its file on disk, with every other line byte for byte | `alice-file-after.md` |
| Joining a room that already has content | Ready without a claim; the room's newer text is written to the file | `alice-joins-existing-room.log` |
| A viewer opens it | Access Viewer, joins read-only, the room's text lands in the viewer's own copy | `carol-viewer.log`, `carol-file-after.md` |
| The owner removes the viewer | The viewer's session ends with `Closed(AccessRevoked)` (4403); the window stays open, locked | `carol-viewer.log` |
| Presence past 30 s | Failed on the first run (Bob saw nobody); fixed by raising the awareness clock on renewal, then passed | first run's logs are not kept; the fixed run is above |

These runs were started before the rule to unset `CLAUDE_CONFIG_DIR`, so their scratch device indexes listed file paths under the agent seat folder's `skills`. Nothing from those files is in the evidence; the three instances were closed by PID and their scratch data folders deleted. Launch with `env -u CLAUDE_CONFIG_DIR -u CODEX_HOME`, as above.

What could not be checked: anything that needs seeing the window or sending it keys. `screencapture -l <window>` answered "could not create image from window" for this session (macOS withholds other apps' windows without Screen Recording permission), and `act.sh` could not bring the window to the front. One full-screen capture was taken to test the permission and deleted without being opened.

A side-by-side with Electron is not possible on a local server anyway: the packaged Electron app refuses a server on this computer (`parseServerOrigin` without `allowDev`).

## How to run the tests

```sh
cd rust
cargo test -p markie-cloud                                  # unit, mock HTTP, supervisor
cargo test -p markie-editor                                 # binding tests
crates/markie-editor/interop/run-live.sh                    # Rust + TipTap on the real server
```

`run-live.sh` needs the repo's `node_modules` and `server/node_modules` (a worktree can symlink the main checkout's). Evidence lands in `.autoloop/runs/collab-live/<stamp>/`: `rust-report.json`, `tiptap-seen.json`, `tiptap-done.json`, `node.log`, `server.log`. The handoff file with the scratch session token is deleted after each run.

Evidence from the runs recorded here:

- `.autoloop/runs/collab-live/20261122-011909/` (first green run)
- `.autoloop/runs/collab-live/20261122-012103/`, `20261122-012135/`, `20261122-012208/` (three in a row after the cursor-settle fix)
- `.autoloop/runs/collab-live/20261122-013718/` (with the 36 s presence check, after the renewal fix)
- `.autoloop/runs/collab-app/20261122-0140/` (the window against the local server)

## Open items

| Item | Owner | Notes |
|---|---|---|
| Screenshots of the share sheet, margin, panel, carets, avatars and banner | this work, with screen permission | Needs Screen Recording for the agent's shell and a focusable window. The scenario script sets everything else up. |
| Side-by-side with Electron | Kirby's call | The packaged Electron app refuses a localhost server; a dev build of Electron, or a staging server, would allow it. |
| Local comments on rename | dialogs | `move_records`. Agents now comment through the bridge (INTEGRATION-CLOUD.md). |
| Legacy room migration of `$…$` and front matter | this work | Rare: only rooms seeded by builds before the model stamp. |
| The access-removed line contains an em dash | Kirby | It is Electron's wording (rich-view.tsx), copied for parity. Change both apps or neither. |
