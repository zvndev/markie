// The files iOS and Android fetch to let the Markie mobile app open this
// server's /d/<id> and /s/<token> links (docs/mobile/AGENT-LINKS-CONTRACT.md).
// They also claim one more path, MOBILE_RETURN_PATH: the way back into the
// app after a Google or Apple sign-in (mobile-auth.ts).
//
// Both are JSON, with no auth and no redirect: Apple's CDN and Android's
// verifier fetch them anonymously and refuse a redirect. canonical-host.ts only
// redirects /auth and /account pages, so these are served on every name the
// server answers to.
import { Hono } from "hono";
import { OFFICIAL_HOSTS } from "./official.ts";

export const MOBILE_APP_ID = "com.zvn.markie.mobile";
export const APPLE_TEAM_ID = "3VU8SG5TD9";

/** The hosts the app claims natively (its entitlements and manifest). */
export const MOBILE_LINK_HOSTS = ["api.markiedocs.com", "markiedocs.com"] as const;
/**
 * The way back into the app after a Google or Apple sign-in. An https link
 * here is handed to the app by the operating system only after it has checked
 * the files below, so no other app can receive it (mobile-auth.ts).
 */
export const MOBILE_RETURN_PATH = "/auth/mobile-return";

/**
 * The origin the sign-in page's "Return to Markie" button points at, or null
 * when this server has no host the app claims. Only Markie Cloud has one, and
 * only when it is running at one of its own addresses.
 * It is never the host the sign-in page itself is on: iOS keeps a link to
 * the page's own host in the browser, and hands the app only a link to
 * another one.
 */
export function verifiedReturnOrigin(d: { official: boolean; origin: string; docsOrigin: string | null }): string | null {
  if (!d.official) return null;
  const own = new URL(d.origin).host;
  // MARKIE_OFFICIAL unset reads as official (deployment.ts), so a local or
  // self-hosted server that forgot MARKIE_OFFICIAL=0 lands here too. It is
  // not at one of Markie Cloud's addresses, and must not send its sign-ins
  // back through Markie Cloud's site.
  if (!OFFICIAL_HOSTS.has(own)) return null;
  const hosts: readonly string[] = MOBILE_LINK_HOSTS;
  const candidates = [...(d.docsOrigin ? [new URL(d.docsOrigin).host] : []), ...hosts];
  const host = candidates.find((candidate) => hosts.includes(candidate) && candidate !== own);
  return host ? `https://${host}` : null;
}

export const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    // iOS 13+ reads `details[].appIDs` and `components`. `apps` stays an empty
    // array because older parsers reject the file without it.
    apps: [] as string[],
    details: [
      {
        appIDs: [`${APPLE_TEAM_ID}.${MOBILE_APP_ID}`],
        // In order: Apple's `*` also matches `/`, so the excludes come first,
        // or the app would also claim /d/<id>/raw, /s/<token>/assets and
        // every other path under a document.
        components: [
          { "/": "/d/*/*", exclude: true },
          { "/": "/s/*/*", exclude: true },
          { "/": "/d/*" },
          { "/": "/s/*" },
          { "/": MOBILE_RETURN_PATH },
        ],
      },
    ],
  },
};

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * The SHA-256 signing-certificate fingerprints in ANDROID_APP_CERT_SHA256,
 * comma separated, as AA:BB:… in upper case. A value that is not one is left
 * out with a warning rather than published: a malformed fingerprint only
 * makes verification fail on the device, far from the cause.
 */
export function androidFingerprints(raw: string | undefined, warn: (message: string) => void = console.warn): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const value = part.trim().toUpperCase();
    if (!value) continue;
    if (FINGERPRINT.test(value)) {
      if (!out.includes(value)) out.push(value);
    } else {
      warn(`ANDROID_APP_CERT_SHA256: ignoring "${value.slice(0, 120)}", which is not a SHA-256 fingerprint (32 hex pairs joined by colons).`);
    }
  }
  return out;
}

/** The assetlinks.json statements: none at all until a fingerprint is configured. */
export function assetLinks(fingerprints: string[]) {
  if (fingerprints.length === 0) return [];
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: MOBILE_APP_ID, sha256_cert_fingerprints: fingerprints },
    },
  ];
}

/** Whether Android can verify this server's links: a signing fingerprint is published. */
export function androidLinksVerified(env: Record<string, string | undefined> = process.env): boolean {
  return androidFingerprints(env.ANDROID_APP_CERT_SHA256, () => undefined).length > 0;
}

export function createWellKnown(env: Record<string, string | undefined> = process.env): Hono {
  const app = new Hono();
  // Resolved once: env does not change under a running server.
  const assetlinks = JSON.stringify(assetLinks(androidFingerprints(env.ANDROID_APP_CERT_SHA256)));
  const aasa = JSON.stringify(APPLE_APP_SITE_ASSOCIATION);
  const json = (body: string) =>
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    });
  app.get("/.well-known/apple-app-site-association", () => json(aasa));
  app.get("/.well-known/assetlinks.json", () => json(assetlinks));
  return app;
}
