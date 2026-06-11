// Phase 9: drive the Markie MCP server over stdio like a real client.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

const child = spawn("node", ["mcp/markie-mcp.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
});
let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const toolText = (res) => res.result.content[0].text;

const results = {};

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "verify", version: "0" },
});
results.initialize = init.result.serverInfo.name === "markie-mcp";
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await rpc("tools/list");
results.toolCount = tools.result.tools.length;

const list = JSON.parse(toolText(await rpc("tools/call", { name: "list_docs", arguments: {} })));
results.listIncludesTestDoc = list.some((d) => d.path === "/tmp/collab-e2e.md");

const read = toolText(
  await rpc("tools/call", { name: "read_doc", arguments: { path: "/tmp/collab-e2e.md" } })
);
results.readDoc = read.includes("Collab E2E");

// write + insert round-trip on a scratch tracked file
writeFileSync("/tmp/mcp-scratch.md", "# Notes\n\n## Roadmap\n\nOld line.\n");
// track it by inserting into the registry through the tool surface: list_docs
// only reads, so use write_doc's tracked-file guard as the negative test first
const untracked = toolText(
  await rpc("tools/call", {
    name: "write_doc",
    arguments: { path: "/tmp/mcp-scratch.md", content: "x" },
  })
);
results.untrackedRejected = untracked.includes("Not in the Markie library");

// register it the way the app does (registry insert), then exercise the editors
const { createRequire } = await import("node:module");
const require = createRequire(new URL("../mcp/package.json", import.meta.url));
const Database = require("better-sqlite3");
const { homedir } = await import("node:os");
const db = new Database(`${homedir()}/Library/Application Support/Markie/registry.db`);
db.prepare(
  `INSERT INTO files (path, name, last_opened_at) VALUES (?, ?, ?)
   ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at`
).run("/tmp/mcp-scratch.md", "mcp-scratch.md", new Date().toISOString());
db.close();

const ins = toolText(
  await rpc("tools/call", {
    name: "insert_after_heading",
    arguments: { path: "/tmp/mcp-scratch.md", heading: "Roadmap", content: "- Ship Phase 9 via MCP" },
  })
);
results.insertAfterHeading =
  ins.includes("Inserted") &&
  readFileSync("/tmp/mcp-scratch.md", "utf8").includes("## Roadmap\n\n- Ship Phase 9 via MCP");

const search = JSON.parse(
  toolText(await rpc("tools/call", { name: "search_docs", arguments: { query: "phase 9 via mcp" } }))
);
results.search = search.some((h) => h.path === "/tmp/mcp-scratch.md");

console.log(JSON.stringify(results, null, 2));
child.kill();
process.exit(Object.values(results).every((v) => v === true || typeof v === "number") ? 0 : 1);
