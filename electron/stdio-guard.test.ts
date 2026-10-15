import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CommonJS main-process module: load it the way main.js does.
const load = createRequire(import.meta.url);
const { guardStdio, isBrokenPipeError } = load("./stdio-guard.js");
const here = path.dirname(fileURLToPath(import.meta.url));

// The same shape as main.js: an uncaughtException handler that writes the
// error to the console. The parent closes the child's stdout and stderr before
// the child writes one stray line to stderr, which is what a terminal or WSL
// going away looks like from inside Markie.
const CHILD = `
  const [guardPath, mode] = process.argv.slice(1);
  const { guardStdio, isBrokenPipeError } = require(guardPath);
  if (mode === "fixed") guardStdio();
  let calls = 0;
  process.on("uncaughtException", (error) => {
    calls++;
    if (mode === "fixed" && isBrokenPipeError(error)) return;
    try { console.error("uncaughtException:", error); } catch {}
  });
  setTimeout(() => process.stderr.write("one stray line\\n"), 200);
  setTimeout(() => {
    require("fs").writeSync(3, String(calls));
    process.exit(0);
  }, 700);
`;

function handlerCallsAfterPipeCloses(mode: "unguarded" | "fixed"): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", CHILD, path.join(here, "stdio-guard.js"), mode], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    child.stdout!.destroy();
    child.stderr!.destroy();
    let out = "";
    const report = child.stdio[3] as NodeJS.ReadableStream;
    report.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(Number(out)));
  });
}

describe("guardStdio", () => {
  it("adds a standing error listener to each stream", () => {
    const streams = [new EventEmitter(), new EventEmitter()];
    guardStdio(streams);
    for (const stream of streams) {
      expect(stream.listenerCount("error")).toBe(1);
      expect(() => stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
    }
  });

  it("skips streams that are missing", () => {
    expect(() => guardStdio([null, undefined, {}])).not.toThrow();
  });
});

describe("isBrokenPipeError", () => {
  it("matches a dead console write and nothing else", () => {
    expect(isBrokenPipeError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isBrokenPipeError(new Error("boom"))).toBe(false);
    expect(isBrokenPipeError(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe(false);
    // A dropped network connection is a real crash worth printing, not a dead console.
    expect(isBrokenPipeError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
    expect(isBrokenPipeError("EPIPE")).toBe(false);
  });
});

describe("a closed stdout/stderr", () => {
  it("loops the crash handler without the guard", async () => {
    // Pins the failure the guard exists for: if Node ever stops looping here,
    // this test says so instead of the fix quietly guarding nothing.
    expect(await handlerCallsAfterPipeCloses("unguarded")).toBeGreaterThan(1000);
  });

  it("never reaches the crash handler with the guard", async () => {
    expect(await handlerCallsAfterPipeCloses("fixed")).toBe(0);
  });
});
