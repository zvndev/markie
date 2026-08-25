import { describe, it, expect } from "vitest";
import { buildPDFHTML, buildPDFHTMLSync, getPDFStyles, getPDFStylesSync } from "./pdf-styles";

describe("getPDFStyles", () => {
  it("produces one closed style block per theme", async () => {
    for (const theme of ["dark", "light"] as const) {
      const css = await getPDFStyles(theme);
      expect(css.startsWith("<style>")).toBe(true);
      expect(css.endsWith("</style>")).toBe(true);
      // exactly one style element — no stray close tag inside the payload
      expect(css.match(/<\/style>/g)).toHaveLength(1);
    }
  });

  it("carries theme-specific colors", () => {
    // the sync variant is the same stylesheet minus KaTeX, so the theme rules
    // can be asserted without pulling 240 KB of embedded fonts in
    expect(getPDFStylesSync("dark")).toContain("background: #09090b");
    expect(getPDFStylesSync("light")).toContain("background: #fff");
  });

  // rehype-katex runs in the export pipeline, so without the KaTeX stylesheet
  // math came out as a pile of unstyled spans in the PDF.
  it("inlines the KaTeX stylesheet with embedded fonts", async () => {
    const css = await getPDFStyles("light");
    expect(css).toContain(".katex");
    expect(css).toContain("font-family:KaTeX_Main");
    expect(css).toContain("data:font/woff2;base64,");
    // no relative font URLs left: the print window has no base URL to resolve them
    expect(css).not.toContain("url(fonts/");
  });
});

describe("buildPDFHTML", () => {
  it("produces a full HTML document for both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      const html = await buildPDFHTML("<p>hi</p>", theme);
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html.trimEnd().endsWith("</html>")).toBe(true);
      expect(html).toContain("<head>");
      expect(html).toContain('<meta charset="utf-8">');
      expect(html).toContain(await getPDFStyles(theme));
    }
  });

  it("inserts the body at the document slot", async () => {
    const html = await buildPDFHTML("<p>body content</p>", "dark");
    expect(html).toContain('<article class="markdown-body"><p>body content</p></article>');
    // the slot is inside <body>, after the head has been closed
    expect(html.indexOf("body content")).toBeGreaterThan(html.indexOf("</head>"));
  });

  it("cannot be broken out of by a </style> or </script> in the body", async () => {
    const attack = '</style><script>alert(1)</script><style>';
    const html = await buildPDFHTML(`<p>${attack}</p>`, "dark");

    // The head's style block is closed before the body slot, so nothing from
    // the body can land inside it.
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.match(/<\/style>/g)).toHaveLength(1);

    // And the closing sequences themselves are neutralised, so the injected
    // markup cannot end an enclosing element or introduce a live <script>.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/script");
    expect(html).toContain("&lt;/style");

    // Every style/script close tag in the document belongs to the template.
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toBeNull();
  });

  it("leaves ordinary rendered markdown untouched", async () => {
    const body = '<pre><code>&#x3C;/script></code></pre>';
    expect(await buildPDFHTML(body, "light")).toContain(body);
  });

  // The KaTeX stylesheet is loaded on demand so it stays out of the app's main
  // chunk; the sync variant is the same document without it.
  it("builds the same document without KaTeX when it cannot await", async () => {
    const withMath = await buildPDFHTML("<p>hi</p>", "light");
    const without = buildPDFHTMLSync("<p>hi</p>", "light");
    expect(without).toContain("<article class=\"markdown-body\"><p>hi</p></article>");
    expect(without).not.toContain("data:font/woff2;base64,");
    expect(withMath.length).toBeGreaterThan(without.length);
  });
});
