import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { guardPath } from "../../../../mcp/lib.mjs";
import { askMarkie, callBridge, findBridge } from "../../../../mcp/agent-client.mjs";

const scratch = await realpath(process.argv[2]);
assert.equal(await realpath(homedir()), scratch, "test must not inspect the real home");
const dir = join(scratch, "agent");
const info = await findBridge({ dir });
assert.ok(info && info.app === "Markie RS" && info.socket === join(dir, "markie-rs.sock"), "scratch bridge discovery");
const p = join(scratch, "fixture.md");
assert.equal(guardPath(p, scratch, { formats: ["markdown"] }).ok, true);
const call = (info, method, params) => callBridge(info, method, params, { timeoutMs: 3000 });
assert.equal((await askMarkie("cloud_status", { path: p }, { find: () => findBridge({ dir }), call, launch: () => false })).method, "cloud_status");
assert.equal((await call(info, "cloud_sync", { path: p })).method, "cloud_sync");
for (const method of ["cloud_public_link", "cloud_revoke_public_link", "history_note_write", "open_in_markie"]) {
  assert.equal((await call(info, method, { path: p })).method, method);
}
for (const method of ["comments_list", "comments_add", "comments_reply", "comments_resolve"]) {
  await assert.rejects(call(info, method, { path: p }), /only in the Markie super-nightly/);
}
await assert.rejects(call({ socket: info.socket, token: "invalid" }, "cloud_status", {}), /Not authorized/);
await assert.rejects(call(info, "not_a_method", {}), /Unknown method/);

function raw(chunks) {
  return new Promise((resolve, reject) => {
    const socket = connect(info.socket);
    let reply = "";
    socket.on("connect", () => {
      socket.write(chunks[0]);
      if (chunks.length > 1) setTimeout(() => socket.write(chunks[1]), 30);
    });
    socket.on("data", (chunk) => { reply += chunk; });
    socket.on("close", () => resolve(JSON.parse(reply)));
    socket.on("error", (e) => reject(new Error(`raw frame, ${chunks.length} chunks, ${chunks[0].length} first bytes: ${e.code}`)));
    socket.setTimeout(2000, () => socket.destroy(new Error("raw socket timed out")));
  });
}
assert.equal((await raw(["{bad\n"])).error, "Bad request.");
assert.equal((await raw(["a".repeat(65537)])).error, "Request too large.");
const request = JSON.stringify({ token: info.token, method: "cloud_status" }) + "\n";
assert.equal((await raw([request.slice(0, 9), request.slice(9)])).result.method, "cloud_status");

const adapter = fileURLToPath(new URL("../mcp/markie-rs-mcp.mjs", import.meta.url));
async function runMcp(data, cases) {
  const child = spawn(process.execPath, [adapter], {
    env: { ...process.env, MARKIE_RS_DATA_DIR: data, MARKIE_RS_MCP_SERVER: "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const answers = lines[Symbol.asyncIterator]();
  const closed = once(child, "close");
  child.stdin.on("error", () => {}); // A premature exit is asserted below.
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    for (const [name, check] of cases) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { path: p } } }) + "\n");
      const { value } = await answers.next();
      assert.ok(value, "MCP server returned a response");
      check(JSON.parse(value).result);
    }
  } finally {
    child.stdin.end();
    lines.close();
    try {
      const [code] = await closed;
      assert.equal(code, 0, "MCP server exited successfully");
    } finally {
      clearTimeout(timer);
    }
  }
}
await runMcp(scratch, [
  ["markie_cloud_status", (r) => assert.match(r.content[0].text, /cloud_status/)],
  ["markie_open_in_markie", (r) => assert.match(r.content[0].text, /open_in_markie/)],
  ["markie_list_comments", (r) => assert.match(r.content[0].text, /only in the Markie super-nightly/)],
  ["markie_read_document", (r) => assert.match(r.content[0].text, /Scratch fixture/)],
]);
await runMcp(join(scratch, "no-bridge"), [
  ["markie_open_in_markie", (r) => { assert.equal(r.isError, true); assert.match(r.content[0].text, /Markie RS isn't running/); }],
]);
