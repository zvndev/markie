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

> **Discovery (2026-06-16):** an MCP server already exists at
> `mcp/markie-mcp.mjs` (committed `4f2a1b9`, on `main`). It is **registry-scoped**
> — it reads `~/Library/Application Support/Markie/registry.db` via
> `better-sqlite3`, so it only sees docs the user has *opened* in Markie. We
> **upgrade this file in place** to the device-wide design rather than adding a
> parallel server, and **drop the `better-sqlite3` dependency**, which makes the
> server **dependency-free pure Node**. Its hand-rolled newline-delimited
> JSON-RPC stdio loop already works and is kept (no `@modelcontextprotocol/sdk`,
> no `zod`, no esbuild — simpler and nothing to bundle).

`mcp/markie-mcp.mjs` — the upgraded ESM stdio server (keeps the existing JSON-RPC
loop; swaps the registry-backed tools for device-wide ones).

- `mcp/lib.mjs` — pure helpers (path guard, query match, skill classification,
  grouping). Unit-tested in isolation.
- Reuses `electron/mdindex.js` (CommonJS, already pure, no electron imports) via
  `createRequire`: `require("../electron/mdindex.js")` → uses
  `mdindex.walk(home, { home })`, `isExcludedDir`, `allowlist`, `EXCLUDED_NAMES`.
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

Because the server is now dependency-free, packaging is just a file copy — no
bundler, no `node_modules`.

- **Dev:** `node mcp/markie-mcp.mjs` runs against the live repo
  (`../electron/mdindex.js`, `./lib.mjs`).
- **Release:** electron-builder `extraResources` copies `mcp/markie-mcp.mjs` +
  `mcp/lib.mjs` to `Contents/Resources/mcp/` and `electron/mdindex.js` to
  `Contents/Resources/electron/mdindex.js`, preserving the `../electron`
  relative layout so the imports resolve unchanged. Needs only a system `node`
  on PATH (the target user is a developer).
- **Main process** gains a `mcp-info` IPC returning `{ serverPath, packaged }`.
  `serverPath` = `process.resourcesPath/mcp/markie-mcp.mjs` when packaged, else
  `<appPath>/mcp/markie-mcp.mjs`. Exposed through preload as `mcpInfo()`.

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
- A scripted **live stdio smoke test**: spawn `mcp/markie-mcp.mjs`, send
  `initialize` + `tools/list` + a `tools/call` for `markie_find_md`, assert a
  well-formed response. Run manually during the build (not in CI to avoid
  walking `~`).
- `mcp/package.json` `test` script wired to the node:test file; vitest stays
  scoped to `src/` + `electron/`.

## Release

Bundle with the Shared-tabs work into **0.2.5**: build → notarize → publish to
B2 → verify feed → push `main` + tag.
