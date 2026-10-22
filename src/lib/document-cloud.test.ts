import { describe, expect, it, vi } from "vitest";
import { DocumentCloudClient } from "./document-cloud";
import { createHash } from "node:crypto";

describe("explicit multi-format cloud client", () => {
  const row = { schemaVersion: 2, id: "cloud-id", name: "note.docx", format: "docx", role: "viewer", version: 2, sha256: "0".repeat(64), createdAt: 1, updatedAt: 2, byteLength: 10 };
  it("lists bounded typed metadata with only a GET and forwards cancellation", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ documents: [{ ...row, data: "not retained" }] }));
    const controller = new AbortController();
    const list = await new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request).list(controller.signal);
    expect(list).toEqual([row]);
    expect(request).toHaveBeenCalledWith("https://markie.test/api/document-platform/documents", expect.objectContaining({ method: "GET", signal: controller.signal, cache: "no-store" }));
    expect(request.mock.calls[0][1]?.body).toBeUndefined();
  });
  it("refuses malformed, oversized, duplicate, private and permissionless metadata", async () => {
    for (const documents of [null, [row, row], Array(1001).fill(row), [{ ...row, role: "admin" }], [{ ...row, role: undefined }], [{ ...row, name: "copy.txt" }], [{ ...row, name: "secret.vault" }], [{ ...row, byteLength: 16777217 }], [{ ...row, updatedAt: -1 }], [{ ...row, format: "html" }], [{ ...row, version: 0 }]]) {
      const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, vi.fn(async () => Response.json({ documents })));
      await expect(client.list()).rejects.toThrow(/metadata|list|identities/);
    }
  });
  it.each([{ name: "copy.txt", format: "docx", role: "owner" }, { name: "copy.docx", format: "text", role: "editor" }, { name: "copy.txt", format: "text", role: undefined }, { name: "copy.txt", format: "text", role: "writer" }])("rejects invalid GET snapshot metadata ($name, $format, $role) before exposing bytes", async (fields) => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ document: { ...row, ...fields, encoding: "base64", data: btoa("valid UTF8 bytes"), sha256: createHash("sha256").update("valid UTF8 bytes").digest("hex") } }));
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request);
    const response = await client.call("/documents/cloud-id");
    await expect(client.decode(response.document)).rejects.toThrow(/metadata/);
    expect(request.mock.calls[0][1]?.method).toBe("GET");
  });
  it("does not allow insecure remote token transport or invalid identities", () => {
    expect(() => new DocumentCloudClient({ baseUrl: "http://remote.test", token: "secret" })).toThrow(/HTTPS/);
    expect(() => new DocumentCloudClient({ baseUrl: "https://markie.test", token: "" })).toThrow(/Sign in/);
  });
  it("uploads an owned byte snapshot with its format and digest", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ document: { ...body, id: "document-id", version: 1, role: "owner" } });
    });
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request);
    const bytes = new TextEncoder().encode("# original");
    const pending = client.upload({ name: "note.md", bytes });
    bytes.fill(0);
    const document = await pending;
    expect(document.data).toBe(btoa("# original"));
    expect(request.mock.calls[0][0]).toBe("https://markie.test/api/document-platform/documents");
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer session" });
  });
  it.each([["memo.rtf", "rtf"], ["report.odt", "odt"], ["counter.wd", "darkmown"]])("uploads a %s snapshot as %s", async (name, format) => {
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ document: { ...body, id: "document-id", version: 1, role: "owner" } });
    });
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request);
    const document = await client.upload({ name, bytes: new TextEncoder().encode("snapshot bytes") });
    expect(document.format).toBe(format);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).format).toBe(format);
  });
  it("requires the selected new-copy area in the acknowledgment and never retries a denied destination", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => Response.json({ document: { ...JSON.parse(String(init?.body)), id: "document-id", version: 1, role: "owner" } }));
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request), file = { name: "note.txt", bytes: new TextEncoder().encode("original") };
    expect((await client.upload(file, undefined, undefined, "work")).areaId).toBe("work");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).areaId).toBe("work");
    request.mockResolvedValueOnce(Response.json({ error: "forbidden-area" }, { status: 403 }));
    await expect(client.upload(file, undefined, undefined, "foreign")).rejects.toThrow("permission"); expect(request).toHaveBeenCalledTimes(2);
    request.mockImplementationOnce(async (_url, init) => { const body = JSON.parse(String(init?.body)); delete body.areaId; return Response.json({ document: { ...body, id: "document-id", version: 1, role: "owner" } }); });
    await expect(client.upload(file, undefined, undefined, "work")).rejects.toThrow("acknowledgment"); expect(request).toHaveBeenCalledTimes(3);
    await expect(client.upload(file, { id: "document-id", version: 1 }, undefined, "work")).rejects.toThrow("Existing snapshots keep");
  });
  it.each(["id", "version", "name", "format", "bytes", "digest", "role", "missing-role"])("rejects a PUT acknowledgment with unrelated %s", async (mismatch) => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const document = { ...body, id: "document-id", version: 3, role: "editor" };
      if (mismatch === "id") document.id = "unrelated-id";
      if (mismatch === "version") document.version = 2;
      if (mismatch === "name") document.name = "other.md";
      if (mismatch === "format") document.format = "text";
      if (mismatch === "bytes") { document.data = btoa("unrelated self-consistent bytes"); document.sha256 = createHash("sha256").update("unrelated self-consistent bytes").digest("hex"); }
      if (mismatch === "digest") document.sha256 = "0".repeat(64);
      if (mismatch === "role") document.role = "viewer";
      if (mismatch === "missing-role") delete document.role;
      return Response.json({ document });
    });
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request);
    await expect(client.upload({ name: "note.md", bytes: new TextEncoder().encode("# submitted") }, { id: "document-id", version: 2 })).rejects.toThrow(/acknowledgment|integrity|metadata/);
  });
  it.each(["owner", "editor"])("accepts the exact next PUT snapshot acknowledged for %s", async (role) => {
    const request = vi.fn<typeof fetch>(async (_url, init) => Response.json({ document: { ...JSON.parse(String(init?.body)), id: "document-id", version: 3, role } }));
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request);
    await expect(client.upload({ name: "note.md", bytes: new TextEncoder().encode("# submitted") }, { id: "document-id", version: 2 })).resolves.toMatchObject({ id: "document-id", version: 3, role });
  });
  it.each([{ role: "editor", version: 1 }, { role: "owner", version: 2 }, { role: undefined, version: 1 }])("requires an owner version-1 acknowledgment for POST ($role, $version)", async (ack) => {
    const request = vi.fn<typeof fetch>(async (_url, init) => Response.json({ document: { ...JSON.parse(String(init?.body)), id: "document-id", ...ack } }));
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request);
    await expect(client.upload({ name: "note.md", bytes: new TextEncoder().encode("# submitted") })).rejects.toThrow(/acknowledgment|metadata/);
  });
  it("keeps conflicts, unsupported servers and bad hashes explicit", async () => {
    const identity = { baseUrl: "http://127.0.0.1:8787", token: "session" };
    await expect(new DocumentCloudClient(identity, vi.fn(async () => Response.json({ serverVersion: 4 }, { status: 409 }))).call("/documents/doc", "PUT", {})).rejects.toMatchObject({ status: 409, serverVersion: 4 });
    await expect(new DocumentCloudClient(identity, vi.fn(async () => new Response("not found", { status: 404 }))).call("/documents")).rejects.toThrow(/not provide/);
    await expect(new DocumentCloudClient(identity).decode({ id: "doc", name: "x.txt", format: "text", role: "viewer", version: 1, encoding: "base64", data: btoa("x"), sha256: "0".repeat(64) })).rejects.toThrow(/integrity/);
  });
  it("never accepts active/unsupported formats as cloud documents", async () => {
    const request = vi.fn();
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request);
    await expect(client.upload({ name: "content.html", bytes: new TextEncoder().encode("<script>bad</script>") })).rejects.toThrow(/format/);
    expect(request).not.toHaveBeenCalled();
    await expect(client.call("/documents/../auth")).rejects.toThrow(/Invalid/);
  });
});
