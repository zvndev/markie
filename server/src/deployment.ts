// Which Markie server this process is: the official Markie Cloud, or somebody's
// own server run from deploy/. Everything that used to assume the official
// deployment (where links point, which websites may hold a session, whether the
// download routes are served) reads it from here.
//
// The official deployment is the DEFAULT. Self-hosting is a declaration,
// MARKIE_OFFICIAL=0, which deploy/docker-compose.yml always makes. The reverse
// default would have meant the live Railway service, which sets no such
// variable today, silently dropping the release-manifest guards and turning its
// own /download routes into redirects to markiedocs.com, which proxies back to
// them. A self-hoster who forgets the variable gets the stricter behaviour and
// a warning at boot, never the weaker one.
import { readFileSync } from "node:fs";
import { downloadManifest, markieSiteUrl } from "./downloads.ts";
import { officialFlag } from "./official.ts";

export { officialFlag };

export interface Deployment {
  /** The official Markie Cloud: release-manifest guards and download routes. */
  official: boolean;
  /** BETTER_AUTH_URL's origin: where this server's API, auth and pages live. */
  origin: string;
  /** Base for links this server hands out: share pages, invite emails, `src=`. */
  siteUrl: string;
  /** Where "Get Markie" points. Always the official site on a self-hosted server. */
  downloadSiteUrl: string;
  /** Shown to people adding this server in Markie. */
  name: string;
}

type Env = Record<string, string | undefined>;

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");

// Hosts the official deployment is reached on. Only used to decide whether an
// unset MARKIE_OFFICIAL deserves a warning; it never turns a server official.
const OFFICIAL_HOSTS = new Set([
  "api-production-602f.up.railway.app",
  "markiedocs.com",
  "www.markiedocs.com",
  "api.markiedocs.com",
]);

export function resolveDeployment(env: Env = process.env, warn: (message: string) => void = console.warn): Deployment {
  const official = officialFlag(env);
  const production = env.NODE_ENV === "production";
  if (!official && production && !env.BETTER_AUTH_URL) {
    throw new Error("BETTER_AUTH_URL is required on a self-hosted server: set it to https://<your domain>.");
  }
  const origin = new URL(env.BETTER_AUTH_URL ?? "http://localhost:8787").origin;
  const host = new URL(origin).host;
  if (official && production && env.MARKIE_OFFICIAL === undefined && !OFFICIAL_HOSTS.has(host)) {
    warn(
      `MARKIE_OFFICIAL is unset, so ${host} is running as the official Markie Cloud. ` +
        "A self-hosted server sets MARKIE_OFFICIAL=0 (deploy/docker-compose.yml does this)."
    );
  }
  let siteUrl: string;
  if (official) {
    // The existing guard: production refuses a MARKIE_SITE_URL that disagrees
    // with the stable release manifest.
    siteUrl = markieSiteUrl(env.MARKIE_SITE_URL, env.NODE_ENV);
  } else {
    const configured = env.MARKIE_SITE_URL ? new URL(env.MARKIE_SITE_URL) : null;
    if (configured && configured.protocol !== "https:" && configured.protocol !== "http:") {
      throw new Error("MARKIE_SITE_URL must be an http(s) URL.");
    }
    siteUrl = stripTrailingSlash(configured ? configured.toString() : origin);
  }
  const canonical = stripTrailingSlash(downloadManifest.siteUrl);
  const name = env.MARKIE_SERVER_NAME?.trim() || (official ? "Markie Cloud" : host);
  return {
    official,
    origin,
    siteUrl,
    downloadSiteUrl: official ? siteUrl : canonical,
    name: name.slice(0, 80),
  };
}

let cached: Deployment | undefined;
/** The deployment this process booted as. Resolved once; env does not change under a running server. */
export function deployment(): Deployment {
  cached ??= resolveDeployment();
  return cached;
}

const SERVER_PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
export const SERVER_VERSION = SERVER_PACKAGE.version;

/**
 * Bumped only for a change an existing desktop app cannot survive. Additive
 * routes and fields never bump it: apps that predate a feature simply ignore
 * it, and every route an older app calls stays. A future app compares this
 * with the version it speaks and tells the person to update one side.
 */
export const API_VERSION = 1;
