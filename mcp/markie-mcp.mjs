#!/usr/bin/env node
// Markie MCP server (stdio): lets Claude Code & friends browse and edit
// the local Markie library. Speaks MCP over newline-delimited JSON-RPC.
//
// Claude Code registration:
//   claude mcp add markie -- node /path/to/markie-mcp.mjs
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const REGISTRY = join(
  homedir(),
  "Library/Application Support/Markie/registry.db"
);

function db() {
  if (!existsSync(REGISTRY)) {
    throw new Error("Markie registry not found — open Markie once first");
  }
  return new Database(REGISTRY, { readonly: false });
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ---- tools ----

const TOOLS = [
  {
    name: "list_docs",
    description:
      "List every document Markie knows about: name, absolute path, sync state, last opened time. Cloud-synced docs include their cloud id.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_doc",
    description: "Read a document from the Markie library by absolute path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute file path" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_doc",
    description:
      "Replace a Markie document's content on disk (the running app picks changes up on reopen). Keeps the registry hash in sync.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "Full new markdown content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "insert_after_heading",
    description:
      "Insert markdown right after a heading line in a Markie document. The heading matches by its text, any level (e.g. 'Roadmap' matches '## Roadmap').",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        heading: { type: "string", description: "Heading text to find" },
        content: { type: "string", description: "Markdown to insert after it" },
      },
      required: ["path", "heading", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "search_docs",
    description:
      "Search the contents of every tracked Markie document for a string (case-insensitive). Returns matching lines with paths and line numbers.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Text to find" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function requireTracked(database, path) {
  const row = database
    .prepare("SELECT * FROM files WHERE path = ?")
    .get(path);
  if (!row) {
    throw new Error(
      `Not in the Markie library: ${path} — use list_docs to see tracked files`
    );
  }
  return row;
}

function runTool(name, args) {
  const database = db();
  try {
    switch (name) {
      case "list_docs": {
        const rows = database
          .prepare(
            "SELECT path, name, sync_state, cloud_doc_id, last_opened_at FROM files ORDER BY last_opened_at DESC"
          )
          .all();
        return rows.map((r) => ({
          ...r,
          exists: existsSync(r.path),
        }));
      }
      case "read_doc": {
        requireTracked(database, args.path);
        return readFileSync(args.path, "utf8");
      }
      case "write_doc": {
        requireTracked(database, args.path);
        writeFileSync(args.path, args.content, "utf8");
        database
          .prepare("UPDATE files SET content_hash = ? WHERE path = ?")
          .run(sha256(args.content), args.path);
        return `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`;
      }
      case "insert_after_heading": {
        requireTracked(database, args.path);
        const lines = readFileSync(args.path, "utf8").split("\n");
        const target = args.heading.trim().toLowerCase();
        const idx = lines.findIndex(
          (l) => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === target
        );
        if (idx === -1) throw new Error(`Heading not found: ${args.heading}`);
        lines.splice(idx + 1, 0, "", args.content.replace(/\n$/, ""));
        const next = lines.join("\n");
        writeFileSync(args.path, next, "utf8");
        database
          .prepare("UPDATE files SET content_hash = ? WHERE path = ?")
          .run(sha256(next), args.path);
        return `Inserted after "${lines[idx]}" (line ${idx + 1}) in ${args.path}`;
      }
      case "search_docs": {
        const q = args.query.toLowerCase();
        const rows = database
          .prepare("SELECT path, name FROM files ORDER BY last_opened_at DESC")
          .all();
        const hits = [];
        for (const r of rows) {
          if (!existsSync(r.path)) continue;
          const lines = readFileSync(r.path, "utf8").split("\n");
          lines.forEach((line, i) => {
            if (line.toLowerCase().includes(q)) {
              hits.push({ path: r.path, line: i + 1, text: line.trim().slice(0, 200) });
            }
          });
        }
        return hits.slice(0, 100);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } finally {
    database.close();
  }
}

// ---- MCP plumbing (newline-delimited JSON-RPC over stdio) ----

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
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
          serverInfo: { name: "markie-mcp", version: "0.1.0" },
        },
      });
    } else if (method === "notifications/initialized") {
      // notification — no response
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const out = runTool(params.name, params.arguments ?? {});
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
