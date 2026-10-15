import { describe, expect, it, vi } from "vitest";
import { DocumentCloudClient } from "./document-cloud";

describe("explicit multi-format cloud client", () => {
  it("does not allow insecure remote token transport or invalid identities", () => {
    expect(() => new DocumentCloudClient({ baseUrl: "http://remote.test", token: "secret" })).toThrow(/HTTPS/);
    expect(() => new DocumentCloudClient({ baseUrl: "https://markie.test", token: "" })).toThrow(/Sign in/);
  });
  it("uploads an owned byte snapshot with its format and digest", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ document: { ...body, id: "document-id", version: 1 } });
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
  it("keeps conflicts, unsupported servers and bad hashes explicit", async () => {
    const identity = { baseUrl: "http://127.0.0.1:8787", token: "session" };
    await expect(new DocumentCloudClient(identity, vi.fn(async () => Response.json({ serverVersion: 4 }, { status: 409 }))).call("/documents/doc", "PUT", {})).rejects.toMatchObject({ status: 409, serverVersion: 4 });
    await expect(new DocumentCloudClient(identity, vi.fn(async () => new Response("not found", { status: 404 }))).call("/documents")).rejects.toThrow(/not provide/);
    await expect(new DocumentCloudClient(identity).decode({ id: "doc", name: "x.txt", format: "text", version: 1, encoding: "base64", data: btoa("x"), sha256: "0".repeat(64) })).rejects.toThrow(/integrity/);
  });
  it("never accepts active/unsupported formats as cloud documents", async () => {
    const request = vi.fn();
    const client = new DocumentCloudClient({ baseUrl: "https://markie.test", token: "session" }, request);
    await expect(client.upload({ name: "content.html", bytes: new TextEncoder().encode("<script>bad</script>") })).rejects.toThrow(/format/);
    expect(request).not.toHaveBeenCalled();
    await expect(client.call("/documents/../auth")).rejects.toThrow(/Invalid/);
  });
});
