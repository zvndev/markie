// One bridge request through the repo's own MCP agent client. Prints the
// reply, never the discovery credential.
import { readFileSync } from "node:fs";
const [repo, discovery, method, params] = process.argv.slice(2);
const { callBridge } = await import(`${repo}/mcp/agent-client.mjs`);
const info = JSON.parse(readFileSync(discovery, "utf8"));
try {
  const result = await callBridge(info, method, JSON.parse(params), { timeoutMs: 60_000 });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
