// A markdown document, rendered by the desktop's own pipeline
// (src/lib/markdown-html.ts: GFM, math, highlighting, media and video cards,
// then the same hardened sanitizer the share pages use) and styled by the
// desktop's own `.markdown-body` rules. Nothing here renders markdown itself.
// The phone's own last pass (src/lib/document-html.ts) keeps the document out
// of the app's chrome and loads the pictures the author's Markie synced.
import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { splitFrontMatter } from "@/lib/front-matter";
import { ASSET_ATTR, ASSET_STATE_ATTR, markAssetMissing, prepareDocumentHtml } from "../lib/document-html";

// A few at a time: each answer is held in memory until its picture decodes.
const ASSET_CONCURRENCY = 3;

interface MarkdownViewProps {
  content: string;
  /** Every link tap comes here; the view never navigates on its own. */
  onLink: (href: string | null, anchor: HTMLAnchorElement) => void;
  /** One of the document's own pictures, by the ref it wrote, or null. */
  loadAsset?: (ref: string) => Promise<Blob | null>;
}

export function MarkdownView({ content, onLink, loadAsset }: MarkdownViewProps) {
  // Front matter is metadata for agents and the desktop's taxonomy, not prose:
  // the desktop holds it aside from the rich view, and so does this.
  const prepared = useMemo(() => prepareDocumentHtml(renderMarkdownHTML(splitFrontMatter(content).body)), [content]);
  const article = useRef<HTMLElement>(null);
  const loadRef = useRef(loadAsset);
  loadRef.current = loadAsset;

  useEffect(() => {
    const root = article.current;
    const load = loadRef.current;
    if (!root || !prepared.assets.length) return;
    let live = true;
    const urls: string[] = [];
    const queue = [...prepared.assets];
    const settle = (ref: string, url: string | null) => {
      for (const img of Array.from(root.querySelectorAll<HTMLImageElement>(`img[${ASSET_ATTR}]`))) {
        if (img.getAttribute(ASSET_ATTR) !== ref) continue;
        if (url) {
          img.addEventListener("load", () => img.setAttribute(ASSET_STATE_ATTR, "ready"), { once: true });
          img.addEventListener("error", () => markAssetMissing(img), { once: true });
          img.src = url;
        } else {
          markAssetMissing(img);
        }
      }
    };
    const worker = async () => {
      while (live && queue.length) {
        const ref = queue.shift()!;
        const blob = load ? await load(ref).catch(() => null) : null;
        if (!live) return;
        const url = blob ? URL.createObjectURL(blob) : null;
        if (url) urls.push(url);
        settle(ref, url);
      }
    };
    void Promise.all(Array.from({ length: Math.min(ASSET_CONCURRENCY, queue.length) }, worker));
    return () => {
      live = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [prepared]);

  function onClick(event: MouseEvent<HTMLElement>) {
    const anchor = (event.target as Element).closest?.("a");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    onLink(anchor.getAttribute("href"), anchor);
  }

  return (
    <article
      ref={article}
      className="markdown-body m-markdown"
      onClick={onClick}
      // Sanitized by renderMarkdownHTML's rehype-sanitize schema, then
      // narrowed by prepareDocumentHtml.
      dangerouslySetInnerHTML={{ __html: prepared.html }}
    />
  );
}
