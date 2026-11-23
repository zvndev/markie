// A markdown document, rendered by the desktop's own pipeline
// (src/lib/markdown-html.ts: GFM, math, highlighting, media and video cards,
// then the same hardened sanitizer the share pages use) and styled by the
// desktop's own `.markdown-body` rules. Nothing here renders markdown itself.
// The phone's own last pass (src/lib/document-html.ts) keeps the document out
// of the app's chrome and loads the pictures the author's Markie synced.
//
// Comments are drawn over that HTML, not into it: each open thread's quoted
// words are found in the rendered text and wrapped in a <mark>, and a
// selection is read back as the same kind of quote (lib/reading-comments.ts).
import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { splitFrontMatter } from "@/lib/front-matter";
import { describeQuote, locateQuote, type Quote } from "@/lib/quote-anchor";
import { ASSET_ATTR, ASSET_STATE_ATTR, markAssetMissing, prepareDocumentHtml } from "../lib/document-html";
import { THREAD_MARK_ATTR, applyMarks, clearMarks, flattenDom, rangeOffsets, threadAt, type FlatDom, type Placement } from "../lib/reading-comments";

// A few at a time: each answer is held in memory until its picture decodes.
const ASSET_CONCURRENCY = 3;
// A selection settles for this long before it is read: dragging a handle
// fires a change for every character.
const SELECTION_SETTLE_MS = 120;

/** A thread to find in the document by the words it quotes. */
export interface ThreadQuote {
  id: string;
  quote: Quote;
  /** Open threads are highlighted. Resolved ones are only looked for. */
  highlight: boolean;
}

export interface MarkdownComments {
  threads: readonly ThreadQuote[];
  /** After every pass: the threads whose words are in the document. */
  onPlaced: (ids: ReadonlySet<string>) => void;
  /** A highlight was tapped. */
  onThread: (id: string) => void;
  /** The reader's selection inside the document, as a quote, or null when there is none. */
  onSelect: (quote: Quote | null) => void;
}

interface MarkdownViewProps {
  content: string;
  /** Every link tap comes here; the view never navigates on its own. */
  onLink: (href: string | null, anchor: HTMLAnchorElement) => void;
  /** One of the document's own pictures, by the ref it wrote, or null. */
  loadAsset?: (ref: string) => Promise<Blob | null>;
  /** Present on a document that takes comments. */
  comments?: MarkdownComments;
}

/** Scrolls a thread's highlight into view and flashes it. False when it has none. */
export function showThreadMark(root: ParentNode | null, id: string): boolean {
  const marks = Array.from(root?.querySelectorAll<HTMLElement>(`mark[${THREAD_MARK_ATTR}]`) ?? []).filter((mark) => mark.getAttribute(THREAD_MARK_ATTR) === id);
  if (!marks.length) return false;
  marks[0].scrollIntoView?.({ behavior: "smooth", block: "center" });
  for (const mark of marks) {
    mark.classList.add("is-shown");
    setTimeout(() => mark.classList.remove("is-shown"), 1600);
  }
  return true;
}

export function MarkdownView({ content, onLink, loadAsset, comments }: MarkdownViewProps) {
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

  // ── Comments ──────────────────────────────────────────────────────────
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const marks = useRef<HTMLElement[]>([]);
  // The document's text as last read. Marking splits text nodes, so it is
  // read again after every pass and only then trusted for a selection.
  const flat = useRef<FlatDom | null>(null);
  // The threads polled every few seconds are new objects each time. Marking
  // again would take the reader's selection away, so it happens only when
  // what there is to mark has changed.
  const wanted = comments ? JSON.stringify(comments.threads) : null;

  useEffect(() => {
    const root = article.current;
    if (!root) return;
    clearMarks(marks.current);
    marks.current = [];
    flat.current = null;
    if (wanted === null) return;
    const threads = JSON.parse(wanted) as ThreadQuote[];
    const text = flattenDom(root);
    const placed = new Set<string>();
    const placements: Placement[] = [];
    for (const thread of threads) {
      const range = locateQuote(text.text, thread.quote);
      if (!range) continue;
      placed.add(thread.id);
      if (thread.highlight) placements.push({ id: thread.id, ...range });
    }
    if (placements.length) {
      marks.current = applyMarks(text, placements);
      flat.current = flattenDom(root);
    } else {
      flat.current = text;
    }
    commentsRef.current?.onPlaced(placed);
  }, [prepared, wanted]);

  const takesComments = !!comments;
  useEffect(() => {
    if (!takesComments) return;
    const doc = article.current?.ownerDocument;
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const root = article.current;
      const selection = doc.getSelection();
      if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) { commentsRef.current?.onSelect(null); return; }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) { commentsRef.current?.onSelect(null); return; }
      const text = flat.current ?? (flat.current = flattenDom(root));
      const offsets = rangeOffsets(text, range);
      commentsRef.current?.onSelect(offsets ? describeQuote(text.text, offsets.start, offsets.end) : null);
    };
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(read, SELECTION_SETTLE_MS);
    };
    doc.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(timer);
      doc.removeEventListener("selectionchange", onChange);
    };
  }, [takesComments]);

  function onClick(event: MouseEvent<HTMLElement>) {
    const anchor = (event.target as Element).closest?.("a");
    if (anchor && event.currentTarget.contains(anchor)) {
      event.preventDefault();
      onLink(anchor.getAttribute("href"), anchor);
      return;
    }
    // A tap on a highlight opens its thread. A tap that ends a selection is
    // the reader choosing words, not asking for the thread under them.
    const thread = threadAt(event.target, marks.current);
    if (thread && (article.current?.ownerDocument.getSelection()?.isCollapsed ?? true)) commentsRef.current?.onThread(thread);
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
