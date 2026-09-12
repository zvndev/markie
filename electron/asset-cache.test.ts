// electron/asset-cache.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const { createAssetCache } = require("./asset-cache") as typeof import("./asset-cache");

const bytes = (s: string) => ({ stream: Readable.toWeb(Readable.from(Buffer.from(s))), mime: "image/png", hash: `h-${s}`, size: s.length });

describe("asset cache", () => {
  it("fetches once, then serves from disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const cache = createAssetCache({ dir, fetchAsset: async () => (fetches += 1, bytes("aaaa")) });
    const first = await cache.get("c1", "a.png");
    expect(first).toEqual({ path: path.join(dir, "h-aaaa"), mime: "image/png", size: 4 });
    expect(readFileSync(first!.path, "utf8")).toBe("aaaa");
    await cache.get("c1", "a.png");
    expect(fetches).toBe(1);
  });

  it("answers null for a miss on the server and does not remember it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let answer: ReturnType<typeof bytes> | null = null;
    const cache = createAssetCache({ dir, fetchAsset: async () => answer });
    expect(await cache.get("c1", "a.png")).toBeNull();
    answer = bytes("aaaa");
    expect((await cache.get("c1", "a.png"))?.size).toBe(4);
  });

  it("evicts the least recently used past the limit and clears on demand", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({ dir, fetchAsset: async (_c: string, ref: string) => bytes(ref.replace(".png", "").repeat(4)), limitBytes: 10 });
    await cache.get("c1", "a.png"); // 4 bytes
    await cache.get("c1", "b.png"); // 8
    await cache.get("c1", "a.png"); // a is now most recent
    await cache.get("c1", "c.png"); // 12 > 10: b goes
    expect(existsSync(path.join(dir, "h-aaaa"))).toBe(true);
    expect(existsSync(path.join(dir, "h-bbbb"))).toBe(false);
    expect(existsSync(path.join(dir, "h-cccc"))).toBe(true);
    await cache.clear();
    expect(existsSync(path.join(dir, "h-aaaa"))).toBe(false);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
