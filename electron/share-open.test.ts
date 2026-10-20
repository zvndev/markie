import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

// share-open.js reaches share-origin.js through CJS require(); loading both the
// same way is what makes setTrustedOrigins below the one it reads.
const load = createRequire(import.meta.url);
const { planShareOpen, fetchSharedDoc } = load("./share-open.js");
const { DEFAULT_SERVER, setTrustedOrigins, isAllowedServerOrigin } = load("./share-origin.js");

afterEach(() => setTrustedOrigins(null));

const link = (src?: string) =>
  `markie://open?token=tok123${src === undefined ? "" : `&src=${encodeURIComponent(src)}`}`;

function okFetch(body = "# Hello") {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-disposition": 'attachment; filename="hello.md"' }),
    text: async () => body,
  }));
}

describe("planShareOpen", () => {
  it("fetches from the default server when the link names no server", () => {
    expect(planShareOpen(link())).toEqual({ action: "fetch", base: DEFAULT_SERVER, token: "tok123" });
  });

  it("fetches straight from a server the user added", () => {
    setTrustedOrigins(() => [DEFAULT_SERVER, "https://docs.example.com"]);
    expect(planShareOpen(link("https://docs.example.com"))).toMatchObject({
      action: "fetch",
      base: "https://docs.example.com",
    });
  });

  it("asks first about a server the user has not added", () => {
    expect(planShareOpen(link("https://docs.example.com"))).toEqual({
      action: "confirm",
      origin: "https://docs.example.com",
      host: "docs.example.com",
      token: "tok123",
    });
  });

  it("keeps falling back to the default for junk and internal addresses", () => {
    for (const src of ["http://docs.example.com", "169.254.169.254", "https://intranet", "::::"]) {
      expect(planShareOpen(link(src))).toMatchObject({ action: "fetch", base: DEFAULT_SERVER });
    }
  });

  it("ignores a link without a token", () => {
    expect(planShareOpen("markie://open?src=https://docs.example.com")).toEqual({ action: "ignore" });
    expect(planShareOpen("not a url")).toEqual({ action: "ignore" });
  });
});

describe("opening a link from a server the user has not added", () => {
  it("fetches nothing until the user confirms", async () => {
    const fetchImpl = okFetch();
    let release: (yes: boolean) => void = () => {};
    const confirm = vi.fn(() => new Promise<boolean>((r) => (release = r)));

    const pending = fetchSharedDoc(link("https://docs.example.com"), { confirm, fetchImpl });
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledWith({ origin: "https://docs.example.com", host: "docs.example.com" });
    expect(fetchImpl).not.toHaveBeenCalled();

    release(true);
    const result = await pending;
    expect(result).toMatchObject({ status: "ok", content: "# Hello", origin: "https://docs.example.com", untrusted: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches nothing at all when the user says no", async () => {
    const fetchImpl = okFetch();
    const result = await fetchSharedDoc(link("https://docs.example.com"), { confirm: async () => false, fetchImpl });
    expect(result).toEqual({ status: "declined", origin: "https://docs.example.com" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a missing confirm as no", async () => {
    const fetchImpl = okFetch();
    const result = await fetchSharedDoc(link("https://docs.example.com"), { fetchImpl });
    expect(result.status).toBe("declined");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches the public share anonymously, without following redirects", async () => {
    const fetchImpl = okFetch();
    await fetchSharedDoc(link("https://docs.example.com"), { confirm: async () => true, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://docs.example.com/s/tok123/raw");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization|cookie/i);
  });

  it("does not add the server to the trusted list by opening a document from it", async () => {
    await fetchSharedDoc(link("https://docs.example.com"), { confirm: async () => true, fetchImpl: okFetch() });
    expect(isAllowedServerOrigin("https://docs.example.com")).toBe(false);
  });

  it("refuses an answer over the size cap", async () => {
    const fetchImpl = okFetch("x".repeat(50));
    await expect(
      fetchSharedDoc(link("https://docs.example.com"), { confirm: async () => true, fetchImpl, maxBytes: 10 })
    ).rejects.toThrow(/too large/);
  });
});

describe("opening a link from a trusted server", () => {
  it("never asks", async () => {
    const confirm = vi.fn(async () => true);
    const fetchImpl = okFetch();
    const result = await fetchSharedDoc(link(), { confirm, fetchImpl });
    expect(confirm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ok", origin: DEFAULT_SERVER, untrusted: false });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${DEFAULT_SERVER}/s/tok123/raw`);
  });

  it("throws on an HTTP failure so the caller can say the link expired", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), text: async () => "" }));
    await expect(fetchSharedDoc(link(), { fetchImpl })).rejects.toThrow("HTTP 404");
  });
});
