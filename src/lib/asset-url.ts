// Turning a document's own image reference into something the renderer can load.
//
// A relative src like `demo/shot.png` resolves against the renderer's origin,
// which is `app://markie/`, so it asks the bundled-output handler for a file
// that was never in the bundle and gets a 403. Every other markdown tool
// resolves it against the document's folder, which is what an author means and
// what an agent writing a report produces without being told.
//
// So the src is rewritten to
// `markie-asset://local/<absolute path>?doc=<document path>&ref=<reference as
// written>` on the way into the DOM, and only there. The document on disk is
// untouched: the editor keeps the original in the node's attribute, so what
// gets saved is what was written. Main decides whether to actually serve it;
// this side only addresses it, and an address is not a permission. The `doc`
// query names the document the reference belongs to, so main can look for the
// picture on that one cloud document when the file itself is not on this
// machine. The document and not its folder: two synced documents can share a
// folder and reference the same missing picture, and a folder let main answer
// with whichever of them happened to be opened last. The `ref` query is that
// reference as the markdown wrote it, which is the name the server holds the
// picture under.

import { pathDirname } from "@/lib/path-utils";

export const ASSET_SCHEME = "markie-asset";
const ASSET_ORIGIN = `${ASSET_SCHEME}://local`;

// The path of the document on screen. Module scope rather than a prop because
// the value is needed inside a ProseMirror node's renderHTML, which is called
// by the editor with no access to React state, and because it changes when a
// different file is opened rather than when a component re-renders.
let docPath: string | null = null;

export function setAssetDocPath(path: string | null): void {
  docPath = path && path.trim() ? path : null;
}

/** The folder of the document on screen, which is what a relative src
 * resolves against. */
export function getAssetBaseDir(): string | null {
  return docPath ? pathDirname(docPath) : null;
}

// Windows paths and POSIX paths both arrive here, and the renderer has no
// node:path. Normalising to forward slashes is enough for the join, and main
// resolves properly on the other side.
function joinPath(dir: string, rel: string): string {
  const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = `${base}/${rel.replace(/\\/g, "/")}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" && out.length > 0) continue;
    if (part === ".") continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/") || "/";
}

// True for anything that already names where it lives: a scheme, a
// protocol-relative URL. Those are left exactly as written.
function hasScheme(src: string): boolean {
  return src.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(src);
}

/**
 * The URL to put in the DOM for a document's image reference.
 *
 * Resolves against `base` when one is handed in, else against the open
 * document's folder. A file previewed from somewhere else (a SKILL.md out of
 * the catalog cache) has its pictures beside its own file, not beside
 * whatever is open, so a handed-in base names no document: it is a folder,
 * and no one document in it is the one this picture belongs to.
 * Returns the src unchanged when it is not a local file reference, or when
 * there is nothing to resolve it against.
 */
export function resolveAssetSrc(src: string | null | undefined, base?: string | null): string {
  const raw = typeof src === "string" ? src.trim() : "";
  if (!raw || hasScheme(raw)) return raw;
  const override = base && base.trim() ? base : null;
  const dir = override ?? getAssetBaseDir();
  if (!dir) return raw;

  // Strip the query and hash the way a browser would before treating what is
  // left as a path, then put nothing back: a local file has no cache buster.
  const bare = raw.split("#")[0].split("?")[0];
  if (!bare) return raw;

  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    decoded = bare; // a stray % is not a reason to drop the picture
  }

  const absolute = decoded.startsWith("/") ? decoded : joinPath(dir, decoded);
  const address = `${ASSET_ORIGIN}/${encodeURIComponent(absolute)}`;
  if (override || !docPath) return address;
  // `ref` is the reference as the markdown wrote it, which is the exact string
  // the uploader stored it under. Main can rebuild a name from the resolved
  // path, but "./a.png" rebuilds as "a.png" and "../img/a.png" rebuilds as an
  // absolute path, and the server holds nothing under either. Carrying the
  // original costs one query parameter and is no more trusted than `doc` is:
  // at the server a ref is a lookup key, never a path.
  return `${address}?doc=${encodeURIComponent(docPath)}&ref=${encodeURIComponent(decoded)}`;
}

// What to draw for a given source. Markdown has one syntax for embedded media
// and it is the image one, so `![](clip.mp4)` is what a person writes and what
// an agent produces. Deciding by extension here means the markdown stays plain
// markdown: no Markie-only directive, and the file opens in any other editor
// as the image reference it already was.
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|oga|opus)(\?|#|$)/i;

export type MediaKind = "image" | "video" | "audio";

export function mediaKindOf(src: string | null | undefined): MediaKind {
  const raw = typeof src === "string" ? src.trim() : "";
  if (VIDEO_EXT.test(raw)) return "video";
  if (AUDIO_EXT.test(raw)) return "audio";
  return "image";
}

/** True when a URL is one this module produced. */
export function isAssetUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${ASSET_SCHEME}://`);
}
