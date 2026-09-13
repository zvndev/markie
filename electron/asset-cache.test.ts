// electron/asset-cache.test.ts
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import realFsp from "node:fs/promises";
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

  it("evicts the least recently used past the limit and empties on sign-out", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({ dir, fetchAsset: async (_c: string, ref: string) => bytes(ref.replace(".png", "").repeat(4)), limitBytes: 10 });
    await cache.bindSession("s1");
    await cache.get("c1", "a.png"); // 4 bytes
    await cache.get("c1", "b.png"); // 8
    await cache.get("c1", "a.png"); // a is now most recent
    await cache.get("c1", "c.png"); // 12 > 10: b goes
    expect(existsSync(path.join(dir, hashOf("aaaa")))).toBe(true);
    expect(existsSync(path.join(dir, hashOf("bbbb")))).toBe(false);
    expect(existsSync(path.join(dir, hashOf("cccc")))).toBe(true);
    await cache.bindSession(null); // the sign-out
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
    await cache.bindSession("s1");

    const pending = cache.get("c1", "a.png");
    await cache.bindSession(null); // a sign-out lands while the fetch is still in flight
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

  // Chromium asks for a video one Range at a time and the protocol handler
  // calls get() for every one of them, so an unmemoed revalidation is a
  // conditional request per slice.
  it("asks at most once a minute, however often the same picture is served", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let asked = 0;
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => bytes("aaaa"),
      revalidate: async () => {
        asked += 1;
        return { fresh: true };
      },
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
      await cache.get("c1", "a.png"); // the miss that fills the cache
      await cache.get("c1", "a.png"); // a hit: asks
      await cache.get("c1", "a.png"); // still inside the window: does not ask
      expect(asked).toBe(1);

      vi.setSystemTime(new Date("2026-06-01T00:01:01.000Z"));
      await cache.get("c1", "a.png");
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves nothing from inside the memo window when a sign-out lands on the way", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => bytes("aaaa"),
      revalidate: async () => ({ fresh: true }),
    });
    await cache.bindSession("s1");
    await cache.get("c1", "a.png"); // fills the cache
    await cache.get("c1", "a.png"); // validates it, so the next get is memoed

    const pending = cache.get("c1", "a.png");
    await cache.bindSession(null); // a sign-out lands while the hit is being recorded

    // The memo is the one path that returns without asking anything, so it is
    // the one that could hand back a file the wipe failed to unlink.
    expect(await pending).toBeNull();
  });

  it("drops a picture the server says is gone rather than showing it from disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => bytes("aaaa"),
      revalidate: async () => ({ gone: true }),
    });

    const first = await cache.get("c1", "a.png");
    expect(await cache.get("c1", "a.png")).toBeNull();

    // A revoked share, or a ref the document no longer has. Keeping either
    // the entry or the file would go on showing it on this machine.
    const stored = JSON.parse(readFileSync(path.join(dir, "cache.json"), "utf8"));
    expect(stored.entries["c1\ta.png"]).toBeUndefined();
    expect(existsSync(first!.path)).toBe(false);
  });

  it("remembers nothing about a miss the server says is gone", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => {
        fetches += 1;
        return { gone: true };
      },
    });

    expect(await cache.get("c1", "a.png")).toBeNull();

    expect(readdirSync(dir).filter((name) => name !== "cache.json")).toEqual([]);
    expect(await cache.get("c1", "a.png")).toBeNull();
    expect(fetches).toBe(2);
  });

  it("keeps serving the cached copy when the replacement dies mid-download", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => bytes("aaaa"),
      revalidate: async () => ({
        fetched: {
          stream: new ReadableStream({
            start(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          mime: "image/png",
          hash: hashOf("bbbb"),
          size: 4,
        },
      }),
    });

    const first = await cache.get("c1", "a.png");
    const second = await cache.get("c1", "a.png");

    // The download failed, so what is on disk is still the last copy that
    // worked. Blanking the picture would be a worse answer than a stale one.
    expect(second).toEqual(first);
    expect(readFileSync(second!.path, "utf8")).toBe("aaaa");
    // And the part file the failed download left goes with it.
    expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);
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
    await cache.bindSession("s1");
    await cache.get("c1", "a.png");

    const pending = cache.get("c1", "a.png");
    await cache.bindSession(null); // a sign-out lands while the revalidation is still out
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

  it("stores the same bytes twice over without either request losing its file", async () => {
    // Two refs to one picture, finishing together. Both temp files were named
    // hash + pid + millisecond, so inside the same millisecond they were the
    // same path: one rename won, the other hit ENOENT and its request 404ed.
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cache = createAssetCache({
        dir,
        fetchAsset: async () => {
          await gate;
          return bytes("aaaa");
        },
      });

      const both = Promise.all([cache.get("c1", "a.png"), cache.get("c1", "b.png")]);
      release();
      const [first, second] = await both;

      expect(first).toEqual({ path: path.join(dir, hashOf("aaaa")), mime: "image/png", size: 4 });
      expect(second).toEqual(first);
      expect(readFileSync(first!.path, "utf8")).toBe("aaaa");
      expect(readdirSync(dir).filter((name) => name.includes(".part"))).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps the cache across a relaunch of the same session", async () => {
    // The whole reason the cache remembers a session key. `config` starts
    // empty in every new main process and the renderer's first push carries
    // the stored token, so a clear driven by "the session changed" emptied
    // this directory on every cold start of a signed-in app.
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const fetchAsset = async () => {
      fetches += 1;
      return bytes("aaaa");
    };
    const first = createAssetCache({ dir, fetchAsset });
    await first.bindSession("key-a");
    await first.get("c1", "a.png");
    expect(fetches).toBe(1);

    // A new process, the same account: the index on disk already says whose
    // these are.
    const relaunched = createAssetCache({ dir, fetchAsset });
    await relaunched.bindSession("key-a");
    await relaunched.get("c1", "a.png");
    expect(fetches).toBe(1);
  });

  it("binds a key to a fresh cache without disturbing it, and keeps it on a repeat", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const fetchAsset = async () => {
      fetches += 1;
      return bytes("aaaa");
    };
    const cache = createAssetCache({ dir, fetchAsset });

    // An empty cache has nothing to lose to the binding.
    await cache.bindSession("key-a");
    await cache.get("c1", "a.png");
    expect(fetches).toBe(1);

    // The renderer pushes the same config often. None of those may clear.
    await cache.bindSession("key-a");
    await cache.bindSession("key-a");
    await cache.get("c1", "a.png");
    expect(fetches).toBe(1);
  });

  it("empties the cache when another session binds to it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const fetchAsset = async () => {
      fetches += 1;
      return bytes("aaaa");
    };
    const cache = createAssetCache({ dir, fetchAsset });
    await cache.bindSession("key-a");
    await cache.get("c1", "a.png");
    expect(readdirSync(dir)).toContain(hashOf("aaaa"));

    // Account B's token replaces account A's, with no sign-out in between.
    await cache.bindSession("key-b");
    expect(readdirSync(dir)).not.toContain(hashOf("aaaa"));
    await cache.get("c1", "a.png");
    expect(fetches).toBe(2);
  });

  it("empties the cache on sign-out, and again when a session follows one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const fetchAsset = async () => {
      fetches += 1;
      return bytes("aaaa");
    };
    const cache = createAssetCache({ dir, fetchAsset });
    await cache.bindSession("key-a");
    await cache.get("c1", "a.png");

    await cache.bindSession(null);
    expect(readdirSync(dir)).not.toContain(hashOf("aaaa"));

    await cache.bindSession("key-a");
    await cache.get("c1", "a.png");
    expect(fetches).toBe(2);
  });

  it("empties a cache an older build left with no session recorded", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const fetchAsset = async () => {
      fetches += 1;
      return bytes("aaaa");
    };
    const before = createAssetCache({ dir, fetchAsset });
    await before.get("c1", "a.png");
    expect(fetches).toBe(1);

    // Nothing on disk says whose those bytes are, so they go.
    const upgraded = createAssetCache({ dir, fetchAsset });
    await upgraded.bindSession("key-a");
    await upgraded.get("c1", "a.png");
    expect(fetches).toBe(2);
  });

  it("refuses to say a sign-out finished when a file would not go", async () => {
    // Windows will not unlink a cached video another handle is still reading.
    // A clear that swallowed that resolved, main never wrote the marker, and
    // the signed-out account's bytes stayed on this disk indefinitely.
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let fetches = 0;
    const fetchAsset = async () => {
      fetches += 1;
      return bytes("aaaa");
    };
    const locked = hashOf("aaaa");
    const stubborn = {
      ...realFsp,
      rm: async (target: Parameters<typeof realFsp.rm>[0], opts?: Parameters<typeof realFsp.rm>[1]) => {
        if (path.basename(String(target)) === locked) throw new Error("EPERM: file is open");
        return realFsp.rm(target, opts);
      },
    };
    const cache = createAssetCache({ dir, fetchAsset, fsp: stubborn });
    await cache.bindSession("s1");
    await cache.get("c1", "a.png");
    expect(existsSync(path.join(dir, locked))).toBe(true);

    await expect(cache.bindSession(null)).rejects.toThrow(/could not be removed/);
    expect(existsSync(path.join(dir, locked))).toBe(true);

    // What main.js does with that rejection.
    await cache.markPendingClear();

    // The next start finishes the job before it serves anything.
    const reopened = createAssetCache({ dir, fetchAsset });
    await reopened.get("c1", "a.png");
    expect(fetches).toBe(2);
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

    // The wipe itself could not finish (disk trouble, a locked file);
    // main.js leaves this marker in that case.
    await cache.markPendingClear();

    // The next process to open this same cache directory must not serve the
    // old account's picture straight out of the index it never got to wipe.
    const reopened = createAssetCache({ dir, fetchAsset });
    await reopened.get("c1", "a.png");
    expect(fetches).toBe(2);
  });
});

// The hash the response carried in its ETag names the file on this disk, and
// the cache is content-addressed and first-writer-wins, so one response that
// lies about its ETag poisons every other (cloudId, ref) in the account that
// later resolves to the same hash. Against the real server this is not
// reachable, because the upload route recomputes the digest and refuses a
// mismatch. That is the server's correctness standing in for the client's, on
// the side that actually names a file in the user's home directory.
describe("the cache checks its own bytes", () => {
  const lying = (body: string, claimed: { hash?: string; size?: number } = {}) => ({
    stream: Readable.toWeb(Readable.from(Buffer.from(body))),
    mime: "image/png",
    hash: claimed.hash ?? hashOf(body),
    size: claimed.size ?? body.length,
  });

  it("files nothing when the bytes do not hash to the name they came under", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const claimed = hashOf("the-real-picture");
    const cache = createAssetCache({ dir, fetchAsset: async () => lying("something-else", { hash: claimed }) });

    expect(await cache.get("c1", "a.png")).toBeNull();
    // Neither the file under the claimed name nor a part file survives.
    expect(existsSync(path.join(dir, claimed))).toBe(false);
    // Nothing at all: no part file, and no index entry either, since the
    // index is only written once something is filed.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps serving a later honest answer for the same ref", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    let honest = false;
    const cache = createAssetCache({
      dir,
      fetchAsset: async () => (honest ? lying("aaaa") : lying("something-else", { hash: hashOf("aaaa") })),
    });
    expect(await cache.get("c1", "a.png")).toBeNull();
    honest = true;
    const got = await cache.get("c1", "a.png");
    expect(got).toEqual({ path: path.join(dir, hashOf("aaaa")), mime: "image/png", size: 4 });
    expect(readFileSync(got!.path, "utf8")).toBe("aaaa");
  });

  it("records the bytes it actually wrote, not the length the response declared", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    // A response with no Content-Length at all reaches store() as size 0, and
    // a recorded 0 can never push the cache over its 2 GB bound: the
    // directory grew without limit on the user's disk.
    const cache = createAssetCache({ dir, fetchAsset: async () => lying("aaaaaaaa", { size: 0 }) });
    const got = await cache.get("c1", "a.png");
    expect(got?.size).toBe(8);
    expect(statSync(got!.path).size).toBe(8);
    const entry = JSON.parse(readFileSync(path.join(dir, "cache.json"), "utf8")).entries["c1\ta.png"];
    expect(entry.size).toBe(8);
  });

  it("evicts on what is on disk, so a lied-about size cannot keep the cache over its bound", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "markie-asset-cache-"));
    const bodies = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    let next = 0;
    const cache = createAssetCache({
      dir,
      limitBytes: 100,
      fetchAsset: async () => lying(bodies[next++], { size: 0 }),
    });
    await cache.get("c1", "a.png");
    await cache.get("c1", "b.png");
    await cache.get("c1", "c.png");
    // 120 bytes of real content against a 100-byte bound: the oldest goes.
    expect(existsSync(path.join(dir, hashOf(bodies[0])))).toBe(false);
    expect(existsSync(path.join(dir, hashOf(bodies[2])))).toBe(true);
  });
});
