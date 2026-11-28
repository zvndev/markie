import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { updateHarnessFeed, HARNESS_ENV } = require("./update-harness.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const harnessBuild = { version: "0.9.7", markieUpdateHarness: true };
const env = (url: string) => ({ [HARNESS_ENV]: url });

describe("the Mac cutover handoff feed override", () => {
  it("points a packaged harness build at a loopback feed", () => {
    expect(
      updateHarnessFeed({ isPackaged: true, metadata: harnessBuild, env: env("http://127.0.0.1:4567/mac") })
    ).toEqual({ provider: "generic", url: "http://127.0.0.1:4567/mac/" });
  });

  it("does nothing in a production build, whatever the environment says", () => {
    // The public package.json, as the release config packs it.
    const publicPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(publicPackage.markieUpdateHarness).toBeUndefined();
    expect(updateHarnessFeed({ isPackaged: true, metadata: publicPackage, env: env("http://127.0.0.1:4567/") })).toBeNull();
    // Truthy is not the marker.
    for (const marker of ["true", 1, "yes", {}]) {
      expect(
        updateHarnessFeed({
          isPackaged: true,
          metadata: { version: "0.9.7", markieUpdateHarness: marker },
          env: env("http://127.0.0.1:4567/"),
        })
      ).toBeNull();
    }
  });

  it("does nothing unpackaged, in a private build, or without the variable", () => {
    expect(updateHarnessFeed({ isPackaged: false, metadata: harnessBuild, env: env("http://127.0.0.1:1/") })).toBeNull();
    expect(
      updateHarnessFeed({
        isPackaged: true,
        metadata: { ...harnessBuild, markiePrivateRelease: { channel: "super-nightly" } },
        env: env("http://127.0.0.1:1/"),
      })
    ).toBeNull();
    expect(updateHarnessFeed({ isPackaged: true, metadata: harnessBuild, env: {} })).toBeNull();
    expect(updateHarnessFeed()).toBeNull();
  });

  it("refuses anything but plain http on the loopback interface", () => {
    for (const url of [
      "https://127.0.0.1:4567/",
      "http://192.168.1.10:4567/",
      "http://f005.backblazeb2.com/file/markie-releases/mac/",
      "http://127.0.0.1.evil.example/",
      "http://user:pass@127.0.0.1:4567/",
      "http://127.0.0.1:4567/?redirect=https://evil.example",
      "file:///tmp/feed/",
      "not a url",
    ]) {
      expect(updateHarnessFeed({ isPackaged: true, metadata: harnessBuild, env: env(url) }), url).toBeNull();
    }
    expect(updateHarnessFeed({ isPackaged: true, metadata: harnessBuild, env: env("http://localhost:9/") })?.url).toBe(
      "http://localhost:9/"
    );
  });

  it("is wired into main.js before the channel is set, and only through this module", () => {
    const main = readFileSync(path.join(root, "electron/main.js"), "utf8");
    expect(main).toContain('require("./update-harness")');
    expect(main.indexOf("updateHarnessFeed({")).toBeLessThan(main.indexOf("autoUpdater.channel = channel;"));
    expect(main.match(new RegExp(HARNESS_ENV, "g"))).toBeNull();
  });
});
