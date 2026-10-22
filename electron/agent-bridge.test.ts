import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const { createAgentBridge } = require("./agent-bridge.js");

// Unix socket paths are capped near 104 bytes, so keep the directory short.
const tmp = () => fs.mkdtempSync(path.join("/tmp", "mab-"));
const bridges: Array<{ stop: () => void }> = [];
afterEach(() => { while (bridges.length) bridges.pop()!.stop(); });

function ask(socket: string, line: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const c = net.connect(socket);
    let buf = "";
    c.setEncoding("utf8");
    c.on("connect", () => c.write(line + "\n"));
    c.on("data", (d) => { buf += d; });
    c.on("close", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    c.on("error", reject);
  });
}

describe.skipIf(os.platform() === "win32")("agent bridge", () => {
  it("advertises itself to this user only and answers a request carrying its token", async () => {
    const dir = path.join(tmp(), ".markie");
    const bridge = createAgentBridge({ dir, instance: "abc123", info: { app: "Markie", version: "1.0.0" }, handlers: { echo: async (p: { x: number }) => ({ got: p.x }) } });
    bridges.push(bridge);
    await bridge.start();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(bridge.discoveryPath).mode & 0o777).toBe(0o600);
    const info = JSON.parse(fs.readFileSync(bridge.discoveryPath, "utf8"));
    expect(info).toMatchObject({ socket: bridge.socketPath, app: "Markie", version: "1.0.0", pid: process.pid });
    expect(await ask(bridge.socketPath, JSON.stringify({ token: info.token, method: "echo", params: { x: 7 } }))).toEqual({ ok: true, result: { got: 7 } });
  });

  it("refuses a caller without the token, an unknown method, and garbage", async () => {
    const bridge = createAgentBridge({ dir: path.join(tmp(), ".markie"), instance: "def456", handlers: { echo: async () => "no" } });
    bridges.push(bridge);
    await bridge.start();
    expect(await ask(bridge.socketPath, JSON.stringify({ token: "wrong", method: "echo" }))).toEqual({ ok: false, error: "Not authorized." });
    expect(await ask(bridge.socketPath, JSON.stringify({ token: bridge.token, method: "toString" }))).toMatchObject({ ok: false });
    expect(await ask(bridge.socketPath, "{not json")).toEqual({ ok: false, error: "Bad request." });
  });

  it("returns a handler's refusal as the error, and cleans up only its own files", async () => {
    const dir = path.join(tmp(), ".markie");
    const bridge = createAgentBridge({ dir, instance: "aa11", handlers: { fail: async () => { throw new Error("The user declined."); } } });
    await bridge.start();
    expect(await ask(bridge.socketPath, JSON.stringify({ token: bridge.token, method: "fail" }))).toEqual({ ok: false, error: "The user declined." });
    bridge.stop();
    expect(fs.existsSync(bridge.discoveryPath)).toBe(false);
    expect(fs.existsSync(bridge.socketPath)).toBe(false);
  });

  it("starts over a socket a crashed run left behind", async () => {
    const dir = path.join(tmp(), ".markie");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent-bb22.sock"), "stale");
    const bridge = createAgentBridge({ dir, instance: "bb22", handlers: { ping: async () => "pong" } });
    bridges.push(bridge);
    await bridge.start();
    expect(await ask(bridge.socketPath, JSON.stringify({ token: bridge.token, method: "ping" }))).toEqual({ ok: true, result: "pong" });
  });
});
