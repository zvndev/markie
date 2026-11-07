// Where hosted Live Docs live, and which requests belong to them.
//
// A Live Doc is a cloud document with format `darkmown` (a .wd). Each one gets
// its own address, `<label>.<LIVE_DOCS_DOMAIN>`, on a domain that is not
// Markie's (docs: markie-darkmown-sites-design, "Security model" 1). The page
// there runs Darkmown's runtime, so it must never share a site with the app:
// no cookie the app sets may reach it, and no cookie it sets may reach the app.
//
//   LIVE_DOCS_DOMAIN=markie.live      production
//   LIVE_DOCS_DOMAIN=localhost:8787   local, with the app on 127.0.0.1:8787
//
// Unset means the feature is off: no live routes answer and no address is
// handed out. The server refuses to boot when the live domain equals,
// contains, sits under, or shares a registrable domain with any name the app
// answers on, because then a Live Doc could read or plant the app's cookies.
//
// Dependency-free so the boot check and the host classifier can be tested
// without the app.

type Env = Readonly<Record<string, string | undefined>>;

export interface LiveDocsConfig {
  /** The live domain's hostname, lowercase, no port: `markie.live`. */
  domain: string;
  /** `:8787` when the live domain was configured with a port, else empty. */
  port: string;
  /** `http` only for a loopback domain (`localhost`), `https` everywhere else. */
  scheme: "http" | "https";
}

// 16 characters of RFC 4648 base32 (a-z, 2-7) is exactly 80 random bits
// (live-docs-store.ts newLiveDocLabel). Nothing else on the live domain is a
// Live Doc, so `www`, `api` or a multi-level name never reaches a document.
export const LIVE_DOC_LABEL = /^[a-z2-7]{16}$/;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function loopbackName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * LIVE_DOCS_DOMAIN, parsed, or null when it is unset (the feature is off).
 * Throws on anything that is not a bare DNS name with an optional port, so a
 * typo stops the boot rather than serving Live Docs on a name nobody meant.
 */
export function liveDocsConfig(env: Env = process.env): LiveDocsConfig | null {
  const raw = env.LIVE_DOCS_DOMAIN?.trim().toLowerCase();
  if (!raw) return null;
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(raw);
  const hostname = match?.[1] ?? "";
  const labels = hostname.split(".");
  if (!match || IPV4.test(hostname) || hostname.length > 200 || !labels.every((label) => DNS_LABEL.test(label))) {
    throw new Error(
      "LIVE_DOCS_DOMAIN must be a bare domain name with an optional port, like markie.live or localhost:8787. " +
        "No scheme, path, wildcard or IP address."
    );
  }
  const portNumber = match[2] === undefined ? null : Number(match[2]);
  if (portNumber !== null && (portNumber < 1 || portNumber > 65535)) {
    throw new Error("LIVE_DOCS_DOMAIN has a port outside 1-65535.");
  }
  return {
    domain: hostname,
    port: portNumber === null ? "" : `:${portNumber}`,
    scheme: loopbackName(hostname) ? "http" : "https",
  };
}

/** The origin a label's Live Doc is served on. Callers pass a stored label only. */
export function liveDocOrigin(config: LiveDocsConfig, label: string): string {
  if (!LIVE_DOC_LABEL.test(label)) throw new Error("not a Live Doc label");
  return `${config.scheme}://${label}.${config.domain}${config.port}`;
}

function hostnameOf(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

// The registrable domain, approximated as the last two labels. It over-refuses
// under a two-level public suffix (two unrelated sites under co.uk), which is
// the safe direction for a boot check: the cost is choosing another domain.
function siteOf(hostname: string): string {
  if (IPV4.test(hostname) || hostname.includes(":")) return hostname;
  return hostname.split(".").slice(-2).join(".");
}

/**
 * Throws when the live domain could share cookies with a name the app runs
 * on: the same name, one above or below the other, or the same registrable
 * domain. `appUrls` is every origin or host the app answers on or sets
 * cookies for (BETTER_AUTH_URL, its aliases, MARKIE_SITE_URL, web origins).
 */
export function assertLiveDocsIsolated(config: LiveDocsConfig, appUrls: readonly (string | null | undefined)[]): void {
  const live = config.domain;
  for (const value of appUrls) {
    if (!value) continue;
    const app = hostnameOf(value);
    if (!app) continue;
    const reason =
      app === live ? "is the same name as"
        : app.endsWith(`.${live}`) ? "contains"
          : live.endsWith(`.${app}`) ? "sits under"
            : siteOf(app) === siteOf(live) ? "shares a registrable domain with"
              : null;
    if (!reason) continue;
    const hint = loopbackName(live) && loopbackName(app)
      ? " Locally, run the app on 127.0.0.1 (BETTER_AUTH_URL=http://127.0.0.1:8787) and keep LIVE_DOCS_DOMAIN=localhost:8787."
      : "";
    throw new Error(
      `LIVE_DOCS_DOMAIN (${live}) ${reason} ${app}, a name Markie's app answers on. ` +
        `Live Docs must run on a separate domain so a page can never reach the app's cookies.${hint}`
    );
  }
}

/** What a request's host makes it. */
export type LiveHost =
  /** Markie's own app, API and sign-in. */
  | { kind: "app" }
  /** The bare live domain. Never a document, never a cookie. */
  | { kind: "apex" }
  /** One Live Doc's address. The label is well formed but may not exist. */
  | { kind: "live"; label: string }
  /**
   * Under the live domain but not a Live Doc address (another label shape,
   * another port), or headers that disagree about which side this is. Always
   * answered by the live side's 404, never by the app.
   */
  | { kind: "refused" };

function classifyOne(value: string, config: LiveDocsConfig): LiveHost {
  const host = value.split(",")[0]?.trim().toLowerCase() ?? "";
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(host);
  const hostname = (match?.[1] ?? "").replace(/\.$/, "");
  const port = match?.[2] === undefined ? "" : `:${match[2]}`;
  const inLiveDomain = hostname === config.domain || hostname.endsWith(`.${config.domain}`);
  if (!inLiveDomain) return { kind: "app" };
  // A live name on another port is not this deployment's Live Doc. With no
  // configured port the default ports are the same address.
  const portMatches = config.port ? port === config.port : port === "" || port === ":443" || port === ":80";
  if (!portMatches) return { kind: "refused" };
  if (hostname === config.domain) return { kind: "apex" };
  const label = hostname.slice(0, -(config.domain.length + 1));
  return LIVE_DOC_LABEL.test(label) ? { kind: "live", label } : { kind: "refused" };
}

const same = (a: LiveHost, b: LiveHost) =>
  a.kind === b.kind && (a.kind !== "live" || (b.kind === "live" && a.label === b.label));

/**
 * Which side a request belongs to. The Host header and, when a proxy set it,
 * X-Forwarded-Host are both read, and when either names the live domain they
 * must agree exactly. A request that says "app" in one and "Live Doc" in the
 * other is refused, so neither header alone can carry a request across.
 */
export function classifyRequestHost(request: Request, config: LiveDocsConfig): LiveHost {
  return classifyHostHeaders(request.headers.get("host"), request.headers.get("x-forwarded-host"), config, request.url);
}

/**
 * Whether a WebSocket upgrade may reach the app's socket handlers: only on an
 * app host. The live dispatch in index.ts sees Hono requests only, and an
 * upgrade never becomes one, so the upgrade listener asks this itself.
 */
export function upgradeAllowed(headers: Readonly<Record<string, string | string[] | undefined>>, config: LiveDocsConfig | null): boolean {
  if (!config) return true;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(",") : value) ?? null;
  return classifyHostHeaders(one(headers.host), one(headers["x-forwarded-host"]), config).kind === "app";
}

function classifyHostHeaders(host: string | null, forwarded: string | null, config: LiveDocsConfig, url?: string): LiveHost {
  const fromHost = host ? classifyOne(host, config) : null;
  const fromForwarded = forwarded ? classifyOne(forwarded, config) : null;
  if (fromHost && fromForwarded) return same(fromHost, fromForwarded) ? fromHost : { kind: "refused" };
  if (fromHost ?? fromForwarded) return (fromHost ?? fromForwarded)!;
  if (!url) return { kind: "app" };
  try {
    return classifyOne(new URL(url).host, config);
  } catch {
    return { kind: "app" };
  }
}
