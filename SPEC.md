# Spec — Markie

## Overview
Markie is maintained as a working native desktop markdown application with a local-first core and
optional cloud collaboration. The durable feature ledger is the checkable definition of done; this
file is the human-readable companion that explains the product surface future runs should preserve.

## Canonical user journeys
1. As a local user, I can open a `.md`, `.markdown`, `.mdx`, or `.csv` file from Finder or inside
   Markie, edit it in the appropriate surface, save it, and see the on-disk file update.
2. As a power user, I can browse indexed markdown files, use keyboard-first commands, inspect
   document stats, export/share a document, and keep working without signing in.
3. As a signed-in user, I can sync/share a document, collaborate live, comment on selections, and
   preserve local ownership and safe conflict handling.
4. As an AI-agent user, I can point Codex, Claude Code, or another MCP client at Markie's local MCP
   server and safely find/read/write markdown within the allowed local scope.
5. As a desktop user, I can download the correct Markie build for Apple Silicon macOS, Intel macOS,
   Windows, or Linux from a clear download page.

These journeys are the backbone of `feature_list.json` acceptance `steps[]`.

## Current state (snapshot; agent may append observations)
- Runs today: Electron + Next renderer, local editor/rich view, file lifecycle, library/sync,
  sharing, collaboration, comments, theming, MCP server, and server test suites exist in the repo.
- Known broken / flaky: none confirmed during initialization. Future wakeups must treat failing
  `./init.sh` as a repair-only run.
- Aspirational / not yet built: context-aware terminal phases from
  `docs/superpowers/specs/2026-06-12-markie-upcoming-features.md`, deeper MCP/current-document
  affordances, complete light-mode polish, cross-platform desktop packaging/downloads, React Native
  planning, release hardening, and recurring QA/security/product review findings.

## Out of scope
Markie should not become cloud-first, paid-tier driven, or a non-Markdown storage system. External
deployments, credential rotation, notarization, billing, and major API/design decisions are reserved
for human checkpoints.
