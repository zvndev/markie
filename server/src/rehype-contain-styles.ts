// A shared document may carry inline styles (span, div, p, headings, mark,
// svg keep `style` through the sanitizer: highlights, alignment, KaTeX). A
// style that takes a block out of the page's flow, or lifts it over the
// page's own chrome, lets a document draw a fake Markie screen over the real
// one on markiedocs.com: `position:fixed; inset:0; z-index:2147483647`.
//
// This runs after rehype-sanitize and drops exactly those declarations:
// `position` other than static or relative, and any `z-index`. Nothing the
// editor or KaTeX writes uses either, so documents render as before. A style
// that uses a CSS escape or a comment is dropped whole, because either can
// spell `position` or `fixed` in a way a plain match would miss, and nothing
// legitimate in a document's inline style needs one.
//
// A copy of src/lib/rehype-contain-styles.ts, for the same reason
// server/src/render.ts copies markdown-html.ts. Keep the two identical.
import { visit } from "unist-util-visit";

interface ElementNode {
  type: string;
  properties?: Record<string, unknown>;
}

const SAFE_POSITION = /^(static|relative)(\s*!\s*important)?$/;

// Splitting on every `;` finds every real declaration boundary and possibly a
// few inside quoted values, so a dangerous declaration is always seen. A style
// with none is returned untouched, so a `;` inside a url("data:...") survives.
function unsafe(decl: string): boolean {
  const colon = decl.indexOf(":");
  if (colon < 0) return false;
  const name = decl.slice(0, colon).trim().toLowerCase();
  const value = decl.slice(colon + 1).trim().toLowerCase();
  if (name === "z-index") return true;
  return name === "position" && !SAFE_POSITION.test(value);
}

export function containStyle(style: string): string | null {
  if (/[\\]|\/\*/.test(style)) return null;
  const decls = style.split(";");
  if (!decls.some(unsafe)) return style;
  const kept = decls.map((decl) => decl.trim()).filter((decl) => decl && !unsafe(decl));
  return kept.length ? kept.join("; ") : null;
}

export function rehypeContainStyles() {
  return (tree: unknown) => {
    visit(tree as never, "element", (node: ElementNode) => {
      const style = node.properties?.style;
      if (typeof style !== "string") return;
      const safe = containStyle(style);
      if (safe === null) delete node.properties!.style;
      else node.properties!.style = safe;
    });
  };
}
