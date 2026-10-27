# Vision: Markie

> Immutable. Human edits only. Every agent reads this first; it overrides everything else.

## What this is
Markie is a native desktop markdown workspace: fast editor, live rich view, device-wide document
index, sharing, collaboration, comments, theme sync, and a built-in MCP surface for AI agents.
It should feel like the Google Docs of Markdown while keeping the user's files on their machine and
making cloud features optional. Markdown comes first, and Markie also opens the documents people
keep beside it: plain text, Word, RTF and OpenDocument, and Darkmown `.wd` interactive documents.
It ships first-class builds for Apple Silicon Macs, Intel Macs, Windows, and Linux from one clear
download page.

Markie Cloud is the optional layer on top: sync, private and public links, and agent tokens with a
hosted MCP so an agent that is not on the user's computer can still hand them a document. The
Markie Docs phone app opens those cloud documents on iOS and Android.

## Who it's for
Markie is for writers, developers, researchers, and AI-agent users who keep important work in
Markdown and want a polished local app instead of a browser-first notes silo. The core job is to
open, edit, browse, share, and automate markdown files without losing local ownership.

## What "good" looks like
A user can install Markie on their desktop platform, open or find a markdown file, edit it in View
or source mode, save/export/share it, and use agent tooling around it without account friction. Both
dark and light mode must be legible across the app. A feature is done only when its user journey is
reproduced and the relevant renderer, Electron, MCP, server, mobile, packaging, or visual checks
pass.

## Non-goals (do NOT build toward these)
- Do not turn Markie into a proprietary cloud-first document silo; local mode must remain useful
  without an account.
- Do not make the ZVN home server part of the serving path for other users' documents.
- Do not replace the user's own files as the source of truth for local documents. A markdown file
  stays markdown and an Office file stays in its own format. Markie Cloud only holds what the user,
  or an agent they authorized, puts there.
- Do not add paid-tier, billing, or lock-in features unless explicitly requested.
