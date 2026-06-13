// Self-contained server-side renderer for public share pages. Uses the exact
// same unified pipeline as the in-app preview (src/lib/markdown-html.ts), kept
// here so the server has no dependency on the Next app's module graph.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeHighlight)
  .use(rehypeKatex)
  .use(rehypeStringify);

export function renderMarkdownHTML(markdown: string): string {
  return String(processor.processSync(markdown));
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"
  );

// CDN stylesheets for the rendered content (highlight.js + KaTeX), so the page
// is self-contained and zero-build.
const HEAD_CSS = `
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css">`;

const PAGE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0a0c; color: #e4e4e7;
    font: 16px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .bar { position: sticky; top: 0; display: flex; align-items: center; gap: 12px;
    padding: 12px 20px; background: #131316cc; backdrop-filter: blur(8px);
    border-bottom: 1px solid #27272a; }
  .bar .brand { font-weight: 800; color: #f59e0b; font-size: 18px; }
  .bar .title { font-size: 14px; color: #a1a1aa; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { text-decoration: none; font-size: 13px; font-weight: 600;
    padding: 7px 14px; border-radius: 8px; white-space: nowrap; }
  .btn.primary { background: #f59e0b; color: #000; }
  .btn.ghost { color: #e4e4e7; border: 1px solid #3f3f46; }
  main { max-width: 760px; margin: 0 auto; padding: 36px 24px 64px; }
  main :where(h1,h2,h3) { line-height: 1.25; margin-top: 1.6em; }
  main h1 { font-size: 1.9em; }
  main pre { background: #131316; padding: 14px 16px; border-radius: 10px;
    overflow-x: auto; border: 1px solid #27272a; }
  main code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main :not(pre) > code { background: #27272a; padding: 1px 5px; border-radius: 5px;
    font-size: 0.9em; }
  main a { color: #fbbf24; }
  main blockquote { border-left: 3px solid #3f3f46; margin: 1em 0; padding: 2px 16px;
    color: #a1a1aa; }
  main table { border-collapse: collapse; }
  main th, main td { border: 1px solid #27272a; padding: 6px 12px; }
  main img { max-width: 100%; border-radius: 8px; }
  .cta { max-width: 760px; margin: 0 auto; padding: 24px; border-top: 1px solid #27272a;
    color: #a1a1aa; font-size: 14px; }
  .cta a { color: #fbbf24; font-weight: 600; }`;

export function renderPublicPage(opts: {
  title: string;
  markdown: string;
  token: string;
  siteUrl: string;
}): string {
  const { title, markdown, token, siteUrl } = opts;
  const content = renderMarkdownHTML(markdown);
  const safeTitle = esc(title);
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${safeTitle} · Markie</title>
  ${HEAD_CSS}
  <style>${PAGE_CSS}</style>
</head><body>
  <div class="bar">
    <span class="brand">M</span>
    <span class="title">${safeTitle}</span>
    <a class="btn ghost" href="markie://open">Open in Markie</a>
    <a class="btn primary" href="/s/${esc(token)}/raw">Download .md</a>
  </div>
  <main>${content}</main>
  <div class="cta">
    These look even better in <a href="${esc(siteUrl)}">Markie</a> — it's free,
    it's fast, and your markdown will thank you.
  </div>
</body></html>`;
}

export function renderNotFoundPage(siteUrl: string): string {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link expired · Markie</title>
  <style>${PAGE_CSS}</style>
</head><body>
  <main style="text-align:center;padding-top:80px">
    <div style="font-size:40px;font-weight:800;color:#f59e0b">M</div>
    <h1>This link is no longer available</h1>
    <p style="color:#a1a1aa">The doc was unshared, or the link expired.</p>
    <p><a class="btn primary" href="${esc(siteUrl)}">Get Markie</a></p>
  </main>
</body></html>`;
}
