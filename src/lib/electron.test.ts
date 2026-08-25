import { describe, expect, it, vi } from "vitest";
import { safeApi, type ElectronAPI } from "./electron";

// safeApi is the renderer's only guarantee that a dead main process reads as a
// failed call rather than an unhandled rejection. These are the properties call
// sites depend on without ever naming them.
function api(overrides: Partial<ElectronAPI>): ElectronAPI {
  return overrides as unknown as ElectronAPI;
}

// What contextBridge.exposeInMainWorld actually hands the renderer: every
// property read-only and non-configurable. A plain object literal is writable
// and configurable, so it cannot catch a Proxy that violates the invariant
// those flags impose — which is how a broken safeApi shipped while every test
// above stayed green.
function bridged(overrides: Partial<ElectronAPI>): ElectronAPI {
  const exposed = {};
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(exposed, key, {
      value,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }
  return exposed as unknown as ElectronAPI;
}

describe("safeApi", () => {
  it("works on an object exposed through contextBridge", async () => {
    // Reading any method off a Proxy whose get trap returns a wrapper throws
    //   TypeError: 'get' on proxy: property 'saveFile' is a read-only and
    //   non-configurable data property on the proxy target
    // The renderer swallowed that as a failed save: the user confirmed
    // "Yes, overwrite the file" and nothing whatsoever was written.
    const saveFile = vi.fn(async () => ({ success: true }));
    const safe = safeApi(bridged({ saveFile }))!;

    await expect(
      safe.saveFile({ filePath: "/x.md", content: "hello", force: true })
    ).resolves.toEqual({ success: true });
    expect(saveFile).toHaveBeenCalledWith({
      filePath: "/x.md",
      content: "hello",
      force: true,
    });
  });

  it("keeps method identity stable across reads of a bridged object", () => {
    // The reason the Proxy exists at all: effect deps and listener identity.
    const safe = safeApi(bridged({ saveFile: vi.fn(async () => ({ success: true })) }))!;
    expect(safe.saveFile).toBe(safe.saveFile);
  });

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
