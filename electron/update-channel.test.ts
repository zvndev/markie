import { describe, it, expect } from "vitest";
import {
  BETA_CHANNEL,
  STABLE_CHANNEL,
  channelFor,
  feedFor,
  isPrerelease,
  readBetaOptIn,
  updaterSettingsFor,
  writeBetaOptIn,
} from "./update-channel.js";

function memoryFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFileSync: (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    writeFileSync: (p: string, data: string) => void files.set(p, data),
  };
}

describe("channelFor", () => {
  it("defaults to stable", () => {
    // A user who never opted in must never be moved onto beta by anything.
    expect(channelFor(false)).toBe(STABLE_CHANNEL);
    expect(channelFor(undefined)).toBe(STABLE_CHANNEL);
    expect(channelFor(null)).toBe(STABLE_CHANNEL);
  });

  it("uses beta only for an explicit opt-in", () => {
    expect(channelFor(true)).toBe(BETA_CHANNEL);
  });

  it("does not treat a truthy non-boolean as consent", () => {
    // The value comes off disk, where a corrupted file can hold anything.
    expect(channelFor("yes" as unknown as boolean)).toBe(STABLE_CHANNEL);
    expect(channelFor(1 as unknown as boolean)).toBe(STABLE_CHANNEL);
  });
});

describe("feedFor", () => {
  it("maps channels to the electron-builder mac feed files", () => {
    expect(feedFor(STABLE_CHANNEL)).toBe("latest-mac.yml");
    expect(feedFor(BETA_CHANNEL)).toBe("beta-mac.yml");
  });

  it("keeps the two feeds distinct so a beta cannot overwrite stable", () => {
    expect(feedFor(BETA_CHANNEL)).not.toBe(feedFor(STABLE_CHANNEL));
  });
});

describe("isPrerelease", () => {
  it("recognises a beta build", () => {
    expect(isPrerelease("0.5.0-beta.1")).toBe(true);
  });

  it("does not mistake a stable build for one", () => {
    expect(isPrerelease("0.5.0")).toBe(false);
    expect(isPrerelease("0.4.0")).toBe(false);
  });

  it("survives a missing or malformed version", () => {
    expect(isPrerelease("")).toBe(false);
    expect(isPrerelease(undefined)).toBe(false);
  });
});

describe("updaterSettingsFor", () => {
  it("puts an opted-in user on the beta feed", () => {
    const s = updaterSettingsFor({ optedIn: true, currentVersion: "0.4.0" });
    expect(s.channel).toBe(BETA_CHANNEL);
  });

  it("brings a beta user back down to stable when they opt out", () => {
    // This is the bail-out. Without allowDowngrade the user is stranded above
    // stable: 0.5.0-beta.1 is newer than 0.4.0, so the stable feed offers them
    // nothing and they sit on the build we withdrew.
    const s = updaterSettingsFor({ optedIn: false, currentVersion: "0.5.0-beta.1" });
    expect(s.channel).toBe(STABLE_CHANNEL);
    expect(s.allowDowngrade).toBe(true);
  });

  it("never downgrades a user who was always on stable", () => {
    const s = updaterSettingsFor({ optedIn: false, currentVersion: "0.4.0" });
    expect(s.channel).toBe(STABLE_CHANNEL);
    expect(s.allowDowngrade).toBe(false);
  });

  it("does not downgrade someone still opted in to beta", () => {
    const s = updaterSettingsFor({ optedIn: true, currentVersion: "0.5.0-beta.1" });
    expect(s.allowDowngrade).toBe(false);
  });
});

describe("readBetaOptIn", () => {
  it("is false when nothing has ever been written", () => {
    // The default has to survive a fresh install with no file at all.
    const fs = memoryFs();
    expect(readBetaOptIn("/data", { fs })).toBe(false);
  });

  it("reads back what was written", () => {
    const fs = memoryFs();
    writeBetaOptIn("/data", true, { fs });
    expect(readBetaOptIn("/data", { fs })).toBe(true);
    writeBetaOptIn("/data", false, { fs });
    expect(readBetaOptIn("/data", { fs })).toBe(false);
  });

  it("falls back to stable on a corrupted file rather than throwing", () => {
    // A crash here happens before the window exists, so it is invisible and
    // fatal. Stable is the safe answer to "I cannot tell".
    const fs = memoryFs({ "/data/update-channel.json": "{not json" });
    expect(readBetaOptIn("/data", { fs })).toBe(false);
  });

  it("ignores a file whose shape is wrong", () => {
    const fs = memoryFs({ "/data/update-channel.json": '{"beta":"yes"}' });
    expect(readBetaOptIn("/data", { fs })).toBe(false);
  });
});

describe("writeBetaOptIn", () => {
  it("reports failure instead of throwing when the disk refuses", () => {
    const fs = {
      readFileSync: () => {
        throw new Error("nope");
      },
      writeFileSync: () => {
        throw new Error("EROFS");
      },
    };
    expect(() => writeBetaOptIn("/data", true, { fs })).not.toThrow();
    expect(writeBetaOptIn("/data", true, { fs })).toBe(false);
  });

  it("reports success on a normal write", () => {
    const fs = memoryFs();
    expect(writeBetaOptIn("/data", true, { fs })).toBe(true);
  });
});
