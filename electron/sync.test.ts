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

    expect(res).toMatchObject({ ok: true, reloaded: true });
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
    });
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
      if (String(target) === p) throw new Error("EROFS");
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
