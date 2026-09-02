# Changelog

All notable changes to Markie are recorded here. Entries are written for the
people using the app, not for the diff.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] - 2026-08-28

### Fixed

- **The left rail says what each button is, straight away.** The rail is a
  column of icons, and the one that opens Projects is a grid that looks like
  nothing in particular. It always carried its name, but through the tooltip
  the operating system draws after about a second of hovering, which is longer
  than it takes to click. The name appears immediately now, on hover and on
  keyboard focus. Projects is `Shift-Command-L`, and the Library is
  `Command-L`.

## [0.5.0] - 2026-08-26

### Added

- **Projects: your markdown organized the way you actually work.** Markie now
  groups every markdown file it can see into projects, and each project into
  blocks of work, without moving a single file on disk. The grouping is
  Markie's own, laid over your files wherever they already live, so you get an
  organized workspace without reorganizing your computer.
- **Projects is its own place in the left rail, two levels deep.** The index
  fills the window with every project, most recently updated first. Open one
  to see its blocks and files, and a back chevron, a breadcrumb, Command-Up,
  and Escape all walk you back out. The search field scopes itself to wherever
  you are and shows which, so a search inside a project stays inside it.
- **Folders that keep themselves current.** Updated today, in the last three
  days, and in the last week are there from the start, and you can add your
  own to `Projects.md` by naming a time window, a path pattern, or both. They
  are views rather than containers: a folder shows its files grouped by the
  project each one still belongs to, and every heading walks into that
  project. Nothing is moved, copied, or duplicated.
- **Make and rename projects.** Call a project what you actually call it, or
  start an empty one before its first file exists. A rename changes only what
  you read: pins, blocks, and assignments keep pointing exactly where they
  did, and nothing on disk is touched.
- **`Projects.md`, an organization file you can edit.** Your rules live in a
  real markdown document in your Markie folder, so you can open it, read it,
  and change how your work is grouped. Match paths to projects, pin a file
  somewhere it would not land on its own, or rename and merge blocks in the
  app and have those choices stick. A broken rule falls back to the last
  version that worked and tells you, rather than emptying your view.
- **Blocks are named after work, not dates.** A block called
  `checkout-redesign` says what it is; one called `2026-08-26` only says when
  it was filed. Files written close together become a block named for the work
  itself, and you can rename any of them.
- **File history with diffs.** Every save keeps a version, stored inside
  Markie rather than beside your file, so your folders stay clean. Open the
  history for any document to see what changed line by line, who changed it,
  and restore any version. Recent history is kept in full and older versions
  thin out over time.
- **Agents file their own writing.** The bundled MCP server now tells any
  connected agent what Markie is, which tool to use when, and how to declare
  where a document belongs. Claude Code, Codex, and any other MCP client get
  the same guidance, so documents an agent writes land in the right project
  and block as they are created.
- **Windows updates itself.** The signed Windows build has been downloadable
  since 0.4.2 but could never update. It now checks for and installs updates
  the way the Mac build does.

### Changed

- **Markie saves as you type.** Edits land on disk about a second after you
  stop typing, the way a document editor should. Command-S still works and
  simply saves now rather than later. Switching files, opening a new one,
  closing the window, and quitting all finish the save first.
- **Nothing is lost if Markie stops unexpectedly.** Unsaved work is journaled
  as you type, so a crash or a force quit offers your text back on the next
  launch.
- **Rich mode no longer rewrites the rest of your file.** Editing one
  paragraph now leaves every other line exactly as it was, byte for byte:
  your front matter, footnotes, raw HTML, comments, table alignment, and your
  own line wrapping all survive. In the rare document Markie cannot promise to
  reproduce, rich editing waits and tells you why, and Source is always
  available and always exact.
- **The Library is Recent and Folders, with nothing nested inside either.**
  Picking Files and then picking Projects inside it is gone; Projects has the
  left rail to itself now, and the panel spends its rows on your files instead
  of on where you are.
- **File names come first in every list.** Rows used to open with the whole
  absolute path, so forty of them began with the same forty characters before
  reaching the word that told them apart. The name leads now, the folder
  follows it quietly, and the full path is still on the row and copyable from
  its menu.
- **Cards and panels have visible edges in both themes.** Borders were close
  to invisible in dark mode and faint in light; both now meet a real contrast
  floor. Documents were given their own, much quieter rule at the same time,
  so heading underlines and table borders read as typography rather than as
  panel edges.
- **`markie_list_skills` stopped reporting noise.** It was listing thousands of
  cached plugin copies the app itself hides. It now shows the agent files you
  actually wrote.
- **`markie_find_md` will not walk forever.** The agent-facing search now
  respects the same limits the app's own index has always had, and says so
  when a result set was cut short instead of quietly looking empty.

### Fixed

- **Security: a shared document could be claimed by the wrong person.**
  Sharing a document with an email address that had no account yet left the
  invitation waiting. Anyone who registered that address first inherited the
  document, because signing up did not require proving you own the address.
  Verification is now required before any pending share is claimed, on every
  path that could claim one. Existing accounts are unaffected. If you have
  shared anything to an address that had not yet signed up, this closes it.
- Signing up with a password and then confirming your address no longer
  discards that password.
- Signing in with an unverified address, or signing up with one, now leads
  somewhere instead of a dead end.

### Security

- Updated `better-auth` (account takeover via pre-account hijacking on
  emailed-code sign-in) and `@hono/node-server` (an unauthenticated memory
  leak reachable through the collaboration socket).

## [0.4.1] - 2026-08-24

### Added

- **Resize the library panel.** Drag its right edge to make the Files, Browse,
  Shared, and Skills panel wider or narrower (200–520px); Markie remembers
  your width between launches. Double-click the edge to reset it, or focus it
  and use the arrow keys (Shift for bigger steps, Home/End for the limits).
- **Intel Mac download.** The notarized Intel build has shipped in every
  release alongside Apple Silicon but was never linked; `/download/mac-intel`
  now redirects to it and `/download/latest.json` lists both. Windows and
  Linux remain packaging-only.
- **Crash log.** Every crash, hung window, or failed background action is
  written to a log you can open from Help → Reveal Crash Log and attach to a
  bug report.
- **Snapshots and Revert.** Every save over an existing file first keeps a
  copy of what was there (20 per file, 200 MB total, oldest pruned). File →
  Revert to Snapshot… opens that file's snapshot folder; picking one loads it
  into the window as unsaved changes, so nothing touches the disk until you
  decide to save.
- **A real welcome document on first launch.** First run opens a short
  markdown file that explains Markie in its own format and never asks for an
  account, instead of a fictional sample document. Double-clicking a `.md`
  file still goes straight to that file.
- **Sign in where it matters.** The sign-in surfaces (Google, an emailed
  code, or a password) now live in one place with a reason for the prompt,
  and appear inline where you hit them: the Share dialog and the Library's
  sync prompt sign you in without bouncing you through Settings. Forgot your
  password? A code resets it.
- **Opt-in crash reports.** Off by default. When you turn it on in Settings →
  Advanced, a crash sends a scrubbed report (paths, your home folder, and
  document names are stripped before anything leaves the machine); turning it
  back off stops it immediately.
- **Beta update channel.** Settings → Advanced can opt this install into beta
  releases and back out again; leaving beta walks you back down to the current
  stable build. The channel is in-app only and unlisted.

### Changed

- **Viewers can comment.** Anyone who can read a shared document can now
  start a comment thread and reply. Resolving and reopening threads stays
  with editors, and deleting someone else's comment stays with the owner. A
  viewer whose access is revoked mid-session loses the comment box instead
  of keeping one that silently fails.

### Fixed

- **A locked-out user and an invited stranger can get back in.** A forgotten
  password is recovered with an emailed code, and the reset and code requests
  are rate limited. An invite link now names the address it was sent to, so
  the reader knows which account claims the document.
- **A crash in one part of the app no longer blanks the whole window.** Markie
  shows what went wrong, with Reload and Copy details buttons; a renderer that
  dies is caught by the main process and offered a reload. Your file on disk is
  never touched.
- **Markie stopped re-scanning your whole home folder every twenty seconds.**
  Once Browse had been opened, every return to the window triggered two full
  walks of `~` — including iCloud-synced Desktop & Documents, Dropbox, Google
  Drive, OneDrive, photo and music libraries, and app bundles. That load is the
  most likely cause of the Finder and system slowdowns seen while Markie was
  open. Markie now skips cloud-synced and bundle folders (folders you add as
  workspace roots are always indexed), scans only while the Browse or Skills
  panel has asked for it and at most once every five minutes, caps each scan,
  and never triggers a second scan for an answer it already had.
- **Opening a shared document whose access changed no longer does nothing.**
  A revoked share, a deleted document, an expired session, or a proxy error
  page used to be swallowed: the click did nothing, or the menu stuck open, or
  the window went blank. Markie now says what happened, always closes the
  menu, and the server answers JSON on every API route so the app can show a
  reason.
- **Opening a second document while a live session was running no longer
  leaves the first document's session attached.** The previous file's text
  could be saved into the new file's path.
- **A shared document whose access is removed mid-session now says so** and
  stops reconnecting, instead of retrying several times a second forever. A
  viewer no longer seeds an empty room with their local copy.
- **PDF export was rebuilt.** Large documents no longer produce a blank file
  or take the app down; the export waits for fonts and layout to finish
  instead of guessing; it gives up with a clear message instead of hanging; a
  second export can't start on top of the first; and failures are reported
  instead of silently doing nothing. Math in exported PDFs and HTML now renders
  correctly — the KaTeX stylesheet and fonts are embedded.
- **Exporting or saving immediately after typing writes what's on screen**,
  not the version from a moment earlier.
- **Save As writes the format the name you chose promises**, even when you
  change the extension in the dialog, and warns before a CSV save would leave
  content outside the first table out of the file.
- **A malformed document can no longer take down the preview or an export.**
  If markdown fails to render, Markie shows the source text instead.
- **Printing (⌘P) no longer prints the sidebars, toolbars, terminal, and find
  bar** around a clipped page; the document prints full-width. ⌘P now goes
  through the same pipeline as PDF export, so long documents print every page
  with their images, and dismissing the system print dialog cancels cleanly.
- **A crash mid-save can no longer destroy a file.** Every write to one of
  your files lands in a temporary file beside it first and replaces the
  original only after the data is fully on disk. Finder tags and other
  metadata survive on macOS. Known tradeoff: a file that is a hard link
  becomes an independent copy on save.
- **Exports carry the document's images.** Images referenced by relative
  paths are embedded into PDF and HTML exports (10 MB per image, 30 MB
  total; only files inside the document's own folder are read).
- **Two people opening the same shared document can no longer double its
  content.** The server lets only one connection seed an empty room, and the
  app waits for the first sync before seeding at all. Documents record a
  schema version so a future format change is detected instead of silently
  mixing.
- **Closing the terminal panel now closes its shells** instead of leaving them
  running in the background; open shells are capped.
- **Markie no longer launches to a blank window** when the file it was asked
  to open can't be read, and a `markie://` link that can't be opened shows a
  message instead of nothing.
- **The conflict dialog no longer re-compares the document on every keystroke
  behind it**, and "Keep both" rescues exactly the copy it counted.
- **"Shared by me" shows an error with a retry** instead of claiming you
  haven't shared anything when the request fails. Browse and Skills do the
  same instead of spinning forever.
- **Renaming or moving a folder whose name contains `_` or `%`** no longer
  repoints unrelated files in the library.
- **Markie degrades with a clear message instead of crashing** when its local
  database can't load; checking whether Markie is your default Markdown app is
  cached and can no longer hang.
- **Exported HTML no longer carries `javascript:` links.** The export pipeline
  now runs the same sanitizer the web share pages use, while keeping code
  highlighting and math markup intact.
- **Hiding the terminal no longer kills its shells** — the panel is hidden,
  not torn down; shells are closed only when the window closes.
- **Windows:** Markie uses your real Documents folder (including OneDrive),
  accepts folder and file names Windows can store, treats differently-cased
  paths as the same file, no longer draws a second title bar over its own,
  hides macOS-only menu items, unpacks the terminal's support files correctly,
  registers and removes the `markie://` handler on install/uninstall, and the
  "open in Markie" MCP action actually opens Markie.
- **An update that fails to install now says so.** "Restart & update" could sit
  on "Restarting…" forever with nothing to click and no explanation, because an
  error while quitting stopped Markie from quitting at all: the installer then
  waited on an app that was never going to close, and the update silently never
  landed. Markie now reports the failure, offers "Try again", and notices when
  the restart has not happened.
- **A logging failure can no longer take down the main process.** The update
  system wrote its progress through a channel that can fail, and a failed write
  raised an error big enough to put a JavaScript error dialog on screen mid
  install. Log writes are now allowed to fail quietly, and an unexpected error
  is recorded instead of interrupting you with a stack trace.

## [0.3.2] - 2026-08-14

### Added

- **Find and replace** (`⌘F`, and `⌥⌘F` to replace), in the Edit menu and the
  command palette. `⌘F` used to do nothing at all in Rich, which is the mode
  Markie opens in: find existed, but only inside the Markdown Source editor,
  behind its own separate search box. There is now one bar, and it works in
  whichever pane you are reading. `⏎` and `⇧⏎` step through the matches, `⌘G`
  steps from anywhere, and the count tells you where you are. Match case and
  whole word are both there, and the search text is taken literally, so looking
  for `a.b` or `$5 (approx)` finds exactly that.
- Replace changes one match, and Replace All changes the rest, each in a single
  undo. Read-only shares can be searched but not rewritten.
- Searching the Rich pane finds phrases that run through formatting. "quick
  brown" is found even when only "quick" is bold, which is one document to you
  and two pieces of text to the editor. Each pane searches what it is actually
  showing: the heading marker `#` is real text in Source and is not in Rich.

### Fixed

- **Open now starts in the folder you are already working in.** Pressing Open
  while reading a document dropped you wherever a file dialog was last used,
  which was usually somewhere unrelated, so finding the file next to the one on
  screen meant navigating back every time. The picker now opens beside the
  current document.

## [0.3.1] - 2026-08-11

### Security

- **Sharing a document no longer makes it publicly readable.** Inviting someone
  who did not have a Markie account created a public link for the document as a
  side effect, and that link kept working for anyone who had the URL even after
  you removed the person. Invites now carry a link addressed to one recipient.
  It opens one document, it is checked against that person's access every time
  it is used, and it stops working the moment you remove them. Public links are
  still available, but only when you deliberately create one.

### Fixed

- **Share emails now contain something to click.** Sharing with someone who
  already had an account sent them a note saying they were "in", with no link
  to the document and nothing to do but go and look for it. The email now has
  two buttons: read it on the web, or open it straight in Markie, where it
  arrives in the Library synced and live rather than as a detached copy.
- **Every share link that was emailed pointed at a page that did not exist.**
  The website served nothing at the address the links used, so "Read it right
  now" answered with a 404. The link and the page agree now.

### Added

- **Reveal in Finder** (`⌥⌘R`), in the File menu and the command palette, opens
  the folder containing the document you are reading with the file selected, so
  you can drag it into another app. Called "Show in Explorer" on Windows and
  "Show in File Manager" on Linux.

## [0.3.0] - 2026-08-11

### Security

- An AI agent writing through the MCP server can no longer be redirected out of
  your home folder by a symbolic link. A link pointing at a file that did not
  exist yet was treated as an ordinary new document, which allowed a write to
  any path, under any file extension, while reporting the harmless path back.
  Cloning an untrusted repository into your home folder was enough to set one up.
- Signing in with Google now verifies that the sign-in came from your copy of
  Markie. The app mints a single-use code before opening your browser and only
  accepts the account that comes back carrying it, so a web page cannot hand
  Markie an account you did not ask for. Sign-in codes are good for ten minutes
  and cannot be reused.
- **Read-only shares are now read-only everywhere.** Someone given view-only
  access could still type into a shared document, in either editing pane, with
  nothing on screen explaining that their edits would never reach you. The panes
  also disagreed with each other: the Source pane locked for everyone during a
  live session, including the people who were allowed to edit. Access is now
  resolved once, from the server, and every pane obeys it. Viewers see a strip
  saying who shared the document, with "Make a copy" to work on their own.
- **Removing someone from a shared document takes effect immediately.** Their
  live connection is closed as soon as you revoke access. It used to be checked
  only when they first connected, so an open session kept working.

### Added

- **Markie tells you when a document has changed somewhere else.** If another
  device or another person has moved a document on, a line appears above it
  offering to bring the change down. When nothing of yours is at stake that is
  one click. When both copies changed, you get a choice that says what it costs
  first, in lines: "Pulling replaces 8 lines of yours and brings in 12 from the
  server." You can keep both, which saves your version beside the original under
  its own name and then takes theirs, or pull and overwrite. Keep both is the
  default, because it is the only one that cannot lose work.
- Documents are checked for updates when you open one, when you come back to the
  window, and once a minute while you are looking at it. Nothing is checked while
  Markie is in the background.
- A **Retry backup** button on any document whose last upload failed. That state
  was visible in your Library but there was no way to act on it.

### Changed

- The editing modes are now **Rich**, **Source**, and **Split**. The mode called
  "View" was a full editor, so the name was telling you the opposite of what it
  did. `⌘1`, `⌘2`, and `⌘3` are unchanged.
- **Markie takes up less than half the space it used to.** The installed app is
  down from 590.7 MB to 285.7 MB, and the download from 209.2 MB to 123.0 MB.
  The app was shipping its entire build toolchain, which nothing at runtime ever
  loaded.
- The MCP server now reports the shipped version during the handshake instead of
  a hardcoded one, and the Claude Code plugin manifest moves with each release.

### Fixed

- **Share works from everywhere, and explains itself.** It used to answer three
  different situations with three unrelated surfaces: signed out opened
  Settings, an unsynced file silently opened the Library, and a synced file
  opened the real dialog only if a background check happened to finish. When
  that check failed, Share stopped responding entirely until you restarted.
  There is now one "Share this document" dialog that says what is missing and
  offers the button that fixes it, including "Sync and share" in one step.
  `Share…` also stays in the command palette instead of disappearing exactly
  when you go looking for it.
- **The Recent list stops rearranging itself.** Opening a file used to send it
  to the top, so every other row shifted the moment you clicked. The order now
  holds still while the panel is open, and files that appear while you are
  looking are added at the top. Recent also has a filter box.
- **Saving no longer overwrites changes made by something else.** If a file
  changed on disk since you opened it, which happens constantly when an agent is
  working in the same folder, Markie now asks whether to reload it or overwrite
  it. It used to write straight over the newer file with no warning.
- **Opening a file no longer rewrites it.** Markie used to re-serialize every
  document the moment it loaded, which quietly mangled YAML front matter, raw
  HTML, footnotes, and math, and marked the file as edited before you touched
  it. `SKILL.md`, `CLAUDE.md`, and `AGENTS.md` files were hit hardest. Files now
  open byte for byte as they are on disk.
- **Markie no longer claims a document is backed up when it is not.** A failed
  upload left the Library still reporting "Synced", which also put "Take cloud"
  one click away from replacing your work with an older copy the server never
  accepted. Failed uploads are now marked, and taking the cloud copy is refused
  while local changes have not reached it.
- Pressing `⌘/` with the cursor in the source editor no longer comments out the
  current line. It used to open the shortcuts dialog *and* silently wrap your
  text in `<!-- -->`, so edits happened without you noticing.
- Pressing Escape while renaming a file no longer performs the rename it was
  meant to cancel.

## [0.2.11] - 2026-07-21

### Fixed

- Files open again from every list. Clicking a file in Recent, Browse, or Skills
  opens it even when it lives outside your workspace folder.
- The side panel stays open when you open a file, so you can move from file to
  file without reopening it each time.
- Share works right after you sync. The button now checks the document's live
  sync state and lights up as soon as "Sync to cloud" finishes.
- Entries for files deleted from disk are removed from your library
  automatically. Documents synced to your cloud are kept and marked missing, so
  the cloud copy is never lost.

## [0.2.10] - 2026-07-13

### Fixed

- Distributed disk images carry verifiable Apple tickets, so Gatekeeper accepts
  them reliably offline.

## [0.2.9] - 2026-07-13

### Changed

- Desktop navigation made dependable across platforms, and Windows installers
  carry the correct native modules.

[Unreleased]: https://github.com/zvndev/markie/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/zvndev/markie/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/zvndev/markie/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/zvndev/markie/compare/v0.2.11...v0.3.0
[0.2.11]: https://github.com/zvndev/markie/compare/v0.2.9...v0.2.11
[0.2.10]: https://github.com/zvndev/markie/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/zvndev/markie/releases/tag/v0.2.9
