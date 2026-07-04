# Markie

**The Google Docs of Markdown — except your files live on your machine.** Native desktop markdown.

[![Markie](https://markie.zvndev.com/markie-demo-poster.jpg)](https://markie.zvndev.com)

Markie is a desktop markdown app that gets out of your way: a clean editor with
live preview, a device-wide index of every markdown file you own, painless
sharing, and a built-in [MCP](https://modelcontextprotocol.io) server so any AI
agent — Claude Code, Codex, or a local model — can find, read, and write your
markdown right alongside you.

## Features

- **Editor + live preview** — edit, preview, or split view; GitHub-flavored
  markdown, tables, code highlighting, and KaTeX math.
- **Browse** — a device-wide index of every `.md` on your machine, so your notes and
  docs are one search away.
- **Agent & skill files** — surfaces `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  `~/.claude/skills`, `~/.codex`, and Cursor rules, grouped by tool.
- **Sharing** — share a doc via a public link or by email; recipients open it in
  one click, no account required.
- **Markie MCP** — let Claude Code / Codex work with your markdown (see below).

## Install

The current public download is **Apple Silicon macOS**. The source tree now has
local packaging configuration for Apple Silicon macOS, Intel macOS, Windows x64,
and Linux x64; signed public artifacts for the new targets are still release
work. Server download routes are backed by `server/download-manifest.json` so
planned platforms stay visible without pointing to unpublished files.

➡️ **[Download Markie](https://markie.zvndev.com)**

> Public Windows, Intel Mac, and Linux downloads are not published yet.

## The Markie MCP

Markie ships a dependency-free [MCP](https://modelcontextprotocol.io) server that
gives an AI agent a markdown workspace on *your* machine: `markie_find_md`,
`markie_read_md`, `markie_write_md`, `markie_list_skills`, and
`markie_open_in_markie`. It runs entirely locally — no cloud, no API key.
Reads/writes are fenced to markdown under your home folder (symlink-guarded), so an
agent can *"find my notes and add a section"* and actually do it.

**Claude Code — plugin (easiest):**

```
/plugin marketplace add zvndev/markie
/plugin install markie@markie
```

**Codex or any other MCP client** — point it at the bundled server. The installed
app's **Agents** dialog shows the exact command; it looks like:

```toml
# ~/.codex/config.toml
[mcp_servers.markie]
command = "node"
args = ["/Applications/Markie.app/Contents/Resources/mcp/markie-mcp.mjs"]
```

(Running from source instead? Use `node /path/to/markie/mcp/markie-mcp.mjs`.)

## Build from source

Requires Node ≥ 22.

```bash
npm install
npm run electron:dev     # run the app in development
npm run electron:pack    # build an unsigned local macOS app
npm run electron:pack:mac:arm64
npm run electron:pack:mac:x64
npm run electron:pack:win
npm run electron:pack:linux
npm run electron:smoke:mac:arm64
npm run electron:smoke:mac:x64
npm run electron:smoke:win
npm run electron:smoke:win:launch # Windows host only
npm run electron:smoke:linux
```

The local pack/build scripts use a certificate-free electron-builder wrapper and
pass `--publish never`; `npm run electron:release` is the only Developer ID
signing/publishing path. The Windows unpacked package also installs the matching
Electron `better-sqlite3` Windows prebuild before `electron:smoke:win` runs.
Native Windows launch evidence is handled by `electron:smoke:win:launch` or the
`Windows launch smoke` workflow on `windows-latest`; it is not claimed from a
Mac structure check.
After cross-architecture local packaging, the wrapper restores the development
`better-sqlite3` native module for your current Electron host. If Library or
Files ever get stuck after packaging, run `npm run native:restore`.

Other scripts: `npm run build` (Next static export), `npm test` (renderer +
Electron unit tests), `node --test mcp/lib.test.mjs` (MCP tests), and
`npm run release:preflight` (safe local release-readiness checks, no publishing).

## Tech

Electron · Next.js (static export) · React · TypeScript · Tailwind · TipTap ·
CodeMirror · a unified/remark/rehype render pipeline.

## License

[MIT](./LICENSE) © ZVN
