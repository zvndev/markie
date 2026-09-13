import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// sync.js reaches the registry through CJS require(), which vi.mock cannot
// intercept: an ESM import of ./registry.js yields a *different* instance from
// the one sync.js holds. Loading both through the same require() cache is what
// makes the swapped-in fake below visible to the module under test.
const load = createRequire(import.meta.url);
const registry = load("./registry.js");
const sync = load("./sync.js");

// The only origin setConfig will accept outside dev mode.
const SERVER = "https://api-production-602f.up.railway.app";

// Whoever is signed in for these tests, and somebody else.
const ME = "user-me";
const THEM = "user-them";

// The renderer's sequence, in two pushes: the token is stored, and only later
// does /api/me say who it belongs to. The first push carries whatever principal
// the renderer had before, which is why the engine must not trust it.
function signIn(token: string, userId: string) {
  sync.setConfig({ token, serverURL: SERVER });
  sync.setConfig({ token, serverURL: SERVER, userId });
}

interface Row {
  path: string;
  name: string;
  sync_state: string;
  cloud_doc_id: string | null;
  cloud_version: number;
  content_hash: string | null;
  last_synced_at: string | null;
  last_opened_at: string | null;
  // The last role the server confirmed for this file, and the account it was
  // confirmed for.
  share_role?: "owner" | "editor" | "viewer" | null;
  share_role_user?: string | null;
  // What reconciliation (electron/reconcile.js) last learned about this
  // row's media.
  assets_state?: string | null;
  assets_skipped?: string | null;
}

const realRegistry = { ...registry };
let rows: Map<string, Row>;
let tmpDir: string;

// An in-memory stand-in for the SQLite registry. It applies updates for real so
// the assertions can read the row's resulting state, which is the thing the
// P0 was about: what the Library is later told about this file.
function seedRow(overrides: Partial<Row> & { path: string }): Row {
  const row: Row = {
    name: path.basename(overrides.path),
    sync_state: "local-only",
    cloud_doc_id: null,
    cloud_version: 0,
    content_hash: null,
    last_synced_at: null,
    last_opened_at: "2026-08-01T00:00:00.000Z",
    share_role: null,
    share_role_user: null,
    ...overrides,
  };
  rows.set(row.path, row);
  return row;
}

interface Reply {
  status: number;
  body?: unknown;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

// Queues one reply per request. An Error in the queue is thrown by fetch itself,
// which is how being offline actually presents (no status ever arrives).
function respondWith(...replies: Array<Reply | Error>): Call[] {
  const queue = [...replies];
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({
        method: init.method,
        url,
        body: init.body ? JSON.parse(init.body) : null,
      });
      const next = queue.shift();
      if (!next) throw new Error(`unexpected request: ${init.method} ${url}`);
      if (next instanceof Error) throw next;
      return { status: next.status, json: async () => next.body ?? null };
    })
  );
  return calls;
}

let realHome: string | undefined;

beforeEach(() => {
  rows = new Map();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-sync-"));
  // Landing writes under the default workspace, which hangs off the home
  // directory. Every test gets a throwaway one.
  realHome = process.env.HOME;
  process.env.HOME = tmpDir;
  registry.listRoots = () => [];
  registry.addRoot = () => {};
  registry.get = (p: string) => rows.get(p);
  registry.update = (p: string, fields: Partial<Row>) => {
    const row = rows.get(p);
    if (row) Object.assign(row, fields);
  };
  registry.hashContent = (content: string) => `hash:${content}`;
  registry.list = () => [...rows.values()];
  registry.pruneMissing = () => 0;
  registry.track = () => {};
  registry.forget = (p: string) => {
    rows.delete(p);
  };
  signIn("test-token", ME);
});

afterEach(() => {
  Object.assign(registry, realRegistry);
  // Reset for every test regardless of which one set it, so a test that
  // configures asset sync can never leak it into one that runs after.
  sync.setAssetSync(null);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("push", () => {
  const syncedRow = (p: string) =>
    seedRow({
      path: p,
      sync_state: "synced",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
      content_hash: "hash:old",
    });

  it("records the new version and hash when the server accepts the snapshot", async () => {
    const row = syncedRow("/docs/a.md");
    const calls = respondWith({ status: 200, body: { version: 5 } });

    const res = await sync.push("/docs/a.md", "a.md", "new");

    expect(res).toEqual({ ok: true, version: 5, media: null });
    expect(row.sync_state).toBe("synced");
    expect(row.cloud_version).toBe(5);
    expect(row.content_hash).toBe("hash:new");
    expect(row.last_synced_at).not.toBeNull();
    expect(calls[0].body).toMatchObject({ baseVersion: 4, hash: "hash:new" });
  });

  it("marks the row unpushed on 403 rather than leaving it synced", async () => {
    const row = syncedRow("/docs/a.md");
    respondWith({ status: 403 });

    const res = await sync.push("/docs/a.md", "a.md", "new");

    expect(row.sync_state).toBe("unpushed");
    expect(row.sync_state).not.toBe("synced");
    expect(res.error).toBe("push failed (403)");
    expect(res.ok).toBeUndefined();
  });

  it("marks the row unpushed on 500", async () => {
    const row = syncedRow("/docs/a.md");
    respondWith({ status: 500 });

    const res = await sync.push("/docs/a.md", "a.md", "new");

    expect(row.sync_state).toBe("unpushed");
    expect(res.error).toBe("push failed (500)");
  });

  it("marks the row unpushed when the request throws (offline)", async () => {
    const row = syncedRow("/docs/a.md");
    respondWith(new TypeError("fetch failed"));

    // Resolving rather than rejecting is the assertion: this used to escape as
    // an unhandled rejection, so the row was never updated at all.
    await expect(sync.push("/docs/a.md", "a.md", "new")).resolves.toEqual({
      error: "push failed (offline)",
      media: null,
    });
    expect(row.sync_state).toBe("unpushed");
    expect(row.content_hash).toBe("hash:old");
  });

  it("leaves the row unpushed when the version counter is stale but not conflicting", async () => {
    const row = syncedRow("/docs/a.md");
    respondWith({ status: 418 });

    await sync.push("/docs/a.md", "a.md", "new");

    expect(row.sync_state).toBe("unpushed");
  });

  it("marks the row conflict on 409", async () => {
    const row = syncedRow("/docs/a.md");
    respondWith({ status: 409 });

    const res = await sync.push("/docs/a.md", "a.md", "new");

    expect(row.sync_state).toBe("conflict");
    expect(res).toEqual({ conflict: true, media: null });
  });

  it("retries an unpushed row and restores it to synced once the push lands", async () => {
    // Without this the "unpushed" state would be a dead end: push() only ever
    // accepted "synced" rows, so a failed push could never be retried.
    const row = seedRow({
      path: "/docs/a.md",
      sync_state: "unpushed",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
    });
    respondWith({ status: 200, body: { version: 5 } });

    const res = await sync.push("/docs/a.md", "a.md", "recovered");

    expect(res).toEqual({ ok: true, version: 5, media: null });
    expect(row.sync_state).toBe("synced");
    expect(row.cloud_version).toBe(5);
  });

  it("skips rows that were never cloud-linked", async () => {
    seedRow({ path: "/docs/a.md", sync_state: "local-only" });
    respondWith();

    expect(await sync.push("/docs/a.md", "a.md", "new")).toEqual({
      skipped: "not synced",
    });
  });
});

describe("syncOn", () => {
  it("marks the row unpushed when the server refuses the first snapshot", async () => {
    const row = seedRow({ path: "/docs/a.md", sync_state: "local-only" });
    respondWith({ status: 500 });

    const res = await sync.syncOn("/docs/a.md", "a.md", "hello");

    expect(row.sync_state).toBe("unpushed");
    expect(res.error).toBe("push failed (500)");
  });

  it("marks the row unpushed when the request throws (offline)", async () => {
    const row = seedRow({ path: "/docs/a.md", sync_state: "local-only" });
    respondWith(new TypeError("fetch failed"));

    await expect(sync.syncOn("/docs/a.md", "a.md", "hello")).resolves.toEqual({
      error: "push failed (offline)",
      media: null,
    });
    expect(row.sync_state).toBe("unpushed");
  });

  it("marks the row synced when the server accepts it", async () => {
    const row = seedRow({ path: "/docs/a.md", sync_state: "local-only" });
    respondWith({ status: 200, body: { version: 1 } });

    const res = await sync.syncOn("/docs/a.md", "a.md", "hello");

    expect(res).toEqual({ ok: true, version: 1, media: null });
    expect(row.sync_state).toBe("synced");
    expect(row.cloud_doc_id).toBeTruthy();
  });

  it("remembers the cloud id when the accepted PUT comes back unreadable", async () => {
    const row = seedRow({ path: "/docs/a.md", sync_state: "local-only" });
    respondWith({ status: 200, body: { ok: true } });

    const first = await sync.syncOn("/docs/a.md", "a.md", "hello");

    expect(first.error).toMatch(/unreadable/i);
    // The server stored the doc; only the version was unreadable. Keeping the
    // id makes the retry a retry, not a second copy in the cloud.
    expect(row.cloud_doc_id).toBeTruthy();
    expect(row.cloud_version ?? 0).toBe(0);
    expect(row.sync_state).toBe("unpushed");

    const minted = row.cloud_doc_id;
    respondWith({ status: 200, body: { version: 2 } });
    const second = await sync.syncOn("/docs/a.md", "a.md", "hello");

    expect(second).toEqual({ ok: true, version: 2, media: null });
    expect(row.cloud_doc_id).toBe(minted);
  });
});

describe("resolve", () => {
  it("refuses to take the cloud copy over an unpushed edit and leaves the file alone", async () => {
    const filePath = path.join(tmpDir, "a.md");
    fs.writeFileSync(filePath, "the only copy of this edit", "utf-8");
    seedRow({
      path: filePath,
      sync_state: "unpushed",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
    });
    const calls = respondWith();

    const res = await sync.resolve(filePath, "cloud");

    expect(res.error).toMatch(/never reached the cloud/);
    expect(res.ok).toBeUndefined();
    expect(fs.readFileSync(filePath, "utf-8")).toBe("the only copy of this edit");
    // It must not even ask the server for a copy it might write over the file.
    expect(calls).toHaveLength(0);
  });

  it("still takes the cloud copy for a genuine conflict", async () => {
    const filePath = path.join(tmpDir, "a.md");
    fs.writeFileSync(filePath, "local", "utf-8");
    const row = seedRow({
      path: filePath,
      sync_state: "conflict",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
    });
    // Pulling the cloud copy over local is not a text push, so nothing here
    // should ever reach the asset sync.
    const mediaCalls: string[] = [];
    sync.setAssetSync({
      pushAssets: async (p: string, cloudId: string) => {
        mediaCalls.push(`${cloudId}:${p}`);
        return { ok: true, uploaded: 1, skipped: [] };
      },
    });
    respondWith({ status: 200, body: { doc: { content: "from cloud", version: 9 } } });

    const res = await sync.resolve(filePath, "cloud");

    expect(res).toMatchObject({ ok: true, reloaded: true });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("from cloud");
    expect(row.sync_state).toBe("synced");
    expect(row.cloud_version).toBe(9);
    expect(mediaCalls).toHaveLength(0);
    expect(res.media).toBeUndefined();
  });
});

describe("fetchAsset", () => {
  // The asset cache revalidates a hit with the ETag of the copy it holds, so
  // an unchanged picture costs a 304 and no bytes at all.
  it("sends the cached copy's ETag and reads a 304 as not modified", async () => {
    const etag = `"${"a".repeat(64)}"`;
    const headers: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        headers.push(init.headers);
        return { status: 304, headers: new Headers(), body: null };
      })
    );

    expect(await sync.fetchAsset("cloud-1", "a.png", etag)).toEqual({ notModified: true });
    expect(headers[0]["If-None-Match"]).toBe(etag);
  });

  // A revalidation runs while somebody is looking at the picture, and the
  // protocol handler waits on it. Five minutes is the budget for downloading
  // a video, not for asking whether a cached one changed.
  it("gives a revalidation five seconds to answer, and a download five minutes", async () => {
    const aborted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              aborted.push(_url);
              reject(new Error("aborted"));
            });
          })
      )
    );
    vi.useFakeTimers();
    try {
      const revalidation = sync.fetchAsset("cloud-1", "a.png", `"${"a".repeat(64)}"`);
      await vi.advanceTimersByTimeAsync(5001);
      expect(aborted).toHaveLength(1);
      expect(await revalidation).toBeNull();

      const download = sync.fetchAsset("cloud-1", "a.png");
      await vi.advanceTimersByTimeAsync(5001);
      // Still waiting: a picture nobody has a copy of is worth five minutes.
      expect(aborted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(300000);
      expect(aborted).toHaveLength(2);
      expect(await download).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The signal handed to fetch governs the response body too, so one 5 s cap
  // would have given a relinked video five seconds to download, failed it,
  // and gone on showing the old bytes forever.
  it("holds the five-second deadline to the answer, not to the download behind it", async () => {
    const hash = "b".repeat(64);
    let sendBody: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { signal: AbortSignal }) => ({
        status: 200,
        headers: new Headers({ etag: `"${hash}"`, "content-type": "image/png", "content-length": "4" }),
        body: new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
            sendBody = () => {
              controller.enqueue(new TextEncoder().encode("bbbb"));
              controller.close();
            };
          },
        }),
      }))
    );
    vi.useFakeTimers();
    try {
      const res = await sync.fetchAsset("cloud-1", "a.png", `"${"a".repeat(64)}"`);
      expect(res).toMatchObject({ hash, mime: "image/png", size: 4 });

      // Eight seconds of a slow download later, the body is still welcome.
      await vi.advanceTimersByTimeAsync(8000);
      sendBody!();
      const reader = res!.stream.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("bbbb");
      expect((await reader.read()).done).toBe(true);
      // And the transfer's own deadline goes with the transfer.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a revoked or missing picture as gone, and a server fault as nothing", async () => {
    const answer = async (status: number, ifNoneMatch?: string) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ status, headers: new Headers(), body: null }))
      );
      return sync.fetchAsset("cloud-1", "a.png", ifNoneMatch);
    };
    const etag = `"${"a".repeat(64)}"`;

    // Definitive: the document no longer has this ref, or this account may no
    // longer read it. The cache has to forget it, not keep showing it.
    expect(await answer(404)).toEqual({ gone: true });
    expect(await answer(403)).toEqual({ gone: true });
    expect(await answer(404, etag)).toEqual({ gone: true });
    expect(await answer(403, etag)).toEqual({ gone: true });
    // Not definitive: the picture may well still be there.
    expect(await answer(500)).toBeNull();
    expect(await answer(503, etag)).toBeNull();
  });

  it("sends no conditional header when there is nothing cached to revalidate", async () => {
    const headers: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        headers.push(init.headers);
        return { status: 404, headers: new Headers(), body: null };
      })
    );

    expect(await sync.fetchAsset("cloud-1", "a.png")).toEqual({ gone: true });
    expect(headers[0]["If-None-Match"]).toBeUndefined();
  });
});

describe("remoteContent", () => {
  it("hands the renderer the cloud copy for a diff", async () => {
    const filePath = path.join(tmpDir, "a.md");
    seedRow({ path: filePath, sync_state: "conflict", cloud_doc_id: "cloud-1", cloud_version: 4 });
    respondWith({ status: 200, body: { doc: { content: "from cloud", version: 9, name: "a.md" } } });

    const res = await sync.remoteContent(filePath);

    expect(res).toEqual({ ok: true, content: "from cloud", version: 9, name: "a.md" });
  });

  it("refuses a cloud copy over the cap instead of sending it to the renderer", async () => {
    // The Review step diffs the cloud copy in the renderer, which is the one
    // place the cap protects; a copy this size stops here, with the same
    // refusal the pull would have given.
    const filePath = path.join(tmpDir, "a.md");
    seedRow({ path: filePath, sync_state: "conflict", cloud_doc_id: "cloud-1", cloud_version: 4 });
    respondWith({ status: 200, body: { doc: { content: "x".repeat(100_000_000), version: 9 } } });

    const res = await sync.remoteContent(filePath);

    expect(res).toEqual({
      error: "a.md in the cloud is 100 MB, more than Markie opens (100 MB). Nothing was changed.",
    });
    expect(res.content).toBeUndefined();
  });
});

describe("syncOff", () => {
  const cloudRow = (p: string) =>
    seedRow({
      path: p,
      sync_state: "synced",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
    });

  it("keeps cloud_doc_id when the delete fails so the copy can still be removed", async () => {
    const row = cloudRow("/docs/a.md");
    respondWith({ status: 500 });

    const res = await sync.syncOff("/docs/a.md", true);

    expect(res.error).toBe("delete failed (500)");
    expect(res.ok).toBeUndefined();
    expect(res.deleted).toBeUndefined();
    // Still live on the server and still served to everyone it was shared with.
    expect(row.cloud_doc_id).toBe("cloud-1");
    expect(row.sync_state).toBe("synced");
  });

  it("keeps cloud_doc_id when the delete request throws (offline)", async () => {
    const row = cloudRow("/docs/a.md");
    respondWith(new TypeError("fetch failed"));

    await expect(sync.syncOff("/docs/a.md", true)).resolves.toEqual({
      error: "delete failed (offline)",
    });
    expect(row.cloud_doc_id).toBe("cloud-1");
  });

  it("treats 404 as success because the cloud copy is already gone", async () => {
    const row = cloudRow("/docs/a.md");
    respondWith({ status: 404 });

    const res = await sync.syncOff("/docs/a.md", true);

    expect(res).toEqual({ ok: true, deleted: true });
    expect(row.cloud_doc_id).toBeNull();
    expect(row.sync_state).toBe("local-only");
  });

  it("unlinks the cloud copy on a successful delete", async () => {
    const row = cloudRow("/docs/a.md");
    respondWith({ status: 200 });

    expect(await sync.syncOff("/docs/a.md", true)).toEqual({
      ok: true,
      deleted: true,
    });
    expect(row.cloud_doc_id).toBeNull();
    expect(row.cloud_version).toBe(0);
  });

  it("pauses without touching the server when the cloud copy is kept", async () => {
    const row = cloudRow("/docs/a.md");
    const calls = respondWith();

    expect(await sync.syncOff("/docs/a.md", false)).toEqual({
      ok: true,
      paused: true,
    });
    expect(row.sync_state).toBe("paused");
    expect(row.cloud_doc_id).toBe("cloud-1");
    expect(calls).toHaveLength(0);
  });
});

describe("viewer access", () => {
  const sharedRow = (p = "/docs/a.md") =>
    seedRow({
      path: p,
      sync_state: "synced",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
      content_hash: "hash:old",
    });

  it("refuses to push a doc the user can only view", async () => {
    const row = sharedRow();
    sync.setDocRole("cloud-1", "viewer");
    const calls = respondWith();

    const res = await sync.push("/docs/a.md", "a.md", "new");

    // The server answers this request with 403. Sending it anyway and relaying
    // the status told the user their backup failed, not that it was never
    // theirs to make.
    expect(calls).toHaveLength(0);
    expect(res.error).toMatch(/view-only/);
    expect(res.ok).toBeUndefined();
    // Still on disk, still not in the cloud: the row must not claim otherwise.
    expect(row.sync_state).toBe("unpushed");
  });

  it("refuses to turn sync on for a doc the user can only view", async () => {
    const row = sharedRow();
    sync.setDocRole("cloud-1", "viewer");
    const calls = respondWith();

    const res = await sync.syncOn("/docs/a.md", "a.md", "new");

    expect(calls).toHaveLength(0);
    expect(res.error).toMatch(/view-only/);
    expect(row.sync_state).toBe("unpushed");
  });

  it("still pushes for an editor", async () => {
    const row = sharedRow();
    sync.setDocRole("cloud-1", "editor");
    respondWith({ status: 200, body: { version: 5 } });

    expect(await sync.push("/docs/a.md", "a.md", "new")).toEqual({
      ok: true,
      version: 5,
      media: null,
    });
    expect(row.sync_state).toBe("synced");
  });

  it("still pushes for an owner", async () => {
    const row = sharedRow();
    sync.setDocRole("cloud-1", "owner");
    respondWith({ status: 200, body: { version: 5 } });

    expect(await sync.push("/docs/a.md", "a.md", "new")).toEqual({
      ok: true,
      version: 5,
      media: null,
    });
    expect(row.sync_state).toBe("synced");
  });

  it("pushes when no role has been reported for the doc", async () => {
    // Unknown is not viewer. The server is still the one enforcing access, so
    // an unreported doc has to keep working exactly as before.
    sharedRow();
    respondWith({ status: 200, body: { version: 5 } });

    expect(await sync.push("/docs/a.md", "a.md", "new")).toEqual({
      ok: true,
      version: 5,
      media: null,
    });
  });

  it("forgets roles when the account changes", async () => {
    sharedRow();
    sync.setDocRole("cloud-1", "viewer");
    sync.setConfig({ token: "someone-else", serverURL: SERVER });
    respondWith({ status: 200, body: { version: 5 } });

    // The previous user's viewer grant says nothing about this one.
    expect(await sync.push("/docs/a.md", "a.md", "new")).toEqual({
      ok: true,
      version: 5,
      media: null,
    });
  });

  it("learns the role from the library list rather than asking again", async () => {
    sharedRow();
    respondWith({
      status: 200,
      body: { docs: [{ id: "cloud-1", version: 4, shared: true, role: "viewer" }] },
    });
    await sync.libraryState();

    const calls = respondWith();
    const res = await sync.push("/docs/a.md", "a.md", "new");

    expect(res.error).toMatch(/view-only/);
    expect(calls).toHaveLength(0);
  });

  it("treats a shared doc whose role is missing from the list as view-only", async () => {
    sharedRow();
    respondWith({
      status: 200,
      body: { docs: [{ id: "cloud-1", version: 4, shared: true }] },
    });
    await sync.libraryState();

    const calls = respondWith();
    const res = await sync.push("/docs/a.md", "a.md", "new");

    expect(res.error).toMatch(/view-only/);
    expect(calls).toHaveLength(0);
  });

  it("keeps pushing docs the library list shows as owned", async () => {
    sharedRow();
    respondWith({ status: 200, body: { docs: [{ id: "cloud-1", version: 4 }] } });
    await sync.libraryState();

    respondWith({ status: 200, body: { version: 5 } });

    expect(await sync.push("/docs/a.md", "a.md", "new")).toEqual({
      ok: true,
      version: 5,
      media: null,
    });
  });
});

describe("checkUpdates listing", () => {
  const listing = async () => (await sync.checkUpdates()).listing as string | null;
  // Rows for every id below, so the check has nothing to land and the queued
  // replies are consumed by the list requests alone.
  beforeEach(() => {
    seedRow({ path: "/docs/one.md", sync_state: "synced", cloud_doc_id: "cloud-1", cloud_version: 1 });
    seedRow({ path: "/docs/two.md", sync_state: "synced", cloud_doc_id: "cloud-2", cloud_version: 1 });
  });

  it("fingerprints the account's list, and the fingerprint moves when a document appears", async () => {
    respondWith(
      { status: 200, body: { docs: [{ id: "cloud-1", version: 1 }] } },
      { status: 200, body: { docs: [{ id: "cloud-1", version: 1 }] } },
      { status: 200, body: { docs: [{ id: "cloud-1", version: 1 }, { id: "cloud-2", version: 1, name: "b.md" }] } }
    );
    const first = await listing();
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await listing()).toBe(first);
    expect(await listing()).not.toBe(first);
  });

  it("moves when a document is edited elsewhere or renamed", async () => {
    respondWith(
      { status: 200, body: { docs: [{ id: "cloud-1", version: 1, name: "a.md" }] } },
      { status: 200, body: { docs: [{ id: "cloud-1", version: 2, name: "a.md" }] } },
      { status: 200, body: { docs: [{ id: "cloud-1", version: 2, name: "b.md" }] } }
    );
    const v1 = await listing();
    const v2 = await listing();
    const renamed = await listing();
    expect(new Set([v1, v2, renamed]).size).toBe(3);
  });

  it("moves when a row's media state changes and the server's list does not", async () => {
    // A reconciliation pass turning "media pending" into synced changes what
    // the Library draws without changing anything on the server. Left out of
    // the fingerprint, the renderer deduplicated the refresh away and an open
    // Cloud panel said "media pending" until something unrelated moved.
    respondWith(
      { status: 200, body: { docs: [{ id: "cloud-1", version: 1, name: "a.md" }] } },
      { status: 200, body: { docs: [{ id: "cloud-1", version: 1, name: "a.md" }] } },
      { status: 200, body: { docs: [{ id: "cloud-1", version: 1, name: "a.md" }] } }
    );
    const before = await listing();

    rows.get("/docs/one.md")!.assets_state = "synced";
    const afterState = await listing();
    expect(afterState).not.toBe(before);

    rows.get("/docs/one.md")!.assets_skipped = JSON.stringify([{ ref: "big.png", reason: "size" }]);
    expect(await listing()).not.toBe(afterState);
  });

  it("reports no fingerprint for a list it never received, so nothing refreshes off a failure", async () => {
    respondWith({ status: 500 }, new Error("offline"));
    expect(await listing()).toBeNull();
    expect(await listing()).toBeNull();
    sync.setConfig({ token: null, serverURL: null });
    expect(await listing()).toBeNull();
  });
});

describe("libraryState", () => {
  it("says the cloud list did not load rather than showing an empty cloud", async () => {
    seedRow({ path: "/docs/a.md" });
    respondWith({ status: 401 });

    const state = await sync.libraryState();

    expect(state.items.map((i: { path: string }) => i.path)).toEqual(["/docs/a.md"]);
    expect(state.signedIn).toBe(true);
    expect(state.cloudError).toMatch(/sign-in has expired/);
  });

  it("tells offline apart from a refused sign-in", async () => {
    respondWith(new Error("offline"));
    expect((await sync.libraryState()).cloudError).toMatch(/reach the server/);
    respondWith({ status: 503 });
    expect((await sync.libraryState()).cloudError).toMatch(/HTTP 503/);
    respondWith({ status: 200, body: { docs: [] } });
    expect((await sync.libraryState()).cloudError).toBeNull();
  });

  const syncedRow = () =>
    seedRow({
      path: "/docs/a.md",
      sync_state: "synced",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
    });

  it("does not relabel synced rows as paused when the remote list fails", async () => {
    syncedRow();
    respondWith({ status: 500 });

    const state = await sync.libraryState();

    // A failed list is not an empty server: calling this "paused" told the user
    // the doc had been deleted remotely and hid the fact that sync still worked.
    expect(state.items[0].state).toBe("synced");
  });

  it("does not relabel synced rows as paused when the remote list throws", async () => {
    syncedRow();
    respondWith(new TypeError("fetch failed"));

    const state = await sync.libraryState();

    expect(state.items[0].state).toBe("synced");
  });

  it("does not relabel synced rows as paused when the response body is unusable", async () => {
    syncedRow();
    respondWith({ status: 200, body: null });

    const state = await sync.libraryState();

    expect(state.items[0].state).toBe("synced");
  });

  it("still marks a row paused when the list loads and the doc is genuinely gone", async () => {
    syncedRow();
    respondWith({ status: 200, body: { docs: [] } });

    const state = await sync.libraryState();

    expect(state.items[0].state).toBe("paused");
  });

  it("marks a row behind when the server holds a newer version", async () => {
    syncedRow();
    respondWith({ status: 200, body: { docs: [{ id: "cloud-1", version: 9 }] } });

    const state = await sync.libraryState();

    expect(state.items[0].state).toBe("behind");
  });

  // Who owns a document decides which half of the Cloud page it appears under,
  // and getting it wrong offers owner's actions on somebody else's file. The
  // only honest sources are the list the server just sent and the last role it
  // confirmed; with neither, the answer is "nobody has said".
  describe("who owns each document", () => {
    it("takes ownership from the list when the list loads", async () => {
      syncedRow();
      respondWith({ status: 200, body: { docs: [{ id: "cloud-1", version: 4 }] } });

      expect((await sync.libraryState()).items[0].owned).toBe(true);
    });

    it("calls a shared document someone else's, list or no list", async () => {
      syncedRow();
      respondWith({
        status: 200,
        body: { docs: [{ id: "cloud-1", version: 4, shared: true, role: "editor" }] },
      });

      expect((await sync.libraryState()).items[0].owned).toBe(false);
    });

    it("keeps someone else's document theirs when the list cannot be fetched", async () => {
      // Offline, or the server is down: no remote record either way. Reading
      // that silence as "mine" is what filed a shared file under my own.
      seedRow({
        path: "/docs/theirs.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-2",
        cloud_version: 4,
        share_role: "editor",
        share_role_user: ME,
      });
      respondWith(new Error("offline"));

      expect((await sync.libraryState()).items[0].owned).toBe(false);
    });

    it("still calls my own document mine when the list cannot be fetched", async () => {
      // The wifi dropping mid-session must not take my own documents away from
      // me: this is the whole reason the remembered role is kept.
      seedRow({
        path: "/docs/mine.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-3",
        cloud_version: 4,
        share_role: "owner",
        share_role_user: ME,
      });
      respondWith({ status: 503 });

      expect((await sync.libraryState()).items[0].owned).toBe(true);
    });

    it("will not read another account's remembered role as its own", async () => {
      // Two accounts on one machine. The role was proved by somebody else, so
      // for this session it says nothing at all.
      seedRow({
        path: "/docs/hers.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-4",
        cloud_version: 4,
        share_role: "owner",
        share_role_user: THEM,
      });
      respondWith(new Error("offline"));

      expect((await sync.libraryState()).items[0].owned).toBeNull();
    });

    it("will not read a role remembered before principals were stored", async () => {
      // Databases that predate the column have a role and no account beside it.
      seedRow({
        path: "/docs/old.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-5",
        cloud_version: 4,
        share_role: "owner",
        share_role_user: null,
      });
      respondWith(new Error("offline"));

      expect((await sync.libraryState()).items[0].owned).toBeNull();
    });

    it("drops a previous account's documents when this account's list loads", async () => {
      // A signed in as owner, then B signed in. B's list is complete and does
      // not mention the document, which is the server saying it is not B's.
      seedRow({
        path: "/docs/from-a.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-6",
        cloud_version: 4,
        share_role: "owner",
        share_role_user: THEM,
      });
      signIn("b-token", ME);
      respondWith({ status: 200, body: { docs: [] } });

      expect((await sync.libraryState()).items[0].owned).toBeNull();
    });

    // A's remembered roles are evidence about A's token. The moment another
    // token arrives, nothing has been confirmed for it, and the roles say
    // nothing until /api/me answers under the new token.
    const mineByA = () =>
      seedRow({
        path: "/docs/mine-by-a.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-7",
        cloud_version: 4,
        share_role: "owner",
        share_role_user: ME,
      });

    it("stops reading A's remembered roles the moment B's token arrives", async () => {
      // A is confirmed. B's token replaces A's with no sign-out in between,
      // and the renderer's push still names A, because that is the last thing
      // it heard. B's list then fails to load.
      mineByA();
      sync.setConfig({ token: "b-token", serverURL: SERVER, userId: ME });
      respondWith({ status: 503 });

      expect((await sync.libraryState()).items[0].owned).toBeNull();
    });

    it("reads B's remembered roles once B's token is confirmed, and not A's", async () => {
      mineByA();
      seedRow({
        path: "/docs/mine-by-b.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-8",
        cloud_version: 4,
        share_role: "owner",
        share_role_user: "user-b",
      });
      signIn("b-token", "user-b");
      respondWith({ status: 503 });

      const owned = Object.fromEntries(
        (await sync.libraryState()).items.map((i: { path: string; owned: boolean | null }) => [
          i.path,
          i.owned,
        ])
      );
      expect(owned).toEqual({ "/docs/mine-by-a.md": null, "/docs/mine-by-b.md": true });
    });

    it("keeps the confirmed account through a push that only repeats the token", async () => {
      // The boot push sends the same token with no user. That is not a new
      // session and must not throw the answer away.
      mineByA();
      sync.setConfig({ token: "test-token", serverURL: SERVER });
      respondWith({ status: 503 });

      expect((await sync.libraryState()).items[0].owned).toBe(true);
    });

    it("forgets the account when the server changes under the same token", async () => {
      // The same token string offered to another server is another session:
      // nothing there has said whose it is, so A's remembered roles are not
      // read for it until that server answers /api/me.
      mineByA();
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        sync.setConfig({ token: "test-token", serverURL: "http://localhost:4010" });
      } finally {
        process.env.NODE_ENV = env;
      }
      respondWith({ status: 503 });

      expect((await sync.libraryState()).items[0].owned).toBeNull();
    });

    it("forgets the account on sign-out until the next token is confirmed", async () => {
      mineByA();
      sync.setConfig({ token: null, serverURL: null });
      sync.setConfig({ token: "test-token", serverURL: SERVER });
      respondWith({ status: 503 });

      expect((await sync.libraryState()).items[0].owned).toBeNull();
    });

    it("says nobody has told it, rather than guessing", async () => {
      syncedRow();
      respondWith({ status: 500 });

      expect((await sync.libraryState()).items[0].owned).toBeNull();
    });

    it("has nothing to wonder about for a file that was never in the cloud", async () => {
      seedRow({ path: "/docs/local.md" });
      respondWith({ status: 500 });

      expect((await sync.libraryState()).items[0].owned).toBe(true);
    });
  });

  // Whether a document is shared with this account decides the other half of
  // the Cloud page. The list says so when it loads; when it does not, the
  // role the server last confirmed for this account is the only word there
  // is, and a document that was shared with me yesterday is still shared with
  // me during today's outage.
  describe("what a remembered role says about sharing", () => {
    const sharedWithMe = (role: "editor" | "viewer", user: string = ME) =>
      seedRow({
        path: "/docs/theirs.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-9",
        cloud_version: 4,
        share_role: role,
        share_role_user: user,
      });

    it("keeps a document shared with me shared when the list cannot be fetched", async () => {
      sharedWithMe("editor");
      respondWith(new Error("offline"));

      expect((await sync.libraryState()).items[0]).toMatchObject({
        owned: false,
        shared: true,
        role: "editor",
        // Nobody remembers who shared it; the list will say when it is back.
        sharedBy: null,
      });
    });

    it("carries a remembered viewer role the same way", async () => {
      sharedWithMe("viewer");
      respondWith({ status: 503 });

      expect((await sync.libraryState()).items[0]).toMatchObject({
        owned: false,
        shared: true,
        role: "viewer",
      });
    });

    it("prefers the list over memory when the list loads", async () => {
      sharedWithMe("viewer");
      respondWith({
        status: 200,
        body: {
          docs: [{ id: "cloud-9", version: 4, shared: true, role: "editor", shared_by: "Grace" }],
        },
      });

      expect((await sync.libraryState()).items[0]).toMatchObject({
        shared: true,
        role: "editor",
        sharedBy: "Grace",
      });
    });

    it("does not call a document shared when the list loaded without it", async () => {
      // Access was revoked, or the document was deleted. Memory does not get a
      // vote once the server has answered.
      sharedWithMe("editor");
      respondWith({ status: 200, body: { docs: [] } });

      expect((await sync.libraryState()).items[0]).toMatchObject({
        shared: false,
        role: null,
        owned: null,
      });
    });

    it("does not read another account's remembered share as mine", async () => {
      sharedWithMe("editor", THEM);
      respondWith(new Error("offline"));

      expect((await sync.libraryState()).items[0]).toMatchObject({
        shared: false,
        role: null,
        owned: null,
      });
    });

    it("does not read a remembered share before this account is confirmed", async () => {
      sharedWithMe("editor");
      sync.setConfig({ token: "b-token", serverURL: SERVER, userId: ME });
      respondWith(new Error("offline"));

      expect((await sync.libraryState()).items[0]).toMatchObject({
        shared: false,
        role: null,
        owned: null,
      });
    });

    it("does not call my own document shared with me", async () => {
      seedRow({
        path: "/docs/mine.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-10",
        cloud_version: 4,
        share_role: "owner",
        share_role_user: ME,
      });
      respondWith(new Error("offline"));

      expect((await sync.libraryState()).items[0]).toMatchObject({
        owned: true,
        shared: false,
        role: null,
      });
    });
  });

  // Rows from before share_role_user existed have a role and nobody beside it,
  // and a role with nobody beside it is refused offline. Opening the document
  // online writes the account in; a document never opened again would stay
  // unconfirmed for ever. The list the server sends names the same rows, so
  // it can do the writing.
  describe("healing rows the migration left unconfirmed", () => {
    const migrated = (role: "owner" | "editor" = "owner") =>
      seedRow({
        path: "/docs/old.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-11",
        cloud_version: 4,
        share_role: role,
        share_role_user: null,
      });

    it("writes the live role and this account back to a row the list names", async () => {
      migrated();
      respondWith(
        { status: 200, body: { docs: [{ id: "cloud-11", version: 4 }] } },
        { status: 503 }
      );

      await sync.libraryState();
      expect(rows.get("/docs/old.md")).toMatchObject({ share_role: "owner", share_role_user: ME });

      // And the next outage no longer takes the document away.
      expect((await sync.libraryState()).items[0].owned).toBe(true);
    });

    it("records a shared document's live role the same way", async () => {
      migrated("owner");
      respondWith(
        {
          status: 200,
          body: { docs: [{ id: "cloud-11", version: 4, shared: true, role: "editor" }] },
        },
        new Error("offline")
      );

      await sync.libraryState();
      expect(rows.get("/docs/old.md")).toMatchObject({
        share_role: "editor",
        share_role_user: ME,
      });
      expect((await sync.libraryState()).items[0]).toMatchObject({
        owned: false,
        shared: true,
        role: "editor",
      });
    });

    it("leaves a row the list omits alone", async () => {
      // Absent from a loaded list already reads as "not this account's";
      // writing anything to it would be inventing an answer.
      migrated();
      respondWith({ status: 200, body: { docs: [] } });

      await sync.libraryState();
      expect(rows.get("/docs/old.md")).toMatchObject({ share_role: "owner", share_role_user: null });
    });

    it("writes nothing before this account is confirmed", async () => {
      migrated();
      sync.setConfig({ token: "b-token", serverURL: SERVER, userId: ME });
      respondWith({ status: 200, body: { docs: [{ id: "cloud-11", version: 4 }] } });

      await sync.libraryState();
      expect(rows.get("/docs/old.md")).toMatchObject({ share_role: "owner", share_role_user: null });
    });

    it("does not rewrite a row that already says the same thing", async () => {
      seedRow({
        path: "/docs/fine.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-12",
        cloud_version: 4,
        share_role: "owner",
        share_role_user: ME,
      });
      const writes: string[] = [];
      const update = registry.update;
      registry.update = (p: string, fields: Partial<Row>) => {
        writes.push(p);
        update(p, fields);
      };
      respondWith({ status: 200, body: { docs: [{ id: "cloud-12", version: 4 }] } });

      await sync.libraryState();
      expect(writes).toEqual([]);
    });
  });

  it("leaves an unpushed row unpushed even when the server list loads", async () => {
    seedRow({
      path: "/docs/a.md",
      sync_state: "unpushed",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
    });
    respondWith({ status: 200, body: { docs: [{ id: "cloud-1", version: 9 }] } });

    const state = await sync.libraryState();

    expect(state.items[0].state).toBe("unpushed");
  });

  describe("media", () => {
    it("reports what reconciliation last learned about a row's pictures", async () => {
      seedRow({
        path: "/docs/pics.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-20",
        cloud_version: 1,
        assets_state: "pending",
        assets_skipped: '[{"ref":"a.png","reason":"size"}]',
      });
      respondWith({ status: 200, body: { docs: [{ id: "cloud-20", version: 1 }] } });

      const state = await sync.libraryState();

      expect(state.items[0].media).toEqual({
        state: "pending",
        skipped: [{ ref: "a.png", reason: "size" }],
      });
    });

    it("reads as no state and no skips for a row reconciliation has never touched", async () => {
      seedRow({
        path: "/docs/untouched.md",
        sync_state: "synced",
        cloud_doc_id: "cloud-21",
        cloud_version: 1,
      });
      respondWith({ status: 200, body: { docs: [{ id: "cloud-21", version: 1 }] } });

      const state = await sync.libraryState();

      expect(state.items[0].media).toEqual({ state: null, skipped: [] });
    });
  });
});

describe("hasPrincipal", () => {
  it("is false before anyone is confirmed signed in", () => {
    sync.setConfig({ token: null, serverURL: null });
    expect(sync.hasPrincipal()).toBe(false);
  });

  it("is true once a config push confirms who the token belongs to", () => {
    sync.setConfig({ token: null, serverURL: null });
    sync.setConfig({ token: "test-token", serverURL: SERVER });
    expect(sync.hasPrincipal()).toBe(false);
    sync.setConfig({ token: "test-token", serverURL: SERVER, userId: ME });
    expect(sync.hasPrincipal()).toBe(true);
  });
});

describe("checkUpdates", () => {
  it("reports only the rows the server is ahead of", async () => {
    seedRow({ path: "/docs/behind.md", sync_state: "synced", cloud_doc_id: "c1", cloud_version: 4 });
    seedRow({ path: "/docs/current.md", sync_state: "synced", cloud_doc_id: "c2", cloud_version: 7 });
    respondWith({
      status: 200,
      body: { docs: [{ id: "c1", version: 9 }, { id: "c2", version: 7 }] },
    });

    const { updates } = await sync.checkUpdates();

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      path: "/docs/behind.md",
      cloudId: "c1",
      localVersion: 4,
      remoteVersion: 9,
    });
  });

  it("costs one request no matter how many files are tracked", async () => {
    for (let i = 0; i < 20; i++) {
      seedRow({ path: `/docs/${i}.md`, sync_state: "synced", cloud_doc_id: `c${i}`, cloud_version: 1 });
    }
    const calls = respondWith({
      status: 200,
      body: { docs: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, version: 2 })) },
    });

    const { updates } = await sync.checkUpdates();

    expect(updates).toHaveLength(20);
    expect(calls).toHaveLength(1);
  });

  // A clean buffer does not mean nothing is at risk: a file whose push was
  // rejected holds changes the server never took, and opening it looks saved.
  // The caller cannot tell that apart without the row's state.
  it("reports the sync state, so a one-click pull can refuse to be one", async () => {
    seedRow({ path: "/docs/c.md", sync_state: "conflict", cloud_doc_id: "c1", cloud_version: 4 });
    seedRow({ path: "/docs/s.md", sync_state: "synced", cloud_doc_id: "c2", cloud_version: 4 });
    respondWith({
      status: 200,
      body: { docs: [{ id: "c1", version: 9 }, { id: "c2", version: 9 }] },
    });

    const { updates } = await sync.checkUpdates();
    const byPath = Object.fromEntries(updates.map((u: { path: string; syncState: string }) => [u.path, u.syncState]));

    expect(byPath["/docs/c.md"]).toBe("conflict");
    expect(byPath["/docs/s.md"]).toBe("synced");
  });

  it("ignores local-only files, which have nothing to be behind", async () => {
    seedRow({ path: "/docs/local.md", sync_state: "local-only" });
    respondWith({ status: 200, body: { docs: [] } });

    expect((await sync.checkUpdates()).updates).toEqual([]);
  });

  // Absent from the list means deleted or revoked. libraryState reports that as
  // "paused"; offering to pull a document that is gone would fail on click.
  it("does not offer to pull a document that is no longer on the server", async () => {
    seedRow({ path: "/docs/a.md", sync_state: "synced", cloud_doc_id: "c1", cloud_version: 4 });
    respondWith({ status: 200, body: { docs: [] } });

    expect((await sync.checkUpdates()).updates).toEqual([]);
  });

  // The P0 shape this mirrors: a failed list request once relabelled every
  // synced row. Here it must not claim every document has an update waiting.
  it("reports nothing when the list request fails", async () => {
    seedRow({ path: "/docs/a.md", sync_state: "synced", cloud_doc_id: "c1", cloud_version: 4 });
    respondWith(new Error("offline"));

    expect((await sync.checkUpdates()).updates).toEqual([]);
  });

  it("reports nothing when signed out, without calling the server", async () => {
    seedRow({ path: "/docs/a.md", sync_state: "synced", cloud_doc_id: "c1", cloud_version: 4 });
    sync.setConfig({ token: null, serverURL: null });
    const calls = respondWith();

    expect((await sync.checkUpdates()).updates).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("keepBothPath", () => {
  it("names the copy after the original", () => {
    expect(sync.keepBothPath("/docs/notes.md", () => false)).toBe(
      "/docs/notes (my version).md"
    );
  });

  // This function exists to stop work being destroyed, so it must not destroy a
  // previous rescue to do it.
  it("suffixes rather than overwriting an earlier rescue", () => {
    const taken = new Set(["/docs/notes (my version).md"]);
    expect(sync.keepBothPath("/docs/notes.md", (p: string) => taken.has(p))).toBe(
      "/docs/notes (my version 2).md"
    );
  });

  it("handles a name with no extension", () => {
    expect(sync.keepBothPath("/docs/README", () => false)).toBe(
      "/docs/README (my version)"
    );
  });

  it("does not treat a dotfile's leading dot as an extension", () => {
    expect(sync.keepBothPath("/docs/.env", () => false)).toBe(
      "/docs/.env (my version)"
    );
  });
});

describe("resolveKeepBoth", () => {
  const seedOnDisk = (name: string, content: string) => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, "utf-8");
    seedRow({
      path: p,
      name,
      sync_state: "conflict",
      cloud_doc_id: "cloud-1",
      cloud_version: 4,
    });
    return p;
  };

  it("writes the local copy and then takes the server's", async () => {
    const p = seedOnDisk("notes.md", "mine\n");
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9, name: "notes.md" } } });

    const res = await sync.resolveKeepBoth(p);

    expect(res.ok).toBe(true);
    expect(fs.readFileSync(res.keptAt, "utf-8")).toBe("mine\n");
    expect(fs.readFileSync(p, "utf-8")).toBe("theirs\n");
    expect(rows.get(p)!.sync_state).toBe("synced");
    expect(rows.get(p)!.cloud_version).toBe(9);
  });

  // No text ever reaches the cloud here: the kept copy is tracked local-only
  // (see "tracks the copy as local-only with no cloud link" below) and has no
  // cloud id to push its media against, and the original path only pulls the
  // server's existing content over local, same as resolve("cloud"). Nothing
  // in this function should ever call the asset sync.
  it("never pushes media: nothing here writes text to the cloud", async () => {
    const p = seedOnDisk("notes.md", "mine\n![](mine.png)\n");
    const mediaCalls: string[] = [];
    sync.setAssetSync({
      pushAssets: async (fp: string, cloudId: string) => {
        mediaCalls.push(`${cloudId}:${fp}`);
        return { ok: true, uploaded: 1, skipped: [] };
      },
    });
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9, name: "notes.md" } } });

    const res = await sync.resolveKeepBoth(p);

    expect(res.ok).toBe(true);
    expect(mediaCalls).toHaveLength(0);
    expect(res.media).toBeUndefined();
  });

  // Caught by the end-to-end run, not by inspection: the dialog counts the
  // buffer's lines and promises to save "your version", but this rescued the
  // last saved file, dropping every unsaved edit in the one feature whose whole
  // job is not losing them.
  it("rescues the caller's buffer, not the stale copy on disk", async () => {
    const p = seedOnDisk("notes.md", "saved earlier\n");

    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9, name: "notes.md" } } });

    const res = await sync.resolveKeepBoth(p, "saved earlier\nMY UNSAVED LINE\n");

    expect(fs.readFileSync(res.keptAt, "utf-8")).toBe("saved earlier\nMY UNSAVED LINE\n");
    expect(fs.readFileSync(res.keptAt, "utf-8")).toContain("MY UNSAVED LINE");
  });

  it("falls back to the file on disk when the caller has no buffer", async () => {
    const p = seedOnDisk("notes.md", "only on disk\n");
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9, name: "notes.md" } } });

    const res = await sync.resolveKeepBoth(p);

    expect(fs.readFileSync(res.keptAt, "utf-8")).toBe("only on disk\n");
  });

  it("returns the pulled content so an open buffer can follow it", async () => {
    const p = seedOnDisk("notes.md", "mine\n");
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9, name: "notes.md" } } });

    const res = await sync.resolveKeepBoth(p);

    expect(res.content).toBe("theirs\n");
    expect(res.version).toBe(9);
  });

  // The rescued copy must never become a second window onto the document it was
  // rescued from, or the next save pushes it straight back over the server.
  it("tracks the copy as local-only with no cloud link", async () => {
    const p = seedOnDisk("notes.md", "mine\n");
    const tracked: Array<[string, string]> = [];
    registry.track = (tp: string, tn: string) => {
      tracked.push([tp, tn]);
      seedRow({ path: tp, name: tn, cloud_doc_id: "SHOULD-BE-CLEARED", cloud_version: 4 });
    };
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9, name: "notes.md" } } });

    const res = await sync.resolveKeepBoth(p);

    expect(tracked).toHaveLength(1);
    expect(rows.get(res.keptAt)!.cloud_doc_id).toBeNull();
    expect(rows.get(res.keptAt)!.cloud_version).toBe(0);
    expect(rows.get(res.keptAt)!.sync_state).toBe("local-only");
  });

  it("leaves the original untouched when the server cannot be reached", async () => {
    const p = seedOnDisk("notes.md", "mine\n");
    respondWith(new Error("offline"));

    const res = await sync.resolveKeepBoth(p);

    expect(res.error).toBe("fetch failed (offline)");
    expect(fs.readFileSync(p, "utf-8")).toBe("mine\n");
    expect(rows.get(p)!.sync_state).toBe("conflict");
    // No stray rescue file for a resolution that never happened.
    expect(fs.readdirSync(tmpDir)).toEqual(["notes.md"]);
  });

  it("leaves the original untouched when the copy cannot be written", async () => {
    const p = seedOnDisk("notes.md", "mine\n");
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9, name: "notes.md" } } });
    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      target: string,
      data: string,
      enc: string
    ) => {
      if (String(target).includes("(my version)")) throw new Error("EACCES");
      return realWrite(target, data, enc as never);
    }) as typeof fs.writeFileSync);

    const res = await sync.resolveKeepBoth(p);

    expect(res.error).toContain("Couldn't write the copy");
    expect(res.ok).toBeUndefined();
    expect(fs.readFileSync(p, "utf-8")).toBe("mine\n");
    expect(rows.get(p)!.sync_state).toBe("conflict");
    spy.mockRestore();
  });

  it("says where the rescued copy went if the original cannot be overwritten", async () => {
    const p = seedOnDisk("notes.md", "mine\n");
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9, name: "notes.md" } } });
    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      target: string,
      data: string,
      enc: string
    ) => {
      // Atomic writes land on `<target>.markie-<id>.tmp` first, so an
      // unwritable destination has to fail on the temp file beside it.
      if (String(target).startsWith(p)) throw new Error("EROFS");
      return realWrite(target, data, enc as never);
    }) as typeof fs.writeFileSync);

    const res = await sync.resolveKeepBoth(p);

    expect(res.error).toContain("(my version)");
    expect(res.error).toContain("couldn't overwrite the original");
    expect(fs.readFileSync(p, "utf-8")).toBe("mine\n");
    spy.mockRestore();
  });

  it("refuses a file with no cloud copy", async () => {
    const p = path.join(tmpDir, "local.md");
    fs.writeFileSync(p, "mine\n");
    seedRow({ path: p, sync_state: "local-only" });
    const calls = respondWith();

    expect((await sync.resolveKeepBoth(p)).error).toBe("not synced");
    expect(calls).toHaveLength(0);
  });
});

describe("resolve('cloud')", () => {
  it("refuses a cloud copy over the cap before touching the file", async () => {
    const p = path.join(tmpDir, "notes.md");
    fs.writeFileSync(p, "mine\n");
    const row = seedRow({ path: p, sync_state: "behind", cloud_doc_id: "cloud-1", cloud_version: 4 });
    respondWith({ status: 200, body: { doc: { content: "x".repeat(100_000_000), version: 9 } } });

    const res = await sync.resolve(p, "cloud");

    expect(res.error).toMatch(/notes\.md in the cloud is 100 MB, more than Markie opens \(100 MB\)/);
    expect(res.ok).toBeUndefined();
    expect(fs.readFileSync(p, "utf-8")).toBe("mine\n");
    expect(row.cloud_version).toBe(4);
  });

  it("hands back the content it wrote so an open buffer can follow it", async () => {
    const p = path.join(tmpDir, "notes.md");
    fs.writeFileSync(p, "mine\n");
    seedRow({ path: p, sync_state: "behind", cloud_doc_id: "cloud-1", cloud_version: 4 });
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 9 } } });

    const res = await sync.resolve(p, "cloud");

    expect(res.ok).toBe(true);
    expect(res.content).toBe("theirs\n");
    expect(res.version).toBe(9);
    expect(fs.readFileSync(p, "utf-8")).toBe("theirs\n");
  });
});

// The server masks a revoked or deleted doc as a 404, and a proxy in front of
// it can answer 2xx with an HTML error page. Both used to reach `res.data.doc`
// and throw out of the ipcMain handler, which took the window with it.
describe("pull", () => {
  it("writes the server's copy and tracks it as synced", async () => {
    const p = path.join(tmpDir, "pulled.md");
    respondWith({
      status: 200,
      body: { doc: { content: "cloud text\n", name: "pulled.md", version: 3 } },
    });

    const res = await sync.pull("cloud-1", p);

    expect(res.ok).toBe(true);
    expect(res.name).toBe("pulled.md");
    expect(fs.readFileSync(p, "utf-8")).toBe("cloud text\n");
  });

  it("reports a revoked doc instead of throwing", async () => {
    const p = path.join(tmpDir, "gone.md");
    respondWith({ status: 404 });

    const res = await sync.pull("cloud-1", p);

    expect(res.error).toBe("fetch failed (404)");
    expect(fs.existsSync(p)).toBe(false);
  });

  it("reports a 200 whose body is not a document", async () => {
    const p = path.join(tmpDir, "unreadable.md");
    respondWith({ status: 200, body: null });

    const res = await sync.pull("cloud-1", p);

    expect(res.error).toMatch(/unreadable/i);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("reports a 200 whose doc has no content string", async () => {
    const p = path.join(tmpDir, "shape.md");
    respondWith({ status: 200, body: { doc: { name: "shape.md", version: 1 } } });

    expect((await sync.pull("cloud-1", p)).error).toMatch(/unreadable/i);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("reports an unwritable target instead of throwing", async () => {
    const p = path.join(tmpDir, "no-such-dir", "notes.md");
    respondWith({
      status: 200,
      body: { doc: { content: "hi\n", name: "notes.md", version: 1 } },
    });

    const res = await sync.pull("cloud-1", p);

    expect(res.error).toContain("Couldn't write");
  });

  it("refuses when signed out without touching the network", async () => {
    sync.setConfig({ token: null, serverURL: SERVER });
    const calls = respondWith();

    expect((await sync.pull("cloud-1", path.join(tmpDir, "x.md"))).error).toBe(
      "not signed in"
    );
    expect(calls).toHaveLength(0);
  });

  // The Library opens a file by the path fileGrants hands back, which is
  // always realpath'd (electron/file-grants.js, for symlink-escape safety).
  // A landing folder that is itself reached through a symlink — the e2e
  // scripts' temporary HOME, or a real user's iCloud-redirected Documents —
  // must not be tracked under a spelling nothing will ever open it by again.
  it("tracks a landed document under the realpath, even when the landing folder is reached through a symlink", async () => {
    // The default stand-in swallows track(); make it real so the row this
    // test inspects is the one pull() actually writes to.
    registry.track = (p: string, name: string) => {
      if (!rows.has(p)) seedRow({ path: p, name });
    };
    // Nested under tmpDir so the top-level afterEach's rmSync cleans up both
    // the real directory and the symlink to it.
    const realDir = fs.mkdtempSync(path.join(tmpDir, "real-"));
    const linkDir = path.join(tmpDir, "via-symlink");
    fs.symlinkSync(realDir, linkDir, "dir");
    const target = path.join(linkDir, "pulled.md");
    const expectedPath = path.join(fs.realpathSync(realDir), "pulled.md");
    respondWith({
      status: 200,
      body: { doc: { content: "cloud text\n", name: "pulled.md", version: 3 } },
    });

    const res = await sync.pull("cloud-1", target);

    expect(res.ok).toBe(true);
    expect(res.path).toBe(expectedPath);
    expect(rows.get(expectedPath)).toMatchObject({ cloud_doc_id: "cloud-1", sync_state: "synced" });
    expect(rows.has(target)).toBe(false);
  });

  // Bringing back a synced file that was deleted from disk. The save dialog
  // may put the copy anywhere, and a document must end up with one row per
  // file, not one per attempt: two rows on one cloud document are two files
  // that push over each other.
  describe("bringing a deleted file back", () => {
    const linkedRows = () => [...rows.values()].filter((r) => r.cloud_doc_id === "cloud-1");

    beforeEach(() => {
      // The real track inserts the pulled path; the default fake does not.
      registry.track = (p: string, name: string) => {
        if (!rows.has(p)) seedRow({ path: p, name });
      };
      respondWith({
        status: 200,
        body: { doc: { content: "cloud text\n", name: "old.md", version: 3 } },
      });
    });

    it("forgets the dead row when the copy lands at a new path", async () => {
      const old = path.join(tmpDir, "old.md");
      seedRow({ path: old, sync_state: "synced", cloud_doc_id: "cloud-1", cloud_version: 2 });
      const restored = path.join(tmpDir, "restored.md");

      expect((await sync.pull("cloud-1", restored)).ok).toBe(true);

      // tmpDir itself can sit behind a symlink (macOS's /var), so the row
      // pull() actually writes to is restored's realpath, not the literal
      // string handed in.
      expect(linkedRows().map((r) => r.path)).toEqual([fs.realpathSync(restored)]);
      expect(rows.has(old)).toBe(false);
    });

    it("leaves a row alone while its file is still on disk", async () => {
      // Two live copies is a different situation, and not one to resolve by
      // forgetting either of them.
      const old = path.join(tmpDir, "old.md");
      fs.writeFileSync(old, "still here\n");
      seedRow({ path: old, sync_state: "synced", cloud_doc_id: "cloud-1", cloud_version: 2 });
      const restored = path.join(tmpDir, "restored.md");

      await sync.pull("cloud-1", restored);

      expect(linkedRows().map((r) => r.path).sort()).toEqual(
        [old, fs.realpathSync(restored)].sort()
      );
    });

    it("needs nothing when the copy lands back at the old path", async () => {
      // Seeded under its own realpath: once the fix ships, that is the only
      // spelling a cloud-linked row is ever created under, so a real re-pull
      // of an already-tracked file always names it this way.
      const old = path.join(fs.realpathSync(tmpDir), "old.md");
      seedRow({ path: old, sync_state: "synced", cloud_doc_id: "cloud-1", cloud_version: 2 });

      await sync.pull("cloud-1", old);

      expect(linkedRows().map((r) => r.path)).toEqual([old]);
      expect(rows.get(old)).toMatchObject({ sync_state: "synced", cloud_version: 3 });
    });
  });
});

describe("remoteContent", () => {
  const syncedRow = (p: string) =>
    seedRow({
      path: p,
      sync_state: "synced",
      cloud_doc_id: "cloud-1",
      cloud_version: 2,
    });

  it("returns the server's copy", async () => {
    const p = path.join(tmpDir, "notes.md");
    syncedRow(p);
    respondWith({
      status: 200,
      body: { doc: { content: "theirs\n", name: "notes.md", version: 7 } },
    });

    const res = await sync.remoteContent(p);

    expect(res.ok).toBe(true);
    expect(res.content).toBe("theirs\n");
    expect(res.version).toBe(7);
  });

  it("reports a revoked share as a failed fetch", async () => {
    const p = path.join(tmpDir, "notes.md");
    syncedRow(p);
    respondWith({ status: 403 });

    expect((await sync.remoteContent(p)).error).toBe("fetch failed (403)");
  });

  it("reports an unreadable 200 body", async () => {
    const p = path.join(tmpDir, "notes.md");
    syncedRow(p);
    respondWith({ status: 200, body: null });

    expect((await sync.remoteContent(p)).error).toMatch(/unreadable/i);
  });

  it("reports being offline", async () => {
    const p = path.join(tmpDir, "notes.md");
    syncedRow(p);
    respondWith(new Error("network down"));

    expect((await sync.remoteContent(p)).error).toBe("fetch failed (offline)");
  });

  it("refuses a file with no cloud copy", async () => {
    const p = path.join(tmpDir, "local.md");
    seedRow({ path: p, sync_state: "local-only" });
    const calls = respondWith();

    expect((await sync.remoteContent(p)).error).toBe("not synced");
    expect(calls).toHaveLength(0);
  });
});

describe("resolve('local')", () => {
  it("reports a missing local file instead of throwing", async () => {
    const p = path.join(tmpDir, "vanished.md");
    seedRow({ path: p, sync_state: "conflict", cloud_doc_id: "cloud-1", cloud_version: 2 });
    respondWith({ status: 200, body: { doc: { content: "theirs\n", version: 5 } } });

    const res = await sync.resolve(p, "local");

    expect(res.error).toContain("Couldn't read the local file");
  });

  // "local" force-pushes the local file's text, so its bytes go up first, and
  // it is the local content's media that goes, not the cloud copy fetched
  // above it for baseVersion. The refs are linked afterwards, against the
  // version the text PUT landed on (10 here), not the row's stale 4.
  it("stages media for the local content before the text and links it after", async () => {
    const p = path.join(tmpDir, "notes.md");
    fs.writeFileSync(p, "local content\n![](a.png)\n", "utf-8");
    seedRow({ path: p, sync_state: "conflict", cloud_doc_id: "cloud-1", cloud_version: 4 });
    const mediaCalls: string[] = [];
    let calls: Call[] = [];
    sync.setAssetSync({
      stageAssets: async (fp: string, cloudId: string, content: string) => {
        mediaCalls.push(`stage:${cloudId}:${fp}:${content}:${calls.length}`);
        return { staged: { linkRefs: [{ ref: "a.png", hash: "h" }], uploaded: 1, skipped: [], fingerprint: "fp" } };
      },
      linkAssets: async (_fp: string, cloudId: string, _staged: unknown, opts?: { baseVersion?: number }) => {
        mediaCalls.push(`link:${cloudId}:${opts?.baseVersion}:${calls.length}`);
        return { ok: true, uploaded: 1, skipped: [] };
      },
    });
    calls = respondWith(
      { status: 200, body: { doc: { content: "theirs\n", version: 9 } } },
      { status: 200, body: { version: 10 } }
    );

    const res = await sync.resolve(p, "local");

    expect(res).toEqual({ ok: true, pushed: true, media: { ok: true, uploaded: 1, skipped: [] } });
    expect(mediaCalls).toEqual([
      `stage:cloud-1:${p}:local content\n![](a.png)\n:1`,
      "link:cloud-1:10:2",
    ]);
    expect(rows.get(p)!.sync_state).toBe("synced");
    expect(rows.get(p)!.cloud_version).toBe(10);
  });
});

describe("resolve('cloud') failures", () => {
  it("leaves the local file alone when the body is unreadable", async () => {
    const p = path.join(tmpDir, "notes.md");
    fs.writeFileSync(p, "mine\n");
    seedRow({ path: p, sync_state: "behind", cloud_doc_id: "cloud-1", cloud_version: 4 });
    respondWith({ status: 200, body: { ok: true } });

    const res = await sync.resolve(p, "cloud");

    expect(res.error).toMatch(/unreadable/i);
    expect(fs.readFileSync(p, "utf-8")).toBe("mine\n");
  });
});

describe("landing", () => {
  const TEXT = "# From the laptop\n";
  const cloudDir = () => path.join(tmpDir, "Documents", "Markie", "Cloud");
  const list = (docs: unknown[]) => ({ status: 200, body: { docs } });
  const doc = (id: string, name: string, version = 1) => ({
    status: 200,
    body: { doc: { id, name, version, content: TEXT } },
  });

  beforeEach(() => {
    // The stand-in registry learns a pulled file the way the real one does.
    registry.track = (p: string, name: string, content: string) => {
      seedRow({ path: p, name, content_hash: `hash:${content}` });
    };
  });

  it("lands an owned document from another machine under Documents/Markie/Cloud", async () => {
    const calls = respondWith(
      list([{ id: "cloud-9", name: "from-the-laptop.md", version: 1 }]),
      doc("cloud-9", "from-the-laptop.md")
    );

    const res = await sync.checkUpdates();

    // tmpDir (this test's HOME) can itself sit behind a symlink (macOS's
    // /var), so the row lands under the target's realpath, the same
    // spelling the Library will later open it by.
    const target = path.join(cloudDir(), "from-the-laptop.md");
    const realTarget = fs.realpathSync(target);
    expect(res.landed).toEqual([{ path: realTarget, name: "from-the-laptop.md", cloudId: "cloud-9" }]);
    expect(fs.readFileSync(target, "utf-8")).toBe(TEXT);
    expect(rows.get(realTarget)).toMatchObject({
      sync_state: "synced",
      cloud_doc_id: "cloud-9",
      cloud_version: 1,
    });
    expect(calls.map((c) => c.url)).toEqual([`${SERVER}/api/docs`, `${SERVER}/api/docs/cloud-9`]);
    // It just arrived, so it is not also "behind".
    expect(res.updates).toEqual([]);
  });

  it("does not land what was shared with you", async () => {
    const calls = respondWith(list([{ id: "s1", name: "theirs.md", version: 3, shared: true, role: "viewer" }]));

    const res = await sync.checkUpdates();

    expect(res.landed).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(cloudDir())).toBe(false);
  });

  it("never lands a document this device already knows, even when its file is gone", async () => {
    seedRow({ path: "/docs/deleted-by-hand.md", sync_state: "synced", cloud_doc_id: "cloud-1", cloud_version: 2 });
    seedRow({ path: "/docs/paused.md", sync_state: "paused", cloud_doc_id: "cloud-2", cloud_version: 2 });
    const calls = respondWith(
      list([{ id: "cloud-1", name: "deleted-by-hand.md", version: 2 }, { id: "cloud-2", name: "paused.md", version: 2 }])
    );

    const res = await sync.checkUpdates();

    expect(res.landed).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("never writes over a file already there", async () => {
    fs.mkdirSync(cloudDir(), { recursive: true });
    fs.writeFileSync(path.join(cloudDir(), "notes.md"), "mine, from before\n");
    respondWith(list([{ id: "cloud-2", name: "notes.md", version: 1 }]), doc("cloud-2", "notes.md"));

    const res = await sync.checkUpdates();

    expect(res.landed[0].path).toBe(fs.realpathSync(path.join(cloudDir(), "notes (2).md")));
    expect(fs.readFileSync(path.join(cloudDir(), "notes.md"), "utf-8")).toBe("mine, from before\n");
    expect(fs.readFileSync(path.join(cloudDir(), "notes (2).md"), "utf-8")).toBe(TEXT);
  });

  it("leaves a document the server would not hand over for the next check", async () => {
    respondWith(list([{ id: "cloud-3", name: "later.md", version: 1 }]), { status: 500 });
    expect((await sync.checkUpdates()).landed).toEqual([]);
    expect(fs.existsSync(path.join(cloudDir(), "later.md"))).toBe(false);
    expect([...rows.keys()]).toEqual([]);

    respondWith(list([{ id: "cloud-3", name: "later.md", version: 1 }]), doc("cloud-3", "later.md"));
    expect((await sync.checkUpdates()).landed).toHaveLength(1);
    expect(fs.readFileSync(path.join(cloudDir(), "later.md"), "utf-8")).toBe(TEXT);
  });

  it("lands nothing while signed out, and nothing when the list did not load", async () => {
    respondWith({ status: 401 });
    expect((await sync.checkUpdates()).landed).toEqual([]);
    sync.setConfig({ token: null, serverURL: null });
    expect((await sync.checkUpdates()).landed).toEqual([]);
  });

  it("reduces a name from elsewhere to one this disk accepts", () => {
    expect(sync.landingName("notes.md")).toBe("notes.md");
    expect(sync.landingName("notes")).toBe("notes.md");
    expect(sync.landingName("../../etc/passwd")).toBe("passwd.md");
    expect(sync.landingName("a/b\\c.md")).toBe("c.md");
    expect(sync.landingName("")).toBe("document.md");
    expect(sync.landingName("..")).toBe("document.md");
    expect(sync.landingName(" spaced .md ")).toBe("spaced .md");
  });

  it("numbers a name that is taken", () => {
    const taken = new Set(["/d/notes.md", "/d/notes (2).md"]);
    const exists = (p: string) => taken.has(p);
    expect(sync.freePath("/d", "notes.md", exists)).toBe("/d/notes (3).md");
    expect(sync.freePath("/d", "fresh.md", exists)).toBe("/d/fresh.md");
    expect(sync.freePath("/d", "README", exists)).toBe("/d/README");
  });
});

describe("media and text push order", () => {
  // A stand-in for asset-sync that records the order of its two halves
  // against the number of HTTP calls made so far, so a test can say exactly
  // where each one landed relative to the text PUT.
  function recordingAssetSync(calls: () => Call[], staged: unknown = { linkRefs: [], uploaded: 1, skipped: [], fingerprint: "fp" }) {
    const log: Array<{ step: string; textCallsSoFar: number; filePath?: string; cloudId?: string; baseVersion?: number }> = [];
    sync.setAssetSync({
      stageAssets: async (filePath: string, cloudId: string) => {
        log.push({ step: "stage", textCallsSoFar: calls().length, filePath, cloudId });
        return staged === null ? { pending: true } : { staged };
      },
      linkAssets: async (filePath: string, cloudId: string, _staged: unknown, opts?: { baseVersion?: number }) => {
        log.push({ step: "link", textCallsSoFar: calls().length, filePath, cloudId, baseVersion: opts?.baseVersion });
        return { ok: true, uploaded: 1, skipped: [] };
      },
    });
    return log;
  }

  // The whole point of the split. Bytes may go up at any time: the server
  // keeps an uploaded-but-unlinked asset for an hour. Telling the server what
  // the document points at may not: a link that lands before a text PUT that
  // fails leaves the old text beside a media set that no longer holds its
  // pictures, and the sweep takes them an hour later.
  it("push uploads before the text and links after it, against the version the PUT answered with", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/d.md", sync_state: "synced", cloud_doc_id: "cd", cloud_version: 7 });
    let calls: Call[] = [];
    const log = recordingAssetSync(() => calls);
    calls = respondWith({ status: 200, body: { version: 8 } });

    const res = await sync.push("/docs/d.md", "d.md", "![](d.png)\n");

    expect(res.ok).toBe(true);
    expect(res.media).toEqual({ ok: true, uploaded: 1, skipped: [] });
    expect(log).toEqual([
      { step: "stage", textCallsSoFar: 0, filePath: "/docs/d.md", cloudId: "cd" },
      { step: "link", textCallsSoFar: 1, filePath: "/docs/d.md", cloudId: "cd", baseVersion: 8 },
    ]);
    expect(calls[0].body).toMatchObject({ baseVersion: 7 });
  });

  it("push sends no link when the text PUT fails, and leaves the media pending for reconcile", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/d.md", sync_state: "synced", cloud_doc_id: "cd", cloud_version: 7 });
    let calls: Call[] = [];
    const log = recordingAssetSync(() => calls);
    calls = respondWith({ status: 500 });

    const res = await sync.push("/docs/d.md", "d.md", "![](d.png)\n");

    expect(res.error).toBe("push failed (500)");
    expect(log.map((e) => e.step)).toEqual(["stage"]);
    expect(rows.get("/docs/d.md")!.sync_state).toBe("unpushed");
    expect(rows.get("/docs/d.md")!.assets_state).toBe("pending");
  });

  it("push sends no link when the server refuses the text as stale", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/d.md", sync_state: "synced", cloud_doc_id: "cd", cloud_version: 7 });
    let calls: Call[] = [];
    const log = recordingAssetSync(() => calls);
    calls = respondWith({ status: 409, body: { serverVersion: 9 } });

    const res = await sync.push("/docs/d.md", "d.md", "![](d.png)\n");

    expect(res.conflict).toBe(true);
    expect(log.map((e) => e.step)).toEqual(["stage"]);
    expect(rows.get("/docs/d.md")!.assets_state).toBe("pending");
  });

  // A document the server has never seen has nothing to hang media on:
  // /assets and /assets/missing both answer 404 for a cloud id it does not
  // know. That one create goes first, and both halves follow it.
  it("syncOn creates the document with the text, then stages and links its media", async () => {
    signIn("test-token", ME);
    let calls: Call[] = [];
    const log = recordingAssetSync(() => calls);
    calls = respondWith({ status: 200, body: { id: "x", version: 1 } });

    const res = await sync.syncOn("/docs/a.md", "a.md", "![](a.png)\n");

    expect(res.ok).toBe(true);
    expect(res.media).toEqual({ ok: true, uploaded: 1, skipped: [] });
    expect(log).toEqual([
      { step: "stage", textCallsSoFar: 1, filePath: "/docs/a.md", cloudId: expect.any(String) },
      { step: "link", textCallsSoFar: 1, filePath: "/docs/a.md", cloudId: expect.any(String), baseVersion: 1 },
    ]);
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  it("syncOn uploads first for a document the server already has, and links after the text", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/e.md", sync_state: "paused", cloud_doc_id: "ce", cloud_version: 3 });
    let calls: Call[] = [];
    const log = recordingAssetSync(() => calls);
    calls = respondWith({ status: 200, body: { version: 4 } });

    const res = await sync.syncOn("/docs/e.md", "e.md", "![](e.png)\n");

    expect(res).toEqual({ ok: true, version: 4, media: { ok: true, uploaded: 1, skipped: [] } });
    expect(log).toEqual([
      { step: "stage", textCallsSoFar: 0, filePath: "/docs/e.md", cloudId: "ce" },
      { step: "link", textCallsSoFar: 1, filePath: "/docs/e.md", cloudId: "ce", baseVersion: 4 },
    ]);
    expect(calls[0].body).toMatchObject({ baseVersion: 3 });
  });

  it("syncOn touches media not at all when the create is refused", async () => {
    signIn("test-token", ME);
    let calls: Call[] = [];
    const log = recordingAssetSync(() => calls);
    calls = respondWith({ status: 500 });

    const res = await sync.syncOn("/docs/a.md", "a.md", "![](a.png)\n");

    expect(res).toEqual({ error: "push failed (500)", media: null });
    expect(log).toEqual([]);
  });

  it("carries a staging failure as the media result without stopping the text", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/b.md", sync_state: "synced", cloud_doc_id: "cb", cloud_version: 2 });
    sync.setAssetSync({
      stageAssets: async () => ({ pending: true, error: "media upload failed (offline)" }),
      linkAssets: async () => {
        throw new Error("nothing staged, nothing to link");
      },
    });
    respondWith({ status: 200, body: { id: "cb", version: 3 } });

    const res = await sync.push("/docs/b.md", "b.md", "![](b.png)\n");

    expect(res.ok).toBe(true);
    expect(res.media).toEqual({ pending: true, error: "media upload failed (offline)" });
    expect(rows.get("/docs/b.md")!.sync_state).toBe("synced");
  });

  it("carries an unchanged reference set through without linking again", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/u.md", sync_state: "synced", cloud_doc_id: "cu", cloud_version: 2 });
    const linked: number[] = [];
    sync.setAssetSync({
      stageAssets: async () => ({ unchanged: true }),
      linkAssets: async () => {
        linked.push(1);
        return { ok: true, uploaded: 0, skipped: [] };
      },
    });
    respondWith({ status: 200, body: { version: 3 } });

    const res = await sync.push("/docs/u.md", "u.md", "words\n");

    expect(res.media).toEqual({ unchanged: true });
    expect(linked).toEqual([]);
  });

  it("syncOn leaves staged media pending when it cannot read the version back", async () => {
    // The text may well have landed; this device just cannot say which
    // version it landed as, so it has no base to link against. Reconciliation
    // finishes the job, which needs the row to say so.
    signIn("test-token", ME);
    seedRow({ path: "/docs/u.md", sync_state: "paused", cloud_doc_id: "cu", cloud_version: 1 });
    const linked: number[] = [];
    sync.setAssetSync({
      stageAssets: async () => ({ staged: { linkRefs: [], uploaded: 1, skipped: [], fingerprint: "fp" } }),
      linkAssets: async () => {
        linked.push(1);
        return { ok: true, uploaded: 1, skipped: [] };
      },
    });
    respondWith({ status: 200, body: { id: "cu" } });

    const res = await sync.syncOn("/docs/u.md", "u.md", "![](u.png)\n");

    expect(res.error).toBe("The server sent an unreadable copy of this document.");
    expect(linked).toEqual([]);
    expect(rows.get("/docs/u.md")!.sync_state).toBe("unpushed");
    expect(rows.get("/docs/u.md")!.assets_state).toBe("pending");
  });

  it("does not let a throwing asset sync take the text push down with it", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/c.md", sync_state: "synced", cloud_doc_id: "cc", cloud_version: 1 });
    sync.setAssetSync({
      stageAssets: async () => {
        throw new Error("disk full");
      },
      linkAssets: async () => ({ ok: true, uploaded: 0, skipped: [] }),
    });
    respondWith({ status: 200, body: { version: 2 } });

    const res = await sync.push("/docs/c.md", "c.md", "new");

    expect(res).toEqual({
      ok: true,
      version: 2,
      media: { pending: true, error: "media push failed (disk full)" },
    });
    expect(rows.get("/docs/c.md")!.sync_state).toBe("synced");
    // Same as the throwing link below. A stat that raced a deleted file or a
    // read error out of hashFile would otherwise leave the row claiming its
    // media is current against a fingerprint that was never recomputed, and
    // reconcile only revisits rows that say pending.
    expect(rows.get("/docs/c.md")!.assets_state).toBe("pending");
  });

  it("does not let a throwing link take the text push down with it", async () => {
    signIn("test-token", ME);
    seedRow({ path: "/docs/t.md", sync_state: "synced", cloud_doc_id: "ct", cloud_version: 1 });
    sync.setAssetSync({
      stageAssets: async () => ({ staged: { linkRefs: [], uploaded: 0, skipped: [], fingerprint: "fp" } }),
      linkAssets: async () => {
        throw new Error("disk full");
      },
    });
    respondWith({ status: 200, body: { version: 2 } });

    const res = await sync.push("/docs/t.md", "t.md", "new");

    expect(res).toEqual({
      ok: true,
      version: 2,
      media: { pending: true, error: "media push failed (disk full)" },
    });
    expect(rows.get("/docs/t.md")!.sync_state).toBe("synced");
    expect(rows.get("/docs/t.md")!.assets_state).toBe("pending");
  });
});

describe("setConfig reports whether the session changed", () => {
  // Every account's cached media hangs off this answer. The cache keys carry
  // no principal, so a token swapped straight from account A to account B
  // with no sign-out in between would otherwise hand B whatever A had
  // fetched.
  it("says nothing changed when the renderer repeats the same config", () => {
    sync.setConfig({ token: "a-token", serverURL: SERVER });
    expect(sync.setConfig({ token: "a-token", serverURL: SERVER }).sessionChanged).toBe(false);
    expect(sync.setConfig({ token: "a-token", serverURL: SERVER, userId: ME }).sessionChanged).toBe(false);
  });

  it("says the session changed when one account's token replaces another's", () => {
    sync.setConfig({ token: "a-token", serverURL: SERVER, userId: ME });
    expect(sync.setConfig({ token: "b-token", serverURL: SERVER }).sessionChanged).toBe(true);
  });

  it("says the session changed when the same token is offered to another server", () => {
    sync.setConfig({ token: "a-token", serverURL: SERVER });
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(sync.setConfig({ token: "a-token", serverURL: "http://localhost:4010" }).sessionChanged).toBe(true);
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it("says the session changed on sign-out", () => {
    sync.setConfig({ token: "a-token", serverURL: SERVER });
    expect(sync.setConfig({ token: null, serverURL: null }).sessionChanged).toBe(true);
    // Signed out twice over is not a new session, and there is nothing left
    // to clear.
    expect(sync.setConfig({ token: null, serverURL: null }).sessionChanged).toBe(false);
  });
});

describe("setConfig names the session", () => {
  // The asset cache keeps this beside its index so a relaunch of the same
  // account keeps the pictures it fetched. "Did the config change since the
  // last push" cannot answer that: a new main process has no last push.
  const keyOf = (cfg: { token: string | null; serverURL: string | null }) =>
    sync.setConfig(cfg).sessionKey as string | null;

  it("gives the same token at the same server the same name every time", () => {
    const first = keyOf({ token: "a-token", serverURL: SERVER });
    keyOf({ token: null, serverURL: null });
    expect(keyOf({ token: "a-token", serverURL: SERVER })).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is not the token, and is a different name for another token or another server", () => {
    const a = keyOf({ token: "a-token", serverURL: SERVER });
    expect(a).not.toContain("a-token");
    expect(keyOf({ token: "b-token", serverURL: SERVER })).not.toBe(a);

    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(keyOf({ token: "a-token", serverURL: "http://localhost:4010" })).not.toBe(a);
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it("names nothing without a token, or without a server this app will talk to", () => {
    expect(keyOf({ token: null, serverURL: null })).toBeNull();
    expect(keyOf({ token: null, serverURL: SERVER })).toBeNull();
    // An origin the allow-list refuses is no server at all outside dev.
    expect(keyOf({ token: "a-token", serverURL: "http://localhost:4010" })).toBeNull();
  });
});

// Whether anybody but this account can read a cloud document. The asset push
// asks this before it decides which of a document's references may leave the
// machine, so the only acceptable answer for a document nobody has said
// anything about is the cautious one.
describe("what a document's exposure is", () => {
  const row = (cloudId: string) =>
    seedRow({
      path: `/docs/${cloudId}.md`,
      sync_state: "synced",
      cloud_doc_id: cloudId,
      cloud_version: 4,
      content_hash: "hash:old",
    });

  it("says nobody has said until a listing arrives", () => {
    expect(sync.isExposed("cloud-1")).toBeNull();
  });

  it("reads a document shared with me as exposed", async () => {
    row("cloud-1");
    respondWith({ status: 200, body: { docs: [{ id: "cloud-1", version: 4, shared: true, role: "editor" }] } });
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBe(true);
  });

  it("reads my own document from sharedOut, either way", async () => {
    row("cloud-1");
    row("cloud-2");
    respondWith({
      status: 200,
      body: { docs: [{ id: "cloud-1", version: 4, sharedOut: true }, { id: "cloud-2", version: 4, sharedOut: false }] },
    });
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBe(true);
    expect(sync.isExposed("cloud-2")).toBe(false);
  });

  it("reads my own document as exposed when the listing does not say", async () => {
    // A server that predates sharedOut. Its silence is not "private".
    row("cloud-1");
    respondWith({ status: 200, body: { docs: [{ id: "cloud-1", version: 4 }] } });
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBe(true);
  });

  it("records it from the update check too, not only from the Library", async () => {
    row("cloud-1");
    respondWith({ status: 200, body: { docs: [{ id: "cloud-1", version: 4, sharedOut: false }] } });
    await sync.checkUpdates();
    expect(sync.isExposed("cloud-1")).toBe(false);
  });

  it("forgets everything when the session changes", async () => {
    row("cloud-1");
    respondWith({ status: 200, body: { docs: [{ id: "cloud-1", version: 4, sharedOut: false }] } });
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBe(false);
    // Another account's answer about the same document id is worth nothing.
    signIn("another-token", THEM);
    expect(sync.isExposed("cloud-1")).toBeNull();
  });

  it("forgets a document the next listing does not name", async () => {
    row("cloud-1");
    respondWith(
      { status: 200, body: { docs: [{ id: "cloud-1", version: 4, sharedOut: false }] } },
      { status: 200, body: { docs: [] } }
    );
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBe(false);
    // Deleted on another machine, or this account's access revoked. Whatever
    // the last listing said about it was said about a document the server no
    // longer answers for, so it goes back to nobody having said.
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBeNull();
  });

  it("keeps what it knows when the listing cannot be fetched", async () => {
    row("cloud-1");
    respondWith(
      { status: 200, body: { docs: [{ id: "cloud-1", version: 4, sharedOut: false }] } },
      new Error("offline"),
      { status: 503 }
    );
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBe(false);
    // A list that failed says nothing about who can read anything. Reading it
    // as an empty list would have made every document unstated, which fails
    // closed and stops a private document's ../assets/logo.png travelling for
    // the length of an outage.
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBe(false);
    await sync.libraryState();
    expect(sync.isExposed("cloud-1")).toBe(false);
  });

  it("takes a listing straight from a caller that fetched one itself", () => {
    sync.noteListing([{ id: "cloud-1", sharedOut: false }, { id: "cloud-2", shared: true, role: "editor" }]);
    expect(sync.isExposed("cloud-1")).toBe(false);
    expect(sync.isExposed("cloud-2")).toBe(true);
  });
});
