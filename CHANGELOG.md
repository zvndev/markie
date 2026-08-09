# Changelog

All notable changes to Markie are recorded here. Entries are written for the
people using the app, not for the diff.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed

- The editing modes are now **Rich**, **Source**, and **Split**. The mode called
  "View" was a full editor, so the name was telling you the opposite of what it
  did. `⌘1`, `⌘2`, and `⌘3` are unchanged.

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
- Pressing `⌘/` with the cursor in the source editor no longer comments out the
  current line. It used to open the shortcuts dialog *and* silently wrap your
  text in `<!-- -->`, so edits happened without you noticing.

### Changed

- The MCP server now reports the shipped version during the handshake instead of
  a hardcoded one, and the Claude Code plugin manifest moves with each release.

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

[Unreleased]: https://github.com/zvndev/markie/compare/v0.2.11...HEAD
[0.2.11]: https://github.com/zvndev/markie/compare/v0.2.9...v0.2.11
[0.2.10]: https://github.com/zvndev/markie/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/zvndev/markie/releases/tag/v0.2.9
