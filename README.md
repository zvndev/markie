# Markie

**The Google Docs of Markdown — except your files live on your Mac.** Free, native, Apple Silicon.

[![Markie](https://markie.zvndev.com/markie-demo-poster.jpg)](https://markie.zvndev.com)

Markie is a desktop markdown app that gets out of your way: a clean editor with
live preview, a device-wide index of every markdown file you own, painless
sharing, and a built-in [MCP](https://modelcontextprotocol.io) server so any AI
agent — Claude Code, Codex, or a local model — can find, read, and write your
markdown right alongside you.

## Features

- **Editor + live preview** — edit, preview, or split view; GitHub-flavored
  markdown, tables, code highlighting, and KaTeX math.
- **Browse** — a device-wide index of every `.md` on your Mac, so your notes and
  docs are one search away.
- **Agent & skill files** — surfaces `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  `~/.claude/skills`, `~/.codex`, and Cursor rules, grouped by tool.
- **Sharing** — share a doc via a public link or by email; recipients open it in
  one click, no account required.
- **Markie MCP** — let Claude Code / Codex work with your markdown (see below).

## Install

Download for **Apple Silicon macOS** (M-series). The app is signed and notarized
by Apple, and updates itself automatically.

➡️ **[Download Markie](https://markie.zvndev.com)**

> Apple Silicon only. Intel Macs are not supported.

## The Markie MCP

Markie ships a dependency-free [MCP](https://modelcontextprotocol.io) server that
gives **any** AI agent — Claude Code, Codex, or a local model — a markdown
workspace on *your* machine: `markie_find_md`, `markie_read_md`, `markie_write_md`,
`markie_list_skills`, and `markie_open_in_markie`. It runs entirely locally — no
cloud, no API key. Reads/writes are fenced to markdown under your home folder
(symlink-guarded), so an agent can *"find my notes and add a section"* and actually
do it. Published standalone as [`@zvndev/markie-mcp`](https://www.npmjs.com/package/@zvndev/markie-mcp).

**Claude Code — plugin (easiest):**

```
/plugin marketplace add zvndev/markie
/plugin install markie@markie
```

**Claude Code — or add the server directly:**

```bash
claude mcp add markie -- npx -y @zvndev/markie-mcp
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.markie]
command = "npx"
args = ["-y", "@zvndev/markie-mcp"]
```

**Any other MCP client / local model** — run `npx -y @zvndev/markie-mcp` over stdio
and point your client (or local-model MCP bridge) at it.

(The installed app also bundles the server; the in-app **Agents** dialog shows the
exact path and copy-paste commands. See [`mcp/README.md`](./mcp/README.md) for details.)

## Build from source

Requires Node ≥ 22.

```bash
npm install
npm run electron:dev     # run the app in development
npm run electron:pack    # build an unsigned .app into dist/mac-arm64/
```

Other scripts: `npm run build` (Next static export), `npm test` (renderer +
Electron unit tests), `node --test mcp/lib.test.mjs` (MCP tests).

## Tech

Electron · Next.js (static export) · React · TypeScript · Tailwind · TipTap ·
CodeMirror · a unified/remark/rehype render pipeline.

## License

[MIT](./LICENSE) © ZVN
