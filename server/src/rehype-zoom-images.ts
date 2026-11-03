// Pictures that enlarge on the static document pages, with no script: the
// pages' policy runs none (render.ts). Each picture becomes the label of a
// visually hidden checkbox; checking it shows the same picture over the whole
// window, and a click anywhere on that layer unchecks it. The checkbox is a
// real keyboard stop (Space opens and closes), and everything here is
// phrasing content, so a picture inside a paragraph stays in it.
//
// Escape does not close it; that would need a script. The web read view
// (src/web/doc-view.tsx) has the full viewer.
//
// Runs after sanitizing, on the sanitized tree, so nothing a document writes
// can produce or reach this markup. A picture inside a link is left alone:
// clicking it follows the link.
import { visit } from "unist-util-visit";

interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  value?: string;
}

const el = (tagName: string, properties: Record<string, unknown>, children: Node[] = []): Node => ({ type: "element", tagName, properties, children });

export function rehypeZoomImages() {
  return (tree: unknown) => {
    let n = 0;
    visit(tree as never, "element", (node: Node, index: number | undefined, parent: Node | undefined) => {
      if (node.tagName !== "img" || !parent || index === undefined) return;
      if (typeof node.properties?.src !== "string" || !node.properties.src) return;
      // Skip pictures in links (and video cards, which are links), and any
      // already wrapped.
      if (insideLink(tree as Node, node)) return;
      const id = `markie-zoom-${++n}`;
      const alt = typeof node.properties.alt === "string" ? node.properties.alt.trim() : "";
      const full = el("img", { src: node.properties.src, alt: "" });
      const wrapped = el("span", { className: ["markie-zoom"] }, [
        el("input", { type: "checkbox", id, className: ["markie-zoom-toggle"], ariaLabel: alt ? `Enlarge picture: ${alt}` : "Enlarge picture" }),
        el("label", { htmlFor: id, className: ["markie-zoom-thumb"] }, [node]),
        el("label", { htmlFor: id, className: ["markie-zoom-full"], ariaHidden: "true" }, [full]),
      ]);
      parent.children![index] = wrapped;
      return ["skip", index + 1] as never;
    });
  };
}

function insideLink(root: Node, target: Node): boolean {
  const path: Node[] = [];
  const find = (node: Node): boolean => {
    if (node === target) return true;
    for (const child of node.children ?? []) {
      path.push(node);
      if (find(child)) return true;
      path.pop();
    }
    return false;
  };
  find(root);
  return path.some((node) => node.tagName === "a" || node.tagName === "label");
}

/** The styles the static pages need for it (render.ts PAGE_CSS). */
export const ZOOM_CSS = `
  .markie-zoom { position: relative; display: inline; }
  .markie-zoom-toggle { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
  .markie-zoom-thumb { cursor: zoom-in; }
  .markie-zoom-toggle:focus-visible + .markie-zoom-thumb img { outline: 2px solid var(--brand-red); outline-offset: 3px; }
  .markie-zoom-full { display: none; }
  .markie-zoom-toggle:checked ~ .markie-zoom-full { display: flex; position: fixed; inset: 0; z-index: 60; align-items: center;
    justify-content: center; padding: 24px; background: rgba(10, 10, 12, 0.88); cursor: zoom-out; }
  .markie-zoom-full img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
  @media print { .markie-zoom-full { display: none !important; } }`;
