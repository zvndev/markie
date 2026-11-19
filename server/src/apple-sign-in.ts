// Sign in with Apple: reading its configuration and signing its client secret.
//
// Apple has no static client secret. The token endpoint takes a short JWT,
// signed ES256 with the .p8 key Apple issued for this Services ID, naming the
// team (iss), the Services ID (sub) and Apple (aud), and Apple refuses one
// that expires more than six months after it was issued. Rotating that by hand
// is a chore somebody forgets, so the server signs one at boot and signs a
// fresh one well before the old one ages out.
//
// Importing this module reads nothing. auth.ts calls appleConfigFromEnv once.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export const APPLE_ISSUER = "https://appleid.apple.com";

export interface AppleSignInConfig {
  /** The Services ID, which is the OAuth client_id. */
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: KeyObject;
}

const NAMES = ["APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"] as const;

/**
 * Apple is on only when all four settings are present. Some but not all is a
 * half-finished setup, so it stays off and says which ones are missing. A key
 * that is present but unreadable stops the boot: a deploy that meant to turn
 * Apple on should fail where someone sees it, not run without it.
 */
export function appleConfigFromEnv(env: Record<string, string | undefined> = process.env): AppleSignInConfig | null {
  const values = NAMES.map((name) => env[name]?.trim() ?? "");
  const missing = NAMES.filter((_, i) => !values[i]);
  if (missing.length === NAMES.length) return null;
  if (missing.length) {
    console.warn(`Sign in with Apple is off: ${missing.join(", ")} not set.`);
    return null;
  }
  const [clientId, teamId, keyId, pem] = values;
  // A .p8 pasted into one line of an env file arrives with literal "\n".
  const text = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(text);
  } catch {
    // Never echo the value: it is the key.
    throw new Error("APPLE_PRIVATE_KEY is set but is not a readable private key. Use the contents of Apple's .p8 file.");
  }
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("APPLE_PRIVATE_KEY must be the P-256 key Apple issued for Sign in with Apple.");
  }
  return { clientId, teamId, keyId, privateKey };
}

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** The client secret JWT Apple's token endpoint expects. */
export function signAppleClientSecret(config: AppleSignInConfig, issuedAt: number, lifetimeSeconds: number): string {
  const header = b64url({ alg: "ES256", kid: config.keyId, typ: "JWT" });
  const payload = b64url({ iss: config.teamId, iat: issuedAt, exp: issuedAt + lifetimeSeconds, aud: APPLE_ISSUER, sub: config.clientId });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: config.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

// Apple's cap is 15777000 seconds (six months). A week is far inside it, and
// re-signing daily leaves six days of margin, so a secret that leaked from a
// log or a token request is good for a week at most.
const LIFETIME_SECONDS = 7 * 86_400;
const REFRESH_AFTER_SECONDS = 86_400;
// iat a minute back, so a server clock slightly ahead of Apple's is not "issued in the future".
const CLOCK_SKEW_SECONDS = 60;

/**
 * Holds the current client secret. Signed once now, so a bad key fails at
 * boot, then re-signed on read once it is a day old. Reading it is the only
 * trigger: there is no timer to keep the process alive or to fail silently.
 */
export function createAppleClientSecret(config: AppleSignInConfig, { now = () => Date.now() }: { now?: () => number } = {}) {
  let secret = "", mintedAt = 0;
  const mint = () => {
    mintedAt = Math.floor(now() / 1000);
    secret = signAppleClientSecret(config, mintedAt - CLOCK_SKEW_SECONDS, LIFETIME_SECONDS + CLOCK_SKEW_SECONDS);
  };
  mint();
  return {
    current(): string {
      const age = Math.floor(now() / 1000) - mintedAt;
      // A clock that went backwards also re-signs, rather than trust an iat in the future.
      if (age >= REFRESH_AFTER_SECONDS || age < 0) mint();
      return secret;
    },
  };
}
export type AppleClientSecret = ReturnType<typeof createAppleClientSecret>;

const APPLE_CALLBACK = /\/callback\/apple\/?$/;
const MAX_CALLBACK_BODY = 64 * 1024;

/**
 * Apple's form POST to /api/auth/callback/apple carries a `user` field on
 * first consent: the person's name, and their real email even when they chose
 * Hide My Email. better-auth answers the POST with a redirect to the same
 * callback as a GET, copying every field into the query string, where proxy
 * and access logs keep it. Only the name is read from that field (the email
 * comes from the ID token Apple's token endpoint returns), so everything else
 * is dropped before better-auth sees the body. Any other request comes back
 * untouched.
 */
export async function withoutAppleUserEmail(request: Request): Promise<Request> {
  if (request.method !== "POST" || !APPLE_CALLBACK.test(new URL(request.url).pathname)) return request;
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return request;
  // Apple's form is a few kilobytes. A larger body is not Apple's, and is
  // left for better-auth to refuse rather than buffered here.
  const reader = request.clone().body?.getReader();
  if (!reader) return request;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > MAX_CALLBACK_BODY) return request;
      chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if (!form.has("user")) return request;
  let name: unknown;
  try { name = (JSON.parse(form.get("user") ?? "") as { name?: unknown } | null)?.name; } catch { name = undefined; }
  form.delete("user");
  if (name && typeof name === "object" && !Array.isArray(name)) form.set("user", JSON.stringify({ name }));
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: form.toString() });
}
