import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  electronBuilderBin,
  localElectronBuilderArgs,
  localElectronBuilderEnv,
  shouldRestoreHostNativePrebuild,
} from "../scripts/local-electron-builder.mjs";

// The wrapper takes and returns a process.env-shaped object, but the spread
// inside it loses the index signature on the way out, so both ends are named
// here rather than at each call.
// NODE_ENV is required on ProcessEnv here, and a fixture that only cares
// about signing credentials has no business declaring one.
const builderEnv = (base: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
  localElectronBuilderEnv(base as NodeJS.ProcessEnv);

describe("local electron-builder wrapper", () => {
  it("disables signing identity discovery and strips signing credentials", () => {
    const env = builderEnv({
      PATH: "/bin",
      CSC_LINK: "secret-cert",
      CSC_KEY_PASSWORD: "secret-password",
      CSC_NAME: "Developer ID Application",
      CSC_IDENTITY_AUTO_DISCOVERY: "true",
      APPLE_ID: "person@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: "TEAMID",
    });

    expect(env.PATH).toBe("/bin");
    expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(env.CSC_LINK).toBeUndefined();
    expect(env.CSC_KEY_PASSWORD).toBeUndefined();
    expect(env.CSC_NAME).toBeUndefined();
    expect(env.APPLE_ID).toBeUndefined();
    expect(env.APPLE_APP_SPECIFIC_PASSWORD).toBeUndefined();
    expect(env.APPLE_TEAM_ID).toBeUndefined();
  });

  it("prefers the project-local electron-builder binary when installed", () => {
    const bin = electronBuilderBin(path.resolve("."));
    expect(bin).toMatch(/electron-builder(\.cmd)?$/);
  });

  it("adds mac.identity=null for local macOS package and build commands", () => {
    expect(localElectronBuilderArgs(["--mac", "--arm64", "--dir", "--publish", "never"])).toEqual(
      expect.arrayContaining(["-c.mac.identity=null"])
    );
    expect(localElectronBuilderArgs(["--win", "--x64", "--dir", "--publish", "never"])).not.toContain(
      "-c.mac.identity=null"
    );
    expect(localElectronBuilderArgs(["--mac", "-c.mac.identity=Developer ID"])).toEqual([
      "--mac",
      "-c.mac.identity=Developer ID",
    ]);
  });

  it("adds win.signAndEditExecutable=false for local Windows package and build commands", () => {
    expect(localElectronBuilderArgs(["--win", "--x64", "--dir", "--publish", "never"])).toEqual(
      expect.arrayContaining(["-c.win.signAndEditExecutable=false"])
    );
    expect(localElectronBuilderArgs(["--linux", "--x64", "--dir", "--publish", "never"])).not.toContain(
      "-c.win.signAndEditExecutable=false"
    );
    expect(localElectronBuilderArgs(["--win", "-c.win.signAndEditExecutable=true"])).toEqual(
      expect.arrayContaining(["-c.win.signAndEditExecutable=true", "-c.npmRebuild=false"])
    );
  });

  it("disables electron-builder native rebuilds for local Windows cross-packaging", () => {
    expect(localElectronBuilderArgs(["--win", "--x64", "--dir", "--publish", "never"])).toEqual(
      expect.arrayContaining(["-c.npmRebuild=false"])
    );
    expect(localElectronBuilderArgs(["--mac", "--arm64", "--dir", "--publish", "never"])).not.toContain(
      "-c.npmRebuild=false"
    );
    expect(localElectronBuilderArgs(["--win", "-c.npmRebuild=true"])).toEqual(
      expect.arrayContaining(["-c.win.signAndEditExecutable=false", "-c.npmRebuild=true"])
    );
  });

  it("restores host native modules after cross-platform or cross-arch local builds", () => {
    const appleSilicon: { platform: NodeJS.Platform; arch: NodeJS.Architecture } = {
      platform: "darwin",
      arch: "arm64",
    };

    expect(shouldRestoreHostNativePrebuild(["--mac", "--arm64"], appleSilicon)).toBe(false);
    expect(shouldRestoreHostNativePrebuild(["--mac", "--x64"], appleSilicon)).toBe(true);
    expect(shouldRestoreHostNativePrebuild(["--win", "--x64"], appleSilicon)).toBe(true);
    expect(shouldRestoreHostNativePrebuild(["--linux", "--x64"], appleSilicon)).toBe(true);
  });
});
