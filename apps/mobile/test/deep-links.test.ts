import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_SCHEME,
  CLAIMED_HOSTS,
  appLinkFor,
  classifyDocumentLink,
  hasPendingLink,
  isMarkieWebLink,
  parseMarkieLink,
  peekPendingLink,
  rememberPendingLink,
  resolveForSession,
  signedOutDestination,
  takePendingLink,
} from "../src/lib/deep-links";
import { ApiError } from "../src/lib/api";
import { publicLinkErrorCopy } from "../src/lib/public-link";

const CLOUD = "https://api.markiedocs.com";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

describe("parseMarkieLink", () => {
  it.each([
    ["https://api.markiedocs.com/d/abc-123", { kind: "doc", id: "abc-123", origin: CLOUD }],
    ["https://markiedocs.com/d/abc-123/", { kind: "doc", id: "abc-123", origin: CLOUD }],
    ["https://markiedocs.com/d/abc-123?k=invite-token", { kind: "doc", id: "abc-123", origin: CLOUD }],
    ["https://api.markiedocs.com/s/pub_aaaaaaaaaaaaaaaaaaaa", { kind: "public", token: "pub_aaaaaaaaaaaaaaaaaaaa", origin: CLOUD }],
    ["markie-mobile://d/abc-123", { kind: "doc", id: "abc-123", origin: null }],
    ["markie-mobile:///d/abc-123", { kind: "doc", id: "abc-123", origin: null }],
    ["markie-mobile://s/pub_aaaaaaaaaaaaaaaaaaaa", { kind: "public", token: "pub_aaaaaaaaaaaaaaaaaaaa", origin: null }],
  ])("opens %s", (url, expected) => {
    expect(parseMarkieLink(url)).toEqual(expected);
  });

  it.each([
    "https://api.markiedocs.com/download",
    "https://api.markiedocs.com/d/abc/raw",
    "https://api.markiedocs.com/d/",
    "https://api.markiedocs.com:444/d/abc",
    "http://api.markiedocs.com/d/abc",
    "https://evil.example/d/abc",
    "https://api.markiedocs.com.evil.example/d/abc",
    "https://user:pass@api.markiedocs.com/d/abc",
    "https://api.markiedocs.com/d/..%2F..%2Fapi%2Fme",
    "https://api.markiedocs.com/d/" + "a".repeat(65),
    "https://api.markiedocs.com/s/short",
    "markie://d/abc",
    "markie-mobile://x/abc",
    "javascript:alert(1)",
    "not a url",
  ])("ignores %s", (url) => {
    expect(parseMarkieLink(url)).toBeNull();
  });

  it("claims /d and /s on the signed-in self-hosted server, and nowhere else", () => {
    expect(parseMarkieLink("https://markie.example.com/d/abc", "https://markie.example.com")).toEqual({ kind: "doc", id: "abc", origin: "https://markie.example.com" });
    expect(parseMarkieLink("https://markie.example.com/d/abc")).toBeNull();
    expect(parseMarkieLink("http://localhost:8790/d/abc", "http://localhost:8790")).toEqual({ kind: "doc", id: "abc", origin: "http://localhost:8790" });
  });
});

describe("resolveForSession", () => {
  it("pins a scheme link to the signed-in server", () => {
    expect(resolveForSession({ kind: "doc", id: "a", origin: null }, "https://markie.example.com"))
      .toEqual({ ok: true, target: { kind: "doc", id: "a", origin: "https://markie.example.com" } });
  });

  it("opens Markie Cloud links for a Markie Cloud session", () => {
    expect(resolveForSession({ kind: "doc", id: "a", origin: CLOUD }, CLOUD)).toMatchObject({ ok: true });
  });

  it("never offers a token to another server", () => {
    const result = resolveForSession({ kind: "doc", id: "a", origin: CLOUD }, "https://markie.example.com");
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toContain("Markie Cloud");
  });
});

describe("links with nobody signed in", () => {
  const TOKEN = "pub_aaaaaaaaaaaaaaaaaaaa";

  it.each([
    [`https://markiedocs.com/s/${TOKEN}`, CLOUD],
    [`https://api.markiedocs.com/s/${TOKEN}`, CLOUD],
    [`https://www.markiedocs.com/s/${TOKEN}`, CLOUD],
  ])("opens the public share %s to read, on Markie Cloud", (url, origin) => {
    // Whatever server the sign-in screen is set to, a Markie Cloud link reads from Markie Cloud.
    expect(signedOutDestination(parseMarkieLink(url)!, "https://markie.example.com")).toEqual({ kind: "public", token: TOKEN, origin });
  });

  it("opens a markie-mobile://s link on the server the sign-in screen is set to", () => {
    const target = parseMarkieLink(`markie-mobile://s/${TOKEN}`)!;
    expect(signedOutDestination(target, CLOUD)).toEqual({ kind: "public", token: TOKEN, origin: CLOUD });
    expect(signedOutDestination(target, "http://localhost:8790")).toEqual({ kind: "public", token: TOKEN, origin: "http://localhost:8790" });
  });

  it.each([
    "https://markiedocs.com/d/abc-123",
    "https://api.markiedocs.com/d/abc-123",
    "https://markiedocs.com/d/abc-123?k=invite-token",
    "markie-mobile://d/abc-123",
  ])("keeps the private document %s behind sign-in", (url) => {
    expect(signedOutDestination(parseMarkieLink(url)!, CLOUD)).toBeNull();
  });

  it("leaves /download to the browser, signed in or not", () => {
    for (const url of ["https://markiedocs.com/download", "https://api.markiedocs.com/download", "https://markiedocs.com/download/mac"]) {
      expect(parseMarkieLink(url)).toBeNull();
      expect(isMarkieWebLink(url)).toBe(true);
    }
  });

  it("never treats a path under a share as the share", () => {
    expect(parseMarkieLink(`https://markiedocs.com/s/${TOKEN}/raw`)).toBeNull();
    expect(parseMarkieLink(`https://markiedocs.com/s/${TOKEN}/assets?ref=a.png`)).toBeNull();
  });

  it("says a dead public link is off, without talking about an account's access", () => {
    const off = publicLinkErrorCopy(new ApiError(404, "This share link was turned off, or never existed."));
    expect(off).toMatchObject({ title: "This link is off", retry: false });
    expect(off.body).not.toContain("this account");
    expect(publicLinkErrorCopy(new ApiError(0, "Check your connection and try again."))).toMatchObject({ title: "You're offline", retry: true });
    expect(publicLinkErrorCopy(new ApiError(500, "Server error"))).toMatchObject({ retry: true });
  });
});

describe("pending links", () => {
  it("can be looked at without being used up", () => {
    const storage = memoryStorage();
    rememberPendingLink({ kind: "public", token: "pub_aaaaaaaaaaaaaaaaaaaa", origin: CLOUD }, storage, 1_000);
    expect(peekPendingLink(storage, 2_000)).toEqual({ kind: "public", token: "pub_aaaaaaaaaaaaaaaaaaaa", origin: CLOUD });
    expect(peekPendingLink(storage, 2_000)).not.toBeNull();
    expect(peekPendingLink(storage, 2 * 60 * 60 * 1000)).toBeNull();
    expect(takePendingLink(storage, 2_000)).toMatchObject({ kind: "public" });
    expect(peekPendingLink(storage, 2_000)).toBeNull();
  });

  it("remembers a link tapped before sign-in, once", () => {
    const storage = memoryStorage();
    rememberPendingLink({ kind: "doc", id: "abc", origin: CLOUD }, storage, 1_000);
    expect(hasPendingLink(storage)).toBe(true);
    expect(takePendingLink(storage, 2_000)).toEqual({ kind: "doc", id: "abc", origin: CLOUD });
    expect(takePendingLink(storage, 2_000)).toBeNull();
    expect(hasPendingLink(storage)).toBe(false);
  });

  it("keeps a scheme link's origin open, so it resolves to whichever server signs in", () => {
    const storage = memoryStorage();
    rememberPendingLink({ kind: "public", token: "pub_aaaaaaaaaaaaaaaaaaaa", origin: null }, storage, 1_000);
    expect(takePendingLink(storage, 1_500)).toEqual({ kind: "public", token: "pub_aaaaaaaaaaaaaaaaaaaa", origin: null });
  });

  it("drops a stale or tampered entry", () => {
    const storage = memoryStorage();
    rememberPendingLink({ kind: "doc", id: "abc", origin: CLOUD }, storage, 0);
    expect(takePendingLink(storage, 2 * 60 * 60 * 1000)).toBeNull();
    storage.setItem("markie.mobile.pending-link.v1", JSON.stringify({ link: "https://evil.example/d/x", origin: null, at: 0 }));
    expect(takePendingLink(storage, 1)).toBeNull();
    storage.setItem("markie.mobile.pending-link.v1", JSON.stringify({ link: "markie-mobile://d/x", origin: "javascript:alert(1)//", at: 0 }));
    expect(takePendingLink(storage, 1)).toBeNull();
    storage.setItem("markie.mobile.pending-link.v1", "{not json");
    expect(takePendingLink(storage, 1)).toBeNull();
  });

  it("round-trips through the app scheme", () => {
    expect(appLinkFor({ kind: "doc", id: "abc", origin: CLOUD })).toBe("markie-mobile://d/abc");
    expect(parseMarkieLink(appLinkFor({ kind: "public", token: "pub_aaaaaaaaaaaaaaaaaaaa", origin: null }))).toMatchObject({ kind: "public" });
  });
});

describe("links inside a document", () => {
  const related = new Map([["Counter.wd", "counter-wd"]]);

  it("opens Markie documents in the app", () => {
    expect(classifyDocumentLink("https://api.markiedocs.com/d/abc", CLOUD)).toEqual({ kind: "markie", target: { kind: "doc", id: "abc", origin: CLOUD } });
    expect(classifyDocumentLink("Counter.wd", CLOUD, related)).toEqual({ kind: "related", id: "counter-wd" });
  });

  it("sends the web to the browser and mail to the system", () => {
    expect(classifyDocumentLink("https://example.com/a?b=c", CLOUD)).toEqual({ kind: "external", url: "https://example.com/a?b=c" });
    expect(classifyDocumentLink("mailto:team@example.com", CLOUD)).toEqual({ kind: "system", url: "mailto:team@example.com" });
  });

  it("scrolls to anchors and refuses everything else", () => {
    expect(classifyDocumentLink("#user-content-fn-1", CLOUD)).toEqual({ kind: "anchor", id: "user-content-fn-1" });
    expect(classifyDocumentLink("javascript:alert(1)", CLOUD)).toEqual({ kind: "none" });
    expect(classifyDocumentLink("file:///etc/passwd", CLOUD)).toEqual({ kind: "none" });
    expect(classifyDocumentLink("notes/other.md", CLOUD)).toEqual({ kind: "none" });
    expect(classifyDocumentLink(null, CLOUD)).toEqual({ kind: "none" });
  });
});

describe("URLs other apps send", () => {
  it("passes on only Markie's own web links, never an arbitrary URL", () => {
    expect(isMarkieWebLink("https://api.markiedocs.com/d/abc/raw")).toBe(true);
    expect(isMarkieWebLink("https://markiedocs.com/download")).toBe(true);
    expect(isMarkieWebLink("https://markie.example.com/d/abc/raw", "https://markie.example.com")).toBe(true);
    expect(isMarkieWebLink("https://evil.example/phish")).toBe(false);
    expect(isMarkieWebLink("https://markie.example.com/x")).toBe(false);
    expect(isMarkieWebLink("https://api.markiedocs.com.evil.example/d/abc")).toBe(false);
    expect(isMarkieWebLink("https://user:pw@api.markiedocs.com/d/abc/raw")).toBe(false);
    expect(isMarkieWebLink("http://api.markiedocs.com/d/abc/raw")).toBe(false);
    expect(isMarkieWebLink("javascript:alert(1)")).toBe(false);
  });
});

// What the two systems are told to hand the app, checked against the router
// and against the files the server publishes for them. A host or path claimed
// natively but not routed here would open the app on a link it then refuses.
describe("the links iOS and Android hand over", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const manifest = read("../android/app/src/main/AndroidManifest.xml");
  const wellKnown = read("../../../server/src/well-known.ts");
  const verified = /<intent-filter android:autoVerify="true">([\s\S]*?)<\/intent-filter>/.exec(manifest)?.[1] ?? "";
  const attrs = (block: string, name: string) => [...block.matchAll(new RegExp(`android:${name}="([^"]+)"`, "g"))].map((match) => match[1]);

  it("Android verifies https links to /d/ and /s/ on the two hosts that serve assetlinks.json, and nothing else", () => {
    expect(attrs(verified, "scheme")).toEqual(["https"]);
    // Not www: it redirects, and Android's verifier refuses a redirect.
    expect(attrs(verified, "host")).toEqual(["api.markiedocs.com", "markiedocs.com"]);
    expect(attrs(verified, "pathPrefix")).toEqual(["/d/", "/s/"]);
    for (const host of attrs(verified, "host")) expect(CLAIMED_HOSTS).toContain(host);
    expect(manifest).not.toContain("/download");
  });

  it("iOS claims the same two hosts", () => {
    const entitlements = read("../ios/App/App/App.entitlements");
    expect([...entitlements.matchAll(/<string>applinks:([^<]+)<\/string>/g)].map((match) => match[1])).toEqual(attrs(verified, "host"));
  });

  it("the server's files name this app and the same paths", () => {
    const appId = /applicationId "([^"]+)"/.exec(read("../android/app/build.gradle"))?.[1];
    expect(appId).toBe("com.zvn.markie.mobile");
    expect(wellKnown).toContain(`MOBILE_APP_ID = "${appId}"`);
    expect(wellKnown).toContain('{ "/": "/d/*" }');
    expect(wellKnown).toContain('{ "/": "/s/*" }');
    expect(wellKnown).not.toContain("/download");
  });

  it("the custom scheme takes d and s only", () => {
    const scheme = /<string name="custom_url_scheme">([^<]+)<\/string>/.exec(read("../android/app/src/main/res/values/strings.xml"))?.[1];
    expect(scheme).toBe(APP_SCHEME);
    const block = manifest.split("<intent-filter").find((part) => part.includes("@string/custom_url_scheme")) ?? "";
    expect(attrs(block, "host")).toEqual(["d", "s"]);
  });
});
