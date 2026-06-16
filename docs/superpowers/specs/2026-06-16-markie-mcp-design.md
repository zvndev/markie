# Markie MCP server — design

**Date:** 2026-06-16
**Status:** Approved

## Goal

Give an agent (Claude Code, Codex, etc.) markdown-aware access to the files on
this Mac through an MCP server, so an agent can find, read, write, and open the
user's markdown — especially skill/agent files (`~/.claude/skills`, `~/.codex`,
`CLAUDE.md`, `AGENTS.md`) and existing notes/docs.

## Scope

- **Local markdown workspace only.** No cloud, no account, no auth.
- Reuses Markie's existing device-wide scan logic so what the agent sees matches
  the app's Browse/Skills panels exactly (same exclusions, same allowlist).
- Ships runnable from the repo today and bundled into the app for release.

Out of scope: cloud docs / sharing / public links (deliberately — filesystem
access is the chosen surface); writing outside `~`; non-macOS "open in Markie".

## Architecture

A standalone **ESM Node MCP server** at `mcp/server.mjs`, stdio transport, built
on the official `@modelcontextprotocol/sdk` + `zod` for input schemas.

- `mcp/lib.mjs` — pure, dependency-light helpers (path guard, query match, skill
  classification). Unit-tested in isolation.
- `mcp/server.mjs` — registers the tools and wires them to `lib` + the scanner.
- Reuses `electron/mdindex.js` (CommonJS, already pure, no electron imports) via
  a default import: `import mdindex from "../electron/mdindex.js"` → uses
  `mdindex.walk(home, { home })`, `shouldDescend`, `isExcludedDir`,
  `EXCLUDED_NAMES`. esbuild inlines it for the bundled build; Node's CJS interop
  resolves it in dev.
- `classifyAgentFile` (~10 lines) is duplicated into `mcp/lib.mjs` with a comment
  pointing at the canonical `src/lib/agent-files.ts`; a unit test asserts the
  same cases. (Too small to justify a shared build step across TS/ESM.)

## Tools

| Tool | Input | Behaviour |
|---|---|---|
| `markie_find_md` | `query: string`, `limit?: number` | Scan device markdown; return path/name/dir matches (name+path substring, case-insensitive), newest first. Caches the scan for the process lifetime; first call walks `~`. |
| `markie_read_md` | `path: string` | Read a markdown file's UTF-8 contents. Must pass the read guard (md extension, under `~`, not excluded). |
| `markie_write_md` | `path: string`, `content: string` | Create/overwrite a markdown file. Must pass the **write guard**. Creates missing parent dirs only within an already-allowed tree. |
| `markie_list_skills` | — | List agent/skill files grouped by tool (Claude / OpenAI·Codex / Gemini / Cursor), via `classifyAgentFile` over the scan. |
| `markie_open_in_markie` | `path: string` | Open the file rendered in Markie (`open -a Markie <path>` on darwin). |

### Path guard (`lib.isAllowedMarkdownPath`, `lib.assertWritable`)

- Resolve to an absolute, normalized path.
- Extension ∈ `.md` / `.markdown` / `.mdx`.
- Path is under the user's home dir.
- No path segment (relative to home) is an excluded dir name (`node_modules`,
  `tmp`, `temp`, dot-dirs, …) — reuses `mdindex.isExcludedDir`, except the
  allowlisted skill roots (`~/.claude/skills`, `~/.codex`) are permitted even
  though they sit under a dot-dir.
- Read uses the same guard minus the "must already exist" relaxation; write
  additionally refuses to create a brand-new directory tree outside an allowed
  parent.

Tools return MCP `isError: true` text on guard failure rather than throwing, so
the agent gets a clear, actionable message.

## Packaging & wiring

- **Dev:** `node mcp/server.mjs` runs against the live repo (`../electron/...`).
- **Release:** an esbuild step bundles `mcp/server.mjs` (+ inlined mdindex +
  SDK) into a single `mcp/dist/server.mjs`; electron-builder `extraResources`
  copies `mcp/dist/` to `Contents/Resources/mcp/`. The server needs only a
  system `node` on PATH (the target user is a developer).
- **Main process** gains a `mcp-info` IPC returning
  `{ serverPath, nodePath, packaged }`. `serverPath` =
  `process.resourcesPath/mcp/server.mjs` when packaged, else
  `<appPath>/mcp/server.mjs`. Exposed through preload as `mcpInfo()`.

## Agents button + modal

- Activity bar gains an **Agents** icon button at the bottom-left, above the
  keyboard-shortcuts button.
- It opens a modal (`agents-dialog.tsx`) with:
  - a one-paragraph "what this gives your agent" blurb + the tool list;
  - **Claude Code** copy block: `claude mcp add markie -- node <serverPath>`;
  - **Codex** copy block: a `~/.codex/config.toml` `[mcp_servers.markie]` entry;
  - a copy button per block; the `<serverPath>` is filled from `mcpInfo()` (a
    sensible placeholder when running on the web/dev).

## Testing

- `mcp/lib.test.mjs` (node:test): path guard (allow/deny matrix incl. excluded
  segments + allowlisted skill roots), query match, `classifyAgentFile` parity.
- A scripted **live stdio smoke test**: spawn the server, send `initialize` +
  `tools/list` + a `tools/call` for `markie_find_md`, assert a well-formed
  response. Run manually during the build (not in CI to avoid walking `~`).
- `mcp/package.json` `test` script wired to the node:test file; vitest stays
  scoped to `src/` + `electron/`.

## Release

Bundle with the Shared-tabs work into **0.2.5**: build → notarize → publish to
B2 → verify feed → push `main` + tag.
