import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderDownloadPage,
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

test("renderPublicPage offers the manifest primary download", () => {
  const page = renderPublicPage({
    title: "Doc",
    markdown: "# Hi",
    token: "tok",
    siteUrl: "https://markie.example.com",
  });
  assert.match(page, /href="\/download\/mac"/);
  assert.match(page, /Get Markie for macOS/);
});

test("renderDownloadPage lists public and planned platforms", () => {
  const page = renderDownloadPage({ siteUrl: "https://markie.example.com" });

  assert.match(page, /Download Markie/);
  assert.match(page, /macOS Apple Silicon/);
  assert.match(page, /Windows x64/);
  assert.match(page, /Not published yet/);
  assert.match(page, /Markie-\*-arm64\.dmg/);
  assert.match(page, /Markie-\*-x64\.dmg/);
  assert.match(page, /Markie-\*-x64\.exe/);
  assert.match(page, /Markie-\*-x64\.AppImage/);
  assert.match(page, /\/download\/mac-intel/);
  assert.match(page, /\/download\/windows/);
  assert.match(page, /\/download\/linux/);
});

test("renderPublicPage's Open in Markie deep link carries the token + source", () => {
  const page = renderPublicPage({
    title: "Doc",
    markdown: "# Hi",
    token: "tok123",
    siteUrl: "https://markie.example.com",
  });
  // primary "Open in Markie" → markie://open?token=…&src=… so the app can fetch
  // the shared doc (no account needed) and open it.
  assert.match(page, /href="markie:\/\/open\?token=tok123&amp;src=https%3A%2F%2Fmarkie\.example\.com"/);
  assert.match(page, /class="btn primary"[^>]*>Open in Markie/);
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
