// Self-contained server-side renderer for public share pages. Uses the exact
// same unified pipeline as the in-app preview (src/lib/markdown-html.ts), kept
// here so the server has no dependency on the Next app's module graph.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkStrictMath } from "./remark-strict-math.ts";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import { rehypeMedia } from "./rehype-media.ts";
import { rehypeCloudAssets } from "./rehype-cloud-assets.ts";
import { rehypeDocLinks } from "./rehype-doc-links.ts";
import { rehypeEmbeds } from "./rehype-embeds.ts";
import { rehypeLegibleColors } from "./rehype-legible-colors.ts";
import rehypeStringify from "rehype-stringify";
import type { DocLinkAnswer } from "./doc-links.ts";
import {
  downloadHref,
  downloadPlatforms,
  primaryDownloadCta,
  type DownloadPlatform,
} from "./downloads.ts";
import { deployment } from "./deployment.ts";
import { BRAND_HEAD, brandLogoSvg } from "./brand.ts";

// Where "Get Markie" and "Markie home" point. The official deployment serves
// its own download routes, so it keeps the site it was handed; a self-hosted
// server serves none and sends people to the official site instead.
const markieSite = (siteUrl: string) => (deployment().official ? siteUrl : deployment().downloadSiteUrl);

// rehype-sanitize schema: drops scripts, event handlers, and javascript:/data:
// hrefs (defaultSchema.protocols) while preserving what rehype-highlight (hljs
// class names), rehype-katex (MathML tags + inline styles) and the rich
// editor's own marks emit. This is the hardened public variant of the in-app
// renderer. A document's own HTML is parsed by rehype-raw and then sanitized
// against this schema, in that order, so what could run or frame never
// reaches the page however it is written, and a highlight, a colour, a
// centred heading or a picture with a chosen width survives.
const MATHML = ["math","semantics","annotation","mrow","mi","mo","mn","ms","mtext","mspace","msup","msub","msubsup","mfrac","msqrt","mroot","munder","mover","munderover","mtable","mtr","mtd","mpadded","mphantom","menclose","mstyle","mglyph"];
const SVG = ["svg","path","line","g","defs","use","rect","polyline"];
// Kept in step with src/lib/markdown-html.ts. A shared document can carry a
// clip as a remote or inlined source; a local path was never going to reach
// the reader anyway.
const MEDIA = ["video", "audio", "source"];
const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  // Kept in step with src/lib/markdown-html.ts. defaultSchema.protocols.src is
  // ["http", "https"], which strips the src off an inlined image and leaves an
  // <img alt> pointing at nothing, so a self-contained document shared as a
  // link lost every picture in it. data: is safe in an image position (a script
  // inside an SVG does not run when the SVG is loaded through <img>) and the
  // page's own CSP below already allows it. `href` is deliberately not widened:
  // a data: link is the thing defaultSchema.protocols is there to stop.
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
  // A disallowed element is normally unwrapped, its text kept, which is right
  // for a <small> and wrong for a <style>: the CSS inside came out as a
  // paragraph of the page. Its contents go the way a script's do.
  strip: [...(defaultSchema.strip ?? []), "style"],
  // Kept in step with src/lib/markdown-html.ts: `mark` and `u` are what the
  // editor writes for a highlight and an underline, and `style` on the blocks
  // it can align. `style` was already allowed on span and div, so this widens
  // where an inline style may sit, not what one may do.
  tagNames: [...(defaultSchema.tagNames ?? []), "span", "div", "mark", "u", ...MATHML, ...SVG, ...MEDIA],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "ariaHidden", "ariaLabel"],
    // defaultSchema.attributes.a restricts className to the single value
    // "data-footnote-backref" (a hast-util-sanitize allow list, `[key,
    // ...allowedValues]`), which is checked before the wildcard "*" list
    // above and wins even though it is more specific, not more permissive: a
    // tag-specific match short-circuits the wildcard rather than adding to
    // it. Left alone, a muted doc link's class is silently emptied. The fix
    // stays just as narrow as the entry it replaces: the one existing value
    // plus the one new value the muted style needs, nothing unrestricted.
    // (Appending a second ["className", ...] entry instead of replacing the
    // first would not work: findDefinition below returns on the first name
    // match, so the original, narrower entry would still win and the
    // muted class would go on being emptied.) An author's own
    // `class="btn primary"` still cannot survive sanitize and impersonate
    // the page's real buttons.
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter((entry) => !(Array.isArray(entry) && entry[0] === "className")),
      ["className", "data-footnote-backref", "doc-link-muted"],
    ],
    span: ["className", "style", "ariaHidden"],
    div: ["className", "style"],
    mark: ["style"],
    p: ["style"],
    h1: ["style"],
    h2: ["style"],
    h3: ["style"],
    h4: ["style"],
    h5: ["style"],
    h6: ["style"],
    code: ["className"],
    pre: ["className"],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    svg: ["xmlns", "width", "height", "viewBox", "preserveAspectRatio", "style", "ariaHidden"],
    path: ["d"],
    line: ["x1", "y1", "x2", "y2"],
    video: ["src", "controls", "preload", "width", "height", "poster"],
    audio: ["src", "controls", "preload"],
    source: ["src", "type"],
  },
};

export interface RenderOptions {
  assetUrlFor?: (ref: string) => string | null;
  docLinkFor?: (ref: string) => DocLinkAnswer;
}

function buildProcessor(opts: RenderOptions) {
  const p = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    // Prices are not equations: "$6 ... $100" stays text (remark-strict-math.ts).
    .use(remarkStrictMath)
    // allowDangerousHtml only keeps the HTML nodes for rehype-raw to parse;
    // rehype-sanitize below is what decides what stays.
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeMedia);
  if (opts.assetUrlFor) p.use(rehypeCloudAssets, opts.assetUrlFor);
  // Installed unconditionally, even when no caller passed docLinkFor: the
  // plugin's own job of scrubbing an author's borrowed doc-link-muted class
  // (rehype-doc-links.ts) must run on every render path, not just the ones
  // that resolve links. Its default docLinkFor answers null for everything,
  // so a caller that does pass one sees no change in behaviour.
  p.use(rehypeDocLinks, opts.docLinkFor);
  // rehypeLegibleColors reads the sanitized tree and changes nothing in it:
  // it leaves a stylesheet on the file for the page renderers below
  // (rehype-legible-colors.ts).
  return p
    .use(rehypeEmbeds)
    .use(rehypeHighlight)
    .use(rehypeKatex)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeLegibleColors)
    .use(rehypeStringify);
}

// The no-context case (public-page previews with no doc context, and every
// existing test) is cached rather than rebuilt per call.
const plain = buildProcessor({});

function processMarkdown(markdown: string, opts: RenderOptions) {
  const processor = opts.assetUrlFor || opts.docLinkFor ? buildProcessor(opts) : plain;
  return processor.processSync(markdown);
}

export function renderMarkdownHTML(markdown: string, opts: RenderOptions = {}): string {
  return String(processMarkdown(markdown, opts));
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
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.18/dist/katex.min.css">`;

const PAGE_CSS = `
  :root {
    color-scheme: light dark;
    /* Brand (brand.ts): paper and ink, the red reserved for the underline. */
    --brand-red: #EC4431;
    --logo-ink: #2C2C2C;
    --page-bg: #F6F4EF;
    --surface: rgba(255, 255, 255, 0.86);
    --surface-strong: #ffffff;
    --text: #2C2C2C;
    --muted: #6f665d;
    --line: #e7ded0;
    --accent: #2C2C2C;
    --accent-strong: #2C2C2C;
    --accent-text: #ffffff;
    --code-bg: #eeeae2;
    --shadow: 0 18px 45px rgba(28, 25, 23, 0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --logo-ink: #ffffff;
      --page-bg: #171719;
      --surface: rgba(23, 23, 25, 0.84);
      --surface-strong: #1f1f22;
      --text: #e4e4e7;
      --muted: #a1a1aa;
      --line: #2e2e33;
      --accent: #ffffff;
      --accent-strong: #ffffff;
      --accent-text: #171719;
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
  .bar .brand { display: flex; color: var(--logo-ink); line-height: 0; margin: -6px 0; }
  .hero-logo { color: var(--logo-ink); line-height: 0; margin-bottom: 4px; }
  .brand-logo { display: inline-block; }
  .bar .title { font-size: 14px; color: var(--muted); flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { text-decoration: none; font-size: 13px; font-weight: 600;
    padding: 7px 14px; border-radius: 8px; white-space: nowrap; }
  .btn.primary { background: var(--accent-strong); color: var(--accent-text); }
  .btn.ghost { color: var(--text); border: 1px solid var(--line); background: color-mix(in srgb, var(--surface-strong) 64%, transparent); }
  main { max-width: 760px; margin: 0 auto; padding: 36px 24px 64px; overflow-wrap: anywhere; }
  main :where(h1,h2,h3) { line-height: 1.25; margin-top: 1.6em; }
  main h1 { font-size: 1.9em; }
  main pre { background: var(--code-bg); padding: 14px 16px; border-radius: 8px;
    overflow-x: auto; border: 1px solid var(--line); }
  main code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main :not(pre) > code { background: var(--code-bg); padding: 1px 5px; border-radius: 5px;
    font-size: 0.9em; }
  main a, .cta a { color: var(--accent); text-decoration-color: var(--brand-red);
    text-decoration-thickness: 2px; text-underline-offset: 3px; }
  main .darkmown-note { color: var(--muted); font-size: 14px; border: 1px solid var(--line);
    border-radius: 8px; padding: 10px 14px; background: var(--surface-strong); }
  main pre.darkmown-source { white-space: pre-wrap; overflow-wrap: anywhere; }
  main a.doc-link-muted { color: var(--muted); text-decoration: underline dotted; cursor: not-allowed; }
  main blockquote { border-left: 3px solid var(--line); margin: 1em 0; padding: 2px 16px;
    color: var(--muted); }
  main table { border-collapse: collapse; }
  main th, main td { border: 1px solid var(--line); padding: 6px 12px; }
  main img { max-width: 100%; border-radius: 8px; }
  /* A video card (rehype-embeds.ts): the thumbnail YouTube serves is 4:3 with
     black bars, so it is cropped to the player's shape. */
  main p.markie-embed img { display: block; width: 100%; max-width: 640px; aspect-ratio: 16 / 9; object-fit: cover; }
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
  .cta-invite { margin-top: 10px; line-height: 1.5; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  /* The bar on a document page (hostedBar below). A details element, so the
     reader can put it away and read full-bleed with no script on the page:
     the summary is a real, focusable disclosure button (Enter or Space), and
     the browser itself tracks and announces whether the bar is shown. */
  .chrome { position: sticky; top: 0; z-index: 20; }
  .chrome .bar { position: static; padding-right: 92px; }
  .chrome > summary { list-style: none; position: absolute; top: 50%; transform: translateY(-50%); right: 16px; z-index: 1;
    display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px 0 7px;
    border: 1px solid var(--line); border-radius: 6px; background: var(--surface-strong);
    color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; }
  .chrome > summary::-webkit-details-marker { display: none; }
  .chrome > summary:hover { color: var(--text); }
  .chrome > summary svg { flex: none; }
  .chrome:not([open]) > summary { top: 10px; right: 10px; transform: none; box-shadow: var(--shadow); }
  .chrome[open] .when-closed, .chrome:not([open]) .when-open { display: none; }
  .chrome > summary > span { display: inline-flex; align-items: center; gap: 4px; }
  .chrome :focus-visible { outline: 2px solid var(--brand-red); outline-offset: 2px; }
  .bar .nav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .nav-link { color: var(--muted); text-decoration: none; font-size: 13px; font-weight: 600;
    padding: 7px 8px; border-radius: 6px; white-space: nowrap; }
  .nav-link:hover { color: var(--text); background: var(--code-bg); }
  .nav-sep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; }
  .who { display: inline-block; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; }
  .btn:hover { filter: brightness(0.96); }

  /* What a document can carry, legible on both pages. highlight.js paints its
     own block background; the page's code panel is the one that follows the
     scheme. */
  main pre code.hljs { background: transparent; padding: 0; }
  main th { background: var(--code-bg); }
  main hr { border: 0; border-top: 1px solid var(--line); }
  main .katex-display { overflow-x: auto; overflow-y: hidden; }
  main pre.text-doc { white-space: pre-wrap; overflow-wrap: anywhere; background: none; border: 0; padding: 0;
    font: 15px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; }
  /* An author's own inline colours get a per-document stylesheet of their
     own (rehype-legible-colors.ts, docStyle below). */

  @media (max-width: 640px) {
    .bar { align-items: flex-start; flex-wrap: wrap; }
    .bar .title { min-width: 0; flex-basis: calc(100% - 34px); }
    .bar .btn { flex: 1 1 auto; text-align: center; }
    .chrome .bar { align-items: center; gap: 8px 10px; padding: 10px 14px; }
    .chrome .bar .title { flex: 1 1 0; flex-basis: auto; margin-right: 84px; font-size: 13px; }
    .chrome > summary, .chrome:not([open]) > summary { top: 9px; right: 12px; transform: none; }
    .bar .nav { flex-basis: 100%; justify-content: flex-start; gap: 6px; }
    .bar .nav .btn { flex: 0 1 auto; padding: 6px 10px; }
    .nav-sep { display: none; }
    .who { max-width: 100%; }
    main { padding: 28px 18px 56px; }
  }
  @media print { .chrome, .cta { display: none; } }`;

// The way out to the rest of Markie, on every page that shows a document.
// `webApp` is webAppAvailable(): links into /app exist only when this server
// actually serves the web app. Without it the bar is what it always was, the
// desktop deep link and the downloads.
export interface HostedNav {
  webApp: boolean;
  /** Who the browser is signed in as, for the account chip. Null: nobody. */
  account: string | null;
}

const CHEVRON_UP = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEVRON_DOWN = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const NAV_SEP = `<span class="nav-sep" aria-hidden="true"></span>`;

const navLink = (href: string, label: string) => `<a class="nav-link" href="${esc(href)}">${esc(label)}</a>`;
const button = (kind: "primary" | "ghost", href: string, label: string) =>
  `<a class="btn ${kind}" href="${esc(href)}">${esc(label)}</a>`;
const accountChip = (account: string) =>
  `<span class="who" title="${esc(`Signed in as ${account}`)}"><span class="sr-only">Signed in as </span>${esc(account)}</span>`;

// The bar, inside a <details> so the reader can put it away and get it back
// without any script: the page's CSP has no script-src and keeps none. Open by
// default. The summary is the toggle; its name says which way it goes, and
// the browser reports expanded or collapsed on it.
function hostedBar(safeTitle: string, items: string[]): string {
  return `<details class="chrome" open>
    <summary class="chrome-toggle">
      <span class="when-open">${CHEVRON_UP}Hide<span class="sr-only"> the Markie bar</span></span>
      <span class="when-closed">${CHEVRON_DOWN}Show<span class="sr-only"> the Markie</span> bar</span>
    </summary>
    <header class="bar">
      <span class="brand">${brandLogoSvg(120)}</span>
      <span class="title">${safeTitle}</span>
      <nav class="nav" aria-label="Markie">
        ${items.join("\n        ")}
      </nav>
    </header>
  </details>`;
}

// A document's body by docs.format: Darkmown as its escaped source, plain
// text as escaped preformatted text (the phone app shows it the same way),
// and everything else through the markdown pipeline.
// `css` is the document's own colour stylesheet, empty for most documents.
function renderDocBody(markdown: string, format: string | undefined, opts: RenderOptions): { html: string; css: string } {
  if (format === "darkmown") return { html: renderDarkmownSource(markdown), css: "" };
  if (format === "text") return { html: `<pre class="text-doc">${esc(markdown)}</pre>`, css: "" };
  const file = processMarkdown(markdown, opts);
  return { html: String(file), css: typeof file.data.legibleCss === "string" ? file.data.legibleCss : "" };
}

const docStyle = (css: string) => (css ? `\n  <style>${css}</style>` : "");

export function renderPublicPage(opts: {
  title: string;
  markdown: string;
  token: string;
  siteUrl: string;
  assetUrlFor?: (ref: string) => string | null;
  docLinkFor?: (ref: string) => DocLinkAnswer;
  /** docs.format, so a Darkmown or plain-text document reads as itself. */
  format?: string;
  nav?: HostedNav;
  /**
   * Set only when the signed-in reader may edit this document, and only then
   * does the page name the document's id (in the editor link). A public link
   * page never carries it otherwise.
   */
  editDocId?: string | null;
}): string {
  const { title, markdown, token, siteUrl } = opts;
  const content = renderDocBody(markdown, opts.format, { assetUrlFor: opts.assetUrlFor, docLinkFor: opts.docLinkFor });
  const safeTitle = esc(title);
  const download = primaryDownloadCta(markieSite(""));
  const nav = opts.nav ?? { webApp: false, account: null };
  const items: string[] = [];
  if (nav.webApp) {
    if (nav.account) {
      items.push(navLink("/app", "Library"), navLink("/app/new", "New document"));
      if (opts.editDocId) items.push(button("primary", `/app/d/${encodeURIComponent(opts.editDocId)}`, "Open in editor"));
    } else {
      items.push(navLink("/app", "Sign in"));
    }
    items.push(NAV_SEP);
  } else {
    items.push(button("primary", `markie://open?token=${encodeURIComponent(token)}&src=${encodeURIComponent(siteUrl)}`, "Open in Markie"));
  }
  items.push(button("ghost", download.href, download.label));
  items.push(`<a class="btn ghost" href="/s/${esc(token)}/raw">Download ${opts.format === "darkmown" ? ".wd" : ".md"}</a>`);
  if (nav.account) items.push(accountChip(nav.account));
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: https:; media-src * data: https:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; base-uri 'none'; form-action 'none'">
  <title>${safeTitle} · Markie</title>
  ${HEAD_CSS}
  ${BRAND_HEAD}
  <style>${PAGE_CSS}</style>${docStyle(content.css)}
</head><body>
  ${hostedBar(safeTitle, items)}
  <main>${content.html}</main>
  <div class="cta">
    These look even better in <a href="${esc(markieSite(siteUrl))}">Markie</a>. It's free,
    it's fast, and your markdown will thank you.
  </div>
</body></html>`;
}

// Only says something when there is something to say. A row of chips reading
// "Published" over every download tells a visitor nothing they cannot see from
// the button underneath it.
function platformStatusLabel(available: boolean) {
  return available ? null : "Coming soon";
}

export function renderDownloadPage(opts: {
  siteUrl: string;
  selectedPlatform?: DownloadPlatform;
  status?: "missing";
  // Ids the server resolved as downloadable right now. A "ready" platform is
  // offered only when it is in here, which is once its first stable release
  // exists. Public platforms are offered regardless, as they always were.
  offered?: ReadonlySet<string>;
}): string {
  const { siteUrl, selectedPlatform, status, offered } = opts;
  const isAvailable = (platform: DownloadPlatform) =>
    platform.status === "public" || (platform.status === "ready" && offered?.has(platform.id) === true);
  const selectedUnavailable = selectedPlatform ? !isAvailable(selectedPlatform) : false;
  const primary = primaryDownloadCta();
  const platforms = downloadPlatforms();
  // Written for somebody who wants the app, not for the build system. This
  // page used to explain the release process to its visitors: it named the
  // artifact filename and internal route on every card, chipped each one
  // "Published", and closed with a line about signing and updater feeds being
  // human-gated work. None of that is a download page.
  const headline =
    status === "missing"
      ? "Page not found"
      : selectedPlatform && selectedUnavailable
        ? `Markie for ${selectedPlatform.label} is coming`
        : "Download Markie";
  const summary =
    status === "missing"
      ? "That link does not go anywhere. The downloads are below."
      : selectedPlatform && selectedUnavailable
        ? `It is not ready yet. Markie runs on ${primary.platform.label} today.`
        : "A fast markdown reader and editor for your own files. Free, and it opens what is already on your machine.";
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; base-uri 'none'; form-action 'none'">
  <title>${esc(headline)} · Markie</title>
  ${HEAD_CSS}
  ${BRAND_HEAD}
  <style>${PAGE_CSS}</style>
</head><body>
  <div class="bar">
    <span class="brand">${brandLogoSvg(120)}</span>
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
          const isPublic = isAvailable(platform);
          const badge = platformStatusLabel(isPublic);
          return `<section class="platform-card">
        ${badge ? `<span class="status">${esc(badge)}</span>` : ""}
        <h2>${esc(platform.label)}</h2>
        <p>${esc(platform.description)}</p>
        ${
          isPublic
            ? `<a class="btn primary" href="${esc(downloadHref(platform))}">${esc(platform.ctaLabel)}</a>`
            : `<span class="btn ghost" aria-disabled="true">Not yet</span>`
        }
      </section>`;
        })
        .join("")}
    </div>
    <p class="download-note">The macOS and Windows builds are signed. Every build updates itself once installed.</p>
  </main>
</body></html>`;
}

export function renderNotFoundPage(siteUrl: string): string {
  const download = primaryDownloadCta(markieSite(siteUrl));
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link expired · Markie</title>
  ${BRAND_HEAD}
  <style>${PAGE_CSS}</style>
</head><body>
  <main style="text-align:center;padding-top:80px">
    <div class="hero-logo">${brandLogoSvg(160)}</div>
    <h1>This link is no longer available</h1>
    <p style="color:var(--muted)">The doc was unshared, or the link expired.</p>
    <p><a class="btn primary" href="${esc(download.href)}">${esc(download.label)}</a></p>
  </main>
</body></html>`;
}

// A Darkmown (.wd) document on the web: its source, escaped into a code block,
// under a line saying it is interactive in the Markie app.
//
// Not a static compile. The Darkmown compiler and runtime live in the
// renderer (src/lib/darkmown) and are not part of the server, whose build
// holds server/ alone; and a compiled body with no runtime would draw
// controls that do nothing when pressed. The source is the honest static
// view. Every character of it goes through esc(), never through the markdown
// pipeline, so nothing in a document can become markup here, let alone
// script, and the page's CSP (default-src 'none', no script-src) would refuse
// a script even if one did.
export const DARKMOWN_WEB_NOTE =
  "This is an interactive Markie document. Open it in the Markie app to use its controls. Here is its source.";

export function renderDarkmownSource(source: string): string {
  return `<p class="darkmown-note">${esc(DARKMOWN_WEB_NOTE)}</p>\n<pre class="darkmown-source"><code>${esc(source)}</code></pre>`;
}

// A document rendered for someone who is entitled to read it. Unlike the
// public page there is no shareable token in the markup: the URL that reached
// here belongs to one person, so nothing on the page invites passing it on.
export function renderSharedDocPage(opts: {
  title: string;
  markdown: string;
  docId: string;
  siteUrl: string;
  sharedBy?: string | null;
  canEdit: boolean;
  /**
   * Set when the reader got here through an invite email and has no account
   * yet. Making an account at this exact address and confirming it is what
   * makes claimPendingInvites hand them the document, so the address has to be
   * named rather than implied. Confirming is not an extra hurdle to mention
   * here: signing in is impossible until the address is proven, so by the time
   * they are signed in the document really is waiting for them.
   */
  invitedEmail?: string | null;
  assetUrlFor?: (ref: string) => string | null;
  docLinkFor?: (ref: string) => DocLinkAnswer;
  /** docs.format. A darkmown document is shown as its source (renderDarkmownSource). */
  format?: string;
  /** The bar's links into the web app and the account chip (HostedNav). */
  nav?: HostedNav;
}): string {
  const { title, markdown, docId, siteUrl, sharedBy, canEdit, invitedEmail } = opts;
  const darkmown = opts.format === "darkmown";
  const content = renderDocBody(markdown, opts.format, { assetUrlFor: opts.assetUrlFor, docLinkFor: opts.docLinkFor });
  const safeTitle = esc(title);
  const download = primaryDownloadCta(markieSite(siteUrl));
  const openInMarkie = `markie://doc?id=${encodeURIComponent(docId)}&src=${encodeURIComponent(siteUrl)}`;
  const nav = opts.nav ?? { webApp: false, account: null };
  const items: string[] = [];
  if (nav.webApp) {
    // Only an editor is offered the editor: a viewer's copy there is
    // read-only, and this page already is the read-only view.
    items.push(navLink("/app", "Library"), navLink("/app/new", "New document"));
    if (canEdit) items.push(button("primary", `/app/d/${encodeURIComponent(docId)}`, "Open in editor"));
    items.push(NAV_SEP);
  } else {
    items.push(button("primary", openInMarkie, "Open in Markie"));
  }
  items.push(button("ghost", download.href, download.label));
  items.push(`<a class="btn ghost" href="/d/${esc(docId)}/raw">Download ${darkmown ? ".wd" : ".md"}</a>`);
  if (nav.account) items.push(accountChip(nav.account));
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: https:; media-src * data: https:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; base-uri 'none'; form-action 'none'">
  <title>${safeTitle} · Markie</title>
  ${HEAD_CSS}
  ${BRAND_HEAD}
  <style>${PAGE_CSS}</style>${docStyle(content.css)}
</head><body>
  ${hostedBar(safeTitle, items)}
  <main>${content.html}</main>
  <div class="cta">
    ${sharedBy ? `${esc(sharedBy)} shared this with you. ` : ""}${
      canEdit
        ? "Open it in Markie to edit it with them, live."
        : "You have view access. Open it in Markie to keep a copy of your own."
    }
    ${
      invitedEmail
        ? `<div class="cta-invite">Get Markie and make an account with
             <strong>${esc(invitedEmail)}</strong>, and this document will already be
             in your Library when you sign in. Nothing to copy across.</div>`
        : ""
    }
  </div>
</body></html>`;
}

// Shown to anyone whose link does not carry access: a stranger guessing at a
// document id, or someone whose access was removed. It names no document and
// does not distinguish "no such document" from "not yours", so the page cannot
// be used to find out which document ids exist.
export function renderAccessRequiredPage(siteUrl: string, signInHref: string | null = null): string {
  const download = primaryDownloadCta(markieSite(siteUrl));
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign in to read this · Markie</title>
  ${BRAND_HEAD}
  <style>${PAGE_CSS}</style>
</head><body>
  <main style="text-align:center;padding-top:80px">
    <div class="hero-logo">${brandLogoSvg(160)}</div>
    <h1>You need access to this document</h1>
    <p style="color:var(--muted)">Markie documents are never public. ${signInHref ? "Sign in with the account it belongs to, or open the link from your invite email." : "Open the link from your invite email, or open the document in Markie with the account it was shared with."}</p>
    ${signInHref ? `<p><a class="btn primary" href="${esc(signInHref)}">Sign in</a></p>` : ""}
    <p><a class="btn ${signInHref ? "ghost" : "primary"}" href="${esc(download.href)}">${esc(download.label)}</a></p>
  </main>
</body></html>`;
}
