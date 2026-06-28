import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalOnlyChecks,
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
        "public/icon.icns",
        "mcp/markie-mcp.mjs",
        "server/package.json",
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
