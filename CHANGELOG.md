# Changelog

All notable changes to Markie are recorded here. Entries are written for the
people using the app, not for the diff.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
