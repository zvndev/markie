import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalOnlyChecks,
  validatePackagingMatrix,
  validateReleaseDocs,
  validateReleaseMetadata,
  validateRequiredFiles,
} from "../scripts/release-preflight.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("release preflight", () => {
  it("checks release metadata and required local files without credentials", () => {
    expect(validateReleaseMetadata(rootDir)).toMatchObject({
      version: "0.2.8",
      appId: "com.zvn.markie",
      productName: "Markie",
    });

    expect(validateRequiredFiles(rootDir)).toEqual(
      expect.arrayContaining([
        "build/preflight.cjs",
        "build/entitlements.mac.plist",
        "build/icon.ico",
        "build/icons/256x256.png",
        "scripts/install-win-native-prebuild.mjs",
        "scripts/local-electron-builder.mjs",
        "scripts/restore-host-native-prebuild.mjs",
        "scripts/package-smoke.mjs",
        "scripts/windows-launch-smoke.mjs",
        ".github/workflows/windows-launch-smoke.yml",
        "public/icon.icns",
        "mcp/markie-mcp.mjs",
        "server/package.json",
        "server/download-manifest.json",
      ])
    );
  });

  it("validates the local desktop packaging matrix without publishing", () => {
    expect(validatePackagingMatrix(rootDir)).toMatchObject({
      scripts: expect.arrayContaining([
        "electron:pack:mac:arm64",
        "electron:pack:mac:x64",
        "electron:pack:win",
        "electron:pack:linux",
        "electron:build:mac",
        "electron:build:win",
        "electron:build:linux",
        "electron:smoke:mac:arm64",
        "electron:smoke:mac:x64",
        "electron:smoke:win",
        "electron:smoke:win:launch",
        "electron:smoke:linux",
      ]),
      mac: expect.arrayContaining([
        { target: "dmg", arch: expect.arrayContaining(["arm64", "x64"]) },
        { target: "zip", arch: expect.arrayContaining(["arm64", "x64"]) },
      ]),
      win: expect.arrayContaining([
        { target: "nsis", arch: expect.arrayContaining(["x64"]) },
        { target: "zip", arch: expect.arrayContaining(["x64"]) },
      ]),
      linux: expect.arrayContaining([
        { target: "AppImage", arch: expect.arrayContaining(["x64"]) },
        { target: "deb", arch: expect.arrayContaining(["x64"]) },
      ]),
    });
  });

  it("keeps release docs explicit about platform artifacts and local-only gates", () => {
    expect(validateReleaseDocs(rootDir)).toEqual(
      expect.arrayContaining([
        "Per-platform local artifact contract",
        "npm run electron:pack:mac:arm64",
        "npm run electron:pack:mac:x64",
        "npm run electron:pack:win",
        "npm run electron:pack:linux",
        "Markie-<version>-arm64.dmg",
        "Markie-<version>-x64.exe",
        "Markie-<version>-x64.AppImage",
        "npm run electron:smoke:win:launch",
        "--publish never",
      ])
    );
  });

  it("runs only local test, lint, and build checks", () => {
    const inspected = assertLocalOnlyChecks(rootDir).join("\n");

    expect(inspected).toContain("npm test vitest run");
    expect(inspected).toContain("node --test mcp/lib.test.mjs");
    expect(inspected).toContain("npm run lint eslint");
    expect(inspected).toContain("npm run build next build");
    expect(inspected).not.toMatch(
      /\b(electron-builder|--publish|publish|notarize|notarytool|codesign|xcrun|deploy|railway|aws|s3)\b/i
    );
  });

  it("rejects accidental release or deploy actions in the local plan", () => {
    expect(() =>
      assertLocalOnlyChecks(rootDir, [
        {
          label: "bad release",
          command: "npm",
          args: ["run", "electron:release"],
          script: "electron:release",
        },
      ])
    ).toThrow(/forbidden release\/deploy action/);
  });
});
