// psQuote is one line, and it cost a Windows release check a failing gate.
//
// JSON.stringify was used to put a path into a PowerShell command. PowerShell
// has no backslash escapes, so every separator came out doubled. .NET
// normalises that away for Get-Item and not for Get-AuthenticodeSignature, so
// the mistake showed up as one check failing rather than as everything failing,
// which is the kind of bug that gets diagnosed as "flaky Windows".
import { describe, expect, it } from "vitest";
import {
  appImageVersionFromDesktopEntry,
  isType2AppImage,
  previousFeedFileFor,
  psQuote,
  targetFor,
} from "./update-targets.mjs";

describe("the Linux update target", () => {
  it("recognises a type 2 AppImage and nothing else", () => {
    const appImage = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02, 0, 0, 0, 0, 0]);
    expect(isType2AppImage(appImage)).toBe(true);
    // A plain ELF (the unpacked binary) and an HTML error page saved under the
    // AppImage's name are the two things a broken download turns into.
    expect(isType2AppImage(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0]))).toBe(false);
    expect(isType2AppImage(Buffer.from("<!doctype html>"))).toBe(false);
  });

  it("reads the version electron-builder writes into the AppImage's desktop entry", () => {
    expect(appImageVersionFromDesktopEntry("[Desktop Entry]\nName=Markie\nX-AppImage-Version=0.9.2\n")).toBe("0.9.2");
    expect(appImageVersionFromDesktopEntry("[Desktop Entry]\nName=Markie\n")).toBeNull();
  });

  it("downloads the AppImage a user would, and reads the Linux feed saved at publish", () => {
    const target = targetFor("linux", {} as never);
    expect(target.platformId).toBe("linux-x64");
    expect(target.artifactUrl("https://cdn.example.com/b", "linux/latest-linux.yml", "0.9.2", "x64")).toBe(
      "https://cdn.example.com/b/linux/Markie-0.9.2-x86_64.AppImage"
    );
    expect(previousFeedFileFor("linux")).toBe("previous-latest-linux.yml");
    expect(previousFeedFileFor("win32")).toBe("previous-latest.yml");
    expect(previousFeedFileFor("darwin")).toBe("previous-latest-mac.yml");
  });

  it("stages under an unversioned name, so the updater replaces it in place", async () => {
    const calls: string[] = [];
    const target = targetFor("linux", {
      run: async (cmd: string, args: string[]) => (calls.push([cmd, ...args].join(" ")), ""),
      mkdir: async () => undefined,
    } as never);
    const staged = await target.stage({ artifactPath: "/w/Markie-0.9.2-x86_64.AppImage", workDir: "/w" });
    expect(staged.appPath).toBe("/w/Applications/Markie.AppImage");
    expect(staged.binary).toBe(staged.appPath);
    expect(calls).toContain("chmod +x /w/Applications/Markie.AppImage");
  });
});

describe("quoting a path for PowerShell", () => {
  it("leaves a Windows path's separators exactly as they are", () => {
    expect(psQuote("C:\\Users\\me\\Markie.exe")).toBe("'C:\\Users\\me\\Markie.exe'");
  });

  it("never doubles a backslash, whatever JSON would do", () => {
    const path = "C:\\a\\b";
    expect(psQuote(path)).not.toContain("\\\\");
    expect(JSON.stringify(path)).toContain("\\\\");
  });

  it("escapes a quote the one way PowerShell accepts, by doubling it", () => {
    expect(psQuote("C:\\it's here\\x.exe")).toBe("'C:\\it''s here\\x.exe'");
  });

  it("does not let a path close the string and run something after it", () => {
    // A single-quoted PowerShell string is literal all the way through, so the
    // only thing that could end it early is an unescaped quote.
    const hostile = "C:\\x'; Remove-Item C:\\ -Recurse; '";
    const quoted = psQuote(hostile);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted.slice(1, -1).split("''").join("")).not.toContain("'");
  });

  it("handles a path with spaces without needing anything else", () => {
    expect(psQuote("C:\\Program Files\\Markie\\Markie.exe")).toBe(
      "'C:\\Program Files\\Markie\\Markie.exe'"
    );
  });
});
