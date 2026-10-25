// The files iOS and Android fetch to let the Markie mobile app open this
// server's /d/<id> and /s/<token> links (docs/mobile/AGENT-LINKS-CONTRACT.md).
//
// Both are JSON, with no auth and no redirect: Apple's CDN and Android's
// verifier fetch them anonymously and refuse a redirect. canonical-host.ts only
// redirects /auth and /account pages, so these are served on every name the
// server answers to.
import { Hono } from "hono";

export const MOBILE_APP_ID = "com.zvn.markie.mobile";
export const APPLE_TEAM_ID = "3VU8SG5TD9";

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
