import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nativeRequestHeaders } from "../src/lib/native-http";
import { bytesFromBase64 } from "../src/lib/http";
import config from "../capacitor.config";

describe("native requests", () => {
  it("ask every cache on the way not to store the answer", () => {
    expect(nativeRequestHeaders({ method: "GET", url: "https://x/api/docs/a" })["cache-control"]).toBe("no-store");
    expect(nativeRequestHeaders({ method: "POST", url: "https://x/api/auth/sign-in/email-otp", body: {} })).toMatchObject({ "cache-control": "no-store", "content-type": "application/json" });
    expect(nativeRequestHeaders({ method: "GET", url: "https://x/a.png", responseType: "binary", headers: { authorization: "Bearer t" } })).toMatchObject({ "cache-control": "no-store", accept: "image/*", authorization: "Bearer t" });
  });

  it("decode a binary answer", () => {
    expect(Array.from(bytesFromBase64("iVBORw=="))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("the native shells", () => {
  it("log no plugin calls, so a session never reaches a device log", () => {
    expect(config.loggingBehavior).toBe("none");
  });

  it("give URLSession a cache with no room in it, before the page loads (iOS)", () => {
    const swift = readFileSync(new URL("../ios/App/App/MarkieBridgeViewController.swift", import.meta.url), "utf8");
    const didLoad = /override func capacitorDidLoad\(\) \{([\s\S]*?)super\.capacitorDidLoad\(\)/.exec(swift)?.[1] ?? "";
    expect(didLoad).toContain("URLCache.shared.removeAllCachedResponses()");
    expect(didLoad).toContain("URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, directory: nil)");
  });
});
