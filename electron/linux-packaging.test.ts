// The Linux half of electron-builder.config.cjs, checked against the manifest
// and against what the app's own Linux code expects of the package.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const config = require(path.join(rootDir, "electron-builder.config.cjs"));
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(rootDir, "server/download-manifest.json"), "utf8"));

describe("Linux packaging", () => {
  it("builds an AppImage and a deb for x64", () => {
    expect(config.linux.target).toEqual([
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ]);
  });

  it("publishes to the manifest's Linux directory, not the macOS one", () => {
    // app-update.yml is written from this at pack time. A Linux install that
    // shipped pointing at mac/ would look for latest-linux.yml there forever.
    const linux = manifest.platforms.find((entry: { id: string }) => entry.id === "linux-x64");
    expect(config.linux.publish).toHaveLength(1);
    expect(config.linux.publish[0]).toMatchObject({
      provider: manifest.storage.provider,
      bucket: manifest.storage.bucket,
      path: path.posix.dirname(linux.feed.path),
    });
    expect(config.linux.publish[0].path).toBe("linux");
    expect(config.publish[0].path).toBe("mac");
  });

  it("keeps the early Linux feed beside the stable one", () => {
    const linux = manifest.platforms.find((entry: { id: string }) => entry.id === "linux-x64");
    expect(path.posix.dirname(manifest.betaChannel.linuxFeed.path)).toBe(path.posix.dirname(linux.feed.path));
    expect(path.posix.basename(manifest.betaChannel.linuxFeed.path)).toBe("beta-linux.yml");
    expect(path.posix.basename(linux.feed.path)).toBe("latest-linux.yml");
  });

  it("names the desktop entry and window class the way linux-desktop.js does", () => {
    // Electron reports desktopName (minus .desktop) as the Wayland app_id, and
    // electron-builder derives StartupWMClass from it, so the AppImage entry the
    // app writes for itself has to use the same file name and class.
    expect(pkg.desktopName).toBe("markie.desktop");
    expect(config.linux.executableName).toBe("markie");
    expect(config.linux.syncDesktopName).toBe(true);
    expect(config.linux.category).toBe("Office;TextEditor;Utility;");
  });

  it("claims Markdown and markie:// and leaves plain text alone", () => {
    expect(config.linux.mimeTypes).toEqual(["text/markdown", "text/x-markdown"]);
    expect(config.protocols).toEqual([{ name: "Markie", schemes: ["markie"] }]);
    expect(config.linux.mimeTypes).not.toContain("text/plain");
  });

  it("ships the window icon linux-desktop.js reads, from the generated icon set", () => {
    expect(config.linux.icon).toBe("build/icons");
    expect(config.linux.extraResources).toEqual([{ from: "build/icons/512x512.png", to: "icons/markie.png" }]);
  });

  it("uses the AppImage runtime that does not need libfuse2", () => {
    expect(config.toolsets?.appimage).toBe("1.0.3");
  });

  it("names a deb maintainer, which fpm refuses to build without", () => {
    expect(config.linux.maintainer).toMatch(/<[^@\s]+@[^>\s]+>/);
  });
});
