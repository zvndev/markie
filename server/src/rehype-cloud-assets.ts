// A shared document's `![](shots/a.png)` names a file beside the author's
// copy. On the web that file is one of the document's assets, reached by the
// same reference through the page's own asset route. The rewrite happens here
// and nowhere else: the markdown the server stores is what the author wrote.
import { visit } from "unist-util-visit";

interface ElementNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
}

const MEDIA_TAGS = new Set(["img", "video", "audio", "source"]);

function isLocal(src: string): boolean {
  return !!src && !src.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

// The reference a document wrote, as the asset table stores it: percent
// decoded, query and fragment kept off.
export function refOf(src: string): string {
  const bare = src.trim().split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

export function rehypeCloudAssets(assetUrlFor: (ref: string) => string | null) {
  return (tree: unknown) => {
    visit(tree as never, "element", (node: ElementNode) => {
      if (!node.tagName || !MEDIA_TAGS.has(node.tagName)) return;
      const src = node.properties?.src;
      if (typeof src !== "string" || !isLocal(src)) return;
      const url = assetUrlFor(refOf(src));
      if (url) node.properties = { ...node.properties, src: url };
    });
  };
}
