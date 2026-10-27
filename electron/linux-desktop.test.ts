import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MARKER,
  appImageDesktopEntry,
  ensureAppImageIntegration,
  linuxPackageKind,
  linuxWindowIcon,
  quoteExecArg,
} from "./linux-desktop.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "markie-linux-desktop-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A filesystem whose system application directories are empty, so a test is
// not decided by whatever the machine running it has installed.
const isolatedFs = (systemEntries: string[] = []) => {
  const fs = require("node:fs");
  return {
    ...fs,
    existsSync: (p: string) =>
      p.startsWith("/usr/") ? systemEntries.includes(p) : fs.existsSync(p),
  };
};

describe("linuxPackageKind", () => {
  it("is an AppImage when the runtime set APPIMAGE", () => {
    expect(linuxPackageKind({ platform: "linux", env: { APPIMAGE: "/home/me/Markie.AppImage" }, resourcesPath: root })).toBe(
      "appimage"
    );
  });

  it("reads the package-type file electron-builder writes into a deb", () => {
    writeFileSync(path.join(root, "package-type"), "deb\n");
    expect(linuxPackageKind({ platform: "linux", env: {}, resourcesPath: root })).toBe("deb");
  });

  it("answers null for an unpacked build, a relative APPIMAGE, or another OS", () => {
    expect(linuxPackageKind({ platform: "linux", env: {}, resourcesPath: root })).toBeNull();
    expect(linuxPackageKind({ platform: "linux", env: { APPIMAGE: "Markie.AppImage" }, resourcesPath: root })).toBeNull();
    writeFileSync(path.join(root, "package-type"), "snap");
    expect(linuxPackageKind({ platform: "linux", env: {}, resourcesPath: root })).toBeNull();
    expect(linuxPackageKind({ platform: "darwin", env: { APPIMAGE: "/x" }, resourcesPath: root })).toBeNull();
  });
});

describe("the AppImage desktop entry", () => {
  it("launches the AppImage with %U and claims markdown and markie://", () => {
    const entry = appImageDesktopEntry({ appImagePath: "/home/me/Apps/Markie.AppImage", version: "0.9.2" });
    expect(entry).toContain('Exec="/home/me/Apps/Markie.AppImage" %U');
    expect(entry).toContain("MimeType=text/markdown;text/x-markdown;x-scheme-handler/markie;");
    expect(entry).toContain("StartupWMClass=markie");
    expect(entry).toContain("Categories=Office;TextEditor;Utility;");
    expect(entry).toContain("X-AppImage-Version=0.9.2");
    expect(entry).toContain(MARKER);
  });

  it("quotes a path so spaces, quotes and $ cannot change the command", () => {
    expect(quoteExecArg('/home/me/My "Apps"/$HOME/Markie.AppImage')).toBe(
      '"/home/me/My \\"Apps\\"/\\$HOME/Markie.AppImage"'
    );
    // String escaping on top of Exec quoting: the spec's four backslashes.
    expect(appImageDesktopEntry({ appImagePath: "/a\\b/$x", version: "1" })).toContain(
      'Exec="/a\\\\\\\\b/\\\\$x" %U'
    );
    const entry = appImageDesktopEntry({ appImagePath: "/tmp/a\nExec=evil", version: "1" });
    expect(entry.split("\n").filter((line) => line.startsWith("Exec="))).toHaveLength(1);
  });

  it("refuses to write an entry for a path with control characters", () => {
    const result = ensureAppImageIntegration({
      env: { APPIMAGE: "/tmp/a\nb.AppImage" },
      home: path.join(root, "home"),
      resourcesPath: root,
      fs: isolatedFs(),
    });
    expect(result).toEqual({ written: false, reason: "unusual-path" });
  });
});

describe("ensureAppImageIntegration", () => {
  const home = () => path.join(root, "home");
  const resources = () => {
    const dir = path.join(root, "resources");
    mkdirSync(path.join(dir, "icons"), { recursive: true });
    writeFileSync(path.join(dir, "icons", "markie.png"), "png");
    return dir;
  };

  it("writes the entry and icon under the user's data dir, then refreshes the caches", () => {
    const calls: string[] = [];
    const result = ensureAppImageIntegration({
      env: { APPIMAGE: "/home/me/Markie.AppImage" },
      home: home(),
      resourcesPath: resources(),
      version: "0.9.2",
      fs: isolatedFs(),
      run: (command: string, args: string[]) => void calls.push([command, ...args].join(" ")),
    });
    const file = path.join(home(), ".local/share/applications/markie.desktop");
    expect(result).toEqual({ written: true, reason: "created", file });
    expect(readFileSync(file, "utf8")).toContain('Exec="/home/me/Markie.AppImage" %U');
    expect(existsSync(path.join(home(), ".local/share/icons/hicolor/512x512/apps/markie.png"))).toBe(true);
    expect(calls).toContain("xdg-mime default markie.desktop x-scheme-handler/markie");
  });

  it("rewrites its own entry when the AppImage moved, and is quiet when nothing changed", () => {
    const options = { home: home(), resourcesPath: resources(), version: "0.9.2", fs: isolatedFs() };
    ensureAppImageIntegration({ ...options, env: { APPIMAGE: "/a/Markie.AppImage" } });
    expect(ensureAppImageIntegration({ ...options, env: { APPIMAGE: "/a/Markie.AppImage" } }).reason).toBe("current");
    expect(ensureAppImageIntegration({ ...options, env: { APPIMAGE: "/b/Markie.AppImage" } }).reason).toBe("updated");
  });

  it("follows XDG_DATA_HOME", () => {
    const data = path.join(root, "data");
    const result = ensureAppImageIntegration({
      env: { APPIMAGE: "/a/Markie.AppImage", XDG_DATA_HOME: data },
      home: home(),
      resourcesPath: resources(),
      fs: isolatedFs(),
    });
    expect(result.file).toBe(path.join(data, "applications/markie.desktop"));
  });

  it("never overwrites an entry it did not write", () => {
    const file = path.join(home(), ".local/share/applications/markie.desktop");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "[Desktop Entry]\nName=My Markie\n");
    const result = ensureAppImageIntegration({
      env: { APPIMAGE: "/a/Markie.AppImage" },
      home: home(),
      resourcesPath: resources(),
      fs: isolatedFs(),
    });
    expect(result).toMatchObject({ written: false, reason: "user-entry" });
    expect(readFileSync(file, "utf8")).toContain("My Markie");
  });

  it("stands aside when the deb's system entry exists, and outside an AppImage", () => {
    const options = { home: home(), resourcesPath: resources() };
    expect(
      ensureAppImageIntegration({
        ...options,
        env: { APPIMAGE: "/a/Markie.AppImage" },
        fs: isolatedFs(["/usr/share/applications/markie.desktop"]),
      }).reason
    ).toBe("system-entry");
    expect(ensureAppImageIntegration({ ...options, env: {}, fs: isolatedFs() }).reason).toBe("not-appimage");
    expect(existsSync(path.join(home(), ".local"))).toBe(false);
  });
});

describe("linuxWindowIcon", () => {
  it("uses the shipped PNG on Linux and nothing elsewhere", () => {
    mkdirSync(path.join(root, "icons"));
    writeFileSync(path.join(root, "icons", "markie.png"), "png");
    expect(linuxWindowIcon({ platform: "linux", resourcesPath: root })).toBe(path.join(root, "icons", "markie.png"));
    expect(linuxWindowIcon({ platform: "darwin", resourcesPath: root })).toBeUndefined();
    expect(linuxWindowIcon({ platform: "linux", resourcesPath: path.join(root, "nope") })).toBeUndefined();
  });
});
