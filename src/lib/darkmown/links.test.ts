// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { darkmownLinkTarget, darkmownPictureRef, darkmownPictureUrl, isDarkmownPictureBase } from "./links";
import { DARKMOWN_LINK_MESSAGE, darkmownFrameSandbox, darkmownLinkFromMessage } from "./frame";
import { sanitizeDarkmownBody } from "./security";
import { compileDarkmownPreview } from "./preview";
import { DARKMOWN_LINK_BRIDGE_SOURCE } from "./runtime";
import linkBridgePolicy from "../../../electron/darkmown-link-bridge-policy.json";
import runtimePolicy from "../../../electron/darkmown-runtime-policy.json";

vi.mock("./compiler-worker-client", async () => {
  const { compileDarkmown } = await import("./compiler");
  return { compileDarkmownOffThread: async (source: string) => compileDarkmown(source) };
});

const require = createRequire(import.meta.url);
const main = require("../../../electron/darkmown-preview.js") as { darkmownLinkTarget(value: unknown): string | null; relativeRef(value: unknown): string | null };
const BASE = "markie-asset://wd-0123456789abcdef0123456789abcdef";

const LINK_CASES: unknown[] = [
  "https://example.com", "http://example.com/a b", "https://example.com/a?b=1#c", "HTTPS://EXAMPLE.COM/X", "mailto:ada@example.com",
  "mailto:ada@example.com,bo@example.org?subject=Hi&body=Hello%20there", "mailto:?subject=Hi", "mailto:ada@example.com?attach=/etc/passwd",
  "javascript:alert(1)", "JAVASCRIPT:alert(1)", "file:///etc/passwd", "data:text/html,x", "markie://open", "markie-asset://local/x", "ftp://x.y",
  "other.md", "/abs", "../up", "//example.com", "https://u:p@example.com", "https:example.com", "https:\\\\example.com", " https://example.com",
  "java\nscript:alert(1)", "", null, 7, {}, `https://example.com/${"x".repeat(9000)}`, "mailto:", "mailto:x", "mailto:a@b.co#x",
  "mailto:x&attach=/etc/passwd&y@a.co", "mailto:a@b.co?subject=Hi%0D%0ABcc:%20evil@x.co", "mailto:a@b.co?body=one%0D%0Atwo",
];

describe("the renderer's link and picture rules", () => {
  it("agree with main's copy on every link", () => {
    for (const value of LINK_CASES) expect(darkmownLinkTarget(value), String(value)).toBe(main.darkmownLinkTarget(value));
  });

  it("refuse javascript: and file: links", () => {
    expect(darkmownLinkTarget("javascript:alert(document.cookie)")).toBeNull();
    expect(darkmownLinkTarget("file:///Users/me/.ssh/id_rsa")).toBeNull();
  });

  it("refuse a mail draft that hides attach= in its address or a header in its subject, in both copies", () => {
    for (const href of ["mailto:x&attach=/etc/passwd&y@a.co", "mailto:a@b.co?subject=Hi%0D%0ABcc:%20evil@x.co"]) {
      expect(darkmownLinkTarget(href), href).toBeNull();
      expect(main.darkmownLinkTarget(href), href).toBeNull();
    }
  });

  it("keep only pictures inside the document's folder, and agree with main on those", () => {
    for (const ref of ["shot.png", "pics/shot.png", "./pics/My%20Photo.JPG", "pics/shot.png?v=2#top"]) {
      expect(darkmownPictureRef(ref), ref).toBe(ref);
      expect(main.relativeRef(ref), ref).toBe(ref);
    }
    for (const ref of ["../beside.png", "pics/../../beside.png", "%2E%2E/beside.png", "..%2Fbeside.png", "/etc/x.png", "C:/x.png", "C:%5Cx.png", "pics\\x.png",
      "https://example.com/x.png", "//example.com/x.png", "file:///x.png", "data:image/png;base64,AAAA", "markie-asset://local/x.png"]) {
      expect(darkmownPictureRef(ref), ref).toBeNull();
      expect(main.relativeRef(ref), ref).toBeNull();
    }
    expect(darkmownPictureRef("notes.txt")).toBeNull();
    expect(darkmownPictureUrl(BASE, "pics/a b.png")).toBe(`${BASE}/pics%2Fa%20b.png`);
    expect(isDarkmownPictureBase(BASE)).toBe(true);
    for (const value of ["markie-asset://local", "markie-asset:", "https://wd-0123456789abcdef0123456789abcdef", `${BASE}/x`, `${BASE} *`]) expect(isDarkmownPictureBase(value), value).toBe(false);
  });
});

describe("sanitizing links and pictures", () => {
  it("keeps web and mail links as new-window links only when the host opts in", async () => {
    const markup = '<p><a href="https://example.com">site</a> <a href="mailto:ada@example.com">mail</a></p>';
    const off = await sanitizeDarkmownBody(markup, false);
    expect(off.bodyHtml).toBe("<p><a>site</a> <a>mail</a></p>");
    const on = await sanitizeDarkmownBody(markup, false, { links: true });
    expect(on.bodyHtml).toBe('<p><a href="https://example.com/" target="_blank" rel="noopener noreferrer">site</a> <a href="mailto:ada@example.com" target="_blank" rel="noopener noreferrer">mail</a></p>');
    expect(on.warnings).toEqual([]);
  });

  it("drops javascript:, file: and relative links, keeping their text", async () => {
    const result = await sanitizeDarkmownBody('<a href="javascript:alert(1)">a</a><a href="file:///etc/passwd">b</a><a href="other.md">c</a><a href="https://example.com" onclick="x()">d</a>', true, { links: true });
    expect(result.bodyHtml).toBe('<a>a</a><a>b</a><a>c</a><a href="https://example.com/" target="_blank" rel="noopener noreferrer">d</a>');
    expect(result.warnings).toHaveLength(1);
  });

  it("points a picture beside the document into its scope, and nothing else", async () => {
    const result = await sanitizeDarkmownBody('<p><img src="pics/shot.png" alt="A photo" title="Shot" decoding="async" fetchpriority="high"></p>', false, { pictureBase: BASE });
    expect(result.bodyHtml).toBe(`<p><img src="${BASE}/pics%2Fshot.png" alt="A photo" title="Shot"></p>`);
    expect(result.warnings).toEqual([]);
  });

  it("refuses a ../ picture, a remote one and an absolute one", async () => {
    const result = await sanitizeDarkmownBody('<img src="../beside.png"><img src="https://example.com/x.png"><img src="/etc/x.png"><img src="file:///x.png">', true, { pictureBase: BASE });
    expect(result.bodyHtml).toBe("");
    expect(result.warnings).toHaveLength(1);
  });

  it("strips every picture without a scope, and ignores a forged scope", async () => {
    expect((await sanitizeDarkmownBody('<img src="shot.png">', true)).bodyHtml).toBe("");
    expect((await sanitizeDarkmownBody('<img src="shot.png">', true, { pictureBase: "markie-asset:" })).bodyHtml).toBe("");
    expect((await sanitizeDarkmownBody('<img src="shot.png">', true, { pictureBase: "https://evil.test" })).bodyHtml).toBe("");
  });

  it("keeps a checklist, checked state included, trusted or not", async () => {
    const markup = '<ul><li><input type="checkbox" disabled> pack bags</li><li><input type="checkbox" disabled checked> book hotel</li></ul>';
    for (const trusted of [true, false]) {
      const result = await sanitizeDarkmownBody(markup, trusted, { links: true, pictureBase: BASE });
      expect(result.bodyHtml).toMatch(/<li><input type="checkbox" disabled maxlength="10000"> pack bags<\/li>/);
      expect(result.bodyHtml).toMatch(/<li><input type="checkbox" disabled maxlength="10000" checked> book hotel<\/li>/);
      expect(result.warnings).toEqual([]);
    }
  });
});

describe("the preview frame with links and pictures", () => {
  it("pins the link bridge by hash, and the bridge can sit in a script element", () => {
    expect(createHash("sha256").update(DARKMOWN_LINK_BRIDGE_SOURCE).digest("base64")).toBe(linkBridgePolicy.linkBridgeSha256);
    expect(DARKMOWN_LINK_BRIDGE_SOURCE).not.toMatch(/<\/script/i);
  });

  it("runs only the link bridge in an untrusted preview, and loads pictures only from the scope", async () => {
    const result = await compileDarkmownPreview("# Trip\n\n[site](https://example.com)\n\n![A photo](pics/shot.png)\n", false, { links: true, pictureBase: BASE });
    const csp = new DOMParser().parseFromString(result.srcDoc, "text/html").querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(csp).toContain(`script-src 'sha256-${linkBridgePolicy.linkBridgeSha256}';`);
    expect(csp).not.toContain(runtimePolicy.runtimeSha256);
    expect(csp).toContain(`img-src ${BASE};`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|img-src[^;]*(https:|data:|\*)/);
    expect(result.srcDoc).toContain(`<img src="${BASE}/pics%2Fshot.png" alt="A photo">`);
    expect(result.srcDoc).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer">site</a>');
    expect(result.srcDoc.match(/<script>/g)).toHaveLength(1);
  });

  it("adds the bridge beside the interpreter in a trusted preview", async () => {
    const result = await compileDarkmownPreview("[site](https://example.com)\n", true, { links: true });
    expect(result.srcDoc).toContain(`script-src &#39;sha256-${linkBridgePolicy.linkBridgeSha256}&#39; &#39;sha256-${runtimePolicy.runtimeSha256}&#39; &#39;sha256-${runtimePolicy.bootstrapSha256}&#39;`);
    expect(result.srcDoc).toContain("img-src &#39;none&#39;");
  });

  it("changes nothing for a host that does not opt in", async () => {
    const result = await compileDarkmownPreview("[site](https://example.com)\n\n![A](a.png)\n", false);
    expect(result.srcDoc).toContain("script-src &#39;none&#39;");
    expect(result.srcDoc).toContain("img-src &#39;none&#39;");
    expect(result.srcDoc).not.toContain("<script>");
    expect(result.srcDoc).not.toContain("href=");
    expect(result.srcDoc).not.toContain("<img");
  });

  it("gives an untrusted frame scripts only when links are on, and never popups or navigation", () => {
    expect(darkmownFrameSandbox(false)).toBe("");
    expect(darkmownFrameSandbox(false, { links: true })).toBe("allow-scripts");
    expect(darkmownFrameSandbox(true, { links: true })).toBe("allow-scripts");
    expect(darkmownFrameSandbox(true, { links: true })).not.toMatch(/same-origin|forms|popups|top-navigation|modals|downloads/);
  });
});

describe("the link bridge inside the frame", () => {
  function frameWithBridge(body: string) {
    const frame = document.createElement("iframe"); document.body.append(frame);
    const window = frame.contentWindow as Window & typeof globalThis;
    window.document.body.innerHTML = body;
    const post = vi.fn();
    Object.defineProperty(window, "parent", { value: { postMessage: post } });
    window.eval(DARKMOWN_LINK_BRIDGE_SOURCE);
    return { window, post, close: () => frame.remove() };
  }

  it("never lets a link navigate the frame, and ignores a click a script fired", () => {
    const dom = frameWithBridge('<a href="https://example.com/" target="_blank"><b>site</b></a>');
    const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    dom.window.document.querySelector("b")!.dispatchEvent(event);
    expect(event.isTrusted).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(dom.post).not.toHaveBeenCalled();
    (dom.window.document.querySelector("a") as HTMLAnchorElement).click();
    expect(dom.post).not.toHaveBeenCalled();
    dom.close();
  });

  it("leaves clicks that are not on a link alone", () => {
    const dom = frameWithBridge("<button>Add</button>");
    const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
    dom.window.document.querySelector("button")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    dom.close();
  });
});

describe("the host's check on a link message", () => {
  function setup() {
    const frame = document.createElement("iframe"); document.body.append(frame);
    const other = document.createElement("iframe"); document.body.append(other);
    const message = (data: unknown, extra: Partial<MessageEvent> = {}) => ({ source: frame.contentWindow, origin: "null", data, ...extra }) as MessageEvent;
    return { frame, other, message, close: () => { frame.remove(); other.remove(); } };
  }
  const clicked = { isActive: true };

  it("opens a web or mail link from this frame after a click", () => {
    const { frame, message, close } = setup();
    expect(darkmownLinkFromMessage(message({ type: DARKMOWN_LINK_MESSAGE, href: "https://example.com" }), frame, clicked)).toBe("https://example.com/");
    expect(darkmownLinkFromMessage(message({ type: DARKMOWN_LINK_MESSAGE, href: "mailto:ada@example.com" }), frame, clicked)).toBe("mailto:ada@example.com");
    close();
  });

  it("refuses a link fired without a click", () => {
    const { frame, message, close } = setup();
    const data = { type: DARKMOWN_LINK_MESSAGE, href: "https://example.com" };
    expect(darkmownLinkFromMessage(message(data), frame, { isActive: false })).toBeNull();
    expect(darkmownLinkFromMessage(message(data), frame, undefined)).toBeNull();
    expect(darkmownLinkFromMessage(message(data), frame)).toBeNull(); // jsdom has no user activation at all
    close();
  });

  it("refuses javascript: and file: links even after a click", () => {
    const { frame, message, close } = setup();
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "other.md", "markie://open"]) {
      expect(darkmownLinkFromMessage(message({ type: DARKMOWN_LINK_MESSAGE, href }), frame, clicked), href).toBeNull();
    }
    close();
  });

  it("refuses messages from anywhere but this frame, or in any other shape", () => {
    const { frame, other, message, close } = setup();
    const data = { type: DARKMOWN_LINK_MESSAGE, href: "https://example.com" };
    expect(darkmownLinkFromMessage(message(data, { source: other.contentWindow }), frame, clicked)).toBeNull();
    expect(darkmownLinkFromMessage(message(data, { source: window }), frame, clicked)).toBeNull();
    expect(darkmownLinkFromMessage(message(data, { origin: "app://markie" }), frame, clicked)).toBeNull();
    expect(darkmownLinkFromMessage(message(data), null, clicked)).toBeNull();
    for (const bad of [{ ...data, extra: 1 }, { type: "markie:preview-theme", href: data.href }, { type: DARKMOWN_LINK_MESSAGE, href: 1 }, [data], "https://example.com", null]) {
      expect(darkmownLinkFromMessage(message(bad), frame, clicked), JSON.stringify(bad)).toBeNull();
    }
    close();
  });
});

describe("a Markdown document made interactive", () => {
  const MARKDOWN = [
    "# Trip notes", "",
    "Book through [the hotel site](https://hotel.example.com/book?room=2) or [email Ada](mailto:ada@example.com?subject=Trip).", "",
    "![The view from the room](pics/view.png \"Room 2\")", "",
    "## Packing", "",
    "- [ ] passport",
    "- [x] charger",
    "- [ ] *walking* shoes", "",
    "Plain <https://maps.example.com> too.", "",
  ].join("\n");

  it("loses nothing in the .wd preview: links, the picture beside it and the checklist", async () => {
    for (const trusted of [false, true]) {
      const { srcDoc, warnings } = await compileDarkmownPreview(MARKDOWN, trusted, { links: true, pictureBase: BASE });
      expect(warnings, `trusted=${trusted}`).toEqual([]);
      const body = new DOMParser().parseFromString(srcDoc, "text/html").body;
      expect([...body.querySelectorAll("h1, h2")].map((heading) => heading.textContent)).toEqual(["Trip notes", "Packing"]);
      expect([...body.querySelectorAll("a")].map((anchor) => [anchor.textContent, anchor.getAttribute("href"), anchor.getAttribute("target")])).toEqual([
        ["the hotel site", "https://hotel.example.com/book?room=2", "_blank"],
        ["email Ada", "mailto:ada@example.com?subject=Trip", "_blank"],
        ["https://maps.example.com", "https://maps.example.com/", "_blank"],
      ]);
      const picture = body.querySelector("img")!;
      expect([picture.getAttribute("src"), picture.getAttribute("alt"), picture.getAttribute("title")]).toEqual([`${BASE}/pics%2Fview.png`, "The view from the room", "Room 2"]);
      const items = [...body.querySelectorAll("li")];
      expect(items.map((item) => [item.textContent!.trim(), (item.querySelector('input[type="checkbox"]') as HTMLInputElement).checked])).toEqual([
        ["passport", false], ["charger", true], ["walking shoes", false],
      ]);
      expect(items[2].querySelector("em")?.textContent).toBe("walking");
    }
  });
});
