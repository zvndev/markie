import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { launchErrors, describeLaunchErrors } = require("../build/launch-errors.cjs") as {
  launchErrors: (dir: string) => string[];
  describeLaunchErrors: (errors: string[]) => string;
};

const dirs: string[] = [];
const profile = (log?: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "markie-launch-errors-"));
  dirs.push(dir);
  if (log !== undefined) writeFileSync(path.join(dir, "markie-crash.log"), log);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// What the 0.9.0 release candidate actually wrote before its gate timed out.
const MISSING_MODULE = [
  "[2026-10-25T00:03:12.781Z] uncaughtException Error: Cannot find module '../mcp/doc-text.cjs'",
  "Require stack:",
  "- /Applications/Markie.app/Contents/Resources/app.asar/electron/doc-text.js",
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1524:15)",
  "",
].join("\n");

describe("launch errors read from the packaged app's crash log", () => {
  it("finds a startup throw the main process swallowed, with its stack", () => {
    const errors = launchErrors(profile(MISSING_MODULE));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Cannot find module '../mcp/doc-text.cjs'");
    expect(describeLaunchErrors(errors)).toContain("Require stack:");
  });

  it("is empty for a clean launch, with or without a log file", () => {
    expect(launchErrors(profile())).toEqual([]);
    expect(launchErrors(profile(""))).toEqual([]);
  });

  it("counts unhandled rejections but not the other crash kinds the log records", () => {
    const log = "[t] child-process-gone {\"type\":\"GPU\"}\n[t] unhandledRejection Error: boom\n    at x\n";
    const errors = launchErrors(profile(log));
    expect(errors).toEqual(["[t] unhandledRejection Error: boom\n    at x"]);
  });
});
