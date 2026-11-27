# Google Docs in Markie RS

Connect a Google account, pick Docs in Google's Picker, import them as Markdown, and keep the picked Docs in sync both ways while Markie is open. Docs the account does not own get suggestions instead of edits. Mac only.

Status, 2026-11-26: steps one (import) and two (two-way sync and suggestions) are built and tested against a fake Google. It is hidden until Kirby creates the Desktop OAuth client and a build carries it. Nothing has run against the real Google yet; the spike tool below does that, and its `--write-test` checks two-way sync on a Doc of its own.

## What a person sees

- **File › Import from Google Docs…**, and the same command in the palette. It opens Settings › Files and sends the browser to Google's consent page with the Picker on it. The person picks Docs, or a folder, and comes back to Markie.
- **Settings › Files › Google Docs**:
  - "Connect Google Docs" when not connected; the account's email, "Import from Google Docs…" and "Disconnect" when connected;
  - **"Keep these Docs in sync both ways"**, ticked by default: the choice for the Docs picked next. Off, they import as Refresh only, as in step one. The choice is remembered;
  - the import folder, `~/Documents/Markie/Google Docs` by default, with "Change…";
  - progress while Markie waits for the pick or imports ("Importing 2 of 4: Trip plan…"), with Cancel;
  - every synced Doc: a Google mark, its title (click to open), and its state in plain words:
    - "Field notes.md · Synced 2 minutes ago";
    - "Sending…", "Edited here · sending in a moment";
    - "Waiting for connection. Your edits are kept and will be sent.";
    - "Conflict: Google's text is in the file, yours is kept beside it. Compare", with **Compare** and **Dismiss**;
    - "Read only: has tabs", "Read only: view only";
    - "Suggesting · Synced 5 minutes ago";
    - "… · Kept here, not sent: tables and images";
    - "Refresh only · Reading list.md · Synced 3 hours ago";
    - "Stopped: this Doc is in the trash in Google. Your file is kept.", "Stopped: Markie can no longer open this Doc in Google.", "Unlinked: the file was deleted on this Mac. Nothing was changed in Google.", with **Remove from List**;
  - under each Doc, **Sync both ways** (a switch, which turns it back to Refresh only when off) and, for a Doc this account doesn't own, **Send my edits as suggestions** (on by default for such Docs);
  - **Sync Now** (or Refresh, for a Refresh-only Doc) and Save as Word on each row, Sync All Now above the list.
- **The title bar**: beside an open synced file's name, a Google mark and one quiet word or two: Synced, Sending…, Edited, Waiting for connection, Conflict, Suggesting, Read only, Refresh only, Not syncing. Its tooltip and VoiceOver label give the row's full sentence.
- **Notices**: a conflict and a stopped Doc each show a notification once.
- **Palette**: Import from Google Docs…, Refresh from Google (the open file; it syncs a two-way Doc), Refresh All from Google, Save Google Doc as Word (the open file).
- **Recents**: a small page mark on cards of files that came from Google Docs.
- Light and dark follow the app's theme. Every control is a button, switch or checkbox to VoiceOver, with a label that names the Doc.

## How import behaves

- **Only the Docs the person picks.** Markie asks Google for the `drive.file` scope and nothing else. The Picker flow refuses any other scope, so this grant is separate from Markie Cloud sign-in.
- **On the Mac only.** The refresh token is kept in the Keychain under Markie's own service, "Markie Nightly Google" for the Mac app and "Markie RS Google" for the dev build. Google data never passes through Markie Cloud.
- **One file per Doc.** A Doc is written to `<import folder>/<title>.md`. A title that is taken gets " (2)", " (3)" and so on; Markie never overwrites a file that is not that Doc's own. Picking a Doc again updates its own file, and keeps its sync choices.
- **Tabs.** A Doc with several tabs becomes one file with a top-level heading per tab.
- **What converts.** Headings (Title is a top-level heading), paragraphs, bold, italic, strikethrough, links, bulleted, numbered and checked lists with nesting, tables, text in a monospace font as code, horizontal rules, footnotes, and images (see Images below). Underline, colours, fonts, links to headings, tables of contents and equations are dropped. Suggestions waiting in a Doc read as if accepted.
- **Folders.** If a picked folder doesn't give Markie access to the Docs in it, Markie says so and asks the person to pick the files themselves. Whether a folder pick covers its Docs is not documented by Google; the spike tool checks.
- **Refresh** (Refresh-only Docs). "Refresh from Google" re-reads a Doc only if it changed in Google. If the local file was edited since the last sync, Markie first keeps the local text beside it as `<name> (conflict 2026-11-25 14.03).md`, then writes Google's text. Nothing is sent to Google.
- **Save as Word.** Google's own `.docx` export, written beside the Markdown file. A later export replaces that copy. It is one-way. Google puts the Doc's images in it itself.
- **The Library.** The import folder is registered as a Library root after the first import.

## Images

Each image in a Doc is saved as a file beside the Doc's Markdown, so it still shows long after Google's own link expires (about half an hour). `crates/markie-google/src/images.rs`.

- **Where.** A folder beside the file, named after it when the first image arrives: `Field notes images/` for `Field notes.md`. A name already on disk, or used by another synced file in that folder, gets " (2)" and so on, so two Docs never share a folder.
- **Names.** Each file is named by its image's object ID, with an extension from the content type Google sends: `kix.abc123.png`. A pull that changes nothing writes nothing; a file whose bytes are the same is not touched.
- **The Markdown.** `![Sales by month](Field%20notes%20images/kix.abc123.png)`. The alt text is the image's description, or its title, or "Image". The path is percent-encoded so it has no space or bracket. That is the form markie-rich writes when it saves an image back, so an edit in Markie never changes the line, and the reader, the editor and PDF export all decode it. An image inside a line of text stays inline; the editor splits it onto its own line only if that paragraph is edited, which keeps it here, unsent.
- **When.** On import, on Refresh, and on every sync round that reads a Doc whose Drive version moved. A round that only sends Markie's edits downloads only images it has no file for. Google's link is fetched with no token, as Google documents it carries the reader's access itself, and only over https from Google's own hosts.
- **When a download fails** (offline, a 403, an expired link, something that isn't an image): a copy saved by an earlier sync stays in use; with no copy, that image is a link to Google, as before, until a later pull saves it. An image never fails the import or the round.
- **Removed in Google.** Its file is deleted, and the folder once nothing is left in it. Markie deletes only files the record says it wrote, only in that Doc's folder, and never one the Markdown still points at. A file someone else put in the folder keeps the folder.
- **Read-only for sync**, as before. Moving, deleting or editing an image line never sends anything to Google; the row says "Kept here, not sent: images". The Markdown last synced holds the same image lines as the file, so an image never reads as a change: no push, no conflict copy, no ping-pong.
- **Renaming the file** keeps its images: the folder keeps the name it was given, and links are relative to the file's folder. **Moving the file to another folder in Markie** takes its images folder along. Moving it outside Markie, in Finder for example, leaves the folder behind and its images stop showing.
- **Conflict copies** get their own folder (`Field notes (conflict 2026-11-26 10.15) images/`) with copies of the images they show, so a later pull can't take them away.

Unverified until a run against the real Google: that an image's `contentUri` downloads with no token, which hosts and redirects serve it, and which content types come back. If it needs more, images stay links, as before.

## How two-way sync behaves

- **When.** While Markie is open. A save of a synced file is sent about three seconds after the last save. Google is checked every minute and whenever the window comes to the front. Every minute Markie also reads each synced file, so an edit made by another app is sent too. A file with unsaved edits in the editor is never synced underneath them.
- **What goes to Google: a diff, never a replace.** Markie compares three versions block by block: the Markdown it last synced (kept in the registry), the file, and the Doc now. Blocks are paragraphs, headings and single list items, compared in a normalized form, so `*` or `-` bullets, `1.` or `3.` numbers, `__bold__` or `**bold**`, line wrapping, trailing spaces and loose or tight lists are never a change. Only what changed here becomes Docs requests: text typed or removed inside a paragraph is one insert and one delete on just those characters; bold, italic, strikethrough, links and code are restyled only where they differ; new blocks are inserted with their heading level, list kind and nesting; removed blocks are deleted. All of a Doc's requests go in one `documents.batchUpdate` with `writeControl.targetRevisionId`, so Google merges them with anything a collaborator typed meanwhile. Markie never calls `files.update` with content and never sends an empty `batchUpdate`. Everything Markdown can't show (comments, suggestions, images, page setup, colours) is in ranges Markie never touches, so it stays.
- **Checked before it goes.** Markie applies its requests to a model of the Doc first, reads that back through the converter, and sends a change only if the Doc would then say what the file says there. Anything else stays in the file, unsent, and the row names it.
- **What stays read-only, and says so.** Tables, images, footnotes, horizontal rules, equations, people and smart chips, page breaks and automatic text, subtitles, paragraphs with suggestions waiting in Google, ticking or unticking a checkbox (how Google stores a tick is unverified), an unticked item whose text is all struck through, a paragraph that is only code, two code blocks right next to each other (a Doc can't keep them apart), and Markdown a Doc has no place for (quotes, HTML, front matter, list items with several paragraphs). The file keeps these edits; the row says "Kept here, not sent: tables". Deleting such a block here doesn't delete it in Google either. A Doc with several tabs is read-only for sync ("Read only: has tabs"): Google's changes still come in, block by block.
- **What comes from Google.** After a write Markie reads the Doc again, so a collaborator's edit that Google merged in reaches the file too. Google's changes are spliced into the file around its own text, so the rest of the file keeps its exact bytes. Then the new base, `revisionId` and Drive `version` are stored. The next round finds nothing to do: no ping-pong.
- **Conflicts.** Changes to different paragraphs, even neighbouring ones, merge on both sides. When the same paragraph changed in both places, Google's text wins in the Doc and in the file, and Markie's version of the file is kept beside it as `<name> (conflict 2026-11-26 10.15).md`, with its own copies of its images, and in the file's History. The row and a notice say so; **Compare** opens the file's History page, where Markie's version before sync replaced it sits next to Google's text with changes highlighted. **Dismiss** clears the row; the copy stays. If a merge would leave Markdown that can't stand (a nested item without its parent), Google's text wins the same way.
- **Offline and errors.** Every failure leaves the file as it is. The network, a timeout, a server error or a 429 retry with backoff (5 seconds, doubling, up to 5 minutes); a 429 or no network pauses all sync for that long, honouring Retry-After. Markie sends at most 50 writes a minute, under Google's 60 per person. The row says "Waiting for connection" meanwhile. A revoked grant stops sync and asks to connect again.
- **Finding Google's changes.** Drive `changes.list`, from a start page token, every poll. Whether it lists `drive.file` picks is not documented, so Markie also checks each synced Doc's Drive `version` until it knows: a change `version` shows that `changes.list` should have listed (made after the token, before the list call) means it doesn't, and Markie then checks `version` every poll; a picked Doc that `changes.list` does list means it does, and Markie then checks `version` only every 15 minutes as a safety net. The answer is remembered (`google_docs.detect`).
- **Lifecycle.** A Doc moved to the trash or no longer shared stops syncing; the file stays and the row says why. A synced file deleted on this Mac is unlinked: nothing in Drive is trashed or changed. A synced file renamed or moved in Markie keeps its record and its images. Turning Sync both ways off makes it Refresh only. Disconnect stops all sync first, revokes the grant and keeps every file.
- **Suggestions.** For a Doc this account does not own but may edit or comment on, "Send my edits as suggestions" is on by default. Markie then writes with `writeControl.writeMode: "SUGGEST"` beside `targetRevisionId`, the shape Google's `batchUpdate` reference gives ("Apply all updates as suggestions"), reading the Doc with `suggestionsViewMode=SUGGESTIONS_INLINE`, the only view whose indices a write may use. The file shows the Doc as if every suggestion were accepted, so a sent suggestion is not a change; if the owner rejects it, Google's text comes back into the file. A comment-only Doc can only take suggestions (whether Google lets a commenter suggest through the API is unverified); a view-only Doc is read-only.

## Building with Google Docs on## Building with Google Docs on

The feature is compiled in from two environment variables, read when `markie-google` compiles (`crates/markie-google/src/config.rs`, `build.rs`):

| Variable | Meaning |
|---|---|
| `MARKIE_GOOGLE_DESKTOP_CLIENT_ID` | The Desktop OAuth client ID. Absent or empty: Google Docs is hidden. |
| `MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET` | The Desktop client's secret, if Google issued one. Google documents it as not confidential for installed apps. |

`rust/scripts/bundle-mac.sh` and `rust/scripts/nightly-release.sh` pass both through and print whether Google Docs is on, never the values. Neither value belongs in the repo, a log or a report.

### Setting up the client (Kirby, about 30 minutes)

1. In the Cloud project that holds Markie's sign-in client, enable the Google Drive API, the Google Docs API and the Google Picker API.
2. Create an OAuth client of type Desktop app.
3. On the consent screen, add only the `.../auth/drive.file` scope. It is non-sensitive, so no security assessment applies. Submit brand verification so the screen shows Markie's name and logo.

## The spike tool

Run once the client exists, before relying on the unverified points above:

```sh
MARKIE_GOOGLE_DESKTOP_CLIENT_ID=... [MARKIE_GOOGLE_DESKTOP_CLIENT_SECRET=...] \
  rust/scripts/google-spike.sh [--out <folder outside the repo>] [--write-test]
```

It opens the real Picker in the browser and prints a report:

1. whether the Picker flow works with a Desktop client and a loopback redirect, with no API key;
2. whether a picked folder's Docs are listed and readable, and, after it asks you to add a Doc to that folder, whether the new Doc is too;
3. for each picked Doc: tabs, images, what Markie dropped, each list's raw glyph settings (to confirm how checklists show), the first lines of Markie's Markdown and of Google's own Markdown export, and what the `.docx` export keeps (comments, tracked changes, images);
4. after it asks you to edit one picked and one unpicked Doc, whether `changes.list` shows only picked files.

Without `--write-test` it only reads from Google, keeps the grant in memory, and revokes it at the end. `--out` saves each Doc's JSON, Markie's Markdown and Google's exports for comparing by eye.

### The live write test (`--write-test`, opt-in)

5. It makes one new Doc of its own, "Markie sync test" (`documents.create`; `drive.file` covers files the app made), imports it two-way into a temporary folder and a registry in memory, and checks, printing PASS or FAIL for each:
   - **write from Markie**: headings, marks, a link, nested bullets, numbers, a checkbox and a code block, sent as requests and read back as the same Markdown; then how Google stores each list (glyph type and symbol), which settles the checklist question;
   - **no ping-pong**: the next round sends nothing;
   - **Google to Markie**: an edit made through the API comes into the file;
   - **merge with a collaborator**: an edit made between Markie's read and its write, merged by `targetRevisionId`, ends up in both the Doc and the file;
   - **conflict**: the same item edited both ways keeps Google's text and a conflict copy;
   - **suggestion mode**: an edit sent with `writeMode: SUGGEST` shows inline as a suggestion (on a Doc you own, which tells whether Google takes suggestions from the owner);
   - and whether `changes.list` lists the Doc after an edit.
6. It moves "Markie sync test" to the trash at the end, whatever happened (a metadata-only `files.update` with `{"trashed": true}`). If that fails it says so, to delete by hand.

It never writes to any other Doc: every call goes through a guard that refuses any Doc ID but the one it made. The same test runs against the fake Google in `markie-google`'s tests (`write_test::tests`), which also checks the guard.

What only this live test can confirm: that Google applies the requests the way its reference describes and the model follows (style inheritance on insert, bullets from leading tabs, joining the list before); how checklists and ticks are stored; that `targetRevisionId` merges a real collaborator's edit; that `SUGGEST` works on these requests and how suggestions read back; and whether `changes.list` lists `drive.file` files.

## For two-way sync: what is recorded

Each imported file has a record in the registry database (table `rs_google_docs`, `crates/markie-google/src/store.rs`): the Doc ID, title, the `revisionId` and Drive `version` last synced, the time, the `.docx` copy, the last error, the Markdown last synced as the merge base, and for sync: two-way on or off, suggestions on or off (and whether the person chose), what the account may do (owner, edit, comment), the reasons local edits stay unsent, the last conflict copy, why sync stopped, when Markie last sent edits, and the images folder's name with the files Markie wrote in it. Records from step one read as Refresh only.

Later, only if asked: sync on Markie Cloud for phone and web, multi-tab write-back, tables written back, comments shown in Markie.

## Where things are

| Part | Path |
|---|---|
| OAuth, PKCE, loopback, Picker URL | `rust/crates/markie-google/src/oauth.rs`, `connect.rs` |
| Keychain grant | `rust/crates/markie-google/src/tokens.rs` |
| Google calls | `rust/crates/markie-google/src/api.rs` |
| Docs to Markdown | `rust/crates/markie-google/src/convert.rs`, fixtures in `tests/fixtures/` |
| Import, refresh, conflict copies, Save as Word | `rust/crates/markie-google/src/import.rs` |
| Images saved beside the file, pruned, copied for conflict copies, moved with the file | `rust/crates/markie-google/src/images.rs` |
| Markdown blocks and normalized keys | `rust/crates/markie-google/src/md.rs` |
| Three-way block diff, merged file | `rust/crates/markie-google/src/merge.rs` |
| A Doc body as Docs indices see it, requests applied | `rust/crates/markie-google/src/model.rs` |
| Local edits to Docs requests, checked before sending | `rust/crates/markie-google/src/plan.rs` |
| One sync round, scheduler, change detection | `rust/crates/markie-google/src/sync.rs` |
| The sync thread | `rust/crates/markie-google/src/worker.rs` |
| The live write test | `rust/crates/markie-google/src/write_test.rs` |
| Tests: sync against the fake, the write-back property, images | `rust/crates/markie-google/tests/sync_flow.rs`, `tests/write_fuzz.rs`, `tests/images.rs` |
| Fake Google for tests and scenes | `rust/crates/markie-google/src/fake.rs` |
| Settings row, sync states and choices, sync thread in the app, title bar status, menu, palette, Recents mark, scene | `rust/crates/markie-app/src/workspace/google_docs.rs` (title bar: `chrome.rs`; save, focus and disk hooks: `workspace.rs`; moves: `projects.rs`) |
| Where an import becomes a Projects folder | `google_import_becomes_projects_folder` in `google_docs.rs` |
| Spike | `rust/scripts/google-spike.sh`, `rust/crates/markie-google/examples/google_spike.rs` |

Scenes: `scene.sh google <out.png> <light|dark> '{"connected":true,"importing":false,"waiting":false,"empty":false,"notice":"…"}'`; every sync state: `'{"states":true,"only":true}'`; the import choice unticked: `'{"two_way":false,"only":true,"rows":2}'`; the title bar status for the file on the command line: `'{"title":"synced"}'` (or `sending`, `waiting`, `conflict`, `suggesting`, `refresh`).

## Tests

All against the fake Google (`src/fake.rs`): revisions, `batchUpdate` with `targetRevisionId` moved past a collaborator's edit, `requiredRevisionId`, `writeMode: SUGGEST` with accept and reject, `changes.list` (and a switch that makes it miss picks), roles (owner, writer, commenter, reader), 429s with Retry-After, no network, trash and unshare, comment anchors that move with edits, `documents.create` and trash for the write test, and image bytes with a content type behind a freshly signed link on every read, with a switch that answers 403. No test reaches the real Google.

- `tests/write_fuzz.rs`: random Markdown of what sync supports and random edits to it, planned into requests, applied to the Doc model, read back: must equal the edited Markdown, as edits and as suggestions (accepted gives the edit, rejected the original). 400 and 150 seeds by default; `MARKIE_FUZZ_SEEDS=4000` passes.
- `tests/images.rs`: import saves each image and writes relative images; a second pull rewrites nothing; an image removed in Google loses its file, then the empty folder; only Markie's files are deleted; a failed download stays a link and a later pull saves it; text edited next to an image sends only the text; moving, deleting or editing an image line sends nothing; a conflict copy keeps its images; Refresh-only Docs and Docs with tabs; rename and move; two Docs never share a folder; the image line survives a markie-rich save byte for byte.
- `tests/sync_flow.rs`: the whole round against the fake, one test per behaviour above, and a property: random edits here and by a collaborator at once converge (file and Doc say the same) and the next round does nothing. 40 seeds by default; 500 pass.
- Unit tests for the parser, the diff and its conflict rule, the model, the planner, debounce, backoff, the write limit, focus, held files, detection, the record, and the row and title bar sentences in the app.
