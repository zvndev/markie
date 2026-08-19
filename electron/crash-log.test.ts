import { describe, it, expect } from "vitest";
import { appendCrash, readCrashes, CRASH_LOG_MAX_BYTES } from "./crash-log.js";

function memoryFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    writeFileSync: (p: string, data: string) => void files.set(p, data),
    appendFileSync: (p: string, data: string) => void files.set(p, (files.get(p) ?? "") + data),
    statSync: (p: string) => ({ size: Buffer.byteLength(files.get(p) ?? "") }),
  };
}

const record = (message: string) => ({
  at: "2026-08-19T00:00:00.000Z",
  source: "render" as const,
  message,
  stack: "Error: x\n  at y",
  version: "0.4.0",
  platform: "darwin",
});

describe("appendCrash", () => {
  it("writes a crash that can be read back", () => {
    const fs = memoryFs();
    appendCrash("/data", record("boom"), { fs });
    expect(readCrashes("/data", { fs })).toHaveLength(1);
    expect(readCrashes("/data", { fs })[0].message).toBe("boom");
  });

  it("keeps every crash, newest last", () => {
    const fs = memoryFs();
    appendCrash("/data", record("first"), { fs });
    appendCrash("/data", record("second"), { fs });
    const all = readCrashes("/data", { fs });
    expect(all.map((r) => r.message)).toEqual(["first", "second"]);
  });

  it("never throws when the disk refuses", () => {
    // This runs on the failure path. A reporter that throws while reporting a
    // crash converts a recoverable error into a silent one.
    const fs = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("EIO");
      },
      writeFileSync: () => {
        throw new Error("EROFS");
      },
      appendFileSync: () => {
        throw new Error("EROFS");
      },
      statSync: () => {
        throw new Error("EIO");
      },
    };
    expect(() => appendCrash("/data", record("boom"), { fs })).not.toThrow();
    expect(appendCrash("/data", record("boom"), { fs })).toBe(false);
  });

  it("rotates rather than growing without bound", () => {
    // A crash loop writes a report per frame. Unbounded, that fills the disk of
    // someone whose app is already broken.
    const fs = memoryFs();
    fs.files.set("/data/crash.log", "x".repeat(CRASH_LOG_MAX_BYTES + 10));
    appendCrash("/data", record("after-rotate"), { fs });
    const size = Buffer.byteLength(fs.files.get("/data/crash.log")!);
    expect(size).toBeLessThan(CRASH_LOG_MAX_BYTES);
    // The newest crash is the one worth keeping.
    expect(readCrashes("/data", { fs }).at(-1)?.message).toBe("after-rotate");
  });
});

describe("readCrashes", () => {
  it("is empty when nothing has ever crashed", () => {
    expect(readCrashes("/data", { fs: memoryFs() })).toEqual([]);
  });

  it("skips a corrupted line instead of losing the whole log", () => {
    // A half-written line from a hard kill must not hide every other report.
    const fs = memoryFs({
      "/data/crash.log": `${JSON.stringify(record("good"))}\n{not json\n${JSON.stringify(record("also good"))}\n`,
    });
    expect(readCrashes("/data", { fs }).map((r) => r.message)).toEqual(["good", "also good"]);
  });
});
