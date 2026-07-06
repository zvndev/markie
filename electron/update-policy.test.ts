import { describe, expect, it } from "vitest";
import {
  desktopUpdatePolicy,
  platformLabel,
  shouldSetupAutoUpdate,
} from "./update-policy.js";

describe("desktop update policy", () => {
  it("keeps development and unpackaged builds away from update feeds", () => {
    expect(desktopUpdatePolicy({ platform: "darwin", isPackaged: false, isDev: false })).toMatchObject({
      supported: false,
      reason: "dev",
      message: "Updates are checked in packaged Markie builds.",
    });
    expect(desktopUpdatePolicy({ platform: "darwin", isPackaged: true, isDev: true })).toMatchObject({
      supported: false,
      reason: "dev",
    });
    expect(shouldSetupAutoUpdate({ platform: "darwin", isPackaged: false, isDev: false })).toBe(false);
  });

  it("supports automatic update checks only for packaged macOS builds", () => {
    expect(desktopUpdatePolicy({ platform: "darwin", isPackaged: true, isDev: false })).toEqual({
      supported: true,
      reason: null,
      platform: "macOS",
      feed: "latest-mac.yml",
    });
    expect(shouldSetupAutoUpdate({ platform: "darwin", isPackaged: true, isDev: false })).toBe(true);
  });

  it("blocks Windows and Linux from using the macOS update feed", () => {
    expect(desktopUpdatePolicy({ platform: "win32", isPackaged: true, isDev: false })).toMatchObject({
      supported: false,
      reason: "unsupported-platform",
      message: "Automatic updates are not enabled for Windows yet.",
      detail: expect.stringContaining("signed macOS update feed only"),
    });
    expect(desktopUpdatePolicy({ platform: "linux", isPackaged: true, isDev: false })).toMatchObject({
      supported: false,
      reason: "unsupported-platform",
      message: "Automatic updates are not enabled for Linux yet.",
    });
    expect(shouldSetupAutoUpdate({ platform: "win32", isPackaged: true, isDev: false })).toBe(false);
  });

  it("uses readable platform names in manual-check dialogs", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("freebsd")).toBe("this platform");
  });
});
