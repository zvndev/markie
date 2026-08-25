import { describe, it, expect, vi } from "vitest";
import {
  crashDsn,
  readCrashConsent,
  sendCrash,
  writeCrashConsent,
} from "./crash-reporting.js";

// The module reads and writes one JSON file; that pair is the whole contract.
type ConsentFs = Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync">;

function memoryFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const fs = {
    readFileSync: (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    writeFileSync: (p: string, data: string) => void files.set(p, data),
  } as unknown as ConsentFs;
  return Object.assign(fs, { files });
}

const DSN = "https://key@o1.ingest.sentry.io/2";

const record = {
  at: "2026-08-19T12:00:00.000Z",
  source: "render",
  message: "boom",
  stack: "Error: boom\n    at f (app://markie/a.js:1:2)",
  version: "0.5.0",
  platform: "darwin/arm64",
};

describe("readCrashConsent", () => {
  it("is off until somebody says otherwise", () => {
    // The entire privacy posture rests on this default. Nothing infers consent.
    expect(readCrashConsent("/data", { fs: memoryFs() })).toBe(false);
  });

  it("reads back an explicit opt-in", () => {
    const fs = memoryFs();
    writeCrashConsent("/data", true, { fs });
    expect(readCrashConsent("/data", { fs })).toBe(true);
    writeCrashConsent("/data", false, { fs });
    expect(readCrashConsent("/data", { fs })).toBe(false);
  });

  it("treats a corrupted or truthy-but-not-true file as no consent", () => {
    for (const bad of ['{"enabled":"yes"}', "{broken", '{"enabled":1}', "null"]) {
      expect(readCrashConsent("/data", { fs: memoryFs({ "/data/crash-reporting.json": bad }) })).toBe(
        false
      );
    }
  });

  it("fails closed when storage cannot be read", () => {
    const hostile = {
      readFileSync: () => {
        throw new Error("EIO");
      },
      writeFileSync: () => {},
    } as unknown as ConsentFs;
    expect(readCrashConsent("/data", { fs: hostile })).toBe(false);
  });
});

describe("crashDsn", () => {
  it("prefers an explicit environment override", () => {
    expect(crashDsn({ MARKIE_SENTRY_DSN: DSN }, { config: { dsn: "https://other@h/9" } })).toBe(DSN);
  });

  it("falls back to the shipped config", () => {
    expect(crashDsn({}, { config: { dsn: DSN } })).toBe(DSN);
  });

  it("is null when no DSN is configured anywhere", () => {
    // Reporting must be completely inert in a build with no project behind it.
    expect(crashDsn({}, { config: { dsn: "" } })).toBe(null);
    expect(crashDsn({}, { config: {} })).toBe(null);
    expect(crashDsn({}, { config: null })).toBe(null);
  });
});

describe("sendCrash", () => {
  const opts = (over = {}) => ({
    dsn: DSN,
    home: "/Users/someone",
    environment: "production",
    clientVersion: "0.5.0",
    ...over,
  });

  it("posts an envelope to the project's ingest endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const sent = await sendCrash(record, opts({ fetchImpl }));
    expect(sent).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://o1.ingest.sentry.io/api/2/envelope/");
    expect(init.method).toBe("POST");
    expect(String((init.headers as Record<string, string>)["X-Sentry-Auth"])).toContain(
      "sentry_key=key"
    );
  });

  it("refuses to send without a usable DSN", async () => {
    const fetchImpl = vi.fn();
    expect(await sendCrash(record, opts({ dsn: "", fetchImpl }))).toBe(false);
    expect(await sendCrash(record, opts({ dsn: "nonsense", fetchImpl }))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws when the network is gone", async () => {
    // This runs while the app is already broken. Failing to report must not
    // become a second failure.
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(sendCrash(record, opts({ fetchImpl }))).resolves.toBe(false);
  });

  it("reports a rejected upload as not sent", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }));
    expect(await sendCrash(record, opts({ fetchImpl }))).toBe(false);
  });

  it("sends nothing that identifies the user or their documents", async () => {
    let body = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return { ok: true, status: 200 };
    });
    await sendCrash(
      {
        ...record,
        message: "ENOENT: /Users/someone/Desktop/Q3 salary review.md",
        stack: "Error: x\n    at read (/Users/someone/Desktop/Q3 salary review.md:1:1)",
      },
      opts({ fetchImpl })
    );
    expect(body).not.toContain("/Users/someone");
    expect(body).not.toContain("Desktop");
    expect(body).not.toContain("someone");
  });
});
