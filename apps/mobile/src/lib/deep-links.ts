// Which links open a document in the app, and where they point.
//
// Accepted shapes (docs/mobile/AGENT-LINKS-CONTRACT.md, "Link contract"):
//   https://api.markiedocs.com/d/<id>     https://markiedocs.com/d/<id>
//   https://api.markiedocs.com/s/<token>  https://markiedocs.com/s/<token>
//   markie-mobile://d/<id>                markie-mobile://s/<token>
// plus /d and /s links on the server the user signed in to, which is how a
// self-hosted server's links open in the app when tapped inside a document.
//
// Anything else is not a document link. A query string (an invite's ?k=) is
// ignored: the app reads through the signed-in account, never a link token.
import { CLOUD_ORIGIN } from "@/lib/cloud-origin";
import { DOC_ID, PUBLIC_TOKEN } from "./docs";
import { isMarkieCloud } from "./server-origin";

export const APP_SCHEME = "markie-mobile";
export const CLAIMED_HOSTS = ["api.markiedocs.com", "markiedocs.com", "www.markiedocs.com"];

export type LinkTarget =
  | { kind: "doc"; id: string; origin: string | null }
  | { kind: "public"; token: string; origin: string | null };

function routeFromPath(path: string, origin: string | null): LinkTarget | null {
  const match = /^\/([ds])\/([^/]+)\/?$/.exec(path);
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (match[1] === "d") return DOC_ID.test(value) ? { kind: "doc", id: value, origin } : null;
  return PUBLIC_TOKEN.test(value) ? { kind: "public", token: value, origin } : null;
}

/**
 * @param serverOrigin The signed-in server, so its own /d and /s links count.
 */
export function parseMarkieLink(input: string, serverOrigin: string | null = null): LinkTarget | null {
  if (typeof input !== "string" || input.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol === `${APP_SCHEME}:`) {
    // markie-mobile://d/<id> parses with "d" as the host; markie-mobile:///d/<id>
    // with an empty host. Both mean the same route, on the signed-in server.
    if (url.username || url.password || url.port) return null;
    return routeFromPath(`${url.host ? `/${url.host}` : ""}${url.pathname}`, null);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.protocol === "https:" && !url.port && CLAIMED_HOSTS.includes(url.hostname)) {
    // markiedocs.com proxies /d and /s to Markie Cloud's API host.
    return routeFromPath(url.pathname, CLOUD_ORIGIN);
  }
  if (serverOrigin && url.origin === serverOrigin) return routeFromPath(url.pathname, serverOrigin);
  return null;
}

/**
 * An https link on a Markie host (or the signed-in server) that isn't a
 * document the app opens: a raw download, an asset. The only kind of URL the
 * app hands on to the browser when another app sends it one.
 */
export function isMarkieWebLink(input: string, serverOrigin: string | null = null): boolean {
  if (typeof input !== "string" || input.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:" && !url.port && CLAIMED_HOSTS.includes(url.hostname)) return true;
  // The signed-in origin already passed normalizeServerOrigin's rules.
  return !!serverOrigin && url.origin === serverOrigin;
}

export type ResolvedLink = { ok: true; target: LinkTarget } | { ok: false; message: string };

/**
 * Pins a link to the signed-in server. A link to another server can't be read
 * with this session's token, and the token is never offered to it.
 */
export function resolveForSession(target: LinkTarget, sessionOrigin: string): ResolvedLink {
  if (target.origin === null) return { ok: true, target: { ...target, origin: sessionOrigin } };
  const same = target.origin === sessionOrigin || (isMarkieCloud(target.origin) && isMarkieCloud(sessionOrigin));
  if (same) return { ok: true, target: { ...target, origin: sessionOrigin } };
  const where = isMarkieCloud(target.origin) ? "Markie Cloud" : new URL(target.origin).host;
  return { ok: false, message: `This link is for ${where}, and you're signed in to a different server. Sign out and sign in to ${where} to open it.` };
}

/** The app-scheme form of a target, for the in-app route and for tests. */
export function appLinkFor(target: LinkTarget): string {
  return target.kind === "doc" ? `${APP_SCHEME}://d/${encodeURIComponent(target.id)}` : `${APP_SCHEME}://s/${encodeURIComponent(target.token)}`;
}

// A link tapped before sign-in waits for it. Kept across an app restart (iOS
// may end the app while the user fetches the code from Mail), for an hour.
// A document id or public token is a pointer, not a credential: the server
// still decides, after sign-in, whether this account may read it.
export const PENDING_LINK_KEY = "markie.mobile.pending-link.v1";
const PENDING_TTL_MS = 60 * 60 * 1000;

type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function rememberPendingLink(target: LinkTarget, storage: PendingStorage, now = Date.now()): void {
  try {
    storage.setItem(PENDING_LINK_KEY, JSON.stringify({ link: appLinkFor(target), origin: target.origin, at: now }));
  } catch {
    // Storage unavailable: the link is simply not remembered.
  }
}

/** Whether a link is waiting, without consuming it. */
export function hasPendingLink(storage: Pick<Storage, "getItem">): boolean {
  try {
    return !!storage.getItem(PENDING_LINK_KEY);
  } catch {
    return false;
  }
}

/** Forget a waiting link (signing out on purpose). */
export function clearPendingLink(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(PENDING_LINK_KEY);
  } catch {
    // nothing stored
  }
}

export function takePendingLink(storage: PendingStorage, now = Date.now()): LinkTarget | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PENDING_LINK_KEY);
    storage.removeItem(PENDING_LINK_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { link?: unknown; origin?: unknown; at?: unknown };
    if (typeof value.at !== "number" || now - value.at > PENDING_TTL_MS || value.at > now + 60_000) return null;
    if (typeof value.link !== "string") return null;
    const target = parseMarkieLink(value.link);
    if (!target) return null;
    const origin = typeof value.origin === "string" ? value.origin : null;
    if (origin !== null && origin !== CLOUD_ORIGIN && !/^https?:\/\/[^/]+$/.test(origin)) return null;
    return { ...target, origin };
  } catch {
    return null;
  }
}

/** What an in-document link does when tapped. */
export type InDocumentLink =
  | { kind: "markie"; target: LinkTarget }
  | { kind: "related"; id: string }
  | { kind: "external"; url: string }
  | { kind: "system"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "none" };

export function classifyDocumentLink(href: string | null, serverOrigin: string, related: ReadonlyMap<string, string> = new Map()): InDocumentLink {
  if (!href) return { kind: "none" };
  const value = href.trim();
  if (value.startsWith("#")) {
    let id = value.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      return { kind: "none" };
    }
    return id ? { kind: "anchor", id } : { kind: "none" };
  }
  // A pointer to another document by its file name, resolved by the server
  // when the author's Markie pushed it (server/src/doc-links.ts).
  const relatedTarget = related.get(value);
  if (relatedTarget && DOC_ID.test(relatedTarget)) return { kind: "related", id: relatedTarget };
  const markie = parseMarkieLink(value, serverOrigin);
  if (markie) return { kind: "markie", target: markie };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "none" };
  }
  if (url.protocol === "https:" || url.protocol === "http:") return { kind: "external", url: url.href };
  if (url.protocol === "mailto:" || url.protocol === "tel:") return { kind: "system", url: url.href };
  return { kind: "none" };
}
