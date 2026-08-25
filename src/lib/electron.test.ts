import { describe, expect, it, vi } from "vitest";
import { safeApi, type ElectronAPI } from "./electron";

// safeApi is the renderer's only guarantee that a dead main process reads as a
// failed call rather than an unhandled rejection. These are the properties call
// sites depend on without ever naming them.
function api(overrides: Partial<ElectronAPI>): ElectronAPI {
  return overrides as unknown as ElectronAPI;
}

describe("safeApi", () => {
  it("folds a rejected invoke into { error }", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const safe = safeApi(
      api({
        saveFile: vi.fn(async () => {
          throw new Error("EPERM: operation not permitted");
        }),
      })
    )!;

    await expect(
      safe.saveFile({ filePath: "/x.md", content: "" })
    ).resolves.toEqual({ error: "EPERM: operation not permitted" });
    spy.mockRestore();
  });

  it("reports the message without an 'Error:' prefix", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const safe = safeApi(
      api({
        // A thrown, not returned, rejection: String(err) would read "Error: no".
        saveFile: vi.fn(async () => {
          throw new Error("Disk is full");
        }),
      })
    )!;
    const result = (await safe.saveFile({ filePath: "/x", content: "" })) as {
      error: string;
    };
    expect(result.error).toBe("Disk is full");
    expect(result.error).not.toMatch(/^Error:/);
    spy.mockRestore();
  });

  it("falls back to String() for a rejection that is not an Error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const safe = safeApi(
      api({
        saveFile: vi.fn(async () => {
          throw "plain string";
        }),
      })
    )!;
    await expect(
      safe.saveFile({ filePath: "/x", content: "" })
    ).resolves.toEqual({ error: "plain string" });
    spy.mockRestore();
  });

  it("passes on* subscriptions through untouched", () => {
    const off = vi.fn();
    const onMenuSave = vi.fn(() => off);
    const safe = safeApi(api({ onMenuSave }))!;

    // Identity matters: a wrapper here would return `{ error }` where an
    // unsubscribe function belongs, and effect cleanups would stop working.
    expect(safe.onMenuSave).toBe(onMenuSave);
    expect(safe.onMenuSave(() => {})).toBe(off);
  });

  it("hands back the same wrapper for the same method every time", () => {
    const safe = safeApi(api({ saveFile: vi.fn(async () => ({ success: true })) }))!;
    expect(safe.saveFile).toBe(safe.saveFile);
  });

  it("returns the same proxy for the same bridge", () => {
    const raw = api({ saveFile: vi.fn(async () => ({ success: true })) });
    expect(safeApi(raw)).toBe(safeApi(raw));
  });

  it("passes non-function members straight through", () => {
    const safe = safeApi(api({ platform: "darwin" }))!;
    expect(safe.platform).toBe("darwin");
  });

  it("returns null for no bridge at all", () => {
    expect(safeApi(null)).toBeNull();
  });
});
