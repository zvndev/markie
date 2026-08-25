import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// CommonJS main-process module: load it the way main.js does.
const load = createRequire(import.meta.url);
const { createCrashLog, FILE_NAME } = load("./crash-log.js");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-crashlog-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createCrashLog", () => {
  it("appends one line per crash, newest last", () => {
    const log = createCrashLog({ dir });
    log.log("uncaughtException", new Error("boom"));
    log.log("render-process-gone", { reason: "crashed" });

    // An Error's stack spans lines, so entries are counted by their stamp.
    const body = log.read();
    const entries = body.match(/^\[\d{4}-/gm) ?? [];
    expect(entries).toHaveLength(2);
    expect(body.indexOf("uncaughtException")).toBeLessThan(body.indexOf("render-process-gone"));
    expect(body).toContain("boom");
    expect(body).toContain("crashed");
  });

  it("writes to markie-crash.log under the given directory", () => {
    const log = createCrashLog({ dir });
    log.log("kind", "detail");
    expect(log.path).toBe(path.join(dir, FILE_NAME));
    expect(fs.existsSync(log.path)).toBe(true);
  });

  it("records the stack, not just the message", () => {
    const log = createCrashLog({ dir });
    const err = new Error("with a stack");
    log.log("uncaughtException", err);
    expect(log.read()).toContain("crash-log.test");
    expect(log.read()).toContain(String(err.stack).split("\n")[1].trim().slice(0, 10));
  });

  it("survives a detail it cannot serialise", () => {
    const log = createCrashLog({ dir });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(log.log("weird", circular)).toBe(true);
    expect(log.read()).toContain("weird");
  });

  it("handles a missing detail", () => {
    const log = createCrashLog({ dir });
    log.log("no-detail");
    expect(log.read()).toContain("no-detail");
  });

  it("rotates to one previous generation once it passes the cap", () => {
    const log = createCrashLog({ dir, maxBytes: 200 });
    for (let i = 0; i < 20; i++) log.log("spin", `entry-${i}-padding-padding`);

    expect(fs.statSync(log.path).size).toBeLessThanOrEqual(200);
    expect(fs.existsSync(log.previousPath)).toBe(true);
    // The newest entry is always in the live file.
    expect(log.read()).toContain("entry-19");
  });

  it("keeps only one generation of history", () => {
    const log = createCrashLog({ dir, maxBytes: 120 });
    for (let i = 0; i < 30; i++) log.log("spin", `entry-${i}`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual([FILE_NAME, `${FILE_NAME}.1`]);
  });

  it("reports failure instead of throwing when the directory is gone", () => {
    const log = createCrashLog({ dir: path.join(dir, "missing", "deeper") });
    expect(log.log("kind", "detail")).toBe(false);
  });

  it("ensure() creates an empty log so there is something to reveal", () => {
    const log = createCrashLog({ dir });
    expect(fs.existsSync(log.path)).toBe(false);
    expect(log.ensure()).toBe(log.path);
    expect(fs.existsSync(log.path)).toBe(true);
    expect(log.read()).toBe("");
  });

  it("ensure() leaves an existing log alone", () => {
    const log = createCrashLog({ dir });
    log.log("kind", "keep me");
    log.ensure();
    expect(log.read()).toContain("keep me");
  });

  it("read() returns empty rather than throwing when there is no log", () => {
    expect(createCrashLog({ dir }).read()).toBe("");
  });

  it("stamps each entry with an ISO timestamp", () => {
    const log = createCrashLog({ dir, now: () => new Date("2026-08-23T10:11:12.000Z") });
    log.log("kind", "detail");
    expect(log.read()).toContain("[2026-08-23T10:11:12.000Z] kind detail");
  });
});
