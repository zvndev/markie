# Google Docs in Markie RS

Step one of Google Docs sync: connect a Google account, pick Docs in Google's Picker, and import them one way as Markdown. Two-way sync comes next and builds on what this step records.

Status, 2026-11-25: built and tested against a fake Google. It is hidden until Kirby creates the Desktop OAuth client and a build carries it. Nothing has run against the real Google yet; the spike tool below does that.

## What a person sees

- **File › Import from Google Docs…**, and the same command in the palette. It opens Settings › Files and sends the browser to Google's consent page with the Picker on it. The person picks Docs, or a folder, and comes back to Markie.
- **Settings › Files › Google Docs**:
  - "Connect Google Docs" when not connected; the account's email, "Import from Google Docs…" and "Disconnect" when connected;
  - the import folder, `~/Documents/Markie/Google Docs` by default, with "Change…";
  - progress while Markie waits for the pick or imports ("Importing 2 of 4: Trip plan…"), with Cancel;
  - every synced Doc: its title, its file and when it last synced, or what went wrong, with Refresh and Save as Word, and Refresh All above the list.
- **Palette**: Import from Google Docs…, Refresh from Google (the open file), Refresh All from Google, Save Google Doc as Word (the open file).
- **Recents**: a small page mark on cards of files that came from Google Docs.
- Light and dark follow the app's theme.

## How it behaves

- **Only the Docs the person picks.** Markie asks Google for the `drive.file` scope and nothing else. The Picker flow refuses any other scope, so this grant is separate from Markie Cloud sign-in.
- **On the Mac only.** The refresh token is kept in the Keychain under Markie's own service, "Markie Nightly Google" for the Mac app and "Markie RS Google" for the dev build. Google data never passes through Markie Cloud.
- **One file per Doc.** A Doc is written to `<import folder>/<title>.md`. A title that is taken gets " (2)", " (3)" and so on; Markie never overwrites a file that is not that Doc's own. Picking a Doc again updates its own file.
- **Tabs.** A Doc with several tabs becomes one file with a top-level heading per tab.
- **What converts.** Headings (Title is a top-level heading), paragraphs, bold, italic, strikethrough, links, bulleted, numbered and checked lists with nesting, tables, text in a monospace font as code, horizontal rules, footnotes, and images as links. Underline, colours, fonts, links to headings, tables of contents and equations are dropped. Image links point at Google and stop working after about half an hour.
- **Folders.** If a picked folder doesn't give Markie access to the Docs in it, Markie says so and asks the person to pick the files themselves. Whether a folder pick covers its Docs is not documented by Google; the spike tool checks.
- **Refresh.** "Refresh from Google" re-reads a Doc only if it changed in Google. If the local file was edited since the last sync, Markie first keeps the local text beside it as `<name> (conflict 2026-11-25 14.03).md`, then writes Google's text. Nothing is ever sent back to Google in this step.
- **Errors.** A Doc that was trashed or unshared keeps its local file, and its row says why. A revoked grant asks the person to connect again.
- **Save as Word.** Google's own `.docx` export, written beside the Markdown file. A later export replaces that copy. It is one-way.
- **The Library.** The import folder is registered as a Library root after the first import.
- **Disconnect** revokes the grant at Google and removes the Keychain item. Imported files stay.

## Building with Google Docs on

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
  rust/scripts/google-spike.sh [--out <folder outside the repo>]
```

It opens the real Picker in the browser and prints a report:

1. whether the Picker flow works with a Desktop client and a loopback redirect, with no API key;
2. whether a picked folder's Docs are listed and readable, and, after it asks you to add a Doc to that folder, whether the new Doc is too;
3. for each picked Doc: tabs, images, what Markie dropped, each list's raw glyph settings (to confirm how checklists show), the first lines of Markie's Markdown and of Google's own Markdown export, and what the `.docx` export keeps (comments, tracked changes, images);
4. after it asks you to edit one picked and one unpicked Doc, whether `changes.list` shows only picked files.

It only reads from Google, keeps the grant in memory, and revokes it at the end. `--out` saves each Doc's JSON, Markie's Markdown and Google's exports for comparing by eye.

## For two-way sync

Each imported file has a record in the registry database (table `rs_google_docs`, `crates/markie-google/src/store.rs`): the Doc ID, title, the `revisionId` and Drive `version` last synced, the time, the `.docx` copy, the last error, and the Markdown last synced as the merge base.

Still to build:

- write-back: a paragraph three-way diff of base, local and remote, turned into `insertText`, `deleteContentRange` and paragraph style requests in one `batchUpdate` with `targetRevisionId` (never `files.update` with content);
- change detection: `changes.list` polled every 60 seconds while Markie is open and on focus, confirmed by `version`, plus local saves from the file watcher;
- conflicts at paragraph level, shown in the version diff view, in place of whole-file conflict copies;
- suggestion mode (`writeMode: SUGGEST`) for Docs owned by someone else;
- record moves when a synced file is renamed or moved in Markie (`store::move_path` exists, not yet called);
- multi-tab Docs stay read-only for sync in v1.

## Where things are

| Part | Path |
|---|---|
| OAuth, PKCE, loopback, Picker URL | `rust/crates/markie-google/src/oauth.rs`, `connect.rs` |
| Keychain grant | `rust/crates/markie-google/src/tokens.rs` |
| Google calls | `rust/crates/markie-google/src/api.rs` |
| Docs to Markdown | `rust/crates/markie-google/src/convert.rs`, fixtures in `tests/fixtures/` |
| Import, refresh, conflict copies, Save as Word | `rust/crates/markie-google/src/import.rs` |
| Fake Google for tests and scenes | `rust/crates/markie-google/src/fake.rs` |
| Settings row, menu, palette, Recents mark, scene | `rust/crates/markie-app/src/workspace/google_docs.rs` |
| Where an import becomes a Projects folder | `google_import_becomes_projects_folder` in `google_docs.rs` |
| Spike | `rust/scripts/google-spike.sh`, `rust/crates/markie-google/examples/google_spike.rs` |

Scene: `scene.sh google <out.png> <light|dark> '{"connected":true,"importing":false,"waiting":false,"empty":false,"notice":"…"}'`.
