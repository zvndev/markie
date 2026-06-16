import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderMarkdownHTML,
  renderPublicPage,
  renderNotFoundPage,
} from "./render.ts";

test("renderMarkdownHTML converts markdown to html", () => {
  const html = renderMarkdownHTML("# Hello\n\n- a\n- b");
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<li>a<\/li>/);
});

test("renderPublicPage embeds title, content, and download link", () => {
  const page = renderPublicPage({
    title: "My <Doc>",
    markdown: "# Hi",
    token: "abc123",
    siteUrl: "https://markie.example.com",
  });
  assert.match(page, /My &lt;Doc&gt;/);
  assert.match(page, /<h1>Hi<\/h1>/);
  assert.match(page, /href="\/s\/abc123\/raw"/);
  assert.match(page, /https:\/\/markie\.example\.com/);
  assert.match(page, /markie:\/\//);
});

test("renderPublicPage offers a Get Markie for macOS download", () => {
  const page = renderPublicPage({
    title: "Doc",
    markdown: "# Hi",
    token: "tok",
    siteUrl: "https://markie.example.com",
  });
  assert.match(page, /href="\/download\/mac"/);
  assert.match(page, /Get Markie for macOS/);
});

test("renderNotFoundPage returns a 404 body with a site link", () => {
  const page = renderNotFoundPage("https://markie.example.com");
  assert.match(page, /not found|no longer|expired/i);
  assert.match(page, /https:\/\/markie\.example\.com/);
});

test("renderMarkdownHTML drops javascript: link hrefs", () => {
  const html = renderMarkdownHTML("[click](javascript:alert(1))");
  assert.doesNotMatch(html, /javascript:/);
});

test("renderMarkdownHTML preserves syntax-highlight classes", () => {
  const html = renderMarkdownHTML("```js\nconst a = 1;\n```");
  assert.match(html, /hljs/);
});

test("renderMarkdownHTML preserves KaTeX math output", () => {
  const html = renderMarkdownHTML("$E = mc^2$");
  assert.match(html, /katex/);
});

test("renderPublicPage sets a Content-Security-Policy", () => {
  const page = renderPublicPage({ title: "T", markdown: "# H", token: "tok", siteUrl: "https://x.test" });
  assert.match(page, /Content-Security-Policy/);
  assert.match(page, /default-src 'none'/);
});
