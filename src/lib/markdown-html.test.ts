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

  // A document's own HTML is parsed and then sanitized, in that order. What
  // every markdown renderer accepts survives; what could run, or frame, or
  // call out, does not, however it is written.
  describe("raw HTML in a document", () => {
    it("keeps the inline HTML the rich editor writes", () => {
      const html = renderMarkdownHTML(
        [
          'a <mark style="background-color: #ff0">lit</mark> word,',
          "an <u>underlined</u> one,",
          'and a <span style="color: red; font-size: 18px">red</span> one.',
          "",
          '<p style="text-align: center">centred</p>',
          "",
          '<h2 style="text-align: right">right</h2>',
        ].join("\n")
      );
      expect(html).toContain('<mark style="background-color: #ff0">lit</mark>');
      expect(html).toContain("<u>underlined</u>");
      expect(html).toContain('<span style="color: red; font-size: 18px">red</span>');
      expect(html).toContain('<p style="text-align: center">centred</p>');
      expect(html).toContain('<h2 style="text-align: right">right</h2>');
    });

    it("keeps a picture with a chosen width, and a clip", () => {
      const html = renderMarkdownHTML(
        '<img src="demo/shot.png" alt="beside" width="240">\n\n<video src="demo/clip.mp4" width="320" controls></video>'
      );
      expect(html).toContain('<img src="demo/shot.png" alt="beside" width="240">');
      expect(html).toContain('<video src="demo/clip.mp4" width="320" controls>');
    });

    it("drops what could run, frame, or call out", () => {
      const html = renderMarkdownHTML(
        [
          "<script>alert(1)</script>",
          "",
          '<img src="x.png" onerror="alert(1)">',
          "",
          '<iframe src="https://example.com"></iframe>',
          "",
          "<style>body{display:none}</style>",
          "",
          '<a href="javascript:alert(1)">no</a>',
          "",
          '<object data="x"></object>',
        ].join("\n")
      );
      expect(html).not.toContain("<script");
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("onerror");
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("<style");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("<object");
      // The picture itself is still there, minus the handler.
      expect(html).toContain('<img src="x.png">');
    });

    it("keeps plain block HTML that any renderer shows", () => {
      const html = renderMarkdownHTML('<div class="x">hi</div>\n\ntext <b>bold</b>');
      expect(html).toContain('<div class="x">hi</div>');
      expect(html).toContain("<b>bold</b>");
    });
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

// A video link alone on its line is a card in an export: the thumbnail,
// linked to the video. The file keeps the bare URL.
describe("a video link in an export", () => {
  it("becomes a linked thumbnail when it is alone on its line", () => {
    const html = renderMarkdownHTML("Watch this:\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nThen read on.");
    expect(html).toContain('<p class="markie-embed">');
    expect(html).toContain('<p class="markie-embed"><a href="https://youtu.be/dQw4w9WgXcQ">');
    expect(html).toContain('<img src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" alt="Watch on YouTube"');
    // No player: an export runs no script and a share page frames nothing.
    expect(html).not.toContain("<iframe");
  });

  it("stays a link inside a sentence, or when words were chosen for it", () => {
    expect(renderMarkdownHTML("See https://youtu.be/dQw4w9WgXcQ for the talk.")).not.toContain("markie-embed");
    expect(renderMarkdownHTML("[the talk](https://youtu.be/dQw4w9WgXcQ)")).not.toContain("markie-embed");
    expect(renderMarkdownHTML("https://example.com/watch?v=dQw4w9WgXcQ")).not.toContain("markie-embed");
  });

  it("leaves a provider with no guessable thumbnail as the link it was", () => {
    const html = renderMarkdownHTML("https://vimeo.com/148751763");
    expect(html).not.toContain("markie-embed");
    expect(html).toContain('<a href="https://vimeo.com/148751763">');
  });
});
