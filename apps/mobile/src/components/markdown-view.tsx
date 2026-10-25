// A markdown document, rendered by the desktop's own pipeline
// (src/lib/markdown-html.ts: GFM, math, highlighting, media and video cards,
// then the same hardened sanitizer the share pages use) and styled by the
// desktop's own `.markdown-body` rules. Nothing here renders markdown itself.
import { useMemo, type MouseEvent } from "react";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { splitFrontMatter } from "@/lib/front-matter";

interface MarkdownViewProps {
  content: string;
  /** Every link tap comes here; the view never navigates on its own. */
  onLink: (href: string | null, anchor: HTMLAnchorElement) => void;
}

export function MarkdownView({ content, onLink }: MarkdownViewProps) {
  // Front matter is metadata for agents and the desktop's taxonomy, not prose:
  // the desktop holds it aside from the rich view, and so does this.
  const html = useMemo(() => renderMarkdownHTML(splitFrontMatter(content).body), [content]);

  function onClick(event: MouseEvent<HTMLElement>) {
    const anchor = (event.target as Element).closest?.("a");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    onLink(anchor.getAttribute("href"), anchor);
  }

  return (
    <article
      className="markdown-body m-markdown"
      onClick={onClick}
      // Sanitized by renderMarkdownHTML's rehype-sanitize schema.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
