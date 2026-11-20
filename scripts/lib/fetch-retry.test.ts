import { describe, expect, it, vi } from "vitest";
import { createRetryingFetch, isRetryableFetchError } from "./fetch-retry.mjs";

const dropped = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
const noWait = { log: () => {}, sleep: async () => {} };

describe("createRetryingFetch", () => {
  it("retries a socket the server already closed, then returns the response", async () => {
    const response = new Response("ok", { status: 200 });
    const base = vi.fn().mockRejectedValueOnce(dropped()).mockResolvedValueOnce(response);
    const fetch = createRetryingFetch(base, noWait);

    await expect(fetch("https://example.test/a", { method: "HEAD" })).resolves.toBe(response);
    expect(base).toHaveBeenCalledTimes(2);
    expect(base).toHaveBeenLastCalledWith("https://example.test/a", { method: "HEAD" });
  });

  it("returns an error status as it is, without retrying", async () => {
    const response = new Response("busy", { status: 503 });
    const base = vi.fn().mockResolvedValue(response);
    const fetch = createRetryingFetch(base, noWait);

    await expect(fetch("https://example.test/b")).resolves.toBe(response);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error that is not a dropped connection", async () => {
    const error = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const base = vi.fn().mockRejectedValue(error);
    const fetch = createRetryingFetch(base, noWait);

    await expect(fetch("https://example.test/c")).rejects.toBe(error);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt and throws the drop", async () => {
    const base = vi.fn().mockRejectedValue(dropped());
    const fetch = createRetryingFetch(base, { ...noWait, attempts: 3 });

    await expect(fetch("https://example.test/d")).rejects.toThrow("fetch failed");
    expect(base).toHaveBeenCalledTimes(3);
  });
});

describe("isRetryableFetchError", () => {
  it("knows the codes a dropped keep-alive socket throws", () => {
    for (const code of ["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE"]) {
      expect(isRetryableFetchError({ cause: { code } })).toBe(true);
    }
    expect(isRetryableFetchError({ cause: { code: "ENOTFOUND" } })).toBe(false);
    expect(isRetryableFetchError(undefined)).toBe(false);
  });
});
