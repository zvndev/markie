import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { serverRequest, MAX_RESPONSE_BYTES } = load("./server-request.js");

const SELF = "https://docs.example.com";

function endless(chunk = 64 * 1024) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      seen.pulled += chunk;
      c.enqueue(new Uint8Array(chunk).fill(32));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

function replying(res: () => Response) {
  return vi.fn(async (_url: string, _init: RequestInit) => res());
}

describe("serverRequest", () => {
  it("sends to the origin's API route with no redirects and reads the JSON back", async () => {
    const fetchImpl = replying(() => new Response(JSON.stringify({ user: { id: "u" } }), { headers: { "set-auth-token": "fresh" } }));
    const res = await serverRequest({ origin: SELF, path: "/api/me", token: "tok" }, { fetchImpl });
    expect(res).toEqual({ ok: true, status: 200, data: { user: { id: "u" } }, setAuthToken: "fresh" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${SELF}/api/me`);
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("stops reading an answer that never ends at the cap, and aborts the request", async () => {
    const { stream, seen } = endless();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(stream);
    });
    const res = await serverRequest({ origin: SELF, path: "/api/docs/x/shares" }, { fetchImpl });
    expect(res).toMatchObject({ ok: false, status: 0, data: null, error: "The server's answer was too large." });
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 2 * 64 * 1024);
    expect(signal?.aborted).toBe(true);
  });

  it("gives up on a server that never answers", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    expect(await serverRequest({ origin: SELF, path: "/api/me" }, { fetchImpl, timeoutMs: 20 })).toEqual({
      ok: false,
      status: 0,
      data: null,
    });
  });

  it("refuses a path outside the API routes without sending anything", async () => {
    const fetchImpl = replying(() => new Response("{}"));
    for (const path of ["/admin", "api/me", "/api/../admin", "https://evil.example/api/me"]) {
      expect(await serverRequest({ origin: SELF, path }, { fetchImpl }), path).toMatchObject({ ok: false, status: 0 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
