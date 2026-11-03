// What the read view draws for a document, as HTML: Markdown through the
// renderer's own sanitizing pipeline (src/lib/markdown-html.ts, kept in step
// with the hosted page's, server/src/render.ts), plain text escaped into a
// preformatted block. A document's own pictures are reached through its asset
// route on the API origin, as on the hosted page (rehype-cloud-assets.ts).
import { renderMarkdownHTML } from "@/lib/markdown-html";

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

const escapeHtml = (value: string) =>
  value.replace(/[&<>"]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"));

export type ViewTextKind = "markdown" | "text";

export function viewHtml(kind: ViewTextKind, text: string, assetUrl: AssetUrl | null): string {
  if (kind === "text") return `<pre class="markie-view-text">${escapeHtml(text)}</pre>`;
  const html = renderMarkdownHTML(text);
  return assetUrl ? withAssetUrls(html, assetUrl) : html;
}
