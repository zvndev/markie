import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  electronBuilderBin,
  localElectronBuilderArgs,
  localElectronBuilderEnv,
  shouldRestoreHostNativePrebuild,
} from "../scripts/local-electron-builder.mjs";

describe("local electron-builder wrapper", () => {
  it("disables signing identity discovery and strips signing credentials", () => {
    const env = localElectronBuilderEnv({
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
    expect(localElectronBuilderArgs(["--win", "-c.win.signAndEditExecutable=true"])).toEqual([
      "--win",
      "-c.win.signAndEditExecutable=true",
    ]);
  });

  it("restores host native modules after cross-platform or cross-arch local builds", () => {
    const appleSilicon = { platform: "darwin", arch: "arm64" };

    expect(shouldRestoreHostNativePrebuild(["--mac", "--arm64"], appleSilicon)).toBe(false);
    expect(shouldRestoreHostNativePrebuild(["--mac", "--x64"], appleSilicon)).toBe(true);
    expect(shouldRestoreHostNativePrebuild(["--win", "--x64"], appleSilicon)).toBe(true);
    expect(shouldRestoreHostNativePrebuild(["--linux", "--x64"], appleSilicon)).toBe(true);
  });
});
