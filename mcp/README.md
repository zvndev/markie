# @zvndev/markie-mcp

A **local, dependency-free [MCP](https://modelcontextprotocol.io) server** that gives any
AI agent a markdown workspace on *your* machine — find, read, and write the `.md`
files you already have. Nothing leaves your computer; there is no cloud, no API key,
no account.

It's the same server that ships inside [**Markie**](https://markie.zvndev.com), the
markdown app for macOS — but the server is plain Node and works on its own with any
MCP-capable client: **Claude Code**, **Codex**, or a **local model** wired up through
an MCP bridge.

## What it does

| Tool | Description |
|---|---|
| `markie_find_md` | Find markdown anywhere under your home folder (name/path match, newest first). |
| `markie_read_md` | Read a markdown file by path. |
| `markie_write_md` | Create or overwrite a markdown file. |
| `markie_list_skills` | List agent/skill files — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `~/.claude/skills`, `~/.codex`, Cursor rules — grouped by tool. |
| `markie_open_in_markie` | Open a file in the Markie app *(macOS, requires Markie installed)*. |

So an agent can say *"find my Tokyo notes and add a Day 3 section"* and actually do it —
locate the file, read it, and write the change back, all on disk.

## Install

### Claude Code

```bash
claude mcp add markie -- npx -y @zvndev/markie-mcp
```

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.markie]
command = "npx"
args = ["-y", "@zvndev/markie-mcp"]
```

### Any other MCP client / local model

Run it over stdio:

```bash
npx -y @zvndev/markie-mcp
```

Then point your client (or your local-model MCP bridge) at that command. It speaks
MCP over newline-delimited JSON-RPC on stdin/stdout.

> Prefer no global install? `npx` fetches and runs it on demand. Requires **Node ≥ 18**.

## Safety

Reads and writes are deliberately fenced in:

- **Markdown only** — `.md`, `.markdown`, `.mdx`.
- **Home folder only** — paths are `realpath`-canonicalized first, so a symlink can't
  escape your home directory.
- **No vendored/system noise** — `node_modules`, build output, and hidden dirs are
  skipped (except the agent/skill roots `~/.claude/skills` and `~/.codex`, which are
  read-only — agents can't write skill files).

## Part of Markie

`markie_open_in_markie` opens files in the [Markie](https://markie.zvndev.com) desktop
app (free, Apple Silicon macOS). The other four tools work anywhere Node runs.

## License

[MIT](https://github.com/zvndev/markie/blob/main/LICENSE) © ZVN
