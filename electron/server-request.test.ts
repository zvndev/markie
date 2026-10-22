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
    const res = await serverRequest({ origin: SELF, path: "/api/me", token: "tok" }, { fetchImpl, storedToken: "tok" });
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

describe("the path a request may take", () => {
  const { checkedPath } = load("./server-request.js");

  it("keeps an API path and its query as the parser makes them", () => {
    expect(checkedPath(SELF, "/api/docs/abc/shares?x=1&y=2")).toBe("/api/docs/abc/shares?x=1&y=2");
    expect(checkedPath(SELF, "/auth/sign-in/email")).toBe("/auth/sign-in/email");
    expect(checkedPath(SELF, "/api/./me")).toBe("/api/me");
  });

  it("refuses a percent-encoded dot, slash or backslash in any case", () => {
    for (const p of [
      "/api/%2e%2e/admin",
      "/api/%2E%2E/admin",
      "/api/.%2e/admin",
      "/api/%2fadmin",
      "/api/%2Fadmin",
      "/api/%5cadmin",
      "/api/%5Cadmin",
      "/api/docs?next=%2e%2e",
    ]) {
      expect(checkedPath(SELF, p), p).toBeNull();
    }
  });

  it("refuses anything whose normalized path leaves the API routes", () => {
    for (const p of ["/api/../admin", "/api/./../admin", "/admin", "//evil.example/api/me", "/api\\..\\admin", "/api/me#x", "api/me", ""]) {
      expect(checkedPath(SELF, p), p).toBeNull();
    }
  });
});

describe("the token a request carries", () => {
  it("sends main's stored token for the origin when the renderer names that same token", async () => {
    const fetchImpl = replying(() => new Response("{}"));
    await serverRequest({ origin: SELF, path: "/api/me", token: "self-token" }, { fetchImpl, storedToken: "self-token" });
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer self-token");
  });

  it("refuses a token that is not the one stored for this origin, sending nothing", async () => {
    const fetchImpl = replying(() => new Response("{}"));
    // Markie Cloud's token, named for another server.
    const res = await serverRequest({ origin: SELF, path: "/api/me", token: "cloud-token" }, { fetchImpl, storedToken: "self-token" });
    expect(res).toMatchObject({ ok: false, status: 0, error: "That sign-in isn't this server's." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses any token for an origin main holds none for", async () => {
    const fetchImpl = replying(() => new Response("{}"));
    const res = await serverRequest({ origin: SELF, path: "/api/me", token: "anything" }, { fetchImpl, storedToken: null });
    expect(res).toMatchObject({ ok: false, status: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends no token when the renderer asks for none, as a sign-in does", async () => {
    const fetchImpl = replying(() => new Response("{}"));
    await serverRequest({ origin: SELF, path: "/api/auth/sign-in/email", method: "POST", body: "{}" }, { fetchImpl, storedToken: "self-token" });
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
