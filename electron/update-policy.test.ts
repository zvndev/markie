import { describe, expect, it } from "vitest";
import {
  desktopUpdatePolicy,
  platformLabel,
  shouldSetupAutoUpdate,
} from "./update-policy.js";
import { STABLE_CHANNEL, feedFor } from "./update-channel.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(path.join(rootDir, "server/download-manifest.json"), "utf8")
) as {
  platforms: Array<{ id: string; status: string; feed?: { path: string } }>;
};
const platformEntry = (id: string) => manifest.platforms.find((entry) => entry.id === id);

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

  it("supports automatic update checks for packaged macOS builds", () => {
    expect(desktopUpdatePolicy({ platform: "darwin", isPackaged: true, isDev: false })).toEqual({
      supported: true,
      reason: null,
      platform: "macOS",
      feed: "latest-mac.yml",
    });
    expect(shouldSetupAutoUpdate({ platform: "darwin", isPackaged: true, isDev: false })).toBe(true);
  });

  it("supports packaged Windows builds", () => {
    // The signed Windows installer has been the public download since 0.4.2 and
    // the manifest has carried its feed path for as long. This file was the one
    // place still answering "not yet", which meant every Windows install ever
    // shipped could never update itself.
    expect(desktopUpdatePolicy({ platform: "win32", isPackaged: true, isDev: false })).toEqual({
      supported: true,
      reason: null,
      platform: "Windows",
      feed: "latest.yml",
    });
    expect(shouldSetupAutoUpdate({ platform: "win32", isPackaged: true, isDev: false })).toBe(true);
  });

  it("still refuses dev builds on Windows", () => {
    expect(
      desktopUpdatePolicy({ platform: "win32", isPackaged: false, isDev: false }).supported
    ).toBe(false);
    expect(
      desktopUpdatePolicy({ platform: "win32", isPackaged: true, isDev: true }).supported
    ).toBe(false);
  });

  it("still refuses Linux, and says so by name", () => {
    const policy = desktopUpdatePolicy({ platform: "linux", isPackaged: true, isDev: false });
    expect(policy).toMatchObject({
      supported: false,
      reason: "unsupported-platform",
      message: "Automatic updates are not enabled for Linux yet.",
    });
    expect(policy.detail).toMatch(/Linux/);
    expect(shouldSetupAutoUpdate({ platform: "linux", isPackaged: true, isDev: false })).toBe(false);
  });

  it("names the same stable feed the channel module would pick", () => {
    // Two modules hold feed names: this one for "may I update", update-channel
    // for "from where". They must not drift, because a policy that reports one
    // feed while the updater fetches another is a bug nobody can see locally.
    for (const platform of ["darwin", "win32"] as const) {
      expect(desktopUpdatePolicy({ platform, isPackaged: true, isDev: false }).feed).toBe(
        feedFor(STABLE_CHANNEL, platform)
      );
    }
  });

  it("agrees with the manifest about which platforms publish a feed", () => {
    // download-manifest.json is the single source of truth for what is public.
    // These two files disagreeing is exactly how a signed public Windows build
    // shipped for a whole release cycle with its updater switched off.
    for (const [id, platform] of [
      ["mac-arm64", "darwin"],
      ["windows-x64", "win32"],
      ["linux-x64", "linux"],
    ] as const) {
      const entry = platformEntry(id);
      const policy = desktopUpdatePolicy({ platform, isPackaged: true, isDev: false });
      expect(policy.supported).toBe(entry?.status === "public");
      if (!policy.supported) continue;
      // The feed the policy names must be the file the manifest publishes, so
      // an install cannot be told to fetch something that was never uploaded.
      expect(policy.feed).toBe(path.posix.basename(entry!.feed!.path));
    }
  });

  it("uses readable platform names in manual-check dialogs", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("freebsd")).toBe("this platform");
  });
});
