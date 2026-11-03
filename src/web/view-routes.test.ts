// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseViewRoute, parseWebRoute, viewRoutePath, viewSignInHref } from "./routes";
import { escapeIsFree, readBarHidden, writeBarHidden } from "./bar-visibility";
import { isLocalMediaSrc, mediaRef, memberAssetUrl, publicAssetUrl, viewHtml, withAssetUrls } from "./view-content";
import { originalFileName, webExportFormats } from "./web-export";
import { viewPathFor } from "./web-root";
import { publicDocMeta, publicKind } from "./doc-view";

const TOKEN = "a".repeat(64);

describe("the read view's routes", () => {
  it("opens /d/<id> and /s/<token> as the view, and nothing else", () => {
    expect(parseViewRoute("/d/doc-1")).toEqual({ kind: "member", id: "doc-1" });
    expect(parseViewRoute("/d/doc-1/")).toEqual({ kind: "member", id: "doc-1" });
    expect(parseViewRoute(`/s/${TOKEN}`)).toEqual({ kind: "public", token: TOKEN });
    for (const path of ["/app", "/app/d/doc-1", "/d/", "/d/a b", "/d/x/raw", `/s/${TOKEN}/raw`, "/s/short", "/", "/download"]) {
      expect(parseViewRoute(path), path).toBeNull();
    }
    // The app's own routes are untouched by the view's.
    expect(parseWebRoute("/d/doc-1")).toEqual({ page: "library", create: false });
  });

  it("round-trips a route to its path", () => {
    expect(viewRoutePath({ kind: "member", id: "doc-1" })).toBe("/d/doc-1");
    expect(viewRoutePath({ kind: "public", token: TOKEN })).toBe(`/s/${TOKEN}`);
  });

  it("signs in on the API origin and comes back to the same document", () => {
    expect(viewSignInHref("doc-1", "https://api.example.test/")).toBe("https://api.example.test/auth/web-signin?next=%2Fd%2Fdoc-1");
    expect(viewSignInHref("doc-1", "https://api.example.test", { switchAccount: true })).toBe("https://api.example.test/auth/web-signin?next=%2Fd%2Fdoc-1&switch=1");
  });

  it("goes back from the editor to the view it came from, or the document's own", () => {
    const pub = { kind: "public", token: TOKEN } as const;
    expect(viewPathFor("doc-1", pub, "doc-1")).toBe(`/s/${TOKEN}`);
    expect(viewPathFor("doc-2", pub, "doc-1")).toBe("/d/doc-2");
    expect(viewPathFor("doc-1", null, null)).toBe("/d/doc-1");
  });
});

describe("the bar's remembered choice", () => {
  it("is kept per surface, and survives a storage that refuses", () => {
    localStorage.clear();
    expect(readBarHidden("view")).toBe(false);
    writeBarHidden("view", true);
    expect(readBarHidden("view")).toBe(true);
    expect(readBarHidden("editor")).toBe(false);
    writeBarHidden("view", false);
    expect(readBarHidden("view")).toBe(false);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
    expect(readBarHidden("view", broken)).toBe(false);
    expect(() => writeBarHidden("view", true, broken)).not.toThrow();
  });

  it("takes Escape only when nothing else is using it", () => {
    document.body.innerHTML = '<p id="p">text</p><input id="i"><div contenteditable="true" id="e"></div>';
    const esc = (target: Element, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "target", { value: target });
      return event;
    };
    expect(escapeIsFree(esc(document.getElementById("p")!))).toBe(true);
    expect(escapeIsFree(esc(document.getElementById("i")!))).toBe(false);
    expect(escapeIsFree(esc(document.getElementById("e")!))).toBe(false);
    expect(escapeIsFree(esc(document.getElementById("p")!, { shiftKey: true }))).toBe(false);
    const handled = esc(document.getElementById("p")!);
    handled.preventDefault();
    expect(escapeIsFree(handled)).toBe(false);
    document.body.insertAdjacentHTML("beforeend", '<div role="menu"></div>');
    expect(escapeIsFree(esc(document.getElementById("p")!))).toBe(false);
    document.body.innerHTML = '<p id="p"></p><div data-markie-lightbox></div>';
    expect(escapeIsFree(esc(document.getElementById("p")!))).toBe(false);
  });
});

describe("what the view draws", () => {
  it("points a document's own pictures at its asset route, and leaves URLs alone", () => {
    expect(isLocalMediaSrc("shots/a.png")).toBe(true);
    for (const src of ["https://x.test/a.png", "data:image/png;base64,AA", "//x.test/a.png", "#top", ""]) expect(isLocalMediaSrc(src)).toBe(false);
    expect(mediaRef("shots/a%20b.png?x=1#y")).toBe("shots/a b.png");
    const html = withAssetUrls('<p><img src="shots/a%20b.png" alt="A"><img src="https://x.test/b.png"></p>', memberAssetUrl("https://api.test", "doc-1"));
    expect(html).toContain('src="https://api.test/d/doc-1/assets?ref=shots%2Fa%20b.png"');
    expect(html).toContain('src="https://x.test/b.png"');
    expect(publicAssetUrl("https://api.test", TOKEN)("a.png")).toBe(`https://api.test/s/${TOKEN}/assets?ref=a.png`);
  });

  it("renders markdown sanitized and plain text escaped", () => {
    const md = viewHtml("markdown", "# Hi\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n", null);
    expect(md).toContain("<h1>Hi</h1>");
    expect(md).not.toMatch(/<script|onerror/);
    expect(viewHtml("text", "<b>not bold</b>", null)).toBe('<pre class="markie-view-text">&lt;b&gt;not bold&lt;/b&gt;</pre>');
  });

  it("reads a public page's name and format from the shell, and draws each format as itself", () => {
    document.head.innerHTML = '<meta name="markie-doc-name" content="Counter.wd"><meta name="markie-doc-format" content="darkmown">';
    expect(publicDocMeta(document)).toEqual({ name: "Counter.wd", format: "darkmown" });
    document.head.innerHTML = "";
    expect(publicDocMeta(document)).toEqual({ name: "Shared document", format: "markdown" });
    expect(publicKind("darkmown")).toBe("darkmown");
    expect(publicKind("text")).toBe("text");
    expect(publicKind("markdown")).toBe("markdown");
    expect(publicKind("anything")).toBe("markdown");
  });
});

describe("export on the web", () => {
  it("offers every converted format but the document's own", () => {
    expect(webExportFormats("markdown", "a.md").map((f) => f.id)).toEqual(["docx", "rtf", "odt", "txt"]);
    expect(webExportFormats("text", "a.txt").map((f) => f.id)).toEqual(["docx", "rtf", "odt", "md"]);
    expect(webExportFormats("office", "a.docx").map((f) => f.id)).toEqual(["rtf", "odt", "md"]);
    expect(webExportFormats("darkmown", "a.wd")).toEqual([]);
  });

  it("names the original download after the document", () => {
    expect(originalFileName("Notes.md", "markdown")).toBe("Notes.md");
    expect(originalFileName("Notes", "markdown")).toBe("Notes.md");
    expect(originalFileName("Counter", "darkmown")).toBe("Counter.wd");
    expect(originalFileName("", "text")).toBe("document.txt");
  });
});
