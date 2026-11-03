import { describe, expect, it } from "vitest";
import { ApiError, createApiClient, platformFetch } from "../src/lib/api";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/lib/http";
import { collabWsBase, liveConfig, liveKind, saveLiveSnapshot, shouldGoLive, LIVE_MAX_CHARS } from "../src/lib/live";
import { docTypeGroup, kindFromName, newDocName, newDocType, NEW_DOC_TYPES, parsePlatformItem, parsePlatformList, type RecentDoc } from "../src/lib/docs";
import { filterRecent, mergeRecent, withPlatform } from "../src/lib/recent";
import { NEW_DOCUMENT_TYPES } from "@/components/new-document-modal";

const ORIGIN = "https://api.markiedocs.com";
const TOKEN = "tok_aaaaaaaaaaaaaaaaaaaaaaaa";

function fake(handler: (req: HttpRequest) => Partial<HttpResponse> & { json?: unknown }) {
  const calls: HttpRequest[] = [];
  const transport: HttpTransport = async (req) => {
    calls.push(req);
    const out = handler(req);
    return { status: out.status ?? 200, headers: out.headers ?? {}, text: out.text ?? (out.json === undefined ? "" : JSON.stringify(out.json)) };
  };
  return { transport, calls, api: createApiClient({ origin: ORIGIN, transport, getToken: () => TOKEN }) };
}

describe("live editing", () => {
  it("goes live exactly when the desktop does: someone else is on a small Markdown or text document", () => {
    expect(liveKind("Plan.md", "markdown")).toBe("rich");
    expect(liveKind("notes.txt", "text")).toBe("text");
    expect(liveKind("Counter.wd", "darkmown")).toBeNull();
    expect(liveKind("budget.csv", "text")).toBeNull();
    expect(shouldGoLive([{}], "rich", 10)).toBe(true);
    expect(shouldGoLive([], "rich", 10)).toBe(false);
    expect(shouldGoLive(null, "rich", 10)).toBe(false);
    expect(shouldGoLive([{}], null, 10)).toBe(false);
    expect(shouldGoLive([{}], "text", LIVE_MAX_CHARS + 1)).toBe(false);
  });

  it("opens the socket on the signed-in server, wss for https", () => {
    expect(collabWsBase("https://api.markiedocs.com")).toBe("wss://api.markiedocs.com/collab");
    expect(collabWsBase("http://localhost:8790")).toBe("ws://localhost:8790/collab");
  });

  it("never puts the session token on the socket, even when a client says legacy", async () => {
    const config = liveConfig({ origin: ORIGIN, docId: "d1", displayName: "Kirby", readonly: false, fetchTicket: async () => ({ kind: "legacy" }) });
    expect(config.token).toBe("");
    expect(await config.fetchTicket()).toEqual({ kind: "failed", status: 404 });
    expect(config.user.name).toBe("Kirby");
  });

  it("asks the ticket route with the session, and only ever answers ticket or failed", async () => {
    const ok = fake(() => ({ json: { ticket: "t".repeat(43), expiresAt: 5 } }));
    expect(await ok.api.collabTicket("doc-1")).toEqual({ kind: "ticket", ticket: "t".repeat(43), expiresAt: 5 });
    expect(ok.calls[0]).toMatchObject({ method: "POST", url: `${ORIGIN}/api/docs/doc-1/collab-ticket` });
    expect(ok.calls[0].headers?.authorization).toBe(`Bearer ${TOKEN}`);
    const old = fake(() => ({ status: 404, json: { error: "not found" } }));
    expect(await old.api.collabTicket("doc-1")).toEqual({ kind: "failed", status: 404 });
  });

  it("writes the room's text over a newer stored version once, and not at all when it already matches", async () => {
    let version = 3;
    let content = "theirs";
    const puts: number[] = [];
    const api = {
      async saveDoc({ baseVersion, content: next }: { id: string; name: string; content: string; baseVersion: number }) {
        puts.push(baseVersion);
        if (baseVersion !== version) throw Object.assign(new ApiError(409, "conflict", "conflict"), {});
        version += 1;
        content = next;
        return { id: "d", version };
      },
      async doc() { return { version, content }; },
    };
    expect(await saveLiveSnapshot(api, { id: "d", name: "d.md", content: "room", version: 2 })).toBe(4);
    expect(puts).toEqual([2, 3]);
    expect(content).toBe("room");
    expect(await saveLiveSnapshot(api, { id: "d", name: "d.md", content: "room", version: 1 })).toBe(4);
    expect(puts).toEqual([2, 3, 1]);
  });
});

describe("sharing", () => {
  it("lists members and invitations, and shares, re-roles and removes through the desktop's routes", async () => {
    const { api, calls } = fake((req) => {
      if (req.method === "GET") return { json: { shares: [
        { user_id: "u2", role: "editor", email: "ana@example.com", name: "Ana" },
        { user_id: null, role: "viewer", email: "sam@example.com", name: null, pending: true },
        { user_id: "bad id!", role: "owner", email: "x@example.com" },
      ] } };
      if (req.method === "POST") return { json: { ok: true, status: "invited" } };
      return { json: { ok: true } };
    });
    expect(await api.shares("doc-1")).toEqual([
      { userId: "u2", email: "ana@example.com", name: "Ana", role: "editor", pending: false },
      { userId: null, email: "sam@example.com", name: null, role: "viewer", pending: true },
    ]);
    expect(await api.addShare("doc-1", " Sam@Example.com ", "viewer")).toBe("invited");
    expect(calls[1]).toMatchObject({ method: "POST", url: `${ORIGIN}/api/docs/doc-1/shares`, body: { email: "sam@example.com", role: "viewer" } });
    await api.removeShare("doc-1", "sam@example.com");
    expect(calls[2]).toMatchObject({ method: "DELETE", url: `${ORIGIN}/api/docs/doc-1/shares/sam%40example.com` });
    await expect(api.addShare("doc-1", "not an email", "viewer")).rejects.toThrow(/email/);
  });

  it("reads, makes and removes the public link only when asked, and ignores anything that isn't one", async () => {
    const url = `https://markiedocs.com/s/${"a".repeat(43)}`;
    const { api, calls } = fake((req) => (req.method === "DELETE" ? { json: { ok: true } } : { json: { url: req.method === "GET" ? null : url } }));
    expect(await api.publicLink("doc-1")).toBeNull();
    expect(await api.createPublicLink("doc-1")).toBe(url);
    await api.revokePublicLink("doc-1");
    expect(calls.map((c) => `${c.method} ${c.url.replace(ORIGIN, "")}`)).toEqual([
      "GET /api/docs/doc-1/public-link", "POST /api/docs/doc-1/public-link", "DELETE /api/docs/doc-1/public-link",
    ]);
    const odd = fake(() => ({ json: { url: "javascript:alert(1)" } }));
    expect(await odd.api.publicLink("doc-1")).toBeNull();
  });
});

describe("comments", () => {
  it("reads threads defensively and posts, replies, resolves and deletes on the desktop's routes", async () => {
    const { api, calls } = fake((req) => req.method === "GET"
      ? { json: { threads: [{ id: "t1", anchor: { from: 1, to: 2 }, status: "resolved", created_by: "u1", created_at: "2026-11-03T10:00:00Z", comments: [{ id: "c1", author_id: "u1", author_name: "Kirby\u0007", author_email: "k@example.com", body: "Hi", created_at: "2026-11-03T10:00:00Z" }, { id: 7 }] }, { nope: true }] } }
      : { json: { id: "t2" } });
    const threads = await api.threads("doc-1");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "t1", status: "resolved", comments: [{ id: "c1", authorName: "Kirby", body: "Hi" }] });
    expect(await api.createThread("doc-1", { from: 1, to: 2 }, "  Look here  ")).toBe("t2");
    expect(calls[1].body).toEqual({ anchor: { from: 1, to: 2 }, body: "Look here" });
    await api.reply("doc-1", "t1", "Yes");
    await api.setThreadStatus("doc-1", "t1", "open");
    await api.deleteComment("doc-1", "t1", "c1");
    expect(calls.slice(2).map((c) => `${c.method} ${c.url.replace(ORIGIN, "")}`)).toEqual([
      "POST /api/docs/doc-1/threads/t1/comments", "POST /api/docs/doc-1/threads/t1/status", "DELETE /api/docs/doc-1/threads/t1/comments/c1",
    ]);
    await expect(api.createThread("doc-1", {}, "   ")).rejects.toThrow(/comment/);
  });
});

describe("the document platform", () => {
  it("reaches only the platform's own routes on the signed-in server", async () => {
    const { transport, calls } = fake(() => ({ json: { documents: [] } }));
    const request = platformFetch(transport, ORIGIN);
    const res = await request(`${ORIGIN}/api/document-platform/documents`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Other": "no" } });
    expect(await res.json()).toEqual({ documents: [] });
    expect(calls[0].headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    await expect(request(`${ORIGIN}/api/docs/recent`)).rejects.toThrow(TypeError);
    await expect(request("https://evil.example/api/document-platform/documents")).rejects.toThrow(TypeError);
  });

  it("lists Word, RTF and OpenDocument files as Recent rows, and nothing malformed", () => {
    const row = parsePlatformItem({ id: "p1", name: "Memo.docx", format: "docx", role: "owner", version: 1, updatedAt: 1_762_000_000_000, createdAt: 1_761_000_000_000 });
    expect(row).toMatchObject({ id: "p1", store: "platform", kind: "docx", shared: false, role: "owner" });
    expect(parsePlatformItem({ id: "p2", name: "x.exe", format: "exe", role: "owner", updatedAt: 1 })).toBeNull();
    expect(parsePlatformItem({ id: "p3", name: "x.odt", format: "odt", role: "admin", updatedAt: 1 })).toBeNull();
    expect(parsePlatformList({ documents: [{ id: "p4", name: "a.rtf", format: "rtf", role: "viewer", updatedAt: 5 }] })[0]).toMatchObject({ kind: "rtf", shared: true });
  });

  it("answers an empty list from a server without the platform", async () => {
    const { api } = fake(() => ({ status: 404, json: { error: "not found" } }));
    expect(await api.platformRecent()).toEqual([]);
  });
});

describe("new documents", () => {
  it("offers every format the desktop's chooser offers", () => {
    expect(NEW_DOC_TYPES.map((t) => t.id)).toEqual(NEW_DOCUMENT_TYPES.map((t) => t.format));
    expect(NEW_DOC_TYPES.map((t) => t.extension)).toEqual(NEW_DOCUMENT_TYPES.map((t) => t.extension));
  });

  it("keeps a Word, RTF or OpenDocument file in its own format whatever is typed", () => {
    expect(newDocName("Memo", newDocType("docx"))).toBe("Memo.docx");
    expect(newDocName("Memo.txt", newDocType("rtf"))).toBe("Memo.txt.rtf");
    expect(newDocName("Memo.odt", newDocType("odt"))).toBe("Memo.odt");
    expect(newDocType("nope").id).toBe("markdown");
  });
});

describe("Recent by type", () => {
  const row = (id: string, name: string, extra: Partial<RecentDoc> = {}): RecentDoc => ({
    id, store: "docs", kind: kindFromName(name, "markdown"), name, format: "markdown", createdAt: null, updatedAt: `2026-11-0${id.length}T10:00:00.000Z`,
    origin: { kind: "app", agent: null }, shared: false, role: "owner", sharedBy: null, privateLink: "", ...extra,
  });
  const docs = [
    row("a", "Plan.md"),
    row("bb", "notes.txt", { format: "text", kind: "text" }),
    row("ccc", "config.yaml", { format: "text", kind: kindFromName("config.yaml", "text") }),
    row("dddd", "Memo.docx", { store: "platform", kind: "docx" }),
    row("eeeee", "Counter.wd", { format: "darkmown", kind: "darkmown" }),
  ];

  it("files each document under one type", () => {
    expect(docs.map(docTypeGroup)).toEqual(["markdown", "text", "data", "word", "darkmown"]);
  });

  it("filters by type together with search and the shared filter", () => {
    expect(filterRecent(docs, "", "all", "word").map((d) => d.id)).toEqual(["dddd"]);
    expect(filterRecent(docs, "plan", "all", "markdown").map((d) => d.id)).toEqual(["a"]);
    expect(filterRecent(docs, "plan", "all", "text")).toEqual([]);
  });

  it("keeps a platform file and a Markdown file with the same id apart", () => {
    const merged = mergeRecent([row("x", "a.md")], [row("x", "a.docx", { store: "platform", kind: "docx" })]);
    expect(merged).toHaveLength(2);
    expect(withPlatform(merged, []).map((d) => d.store)).toEqual(["docs"]);
  });
});
