import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const { createAssetSync } = require("./asset-sync") as typeof import("./asset-sync");
const { fingerprint } = require("./doc-assets") as typeof import("./doc-assets");

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
    expect(row.assets_fingerprint).toBe(fingerprint([{ ref: "shots/a.png", hash: sha("aaaa") }, { ref: "b.png", hash: sha("bbbb") }]));
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
});
