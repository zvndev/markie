// A shared document's `[the plan](plan.md)` names a file beside the author's
// copy. On the web that is a pointer the server may or may not let this
// reader follow. The rewrite happens here and nowhere else: the markdown the
// server stores is what the author wrote.
import { visit } from "unist-util-visit";
import { isLocal, refOf } from "./rehype-cloud-assets.ts";
import type { DocLinkAnswer } from "./doc-links.ts";

interface ElementNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
}

export const MUTED_LINK_TITLE = "This document isn't shared with you.";

export function rehypeDocLinks(linkFor: (ref: string) => DocLinkAnswer) {
  return (tree: unknown) => {
    visit(tree as never, "element", (node: ElementNode) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string" || !isLocal(href)) return;
      const ref = refOf(href);
      if (!ref) return;
      const answer = linkFor(ref);
      if (!answer) return;
      if ("href" in answer) {
        node.properties = { ...node.properties, href: answer.href };
        return;
      }
      // Muted: no href at all, so nothing is navigable, and a class and title
      // the page styles and the reader's hover can read. Both survive
      // sanitize, which allows className and title on every element.
      const rest = { ...(node.properties ?? {}) } as Record<string, unknown>;
      delete rest.href;
      const existing = Array.isArray(rest.className) ? rest.className : [];
      node.properties = { ...rest, className: [...existing, "doc-link-muted"], title: MUTED_LINK_TITLE };
    });
  };
}
