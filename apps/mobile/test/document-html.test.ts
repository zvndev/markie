// @vitest-environment jsdom
// The phone's last pass over a document's HTML (src/lib/document-html.ts) and
// the box the result is shown in. A document is somebody else's HTML in the
// same page as the app's chrome: it must not be able to look like, or sit on
// top of, any of it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { ASSET_ATTR, ASSET_STATE_ATTR, MAX_DOCUMENT_ASSETS, isLocalRef, prepareDocumentHtml, refOf } from "../src/lib/document-html";
import { MarkdownView } from "../src/components/markdown-view";

const render = (markdown: string) => prepareDocumentHtml(renderMarkdownHTML(markdown));
const parse = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
};

describe("a document's HTML on the phone", () => {
  it("keeps no class of the app's own", () => {
    const { html } = render(
      '<div class="m-screen m-sign-in keep" style="position:fixed;inset:0;z-index:2147483647">Sign in</div>\n\n' +
      '<span class="m-badge m-badge-agent">from Claude Code</span> <p class="m-toast">x</p>\n\n' +
      '<div class="m-table-scroll">fake</div>'
    );
    const root = parse(html);
    const classes = Array.from(root.querySelectorAll("[class]")).flatMap((el) => Array.from(el.classList));
    expect(classes.filter((name) => name.startsWith("m-"))).toEqual([]);
    expect(classes).toContain("keep");
    expect(root.textContent).toContain("Sign in");
  });

  it("keeps the desktop renderer's own classes (highlighting, math)", () => {
    const { html } = render("```js\nconst a = 1;\n```\n\n$x^2$");
    expect(html).toMatch(/class="[^"]*hljs/);
    expect(html).toMatch(/class="katex/);
  });

  it("puts every table in its own scroller, so the table itself can span the column", () => {
    const { html } = render("| a | b |\n|---|---|\n| 1 | 2 |\n");
    const root = parse(html);
    const table = root.querySelector("table")!;
    expect(table.parentElement?.className).toBe("m-table-scroll");
    expect(root.querySelectorAll(".m-table-scroll")).toHaveLength(1);
  });

  it("turns a picture beside the author's file into an asset to fetch, the way the server's web view does", () => {
    const { html, assets } = render(
      "![shot](shots/a%20b.png)\n\n![again](shots/a%20b.png?x=1#y)\n\n![web](https://example.com/a.png)\n\n![proto](//cdn.example/a.png)\n\n![inline](data:image/png;base64,AAAA)"
    );
    expect(assets).toEqual(["shots/a b.png"]);
    const imgs = Array.from(parse(html).querySelectorAll("img"));
    const local = imgs.filter((img) => img.getAttribute(ASSET_ATTR));
    expect(local).toHaveLength(2);
    for (const img of local) {
      expect(img.hasAttribute("src")).toBe(false);
      expect(img.getAttribute(ASSET_STATE_ATTR)).toBe("loading");
    }
    expect(imgs.map((img) => img.getAttribute("src")).filter(Boolean)).toEqual(["https://example.com/a.png", "//cdn.example/a.png", "data:image/png;base64,AAAA"]);
  });

  it("matches the server's notion of a local ref", () => {
    expect(isLocalRef("shots/a.png")).toBe(true);
    expect(isLocalRef("../a.png")).toBe(true);
    expect(isLocalRef("https://x/a.png")).toBe(false);
    expect(isLocalRef("//x/a.png")).toBe(false);
    expect(isLocalRef("data:x")).toBe(false);
    expect(refOf(" a%20b.png?v=1#frag ")).toBe("a b.png");
    expect(refOf("bad%zz.png")).toBe("bad%zz.png");
  });

  it("ignores a document's own attempt to mark something for loading", () => {
    const { assets, html } = prepareDocumentHtml('<img src="https://x.example/a.png" data-markie-asset="secret.png">');
    expect(assets).toEqual([]);
    expect(html).not.toContain("secret.png");
  });

  it("fetches at most a bounded number of pictures, and says so for the rest", () => {
    const markdown = Array.from({ length: MAX_DOCUMENT_ASSETS + 3 }, (_, i) => `![p${i}](p${i}.png)`).join("\n\n");
    const { assets, html } = render(markdown);
    expect(assets).toHaveLength(MAX_DOCUMENT_ASSETS);
    expect(parse(html).querySelectorAll(".m-asset-missing")).toHaveLength(3);
  });
});

describe("the article a document is shown in", () => {
  it("contains the document's paint, positioning and stacking", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
    const rule = /\n\.m-markdown \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/contain:\s*paint/);
    expect(rule).toMatch(/isolation:\s*isolate/);
    expect(rule).toMatch(/position:\s*relative/);
    // clip, not hidden: hidden makes the article a scroll container, and an
    // in-page link to a target past its edge scrolled the document out of view.
    expect(rule).toMatch(/overflow:\s*clip/);
    expect(rule).not.toMatch(/overflow:\s*(hidden|auto|scroll)/);
  });

  it("styles every highlight token for the light page, and keeps the picture placeholder calm", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
    // Every token github-dark colors, that the light block must repaint.
    const dark = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/highlight.js/styles/github-dark.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const colored = new Set<string>();
    for (const [, selectors, body] of dark.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/color:/.test(body) || selectors.includes("pre code") || /^\s*code\.hljs/.test(selectors) || /^\s*\.hljs\s*$/.test(selectors)) continue;
      for (const selector of selectors.split(",")) {
        const last = selector.trim().replace(/^.*\s/, "");
        if (last.startsWith(".hljs-")) colored.add(last.replace(/\.inherited__$/, ""));
      }
    }
    const light = css.split("\n").filter((line) => line.startsWith(':root[data-theme-tone="light"] .m-markdown .hljs-')).join("\n");
    for (const token of colored) expect(light, token).toContain(`.m-markdown ${token}`);
    expect(light).toMatch(/\.hljs-subst[^{]*\{[^}]*#1f2328/);

    const placeholder = /\.m-markdown img\[data-markie-asset-state="loading"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(placeholder).toMatch(/color:\s*transparent/);
    expect(placeholder).toMatch(/border:\s*0/);
  });

  it("loads at most three pictures at once", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:test/x", revokeObjectURL: vi.fn() }));
    let inFlight = 0;
    let peak = 0;
    const loadAsset = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(MarkdownView, { content: Array.from({ length: 9 }, (_, i) => `![p${i}](p${i}.png)`).join("\n\n"), onLink: () => undefined, loadAsset }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(loadAsset).toHaveBeenCalledTimes(9);
    expect(peak).toBe(3);
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("renders a hostile document inside that article, without the app's classes, and loads its pictures as blob URLs", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const created: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => { const url = `blob:test/${created.length}`; created.push(url); return url; }, revokeObjectURL: vi.fn() }));
    const loadAsset = vi.fn(async (ref: string) => (ref === "a.png" ? new Blob(["x"], { type: "image/png" }) : null));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(MarkdownView, {
        content: '<div class="m-screen m-navbar" style="position:fixed;inset:0;z-index:2147483647">cover</div>\n\n![a](a.png)\n\n![gone](gone.png)\n',
        onLink: () => undefined,
        loadAsset,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const article = host.querySelector("article")!;
    expect(article.className).toBe("markdown-body m-markdown");
    const cover = Array.from(article.querySelectorAll("div")).find((el) => el.textContent === "cover")!;
    expect(cover.closest(".m-markdown")).toBe(article);
    expect(cover.className).toBe("");
    expect(loadAsset.mock.calls.map(([ref]) => ref).sort()).toEqual(["a.png", "gone.png"]);
    expect(article.querySelector("img")?.getAttribute("src")).toBe("blob:test/0");
    expect(article.querySelector(".m-asset-missing")?.textContent).toBe("Picture not available: gone");
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
});
