// Hosted Live Docs: one address per cloud .wd. The design is
// markie-darkmown-sites-design-2026-11-01.md, "Who can see a Live Doc" and
// "Security model".
//
// Who can open one follows the document's Share settings:
//
//   private   the owner, through the pass below
//   shared    the owner and every member, viewer or editor, through the pass
//
// A Live Doc is never public. There is no address that opens without a
// Markie sign-in, and a darkmown document can hold no public link
// (public-links.ts), so its `/s/<token>` is the same 404 as a token that
// never existed (public.ts).
//
// Every open page keeps a stream to its own host (LIVE_DOC_CHANNEL_PATH). The
// stream re-checks access on a timer and whenever a route takes access away
// (live-docs-channels.ts), and a refusal empties the page, so a removed person
// loses a tab they already have open.
//
// Two hosts take part, and neither ever answers the other's routes:
//
//   <label>.<LIVE_DOCS_DOMAIN>   the Live Doc. Only `/` (the page),
//                                `/__markie/pass` (redeem a pass) and
//                                `/__markie/live` (the page's stream) exist
//                                here. Every app, API and auth path is a 404.
//   the app host                 `/live-docs/pass/<label>` mints a pass for a
//                                signed-in person who may open it, and
//                                `/api/docs/:id/live-doc` gives the owner the
//                                address. Neither exists on the live host.
//
// Opening a private Live Doc (design, "Security model" 4):
//
//   1. The live host has no valid cookie: it sets a short-lived nonce cookie
//      on its own host and redirects to the app host's
//      /live-docs/pass/<label>?state=<hash of the nonce>.
//   2. The app host checks the Markie sign-in (the existing web sign-in if
//      there is none) and access through the same accessLevel documents use.
//      Allowed: a pass, single use, 60 seconds, bound to doc, person, sign-in,
//      label and that state hash, stored hashed. The redirect to the live host
//      is built from the label stored for the document, never from the request.
//   3. The live host spends the pass only alongside the nonce cookie whose
//      hash it was bound to, the OAuth `state` pattern: a pass URL copied into
//      another browser opens nothing, and nobody can plant their own Live Doc
//      session in someone else's browser. It then sets a host-only `__Host-`
//      cookie whose value is a random id looked up server-side, and redirects
//      to `/` so the pass leaves the address bar.
//   4. Every load re-checks the document, the sign-in and access against the
//      database. A deleted document or lost access refuses the next load.
//
// The cookie opens one Live Doc and nothing else: it is a different site from
// Markie, so it never reaches the app or the API, and it never carries the
// Markie session.
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { auth } from "./auth.ts";
import { liveSession } from "./collab-tickets.ts";
import { accessLevel, canManageLevel, hasAudience } from "./shares.ts";
import { registerLiveDocChannel } from "./live-docs-channels.ts";
import { renderSignInNotice, webSignInHrefFor } from "./web-signin.ts";
import { classifyRequestHost, liveDocOrigin, LIVE_DOC_LABEL, type LiveDocsConfig } from "./live-docs-config.ts";
import { createLiveDocCompiler, LIVE_DOC_NETWORK_LIMIT, type LiveDocCompiler } from "./live-docs-compile.ts";
import {
  LIVE_DOC_CHANNEL_PATH, LIVE_DOC_HEADERS, LIVE_NOTICE_CSP, liveDocCsp, renderLiveDocPage, renderLiveNotice,
} from "./live-docs-page.ts";
import {
  LIVE_DOC_SESSION_TTL_MS, canOpenLiveDoc, consumeLiveDocTicket, createLiveDocSession, docIdForLabel,
  endLiveDocSession, ensureLiveDocLabel, issueLiveDocTicket, liveDocCookieRefused, liveDocLabel,
  liveDocLevelOpens, liveDocMeta, liveDocSessionFor, liveDocTakenDown, liveDocVersion, loadLiveDoc, markLiveDocSessionUsed,
  newLiveDocState, type LiveDocBinding, type LiveDocRow,
} from "./live-docs-store.ts";

/** The cookie on a Live Doc's own host. `__Host-`: Secure, Path=/, no Domain. */
export const LIVE_DOC_COOKIE = "__Host-markie-live";
/** Where the live host spends a pass. */
export const LIVE_DOC_REDEEM_PATH = "/__markie/pass";
/** Where the app host mints one. */
export const LIVE_DOC_PASS_PREFIX = "/live-docs/pass/";
/**
 * The nonce cookies that bind a pass to the browser that asked for it. One
 * per flow, named after the first 16 characters of its state hash, so two
 * tabs opening the same Live Doc at once never overwrite each other's.
 */
export const LIVE_DOC_STATE_COOKIE = "__Host-markie-live-state";
export const liveDocStateCookieName = (stateHash: string) => `${LIVE_DOC_STATE_COOKIE}-${stateHash.slice(0, 16)}`;
/** Long enough to sign in to Markie on the way, short enough to go stale. */
export const LIVE_DOC_STATE_TTL_S = 10 * 60;
const STATE_HASH = /^[a-f0-9]{64}$/;

export { LIVE_DOC_CHANNEL_PATH };

/** How often an open page's stream re-reads access, on top of the routes that take it away. */
export const LIVE_DOC_RECHECK_MS = 5_000;
/** A comment on the stream this often keeps every proxy on the way from timing it out. */
export const LIVE_DOC_PING_MS = 15_000;
/** A stream ends after this long and the page reconnects, so none lives forever. */
export const LIVE_DOC_CHANNEL_MAX_MS = 30 * 60 * 1000;
/** Open streams this process holds at most. */
export const LIVE_DOC_MEMBER_CHANNELS_MAX = 1_000;
/** Open streams one person holds at most. */
export const LIVE_DOC_CHANNELS_PER_KEY = 24;

/** Why a stream was closed, which picks the words the page shows. */
export type LiveDocRevokeReason = "access" | "gone";

function cookieFrom(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}

const setCookieHeader = (value: string, maxAgeSeconds: number) =>
  `${LIVE_DOC_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
const clearCookieHeader = () => `${LIVE_DOC_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
const setStateHeader = (state: { nonce: string; hash: string }) =>
  `${liveDocStateCookieName(state.hash)}=${state.nonce}; Path=/; Max-Age=${LIVE_DOC_STATE_TTL_S}; Secure; HttpOnly; SameSite=Lax`;
const clearStateHeader = (stateHash: string) => `${liveDocStateCookieName(stateHash)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

/** Whether a stored binding still opens `label`, read from the database now. */
function stillOpens(binding: LiveDocBinding, label: string): boolean {
  return binding.label === label
    && docIdForLabel(label) === binding.docId
    && liveSession(binding.userId, binding.authSessionId)
    && canOpenLiveDoc(binding.docId, binding.userId);
}

export interface LiveDocsOptions {
  config: LiveDocsConfig;
  /** The app's own origin (BETTER_AUTH_URL), where passes are minted and people sign in. */
  appOrigin: string;
  /** Where the bare live domain sends a visitor. */
  siteUrl: string;
  compiler?: LiveDocCompiler;
  /**
   * Every host name the app answers on. A Live Doc's `:fetch` may not reach
   * any of them, nor the live domain itself: a page has no business talking
   * to Markie's own API or to another Live Doc.
   */
  appHosts?: readonly string[];
  /** Test hooks: how often a stream re-checks and pings. */
  recheckMs?: number;
  pingMs?: number;
}

export function createLiveDocs({
  config, appOrigin, siteUrl, compiler = createLiveDocCompiler(), recheckMs = LIVE_DOC_RECHECK_MS, pingMs = LIVE_DOC_PING_MS, appHosts = [],
}: LiveDocsOptions) {
  const hostOf = (value: string) => { try { return new URL(value).hostname.toLowerCase(); } catch { return value.toLowerCase(); } };
  const forbiddenHosts = new Set([appOrigin, siteUrl, ...appHosts].filter(Boolean).map(hostOf));
  /** Why a page's network list cannot be hosted, or null when it can. */
  const networkRefusal = (network: readonly string[]): string | null => {
    if (network.length > LIVE_DOC_NETWORK_LIMIT) return `A Live Doc can fetch from at most ${LIVE_DOC_NETWORK_LIMIT} addresses.`;
    for (const origin of network) {
      const host = hostOf(origin);
      if (host === config.domain || host.endsWith(`.${config.domain}`) || forbiddenHosts.has(host)) {
        return `A Live Doc can't fetch from ${origin}, which is part of Markie.`;
      }
    }
    return null;
  };
  const passUrl = (label: string) => `${appOrigin}${LIVE_DOC_PASS_PREFIX}${label}`;
  const channelsByKey = new Map<string, number>();

  // ---------------------------------------------------------------- live host
  const live = new Hono<{ Bindings: { label: string } }>();

  // Every live response, whatever produced it, leaves with the same headers.
  // A route that renders the Live Doc itself sets the page CSP; everything
  // else gets the notice CSP, which runs no script at all.
  live.use("*", async (c, next) => {
    await next();
    const headers = c.res.headers;
    for (const [name, value] of Object.entries(LIVE_DOC_HEADERS)) headers.set(name, value);
    if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", LIVE_NOTICE_CSP);
  });

  const notice = (c: Context, status: 403 | 404 | 410 | 422 | 429 | 503, heading: string, line: string, link?: { href: string; label: string }) =>
    c.html(renderLiveNotice(heading, line, link), status);
  const takenDown = (c: Context) =>
    notice(c, 410, "This Live Doc was taken down", "Markie took this page down. Its owner still has the document.");

  async function servePage(c: Context, doc: LiveDocRow) {
    if (doc.content === null) return notice(c, 422, "This Live Doc can't be hosted yet", "Live Docs can be up to 200,000 characters.");
    const compiled = await compiler.compile(doc.content, doc.ownerId);
    if (!compiled.ok) {
      if (compiled.kind === "refused") return notice(c, 422, "This Live Doc can't be hosted yet", compiled.message);
      return notice(c, 503, "This Live Doc didn't load", compiled.message, { href: "/", label: "Try again" });
    }
    const refusal = networkRefusal(compiled.page.network);
    if (refusal) return notice(c, 422, "This Live Doc can't be hosted yet", refusal);
    const title = compiled.page.title || doc.name.replace(/\.wd$/i, "") || "Live Doc";
    c.header("Content-Security-Policy", liveDocCsp(compiled.page.network));
    return c.html(renderLiveDocPage({ ...compiled.page, title, version: doc.version }));
  }

  const toPass = (c: Context, label: string, clearCookie: boolean) => {
    const state = newLiveDocState();
    const headers = new Headers({ location: `${passUrl(label)}?state=${state.hash}` });
    if (clearCookie) headers.append("set-cookie", clearCookieHeader());
    headers.append("set-cookie", setStateHeader(state));
    return new Response(null, { status: 302, headers });
  };

  live.get(LIVE_DOC_REDEEM_PATH, (c) => {
    // A HEAD (a link checker, a prefetch) must not spend the pass the
    // browser's own GET is about to bring.
    if (c.req.method !== "GET") return c.text("Not found", 404);
    const label = c.env.label;
    const binding = consumeLiveDocTicket(c.req.query("ticket") ?? "", label, (stateHash) => cookieFrom(c.req.raw, liveDocStateCookieName(stateHash)));
    if (!binding || !stillOpens(binding, label)) {
      // Nothing is cleared: another tab's flow may still be on its way.
      return notice(c, 403, "This pass didn't work", "A pass works once, for a minute, in the browser that asked for it. If cookies are off for this site, turn them on. Then open the Live Doc again.", { href: "/", label: "Open this Live Doc" });
    }
    const session = createLiveDocSession(binding);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", setCookieHeader(session.value, Math.floor(LIVE_DOC_SESSION_TTL_MS / 1000)));
    headers.append("set-cookie", clearStateHeader(binding.stateHash));
    return new Response(null, { status: 303, headers });
  });

  live.get("/", async (c) => {
    const label = c.env.label;
    const addressed = docIdForLabel(label);
    if (addressed && liveDocTakenDown(addressed)) return takenDown(c);
    const value = cookieFrom(c.req.raw, LIVE_DOC_COOKIE);
    const binding = value ? liveDocSessionFor(value, label) : null;
    if (!binding) return toPass(c, label, value !== null);
    if (!stillOpens(binding, label)) {
      endLiveDocSession(value!);
      return toPass(c, label, true);
    }
    const doc = loadLiveDoc(binding.docId);
    if (!doc) {
      endLiveDocSession(value!);
      return toPass(c, label, true);
    }
    // The cookie came back, so it stuck; the pass's loop guard counts on this.
    markLiveDocSessionUsed(value!);
    return servePage(c, doc);
  });

  // The page's stream. It carries no content: `ready` once, a comment every
  // LIVE_DOC_PING_MS, and `revoked` when access ends, after which it closes.
  // A refusal is a 200 with `revoked`, never an error status, so the page can
  // tell "you lost access" from "the server is restarting" (the script in
  // live-docs-page.ts retries the second and blanks only on the first). The
  // same answer comes back for a label that does not exist.
  type Target =
    | { docId: string; key: string; check: () => LiveDocRevokeReason | null; onRevoke: () => void }
    | { reason: LiveDocRevokeReason };
  let channelsOpen = 0;

  function channelTarget(request: Request, label: string): Target {
    const value = cookieFrom(request, LIVE_DOC_COOKIE);
    const binding = value ? liveDocSessionFor(value, label) : null;
    if (!value || !binding) return { reason: "access" };
    const check = (): LiveDocRevokeReason | null => {
      if (!liveDocMeta(binding.docId) || liveDocTakenDown(binding.docId)) return "gone";
      return liveDocSessionFor(value, label) && stillOpens(binding, label) ? null : "access";
    };
    const now = check();
    if (now) {
      endLiveDocSession(value);
      return { reason: now };
    }
    return { docId: binding.docId, key: `user:${binding.userId}`, check, onRevoke: () => endLiveDocSession(value) };
  }

  live.get(LIVE_DOC_CHANNEL_PATH, (c) => {
    const target = channelTarget(c.req.raw, c.env.label);
    // The version the page shows, so a save between its load and this
    // stream is still reported. Anything else counts as "the current one".
    const shownRaw = c.req.query("v");
    const shown = shownRaw !== undefined && /^\d{1,15}$/.test(shownRaw) ? Number(shownRaw) : null;
    if ("docId" in target && (channelsOpen >= LIVE_DOC_MEMBER_CHANNELS_MAX || (channelsByKey.get(target.key) ?? 0) >= LIVE_DOC_CHANNELS_PER_KEY)) {
      // Busy, not refused: the page backs off and tries again.
      c.header("Retry-After", "30");
      return c.text("Too many open Live Doc pages", 429);
    }
    c.header("X-Accel-Buffering", "no");
    // Counted before the response is returned, so requests arriving together
    // cannot all pass the check above before any of them is counted.
    let counted = "docId" in target;
    if ("docId" in target) {
      channelsOpen += 1;
      channelsByKey.set(target.key, (channelsByKey.get(target.key) ?? 0) + 1);
    }
    const giveBack = () => {
      if (!counted || !("docId" in target)) return;
      counted = false;
      channelsOpen -= 1;
      const left = (channelsByKey.get(target.key) ?? 1) - 1;
      if (left > 0) channelsByKey.set(target.key, left);
      else channelsByKey.delete(target.key);
    };
    return streamSSE(c, async (stream) => {
      if (!("docId" in target)) {
        await stream.writeSSE({ event: "revoked", data: JSON.stringify({ reason: target.reason }) });
        return;
      }
      let finished = false;
      let release = () => {};
      const done = new Promise<void>((resolve) => { release = resolve; });
      // Set once the stream is up; finish() clears whichever exist.
      const timers: { recheck?: ReturnType<typeof setInterval>; ping?: ReturnType<typeof setInterval>; life?: ReturnType<typeof setTimeout> } = {};
      let unregister = () => {};
      const finish = (reason?: LiveDocRevokeReason) => {
        if (finished) return;
        finished = true;
        clearInterval(timers.recheck);
        clearInterval(timers.ping);
        clearTimeout(timers.life);
        unregister();
        giveBack();
        if (!reason) {
          release();
          return;
        }
        try {
          target.onRevoke();
        } catch (error) {
          console.error("live doc revoke cleanup failed:", error instanceof Error ? error.message : error);
        }
        stream.writeSSE({ event: "revoked", data: JSON.stringify({ reason }) }).catch(() => {}).finally(release);
      };
      let lastVersion = shown ?? liveDocVersion(target.docId);
      const recheck = () => {
        if (finished) return;
        let reason: LiveDocRevokeReason | null;
        let version: number | null = null;
        try {
          reason = target.check();
          if (!reason) version = liveDocVersion(target.docId);
        } catch (error) {
          // A database that is busy or closing must not take the server down
          // from a timer. The stream ends without "revoked", and the page
          // reconnects, which checks again.
          console.error("live doc recheck failed:", error instanceof Error ? error.message : error);
          finish();
          return;
        }
        if (reason) {
          finish(reason);
          return;
        }
        // A new version: the page reloads, or offers to if someone is using
        // it. The stream carries no content, only that it changed.
        if (version !== null) versionChanged(version);
      };
      const versionChanged = (version: number) => {
        if (finished || version === lastVersion || (lastVersion !== null && version < lastVersion)) return;
        lastVersion = version;
        stream.writeSSE({ event: "updated", data: "{}" }).catch(() => finish());
      };
      unregister = registerLiveDocChannel(target.docId, { recheck, versionChanged });
      stream.onAbort(() => finish());
      if (stream.aborted) {
        finish();
        return;
      }
      try {
        await stream.writeSSE({ event: "ready", data: "{}", retry: 3_000 });
        // Access may have changed between the request and the registration.
        recheck();
      } catch (error) {
        // The browser left, or the database refused: nothing stays registered.
        finish();
        throw error;
      }
      if (finished) {
        await done;
        return;
      }
      timers.recheck = setInterval(recheck, recheckMs);
      timers.ping = setInterval(() => {
        stream.write(": ping\n\n").catch(() => finish());
      }, pingMs);
      timers.life = setTimeout(() => finish(), LIVE_DOC_CHANNEL_MAX_MS);
      await done;
    }, async (error) => {
      // A stream that failed before it reached `finish` still gives its place back.
      giveBack();
      console.error("live doc stream failed:", error instanceof Error ? error.message : error);
    });
  });

  live.notFound((c) => c.text("Not found", 404));
  live.onError((err, c) => {
    console.error("live doc request failed:", err instanceof Error ? err.message : err);
    return c.text("Something went wrong", 500);
  });

  // ---------------------------------------------------------------- apex and refused
  const edge = new Hono<{ Bindings: { kind: "apex" | "refused" } }>();
  edge.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(LIVE_DOC_HEADERS)) c.res.headers.set(name, value);
    c.res.headers.set("Content-Security-Policy", LIVE_NOTICE_CSP);
    c.res.headers.delete("set-cookie");
  });
  // The bare domain is no document and sets no cookie: it points at Markie.
  edge.get("/", (c) => (c.env.kind === "apex" ? c.redirect(siteUrl, 302) : c.text("Not found", 404)));
  edge.notFound((c) => c.text("Not found", 404));

  /**
   * The response for a request on the live domain, or null when the request
   * is for the app. Called before any app middleware, so no app route, CORS
   * answer or app cookie can ever come back from a live host.
   */
  function dispatch(request: Request): Response | Promise<Response> | null {
    const host = classifyRequestHost(request, config);
    if (host.kind === "app") return null;
    if (host.kind === "live") return live.fetch(request, { label: host.label });
    return edge.fetch(request, { kind: host.kind });
  }

  // ---------------------------------------------------------------- app host
  const app = new Hono();

  app.get(`${LIVE_DOC_PASS_PREFIX}:label`, async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    const label = c.req.param("label");
    // The hash of the nonce cookie the live host set on this browser. Kept
    // through the web sign-in, and bound into the pass.
    const rawState = c.req.query("state");
    const state = typeof rawState === "string" && STATE_HASH.test(rawState) ? rawState : null;
    const back = `${LIVE_DOC_PASS_PREFIX}${label}${state ? `?state=${state}` : ""}`;
    const refused = (signedInAs: string | null) =>
      c.html(renderSignInNotice({
        title: "No access",
        heading: "This account can't open this Live Doc",
        lines: [
          signedInAs ? ["You're signed in as ", { strong: signedInAs }, "."] : ["You're signed in to Markie."],
          ["This Live Doc opens only for the people it's shared with. If it was shared with you, sign in with that account."],
        ],
        action: LIVE_DOC_LABEL.test(label)
          ? { href: webSignInHrefFor(appOrigin, back, { switchAccount: true })!, label: "Sign in with a different account" }
          : null,
      }), 404);
    if (!LIVE_DOC_LABEL.test(label)) return refused(null);

    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    const user = session?.user;
    const sessionId = session?.session?.id;
    // Signed out, or a sign-in that has already ended: the web sign-in, then
    // back here. The same page answers for a label that does not exist, so a
    // signed-out visitor learns nothing about which addresses are real.
    if (!user?.id || !sessionId || !liveSession(user.id, sessionId)) {
      return c.redirect(webSignInHrefFor(appOrigin, back)!, 302);
    }
    const docId = docIdForLabel(label);
    if (!docId || !canOpenLiveDoc(docId, user.id)) return refused(user.email ?? null);
    const stored = liveDocLabel(docId);
    if (!stored) return refused(user.email ?? null);
    if (liveDocCookieRefused(sessionId, stored)) {
      return c.html(renderSignInNotice({
        title: "Cookies needed",
        heading: "This browser didn't keep the Live Doc's cookie",
        lines: [
          ["A Live Doc keeps you in with a cookie on its own address, and this browser refused it, so the page can't open."],
          ["Allow cookies for this site, or open the address in another browser."],
        ],
        action: { href: `${liveDocOrigin(config, stored)}/`, label: "Try again" },
      }), 409);
    }
    // No browser nonce (a pass link opened directly, or a stale one): start
    // at the Live Doc's own address, which sets one and sends the browser back.
    if (!state) {
      return new Response(null, { status: 302, headers: { location: `${liveDocOrigin(config, stored)}/`, "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
    }
    const issued = issueLiveDocTicket({ docId, userId: user.id, authSessionId: sessionId, label: stored }, state);
    if (!issued) {
      c.header("Retry-After", "60");
      return c.text("Too many Live Docs opened in the last minute. Wait a moment and try again.", 429);
    }
    const target = `${liveDocOrigin(config, stored)}${LIVE_DOC_REDEEM_PATH}?ticket=${encodeURIComponent(issued.ticket)}`;
    return new Response(null, { status: 302, headers: { location: target, "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
  });

  // A Live Doc's address, for the Mac app and the web, for anyone it opens
  // for. Anyone else, and any document that does not exist, gets the same 404.
  // There is no public address to hand out: a Live Doc is never public.
  app.get("/api/docs/:id/live-doc", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user?.id) return c.json({ error: "unauthorized" }, 401);
    const docId = c.req.param("id");
    const level = accessLevel(docId, session.user.id);
    if (!liveDocLevelOpens(level)) return c.json({ error: "not_found" }, 404);
    if (!liveDocMeta(docId)) return c.json({ error: "not_a_live_doc" }, 404);
    if (liveDocTakenDown(docId)) return c.json({ error: "taken_down" }, 410);
    const url = `${liveDocOrigin(config, ensureLiveDocLabel(docId))}/`;
    // What the page can reach on the network (design, "Security model" 3),
    // from the same cached compile the page uses. Shown before the address is
    // shared; anyone who can open the page can read its source anyway.
    // null means "not known right now" (busy, or the compile did not finish):
    // the Share dialog then asks rather than assuming the page reaches nothing.
    const doc = loadLiveDoc(docId);
    const compiled = doc?.content ? await compiler.compile(doc.content, doc.ownerId) : null;
    const network = !compiled || (!compiled.ok && compiled.kind === "refused") ? []
      : compiled.ok ? (networkRefusal(compiled.page.network) ? [] : compiled.page.network)
      : null;
    if (!canManageLevel(level)) return c.json({ url, access: "shared", network });
    return c.json({ url, access: hasAudience(docId) ? "shared" : "private", network });
  });

  return { dispatch, app, compiler };
}

export type LiveDocs = ReturnType<typeof createLiveDocs>;
