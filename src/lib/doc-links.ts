// Which links in the rendered document lead to another document, and what
// each one is for this reader. Main answers (electron/doc-link-open.js);
// this marks the anchors so a link this account may not follow reads as
// muted before anyone clicks, and the click handler in local-link.ts knows
// which door to use.
import { getSafeAPI, type DocLinkKind } from "@/lib/electron";
import { localLinkTarget } from "@/lib/local-link";

export const NOT_SHARED = "This document isn't shared with you.";

const DOC_EXT = /\.(md|markdown|mdx|txt)$/i;

/** A local href whose reference, without query or fragment, names a document. */
export function isDocHref(href: string): boolean {
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
  const bare = raw.split("#")[0].split("?")[0];
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    /* keep it as written */
  }
  return DOC_EXT.test(decoded);
}

export async function markDocLinks(root: ParentNode, docPath: string | null): Promise<void> {
  const api = getSafeAPI();
  if (!api?.resolveDocLinks || !docPath) return;
  const anchors: { el: HTMLAnchorElement; href: string }[] = [];
  for (const el of Array.from(root.querySelectorAll("a"))) {
    const href = localLinkTarget(el);
    if (href && isDocHref(href)) anchors.push({ el, href });
  }
  if (anchors.length === 0) return;
  const hrefs = [...new Set(anchors.map((a) => a.href))];
  let answers;
  try {
    answers = await api.resolveDocLinks({ docPath, hrefs });
  } catch {
    return;
  }
  const kinds = new Map<string, DocLinkKind>();
  for (const a of Array.isArray(answers) ? answers : []) kinds.set(a.href, a.kind);
  for (const { el, href } of anchors) {
    const kind = kinds.get(href) ?? "unknown";
    el.dataset.docLink = kind;
    if (kind === "none" && !el.title) el.title = NOT_SHARED;
  }
}
