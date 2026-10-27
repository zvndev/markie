// Settings for where this process runs, read from the environment. Each one
// defaults to what the server did before it existed, so a deployment that sets
// none of them behaves exactly as it did.
//
// Dependency-free on purpose: the private-release gateway image copies this
// file on its own (Dockerfile.private-release) and must not pull in the app.

type Env = Readonly<Record<string, string | undefined>>;

// An HTTP header name, lowercase. Anything else is a typo or a value pasted
// into the wrong variable, and a rate limiter keyed on a header that never
// arrives would put every client in one bucket without saying so.
const HEADER_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The request header that carries the real client address. Only a header the
 * edge in front of this server sets and overwrites may be named here, because
 * the rate limits key on it and a client can send any header it likes.
 *
 * MARKIE_CLIENT_IP_HEADER is this server's own name for it (Fly sets
 * Fly-Client-IP, so the Fly deployment names that one). CLIENT_IP_HEADER is
 * the name ZVN's other apps read, so one setting works for all of them, for
 * example `cf-connecting-ip` behind Cloudflare. When either is set, only that
 * header is read: a request without it is never resolved from
 * X-Forwarded-For instead. Neither set keeps better-auth's own default,
 * x-forwarded-for, which a self-hosted proxy such as deploy/Caddyfile sets.
 */
export function clientIpHeader(env: Env = process.env): string {
  const markie = env.MARKIE_CLIENT_IP_HEADER?.trim().toLowerCase() || "";
  const shared = env.CLIENT_IP_HEADER?.trim().toLowerCase() || "";
  if (markie && shared && markie !== shared) {
    throw new Error(
      `MARKIE_CLIENT_IP_HEADER (${markie}) and CLIENT_IP_HEADER (${shared}) name different headers. Set one of them.`
    );
  }
  const header = markie || shared;
  if (!header) return "x-forwarded-for";
  if (!HEADER_NAME.test(header)) {
    throw new Error(`${markie ? "MARKIE_CLIENT_IP_HEADER" : "CLIENT_IP_HEADER"} must be a single header name, such as cf-connecting-ip.`);
  }
  return header;
}

/**
 * Whether this process runs the server's own scheduled work (the hourly
 * orphaned-asset sweep). On unless ENABLE_CRONS is `false`, `0`, `no` or `off`,
 * so a copy of the server that must not run jobs can still answer requests.
 */
export function cronsEnabled(env: Env = process.env): boolean {
  const value = env.ENABLE_CRONS?.trim().toLowerCase();
  return !(value === "false" || value === "0" || value === "no" || value === "off");
}

// A git SHA or a release tag. Anything longer or stranger is not shown, since
// /health answers anyone.
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The build this process runs, for /health: KAMAL_VERSION (set by Kamal on
 * every container it starts), otherwise GIT_SHA. Undefined when neither is
 * set, which is every deployment that predates them, so their /health answer
 * does not change.
 */
export function releaseCommit(env: Env = process.env): string | undefined {
  for (const value of [env.KAMAL_VERSION, env.GIT_SHA]) {
    const trimmed = value?.trim();
    if (trimmed && RELEASE.test(trimmed)) return trimmed;
  }
  return undefined;
}
