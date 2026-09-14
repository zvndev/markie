import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const { createReconciler } = require("./reconcile") as typeof import("./reconcile");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, unknown> & { path: string };
let rows: Map<string, Row>;
let disk: Map<string, string>;
let pushed: string[];
let media: string[];
let listing: {
  docs: { id: string; version: number; hash: string; shared?: boolean; role?: string; sharedOut?: boolean }[];
} | null;

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
let mediaBase: Array<number | undefined>;
let mediaAnswer: () => Record<string, unknown>;
const assetSync = {
  pushAssets: async (p: string, _cloudId: string, _content: string, opts?: { baseVersion?: number }) => {
    media.push(p);
    mediaBase.push(opts?.baseVersion);
    return mediaAnswer();
  },
};
let links: string[];
let linkBase: Array<number | undefined>;
let linkAnswer: () => Record<string, unknown>;
const linkSync = {
  pushLinks: async (p: string, _cloudId: string, _content: string, opts?: { baseVersion?: number }) => {
    links.push(p);
    linkBase.push(opts?.baseVersion);
    return linkAnswer();
  },
};

function seed(row: Row, content: string | null) {
  rows.set(row.path, { name: "x.md", sync_state: "synced", cloud_doc_id: "c" + rows.size, cloud_version: 1, content_hash: null, assets_state: "synced", ...row });
  if (content !== null) disk.set(row.path, content);
}

beforeEach(() => {
  rows = new Map();
  disk = new Map();
  pushed = [];
  media = [];
  mediaBase = [];
  mediaAnswer = () => ({ ok: true, uploaded: 0, skipped: [] });
  links = [];
  linkBase = [];
  linkAnswer = () => ({ unchanged: true });
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

  it("leaves a shared document this account can only read alone", async () => {
    // The asset call would 403, mark the row pending, and be retried on every
    // pass, so the Cloud panel showed "media pending" forever for a document
    // nobody here is allowed to write.
    seed({ path: "/d/theirs.md", cloud_doc_id: "c1", sync_state: "unpushed", content_hash: sha("old") }, "new");
    seed({ path: "/d/mine.md", cloud_doc_id: "c2", content_hash: sha("x") }, "x");
    listing = {
      docs: [
        { id: "c1", version: 1, hash: sha("old"), shared: true, role: "viewer" },
        { id: "c2", version: 1, hash: sha("x") },
      ],
    };

    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();

    expect(r.skipped).toEqual([{ path: "/d/theirs.md", reason: "viewer" }]);
    expect(pushed).toEqual([]);
    expect(media).toEqual(["/d/mine.md"]);
  });

  it("still reconciles a shared document this account may edit", async () => {
    seed({ path: "/d/ours.md", cloud_doc_id: "c1", content_hash: sha("x") }, "x");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("x"), shared: true, role: "editor" }] };

    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();

    expect(r.skipped).toEqual([]);
    expect(r.mediaPushed).toEqual(["/d/ours.md"]);
  });

  it("backfills media for a current document whose media is pending or stale", async () => {
    seed({ path: "/d/a.md", cloud_doc_id: "c1", content_hash: sha("![](a.png)"), assets_state: "pending" }, "![](a.png)");
    seed({ path: "/d/b.md", cloud_doc_id: "c2", content_hash: sha("b"), assets_state: null }, "b");
    seed({ path: "/d/c.md", cloud_doc_id: "c3", content_hash: sha("c"), assets_state: "synced" }, "c");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("![](a.png)") }, { id: "c2", version: 1, hash: sha("b") }, { id: "c3", version: 1, hash: sha("c") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.mediaPushed.sort()).toEqual(["/d/a.md", "/d/b.md", "/d/c.md"]);
  });

  // Another device can advance the document between the listing and this
  // call. Without a base version the link replaces the newer snapshot's
  // references with this device's stale set; with one the server refuses it.
  it("links media against the version the listing agreed on", async () => {
    seed({ path: "/d/a.md", cloud_doc_id: "c1", cloud_version: 6, content_hash: sha("a"), assets_state: "pending" }, "a");
    listing = { docs: [{ id: "c1", version: 6, hash: sha("a") }] };
    await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(media).toEqual(["/d/a.md"]);
    expect(mediaBase).toEqual([6]);
  });

  it("links against version 0 for a row that has never recorded one", async () => {
    seed({ path: "/d/b.md", cloud_doc_id: "c2", cloud_version: null, content_hash: sha("b"), assets_state: "pending" }, "b");
    listing = { docs: [{ id: "c2", version: 0, hash: sha("b") }] };
    await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(mediaBase).toEqual([0]);
  });

  // The renderer refreshes its whole library when a pass reports it pushed
  // something. A steady-state pass pushes nothing: every document's media is
  // already linked, and counting that as "pushed" made every ten minutes a
  // forced refetch of the list.
  it("separates media that was already linked from media it actually sent", async () => {
    seed({ path: "/d/a.md", cloud_doc_id: "c1", content_hash: sha("a") }, "a");
    seed({ path: "/d/b.md", cloud_doc_id: "c2", content_hash: sha("b") }, "b");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("a") }, { id: "c2", version: 1, hash: sha("b") }] };
    mediaAnswer = () => ({ unchanged: true });

    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();

    expect(r.pushed).toEqual([]);
    expect(r.mediaPushed).toEqual([]);
    expect(r.mediaUnchanged.sort()).toEqual(["/d/a.md", "/d/b.md"]);
    expect(r.errors).toEqual([]);
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
    expect(r).toEqual({ pushed: [], mediaPushed: [], mediaUnchanged: [], linksPushed: [], linksUnchanged: [], skipped: [], errors: [{ path: "*", error: "listing unavailable" }] });
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
    expect(r).toEqual({ pushed: [], mediaPushed: [], mediaUnchanged: [], linksPushed: [], linksUnchanged: [], skipped: [], errors: [{ path: "*", error: "registry unavailable" }] });
    expect(pushed).toEqual([]);
  });

  it("pushes links for a row whose text is current, with the listing's version, and counts the answers", async () => {
    seed({ path: "/d/fine.md", cloud_doc_id: "c1", cloud_version: 4, content_hash: sha("ok") }, "ok");
    seed({ path: "/d/same.md", cloud_doc_id: "c2", cloud_version: 2, content_hash: sha("ok") }, "ok");
    listing = { docs: [{ id: "c1", version: 4, hash: sha("ok") }, { id: "c2", version: 2, hash: sha("ok") }] };
    let n = 0;
    linkAnswer = () => (n++ === 0 ? { ok: true, linked: 1 } : { unchanged: true });
    const r = await createReconciler({ sync, registry, assetSync, linkSync, fs, sleep: async () => {} }).run();
    expect(links).toEqual(["/d/fine.md", "/d/same.md"]);
    expect(linkBase).toEqual([4, 2]);
    expect(r.linksPushed).toEqual(["/d/fine.md"]);
    expect(r.linksUnchanged).toEqual(["/d/same.md"]);
    expect(r.errors).toEqual([]);
  });

  it("does not push links itself for a row whose text it pushed, and reports refusals and errors", async () => {
    seed({ path: "/d/un.md", cloud_doc_id: "c1", sync_state: "unpushed", content_hash: sha("old") }, "old");
    seed({ path: "/d/bad.md", cloud_doc_id: "c2", content_hash: sha("ok") }, "ok");
    seed({ path: "/d/off.md", cloud_doc_id: "c3", content_hash: sha("ok") }, "ok");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("old") }, { id: "c2", version: 1, hash: sha("ok") }, { id: "c3", version: 1, hash: sha("ok") }] };
    let n = 0;
    linkAnswer = () => (n++ === 0 ? { refused: 413 } : { error: "link push failed (offline)" });
    const r = await createReconciler({ sync, registry, assetSync, linkSync, fs, sleep: async () => {} }).run();
    expect(pushed).toEqual(["/d/un.md"]);
    expect(links).toEqual(["/d/bad.md", "/d/off.md"]);
    expect(r.errors).toEqual([
      { path: "/d/bad.md", error: "links refused (413)" },
      { path: "/d/off.md", error: "link push failed (offline)" },
    ]);
  });

  it("runs without a link sync at all", async () => {
    seed({ path: "/d/fine.md", cloud_doc_id: "c1", content_hash: sha("ok") }, "ok");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("ok") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.linksPushed).toEqual([]);
    expect(r.linksUnchanged).toEqual([]);
  });
});

// Reconciliation fetches its own listing, and it is the freshest one there
// is at the moment it stages a document's media. The asset push reads the
// exposure of each document out of the sync engine, so a pass that kept its
// listing to itself would leave every document unstated, and unstated fails
// closed: a private document's `../assets/logo.png` would stop travelling
// until somebody opened the Library.
describe("the listing a pass fetched", () => {
  it("is handed to the sync engine before any document is staged", async () => {
    const noted: unknown[] = [];
    seed({ path: "/d/a.md", cloud_doc_id: "c1", content_hash: sha("ok"), assets_state: "pending" }, "ok");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("ok"), sharedOut: false }] };
    const order: string[] = [];
    const watched = {
      ...sync,
      noteListing: (docs: unknown[]) => {
        noted.push(...docs);
        order.push("noted");
      },
    };
    const staging = {
      pushAssets: async (p: string) => {
        order.push("staged");
        media.push(p);
        return { ok: true, uploaded: 0, skipped: [] };
      },
    };
    await createReconciler({ sync: watched, registry, assetSync: staging, fs, sleep: async () => {} }).run();
    expect(noted).toEqual([{ id: "c1", version: 1, hash: sha("ok"), sharedOut: false }]);
    expect(order).toEqual(["noted", "staged"]);
  });

  it("runs against a sync engine that has no noteListing at all", async () => {
    seed({ path: "/d/a.md", cloud_doc_id: "c1", content_hash: sha("ok"), assets_state: "pending" }, "ok");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("ok") }] };
    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();
    expect(r.errors).toEqual([]);
    expect(media).toEqual(["/d/a.md"]);
  });
});

// The refusal classifier, through the real asset push rather than a stand-in,
// because the thing worth proving is that a pass which failed for a reason
// that has nothing to do with the body is tried again by the next pass.
describe("a link refused while the session was stale", () => {
  const { createAssetSync } = require("./asset-sync") as typeof import("./asset-sync");

  function realAssetSync(linkReplies: Array<{ status: number; data?: unknown }>) {
    const links: unknown[] = [];
    const api = async (method: string, p: string, body?: unknown) => {
      if (method === "PUT" && p.endsWith("/assets")) {
        links.push(body);
        const next = linkReplies.shift();
        return { status: next?.status ?? 500, data: next?.data ?? null };
      }
      throw new Error(`unexpected ${method} ${p}`);
    };
    return { links, assetSync: createAssetSync({ api, registry, grants: { assetRoots: () => [], grantedFilePaths: () => [] }, sleep: async () => {} }) };
  }

  it("is tried again on the next pass and lands", async () => {
    // No references at all, so the push is the link call and nothing else.
    seed({ path: "/d/a.md", cloud_doc_id: "c1", content_hash: sha("words"), assets_state: "pending" }, "words");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("words") }] };
    const { links, assetSync: real } = realAssetSync([
      { status: 401, data: { error: "unauthorized" } },
      { status: 200, data: { linked: 0, kept: 0, dropped: 0, droppedRefs: [] } },
    ]);
    const reconciler = createReconciler({ sync, registry, assetSync: real, fs, sleep: async () => {} });

    const first = await reconciler.run();
    expect(rows.get("/d/a.md")!.assets_state).toBe("pending");
    expect(first.errors).toEqual([{ path: "/d/a.md", error: "media link failed (401)" }]);

    // Signed in again. The row was never settled, so this pass sends it.
    const second = await reconciler.run();
    expect(links).toHaveLength(2);
    expect(second.mediaPushed).toEqual(["/d/a.md"]);
    expect(rows.get("/d/a.md")!.assets_state).toBe("synced");
  });
});

// A refused link settles the row, which is right, but it is not a push. It
// used to land in mediaPushed, which reads as "this document's media went up"
// and fires a library refresh on the strength of it.
describe("a link the server refused", () => {
  it("is reported as an error, not as media pushed", async () => {
    seed({ path: "/d/a.md", cloud_doc_id: "c1", content_hash: sha("ok"), assets_state: "pending" }, "ok");
    listing = { docs: [{ id: "c1", version: 1, hash: sha("ok") }] };
    mediaAnswer = () => ({ ok: true, uploaded: 0, refused: 413, skipped: [{ ref: "*", reason: "refused", status: 413 }] });

    const r = await createReconciler({ sync, registry, assetSync, fs, sleep: async () => {} }).run();

    expect(r.mediaPushed).toEqual([]);
    expect(r.errors).toEqual([{ path: "/d/a.md", error: "media refused (413)" }]);
  });
});
