import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const { createReconciler } = require("./reconcile") as typeof import("./reconcile");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, unknown> & { path: string };
let rows: Map<string, Row>;
let disk: Map<string, string>;
let pushed: string[];
let media: string[];
let listing: { docs: { id: string; version: number; hash: string }[] } | null;

const registry = {
  list: () => [...rows.values()],
  get: (p: string) => rows.get(p) ?? null,
  update: (p: string, f: Record<string, unknown>) => rows.set(p, { ...rows.get(p)!, ...f }),
  hashContent: (s: string) => sha(s),
};
const fs = {
  existsSync: (p: string) => disk.has(p),
  readFileSync: (p: string) => disk.get(p)!,
};
const sync = {
  api: async () => (listing ? { status: 200, data: listing } : { status: 0, data: null }),
  push: async (p: string, _name: string, content: string) => {
    pushed.push(p);
    const row = rows.get(p)!;
    rows.set(p, { ...row, sync_state: "synced", content_hash: sha(content), cloud_version: (row.cloud_version as number) + 1 });
    return { ok: true };
  },
};
const assetSync = { pushAssets: async (p: string) => (media.push(p), { ok: true, uploaded: 0, skipped: [] }) };

function seed(row: Row, content: string | null) {
  rows.set(row.path, { name: "x.md", sync_state: "synced", cloud_doc_id: "c" + rows.size, cloud_version: 1, content_hash: null, assets_state: "synced", ...row });
  if (content !== null) disk.set(row.path, content);
}

beforeEach(() => {
  rows = new Map();
  disk = new Map();
  pushed = [];
  media = [];
  listing = { docs: [] };
});

describe("reconcile", () => {
  it("pushes an unpushed row and one whose disk copy moved on while the server stood still", async () => {
    seed({ path: "/d/un.md", cloud_doc_id: "c1", sync_state: "unpushed", content_hash: sha("old") }, "old");
    seed({ path: "/d/edited.md", cloud_doc_id: "c2", content_hash: sha("v1") }, "v2");
    seed({ path: "/d/fine.md", cloud_doc_id: "c3", content_hash: sha("ok") }, "ok");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("old") }, { id: "c2", version: 1, hash: sha("v1") }, { id: "c3", version: 1, hash: sha("ok") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.pushed.sort()).toEqual(["/d/edited.md", "/d/un.md"]);
    expect(pushed).not.toContain("/d/fine.md");
  });

  it("pushes when the server's hash disagrees at the same version, and skips when the server is ahead", async () => {
    seed({ path: "/d/lost.md", cloud_doc_id: "c1", content_hash: sha("mine") }, "mine");
    seed({ path: "/d/behind.md", cloud_doc_id: "c2", cloud_version: 1, content_hash: sha("mine") }, "mine");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("theirs") }, { id: "c2", version: 5, hash: sha("theirs") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.pushed).toEqual(["/d/lost.md"]);
    expect(r.skipped).toEqual([{ path: "/d/behind.md", reason: "behind" }]);
  });

  it("leaves paused, conflict, local-only, missing-on-disk and delisted rows alone", async () => {
    seed({ path: "/d/p.md", cloud_doc_id: "c1", sync_state: "paused" }, "x");
    seed({ path: "/d/c.md", cloud_doc_id: "c2", sync_state: "conflict" }, "x");
    seed({ path: "/d/l.md", cloud_doc_id: null, sync_state: "local-only" }, "x");
    seed({ path: "/d/gone.md", cloud_doc_id: "c4", sync_state: "unpushed" }, null);
    seed({ path: "/d/delisted.md", cloud_doc_id: "c5", sync_state: "unpushed" }, "x");
    listing = { docs: [{ id: "c1", version: 1, hash: "" }, { id: "c2", version: 1, hash: "" }, { id: "c4", version: 1, hash: "" }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(pushed).toEqual([]);
    expect(r.skipped).toEqual([
      { path: "/d/gone.md", reason: "missing" },
      { path: "/d/delisted.md", reason: "delisted" },
    ]);
  });

  it("backfills media for a current document whose media is pending or stale", async () => {
    seed({ path: "/d/a.md", cloud_doc_id: "c1", content_hash: sha("![](a.png)"), assets_state: "pending" }, "![](a.png)");
    seed({ path: "/d/b.md", cloud_doc_id: "c2", content_hash: sha("b"), assets_state: null }, "b");
    seed({ path: "/d/c.md", cloud_doc_id: "c3", content_hash: sha("c"), assets_state: "synced" }, "c");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("![](a.png)") }, { id: "c2", version: 1, hash: sha("b") }, { id: "c3", version: 1, hash: sha("c") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.mediaPushed.sort()).toEqual(["/d/a.md", "/d/b.md", "/d/c.md"]);
  });

  it("does at most `limit` documents per pass and carries on next time", async () => {
    for (let i = 0; i < 5; i += 1) seed({ path: `/d/${i}.md`, cloud_doc_id: `c${i}`, sync_state: "unpushed" }, "x");
    listing = { docs: [0, 1, 2, 3, 4].map((i) => ({ id: `c${i}`, version: 1, hash: sha("x") })) };
    const rec = createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} });
    expect((await rec.run({ limit: 2 })).pushed).toHaveLength(2);
    expect((await rec.run({ limit: 2 })).pushed).toHaveLength(2);
    expect((await rec.run({ limit: 2 })).pushed).toHaveLength(1);
  });

  it("does nothing without a listing", async () => {
    seed({ path: "/d/un.md", cloud_doc_id: "c1", sync_state: "unpushed" }, "x");
    listing = null;
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r).toEqual({ pushed: [], mediaPushed: [], skipped: [], errors: [{ path: "*", error: "listing unavailable" }] });
  });

  it("turns a throw while building the listing into an error result instead of rejecting", async () => {
    seed({ path: "/d/un.md", cloud_doc_id: "c1", sync_state: "unpushed" }, "x");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("x") }] };
    const brokenRegistry = {
      ...registry,
      list: () => {
        throw new Error("registry unavailable");
      },
    };
    const r = await createReconciler({ sync, registry: brokenRegistry, assetSync, fs, sleep: async () => {} }).run();
    expect(r).toEqual({ pushed: [], mediaPushed: [], skipped: [], errors: [{ path: "*", error: "registry unavailable" }] });
    expect(pushed).toEqual([]);
  });
});
