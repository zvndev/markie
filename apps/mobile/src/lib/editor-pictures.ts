// The pictures a cloud document's author synced beside it, for the rich
// editor. The reader fetches them with the session token and shows them as
// blob: URLs (markdown-view.tsx); the editor is the desktop's TipTap view,
// which asks src/lib/asset-url.ts to resolve a relative src while it draws.
// Left alone, that resolved against the app's own address and drew a broken
// picture (Android) or nothing (iOS). So before the editor first draws, the
// same pictures are fetched the same way and handed to it by reference.
// The document keeps its references as written; only what is drawn changes.
import { useEffect, useState } from "react";
import { setAssetResolver } from "@/lib/asset-url";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { splitFrontMatter } from "@/lib/front-matter";
import { prepareDocumentHtml } from "./document-html";

// As the reader: a few at a time, each held until its picture decodes.
const CONCURRENCY = 3;
// The editor opens without the slowest pictures rather than waiting on them.
const WAIT_MS = 4_000;

/** The document's own pictures, by reference, exactly as the reader finds them. */
export function pictureRefs(markdown: string): string[] {
  return prepareDocumentHtml(renderMarkdownHTML(splitFrontMatter(markdown).body)).assets;
}

/**
 * Fetches the pictures and points the editor's resolver at them for as long
 * as the screen is up. Returns false until they arrived or the wait ran out;
 * the editor holds its first draw until then, because a picture drawn broken
 * is not redrawn when its bytes arrive later.
 */
export function useEditorPictures(load: ((ref: string) => Promise<Blob | null>) | null, markdown: string): boolean {
  const [refs] = useState(() => (load ? pictureRefs(markdown) : []));
  const [ready, setReady] = useState(refs.length === 0);
  useEffect(() => {
    if (!load || refs.length === 0) return;
    let live = true;
    const urls = new Map<string, string>();
    setAssetResolver((ref) => urls.get(ref) ?? ref);
    const queue = [...refs];
    const worker = async () => {
      while (live && queue.length) {
        const ref = queue.shift()!;
        try {
          const blob = await load(ref);
          if (live && blob) urls.set(ref, URL.createObjectURL(blob));
        } catch {
          // Drawn as it was before: one missing picture never holds the rest.
        }
      }
    };
    const timer = setTimeout(() => { if (live) setReady(true); }, WAIT_MS);
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).then(() => {
      clearTimeout(timer);
      if (live) setReady(true);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      setAssetResolver(null);
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
    // The draft is fixed for the screen's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ready;
}
