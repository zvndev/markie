import { describe, it, expect, afterEach } from "vitest";
import {
  shareBaseFromSrc,
  isAllowedServerOrigin,
  untrustedShareOrigin,
  setTrustedOrigins,
  DEFAULT_SERVER,
} from "./share-origin.js";

afterEach(() => setTrustedOrigins(null));

describe("shareBaseFromSrc", () => {
  it("returns the allowlisted production origin when src matches", () => {
    expect(shareBaseFromSrc("https://api-production-602f.up.railway.app")).toBe(
      "https://api-production-602f.up.railway.app",
    );
  });
  it("falls back to DEFAULT_SERVER for an attacker host (no SSRF)", () => {
    expect(shareBaseFromSrc("evil.com")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("169.254.169.254")).toBe(DEFAULT_SERVER);
    expect(shareBaseFromSrc("http://api-production-602f.up.railway.app")).toBe(DEFAULT_SERVER); // not https
    expect(shareBaseFromSrc("https://api-production-602f.up.railway.app.evil.com")).toBe(DEFAULT_SERVER);
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
    expect(isAllowedServerOrigin("https://api-production-602f.up.railway.app")).toBe(true);
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
