#!/usr/bin/env node
// Markie MCP server (stdio): a device-wide markdown workspace for AI agents.
// Lets Claude Code, Codex & friends find, read, write, and open the markdown on
// this Mac — notes, docs, and agent/skill files (~/.claude/skills, ~/.codex,
// CLAUDE.md, AGENTS.md, …). Speaks MCP over newline-delimited JSON-RPC.
//
// Dependency-free pure Node. Reuses Markie's device index (electron/mdindex.js)
// so it sees exactly what the app's Browse/Skills panels see.
//
// Register with Claude Code:
//   claude mcp add markie -- node /path/to/markie-mcp.mjs
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { guardPath, matchQuery, groupSkills } from "./lib.mjs";
import { walk } from "./scan.mjs";

const HOME = homedir();

// Cache the device scan for the process lifetime; writes invalidate it so new
// files surface in the next find.
let _scan = null;
async function scan() {
  if (!_scan) _scan = await walk(HOME, { home: HOME });
  return _scan;
}

// ---- tools ----

const TOOLS = [
  {
    name: "markie_find_md",
    description:
      "Find markdown files anywhere on this Mac (matches name or path, case-insensitive), newest first. Leave query empty to list everything. Mirrors what Markie's Browse panel shows.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match in the name or path" },
        limit: { type: "number", description: "Max results (default 50, max 500)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "markie_read_md",
    description: "Read a markdown file's contents by absolute path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_write_md",
    description:
      "Create or overwrite a markdown file. Only .md/.markdown/.mdx under your home folder, never inside excluded dirs (node_modules, tmp, hidden dirs except the skill roots). Markie picks up changes on reopen.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, ~ allowed" },
        content: { type: "string", description: "Full new markdown content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "markie_list_skills",
    description:
      "List the agent/skill instruction files on this Mac (CLAUDE.md, AGENTS.md, GEMINI.md, ~/.claude/skills, ~/.codex, .cursor rules), grouped by tool. Great for finding and editing skills.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "markie_open_in_markie",
    description: "Open a markdown file rendered in the Markie app.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path, ~ allowed" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

async function runTool(name, args) {
  switch (name) {
    case "markie_find_md": {
      const rows = await scan();
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
      const hits = rows
        .filter((r) => matchQuery(r, args.query))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit)
        .map((r) => ({ path: r.path, name: r.name, dir: r.dir }));
      return { count: hits.length, files: hits };
    }
    case "markie_read_md": {
      const g = guardPath(args.path, HOME);
      if (!g.ok) throw new Error(g.error);
      return await readFile(g.path, "utf8");
    }
    case "markie_write_md": {
      const g = guardPath(args.path, HOME, { mode: "write" });
      if (!g.ok) throw new Error(g.error);
      const body = String(args.content ?? "");
      // The guard already vetted every ancestor segment (under home, no excluded
      // dirs), so creating missing parents stays inside an allowed tree.
      await mkdir(dirname(g.path), { recursive: true });
      await writeFile(g.path, body, "utf8");
      _scan = null; // new file should show up in the next find
      return `Wrote ${Buffer.byteLength(body)} bytes to ${g.path}`;
    }
    case "markie_list_skills": {
      const rows = await scan();
      return groupSkills(rows).map((grp) => ({
        tool: grp.label,
        files: grp.files.map((f) => ({ path: f.path, name: f.name })),
      }));
    }
    case "markie_open_in_markie": {
      const g = guardPath(args.path, HOME);
      if (!g.ok) throw new Error(g.error);
      try {
        await stat(g.path);
      } catch {
        throw new Error(`No such file: ${g.path}`);
      }
      const child = spawn("open", ["-a", "Markie", g.path], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      return `Opening ${g.path} in Markie`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- MCP plumbing (newline-delimited JSON-RPC over stdio) ----

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "markie-mcp", version: "0.2.0" },
        },
      });
    } else if (method === "notifications/initialized") {
      // notification — no response
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const out = await runTool(params.name, params.arguments ?? {});
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: typeof out === "string" ? out : JSON.stringify(out, null, 2),
            },
          ],
        },
      });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        },
      });
    }
  }
});
