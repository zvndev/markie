// Run with a scratch HOME and MARKIE_RS_DATA_DIR after launching the bundled
// app. The caller holds SCREEN.md's lock because opening a file raises RS.
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { askMarkie, callBridge, findBridge } from "../../../../mcp/agent-client.mjs";

const data = process.env.MARKIE_RS_DATA_DIR;
assert.ok(data?.startsWith("/tmp/mrs-agent."), "scratch app profile required");
const dir = await realpath(join(data, "agent"));
const info = await findBridge({ dir });
assert.ok(info && info.app === "Markie RS" && info.socket === join(dir, "markie-rs.sock"), "scratch app bridge required");
const fixture = await realpath(join(homedir(), "reference.md"));
const skill = await realpath(join(homedir(), ".claude/skills/fixture/SKILL.md"));
const ask = (method, params) => askMarkie(method, params, {
  find: async () => info, launch: () => false,
  call: (bridge, method, params) => callBridge(bridge, method, params, { timeoutMs: 15000 }),
});
const status = await ask("cloud_status", { path: fixture });
assert.equal(status.syncState, "local");
assert.equal(status.privateLink, null);
console.log("Local Cloud status passed.");
assert.equal((await ask("history_note_write", { path: fixture, agent: "Fixture agent", sha256: "a".repeat(64) })).noted, true);
console.log("History note passed.");
await assert.rejects(ask("comments_list", { path: fixture }), /only in the Markie super-nightly/);
console.log("Stable comment gate passed.");
assert.match(await ask("open_in_markie", { path: skill }), /Opening .*SKILL\.md in Markie RS/);
console.log("Running Markie RS answered local Cloud status, history note, stable comment gate, and opened the scratch skill.");
