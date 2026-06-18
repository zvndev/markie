import { describe, it, expect } from "vitest";
import { shareBaseFromSrc, isAllowedServerOrigin, DEFAULT_SERVER } from "./share-origin.js";

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
