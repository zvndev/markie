# Vision — Markie

> Immutable. Human edits only. Every wakeup re-reads this first; it overrides everything else.

## What this is
Markie is a native desktop markdown workspace: fast editor, live rich view, device-wide markdown
index, sharing, collaboration, comments, theme sync, and a built-in MCP surface for local AI agents.
It should feel like the Google Docs of Markdown while keeping the user's files on their machine and
making cloud features optional. It should ship first-class builds for Apple Silicon Macs, Intel
Macs, Windows, and Linux from a clear download page.

## Who it's for
Markie is for writers, developers, researchers, and AI-agent users who keep important work in
Markdown and want a polished local app instead of a browser-first notes silo. The core job is to
open, edit, browse, share, and automate markdown files without losing local ownership.

## What "good" looks like
A user can install Markie on their desktop platform, open or find a markdown file, edit it in View
or source mode, save/export/share it, and use agent tooling around it without account friction. Both
dark and light mode must be legible across the app. A feature is done only when its user journey is
reproduced and the relevant renderer, Electron, MCP, server, packaging, or visual checks pass.

## Non-goals (do NOT build toward these)
- Do not turn Markie into a proprietary cloud-first document silo; local mode must remain useful
  without an account.
- Do not make the ZVN home server part of the serving path for other users' documents.
- Do not replace Markdown as the source of truth for local files.
- Do not add paid-tier, billing, or lock-in features unless explicitly requested.
