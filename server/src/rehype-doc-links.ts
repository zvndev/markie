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

export function rehypeDocLinks(linkFor: (ref: string) => DocLinkAnswer = () => null) {
  return (tree: unknown) => {
    visit(tree as never, "element", (node: ElementNode) => {
      if (node.tagName !== "a") return;
      // An author's own `class="doc-link-muted"` would otherwise ride along
      // unchanged on every early return below (including the `{ href }`
      // rewrite), rendering muted while still navigating. Scrubbed up front,
      // it is appended again below only when this plugin is the one muting.
      const cls = Array.isArray(node.properties?.className) ? node.properties.className : [];
      const clean = cls.filter((c) => c !== "doc-link-muted");
      if (clean.length !== cls.length) node.properties = { ...node.properties, className: clean };
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
