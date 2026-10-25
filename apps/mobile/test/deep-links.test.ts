import { describe, expect, it } from "vitest";
import {
  appLinkFor,
  classifyDocumentLink,
  hasPendingLink,
  parseMarkieLink,
  rememberPendingLink,
  resolveForSession,
  takePendingLink,
} from "../src/lib/deep-links";

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

describe("pending links", () => {
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
