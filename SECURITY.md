# Security Policy

## Supported versions

Markie auto-updates, and only the latest release receives fixes. The current
released version is shown on <https://markiedocs.com/download>.

## Reporting a vulnerability

Please report privately rather than in a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/zvndev/markie/security/advisories/new), or
- email **security@zvndev.com**

Please include what you found, how to reproduce it, and what an attacker could
do with it. A proof of concept helps but is not required.

Expect an acknowledgement within a few days. Once a fix ships you are welcome to
disclose publicly, and you will be credited in the release notes unless you
prefer otherwise.

## What is in scope

Markie is a local-first desktop app with an optional cloud service, so the
interesting boundaries are:

- **The Electron sandbox**: anything that lets renderer content read or write
  files outside the granted set, escape the `app://` origin, or reach Node.
- **The MCP server** (`mcp/`): it is the filesystem boundary an AI agent writes
  through. Escapes from the home directory, symlink tricks, or writes to
  excluded paths are the highest-value findings in this repo.
- **Markdown rendering**: script execution from a malicious `.md`, whether in
  the app, in an exported file, or on a public share page.
- **The sharing service** (`server/`): reading or modifying a document you were
  not granted access to, share-token guessing, or auth bypass.
- **Deep links** (`markie://`): anything a web page can trigger in the app
  without the user's intent.
- **The update channel**: anything that would let an attacker serve a build.

## Out of scope

- Vulnerabilities requiring an already-compromised machine or an attacker who
  can already write arbitrary files to your home directory.
- Findings in the build and development toolchain that do not reach a shipped
  artifact (`npm audit` reports against `electron-builder` and friends).
- Missing hardening headers on marketing pages with no user data.

## Handling of your data

Markie stores your documents on your machine. Cloud sync, sharing, and comments
are opt-in and only apply to documents you explicitly sync. Local-only use never
requires an account.
