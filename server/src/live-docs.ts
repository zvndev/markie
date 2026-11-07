// Hosted Live Docs: one address per cloud .wd, private to its owner in H1.
// The design is markie-darkmown-sites-design-2026-11-01.md, "Who can see a
// Live Doc" and "Security model".
//
// Two hosts take part, and neither ever answers the other's routes:
//
//   <label>.<LIVE_DOCS_DOMAIN>   the Live Doc. Only `/` (the page) and
//                                `/__markie/pass` (redeem a pass) exist here.
//                                Every app, API and auth path is a 404.
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
import { auth } from "./auth.ts";
import { liveSession } from "./collab-tickets.ts";
import { accessLevel } from "./shares.ts";
import { renderSignInNotice, webSignInHrefFor } from "./web-signin.ts";
import { classifyRequestHost, liveDocOrigin, LIVE_DOC_LABEL, type LiveDocsConfig } from "./live-docs-config.ts";
import { createLiveDocCompiler, type LiveDocCompiler } from "./live-docs-compile.ts";
import {
  LIVE_DOC_HEADERS, LIVE_DOC_CSP, LIVE_NOTICE_CSP, renderLiveDocPage, renderLiveNotice,
} from "./live-docs-page.ts";
import {
  LIVE_DOC_SESSION_TTL_MS, canOpenLiveDoc, consumeLiveDocTicket, createLiveDocSession, docIdForLabel,
  endLiveDocSession, ensureLiveDocLabel, issueLiveDocTicket, liveDocCookieRefused, liveDocLabel, liveDocSessionFor,
  loadLiveDoc, markLiveDocSessionUsed, newLiveDocState, type LiveDocBinding,
} from "./live-docs-store.ts";

/** The cookie on a Live Doc's own host. `__Host-`: Secure, Path=/, no Domain. */
export const LIVE_DOC_COOKIE = "__Host-markie-live";
/** Where the live host spends a pass. */
export const LIVE_DOC_REDEEM_PATH = "/__markie/pass";
/** Where the app host mints one. */
export const LIVE_DOC_PASS_PREFIX = "/live-docs/pass/";
/** The nonce cookie that binds a pass to the browser that asked for it. */
export const LIVE_DOC_STATE_COOKIE = "__Host-markie-live-state";
/** Long enough to sign in to Markie on the way, short enough to go stale. */
export const LIVE_DOC_STATE_TTL_S = 10 * 60;
const STATE_HASH = /^[a-f0-9]{64}$/;

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
const setStateHeader = (nonce: string) =>
  `${LIVE_DOC_STATE_COOKIE}=${nonce}; Path=/; Max-Age=${LIVE_DOC_STATE_TTL_S}; Secure; HttpOnly; SameSite=Lax`;
const clearStateHeader = () => `${LIVE_DOC_STATE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

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
}

export function createLiveDocs({ config, appOrigin, siteUrl, compiler = createLiveDocCompiler() }: LiveDocsOptions) {
  const passUrl = (label: string) => `${appOrigin}${LIVE_DOC_PASS_PREFIX}${label}`;

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

  const notice = (c: Context, status: 403 | 404 | 422 | 429 | 503, heading: string, line: string, link?: { href: string; label: string }) =>
    c.html(renderLiveNotice(heading, line, link), status);

  const toPass = (c: Context, label: string, clearCookie: boolean) => {
    const state = newLiveDocState();
    const headers = new Headers({ location: `${passUrl(label)}?state=${state.hash}` });
    if (clearCookie) headers.append("set-cookie", clearCookieHeader());
    headers.append("set-cookie", setStateHeader(state.nonce));
    return new Response(null, { status: 302, headers });
  };

  live.get(LIVE_DOC_REDEEM_PATH, (c) => {
    // A HEAD (a link checker, a prefetch) must not spend the pass the
    // browser's own GET is about to bring.
    if (c.req.method !== "GET") return c.text("Not found", 404);
    const label = c.env.label;
    const stateNonce = cookieFrom(c.req.raw, LIVE_DOC_STATE_COOKIE);
    const binding = consumeLiveDocTicket(c.req.query("ticket") ?? "", label, stateNonce);
    if (!binding || !stillOpens(binding, label)) {
      c.header("set-cookie", clearStateHeader());
      return notice(c, 403, "This pass didn't work", "A pass works once, for a minute, in the browser that asked for it. If cookies are off for this site, turn them on. Then open the Live Doc again.", { href: "/", label: "Open this Live Doc" });
    }
    const session = createLiveDocSession(binding);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", setCookieHeader(session.value, Math.floor(LIVE_DOC_SESSION_TTL_MS / 1000)));
    headers.append("set-cookie", clearStateHeader());
    return new Response(null, { status: 303, headers });
  });

  live.get("/", async (c) => {
    const label = c.env.label;
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
    const compiled = await compiler.compile(doc.content, doc.ownerId);
    if (!compiled.ok) {
      if (compiled.kind === "refused") return notice(c, 422, "This Live Doc can't be hosted yet", compiled.message);
      return notice(c, 503, "This Live Doc didn't load", compiled.message, { href: "/", label: "Try again" });
    }
    const title = compiled.page.title || doc.name.replace(/\.wd$/i, "") || "Live Doc";
    c.header("Content-Security-Policy", LIVE_DOC_CSP);
    return c.html(renderLiveDocPage({ ...compiled.page, title }));
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
          ["Live Docs open only for the account that owns them. If it's yours, sign in with that account."],
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

  // The owner's view of a Live Doc's address, for the Mac app. Anyone else,
  // and any document that does not exist, gets the same 404.
  app.get("/api/docs/:id/live-doc", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user?.id) return c.json({ error: "unauthorized" }, 401);
    const docId = c.req.param("id");
    if (accessLevel(docId, session.user.id) !== "owner") return c.json({ error: "not_found" }, 404);
    if (!loadLiveDoc(docId)) return c.json({ error: "not_a_live_doc" }, 404);
    const label = ensureLiveDocLabel(docId);
    return c.json({ url: `${liveDocOrigin(config, label)}/`, access: "private" });
  });

  return { dispatch, app, compiler };
}

export type LiveDocs = ReturnType<typeof createLiveDocs>;
