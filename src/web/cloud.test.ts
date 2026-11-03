// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The web app's cloud calls: both stores in one list, versioned saves that
// report a conflict instead of writing over it, and the routes it promises
// other parts of the server.

type Cloud = typeof import("./cloud");
let cloud: Cloud;

beforeEach(async () => {
  vi.resetModules();
  const client = await import("@/lib/auth-client");
  client.startWebSession("https://docs.example.test", "tok_abcdefghijklmnop");
  cloud = await import("./cloud");
});

function respond(routes: Record<string, (init: RequestInit) => { status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url.replace("https://docs.example.test", "")}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const { status, body } = route(init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("listing", () => {
  it("lists owned, shared and Office documents together, newest first, with this session", async () => {
    const { fetcher, calls } = respond({
      "GET /api/docs": () => ({ status: 200, body: { docs: [
        { id: "a", name: "Plan.md", version: 3, updated_at: "2026-11-01T10:00:00.000Z", sharedOut: true },
        { id: "b", name: "Their notes.txt", version: 1, updated_at: "2026-11-02T10:00:00.000Z", shared: true, role: "editor", shared_by: "Bob" },
        { id: "../x", name: "bad" },
      ] } }),
      "GET /api/document-platform/documents": () => ({ status: 200, body: { documents: [] } }),
    });
    const { docs, errors } = await cloud.listCloudDocuments(fetcher);
    expect(errors).toEqual([]);
    expect(docs.map((d) => [d.id, d.store, d.format, d.role, d.sharedBy, d.sharedOut])).toEqual([
      ["b", "docs", "text", "editor", "Bob", false],
      ["a", "docs", "markdown", "owner", null, true],
    ]);
    expect(calls.every((call) => (call.init.headers as Record<string, string>).Authorization === "Bearer tok_abcdefghijklmnop")).toBe(true);
  });

  it("still lists text documents when the Office store fails, and says so", async () => {
    const { fetcher } = respond({
      "GET /api/docs": () => ({ status: 200, body: { docs: [{ id: "a", name: "A.md", version: 1, updated_at: "2026-11-01T10:00:00.000Z" }] } }),
      "GET /api/document-platform/documents": () => ({ status: 500, body: { error: "storage-error" } }),
    });
    const { docs, errors } = await cloud.listCloudDocuments(fetcher);
    expect(docs).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("ends the session on a 401", async () => {
    const { fetcher } = respond({ "GET /api/docs": () => ({ status: 401, body: { error: "unauthorized" } }) });
    await expect(cloud.listCloudDocuments(fetcher)).rejects.toBeInstanceOf(cloud.SessionEndedError);
  });
});

describe("saving", () => {
  it("names the version it started from and returns the new one", async () => {
    const { fetcher, calls } = respond({ "PUT /api/docs/doc-1": () => ({ status: 200, body: { id: "doc-1", version: 5 } }) });
    expect(await cloud.saveTextDoc({ id: "doc-1", name: "A.md", content: "hi", baseVersion: 4 }, fetcher)).toEqual({ version: 5 });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ name: "A.md", content: "hi", baseVersion: 4 });
    expect(body.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports someone else's newer version as a conflict, never retrying over it", async () => {
    const put = vi.fn(() => ({ status: 409, body: { error: "conflict", serverVersion: 7 } }));
    const { fetcher } = respond({ "PUT /api/docs/doc-1": put });
    const failure = await cloud.saveTextDoc({ id: "doc-1", name: "A.md", content: "mine", baseVersion: 4 }, fetcher).catch((e) => e);
    expect(failure).toBeInstanceOf(cloud.CloudConflictError);
    expect(failure.serverVersion).toBe(7);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("explains a viewer's refused save", async () => {
    const { fetcher } = respond({ "PUT /api/docs/doc-1": () => ({ status: 403, body: { error: "forbidden" } }) });
    await expect(cloud.saveTextDoc({ id: "doc-1", name: "A.md", content: "x", baseVersion: 1 }, fetcher)).rejects.toThrow(/hasn't let you edit/);
  });
});

describe("opening", () => {
  it("opens a text document, and answers null when the store has no such id", async () => {
    const { fetcher } = respond({ "GET /api/docs/doc-1": () => ({ status: 200, body: { doc: { id: "doc-1", name: "A.wd", content: "x", version: 2, role: "viewer" } } }) });
    expect(await cloud.openTextDoc("doc-1", fetcher)).toEqual({ store: "docs", id: "doc-1", name: "A.wd", content: "x", version: 2, role: "viewer" });
    expect(await cloud.openTextDoc("doc-2", fetcher)).toBeNull();
    expect(await cloud.openTextDoc("../etc", fetcher)).toBeNull();
  });
});

describe("names and editors", () => {
  it("keeps a document's type when it is renamed", () => {
    expect(cloud.renamedDocName("Plan.md", "Launch")).toBe("Launch.md");
    expect(cloud.renamedDocName("Plan.md", "Launch.markdown")).toBe("Launch.markdown");
    expect(cloud.renamedDocName("Memo.docx", "Q3/memo")).toBe("Q3 memo.docx");
    expect(cloud.renamedDocName("Plan.md", "   ")).toBeNull();
  });
  it("routes each format to the desktop editor that handles it", () => {
    expect(["a.md", "a.wd", "a.txt", "a.csv", "a.docx", "a.rtf", "a.odt", "a.doc", "a.html"].map(cloud.editorKindFor))
      .toEqual(["markdown", "darkmown", "text", "text", "office", "office", "office", "unsupported", "unsupported"]);
  });
});

describe("routes", () => {
  it("parses and prints the three web app pages", async () => {
    const { parseWebRoute, webRoutePath, signInHref } = await import("./routes");
    expect(parseWebRoute("/app")).toEqual({ page: "library", create: false });
    expect(parseWebRoute("/app/new")).toEqual({ page: "library", create: true });
    expect(parseWebRoute("/app/d/doc-1")).toEqual({ page: "doc", id: "doc-1" });
    expect(parseWebRoute("/app/d/a%2Fb")).toEqual({ page: "library", create: false });
    expect(webRoutePath({ page: "doc", id: "doc-1" })).toBe("/app/d/doc-1");
    expect(signInHref({ page: "library", create: true }, "https://api.markiedocs.com")).toBe("https://api.markiedocs.com/auth/web-signin?next=%2Fapp%2Fnew");
    expect(signInHref({ page: "doc", id: "d1" }, "http://localhost:8787/")).toBe("http://localhost:8787/auth/web-signin?next=%2Fapp%2Fd%2Fd1");
  });
});
