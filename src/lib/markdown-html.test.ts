import { describe, it, expect } from "vitest";
import { renderMarkdownHTML, renderMarkdownFallback } from "./markdown-html";

describe("renderMarkdownHTML", () => {
  it("renders headings", () => {
    expect(renderMarkdownHTML("# Hello")).toContain("<h1>Hello</h1>");
  });

  it("renders GFM tables", () => {
    const html = renderMarkdownHTML("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("highlights fenced code blocks", () => {
    const html = renderMarkdownHTML("```js\nconst x = 1;\n```");
    expect(html).toContain("hljs");
    expect(html).toContain("language-js");
  });

  it("renders math via KaTeX", () => {
    const html = renderMarkdownHTML("$E = mc^2$");
    expect(html).toContain("katex");
  });

  it("renders GFM task lists", () => {
    const html = renderMarkdownHTML("- [x] done\n- [ ] todo");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });
});

// Failure modes. None of these may throw: renderMarkdownHTML is called
// synchronously from React render and from the export handlers, so a throw
// blanks the window (see the ErrorBoundary) or silently kills an export.
describe("renderMarkdownHTML resilience", () => {
  it("does not throw on an unknown fence language", () => {
    const html = renderMarkdownHTML("```notalang\nx\n```");
    expect(html).toContain("language-notalang");
    expect(html).toContain("x");
  });

  it("renders an unterminated fence as a code block", () => {
    const html = renderMarkdownHTML("```js\nconst x = 1;");
    expect(html).toContain("<pre>");
    expect(html).toContain("const");
  });

  it("falls back to a paragraph for a malformed table", () => {
    const html = renderMarkdownHTML("| a | b\n|---\n| 1 | 2 | 3 |");
    expect(html).not.toContain("<table>");
    expect(html).toContain("<p>");
  });

  it("renders invalid LaTeX as a katex-error span instead of throwing", () => {
    const html = renderMarkdownHTML("$\\frac{1}{$");
    expect(html).toContain("katex-error");
    expect(html).toContain("\\frac{1}{");
  });

  // Documented behavior, not a preference: the pipeline runs without
  // allowDangerousHtml and without rehype-raw, so raw HTML in a document is
  // dropped entirely from exports — block tags and their content disappear,
  // inline tags are stripped down to their text.
  it("drops raw HTML from the output", () => {
    const html = renderMarkdownHTML('<div class="x">hi</div>\n\ntext <b>bold</b>');
    expect(html).not.toContain("<div");
    expect(html).not.toContain("<b>");
    expect(html).toContain("text bold");
  });

  it("renders a 5k-line document", () => {
    const doc = Array.from({ length: 5000 }, (_, i) =>
      i % 10 === 0 ? `## Section ${i}` : `Line ${i} with \`code\` and **bold**.`
    ).join("\n\n");
    const html = renderMarkdownHTML(doc);
    expect(html).toContain("Section 4990");
  }, 20000);

  it("returns an escaped <pre> fallback when the pipeline throws", () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      // A non-string reaches processSync from plain-JS call sites and makes
      // unified throw; any pipeline throw takes the same path.
      const html = renderMarkdownHTML(42 as unknown as string);
      expect(html).toContain('class="markie-render-error"');
    } finally {
      console.error = original;
    }
    expect(errors.length).toBe(1);
  });

  it("escapes the source in the fallback", () => {
    const html = renderMarkdownFallback('<script>alert("x")</script> & more');
    expect(html).toBe(
      '<pre class="markie-render-error">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more</pre>'
    );
  });
});

// The rendered HTML is written into exports, the print window, and PDFs, so the
// pipeline sanitizes before it stringifies.
describe("renderMarkdownHTML sanitization", () => {
  it("drops a javascript: link target but keeps the text", () => {
    const html = renderMarkdownHTML("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("drops a javascript: image source", () => {
    const html = renderMarkdownHTML("![x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("keeps ordinary http(s) links intact", () => {
    const html = renderMarkdownHTML("[markie](https://markie.zvndev.com)");
    expect(html).toContain('href="https://markie.zvndev.com"');
  });

  it("keeps highlight.js class names on code", () => {
    const html = renderMarkdownHTML("```js\nconst x = 1;\n```");
    expect(html).toContain("hljs");
    expect(html).toContain("language-js");
    expect(html).toContain("hljs-keyword");
  });

  it("keeps katex spans and their classes", () => {
    const html = renderMarkdownHTML("$E = mc^2$");
    expect(html).toContain('class="katex"');
    expect(html).toContain("<math");
  });
});
