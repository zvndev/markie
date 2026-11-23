// Google and Apple sign-in for the phone app ("Markie Docs").
//
// The provider's screen runs in the phone's browser. The desktop bridge
// (desktop-auth.ts) puts the session token in its link back to the app. The
// phone's path shares nothing with it, and never puts a session anywhere a
// browser, a link or another app can reach:
//
//   1. The app makes a random secret and keeps it in the Keychain. It opens
//      GET /auth/mobile-start with the secret's SHA-256 (the challenge) and a
//      random state. That request opens a sign-in here: one row, holding the
//      challenge, the state, a random cookie given to this browser alone,
//      and the `state` better-auth made for this one trip to the provider.
//   2. The provider sends the browser to better-auth's callback. settle()
//      below sees every answer the callback gives. When the answer is this
//      flow's own (the same better-auth state, checked by better-auth against
//      its own cookie), the session the callback just made is ended on the
//      spot, its cookie is never sent to the browser, and the row is marked
//      with the account that signed in. Nothing else can mark a row: not a
//      session the browser already had, and not a callback from another
//      start.
//   3. The browser lands on GET /auth/mobile-bridge. Only the browser holding
//      the row's cookie gets a code, once: 32 random bytes, good for two
//      minutes and one use, stored only as a hash. The page's button carries
//      the code, the state and this server's origin back to the app.
//   4. The app posts the code, the secret and the state to
//      POST /auth/mobile-exchange over HTTPS. The code is spent the moment it
//      is looked up, right or wrong. When the secret hashes to the challenge
//      the sign-in was opened with, the app gets a session made for it there
//      and then. No browser ever held it.
//
// So the challenge a code answers to is always the one its sign-in was
// opened with, and a link that leaks is a code with no secret: it opens
// nothing, and trying it spends it.
//
// The way back. A `markie-mobile://auth` link can be taken by any app that
// registers the scheme. An app that only receives the link has no secret,
// so it gets nothing. An app that opened the sign-in itself, and got someone
// to finish it and tap the button, would hold the secret too. On Markie
// Cloud the button is therefore an https link on a host the operating system
// has verified belongs to Markie (well-known.ts MOBILE_RETURN_PATH), which
// only the real app can receive. The custom scheme stays for self-hosted
// servers, whose hosts the app cannot claim, and for Android until its
// signing fingerprint is published.
//
// The bridge never sends the browser on by itself. The person taps "Return
// to Markie", under the address they signed in with.
//
// One writer. Rows live in this server's SQLite file and the rate limits in
// this process. A standby that takes over starts from the replicated file:
// a sign-in or code that was not copied in time is unknown to it and is
// refused, and the person starts again. Nothing is ever accepted that the
// database does not hold.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type Database from "better-sqlite3";
import { auth } from "./auth.ts";
import { clientIpHeader } from "./runtime-config.ts";
import { MOBILE_RETURN_PATH } from "./well-known.ts";
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
// How long a sign-in may spend at the provider: better-auth keeps its own
// state for ten minutes, so a later callback is refused there anyway.
export const MOBILE_SIGN_IN_TTL_MS = 10 * 60 * 1000;
// Sign-ins and codes waiting at once, in all and for one client address. A
// start past either is refused, so the table cannot be grown without bound.
export const MOBILE_PENDING_MAX = 2000;
export const MOBILE_PENDING_PER_ADDRESS = 30;
// The exchange's whole body is four short strings.
export const MOBILE_EXCHANGE_BODY_MAX = 4096;
// Requests per client address per minute. Phones behind one carrier address
// share a bucket, so these are loose for a person and tight for a script.
export const MOBILE_RATE = { start: 20, bridge: 60, exchange: 20, windowMs: 60_000 } as const;
/** The cookie that ties a sign-in to the browser it was opened in. */
export const MOBILE_BROWSER_COOKIE = "markie_mobile_sign_in";

// SHA-256 of the app's secret, lowercase hex. Echoed into a URL, so only this
// exact shape is ever accepted.
const CHALLENGE = /^[0-9a-f]{64}$/;
// The app's secret: 32 random bytes, lowercase hex.
const VERIFIER = /^[0-9a-f]{64}$/;
const STATE = /^[0-9a-f]{32,64}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const BROWSER = /^[A-Za-z0-9_-]{43}$/;

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

function returnLink(params: Record<string, string | null>, verified: string | null): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
  // On a verified host the pieces ride the fragment, which a browser never
  // sends to a server: if the app is not there to take the link, the code
  // reaches nobody's log.
  return verified ? `${verified}${MOBILE_RETURN_PATH}#${query}` : `${MOBILE_APP_SCHEME}://auth?${query}`;
}

/**
 * The link back to the app after a sign-in. A code, never a token. `verified`
 * is the https origin the operating system hands only to the real app, or
 * null for the custom scheme.
 */
export function mobileReturnLink(code: string, state: string, issuer: string | null, verified: string | null = null): string {
  return returnLink({ code, state, iss: issuer }, verified);
}

// Why a sign-in did not finish, in words the app chooses (it never shows text
// taken from a link). Anything not named here is "failed".
export const MOBILE_REFUSALS = [SIGNUP_INVITE_REQUIRED, SIGNUP_CLOSED, PROVIDER_EMAIL_UNVERIFIED, "account_not_linked", "failed"] as const;
export type MobileRefusal = (typeof MOBILE_REFUSALS)[number];

export function mobileRefusal(raw: unknown): MobileRefusal {
  return (MOBILE_REFUSALS as readonly string[]).includes(raw as string) ? (raw as MobileRefusal) : "failed";
}

/** The link back to the app when the sign-in was refused. It carries no code. */
export function mobileRefusalLink(refusal: MobileRefusal, state: string | null, issuer: string | null, verified: string | null = null): string {
  return returnLink({ error: refusal, state, iss: issuer }, verified);
}

export interface MobileHandoffStore {
  /** Whether one more sign-in may be opened for this client address. */
  room(address: string): boolean;
  /**
   * Opens a sign-in: the challenge and state the app sent, and the better-auth
   * state (`flow`) of the one provider trip that may finish it. The answer is
   * the secret for this browser's cookie, or null when there is no room.
   * `replaces` is the cookie this browser already held: its sign-in is dropped.
   */
  start(input: { provider: MobileProvider; challenge: string; state: string; flow: string; address: string; replaces?: unknown }): string | null;
  /**
   * The provider callback for `flow` signed this account in. True once, and
   * only for a sign-in that is open and waiting on exactly that flow.
   */
  complete(input: { flow: unknown; userId: string }): boolean;
  /** A code for the finished sign-in this browser opened. Once. Only its hash is kept. */
  issue(browser: unknown): { code: string; state: string; userId: string } | null;
  /** Ends this browser's sign-in without a code. The answer is what to tell the app. */
  refuse(browser: unknown): { state: string; provider: MobileProvider } | null;
  /**
   * Spends a code. The answer is the account it names, or null for anything
   * wrong. A code that was looked up is gone, whatever else was wrong.
   */
  redeem(input: { code?: unknown; verifier?: unknown; state?: unknown; client?: unknown }): string | null;
  /** Removes everything that has expired. The answer is how many rows went. */
  sweep(): number;
}

export function createMobileHandoffStore(
  db: Database.Database,
  now: () => number = Date.now,
  limits: { max: number; perAddress: number } = { max: MOBILE_PENDING_MAX, perAddress: MOBILE_PENDING_PER_ADDRESS }
): MobileHandoffStore {
  // One row per sign-in, from the start to the code. status goes
  // started -> signed_in -> issued, forwards only, each step once.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_sign_ins (
      browser_hash TEXT PRIMARY KEY,
      flow_hash TEXT NOT NULL UNIQUE,
      client TEXT NOT NULL,
      provider TEXT NOT NULL,
      challenge TEXT NOT NULL,
      state TEXT NOT NULL,
      address TEXT NOT NULL,
      status TEXT NOT NULL,
      user_id TEXT,
      code_hash TEXT UNIQUE,
      expires_at INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_sign_ins_expiry ON mobile_sign_ins(expires_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mobile_sign_ins_address ON mobile_sign_ins(address)");
  const insert = db.prepare(
    "INSERT INTO mobile_sign_ins (browser_hash, flow_hash, client, provider, challenge, state, address, status, expires_at) VALUES (?,?,?,?,?,?,?,'started',?)"
  );
  const sweep = db.prepare("DELETE FROM mobile_sign_ins WHERE expires_at <= ?");
  const countAll = db.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins WHERE expires_at > ?");
  const countAddress = db.prepare("SELECT COUNT(*) AS n FROM mobile_sign_ins WHERE address = ? AND expires_at > ?");
  const drop = db.prepare("DELETE FROM mobile_sign_ins WHERE browser_hash = ? RETURNING state, provider");
  const complete = db.prepare(
    "UPDATE mobile_sign_ins SET status = 'signed_in', user_id = ? WHERE flow_hash = ? AND status = 'started' AND expires_at > ?"
  );
  const issue = db.prepare(
    "UPDATE mobile_sign_ins SET status = 'issued', code_hash = ?, expires_at = ? WHERE browser_hash = ? AND status = 'signed_in' AND expires_at > ? RETURNING state, user_id AS userId"
  );
  const take = db.prepare(
    "DELETE FROM mobile_sign_ins WHERE code_hash = ? RETURNING client, challenge, state, status, user_id AS userId, expires_at AS expiresAt"
  );
  const browserHash = (browser: unknown) => (typeof browser === "string" && BROWSER.test(browser) ? sha256Hex(browser) : null);
  const addressKey = (address: string) => sha256Hex(address);
  const room = (address: string) => {
    const at = now();
    if ((countAll.get(at) as { n: number }).n >= limits.max) return false;
    return (countAddress.get(addressKey(address), at) as { n: number }).n < limits.perAddress;
  };
  const open = db.transaction((input: Parameters<MobileHandoffStore["start"]>[0]): string | null => {
    sweep.run(now());
    const old = browserHash(input.replaces);
    if (old) drop.run(old);
    if (!room(input.address)) return null;
    const browser = randomBytes(32).toString("base64url");
    insert.run(sha256Hex(browser), sha256Hex(input.flow), MOBILE_CLIENT, input.provider, input.challenge, input.state, addressKey(input.address), now() + MOBILE_SIGN_IN_TTL_MS);
    return browser;
  });
  return {
    room,
    start: (input) => open(input),
    complete({ flow, userId }) {
      if (typeof flow !== "string" || !flow || !userId) return false;
      return complete.run(userId, sha256Hex(flow), now()).changes === 1;
    },
    issue(browser) {
      const hash = browserHash(browser);
      if (!hash) return null;
      sweep.run(now());
      const code = randomBytes(32).toString("base64url");
      // The update is the check, so two requests can never both get a code.
      const row = issue.get(sha256Hex(code), now() + MOBILE_HANDOFF_TTL_MS, hash, now()) as { state: string; userId: string } | undefined;
      return row ? { code, state: row.state, userId: row.userId } : null;
    },
    refuse(browser) {
      const hash = browserHash(browser);
      if (!hash) return null;
      const row = drop.get(hash) as { state: string; provider: string } | undefined;
      return row ? { state: row.state, provider: mobileProvider(row.provider) ?? "google" } : null;
    },
    redeem({ code, verifier, state, client }) {
      if (typeof code !== "string" || !CODE.test(code)) return null;
      // The delete is the lookup, so two requests can never both get the row.
      const row = take.get(sha256Hex(code)) as
        | { client: string; challenge: string; state: string; status: string; userId: string | null; expiresAt: number }
        | undefined;
      if (!row) return null;
      if (row.expiresAt <= now()) return null;
      if (row.status !== "issued" || !row.userId) return null;
      if (client !== row.client) return null;
      if (typeof verifier !== "string" || !VERIFIER.test(verifier)) return null;
      if (typeof state !== "string" || !sameText(state, row.state)) return null;
      if (!sameText(sha256Hex(verifier), row.challenge)) return null;
      return row.userId;
    },
    sweep: () => sweep.run(now()).changes,
  };
}

/**
 * Counts requests per key in a fixed window, in memory. The map is bounded:
 * when it is full of live windows a new key is refused, not let through.
 */
export function createRateLimiter(now: () => number = Date.now, maxKeys = 20_000) {
  const windows = new Map<string, { until: number; count: number }>();
  const prune = () => {
    const at = now();
    for (const [key, window] of windows) if (window.until <= at) windows.delete(key);
  };
  return {
    allow(key: string, max: number, windowMs: number): boolean {
      const at = now();
      const window = windows.get(key);
      if (window && window.until > at) return ++window.count <= max;
      if (windows.size >= maxKeys) {
        prune();
        if (windows.size >= maxKeys) return false;
      }
      windows.set(key, { until: at + windowMs, count: 1 });
      return true;
    },
    prune,
    size: () => windows.size,
  };
}

/**
 * Reads a JSON body of at most `max` bytes. "too_large" is decided from
 * Content-Length when there is one, and otherwise as the bytes arrive, so a
 * long body is never held: reading stops at the first byte past the limit.
 */
export async function readSmallJson(request: Request, max: number): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "invalid" }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: "too_large" };
  if (!request.body) return { ok: false, reason: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
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
  /**
   * The https origin whose MOBILE_RETURN_PATH the operating system hands only
   * to the real app (well-known.ts verifiedReturnOrigin), or null to go back
   * through markie-mobile://auth. `android` says Android's verification is
   * live too; until it is, an Android browser gets the custom scheme.
   */
  verifiedReturn?: { origin: string; android: boolean } | null;
  store?: MobileHandoffStore;
  now?: () => number;
  /** How often expired sign-ins are removed. 0 leaves it to the requests. */
  sweepEveryMs?: number;
}

export interface MobileAuth {
  app: Hono;
  /**
   * Every answer better-auth gives on /api/auth/* passes through here. One
   * that sends the browser to the phone's bridge is a phone sign-in: the
   * session it made is ended, no cookie it set is passed on, and the sign-in
   * that flow opened is marked with the account. Any other answer is
   * returned untouched.
   */
  settle(request: Request, response: Response): Promise<Response>;
  /** Stops the sweep timer. */
  stop(): void;
}

export function createMobileAuth({ authBase, issuer, google, apple, verifiedReturn = null, store, now = Date.now, sweepEveryMs = 60_000 }: MobileAuthOptions): MobileAuth {
  const app = new Hono();
  const handoffs = store ?? createMobileHandoffStore(openDatabase(), now);
  const limiter = createRateLimiter(now);
  const addressHeader = clientIpHeader();
  const bridgeAt = new URL("/auth/mobile-bridge", authBase);
  const secure = bridgeAt.protocol === "https:";
  const offered = (provider: MobileProvider | null): provider is MobileProvider =>
    provider === "google" ? google : provider === "apple" ? apple : false;

  // Expired sign-ins go on a timer as well as on use, so a burst of starts
  // that nobody finishes does not sit in the table until the next sign-in.
  const timer = sweepEveryMs > 0
    ? setInterval(() => {
        try {
          handoffs.sweep();
          limiter.prune();
        } catch (err) {
          reportFault(err, "mobile sign-in sweep");
        }
      }, sweepEveryMs)
    : null;
  timer?.unref();

  // The address the edge names (runtime-config.ts clientIpHeader), as
  // better-auth reads it for its own limits. Requests without one share a
  // single bucket instead of going unlimited.
  const addressOf = (c: Context) => (c.req.header(addressHeader) ?? "").split(",")[0].trim().slice(0, 64) || "unknown";
  const allowed = (c: Context, route: keyof Omit<typeof MOBILE_RATE, "windowMs">) =>
    limiter.allow(`${route}:${addressOf(c)}`, MOBILE_RATE[route], MOBILE_RATE.windowMs);
  const busy = (c: Context) => {
    c.header("Retry-After", String(Math.ceil(MOBILE_RATE.windowMs / 1000)));
    return c.text("Too many sign-in tries. Wait a minute and try again.", 429);
  };

  const browserCookie = (value: string, maxAge: number) =>
    `${MOBILE_BROWSER_COOKIE}=${value}; Path=/auth; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const browserOf = (c: Context) => {
    for (const part of (c.req.header("cookie") ?? "").split(";")) {
      const at = part.indexOf("=");
      if (at > 0 && part.slice(0, at).trim() === MOBILE_BROWSER_COOKIE) return part.slice(at + 1).trim();
    }
    return null;
  };
  const verifiedFor = (c: Context) => {
    if (!verifiedReturn) return null;
    const android = /android/i.test(c.req.header("user-agent") ?? "");
    return android && !verifiedReturn.android ? null : verifiedReturn.origin;
  };

  // The app opens this in the phone's browser. Without a well-formed
  // challenge there is nothing to bind a code to, so there is no sign-in:
  // this route has no weaker mode to fall back to.
  app.get("/auth/mobile-start", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!allowed(c, "start")) return busy(c);
    const provider = mobileProvider(c.req.query("provider"));
    if (!offered(provider)) return c.text("That sign-in isn't set up on this server.", 404);
    const challenge = mobileChallenge(c.req.query("challenge"));
    const state = mobileState(c.req.query("state"));
    if (!challenge || !state) return c.text("This sign-in link is incomplete. Start again from Markie.", 400);
    const label = provider === "apple" ? "Apple" : "Google";
    const address = addressOf(c);
    // Asked before better-auth writes its own state row, so a full table
    // costs the database nothing more.
    if (!handoffs.room(address)) return busy(c);
    try {
      const bridge = `${bridgeAt.origin}${bridgeAt.pathname}?provider=${provider}`;
      const res = await auth.api.signInSocial({
        body: { provider, callbackURL: bridge, errorCallbackURL: bridge },
        asResponse: true,
      });
      const { url } = (await res.clone().json()) as { url?: string };
      const flow = url ? new URL(url).searchParams.get("state") : null;
      if (!url || !flow) return c.text(`Could not start ${label} sign-in.`, 500);
      const browser = handoffs.start({ provider, challenge, state, flow, address, replaces: browserOf(c) });
      if (!browser) return busy(c);
      const headers = new Headers({ location: url, "cache-control": "private, no-store" });
      for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
      headers.append("set-cookie", browserCookie(browser, Math.ceil(MOBILE_SIGN_IN_TTL_MS / 1000)));
      return new Response(null, { status: 302, headers });
    } catch (err) {
      console.error(`mobile ${provider}-start error:`, err);
      reportFault(err, "/auth/mobile-start");
      return c.text(`Could not start ${label} sign-in.`, 500);
    }
  });

  // The provider's callback sends the browser here. By now settle() has
  // marked the sign-in or left it alone; this page only asks whether the
  // browser that opened it is the one asking.
  app.get("/auth/mobile-bridge", async (c) => {
    if (!allowed(c, "bridge")) return busy(c);
    const browser = browserOf(c);
    // The cookie is for one visit. It goes whatever happens next.
    c.header("Set-Cookie", browserCookie("", 0));
    const verified = verifiedFor(c);
    const back = (refusal: MobileRefusal, state: string | null, provider: MobileProvider) => {
      const words = refusalWords(refusal, provider);
      return bridgePage(c, 401, words.heading, words.sub, { href: mobileRefusalLink(refusal, state, issuer, verified), label: "Back to Markie" });
    };
    const named = mobileProvider(c.req.query("provider")) ?? "google";
    const error = c.req.query("error");
    if (error) {
      const ended = handoffs.refuse(browser);
      return back(mobileRefusal(error), ended?.state ?? null, ended?.provider ?? named);
    }
    const issued = handoffs.issue(browser);
    if (!issued) {
      const ended = handoffs.refuse(browser);
      return back("failed", ended?.state ?? null, ended?.provider ?? named);
    }
    const user = await (await auth.$context).internalAdapter.findUserById(issued.userId);
    if (!user?.email) {
      handoffs.refuse(browser);
      return back("failed", issued.state, named);
    }
    return bridgePage(
      c,
      200,
      "You're signed in",
      `Signed in as ${user.email}. Go back to Markie to finish.`,
      { href: mobileReturnLink(issued.code, issued.state, issuer, verified), label: "Return to Markie" }
    );
  });

  // Where the verified link points. The app takes the link before any request
  // is made, so a browser only gets here when it did not: the app is not
  // installed, or the phone chose the browser. The code is in the fragment,
  // which never reaches this route, and there is nothing to do with it here.
  app.get(MOBILE_RETURN_PATH, (c) => {
    if (!allowed(c, "bridge")) return busy(c);
    return bridgePage(c, 200, "Open Markie to finish", "This link opens the Markie app. If you're still here, go back to Markie and sign in with an email code.", null);
  });

  // The app's own request, over HTTPS, with the secret only it holds. Every
  // refusal reads the same, so the answer says nothing about which part was
  // wrong.
  app.post("/auth/mobile-exchange", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!allowed(c, "exchange")) {
      c.header("Retry-After", String(Math.ceil(MOBILE_RATE.windowMs / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    const refused = () => c.json({ error: "invalid_handoff" }, 400);
    const read = await readSmallJson(c.req.raw, MOBILE_EXCHANGE_BODY_MAX);
    if (!read.ok) return read.reason === "too_large" ? c.json({ error: "body too large" }, 413) : refused();
    const body = read.value as { code?: unknown; verifier?: unknown; state?: unknown; client?: unknown } | null;
    if (!body || typeof body !== "object") return refused();
    const userId = handoffs.redeem(body);
    if (!userId) return refused();
    // A session of the app's own, made now. No browser ever had it, so
    // nothing a browser can be sent to (the desktop bridge) can hand it on.
    const context = await auth.$context;
    const user = await context.internalAdapter.findUserById(userId);
    if (!user?.email) return refused();
    const session = await context.internalAdapter.createSession(userId, false, {
      ipAddress: addressOf(c) === "unknown" ? "" : addressOf(c),
      userAgent: (c.req.header("user-agent") ?? "").slice(0, 512),
    });
    if (!session?.token) return refused();
    return c.json({ token: session.token, user: { id: user.id, email: user.email, name: user.name } });
  });

  async function settle(request: Request, response: Response): Promise<Response> {
    const location = response.headers.get("location");
    if (!location) return response;
    let target: URL;
    try {
      target = new URL(location, bridgeAt.origin);
    } catch {
      return response;
    }
    if (target.origin !== bridgeAt.origin || target.pathname !== bridgeAt.pathname) return response;
    // The browser gets a new answer made from scratch: where to go, and the
    // cookies the callback cleared (its own spent state). Nothing else the
    // callback wrote is passed on. Its session cookie is one such thing, and
    // the bearer plugin's set-auth-token header, which carries the same
    // session, is another.
    const cookies = response.headers.getSetCookie();
    const headers = new Headers({ location, "cache-control": "private, no-store" });
    for (const cookie of cookies) if (/;\s*max-age=0(?:;|$)/i.test(cookie)) headers.append("set-cookie", cookie);
    try {
      const cookie = cookies.map((entry) => entry.split(";")[0]).join("; ");
      const made = cookie ? await auth.api.getSession({ headers: new Headers({ cookie }) }) : null;
      if (made?.session?.token) {
        // Ended first. The sign-in is marked only once the session is gone,
        // so a failure here leaves nothing a code could be minted from.
        await (await auth.$context).internalAdapter.deleteSession(made.session.token);
        const flow = new URL(request.url).searchParams.get("state");
        if (!target.searchParams.has("error") && made.user?.id) handoffs.complete({ flow, userId: made.user.id });
      }
    } catch (err) {
      console.error("mobile sign-in callback failed:", err instanceof Error ? err.message : "unknown error");
      reportFault(err, "/api/auth/callback (mobile)");
    }
    return new Response(null, { status: response.status, headers });
  }

  return { app, settle, stop: () => { if (timer) clearInterval(timer); } };
}
