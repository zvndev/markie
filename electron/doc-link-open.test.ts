import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";

const { createDocLinkOpener, NOT_SHARED } = require("./doc-link-open") as typeof import("./doc-link-open");

const DOC = "/Users/me/report/notes.md";
let disk: Set<string>;
let rows: Map<string, { path: string; cloud_doc_id: string | null }>;
let apiCalls: string[];
let apiAnswer: () => { status: number; data: unknown };
let configured: boolean;
let landed: string[];
let landAnswer: () => { path: string } | { error: string };
let clock: number;

const fs = { existsSync: (p: string) => disk.has(p) };
const registry = {
  get: (p: string) => rows.get(p) ?? null,
  list: () => [...rows.values()],
};
const sync = {
  isConfigured: () => configured,
  api: async (_m: string, p: string) => {
    apiCalls.push(p);
    return apiAnswer();
  },
};
const localAssets = { candidatePath: (src: string, docDir: string) => path.resolve(docDir, src.split("#")[0].split("?")[0]) };
const land = async (cloudId: string) => {
  landed.push(cloudId);
  return landAnswer();
};
const make = () => createDocLinkOpener({ sync, registry, localAssets, land, fs, now: () => clock });

beforeEach(() => {
  disk = new Set();
  rows = new Map([[DOC, { path: DOC, cloud_doc_id: "c-notes" }]]);
  apiCalls = [];
  apiAnswer = () => ({ status: 200, data: { links: [{ ref: "plan.md", target: "c-plan" }, { ref: "secret.md" }] } });
  configured = true;
  landed = [];
  landAnswer = () => ({ path: "/Users/me/Downloads/plan.md" });
  clock = 1_000_000;
});

describe("resolve", () => {
  it("answers local, cloud, none and unknown in that order of preference", async () => {
    disk.add("/Users/me/report/here.md");
    const out = await make().resolve(DOC, ["here.md", "plan.md", "secret.md", "other.md", "spec.pdf", "plan.md#top"]);
    expect(out).toEqual([
      { href: "here.md", kind: "local" },
      { href: "plan.md", kind: "cloud", target: "c-plan" },
      { href: "secret.md", kind: "none" },
      { href: "other.md", kind: "unknown" },
      { href: "spec.pdf", kind: "unknown" },
      { href: "plan.md#top", kind: "cloud", target: "c-plan" },
    ]);
    expect(apiCalls).toEqual(["/api/docs/c-notes/links"]);
  });

  it("prefers the file on disk even when the cloud knows the link", async () => {
    disk.add("/Users/me/report/plan.md");
    expect(await make().resolve(DOC, ["plan.md"])).toEqual([{ href: "plan.md", kind: "local" }]);
    expect(apiCalls).toEqual([]);
  });

  it("answers unknown for a document that is not in the cloud, when signed out, and when the fetch fails", async () => {
    rows.set(DOC, { path: DOC, cloud_doc_id: null });
    expect(await make().resolve(DOC, ["plan.md"])).toEqual([{ href: "plan.md", kind: "unknown" }]);
    rows.set(DOC, { path: DOC, cloud_doc_id: "c-notes" });
    configured = false;
    expect(await make().resolve(DOC, ["plan.md"])).toEqual([{ href: "plan.md", kind: "unknown" }]);
    configured = true;
    apiAnswer = () => ({ status: 500, data: null });
    expect(await make().resolve(DOC, ["plan.md"])).toEqual([{ href: "plan.md", kind: "unknown" }]);
    expect(await make().resolve(null, ["plan.md"])).toEqual([{ href: "plan.md", kind: "unknown" }]);
  });

  it("remembers the server's answer for a minute per document and forgets on request", async () => {
    const opener = make();
    await opener.resolve(DOC, ["plan.md"]);
    clock += 30_000;
    await opener.resolve(DOC, ["plan.md"]);
    expect(apiCalls).toHaveLength(1);
    clock += 31_000;
    await opener.resolve(DOC, ["plan.md"]);
    expect(apiCalls).toHaveLength(2);
    opener.forget("c-notes");
    await opener.resolve(DOC, ["plan.md"]);
    expect(apiCalls).toHaveLength(3);
  });
});

describe("open", () => {
  it("opens a live copy this machine already has rather than landing another", async () => {
    rows.set("/Users/me/other/plan.md", { path: "/Users/me/other/plan.md", cloud_doc_id: "c-plan" });
    disk.add("/Users/me/other/plan.md");
    expect(await make().open(DOC, "plan.md")).toEqual({ ok: true, path: "/Users/me/other/plan.md" });
    expect(landed).toEqual([]);
  });

  it("lands the target once when no live copy exists, ignoring a row whose file is gone", async () => {
    rows.set("/Users/me/old/plan.md", { path: "/Users/me/old/plan.md", cloud_doc_id: "c-plan" });
    expect(await make().open(DOC, "plan.md")).toEqual({ ok: true, path: "/Users/me/Downloads/plan.md" });
    expect(landed).toEqual(["c-plan"]);
  });

  it("refuses a link the reader may not follow, and one that is not a cloud link", async () => {
    expect(await make().open(DOC, "secret.md")).toEqual({ ok: false, kind: "none", error: NOT_SHARED });
    expect(await make().open(DOC, "other.md")).toEqual({ ok: false, kind: "unknown" });
    expect(landed).toEqual([]);
  });

  it("says so when the landing fails", async () => {
    landAnswer = () => ({ error: "fetch failed (0)" });
    expect(await make().open(DOC, "plan.md")).toEqual({
      ok: false,
      kind: "cloud",
      error: "Couldn't open that document. Check your connection, or ask for it to be shared again.",
    });
  });
});
