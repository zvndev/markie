// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDocTheme,
  pullCloudThemes,
  pushCloudThemes,
  setDocTheme,
} from "./theme-sync";

const TOKEN_KEY = "markie.token.v1";
const SERVER_KEY = "markie.server.v1";
const STORE_KEY = "markie.themes.v1";
const SERVER = "https://api.test";

function mockFetch(impl: (url: string, init: RequestInit) => unknown) {
  const fn = vi.fn(async (url: unknown, init: unknown) =>
    impl(String(url), (init ?? {}) as RequestInit)
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SERVER_KEY, SERVER);
  localStorage.setItem(TOKEN_KEY, "tok-123");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("pullCloudThemes", () => {
  it("returns the store and persists it locally", async () => {
    const store = { activeId: "sunset", custom: [{ id: "sunset" }] };
    const fetchMock = mockFetch(() => json({ store }));

    await expect(pullCloudThemes()).resolves.toEqual(store);
    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVER}/api/me/themes`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer tok-123" }),
      })
    );
    expect(JSON.parse(localStorage.getItem(STORE_KEY)!)).toEqual(store);
  });

  it("returns false when signed in with nothing stored yet", async () => {
    mockFetch(() => json({ store: null }));
    await expect(pullCloudThemes()).resolves.toBe(false);
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it("returns null when signed out — and never calls the server", async () => {
    localStorage.removeItem(TOKEN_KEY);
    const fetchMock = mockFetch(() => json({ store: {} }));
    await expect(pullCloudThemes()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a non-OK response", async () => {
    mockFetch(() => json({ store: {} }, false));
    await expect(pullCloudThemes()).resolves.toBeNull();
  });

  it("returns null when the network throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    await expect(pullCloudThemes()).resolves.toBeNull();
  });
});

describe("pushCloudThemes", () => {
  it("PUTs the local store", async () => {
    const store = { activeId: "markie-light", custom: [] };
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    const fetchMock = mockFetch(() => json({ ok: true }));

    pushCloudThemes();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SERVER}/api/me/themes`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ store });
  });

  it("does not throw when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    expect(() => pushCloudThemes()).not.toThrow();
  });
});

describe("doc themes", () => {
  it("getDocTheme returns the pinned tokens and encodes the doc id", async () => {
    const tokens = { background: "#000" };
    const fetchMock = mockFetch(() => json({ tokens }));
    await expect(getDocTheme("doc/1 2")).resolves.toEqual(tokens);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${SERVER}/api/docs/doc%2F1%202/theme`
    );
  });

  it("getDocTheme returns null when nothing is pinned", async () => {
    mockFetch(() => json({ tokens: null }));
    await expect(getDocTheme("doc1")).resolves.toBeNull();
  });

  it("setDocTheme reports success and sends the tokens", async () => {
    const fetchMock = mockFetch(() => json({ ok: true }));
    await expect(setDocTheme("doc1", { background: "#fff" } as never)).resolves.toBe(true);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ tokens: { background: "#fff" } });
  });

  it("setDocTheme unpins with a null token payload", async () => {
    const fetchMock = mockFetch(() => json({ ok: true }));
    await expect(setDocTheme("doc1", null)).resolves.toBe(true);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ tokens: null });
  });

  it("setDocTheme reports failure when the server rejects", async () => {
    mockFetch(() => json({ ok: false }, false));
    await expect(setDocTheme("doc1", null)).resolves.toBe(false);
  });
});
