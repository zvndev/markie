// Google and Apple sign-in for the phone app ("Markie Docs").
//
// The provider's screen runs in the phone's browser, and the way back into
// the app is a `markie-mobile://auth` link. A custom scheme is not a safe
// place for a credential: any web page can fire one, and another app on the
// phone can register the same scheme and receive the link instead. The
// desktop bridge (desktop-auth.ts) puts the session token in its link and
// relies on a nonce the app checks. The phone's path is stricter, and shares
// nothing with it:
//
//   1. The app makes a random secret and keeps it in the Keychain. It opens
//      GET /auth/mobile-start with the secret's SHA-256 (the challenge) and a
//      random state. The secret itself never leaves the app at this point.
//   2. The provider signs the person in and the browser lands on
//      GET /auth/mobile-bridge, which mints a code: 32 random bytes, good for
//      two minutes and for one use, stored only as a hash beside the
//      challenge. The page's link back to the app carries that code, the
//      state and this server's origin. It never carries a session token.
//   3. The app posts the code, the secret and the state to
//      POST /auth/mobile-exchange over HTTPS. The code is spent the moment it
//      is looked up, right or wrong. The session token is in the answer only
//      when the secret hashes to the stored challenge, the state matches, the
//      code has not expired and the sign-in it names is still good.
//
// So a link that leaks, or that another app receives, is a code with no
// secret: it opens nothing, and trying it spends it.
//
// The bridge never sends the browser on by itself. The person taps "Return
// to Markie", under the address they signed in with. A page or an app that
// starts this flow behind someone's back therefore stops on a visible page
// instead of running to the end unseen.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type Database from "better-sqlite3";
import { auth } from "./auth.ts";
import { openDatabase } from "./db.ts";
import { BRAND_HEAD, brandLogoSvg } from "./brand.ts";
import { reportFault } from "./little-friend.ts";
import { PROVIDER_EMAIL_UNVERIFIED, SIGNUP_CLOSED, SIGNUP_INVITE_REQUIRED, signupRefusalMessage } from "./signup.ts";

/** The phone app's scheme (apps/mobile/src/lib/deep-links.ts APP_SCHEME). */
export const MOBILE_APP_SCHEME = "markie-mobile";
/** The only client the exchange answers. A code is minted for it and no other. */
export const MOBILE_CLIENT = "markie-mobile";

// Long enough to tap a button and for the app to make one request on a slow
// network. Short enough that a link found later is a dead one.
export const MOBILE_HANDOFF_TTL_MS = 2 * 60 * 1000;
// The bridge only answers a sign-in that just happened. An older session
// cookie in the phone's browser (from reading a document on the web, say)
// does not turn into an app session without the provider step.
export const MOBILE_SESSION_FRESH_MS = 10 * 60 * 1000;

// SHA-256 of the app's secret, lowercase hex. Echoed into a URL, so only this
// exact shape is ever accepted.
const CHALLENGE = /^[0-9a-f]{64}$/;
// The app's secret: 32 random bytes, lowercase hex.
const VERIFIER = /^[0-9a-f]{64}$/;
const STATE = /^[0-9a-f]{32,64}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;

export type MobileProvider = "google" | "apple";

export function mobileChallenge(raw: unknown): string | null {
  return typeof raw === "string" && CHALLENGE.test(raw) ? raw : null;
}

export function mobileState(raw: unknown): string | null {
  return typeof raw === "string" && STATE.test(raw) ? raw : null;
}

export function mobileProvider(raw: unknown): MobileProvider | null {
  return raw === "google" || raw === "apple" ? raw : null;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The link back to the app after a sign-in. A code, never a token. */
export function mobileReturnLink(code: string, state: string, issuer: string | null): string {
  let link = `${MOBILE_APP_SCHEME}://auth?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  if (issuer) link += `&iss=${encodeURIComponent(issuer)}`;
  return link;
}

// Why a sign-in did not finish, in words the app chooses (it never shows text
// taken from a link). Anything not named here is "failed".
export const MOBILE_REFUSALS = [SIGNUP_INVITE_REQUIRED, SIGNUP_CLOSED, PROVIDER_EMAIL_UNVERIFIED, "account_not_linked", "failed"] as const;
export type MobileRefusal = (typeof MOBILE_REFUSALS)[number];

export function mobileRefusal(raw: unknown): MobileRefusal {
  return (MOBILE_REFUSALS as readonly string[]).includes(raw as string) ? (raw as MobileRefusal) : "failed";
}

/** The link back to the app when the sign-in was refused. It carries no code. */
export function mobileRefusalLink(refusal: MobileRefusal, state: string | null, issuer: string | null): string {
  let link = `${MOBILE_APP_SCHEME}://auth?error=${encodeURIComponent(refusal)}`;
  if (state) link += `&state=${encodeURIComponent(state)}`;
  if (issuer) link += `&iss=${encodeURIComponent(issuer)}`;
  return link;
}

export interface MobileHandoffStore {
  /** A new code for one finished sign-in. Only its hash is kept. */
  issue(input: { challenge: string; state: string; sessionId: string }): string;
  /**
   * Spends a code. The answer is the session it names, or null for anything
   * wrong. A code that was looked up is gone, whatever else was wrong.
   */
  redeem(input: { code: unknown; verifier: unknown; state: unknown; client: unknown }): string | null;
}

export function createMobileHandoffStore(db: Database.Database, now: () => number = Date.now): MobileHandoffStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_handoffs (
      code_hash TEXT PRIMARY KEY,
      client TEXT NOT NULL,
      challenge TEXT NOT NULL,
      state TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_handoffs_expiry ON mobile_handoffs(expires_at)");
  const insert = db.prepare("INSERT INTO mobile_handoffs (code_hash, client, challenge, state, session_id, expires_at) VALUES (?,?,?,?,?,?)");
  const sweep = db.prepare("DELETE FROM mobile_handoffs WHERE expires_at <= ?");
  const take = db.prepare("DELETE FROM mobile_handoffs WHERE code_hash = ? RETURNING client, challenge, state, session_id AS sessionId, expires_at AS expiresAt");
  return {
    issue({ challenge, state, sessionId }) {
      sweep.run(now());
      const code = randomBytes(32).toString("base64url");
      insert.run(sha256Hex(code), MOBILE_CLIENT, challenge, state, sessionId, now() + MOBILE_HANDOFF_TTL_MS);
      return code;
    },
    redeem({ code, verifier, state, client }) {
      if (typeof code !== "string" || !CODE.test(code)) return null;
      // The delete is the lookup, so two requests can never both get the row.
      const row = take.get(sha256Hex(code)) as
        | { client: string; challenge: string; state: string; sessionId: string; expiresAt: number }
        | undefined;
      if (!row) return null;
      if (row.expiresAt <= now()) return null;
      if (client !== row.client) return null;
      if (typeof verifier !== "string" || !VERIFIER.test(verifier)) return null;
      if (typeof state !== "string" || !sameText(state, row.state)) return null;
      if (!sameText(sha256Hex(verifier), row.challenge)) return null;
      return row.sessionId;
    },
  };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// No script: the only way on is the link, tapped by the person.
function bridgePage(c: Context, status: 200 | 401, heading: string, sub: string, link: { href: string; label: string } | null): Response {
  // The page holds a one-use code. It is not a credential by itself, but it
  // has no business in a cache either.
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Markie</title>
${BRAND_HEAD}</head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#171719;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box">
<div style="text-align:center;max-width:340px">
<div style="color:#ffffff;margin-bottom:12px">${brandLogoSvg(132)}</div>
<h2 style="font-size:19px;margin:0 0 6px">${esc(heading)}</h2>
<p style="color:#a1a1aa;font-size:15px;line-height:1.45;margin:0 0 22px;overflow-wrap:anywhere">${esc(sub)}</p>
${link ? `<a href="${esc(link.href)}" style="display:block;padding:13px 16px;border-radius:12px;background:#ffffff;color:#171719;font-weight:600;font-size:16px;text-decoration:none">${esc(link.label)}</a>` : ""}
</div>
</body></html>`,
    status
  );
}

function refusalWords(refusal: MobileRefusal, provider: MobileProvider): { heading: string; sub: string } {
  const name = provider === "apple" ? "Apple" : "Google";
  if (refusal === SIGNUP_INVITE_REQUIRED || refusal === SIGNUP_CLOSED) {
    return { heading: refusal === SIGNUP_CLOSED ? "No new accounts here" : "This server is invite-only", sub: signupRefusalMessage(refusal) };
  }
  if (refusal === PROVIDER_EMAIL_UNVERIFIED) {
    return {
      heading: `${name} hasn't verified this email`,
      sub: `Markie makes an account from ${name} only when ${name} has verified the email. Verify it with ${name}, or sign in with an email code.`,
    };
  }
  if (refusal === "account_not_linked") {
    return {
      heading: `${name} isn't linked to this account yet`,
      sub: `This email already has a Markie account. Sign in with an email code, then link ${name} in Markie on your computer, under Settings, Account, Manage linked sign-ins.`,
    };
  }
  return { heading: "Sign-in didn't complete", sub: "Head back to Markie and try again." };
}

export interface MobileAuthOptions {
  /** BETTER_AUTH_URL: where the provider sends the browser back to. */
  authBase: string;
  /** This server's origin, named on every link so the app can tell servers apart. */
  issuer: string | null;
  google: boolean;
  apple: boolean;
  store?: MobileHandoffStore;
  now?: () => number;
}

export function createMobileAuth({ authBase, issuer, google, apple, store, now = Date.now }: MobileAuthOptions): Hono {
  const app = new Hono();
  const handoffs = store ?? createMobileHandoffStore(openDatabase(), now);
  const offered = (provider: MobileProvider | null): provider is MobileProvider =>
    provider === "google" ? google : provider === "apple" ? apple : false;

  // The app opens this in the phone's browser. Without a well-formed
  // challenge there is nothing to bind a code to, so there is no sign-in:
  // this route has no weaker mode to fall back to.
  app.get("/auth/mobile-start", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const provider = mobileProvider(c.req.query("provider"));
    if (!offered(provider)) return c.text("That sign-in isn't set up on this server.", 404);
    const challenge = mobileChallenge(c.req.query("challenge"));
    const state = mobileState(c.req.query("state"));
    if (!challenge || !state) return c.text("This sign-in link is incomplete. Start again from Markie.", 400);
    const label = provider === "apple" ? "Apple" : "Google";
    try {
      const bridge = `${authBase}/auth/mobile-bridge?provider=${provider}&state=${state}&challenge=${challenge}`;
      const res = await auth.api.signInSocial({
        body: { provider, callbackURL: bridge, errorCallbackURL: bridge },
        asResponse: true,
      });
      const { url } = (await res.clone().json()) as { url?: string };
      if (!url) return c.text(`Could not start ${label} sign-in.`, 500);
      const headers = new Headers({ location: url, "cache-control": "private, no-store" });
      for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
      return new Response(null, { status: 302, headers });
    } catch (err) {
      console.error(`mobile ${provider}-start error:`, err);
      reportFault(err, "/auth/mobile-start");
      return c.text(`Could not start ${label} sign-in.`, 500);
    }
  });

  // The provider sends the browser here once the session cookie is set.
  app.get("/auth/mobile-bridge", async (c) => {
    const provider = mobileProvider(c.req.query("provider")) ?? "google";
    const state = mobileState(c.req.query("state"));
    const challenge = mobileChallenge(c.req.query("challenge"));
    const back = (refusal: MobileRefusal) => {
      const words = refusalWords(refusal, provider);
      return bridgePage(c, 401, words.heading, words.sub, { href: mobileRefusalLink(refusal, state, issuer), label: "Back to Markie" });
    };
    const error = c.req.query("error");
    if (error) return back(mobileRefusal(error));
    if (!state || !challenge) return back("failed");
    const result = await auth.api.getSession({ headers: c.req.raw.headers });
    const session = result?.session;
    if (!session?.id || !result?.user) return back("failed");
    const createdAt = new Date(session.createdAt).getTime();
    if (!Number.isFinite(createdAt) || now() - createdAt > MOBILE_SESSION_FRESH_MS) return back("failed");
    const code = handoffs.issue({ challenge, state, sessionId: session.id });
    return bridgePage(
      c,
      200,
      "You're signed in",
      `Signed in as ${result.user.email}. Go back to Markie to finish.`,
      { href: mobileReturnLink(code, state, issuer), label: "Return to Markie" }
    );
  });

  // The app's own request, over HTTPS, with the secret only it holds. Every
  // refusal reads the same, so the answer says nothing about which part was
  // wrong.
  app.post("/auth/mobile-exchange", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const refused = () => c.json({ error: "invalid_handoff" }, 400);
    let body: { code?: unknown; verifier?: unknown; state?: unknown; client?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return refused();
    }
    if (!body || typeof body !== "object") return refused();
    const sessionId = handoffs.redeem(body);
    if (!sessionId) return refused();
    const token = sessionToken(sessionId);
    if (!token) return refused();
    // better-auth has the last word on whether the sign-in is still good.
    const live = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    if (!live?.user || live.session.id !== sessionId) return refused();
    return c.json({ token, user: { id: live.user.id, email: live.user.email, name: live.user.name } });
  });

  return app;
}

let sessionDb: Database.Database | null = null;
function sessionToken(sessionId: string): string | null {
  sessionDb ??= openDatabase();
  const row = sessionDb.prepare('SELECT token FROM "session" WHERE id = ?').get(sessionId) as { token?: string } | undefined;
  return typeof row?.token === "string" && row.token ? row.token : null;
}
