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

interface Row {
  path: string;
  name: string;
  sync_state: string;
  cloud_doc_id: string | null;
  cloud_version: number;
  content_hash: string | null;
  last_synced_at: string | null;
  last_opened_at: string | null;
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

beforeEach(() => {
  rows = new Map();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-sync-"));
  registry.get = (p: string) => rows.get(p);
  registry.update = (p: string, fields: Partial<Row>) => {
    const row = rows.get(p);
    if (row) Object.assign(row, fields);
  };
  registry.hashContent = (content: string) => `hash:${content}`;
  registry.list = () => [...rows.values()];
  registry.pruneMissing = () => 0;
  registry.track = () => {};
  sync.setConfig({ token: "test-token", serverURL: SERVER });
});

afterEach(() => {
  Object.assign(registry, realRegistry);
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

    expect(res).toEqual({ ok: true, version: 5 });
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
    expect(res).toEqual({ conflict: true });
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

    expect(res).toEqual({ ok: true, version: 5 });
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
    });
    expect(row.sync_state).toBe("unpushed");
  });

  it("marks the row synced when the server accepts it", async () => {
    const row = seedRow({ path: "/docs/a.md", sync_state: "local-only" });
    respondWith({ status: 200, body: { version: 1 } });

    const res = await sync.syncOn("/docs/a.md", "a.md", "hello");

    expect(res).toEqual({ ok: true, version: 1 });
    expect(row.sync_state).toBe("synced");
    expect(row.cloud_doc_id).toBeTruthy();
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
    respondWith({ status: 200, body: { doc: { content: "from cloud", version: 9 } } });

    const res = await sync.resolve(filePath, "cloud");

    expect(res).toEqual({ ok: true, reloaded: true });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("from cloud");
    expect(row.sync_state).toBe("synced");
    expect(row.cloud_version).toBe(9);
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

describe("libraryState", () => {
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
});
