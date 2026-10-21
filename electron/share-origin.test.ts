import { describe, it, expect, afterEach } from "vitest";
import {
  shareBaseFromSrc,
  isAllowedServerOrigin,
  untrustedShareOrigin,
  setTrustedOrigins,
  isLoopbackHostname,
  isTrustedOrigin,
  isCloudOrigin,
  canonicalCloudOrigin,
  CLOUD_ALIASES,
  DEFAULT_SERVER,
} from "./share-origin.js";

const CLOUD = "https://api.markiedocs.com";
const RAILWAY = "https://api-production-602f.up.railway.app";

afterEach(() => setTrustedOrigins(null));

describe("shareBaseFromSrc", () => {
  it("returns the allowlisted production origin when src matches", () => {
    expect(shareBaseFromSrc(CLOUD)).toBe(CLOUD);
  });
  it("reads Markie Cloud's old Railway address as Markie Cloud", () => {
    expect(shareBaseFromSrc(RAILWAY)).toBe(CLOUD);
    expect(shareBaseFromSrc("api-production-602f.up.railway.app")).toBe(CLOUD);
    expect(shareBaseFromSrc(`${RAILWAY}/`)).toBe(CLOUD);
  });
  it("falls back to DEFAULT_SERVER for an attacker host (no SSRF)", () => {
    expect(shareBaseFromSrc("evil.com")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("169.254.169.254")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("http://api-production-602f.up.railway.app")).toBe(DEFAULT_SERVER); // not https
    expect(shareBaseFromSrc("https://api-production-602f.up.railway.app.evil.com")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("http://api.markiedocs.com")).toBe(DEFAULT_SERVER); // not https
    expect(shareBaseFromSrc("https://api.markiedocs.com.evil.com")).toBe(DEFAULT_SERVER);
  });
  it("falls back to DEFAULT_SERVER for empty/garbage src", () => {
    expect(shareBaseFromSrc("")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("::::")).toBe(DEFAULT_SERVER);
  });
  it("allows localhost only in dev mode", () => {
    expect(shareBaseFromSrc("http://localhost:8787", { allowDev: true })).toBe("http://localhost:8787");
    expect(shareBaseFromSrc("http://localhost:8787")).toBe(DEFAULT_SERVER);
  });
});

describe("isAllowedServerOrigin", () => {
  it("accepts the production origin, rejects others", () => {
    expect(isAllowedServerOrigin(CLOUD)).toBe(true);
    expect(isAllowedServerOrigin(RAILWAY)).toBe(true);
    expect(isAllowedServerOrigin("http://api.markiedocs.com")).toBe(false);
    expect(isAllowedServerOrigin("https://evil.com")).toBe(false);
    expect(isAllowedServerOrigin("http://api-production-602f.up.railway.app")).toBe(false);
    expect(isAllowedServerOrigin(null as unknown as string)).toBe(false);
  });
  it("accepts localhost only in dev", () => {
    expect(isAllowedServerOrigin("http://localhost:8787", { allowDev: true })).toBe(true);
    expect(isAllowedServerOrigin("http://localhost:8787")).toBe(false);
  });
});

describe("the trusted list replaces the pinned host", () => {
  const SELF = "https://docs.example.com";

  it("trusts an added server by exact origin, for tokens and share fetches", () => {
    expect(isAllowedServerOrigin(SELF)).toBe(false);
    setTrustedOrigins(() => [DEFAULT_SERVER, SELF]);
    expect(isAllowedServerOrigin(SELF)).toBe(true);
    expect(isAllowedServerOrigin(`${SELF}/`)).toBe(true);
    expect(shareBaseFromSrc(SELF)).toBe(SELF);
    // Not the same origin: another port, plain http, a lookalike host.
    expect(isAllowedServerOrigin("https://docs.example.com:8443")).toBe(false);
    expect(isAllowedServerOrigin("http://docs.example.com")).toBe(false);
    expect(isAllowedServerOrigin("https://docs.example.com.evil.com")).toBe(false);
    expect(shareBaseFromSrc("https://docs.example.com.evil.com")).toBe(DEFAULT_SERVER);
  });

  it("never sends a token to a URL carrying credentials, even for a trusted host", () => {
    setTrustedOrigins(() => [DEFAULT_SERVER, SELF]);
    expect(isAllowedServerOrigin("https://u:p@docs.example.com")).toBe(false);
    expect(shareBaseFromSrc("https://u:p@docs.example.com")).toBe(DEFAULT_SERVER);
  });

  it("always trusts the default server, whatever the provider says", () => {
    setTrustedOrigins(() => []);
    expect(isAllowedServerOrigin(DEFAULT_SERVER)).toBe(true);
    setTrustedOrigins(() => {
      throw new Error("broken");
    });
    expect(isAllowedServerOrigin(DEFAULT_SERVER)).toBe(true);
    expect(isAllowedServerOrigin(SELF)).toBe(false);
  });
});

describe("untrustedShareOrigin", () => {
  it("names a public https origin the user has not added", () => {
    expect(untrustedShareOrigin("https://docs.example.com")).toBe("https://docs.example.com");
    expect(untrustedShareOrigin("docs.example.com")).toBe("https://docs.example.com");
  });

  it("is null for a trusted origin, which needs no question", () => {
    expect(untrustedShareOrigin(DEFAULT_SERVER)).toBeNull();
    setTrustedOrigins(() => [DEFAULT_SERVER, "https://docs.example.com"]);
    expect(untrustedShareOrigin("https://docs.example.com")).toBeNull();
  });

  it("is null for anything that is not a clean public https origin", () => {
    expect(untrustedShareOrigin("")).toBeNull();
    expect(untrustedShareOrigin(null as unknown as string)).toBeNull();
    expect(untrustedShareOrigin("http://docs.example.com")).toBeNull();
    expect(untrustedShareOrigin("https://u:p@docs.example.com")).toBeNull();
    expect(untrustedShareOrigin("169.254.169.254")).toBeNull();
    expect(untrustedShareOrigin("https://10.0.0.5")).toBeNull();
    expect(untrustedShareOrigin("https://[::1]")).toBeNull();
    expect(untrustedShareOrigin("https://intranet")).toBeNull();
    expect(untrustedShareOrigin("https://printer.local")).toBeNull();
    expect(untrustedShareOrigin("https://localhost:8787")).toBeNull();
  });
});

describe("isLoopbackHostname", () => {
  const host = (address: string) => new URL(address).hostname;

  it("is true for this computer in every form the URL parser leaves", () => {
    for (const address of [
      "https://localhost",
      "https://localhost.",
      "https://x.localhost",
      "https://127.0.0.1",
      "https://127.9.9.9",
      "https://0.0.0.0",
      "https://[::1]",
      "https://[::]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:0:0]",
      "https://[::7f00:1]",
      "https://[::ffff:0:7f00:1]",
    ]) {
      expect(isLoopbackHostname(host(address)), address).toBe(true);
    }
  });

  it("is false for every other address", () => {
    for (const address of [
      "https://docs.example.com",
      "https://localhost.example.com",
      "https://10.0.0.1",
      "https://128.0.0.1",
      "https://[::2]",
      "https://[::ffff:a00:1]",
      "https://[2001:db8::1]",
      "https://[fe80::1]",
    ]) {
      expect(isLoopbackHostname(host(address)), address).toBe(false);
    }
    expect(isLoopbackHostname("")).toBe(false);
  });
});

describe("Markie Cloud's address and its old one", () => {
  it("names api.markiedocs.com as Markie Cloud, with the Railway host as an alias", () => {
    expect(DEFAULT_SERVER).toBe(CLOUD);
    expect(CLOUD_ALIASES).toEqual([RAILWAY]);
  });

  it("recognises both, exactly", () => {
    expect(isCloudOrigin(CLOUD)).toBe(true);
    expect(isCloudOrigin(RAILWAY)).toBe(true);
    expect(isCloudOrigin("http://api-production-602f.up.railway.app")).toBe(false);
    expect(isCloudOrigin("https://other-production-602f.up.railway.app")).toBe(false);
    expect(isCloudOrigin(null)).toBe(false);
  });

  it("maps only an alias to the canonical origin", () => {
    expect(canonicalCloudOrigin(RAILWAY)).toBe(CLOUD);
    expect(canonicalCloudOrigin(`${RAILWAY}/`)).toBe(CLOUD);
    expect(canonicalCloudOrigin(CLOUD)).toBe(CLOUD);
    expect(canonicalCloudOrigin("https://docs.example.com")).toBe("https://docs.example.com");
    expect(canonicalCloudOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(canonicalCloudOrigin("not a url")).toBe("not a url");
    expect(canonicalCloudOrigin(null)).toBe(null);
  });

  it("trusts the old address even when the list main hands in names only the new one", () => {
    setTrustedOrigins(() => [CLOUD]);
    expect(isTrustedOrigin(RAILWAY)).toBe(true);
    expect(untrustedShareOrigin(RAILWAY)).toBeNull();
    expect(untrustedShareOrigin("https://api-production-602f.up.railway.app.evil.com")).toBe(
      "https://api-production-602f.up.railway.app.evil.com"
    );
  });
});
