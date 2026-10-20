import { describe, it, expect } from "vitest";
import {
  BETA_CHANNEL,
  STABLE_CHANNEL,
  channelFor,
  feedFor,
  isPrerelease,
  readBetaOptIn,
  readChannelPrefs,
  settleLeftEarly,
  updaterSettingsFor,
  writeBetaOptIn,
} from "./update-channel.js";

// The module reads and writes one JSON file; that pair is the whole contract.
type ChannelFs = Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync">;

function memoryFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const fs = {
    readFileSync: (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    writeFileSync: (p: string, data: string) => void files.set(p, data),
  } as unknown as ChannelFs;
  return Object.assign(fs, { files });
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
    expect(feedFor(STABLE_CHANNEL, "darwin")).toBe("latest-mac.yml");
    expect(feedFor(BETA_CHANNEL, "darwin")).toBe("beta-mac.yml");
  });

  it("names windows feeds without the -mac suffix", () => {
    // electron-builder writes latest.yml / beta.yml for NSIS. Pointing a
    // Windows install at a mac feed would offer it a .dmg it cannot install.
    expect(feedFor(STABLE_CHANNEL, "win32")).toBe("latest.yml");
    expect(feedFor(BETA_CHANNEL, "win32")).toBe("beta.yml");
  });

  it("defaults to the platform it is running on", () => {
    expect(feedFor(STABLE_CHANNEL)).toBe(feedFor(STABLE_CHANNEL, process.platform));
    expect(feedFor(BETA_CHANNEL)).toBe(feedFor(BETA_CHANNEL, process.platform));
  });

  it("keeps the two feeds distinct so a beta cannot overwrite stable", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(feedFor(BETA_CHANNEL, platform)).not.toBe(feedFor(STABLE_CHANNEL, platform));
    }
  });

  it("never hands an unsupported platform a beta feed by accident", () => {
    // Linux has no published feed. Falling through to the mac table is the
    // existing behavior for an unknown channel; keep it explicit rather than
    // letting an unmapped platform silently pick up beta.
    expect(feedFor("nonsense", "linux")).toBe(feedFor(STABLE_CHANNEL, "linux"));
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

describe("stable-numbered early builds", () => {
  // The three-stage pipeline publishes 0.9.0 (not 0.9.0-beta.1) to the early
  // feed, so the version string alone can no longer say "this came from early".

  it("keeps an early user on the early feed for a stable-style version", () => {
    const s = updaterSettingsFor({ optedIn: true, currentVersion: "0.9.0" });
    expect(s.channel).toBe(BETA_CHANNEL);
    expect(s.allowDowngrade).toBe(false);
  });

  it("walks the exact build a user left early access on back down to stable", () => {
    const s = updaterSettingsFor({
      optedIn: false,
      currentVersion: "0.9.0",
      leftEarlyFrom: "0.9.0",
    });
    expect(s.channel).toBe(STABLE_CHANNEL);
    expect(s.allowDowngrade).toBe(true);
  });

  it("stops allowing a downgrade once the user is on any other build", () => {
    const s = updaterSettingsFor({
      optedIn: false,
      currentVersion: "0.8.0",
      leftEarlyFrom: "0.9.0",
    });
    expect(s.allowDowngrade).toBe(false);
  });

  it("records the version a user left from, and only when they were opted in", () => {
    const fs = memoryFs();
    // Never opted in: turning it "off" records nothing.
    writeBetaOptIn("/data", false, { fs, currentVersion: "0.8.0" });
    expect(readChannelPrefs("/data", { fs })).toEqual({ optedIn: false, leftEarlyFrom: null });

    writeBetaOptIn("/data", true, { fs, currentVersion: "0.8.0" });
    expect(readChannelPrefs("/data", { fs })).toEqual({ optedIn: true, leftEarlyFrom: null });

    writeBetaOptIn("/data", false, { fs, currentVersion: "0.9.0" });
    expect(readChannelPrefs("/data", { fs })).toEqual({ optedIn: false, leftEarlyFrom: "0.9.0" });
    // The original key is still there, so older builds read the file the same.
    expect(JSON.parse(fs.files.get("/data/update-channel.json") ?? "{}")).toMatchObject({
      beta: false,
    });
  });

  it("clears the marker when the user opts back in", () => {
    const fs = memoryFs({
      "/data/update-channel.json": '{"beta":false,"leftEarlyFrom":"0.9.0"}',
    });
    writeBetaOptIn("/data", true, { fs, currentVersion: "0.9.0" });
    expect(readChannelPrefs("/data", { fs }).leftEarlyFrom).toBeNull();
  });

  it("settles a stale marker once the install has moved off that build", () => {
    const fs = memoryFs({
      "/data/update-channel.json": '{"beta":false,"leftEarlyFrom":"0.9.0"}',
    });
    expect(settleLeftEarly("/data", "0.9.0", { fs })).toBe(false);
    expect(readChannelPrefs("/data", { fs }).leftEarlyFrom).toBe("0.9.0");
    expect(settleLeftEarly("/data", "0.8.0", { fs })).toBe(true);
    expect(readChannelPrefs("/data", { fs })).toEqual({ optedIn: false, leftEarlyFrom: null });
  });

  it("ignores a marker of the wrong shape", () => {
    const fs = memoryFs({ "/data/update-channel.json": '{"beta":false,"leftEarlyFrom":7}' });
    expect(readChannelPrefs("/data", { fs }).leftEarlyFrom).toBeNull();
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
    } as unknown as ChannelFs;
    expect(() => writeBetaOptIn("/data", true, { fs })).not.toThrow();
    expect(writeBetaOptIn("/data", true, { fs })).toBe(false);
  });

  it("reports success on a normal write", () => {
    const fs = memoryFs();
    expect(writeBetaOptIn("/data", true, { fs })).toBe(true);
  });
});
