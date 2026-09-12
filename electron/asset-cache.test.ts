// electron/asset-cache.test.ts
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

const { createAssetCache } = require("./asset-cache") as typeof import("./asset-cache");

// A real 64-hex sha256, the shape asset-cache.js now insists on before it
// will use a fetched hash as a filename.
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

const bytes = (s: string) => ({
  stream: Readable.toWeb(Readable.from(Buffer.from(s))),
  mime: "image/png",
  hash: hashOf(s),
  size: s.length,
});

describe("asset cache", () => {
  it("fetches once, then serves from disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const cache = createAssetCache({ dir, fetchAsset: async () => (fetches += 1, bytes("aaaa")) });
    const first = await cache.get("c1", "a.png");
    expect(first).toEqual({ path: path.join(dir, hashOf("aaaa")), mime: "image/png", size: 4 });
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

  it("refuses a fetch whose hash is not a real hash, rather than using it as a filename", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => ({
        stream: Readable.toWeb(Readable.from(Buffer.from("aaaa"))),
        mime: "image/png",
        hash: "../../not-a-hash",
        size: 4,
      }),
    });
    expect(await cache.get("c1", "a.png")).toBeNull();
  });

  it("dedupes two concurrent requests for the same asset into one fetch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    let resolveFetch: (value: ReturnType<typeof bytes>) => void = () => {};
    const deferred = new Promise<ReturnType<typeof bytes>>((resolve) => {
      resolveFetch = resolve;
    });
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => {
        fetches += 1;
        return deferred;
      },
    });

    const both = Promise.all([cache.get("c1", "a.png"), cache.get("c1", "a.png")]);
    resolveFetch(bytes("aaaa"));
    const [first, second] = await both;

    expect(fetches).toBe(1);
    expect(first).toEqual(second);
  });

  it("evicts the least recently used past the limit and clears on demand", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({ dir, fetchAsset: async (_c: string, ref: string) => bytes(ref.replace(".png", "").repeat(4)), limitBytes: 10 });
    await cache.get("c1", "a.png"); // 4 bytes
    await cache.get("c1", "b.png"); // 8
    await cache.get("c1", "a.png"); // a is now most recent
    await cache.get("c1", "c.png"); // 12 > 10: b goes
    expect(existsSync(path.join(dir, hashOf("aaaa")))).toBe(true);
    expect(existsSync(path.join(dir, hashOf("bbbb")))).toBe(false);
    expect(existsSync(path.join(dir, hashOf("cccc")))).toBe(true);
    await cache.clear();
    expect(existsSync(path.join(dir, hashOf("aaaa")))).toBe(false);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("keeps recency ordering correct even if the system clock moves backward between runs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const fetchAsset = async (_c: string, ref: string) => bytes(ref.replace(".png", "").repeat(4));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
      const cache = createAssetCache({ dir, fetchAsset });
      await cache.get("c1", "a.png");
      await cache.get("c1", "b.png");

      // The clock goes backward on the next run (DST fallback, an NTP
      // correction). Without seeding this instance's clock from the
      // persisted index, "now" reads as older than b's already-stored
      // timestamp, and touching a again would look older than b instead of
      // newer.
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const reopened = createAssetCache({ dir, fetchAsset, limitBytes: 10 });
      await reopened.get("c1", "a.png"); // touch a again, in the new process
      await reopened.get("c1", "c.png"); // 12 > 10: b, truly least recently used, must go

      expect(existsSync(path.join(dir, hashOf("aaaa")))).toBe(true);
      expect(existsSync(path.join(dir, hashOf("bbbb")))).toBe(false);
      expect(existsSync(path.join(dir, hashOf("cccc")))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws away a fetch that lands after a sign-out clear instead of resurrecting the old account's picture", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let resolveFetch: (value: ReturnType<typeof bytes>) => void = () => {};
    const deferred = new Promise<ReturnType<typeof bytes>>((resolve) => {
      resolveFetch = resolve;
    });
    const cache = createAssetCache({ dir, fetchAsset: async () => deferred });

    const pending = cache.get("c1", "a.png");
    await cache.clear(); // a sign-out lands while the fetch is still in flight
    resolveFetch(bytes("aaaa"));

    expect(await pending).toBeNull();
    expect(existsSync(path.join(dir, hashOf("aaaa")))).toBe(false);
  });

  // A ref is a name, not a hash: the same `a.png` can be relinked to new
  // bytes on the server, and an index hit served forever would show the old
  // picture on this machine until something evicted it.
  it("asks whether a hit is still current, and keeps the cached copy on a 304", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const asked: string[] = [];
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => (fetches += 1, bytes("aaaa")),
      revalidate: async (_c: string, _ref: string, etag: string) => (asked.push(etag), { fresh: true }),
    });

    const first = await cache.get("c1", "a.png");
    const second = await cache.get("c1", "a.png");

    expect(second).toEqual(first);
    expect(fetches).toBe(1);
    // The ETag of what is on disk, which is what makes the 304 possible.
    expect(asked).toEqual([`"${hashOf("aaaa")}"`]);
  });

  it("replaces a hit whose ref now points at different bytes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => bytes("aaaa"),
      revalidate: async () => ({ fetched: bytes("bbbb") }),
    });

    const first = await cache.get("c1", "a.png");
    const second = await cache.get("c1", "a.png");

    expect(second).toEqual({ path: path.join(dir, hashOf("bbbb")), mime: "image/png", size: 4 });
    expect(readFileSync(second!.path, "utf8")).toBe("bbbb");
    const stored = JSON.parse(readFileSync(path.join(dir, "cache.json"), "utf8"));
    expect(stored.entries["c1\ta.png"].hash).toBe(hashOf("bbbb"));
    // Nothing points at the old copy any more, and evict() only counts what
    // the index still names, so leaving it would leak the disk it takes.
    expect(existsSync(first!.path)).toBe(false);
  });

  it("serves nothing when a sign-out lands while a hit is being revalidated", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let answerRevalidate: (value: null) => void = () => {};
    const deferred = new Promise<null>((resolve) => {
      answerRevalidate = resolve;
    });
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => bytes("aaaa"),
      revalidate: async () => deferred,
    });
    await cache.get("c1", "a.png");

    const pending = cache.get("c1", "a.png");
    await cache.clear(); // a sign-out lands while the revalidation is still out
    answerRevalidate(null);

    // The cached copy this would otherwise fall back to went with the rest of
    // that account's pictures.
    expect(await pending).toBeNull();
  });

  it("serves the cached copy when revalidation cannot reach the server", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => (fetches += 1, bytes("aaaa")),
      revalidate: async () => null,
    });

    const first = await cache.get("c1", "a.png");
    const second = await cache.get("c1", "a.png");

    expect(second).toEqual(first);
    expect(readFileSync(second!.path, "utf8")).toBe("aaaa");
    expect(fetches).toBe(1);
  });

  it("finishes an interrupted sign-out clear on the next load", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const fetchAsset = async () => {
      fetches += 1;
      return bytes("aaaa");
    };
    const cache = createAssetCache({ dir, fetchAsset });
    await cache.get("c1", "a.png");
    expect(fetches).toBe(1);

    // The clear() itself could not finish (disk trouble, a locked file);
    // main.js leaves this marker in that case.
    await cache.markPendingClear();

    // The next process to open this same cache directory must not serve the
    // old account's picture straight out of the index it never got to wipe.
    const reopened = createAssetCache({ dir, fetchAsset });
    await reopened.get("c1", "a.png");
    expect(fetches).toBe(2);
  });
});
