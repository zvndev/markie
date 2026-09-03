// Markdown's one embed syntax is the image one, so `![](clip.mp4)` is what a
// person writes and what an agent produces. remark turns that into an <img>,
// which renders as a broken picture rather than a player.
//
// This rewrites those nodes by extension, so the export matches what the app
// draws and the markdown on disk stays plain markdown: no Markie-only
// directive, and the file still opens elsewhere as the image reference it
// already was.
//
// Kept as its own plugin because both the app pipeline and the server's share
// renderer need it and the two deliberately do not import each other.
import { visit } from "unist-util-visit";

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|oga|opus)(\?|#|$)/i;

export function mediaTagFor(src: unknown): "video" | "audio" | null {
  const raw = typeof src === "string" ? src.trim() : "";
  if (!raw) return null;
  if (VIDEO_EXT.test(raw)) return "video";
  if (AUDIO_EXT.test(raw)) return "audio";
  return null;
}

interface ElementNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: unknown[];
}

export function rehypeMedia() {
  return (tree: unknown) => {
    visit(tree as never, "element", (node: ElementNode) => {
      if (node.tagName !== "img") return;
      const tag = mediaTagFor(node.properties?.src);
      if (!tag) return;
      node.tagName = tag;
      node.properties = {
        src: node.properties?.src,
        controls: true,
        // Opening a document with five clips in it should not pull five whole
        // files off the disk before a word has been read.
        preload: "metadata",
      };
      // <video> is not a void element, and an alt attribute means nothing on
      // one. The text becomes the fallback a browser shows if it cannot play.
      const alt = node.properties?.src && typeof node.properties.src === "string" ? "" : "";
      node.children = alt ? [{ type: "text", value: alt }] : [];
    });
  };
}
