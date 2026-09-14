import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { createLinkSync } = require("./link-sync") as typeof import("./link-sync");
const { linkFingerprint } = require("./doc-links") as typeof import("./doc-links");

type Call = { method: string; path: string; body?: unknown };
function fakeApi(replies: Array<{ status: number; data?: unknown }>) {
  const calls: Call[] = [];
  const api = async (method: string, p: string, body?: unknown) => {
    calls.push({ method, path: p, body });
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

function fixture() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "markie-link-sync-")));
  writeFileSync(path.join(dir, "plan.md"), "# plan");
  const docPath = path.join(dir, "doc.md");
  rows.set(docPath, { cloud_doc_id: "c-doc" });
  rows.set(path.join(dir, "plan.md"), { cloud_doc_id: "c-plan" });
  return { dir, docPath };
}

beforeEach(() => {
  rows = new Map();
});

const MD = "[plan](plan.md) [none](nowhere.md)";
const EXPECTED = [{ ref: "plan.md", target: "c-plan" }];

describe("pushLinks", () => {
  it("sends the resolved pairs with the base version and records the fingerprint", async () => {
    const { docPath } = fixture();
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 1 } }]);
    const { pushLinks } = createLinkSync({ api, registry });
    expect(await pushLinks(docPath, "c-doc", MD, { baseVersion: 3 })).toEqual({ ok: true, linked: 1 });
    expect(calls).toEqual([{ method: "PUT", path: "/api/docs/c-doc/links", body: { links: EXPECTED, baseVersion: 3 } }]);
    const row = rows.get(docPath)!;
    expect(row.links_state).toBe("synced");
    expect(row.links_fingerprint).toBe(linkFingerprint(EXPECTED));
  });

  it("sends nothing when the row already holds this fingerprint", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { ...rows.get(docPath)!, links_state: "synced", links_fingerprint: linkFingerprint(EXPECTED) });
    const { api, calls } = fakeApi([]);
    const { pushLinks } = createLinkSync({ api, registry });
    expect(await pushLinks(docPath, "c-doc", MD, { baseVersion: 3 })).toEqual({ unchanged: true });
    expect(calls).toEqual([]);
  });

  it("sends again when a linked file became synced since, which changes the fingerprint", async () => {
    const { docPath } = fixture();
    rows.set(docPath, { ...rows.get(docPath)!, links_state: "synced", links_fingerprint: linkFingerprint([]) });
    const { api, calls } = fakeApi([{ status: 200, data: { linked: 1 } }]);
    const { pushLinks } = createLinkSync({ api, registry });
    expect(await pushLinks(docPath, "c-doc", MD)).toEqual({ ok: true, linked: 1 });
    expect(calls[0].body).toEqual({ links: EXPECTED });
  });

  it("leaves the row pending on 409 so reconciliation retries", async () => {
    const { docPath } = fixture();
    const { api } = fakeApi([{ status: 409, data: { serverVersion: 9 } }]);
    const { pushLinks } = createLinkSync({ api, registry });
    expect(await pushLinks(docPath, "c-doc", MD, { baseVersion: 3 })).toEqual({ conflict: true });
    expect(rows.get(docPath)!.links_state).toBe("pending");
  });

  it("settles a refused body at its fingerprint so it is not resent until the links change", async () => {
    const { docPath } = fixture();
    const { api, calls } = fakeApi([{ status: 413, data: { cap: 500 } }]);
    const { pushLinks } = createLinkSync({ api, registry });
    expect(await pushLinks(docPath, "c-doc", MD, { baseVersion: 3 })).toEqual({ refused: 413 });
    expect(rows.get(docPath)!.links_state).toBe("refused");
    expect(rows.get(docPath)!.links_fingerprint).toBe(linkFingerprint(EXPECTED));
    expect(await pushLinks(docPath, "c-doc", MD, { baseVersion: 3 })).toEqual({ unchanged: true });
    expect(calls).toHaveLength(1);
  });

  it("leaves the row pending on every other answer, offline included", async () => {
    const { docPath } = fixture();
    for (const [status, error] of [[404, "link push failed (404)"], [500, "link push failed (500)"], [0, "link push failed (offline)"]] as const) {
      rows.set(docPath, { cloud_doc_id: "c-doc" });
      const { api } = fakeApi([{ status }]);
      const { pushLinks } = createLinkSync({ api, registry });
      expect(await pushLinks(docPath, "c-doc", MD, { baseVersion: 3 })).toEqual({ error });
      expect(rows.get(docPath)!.links_state).toBe("pending");
    }
  });
});
