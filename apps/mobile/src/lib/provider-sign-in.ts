// Google and Apple sign-in on the phone.
//
// The provider's screen opens in the phone's browser, never in a web view
// inside the app, and the way back is a `markie-mobile://auth` link. Any web
// page can fire that scheme and another app can register it, so the link is
// never trusted with a session and a stolen one opens nothing
// (server/src/mobile-auth.ts is the other half):
//
//   1. begin: make a random secret and a random state, and keep both in the
//      Keychain beside the server the person chose. Open the browser with
//      the secret's SHA-256 only.
//   2. The link comes back with a short-lived, one-use code. It is accepted
//      only when its state is the one kept, and its server is the one chosen.
//   3. finish: send the code and the secret to that same server over HTTPS.
//      The session is in the answer, never in the link.
//
// The app never offers a provider a server has not said it supports, and it
// never sends a hand-off anywhere but the server the sign-in started on.
import type { ApiUser } from "./api";
import { APP_SCHEME } from "./deep-links";
import { NetworkError, type HttpTransport } from "./http";
import type { SecureKeyValue } from "./session";
import { normalizeServerOrigin } from "./server-origin";
import { sha256Hex } from "./sha256";

export type Provider = "google" | "apple";
export const PROVIDER_LABEL: Record<Provider, string> = { google: "Google", apple: "Apple" };

/** The name the server knows this app by (server/src/mobile-auth.ts MOBILE_CLIENT). */
const CLIENT = "markie-mobile";
export const PROVIDER_PENDING_KEY = "markie.mobile.provider-sign-in.v1";
// How long a started sign-in waits for its link. A person may have to find a
// password or approve a prompt on another device; past this the secret is
// thrown away and they start again.
const PENDING_TTL_MS = 15 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 20_000;
const INFO_TIMEOUT_MS = 8_000;

const HEX_64 = /^[0-9a-f]{64}$/;
const STATE = /^[0-9a-f]{32}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_SHAPE = /^[\x21-\x7e]{16,1024}$/;

/** What a server lets the phone sign in with. */
export interface ServerSignIn {
  origin: string;
  /** The server can mail a sign-in code. */
  emailCode: boolean;
  google: boolean;
  apple: boolean;
}

/**
 * Reads /api/server-info. Google and Apple count only when the server also
 * says `mobile`: that it has the hand-off this file speaks. A server from
 * before it, or one that answers anything unexpected, offers neither.
 */
export function parseServerSignIn(origin: string, data: unknown): ServerSignIn {
  const none: ServerSignIn = { origin, emailCode: true, google: false, apple: false };
  if (!data || typeof data !== "object") return none;
  const info = data as { product?: unknown; signIn?: unknown };
  if (info.product !== "markie-server" || !info.signIn || typeof info.signIn !== "object") return none;
  const signIn = info.signIn as { email?: unknown; google?: unknown; apple?: unknown; mobile?: unknown };
  const handoff = signIn.mobile === true;
  return {
    origin,
    emailCode: signIn.email !== false,
    google: handoff && signIn.google === true,
    apple: handoff && signIn.apple === true,
  };
}

/** Asks a server what it supports. No token, no cookies: anyone may ask. */
export async function fetchServerSignIn(origin: string, transport: HttpTransport): Promise<ServerSignIn> {
  try {
    const response = await transport({ method: "GET", url: `${origin}/api/server-info`, timeoutMs: INFO_TIMEOUT_MS });
    if (response.status !== 200 || response.text.length > 16_384) return parseServerSignIn(origin, null);
    return parseServerSignIn(origin, JSON.parse(response.text));
  } catch {
    return parseServerSignIn(origin, null);
  }
}

/**
 * Which buttons to show, in order. On iOS Google is offered only where Apple
 * is too: the App Store requires Sign in with Apple beside any other
 * provider's sign-in (guideline 4.8), so a server with Google alone shows
 * neither there. Apple goes first on iOS.
 */
export function providersFor(signIn: ServerSignIn | null, platform: "ios" | "android" | "web"): Provider[] {
  if (!signIn) return [];
  if (platform === "ios") return signIn.apple ? (signIn.google ? ["apple", "google"] : ["apple"]) : [];
  return [...(signIn.google ? (["google"] as const) : []), ...(signIn.apple ? (["apple"] as const) : [])];
}

interface Pending {
  state: string;
  verifier: string;
  origin: string;
  provider: Provider;
  at: number;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readPending(text: string | null): Pending | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.state !== "string" || !STATE.test(raw.state)) return null;
    if (typeof raw.verifier !== "string" || !HEX_64.test(raw.verifier)) return null;
    if (raw.provider !== "google" && raw.provider !== "apple") return null;
    if (typeof raw.at !== "number" || typeof raw.origin !== "string") return null;
    const origin = normalizeServerOrigin(raw.origin);
    if (!origin.ok || origin.origin !== raw.origin) return null;
    return { state: raw.state, verifier: raw.verifier, origin: origin.origin, provider: raw.provider, at: raw.at };
  } catch {
    return null;
  }
}

/**
 * Starts a sign-in and returns the address to open in the browser. Starting
 * again replaces whatever was waiting, so only the newest sign-in can finish.
 */
export async function beginProviderSignIn(
  { origin, provider, secure, now = Date.now }: { origin: string; provider: Provider; secure: SecureKeyValue; now?: () => number }
): Promise<string> {
  const target = normalizeServerOrigin(origin);
  if (!target.ok || target.origin !== origin) throw new Error("That server address can't be used to sign in.");
  const pending: Pending = { state: randomHex(16), verifier: randomHex(32), origin, provider, at: now() };
  const challenge = await sha256Hex(pending.verifier);
  await secure.set(PROVIDER_PENDING_KEY, JSON.stringify(pending));
  return `${origin}/auth/mobile-start?provider=${provider}&challenge=${challenge}&state=${pending.state}`;
}

/** Whether a link is the way back from a provider, whatever it carries. */
export function isAuthReturnLink(input: string): boolean {
  if (typeof input !== "string" || input.length > 4096) return false;
  try {
    const url = new URL(input.trim());
    return url.protocol === `${APP_SCHEME}:` && url.host === "auth";
  } catch {
    return false;
  }
}

const REFUSALS: Record<string, (provider: string) => string> = {
  signup_invite_required: () => "This server is invite-only. Ask its owner for an invite.",
  signup_closed: () => "This server isn't taking new accounts.",
  provider_email_unverified: (name) => `${name} hasn't verified that email. Verify it with ${name}, or sign in with an email code.`,
  account_not_linked: (name) => `That email already has a Markie account. Sign in with an email code, then link ${name} in Markie on your computer.`,
};

export class ProviderSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSignInError";
  }
}

export type ProviderSignInResult = { origin: string; token: string; user: ApiUser };

/**
 * Finishes a sign-in from the link that came back.
 *
 * Returns null for a link that is not the answer to the sign-in this phone
 * is waiting on: nothing waiting, or a state that does not match. Such a
 * link is ignored and what is waiting is left alone, so a page that fires
 * `markie-mobile://auth` cannot sign anyone in or cancel a sign-in under way.
 * Throws ProviderSignInError, with words for the person, when the sign-in
 * this phone started did not work out.
 */
export async function completeProviderSignIn(
  link: string,
  { secure, transport, now = Date.now }: { secure: SecureKeyValue; transport: HttpTransport; now?: () => number }
): Promise<ProviderSignInResult | null> {
  if (!isAuthReturnLink(link)) return null;
  const url = new URL(link.trim());
  const pending = readPending(await secure.get(PROVIDER_PENDING_KEY).catch(() => null));
  if (!pending) return null;
  const state = url.searchParams.get("state");
  if (!state || state !== pending.state) return null;

  // This is the answer to our sign-in. From here the secret is used at most once.
  await secure.remove(PROVIDER_PENDING_KEY).catch(() => undefined);
  const name = PROVIDER_LABEL[pending.provider];
  const failed = `${name} sign-in didn't finish. Try again.`;
  if (now() - pending.at > PENDING_TTL_MS || pending.at > now() + 60_000) throw new ProviderSignInError(`${name} sign-in took too long. Try again.`);

  // The link has to name the server the sign-in started on. A link from any
  // other server is refused before anything is sent anywhere.
  const issuer = normalizeServerOrigin(url.searchParams.get("iss") ?? "");
  if (!issuer.ok || issuer.origin !== pending.origin) throw new ProviderSignInError(failed);

  const error = url.searchParams.get("error");
  if (error !== null) throw new ProviderSignInError(REFUSALS[error]?.(name) ?? failed);
  const code = url.searchParams.get("code");
  if (!code || !CODE.test(code)) throw new ProviderSignInError(failed);

  let response;
  try {
    response = await transport({
      method: "POST",
      url: `${pending.origin}/auth/mobile-exchange`,
      body: { client: CLIENT, code, verifier: pending.verifier, state: pending.state },
      timeoutMs: EXCHANGE_TIMEOUT_MS,
    });
  } catch (caught) {
    throw new ProviderSignInError(caught instanceof NetworkError ? `${caught.message} Then try ${name} again.` : failed);
  }
  if (response.status === 429) throw new ProviderSignInError("Too many attempts. Wait a minute and try again.");
  if (response.status !== 200) throw new ProviderSignInError(failed);
  let body: { token?: unknown; user?: { id?: unknown; email?: unknown; name?: unknown } };
  try {
    body = JSON.parse(response.text) as typeof body;
  } catch {
    throw new ProviderSignInError(failed);
  }
  const user = body?.user;
  if (typeof body?.token !== "string" || !TOKEN_SHAPE.test(body.token) || !user || typeof user.id !== "string" || !user.id || typeof user.email !== "string" || !user.email) {
    throw new ProviderSignInError(failed);
  }
  return {
    origin: pending.origin,
    token: body.token,
    user: { id: user.id, email: user.email, name: typeof user.name === "string" ? user.name : "" },
  };
}
