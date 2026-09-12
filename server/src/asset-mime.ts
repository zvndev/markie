// The one list of what a document may embed, shared by every asset route.
// Kept in step with electron/local-assets.js: a file Markie will not draw
// locally is not one it uploads, and one it uploads is one this table names.
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
};

export const ASSET_EXTENSIONS = Object.keys(MIME_BY_EXT);

// The mime for a reference as written in markdown, or null when it is not a
// kind of file a document may embed. Query and fragment are ignored the way a
// browser ignores them when picking a handler.
export function assetMimeFor(ref: string): string | null {
  const bare = String(ref ?? "").split("#")[0].split("?")[0];
  const dot = bare.lastIndexOf(".");
  if (dot === -1) return null;
  return MIME_BY_EXT[bare.slice(dot).toLowerCase()] ?? null;
}
