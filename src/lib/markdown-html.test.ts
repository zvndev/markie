import { describe, it, expect } from "vitest";
import { renderMarkdownHTML } from "./markdown-html";

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
