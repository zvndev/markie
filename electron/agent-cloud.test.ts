import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createAgentCloud, markdownLinkFor, sanitizeAgentName, SYNCABLE } = require("./agent-cloud.js");

const ORIGIN = "https://api.markiedocs.com";

function setup({ perms = {} as { cloudSync?: string }, answers = [] as Array<{ allowed: boolean; always?: boolean }>, unlocked = true, api = vi.fn() } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "markie-agent-cloud-")));
  const rows = new Map<string, Record<string, unknown>>();
  const registry = {
    get: (p: string) => rows.get(p) ?? null,
    track: vi.fn((p: string, name: string) => { rows.set(p, { ...(rows.get(p) ?? {}), path: p, name }); }),
  };
  const sync = {
    originOfRow: () => ORIGIN,
    withOrigin: (_o: string, fn: () => unknown) => fn(),
    api,
    syncOn: vi.fn(async (p: string): Promise<Record<string, unknown>> => { rows.set(p, { ...rows.get(p), cloud_doc_id: "doc-1", sync_state: "synced" }); return { ok: true, version: 1 }; }),
    push: vi.fn(async () => ({ ok: true, version: 2 })),
  };
  let stored = { ...perms };
  const permissions = { get: () => stored, set: vi.fn((next: typeof stored) => { stored = next; }) };
  const confirm = vi.fn(async () => answers.shift() ?? { allowed: false });
  const libraryChanged = vi.fn();
  const cloud = createAgentCloud({ registry, sync, home, unlocked: () => unlocked, confirm, permissions, libraryChanged });
  const file = (name: string, body = "# Hi\n") => { const p = path.join(home, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  return { cloud: cloud.handlers, rows, registry, sync, permissions, confirm, libraryChanged, file, home };
}

describe("agent cloud: syncing", () => {
  it("asks the first time, syncs, and returns the private link", async () => {
    const t = setup({ answers: [{ allowed: true }] });
    const p = t.file("Documents/Markie/plan.md");
    const res = await t.cloud.cloud_sync({ path: p });
    expect(t.confirm).toHaveBeenCalledWith({ kind: "sync", name: "plan.md", path: p });
    expect(t.registry.track).toHaveBeenCalledWith(p, "plan.md", "# Hi\n");
    expect(res).toMatchObject({ synced: true, privateLink: `${ORIGIN}/d/doc-1`, server: ORIGIN });
    expect(t.libraryChanged).toHaveBeenCalled();
    expect(t.permissions.set).not.toHaveBeenCalled();
  });

  it("remembers 'always allow' and stops asking", async () => {
    const t = setup({ answers: [{ allowed: true, always: true }] });
    await t.cloud.cloud_sync({ path: t.file("a.md") });
    await t.cloud.cloud_sync({ path: t.file("b.md") });
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.permissions.get().cloudSync).toBe("always");
  });

  it("uploads nothing when the user declines", async () => {
    const t = setup({ answers: [{ allowed: false }] });
    await expect(t.cloud.cloud_sync({ path: t.file("a.md") })).rejects.toThrow("declined");
    expect(t.sync.syncOn).not.toHaveBeenCalled();
    expect(t.registry.track).not.toHaveBeenCalled();
  });

  it("pushes the latest text of a file already in Cloud", async () => {
    const t = setup({ perms: { cloudSync: "always" } });
    const p = t.file("a.md", "new text");
    t.rows.set(p, { cloud_doc_id: "doc-9", sync_state: "synced" });
    const res = await t.cloud.cloud_sync({ path: p });
    expect(t.sync.push).toHaveBeenCalledWith(p, "a.md", "new text");
    expect(t.sync.syncOn).not.toHaveBeenCalled();
    expect(res.privateLink).toBe(`${ORIGIN}/d/doc-9`);
  });

  it("says to sign in when Cloud has no session", async () => {
    const t = setup({ perms: { cloudSync: "always" } });
    t.sync.syncOn.mockResolvedValueOnce({ error: "Sign in to Markie Cloud to sync this file." });
    await expect(t.cloud.cloud_sync({ path: t.file("a.md") })).rejects.toThrow("Sign in to Markie Cloud");
  });

  it("refuses files outside home, other formats, missing files, and a locked build", async () => {
    const t = setup({ perms: { cloudSync: "always" } });
    await expect(t.cloud.cloud_sync({ path: "/etc/hosts" })).rejects.toThrow();
    await expect(t.cloud.cloud_sync({ path: t.file("notes.docx", "x") })).rejects.toThrow("Markdown, Darkmown and plain text");
    await expect(t.cloud.cloud_sync({ path: path.join(t.home, "nope.md") })).rejects.toThrow("No such file");
    await expect(t.cloud.cloud_sync({ path: "relative.md" })).rejects.toThrow("absolute path");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "markie-outside-"));
    fs.writeFileSync(path.join(outside, "x.md"), "x");
    fs.symlinkSync(path.join(outside, "x.md"), path.join(t.home, "link.md"));
    await expect(t.cloud.cloud_sync({ path: path.join(t.home, "link.md") })).rejects.toThrow("home folder");
    const locked = setup({ unlocked: false, perms: { cloudSync: "always" } });
    await expect(locked.cloud.cloud_sync({ path: locked.file("a.md") })).rejects.toThrow("locked");
    expect(t.sync.syncOn).not.toHaveBeenCalled();
  });
});

describe("agent cloud: Darkmown", () => {
  it("syncs a .wd file like any other, with the same consent", async () => {
    const t = setup({ answers: [{ allowed: true }] });
    const p = t.file("Documents/Markie/budget.wd", "<Counter />\n");
    const res = await t.cloud.cloud_sync({ path: p });
    expect(t.confirm).toHaveBeenCalledWith({ kind: "sync", name: "budget.wd", path: p });
    expect(t.registry.track).toHaveBeenCalledWith(p, "budget.wd", "<Counter />\n");
    expect(res).toMatchObject({ synced: true, name: "budget.wd", privateLink: `${ORIGIN}/d/doc-1` });
  });

  it("asks before the first .wd upload and uploads nothing when declined", async () => {
    const t = setup({ answers: [{ allowed: false }] });
    await expect(t.cloud.cloud_sync({ path: t.file("a.wd") })).rejects.toThrow("declined");
    expect(t.sync.syncOn).not.toHaveBeenCalled();
  });

  it("accepts .wd in any case and still refuses lookalikes", () => {
    for (const name of ["a.wd", "A.WD", "notes.md", "t.txt"]) expect(SYNCABLE.test(name), name).toBe(true);
    for (const name of ["a.wdx", "wd", "a.wd.html", "a.docx", "a.csv"]) expect(SYNCABLE.test(name), name).toBe(false);
  });
});

describe("agent cloud: origin", () => {
  const syncOnArgs = (t: ReturnType<typeof setup>) => t.sync.syncOn.mock.calls[0] as unknown[];

  it("sends the agent's name on the call that creates the document", async () => {
    const t = setup({ perms: { cloudSync: "always" } });
    const p = t.file("a.md");
    await t.cloud.cloud_sync({ path: p, agent: "Claude Code" });
    expect(syncOnArgs(t)).toEqual([p, "a.md", "# Hi\n", undefined, undefined, { kind: "agent", agent: "Claude Code" }]);
  });

  it("falls back to 'an agent' when the client gave no usable name", async () => {
    for (const agent of [undefined, null, 5, "", "   ", "\u0000\u200b\n"]) {
      const t = setup({ perms: { cloudSync: "always" } });
      await t.cloud.cloud_sync({ path: t.file("a.md"), agent });
      expect(syncOnArgs(t)[5], String(agent)).toEqual({ kind: "agent", agent: "an agent" });
    }
  });

  it("sends nothing about origin when the file is already in Cloud", async () => {
    const t = setup({ perms: { cloudSync: "always" } });
    const p = t.file("a.md");
    t.rows.set(p, { cloud_doc_id: "doc-9", sync_state: "synced" });
    await t.cloud.cloud_sync({ path: p, agent: "Claude Code" });
    expect(t.sync.syncOn).not.toHaveBeenCalled();
    expect(t.sync.push).toHaveBeenCalledWith(p, "a.md", "# Hi\n");
  });

  it("sanitizes the name: one printable line, 64 characters at most", () => {
    expect(sanitizeAgentName("Claude Code")).toBe("Claude Code");
    expect(sanitizeAgentName("  claude\u0000-code\r\n\t(vs   code)  ")).toBe("claude -code (vs code)");
    expect(sanitizeAgentName("a\u202eb\u200bc")).toBe("a b c");
    expect(sanitizeAgentName("x".repeat(200))).toBe("x".repeat(64));
    const emoji = sanitizeAgentName("\u{1F600}".repeat(100));
    expect(Array.from(emoji)).toHaveLength(64);
    expect(emoji.includes("\ufffd")).toBe(false);
    expect(sanitizeAgentName("  " + "y".repeat(63) + " z")).toBe("y".repeat(63));
    expect(sanitizeAgentName({} as never)).toBe("an agent");
  });
});

describe("agent cloud: markdownLink", () => {
  it("is [name](privateLink) after a sync", async () => {
    const t = setup({ perms: { cloudSync: "always" } });
    const res = await t.cloud.cloud_sync({ path: t.file("plan.md") });
    expect(res.privateLink).toBe(`${ORIGIN}/d/doc-1`);
    expect(res.markdownLink).toBe(`[plan.md](${ORIGIN}/d/doc-1)`);
  });

  it("is on cloud_status too, and null with the privateLink when the file is local", async () => {
    const t = setup();
    const p = t.file("a.wd");
    expect(await t.cloud.cloud_status({ path: p })).toMatchObject({ privateLink: null, markdownLink: null });
    t.rows.set(p, { cloud_doc_id: "d 2", sync_state: "synced" });
    expect((await t.cloud.cloud_status({ path: p })).markdownLink).toBe(`[a.wd](${ORIGIN}/d/d%202)`);
  });

  it("keeps a bracket in the file name from ending the link text", () => {
    expect(markdownLinkFor("a [draft] b.md", "https://x/d/1")).toBe("[a \\[draft\\] b.md](https://x/d/1)");
    expect(markdownLinkFor("a.md", null)).toBeNull();
  });
});

describe("agent cloud: status", () => {
  it("reports a local file without a link and a synced one with it", async () => {
    const t = setup();
    const p = t.file("a.md");
    expect(await t.cloud.cloud_status({ path: p })).toMatchObject({ synced: false, syncState: "local", privateLink: null });
    t.rows.set(p, { cloud_doc_id: "d 2", sync_state: "synced" });
    expect((await t.cloud.cloud_status({ path: p })).privateLink).toBe(`${ORIGIN}/d/d%202`);
    expect(t.confirm).not.toHaveBeenCalled();
  });
});

describe("agent cloud: public links", () => {
  it("returns an existing public link without asking", async () => {
    const api = vi.fn(async () => ({ status: 200, data: { url: "https://markiedocs.com/s/tok" } }));
    const t = setup({ api });
    const p = t.file("a.md");
    t.rows.set(p, { cloud_doc_id: "doc-1", sync_state: "synced" });
    expect((await t.cloud.cloud_public_link({ path: p, create: true })).publicLink).toBe("https://markiedocs.com/s/tok");
    expect(api).toHaveBeenCalledTimes(1);
    expect(t.confirm).not.toHaveBeenCalled();
  });

  it("makes one only when asked to and confirmed, even with 'always allow' on", async () => {
    const api = vi.fn(async (method: string) => (method === "GET" ? { status: 200, data: { url: null } } : { status: 200, data: { url: "https://markiedocs.com/s/new" } }));
    const t = setup({ api, perms: { cloudSync: "always" }, answers: [{ allowed: false }, { allowed: true }] });
    const p = t.file("a.md");
    t.rows.set(p, { cloud_doc_id: "doc-1", sync_state: "synced" });
    expect((await t.cloud.cloud_public_link({ path: p })).publicLink).toBeNull();
    expect(t.confirm).not.toHaveBeenCalled();
    await expect(t.cloud.cloud_public_link({ path: p, create: true })).rejects.toThrow("declined");
    expect(api).not.toHaveBeenCalledWith("POST", expect.anything());
    expect((await t.cloud.cloud_public_link({ path: p, create: true })).publicLink).toBe("https://markiedocs.com/s/new");
    expect(t.confirm).toHaveBeenLastCalledWith({ kind: "public", name: "a.md", path: p });
    expect(api).toHaveBeenCalledWith("POST", "/api/docs/doc-1/public-link");
  });

  it("needs the file in Cloud first, and revokes without asking", async () => {
    const api = vi.fn(async () => ({ status: 200, data: { ok: true } }));
    const t = setup({ api });
    const p = t.file("a.md");
    await expect(t.cloud.cloud_public_link({ path: p, create: true })).rejects.toThrow("Sync it first");
    t.rows.set(p, { cloud_doc_id: "doc-1", sync_state: "synced" });
    expect((await t.cloud.cloud_revoke_public_link({ path: p })).publicLink).toBeNull();
    expect(api).toHaveBeenCalledWith("DELETE", "/api/docs/doc-1/public-link");
    expect(t.confirm).not.toHaveBeenCalled();
  });

  it("explains a refusal from the server", async () => {
    const t = setup({ api: vi.fn(async () => ({ status: 403, data: null })) });
    const p = t.file("a.md");
    t.rows.set(p, { cloud_doc_id: "doc-1", sync_state: "synced" });
    await expect(t.cloud.cloud_public_link({ path: p, create: true })).rejects.toThrow("Only the owner");
  });
});
