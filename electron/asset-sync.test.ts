import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const { createAssetSync } = require("./asset-sync") as typeof import("./asset-sync");
const { fingerprint, hashFile } = require("./doc-assets") as typeof import("./doc-assets");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fixture() {
  // realpathSync.native, not the raw mkdtempSync path: on macOS /tmp resolves
  // through /var -> /private/var, and resolveRefs compares realpaths.
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "markie-asset-sync-")));
  mkdirSync(path.join(dir, "shots"));
  writeFileSync(path.join(dir, "shots", "a.png"), "aaaa");
  writeFileSync(path.join(dir, "b.png"), "bbbb");
  return { dir, docPath: path.join(dir, "doc.md") };
}

type Call = { method: string; path: string; body?: unknown; raw?: { size: number; mime: string } };
function fakeApi(replies: Array<{ status: number; data?: unknown }>) {
  const calls: Call[] = [];
  const api = async (method: string, p: string, body?: unknown, opts?: { raw?: { stream: unknown; size: number; mime: string } }) => {
    calls.push({ method, path: p, body, raw: opts?.raw ? { size: opts.raw.size, mime: opts.raw.mime } : undefined });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected ${method} ${p}`);
    return { status: next.status, data: next.data ?? null };
  };
  return { api, calls };
}

let rows: Map<string, Record<string, unknown>>;
const registry = {
  get: (p: string) => rows.get(p) ?? null,
  update: (p: string, fields: Record<string, unknown>) => rows.set(p, { ...(rows.get(p) ?? {}), ...fields }),
};
const grants = { assetRoots: () => [] as string[], grantedFilePaths: () => [] as string[] };

beforeEach(() => {
  rows = new Map();
});

describe("pushAssets", () => {
  it("asks what is missing, uploads only that, links the full set and records the result", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")], usage: 0, cap: 1 } },
      { status: 200, data: { ok: true } },
      { status: 200, data: { linked: 2, kept: 0, dropped: 1 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    const md = "![](shots/a.png)\n![](b.png)\n![](notes.txt)\n";
    const result = await pushAssets(docPath, "c1", md);
    expect(result).toEqual({ ok: true, uploaded: 1, skipped: [{ ref: "notes.txt", reason: "type" }] });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/api/docs/c1/assets/missing"],
      ["PUT", `/api/assets/${sha("bbbb")}`],
      ["PUT", "/api/docs/c1/assets"],
    ]);
    expect(calls[0].body).toEqual({ hashes: [sha("aaaa"), sha("bbbb")] });
    expect(calls[1].raw).toEqual({ size: 4, mime: "image/png" });
    expect(calls[2].body).toEqual({ refs: [{ ref: "shots/a.png", hash: sha("aaaa") }, { ref: "b.png", hash: sha("bbbb") }, { ref: "notes.txt" }] });
    const row = rows.get(docPath)!;
    expect(row.assets_state).toBe("synced");
    // The whole reference set, skipped refs included: a hashless entry is
    // what makes removing one later look like a change.
    expect(row.assets_fingerprint).toBe(
      fingerprint([{ ref: "shots/a.png", hash: sha("aaaa") }, { ref: "b.png", hash: sha("bbbb") }, { ref: "notes.txt" }])
    );
    expect(JSON.parse(row.assets_skipped as string)).toEqual([{ ref: "notes.txt", reason: "type" }]);
  });

  it("does nothing when the fingerprint already landed", async () => {
    const { docPath } = fixture();
    const md = "![](b.png)\n";
    rows.set(docPath, { cloud_doc_id: "c1", assets_state: "synced", assets_fingerprint: fingerprint([{ ref: "b.png", hash: sha("bbbb") }]) });
    const { api, calls } = fakeApi([]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await pushAssets(docPath, "c1", md)).toEqual({ unchanged: true });
    expect(calls).toEqual([]);
  });

  it("links an empty set for a document with no media, once", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 0 } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await pushAssets(docPath, "c1", "# words\n")).toEqual({ ok: true, uploaded: 0, skipped: [] });
    expect(calls.map((c) => c.path)).toEqual(["/api/docs/c1/assets"]);
    expect(await pushAssets(docPath, "c1", "# words\n")).toEqual({ unchanged: true });
  });

  it("sends the base version with the link when it is given, and omits it when it is not", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { linked: 0, kept: 0, dropped: 0 } },
      { status: 200, data: { linked: 0, kept: 0, dropped: 0 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });

    // A text push about to PUT on top of version 7 commits its refs against
    // the same version, so the server cannot accept the refs of a snapshot it
    // is then going to refuse.
    await pushAssets(docPath, "c1", "# words\n", { baseVersion: 7 });
    expect(calls[0].body).toEqual({ refs: [], baseVersion: 7 });

    // Reconciliation has no snapshot to commit against, so it sends no
    // version and the server links unconditionally, as it always did.
    rows.set(docPath, { ...rows.get(docPath), assets_state: "pending" });
    await pushAssets(docPath, "c1", "# words\n");
    expect(calls[1].body).toEqual({ refs: [] });
  });

  it("leaves the row pending and reports a conflict when the link is refused as stale", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([
      { status: 200, data: { missing: [] } },
      { status: 409, data: { error: "version mismatch", serverVersion: 9 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });

    // Somebody else's snapshot landed between this push's base version and
    // the link. The text PUT that follows will 409 too and take the row into
    // the conflict flow; this one only has to not claim the refs are synced.
    const result = await pushAssets(docPath, "c1", "![](b.png)\n", { baseVersion: 4 });

    expect(result).toEqual({ pending: true, conflict: true });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
    expect(rows.get(docPath)!.assets_fingerprint).toBeUndefined();
  });

  it("retries an upload twice, then leaves the row pending with the error", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")] } },
      { status: 0 },
      { status: 0 },
      { status: 0 },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    const result = await pushAssets(docPath, "c1", "![](b.png)\n");
    expect(result).toEqual({ pending: true, error: "media upload failed (offline)" });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
  });

  it("treats a 503 as pending with no error to show", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([{ status: 503, data: { error: "assets not configured" } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await pushAssets(docPath, "c1", "![](b.png)\n")).toEqual({ pending: true });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
  });

  it("skips a file over the cap and says so", async () => {
    const { dir, docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    // Nothing is left to upload, so there is nothing to ask about: the only
    // call is the link, which names the ref without a hash.
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 1 } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {}, maxBytes: 3 });
    const result = await pushAssets(docPath, "c1", "![](b.png)\n");
    expect(result).toEqual({ ok: true, uploaded: 0, skipped: [{ ref: "b.png", reason: "size" }] });
    expect(calls.map((c) => c.path)).toEqual(["/api/docs/c1/assets"]);
    expect(calls[0].body).toEqual({ refs: [{ ref: "b.png" }] });
    void dir;
  });

  it("never hashes a file it is about to skip for size", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const hashSpy = vi.fn(hashFile);
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 1 } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {}, maxBytes: 3, hashFile: hashSpy });
    const result = await pushAssets(docPath, "c1", "![](b.png)\n");
    expect(result).toEqual({ ok: true, uploaded: 0, skipped: [{ ref: "b.png", reason: "size" }] });
    expect(hashSpy).not.toHaveBeenCalled();
    expect(calls.map((c) => c.path)).toEqual(["/api/docs/c1/assets"]);
  });

  it("does not re-hash an unchanged file on a second push, even when the row is not yet synced", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const hashSpy = vi.fn(hashFile);
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")] } },
      { status: 200, data: { ok: true } },
      { status: 200, data: { linked: 1, kept: 0, dropped: 0 } },
      { status: 200, data: { missing: [] } },
      { status: 200, data: { linked: 1, kept: 0, dropped: 0 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {}, hashFile: hashSpy });
    const md = "![](b.png)\n";
    await pushAssets(docPath, "c1", md);
    expect(hashSpy).toHaveBeenCalledTimes(1);

    // A reconciliation pass retrying a row a prior failure left "pending",
    // with the file on disk never touched: the second push still talks to
    // the network (missing + link, nothing left to upload), but the hash
    // itself comes from the cache, not another read of the file.
    rows.set(docPath, { ...rows.get(docPath), assets_state: "pending" });
    await pushAssets(docPath, "c1", md);
    expect(hashSpy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(5);
  });

  it("uploads a byte-identical file once and links both refs to the same hash", async () => {
    const { dir, docPath } = fixture();
    writeFileSync(path.join(dir, "c.png"), "aaaa"); // same bytes as shots/a.png
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("aaaa")] } },
      { status: 200, data: { ok: true } },
      { status: 200, data: { linked: 2, kept: 0, dropped: 0 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    const md = "![](shots/a.png)\n![](c.png)\n";
    const result = await pushAssets(docPath, "c1", md);
    expect(result).toEqual({ ok: true, uploaded: 1, skipped: [] });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/api/docs/c1/assets/missing"],
      ["PUT", `/api/assets/${sha("aaaa")}`],
      ["PUT", "/api/docs/c1/assets"],
    ]);
    expect(calls[2].body).toEqual({ refs: [{ ref: "shots/a.png", hash: sha("aaaa") }, { ref: "c.png", hash: sha("aaaa") }] });
  });
});

describe("stageAssets", () => {
  it("uploads the missing bytes and stops before the link", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")] } },
      { status: 200, data: { ok: true } },
    ]);
    const { stageAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    const md = "![](shots/a.png)\n![](b.png)\n![](notes.txt)\n";

    const result = await stageAssets(docPath, "c1", md);

    // Bytes only. Nothing has told the server what the document points at.
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/api/docs/c1/assets/missing"],
      ["PUT", `/api/assets/${sha("bbbb")}`],
    ]);
    const linkRefs = [
      { ref: "shots/a.png", hash: sha("aaaa") },
      { ref: "b.png", hash: sha("bbbb") },
      { ref: "notes.txt" },
    ];
    expect(result).toEqual({
      staged: { linkRefs, uploaded: 1, skipped: [{ ref: "notes.txt", reason: "type" }], fingerprint: fingerprint(linkRefs) },
    });
    // Staging alone never claims anything about the row.
    expect(rows.get(docPath)!.assets_state).toBeUndefined();
  });

  it("answers unchanged when the row is synced on the same reference set", async () => {
    const { docPath } = fixture();
    rows.set(docPath, {
      cloud_doc_id: "c1",
      assets_state: "synced",
      assets_fingerprint: fingerprint([{ ref: "b.png", hash: sha("bbbb") }]),
    });
    const { api, calls } = fakeApi([]);
    const { stageAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await stageAssets(docPath, "c1", "![](b.png)\n")).toEqual({ unchanged: true });
    expect(calls).toEqual([]);
  });

  it("writes the row pending and reports the failure when an upload cannot land", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")] } },
      { status: 0 },
      { status: 0 },
      { status: 0 },
    ]);
    const { stageAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await stageAssets(docPath, "c1", "![](b.png)\n")).toEqual({
      pending: true,
      error: "media upload failed (offline)",
    });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
  });
});

describe("linkAssets", () => {
  const staged = () => ({
    linkRefs: [{ ref: "b.png", hash: sha("bbbb") }],
    uploaded: 1,
    skipped: [{ ref: "notes.txt", reason: "type" }],
    fingerprint: "fp-1",
  });

  it("sends the staged refs against the base version and records the row synced", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 1, kept: 0, dropped: 0 } }]);
    const { linkAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });

    const result = await linkAssets(docPath, "c1", staged(), { baseVersion: 12 });

    expect(result).toEqual({ ok: true, uploaded: 1, skipped: [{ ref: "notes.txt", reason: "type" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/docs/c1/assets");
    expect(calls[0].body).toEqual({ refs: [{ ref: "b.png", hash: sha("bbbb") }], baseVersion: 12 });
    const row = rows.get(docPath)!;
    expect(row.assets_state).toBe("synced");
    expect(row.assets_fingerprint).toBe("fp-1");
    expect(JSON.parse(row.assets_skipped as string)).toEqual([{ ref: "notes.txt", reason: "type" }]);
  });

  it("omits the base version when the caller has none", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 1 } }]);
    const { linkAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    await linkAssets(docPath, "c1", staged(), {});
    expect(calls[0].body).toEqual({ refs: [{ ref: "b.png", hash: sha("bbbb") }] });
  });

  it("leaves the row pending and reports a conflict when the link is refused as stale", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([{ status: 409, data: { error: "version mismatch", serverVersion: 9 } }]);
    const { linkAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await linkAssets(docPath, "c1", staged(), { baseVersion: 4 })).toEqual({ pending: true, conflict: true });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
    expect(rows.get(docPath)!.assets_fingerprint).toBeUndefined();
  });

  it("treats a 503 as pending with nothing to show", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([{ status: 503, data: { error: "assets not configured" } }]);
    const { linkAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await linkAssets(docPath, "c1", staged(), {})).toEqual({ pending: true });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
  });

  it("reports any other refusal and leaves the row pending", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api } = fakeApi([{ status: 500 }]);
    const { linkAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    expect(await linkAssets(docPath, "c1", staged(), {})).toEqual({ pending: true, error: "media link failed (500)" });
    expect(rows.get(docPath)!.assets_state).toBe("pending");
  });
});

describe("the fingerprint covers the whole reference set", () => {
  it("tells a document whose only ref was skipped from one with no refs at all", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const skipOnly = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 1 } }]);
    await createAssetSync({ api: skipOnly.api, registry, grants, sleep: async () => {} }).pushAssets(docPath, "c1", "![](notes.txt)\n");
    const withSkipped = rows.get(docPath)!.assets_fingerprint;

    rows.set(docPath, { cloud_doc_id: "c1" });
    const noRefs = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 0 } }]);
    await createAssetSync({ api: noRefs.api, registry, grants, sleep: async () => {} }).pushAssets(docPath, "c1", "# words\n");

    expect(rows.get(docPath)!.assets_fingerprint).not.toBe(withSkipped);
  });

  it("links again when a skipped ref is taken out of a synced document", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { linked: 0, kept: 0, dropped: 1 } },
      { status: 200, data: { linked: 0, kept: 0, dropped: 0 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });
    await pushAssets(docPath, "c1", "![](notes.txt)\n");
    expect(rows.get(docPath)!.assets_state).toBe("synced");

    // The reference is gone from the text. Nothing resolved before and
    // nothing resolves now, so a fingerprint over resolved entries alone
    // would call this unchanged and leave the old ref linked on the server.
    const second = await pushAssets(docPath, "c1", "# words\n");

    expect(second).toEqual({ ok: true, uploaded: 0, skipped: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ refs: [] });
  });
});

describe("what an upload refusal means", () => {
  it("retries a 400 and leaves the row pending, because it says the bytes moved", async () => {
    // The server answers 400 when the body does not hash to the name it was
    // sent under, which is a file that changed between the hash and the
    // upload, not a file Markie may not send. Recording it as a type skip
    // marked the row synced and hid a picture that never arrived.
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")] } },
      { status: 400 },
      { status: 400 },
      { status: 400 },
    ]);
    const { stageAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });

    expect(await stageAssets(docPath, "c1", "![](b.png)\n")).toEqual({
      pending: true,
      error: "media upload failed (400)",
    });
    expect(calls).toHaveLength(4);
    expect(rows.get(docPath)!.assets_state).toBe("pending");
    expect(JSON.parse(rows.get(docPath)!.assets_skipped as string)).toEqual([]);
  });

  it("takes a 415 as a type this server will not hold, once", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")] } },
      { status: 415 },
      { status: 200, data: { linked: 0, kept: 0, dropped: 1 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });

    expect(await pushAssets(docPath, "c1", "![](b.png)\n")).toEqual({
      ok: true,
      uploaded: 0,
      skipped: [{ ref: "b.png", reason: "type" }],
    });
    expect(calls).toHaveLength(3);
    expect(calls[2].body).toEqual({ refs: [{ ref: "b.png" }] });
  });

  it("takes a 413 as a file this server will not hold, once", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("bbbb")] } },
      { status: 413 },
      { status: 200, data: { linked: 0, kept: 0, dropped: 1 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });

    expect(await pushAssets(docPath, "c1", "![](b.png)\n")).toEqual({
      ok: true,
      uploaded: 0,
      skipped: [{ ref: "b.png", reason: "size" }],
    });
    expect(calls).toHaveLength(3);
  });
});

// ── Who wrote the reference ────────────────────────────────────────────────
// A document somebody else can read is a document somebody else can write a
// reference into. Resolving one against this machine's own grants is how a
// co-editor's `../notes/board-deck.png` makes this machine upload that file
// into their document. So an exposed document stages only what sits beside
// it; a private one keeps the repository pattern the spec is built around.
function exposedFixture() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "markie-exposure-")));
  mkdirSync(path.join(root, "docs"));
  mkdirSync(path.join(root, "notes"));
  writeFileSync(path.join(root, "docs", "x.png"), "xxxx");
  writeFileSync(path.join(root, "notes", "board.png"), "board");
  writeFileSync(path.join(root, "notes", "passport.png"), "passport");
  const docPath = path.join(root, "docs", "doc.md");
  const absolute = path.join(root, "notes", "passport.png");
  const md = `![](x.png)\n![](../notes/board.png)\n![](${absolute})\n`;
  // Everything under the fixture is a granted root, which is what the real
  // machine looks like: the default workspace root holds Cloud/ inside it.
  return { root, docPath, absolute, md, grants: { assetRoots: () => [root], grantedFilePaths: () => [] } };
}

describe("what an exposed document may stage", () => {
  it("stages only what sits beside a document somebody else can read", async () => {
    const { docPath, absolute, md, grants: wide } = exposedFixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("xxxx")] } },
      { status: 200, data: { ok: true } },
      { status: 200, data: { linked: 1, kept: 0, dropped: 2 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants: wide, sleep: async () => {}, isExposed: () => true });

    const result = await pushAssets(docPath, "c1", md);

    expect(result).toEqual({
      ok: true,
      uploaded: 1,
      skipped: [
        { ref: "../notes/board.png", reason: "outside" },
        { ref: absolute, reason: "outside" },
      ],
    });
    // Only the sibling was ever offered to the server, and the other two are
    // linked bare, so the document keeps no hash for them.
    expect(calls[0].body).toEqual({ hashes: [sha("xxxx")] });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/docs/c1/assets/missing",
      `/api/assets/${sha("xxxx")}`,
      "/api/docs/c1/assets",
    ]);
    expect(calls[2].body).toEqual({
      refs: [{ ref: "x.png", hash: sha("xxxx") }, { ref: "../notes/board.png" }, { ref: absolute }],
    });
  });

  it("stages everything this machine may draw for a document nobody else can read", async () => {
    const { docPath, absolute, md, grants: wide } = exposedFixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [sha("xxxx"), sha("board"), sha("passport")] } },
      { status: 200, data: { ok: true } },
      { status: 200, data: { ok: true } },
      { status: 200, data: { ok: true } },
      { status: 200, data: { linked: 3, kept: 0, dropped: 0 } },
    ]);
    const { pushAssets } = createAssetSync({ api, registry, grants: wide, sleep: async () => {}, isExposed: () => false });

    expect(await pushAssets(docPath, "c1", md)).toEqual({ ok: true, uploaded: 3, skipped: [] });
    expect(calls[4].body).toEqual({
      refs: [
        { ref: "x.png", hash: sha("xxxx") },
        { ref: "../notes/board.png", hash: sha("board") },
        { ref: absolute, hash: sha("passport") },
      ],
    });
  });

  it("treats a document whose exposure nobody has stated as exposed", async () => {
    const { docPath, absolute, md, grants: wide } = exposedFixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const { api, calls } = fakeApi([
      { status: 200, data: { missing: [] } },
      { status: 200, data: { linked: 1, kept: 0, dropped: 2 } },
    ]);
    // No listing has been seen for this document, so nothing is known. The
    // answer that leaks nothing is the one that treats it as shared.
    const { pushAssets } = createAssetSync({ api, registry, grants: wide, sleep: async () => {}, isExposed: () => null });

    const result = await pushAssets(docPath, "c1", md);

    expect(result.skipped).toEqual([
      { ref: "../notes/board.png", reason: "outside" },
      { ref: absolute, reason: "outside" },
    ]);
    expect(calls[1].body).toEqual({
      refs: [{ ref: "x.png", hash: sha("xxxx") }, { ref: "../notes/board.png" }, { ref: absolute }],
    });
  });

  it("refuses the same shapes the server's link route refuses", async () => {
    const { root, docPath, grants: wide } = exposedFixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    // `./x.png` resolves to the sibling and the local viewer draws it, but
    // the server refuses a `.` segment from an exposed document, so staging
    // it would upload bytes for a link that answers 400 on every pass.
    // A symlink inside the folder pointing out is refused by resolveRefs
    // itself, and lands in the same skip list.
    symlinkSync(path.join(root, "notes", "passport.png"), path.join(root, "docs", "link.png"));
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 2 } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants: wide, sleep: async () => {}, isExposed: () => true });

    const result = await pushAssets(docPath, "c1", "![](./x.png)\n![](link.png)\n");

    expect(result).toEqual({
      ok: true,
      uploaded: 0,
      skipped: [
        { ref: "./x.png", reason: "outside" },
        { ref: "link.png", reason: "outside" },
      ],
    });
    expect(calls.map((c) => c.path)).toEqual(["/api/docs/c1/assets"]);
  });
});

// The server refuses a reference set over 2000 with 413. A client that sent
// the whole set anyway would 413 on every reconciliation pass for ever, so it
// caps first and says what it left out.
describe("a document with more references than the server will take", () => {
  it("keeps the first 2000 in document order and reports the rest", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { cloud_doc_id: "c1" });
    const md = Array.from({ length: 2003 }, (_, i) => `![](p${i}.png)`).join("\n");
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 0, kept: 0, dropped: 2000 } }]);
    const { pushAssets } = createAssetSync({ api, registry, grants, sleep: async () => {} });

    const result = await pushAssets(docPath, "c1", md);

    const sent = (calls[0].body as { refs: { ref: string }[] }).refs;
    expect(sent).toHaveLength(2000);
    expect(sent[0]).toEqual({ ref: "p0.png" });
    expect(sent[1999]).toEqual({ ref: "p1999.png" });
    // The three that did not fit are named, after the ones that were skipped
    // for their own reasons.
    expect(result.skipped.slice(-3)).toEqual([
      { ref: "p2000.png", reason: "count" },
      { ref: "p2001.png", reason: "count" },
      { ref: "p2002.png", reason: "count" },
    ]);
    expect(result.skipped.filter((s: { reason: string }) => s.reason === "count")).toHaveLength(3);
  });
});
