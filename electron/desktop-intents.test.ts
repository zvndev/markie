import { describe, expect, it } from "vitest";
import {
  findDeepLinkArg,
  findOpenableLaunchFile,
  isOpenablePath,
  launchIntentFromArgv,
  markdownDefaultHandlerUnavailable,
  supportsMarkdownDefaultHandler,
} from "./desktop-intents.js";

describe("desktop launch intent helpers", () => {
  const existing = new Set([
    "/Users/me/Notes/brief.md",
    "C:\\Users\\me\\Notes\\brief.md",
    "/home/me/notes/plan.csv",
  ]);
  const existsSync = (filePath: string) => existing.has(filePath);
  const resolvePath = (filePath: string) => `resolved:${filePath}`;

  it("detects Markie deep links from Windows/Linux argv handoff", () => {
    expect(findDeepLinkArg(["Markie.exe", "--some-electron-flag", "markie://open?token=abc"])).toBe(
      "markie://open?token=abc"
    );
    expect(findDeepLinkArg(["Markie.exe", "https://markie.zvndev.com"])).toBeNull();
  });

  it("finds openable markdown/text/csv files and ignores missing or unsupported paths", () => {
    expect(
      findOpenableLaunchFile(["Markie.exe", "C:\\Users\\me\\Notes\\brief.md"], {
        existsSync,
        resolvePath,
      })
    ).toBe("resolved:C:\\Users\\me\\Notes\\brief.md");

    expect(
      findOpenableLaunchFile(["Markie.exe", "/tmp/missing.md", "/tmp/secret.json"], {
        existsSync,
        resolvePath,
      })
    ).toBeNull();
  });

  it("accepts file URLs for OS-level open handoff", () => {
    expect(isOpenablePath("file:///Users/me/Notes/brief.md")).toBe(true);
    expect(
      findOpenableLaunchFile(["file:///Users/me/Notes/brief.md"], {
        existsSync,
        resolvePath,
      })
    ).toBe("resolved:/Users/me/Notes/brief.md");
  });

  it("returns deep link and file path intent independently so main can preserve priority", () => {
    expect(
      launchIntentFromArgv(["Markie.exe", "markie://auth/callback", "/home/me/notes/plan.csv"], {
        existsSync,
        resolvePath,
      })
    ).toEqual({
      deepLink: "markie://auth/callback",
      filePath: "resolved:/home/me/notes/plan.csv",
    });
  });
});

describe("Markdown default handler support", () => {
  it("supports in-app default registration only for packaged macOS", () => {
    expect(supportsMarkdownDefaultHandler({ platform: "darwin", isPackaged: true })).toBe(true);
    expect(supportsMarkdownDefaultHandler({ platform: "darwin", isPackaged: false })).toBe(false);
    expect(supportsMarkdownDefaultHandler({ platform: "win32", isPackaged: true })).toBe(false);
    expect(supportsMarkdownDefaultHandler({ platform: "linux", isPackaged: true })).toBe(false);
  });

  it("returns clear unsupported copy for non-macOS and dev builds", () => {
    expect(markdownDefaultHandlerUnavailable({ platform: "win32", isPackaged: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining("macOS-only"),
    });
    expect(markdownDefaultHandlerUnavailable({ platform: "darwin", isPackaged: false })).toMatchObject({
      ok: false,
      error: expect.stringContaining("installed Markie app"),
    });
    expect(markdownDefaultHandlerUnavailable({ platform: "darwin", isPackaged: true })).toBeNull();
  });
});
