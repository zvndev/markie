import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const afterPack = require("../build/preflight.cjs");

describe("electron-builder afterPack hook", () => {
  it("patches Windows packages before installer artifacts are built", () => {
    expect(afterPack.preflightMode({ electronPlatformName: "win32" })).toBe("windows-native-prebuild");
    expect(afterPack.windowsNativePrebuildScriptPath()).toBe(
      path.resolve("scripts/install-win-native-prebuild.mjs")
    );
  });

  it("keeps macOS release builds on the launch-smoke gate", () => {
    expect(afterPack.preflightMode({ electronPlatformName: "darwin" }, {})).toBe("mac-window-smoke");
    expect(afterPack.preflightMode({ electronPlatformName: "darwin" }, { MARKIE_SKIP_PREFLIGHT: "1" })).toBe(
      "skip-mac-window-smoke"
    );
  });
});
