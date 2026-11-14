// Markie Cloud's address, and the addresses it used to have. One copy, in
// electron/cloud-origin.json, read here and by main (electron/share-origin.js).
//
// An old address is the same server under an older name: the same backend
// and the same database, so a session issued there is good here and a link
// naming it is a Markie Cloud link. Anything stored under one reads as the
// current origin.
import cloud from "../../electron/cloud-origin.json";

export const CLOUD_ORIGIN: string = cloud.origin;
export const CLOUD_ALIASES: readonly string[] = Object.freeze([...cloud.legacyAliases]);
/** Where Markie Cloud's documents are read: /d/<id> and /s/<token> links name this host. */
export const CLOUD_DOCS_ORIGIN: string = cloud.docsOrigin;

/** Whether `origin` is Markie Cloud under its current name or an old one. */
export function isCloudOrigin(origin: string | null | undefined): boolean {
  return typeof origin === "string" && (origin === CLOUD_ORIGIN || CLOUD_ALIASES.includes(origin));
}

/**
 * Markie Cloud's current origin for any of its old ones. Anything else,
 * including a value that is not an origin at all, comes back unchanged.
 */
export function canonicalCloudOrigin<T extends string | null | undefined>(origin: T): T | string {
  if (typeof origin !== "string" || !origin) return origin;
  let parsed: string;
  try {
    parsed = new URL(origin).origin;
  } catch {
    return origin;
  }
  return CLOUD_ALIASES.includes(parsed) ? CLOUD_ORIGIN : origin;
}

/**
 * The origin a document link names for a document on `server`. Markie Cloud,
 * under any of its names, serves its documents on markiedocs.com, so its
 * links go there (the API host still answers an old link with a redirect).
 * Any other server, self-hosted or local, serves its own.
 */
export function docLinkOrigin(server: string): string {
  const trimmed = server.replace(/\/+$/, "");
  return isCloudOrigin(canonicalCloudOrigin(trimmed)) ? CLOUD_DOCS_ORIGIN : trimmed;
}
