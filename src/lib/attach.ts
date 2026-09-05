// Dropping a file onto a document.
//
// The rule, in one line: link the file where it already lives. Markie does not
// copy it into a bundle, does not move it, and does not rewrite the document
// later if you move it yourself. A relative link when the file sits under the
// document's folder, because that pair survives being zipped up and sent on,
// and an absolute path otherwise, because a link that points at a real file on
// this machine beats a tidy link that points at nothing.
//
// Reaching the file is a separate question from naming it: the address here is
// only an address, and electron/file-grants.js decides whether it may be read.

import { mediaKindOf, type MediaKind } from "@/lib/asset-url";

export type AttachmentKind = MediaKind | "file";

export type Attachment = {
  kind: AttachmentKind;
  /** What gets written into the markdown. */
  href: string;
  /** What the reader sees: the alt text, or the link's words. */
  label: string;
};

// Anything Markie can draw in place gets the image syntax, because markdown has
// exactly one embed syntax and `![](clip.mp4)` is what a person writes. Every
// other file is a link, which is the honest thing to say about a zip.
const EMBEDDABLE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|mp4|m4v|webm|ogv|mov|mp3|m4a|aac|wav|flac|oga|opus)$/i;

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

export function basenameOf(absPath: string): string {
  const parts = normalize(absPath).split("/");
  return parts[parts.length - 1] || absPath;
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The path to write for `absPath` in a document saved in `docDir`: relative
 * when the file is inside that folder, absolute when it is anywhere else.
 * Returns null for a document that has never been saved, which has no folder
 * to be relative to.
 */
export function hrefFor(absPath: string, docDir: string | null): string {
  const abs = normalize(absPath);
  if (!docDir) return abs;
  const dir = normalize(docDir).replace(/\/+$/, "");
  if (!dir) return abs;

  // Windows compares paths without regard to case, POSIX does not, and getting
  // this backwards either misses a relative link or invents a wrong one.
  const windows = /^[a-z]:/i.test(abs) || /^[a-z]:/i.test(dir);
  const fold = (s: string) => (windows ? s.toLowerCase() : s);
  if (!fold(abs).startsWith(`${fold(dir)}/`)) return abs;

  const rest = abs.slice(dir.length + 1);
  return rest || abs;
}

/** What to insert for a file the user dropped onto a document. */
export function attachmentFor(absPath: string, docDir: string | null): Attachment {
  const name = basenameOf(absPath);
  const href = hrefFor(absPath, docDir);
  if (!EMBEDDABLE.test(name)) return { kind: "file", href, label: name };
  const kind = mediaKindOf(name);
  return { kind, href, label: stemOf(name) };
}

/**
 * The document content for an attachment. Media is the image node whatever it
 * plays, because that node is what the markdown serializer writes `![]()` from;
 * only LocalImage's renderHTML differs, so the file on disk stays plain
 * markdown that any other editor opens.
 */
export function attachmentContent(attachment: Attachment): Record<string, unknown>[] {
  if (attachment.kind === "file") {
    return [
      {
        type: "text",
        text: attachment.label,
        marks: [{ type: "link", attrs: { href: attachment.href } }],
      },
      // A plain space after the link, so the next thing typed is not swallowed
      // into it. Without this the caret sits inside the mark and the sentence
      // you write next becomes part of the link text.
      { type: "text", text: " " },
    ];
  }
  return [{ type: "image", attrs: { src: attachment.href, alt: attachment.label } }];
}

// The types Markie opens as documents. Dropping one of these anywhere in the
// app has always meant "open this", and it still does; everything else is an
// attachment. Mirrors OPENABLE in electron/file-grants.js, which is the side
// that actually enforces it.
const OPENS_AS_DOCUMENT = /\.(md|markdown|mdx|txt|csv)$/i;

export function opensAsDocument(name: string): boolean {
  return OPENS_AS_DOCUMENT.test(name);
}

// Image and link targets in a markdown document, both `![a](x)` and `[a](x)`,
// including the angle-bracket form a path with spaces needs.
const MD_TARGET = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)/g;
// A picture or clip with a chosen width is written as its HTML tag
// (rich-media-html.ts), and it is just as absent from a share as one written
// with the markdown syntax.
const HTML_SRC = /<(?:img|video|audio|source)\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;

/**
 * How many things the document points at that live on this machine.
 *
 * Sharing a document sends its text, and nothing else. A picture beside it on
 * disk is not in the text, so the person who opens the link sees a hole where
 * it was. Counting them is what lets the share dialog say so out loud instead
 * of letting somebody find out from the recipient.
 */
export function localAssetCount(markdown: string): number {
  const seen = new Set<string>();
  const text = String(markdown ?? "");
  const targets: string[] = [];
  for (const match of text.matchAll(MD_TARGET)) {
    let target = match[1];
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    targets.push(target);
  }
  for (const match of text.matchAll(HTML_SRC)) {
    targets.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  for (const target of targets) {
    if (!target) continue;
    // Anything that names where it lives travels fine: a URL is a URL from
    // anywhere, and an inlined data URI is carried in the text itself.
    if (target.startsWith("#") || target.startsWith("//")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    // Another document in the same set is a link, not an asset, and following
    // it is the reader's problem rather than a missing picture.
    if (opensAsDocument(target.split("#")[0].split("?")[0])) continue;
    seen.add(target);
  }
  return seen.size;
}
