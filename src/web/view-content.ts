// What the read view draws for a document, as HTML: Markdown through the
// renderer's own sanitizing pipeline (src/lib/markdown-html.ts, kept in step
// with the hosted page's, server/src/render.ts), plain text escaped into a
// preformatted block. A document's own pictures are reached through its asset
// route on the API origin, as on the hosted page (rehype-cloud-assets.ts).
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { isDocHref } from "@/lib/doc-links";

const MEDIA = "img[src], video[src], audio[src], source[src]";

/** A reference a document wrote to a file beside it, not a URL. */
export function isLocalMediaSrc(src: string): boolean {
  return !!src && !src.startsWith("//") && !src.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

/** The reference as the asset table stores it: percent decoded, no query or fragment. */
export function mediaRef(src: string): string {
  const bare = src.trim().split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/** Where one of a document's own files is read from. */
export type AssetUrl = (ref: string) => string;

export function memberAssetUrl(apiOrigin: string, id: string): AssetUrl {
  return (ref) => `${apiOrigin}/d/${encodeURIComponent(id)}/assets?ref=${encodeURIComponent(ref)}`;
}

export function publicAssetUrl(apiOrigin: string, token: string): AssetUrl {
  return (ref) => `${apiOrigin}/s/${encodeURIComponent(token)}/assets?ref=${encodeURIComponent(ref)}`;
}

/**
 * Points every local media reference at the document's asset route. Done on
 * an inert template, after sanitizing, so nothing is fetched from the page's
 * own host on the way and nothing the document wrote can add an attribute.
 */
export function withAssetUrls(html: string, assetUrl: AssetUrl, doc: Document = document): string {
  const template = doc.createElement("template");
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll<HTMLElement>(MEDIA))) {
    const src = element.getAttribute("src") ?? "";
    if (isLocalMediaSrc(src)) element.setAttribute("src", assetUrl(mediaRef(src)));
  }
  return template.innerHTML;
}

/**
 * Where a link from this document to another one leads for this reader, keyed
 * by the reference as the pointer table stores it (mediaRef): a page they may
 * open, or a muted link. The server decides, with the same rules as the hosted
 * pages (server/src/doc-links.ts sharedPageLinkFor, publicPageLinkFor).
 */
export type ViewLink = { href: string } | { muted: true };
export type ViewLinks = ReadonlyMap<string, ViewLink>;

export const NOT_SHARED_TITLE = "This document isn't shared with you.";
export const NOT_IN_CLOUD_TITLE = "This page isn't in Markie Cloud, so it can't open here.";

// The pointer answers are paths on the docs host: /d/<id> or /s/<token>.
const VIEW_PATH = /^\/(d|s)\/[A-Za-z0-9_-]{1,256}$/;

/**
 * Points every link to another document at the page this reader may open, the
 * way the hosted pages do (server/src/rehype-doc-links.ts). `[step 1](step-1.md)`
 * as written resolves against /d/<id> to a path no route knows, which the web
 * app answers with the Library. A link to a document with no pointer, or one
 * this reader may not open, is muted: no href, a title that says why.
 * Done on an inert template after sanitizing, like withAssetUrls.
 */
export function withDocLinks(html: string, links: ViewLinks, doc: Document = document): string {
  const template = doc.createElement("template");
  template.innerHTML = html;
  for (const anchor of Array.from(template.content.querySelectorAll<HTMLAnchorElement>("a"))) {
    // Only this function mutes a link: an author's own class does not get to.
    anchor.classList.remove("doc-link-muted");
    if (!anchor.classList.length) anchor.removeAttribute("class");
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!isLocalMediaSrc(href)) continue;
    const ref = mediaRef(href);
    if (!ref) continue;
    const answer = links.get(ref);
    if (answer && "href" in answer && VIEW_PATH.test(answer.href)) {
      anchor.setAttribute("href", answer.href);
      continue;
    }
    if (!answer && !isDocHref(href)) continue;
    anchor.removeAttribute("href");
    anchor.classList.add("doc-link-muted");
    anchor.setAttribute("title", answer ? NOT_SHARED_TITLE : NOT_IN_CLOUD_TITLE);
  }
  return template.innerHTML;
}

/** The server's answer to GET /api/docs/:id/links or /s/:token/links, as a ViewLinks. */
export function parseViewLinks(data: unknown, hrefFor: (target: string) => string): ViewLinks {
  const out = new Map<string, ViewLink>();
  const rows = (data as { links?: unknown } | null)?.links;
  if (!Array.isArray(rows)) return out;
  for (const row of rows as Record<string, unknown>[]) {
    if (typeof row?.ref !== "string" || !row.ref) continue;
    if (typeof row.target === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(row.target)) out.set(row.ref, { href: hrefFor(row.target) });
    else if (typeof row.href === "string" && VIEW_PATH.test(row.href)) out.set(row.ref, { href: row.href });
    else out.set(row.ref, { muted: true });
  }
  return out;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"));

export type ViewTextKind = "markdown" | "text";

export function viewHtml(kind: ViewTextKind, text: string, assetUrl: AssetUrl | null, links: ViewLinks | null = null): string {
  if (kind === "text") return `<pre class="markie-view-text">${escapeHtml(text)}</pre>`;
  let html = renderMarkdownHTML(text);
  if (assetUrl) html = withAssetUrls(html, assetUrl);
  return links ? withDocLinks(html, links) : html;
}
