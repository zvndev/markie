import { describe, expect, it } from "vitest";
import { classifyDeepLink, cloudDocId, sourceHint } from "./deep-links.js";

describe("markie:// deep link routing", () => {
  it("sends a shared document invite to the account-credentialed opener", () => {
    expect(classifyDeepLink("markie://doc?id=abc123")).toBe("cloud-doc");
  });

  it("sends a public link to the token-credentialed opener", () => {
    expect(classifyDeepLink("markie://open?token=t&src=https://markiedocs.com")).toBe(
      "shared-token"
    );
  });

  it("leaves sign-in to the renderer", () => {
    expect(classifyDeepLink("markie://auth?token=t&state=deadbeef")).toBe("renderer");
  });

  // The two document links differ in where their authority comes from, so
  // routing one to the other's handler would either drop a document on the
  // floor or fetch it with the wrong credentials.
  it("does not confuse the two document links for each other", () => {
    expect(classifyDeepLink("markie://doc?id=abc")).not.toBe(
      classifyDeepLink("markie://open?token=abc")
    );
  });

  it("ignores anything that is not a markie link", () => {
    for (const link of [
      "https://markiedocs.com/d/abc",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "",
      // A scheme that merely starts the same way is not ours.
      "markiez://doc?id=abc",
    ]) {
      expect(classifyDeepLink(link)).toBe("ignore");
    }
  });

  it("ignores non-strings rather than throwing at OS hand-off", () => {
    for (const junk of [null, undefined, 42, {}]) {
      expect(classifyDeepLink(junk as unknown as string)).toBe("ignore");
    }
  });
});

describe("reading a shared document link", () => {
  it("takes the document id", () => {
    expect(cloudDocId("markie://doc?id=doc_42")).toBe("doc_42");
  });

  it("decodes an id that needed escaping", () => {
    expect(cloudDocId("markie://doc?id=a%2Fb%20c")).toBe("a/b c");
  });

  it("returns null when there is no id to act on", () => {
    expect(cloudDocId("markie://doc")).toBeNull();
    expect(cloudDocId("markie://doc?id=")).toBeNull();
  });

  // Refusing an id from the wrong kind of link is what stops a public-link
  // token from being replayed as an account-credentialed fetch.
  it("refuses to read an id out of any other link", () => {
    expect(cloudDocId("markie://open?id=doc_42&token=t")).toBeNull();
    expect(cloudDocId("markie://auth?id=doc_42")).toBeNull();
    expect(cloudDocId("https://evil.example/?id=doc_42")).toBeNull();
  });

  // The OS hands these over verbatim, so anything that throws here takes the
  // hand-off with it. A broken escape decodes to a replacement character
  // rather than throwing, and a broken id simply fails to match a document.
  it("survives a malformed url instead of throwing", () => {
    for (const link of ["markie://doc?id=%E0%A4%A", "markie://doc?%", "markie://doc?id=#"]) {
      expect(() => cloudDocId(link)).not.toThrow();
      expect(() => sourceHint(link)).not.toThrow();
    }
    expect(sourceHint("markie://doc?%")).toBeNull();
  });

  it("reads the source hint used to pick an allowlisted server", () => {
    expect(sourceHint("markie://doc?id=x&src=https://markiedocs.com")).toBe(
      "https://markiedocs.com"
    );
    expect(sourceHint("markie://doc?id=x")).toBeNull();
  });
});
