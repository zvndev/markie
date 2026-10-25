// The phone's last pass over a document's HTML, after the desktop's shared
// sanitizer (src/lib/markdown-html.ts) has run and before it reaches the page.
//
// The sanitizer keeps `class` everywhere and `style` on a few blocks, which is
// what the desktop and the share pages want. On the phone the document shares
// one page with the app's own chrome, so two things change here and only here:
//
// - The app's own class names (every one starts with `m-`) come off the
//   document's elements. A document can't dress itself as a sign-in screen,
//   a badge or a nav bar. `.m-markdown` (styles.css) also contains paint and
//   positioning, so even a styled `position: fixed` stays inside the article.
// - A picture the author's Markie synced (`![](shots/a.png)`) names a file
//   beside the author's copy. The server's web view rewrites that to the
//   document's asset route (server/src/rehype-cloud-assets.ts, doc-view.ts
//   assetUrlFor); the phone does the same, but fetches it natively with the
//   session token and shows it as a blob: URL (markdown-view.tsx). Until then
//   the image has no src, so the web view never asks capacitor://localhost
//   for a file that isn't there.

export const ASSET_ATTR = "data-markie-asset";
export const ASSET_STATE_ATTR = "data-markie-asset-state";
/** A document with more pictures than this shows the first ones. */
export const MAX_DOCUMENT_ASSETS = 60;

const APP_CLASS = /^m-/;
export const TABLE_SCROLL_CLASS = "m-table-scroll";
export const ASSET_MISSING_CLASS = "m-asset-missing";

/** The server's own test (rehype-cloud-assets.ts isLocal): no scheme, not protocol-relative. */
export function isLocalRef(src: string): boolean {
  return !!src && !src.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

/** The reference as the server's asset table stores it: percent decoded, query and fragment off. */
export function refOf(src: string): string {
  const bare = src.trim().split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

export interface PreparedHtml {
  html: string;
  /** Distinct asset refs, in document order, at most MAX_DOCUMENT_ASSETS. */
  assets: string[];
}

export function prepareDocumentHtml(html: string, doc: Document = document): PreparedHtml {
  const template = doc.createElement("template");
  template.innerHTML = html;
  const root = template.content;

  for (const el of Array.from(root.querySelectorAll("[class]"))) {
    const kept = Array.from(el.classList).filter((name) => !APP_CLASS.test(name));
    if (kept.length) el.setAttribute("class", kept.join(" "));
    else el.removeAttribute("class");
  }

  // Only this pass marks pictures to load.
  for (const el of Array.from(root.querySelectorAll(`[${ASSET_ATTR}], [${ASSET_STATE_ATTR}]`))) {
    el.removeAttribute(ASSET_ATTR);
    el.removeAttribute(ASSET_STATE_ATTR);
  }

  const assets: string[] = [];
  for (const img of Array.from(root.querySelectorAll("img[src]"))) {
    const src = img.getAttribute("src") ?? "";
    if (!isLocalRef(src.trim())) continue;
    const ref = refOf(src);
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    if (!ref || (!assets.includes(ref) && assets.length >= MAX_DOCUMENT_ASSETS)) {
      markAssetMissing(img, doc);
      continue;
    }
    img.setAttribute(ASSET_ATTR, ref);
    img.setAttribute(ASSET_STATE_ATTR, "loading");
    if (!assets.includes(ref)) assets.push(ref);
  }

  // Every table in a scroller of its own. Added after the class pass, so the
  // only `m-` classes left in a document are the ones this file puts there.
  for (const table of Array.from(root.querySelectorAll("table"))) {
    const scroller = doc.createElement("div");
    scroller.className = TABLE_SCROLL_CLASS;
    table.replaceWith(scroller);
    scroller.append(table);
  }

  return { html: template.innerHTML, assets };
}

/**
 * A picture that can't be shown becomes a quiet line naming it, rather than
 * a broken-image icon or a gap the reader can't see.
 */
export function markAssetMissing(img: Element, doc: Document = document): void {
  const note = doc.createElement("span");
  note.className = ASSET_MISSING_CLASS;
  note.setAttribute("role", "img");
  const alt = (img.getAttribute("alt") ?? "").trim();
  note.textContent = alt ? `Picture not available: ${alt}` : "Picture not available";
  note.setAttribute("aria-label", note.textContent);
  img.replaceWith(note);
}
