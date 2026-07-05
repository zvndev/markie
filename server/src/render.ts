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
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import {
  downloadHref,
  downloadPlatforms,
  primaryDownloadCta,
  type DownloadPlatform,
} from "./downloads.ts";

// rehype-sanitize schema: drops scripts, event handlers, and javascript:/data:
// hrefs (defaultSchema.protocols) while preserving what rehype-highlight (hljs
// class names) and rehype-katex (MathML tags + inline styles) emit. This is the
// hardened public variant of the in-app renderer.
const MATHML = ["math","semantics","annotation","mrow","mi","mo","mn","ms","mtext","mspace","msup","msub","msubsup","mfrac","msqrt","mroot","munder","mover","munderover","mtable","mtr","mtd","mpadded","mphantom","menclose","mstyle","mglyph"];
const SVG = ["svg","path","line","g","defs","use","rect","polyline"];
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "span", "div", ...MATHML, ...SVG],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "ariaHidden", "ariaLabel"],
    span: ["className", "style", "ariaHidden"],
    div: ["className", "style"],
    code: ["className"],
    pre: ["className"],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    svg: ["xmlns", "width", "height", "viewBox", "preserveAspectRatio", "style", "ariaHidden"],
    path: ["d"],
    line: ["x1", "y1", "x2", "y2"],
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeHighlight)
  .use(rehypeKatex)
  .use(rehypeSanitize, sanitizeSchema)
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
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css" media="(prefers-color-scheme: light)">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css">`;

const PAGE_CSS = `
  :root {
    color-scheme: light dark;
    --page-bg: #fbfaf7;
    --surface: rgba(255, 255, 255, 0.86);
    --surface-strong: #ffffff;
    --text: #1c1917;
    --muted: #6f665d;
    --line: #e7ded0;
    --accent: #b45309;
    --accent-strong: #f59e0b;
    --accent-text: #111111;
    --code-bg: #f3eee7;
    --shadow: 0 18px 45px rgba(28, 25, 23, 0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page-bg: #0a0a0c;
      --surface: rgba(19, 19, 22, 0.84);
      --surface-strong: #131316;
      --text: #e4e4e7;
      --muted: #a1a1aa;
      --line: #27272a;
      --accent: #fbbf24;
      --accent-strong: #f59e0b;
      --accent-text: #000000;
      --code-bg: #1f1f23;
      --shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page-bg); color: var(--text);
    font: 16px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .bar { position: sticky; top: 0; display: flex; align-items: center; gap: 12px;
    padding: 12px 20px; background: var(--surface); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line); }
  .bar .brand { font-weight: 800; color: var(--accent-strong); font-size: 18px; }
  .bar .title { font-size: 14px; color: var(--muted); flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { text-decoration: none; font-size: 13px; font-weight: 600;
    padding: 7px 14px; border-radius: 8px; white-space: nowrap; }
  .btn.primary { background: var(--accent-strong); color: var(--accent-text); }
  .btn.ghost { color: var(--text); border: 1px solid var(--line); background: color-mix(in srgb, var(--surface-strong) 64%, transparent); }
  main { max-width: 760px; margin: 0 auto; padding: 36px 24px 64px; }
  main :where(h1,h2,h3) { line-height: 1.25; margin-top: 1.6em; }
  main h1 { font-size: 1.9em; }
  main pre { background: var(--code-bg); padding: 14px 16px; border-radius: 8px;
    overflow-x: auto; border: 1px solid var(--line); }
  main code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main :not(pre) > code { background: var(--code-bg); padding: 1px 5px; border-radius: 5px;
    font-size: 0.9em; }
  main a { color: var(--accent); }
  main blockquote { border-left: 3px solid var(--line); margin: 1em 0; padding: 2px 16px;
    color: var(--muted); }
  main table { border-collapse: collapse; }
  main th, main td { border: 1px solid var(--line); padding: 6px 12px; }
  main img { max-width: 100%; border-radius: 8px; }
  .cta { max-width: 760px; margin: 0 auto; padding: 24px; border-top: 1px solid var(--line);
    color: var(--muted); font-size: 14px; }
  .cta a { color: var(--accent); font-weight: 600; }
  .download-hero { max-width: 920px; }
  .download-hero h1 { margin-top: 0; font-size: clamp(2rem, 7vw, 4.6rem); line-height: 0.96; letter-spacing: 0; }
  .download-hero > p { max-width: 650px; color: var(--muted); font-size: 1.05rem; }
  .platform-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-top: 28px; }
  .platform-card { border: 1px solid var(--line); border-radius: 8px; background: var(--surface-strong); padding: 16px; box-shadow: var(--shadow); }
  .platform-card h2 { margin: 0 0 6px; font-size: 1rem; }
  .platform-card p { margin: 0 0 14px; color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
  .artifact { display: grid; gap: 2px; margin: 12px 0 2px; color: var(--muted);
    font-size: 0.78rem; line-height: 1.4; }
  .artifact code { color: var(--text); background: var(--code-bg); border: 1px solid var(--line);
    border-radius: 5px; padding: 1px 5px; overflow-wrap: anywhere; }
  .status { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; color: var(--muted); font-size: 0.76rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
  .status.public { color: var(--accent-text); background: var(--accent-strong); border-color: transparent; }
  .platform-card .btn { display: inline-flex; margin-top: 12px; }
  .download-note { margin-top: 24px; color: var(--muted); font-size: 0.9rem; }
  @media (max-width: 640px) {
    .bar { align-items: flex-start; flex-wrap: wrap; }
    .bar .title { min-width: 0; flex-basis: calc(100% - 34px); }
    .bar .btn { flex: 1 1 auto; text-align: center; }
    main { padding: 28px 18px 56px; }
  }`;

export function renderPublicPage(opts: {
  title: string;
  markdown: string;
  token: string;
  siteUrl: string;
}): string {
  const { title, markdown, token, siteUrl } = opts;
  const content = renderMarkdownHTML(markdown);
  const safeTitle = esc(title);
  const download = primaryDownloadCta();
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: https:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; base-uri 'none'; form-action 'none'">
  <title>${safeTitle} · Markie</title>
  ${HEAD_CSS}
  <style>${PAGE_CSS}</style>
</head><body>
  <div class="bar">
    <span class="brand">M</span>
    <span class="title">${safeTitle}</span>
    <a class="btn primary" href="${esc(`markie://open?token=${encodeURIComponent(token)}&src=${encodeURIComponent(siteUrl)}`)}">Open in Markie</a>
    <a class="btn ghost" href="${esc(download.href)}">${esc(download.label)}</a>
    <a class="btn ghost" href="/s/${esc(token)}/raw">Download .md</a>
  </div>
  <main>${content}</main>
  <div class="cta">
    These look even better in <a href="${esc(siteUrl)}">Markie</a> — it's free,
    it's fast, and your markdown will thank you.
  </div>
</body></html>`;
}

function platformStatusLabel(platform: DownloadPlatform) {
  return platform.status === "public" ? "Published" : "Planned";
}

export function renderDownloadPage(opts: {
  siteUrl: string;
  selectedPlatform?: DownloadPlatform;
  status?: "missing";
}): string {
  const { siteUrl, selectedPlatform, status } = opts;
  const primary = primaryDownloadCta();
  const platforms = downloadPlatforms();
  const headline =
    status === "missing"
      ? "Download Not Found"
      : selectedPlatform?.status === "planned"
        ? `${selectedPlatform.label} Is Not Published Yet`
        : "Download Markie";
  const summary =
    status === "missing"
      ? "That download route is not in Markie's platform manifest."
      : selectedPlatform?.status === "planned"
        ? `${selectedPlatform.description} The current public build remains ${primary.platform.label}.`
        : "Markie's desktop release surface is manifest-driven: published artifacts link directly, while upcoming platforms stay visible without pretending they are ready.";
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; base-uri 'none'; form-action 'none'">
  <title>${esc(headline)} · Markie</title>
  ${HEAD_CSS}
  <style>${PAGE_CSS}</style>
</head><body>
  <div class="bar">
    <span class="brand">M</span>
    <span class="title">Markie downloads</span>
    <a class="btn primary" href="${esc(primary.href)}">${esc(primary.label)}</a>
    <a class="btn ghost" href="${esc(siteUrl)}">Markie home</a>
  </div>
  <main class="download-hero">
    <h1>${esc(headline)}</h1>
    <p>${esc(summary)}</p>
    <div class="platform-grid">
      ${platforms
        .map((platform) => {
          const isPublic = platform.status === "public";
          return `<section class="platform-card">
        <span class="status${isPublic ? " public" : ""}">${platformStatusLabel(platform)}</span>
        <h2>${esc(platform.label)}</h2>
        <p>${esc(platform.description)}</p>
        <div class="artifact">
          <span>Artifact <code>${esc(platform.artifactPattern ?? "unknown")}</code></span>
          <span>Route <code>${esc(platform.route)}</code></span>
        </div>
        ${
          isPublic
            ? `<a class="btn primary" href="${esc(downloadHref(platform))}">${esc(platform.ctaLabel)}</a>`
            : `<span class="btn ghost" aria-disabled="true">Not published yet</span>`
        }
      </section>`;
        })
        .join("")}
    </div>
    <p class="download-note">Signing, notarization, updater feeds, and public storage changes remain human-gated release work.</p>
  </main>
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
    <div style="font-size:40px;font-weight:800;color:var(--accent-strong)">M</div>
    <h1>This link is no longer available</h1>
    <p style="color:var(--muted)">The doc was unshared, or the link expired.</p>
    <p><a class="btn primary" href="${esc(siteUrl)}">Get Markie</a></p>
  </main>
</body></html>`;
}
