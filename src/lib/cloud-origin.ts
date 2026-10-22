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
