// @vitest-environment jsdom
// How the desktop reads a cloud .wd's hosted Live Doc address
// (server/src/live-docs.ts). Anything but a well-formed web address from the
// server's own route is no address at all.
import { describe, expect, it, vi } from "vitest";
import { makeSharesClient, type ApiRequest } from "./auth-client";

function serverAnswering(status: number, data: unknown) {
  const request = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, data }));
  return { client: makeSharesClient(request as unknown as ApiRequest), request };
}

describe("liveDocAddress", () => {
  it("asks the document's live-doc route and hands back its address", async () => {
    const { client, request } = serverAnswering(200, { url: "https://abcdefghijklmnop.markie.live/", access: "private" });
    expect(await client.liveDocAddress("doc/1")).toEqual({ url: "https://abcdefghijklmnop.markie.live/", access: "private", publicUrl: null, publishedAs: null, network: [] });
    expect(request).toHaveBeenCalledWith("/api/docs/doc%2F1/live-doc");
  });

  it("hands the owner the public address too, while the public link is on", async () => {
    const { client } = serverAnswering(200, { url: "https://abcdefghijklmnop.markie.live/", access: "public", publicUrl: "https://qrstuvwxyz234567.markie.live/", publishedAs: "Olive Owner", network: ["https://api.example.com", "http://evil.example", "javascript:x", 7] });
    expect(await client.liveDocAddress("d")).toEqual({ url: "https://abcdefghijklmnop.markie.live/", access: "public", publicUrl: "https://qrstuvwxyz234567.markie.live/", publishedAs: "Olive Owner", network: ["https://api.example.com"] });
  });

  it("drops a public address that is not a web address, and an access level it does not know", async () => {
    const { client } = serverAnswering(200, { url: "https://abcdefghijklmnop.markie.live/", access: "everyone", publicUrl: "javascript:alert(1)", publishedAs: "x" });
    expect(await client.liveDocAddress("d")).toEqual({ url: "https://abcdefghijklmnop.markie.live/", access: "private", publicUrl: null, publishedAs: null, network: [] });
  });

  it("keeps an explicit null network as unknown, and reads a missing one as empty", async () => {
    expect((await serverAnswering(200, { url: "https://abcdefghijklmnop.markie.live/", access: "private", network: null }).client.liveDocAddress("d"))?.network).toBeNull();
    expect((await serverAnswering(200, { url: "https://abcdefghijklmnop.markie.live/", access: "private" }).client.liveDocAddress("d"))?.network).toEqual([]);
  });

  it("accepts a loopback address for local development", async () => {
    expect((await serverAnswering(200, { url: "http://abcdefghijklmnop.localhost:8787/" }).client.liveDocAddress("d"))?.url).toBe("http://abcdefghijklmnop.localhost:8787/");
  });

  it("reads every refusal, and anything that is not a web address, as no address", async () => {
    for (const [status, data] of [
      [404, { error: "not found" }],
      [404, { error: "not_a_live_doc" }],
      [401, { error: "unauthorized" }],
      [200, { url: 42 }],
      [200, { url: "javascript:alert(1)" }],
      [200, { url: "http://abcdefghijklmnop.markie.live/" }],
      [200, { url: "not a url" }],
      [200, null],
    ] as const) {
      expect(await serverAnswering(status, data).client.liveDocAddress("d"), JSON.stringify(data)).toBeNull();
    }
  });
});
