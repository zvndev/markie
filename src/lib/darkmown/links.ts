// Which links and pictures a .wd preview keeps.
//
// The renderer's copy of electron/darkmown-preview.js's rules. The sanitizer
// uses them to decide what reaches the frame at all, and the host uses
// darkmownLinkTarget before it asks main to open anything. Main applies its
// own copy again, because the renderer is not trusted to have done this.
// links.test.ts runs both copies over the same cases so they cannot drift.

const MAX_URL = 8192;
const MAX_REF = 2048;
const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const MAIL_FIELDS = new Set(["subject", "body", "cc", "bcc"]);
const PICTURE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

function addressList(value: string): boolean {
  const parts = value.split(",").map((part) => part.trim());
  return parts.length > 0 && parts.length <= 20 && parts.every((part) => ADDRESS.test(part));
}

/** An http(s) page or a simple mail draft, normalized; anything else is null. */
export function darkmownLinkTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) return null;
  if (/[\x00-\x20\x7f\\]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (!/^https?:\/\//i.test(value) || !url.hostname || url.username || url.password) return null;
    return url.href;
  }
  if (url.protocol !== "mailto:" || url.hash) return null;
  let to: string;
  try { to = decodeURIComponent(url.pathname); } catch { return null; }
  if (to && !addressList(to)) return null;
  let fields = 0;
  for (const [key, field] of url.searchParams) {
    const name = key.toLowerCase();
    if (!MAIL_FIELDS.has(name) || ++fields > 8 || field.length > 2000) return null;
    // A line break in a header field can start another header (Bcc:, ...).
    if (name !== "body" && /[\r\n]/.test(field)) return null;
    if ((name === "cc" || name === "bcc") && !addressList(field)) return null;
  }
  if (!to && fields === 0) return null;
  return url.href;
}

/**
 * The picture reference exactly as the document wrote it, when it names an
 * image file inside the document's own folder; otherwise null. A remote
 * picture, an absolute path, a scheme and any `..` are refused here, and
 * main refuses them again by realpath.
 */
export function darkmownPictureRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_REF || /[\x00-\x1f\x7f\\]/.test(raw)) return null;
  if (raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const bare = raw.split("#")[0].split("?")[0];
  let decoded: string;
  try { decoded = decodeURIComponent(bare); } catch { decoded = bare; }
  if (!decoded || decoded.startsWith("/") || /^[a-z]:/i.test(decoded) || /[\x00-\x1f\x7f\\]/.test(decoded)) return null;
  if (decoded.split("/").includes("..") || !PICTURE.test(decoded)) return null;
  return raw;
}

/** The address of a picture inside a scope main issued for this document. */
export function darkmownPictureUrl(base: string, ref: string): string {
  return `${base}/${encodeURIComponent(ref)}`;
}

/** A base exactly as main issues it: markie-asset://wd-<32 hex>. */
export function isDarkmownPictureBase(value: unknown): value is string {
  return typeof value === "string" && /^markie-asset:\/\/wd-[0-9a-f]{32}$/.test(value);
}
