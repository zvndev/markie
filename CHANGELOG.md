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

### Fixed

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
