import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { auth } from "./auth.ts";
import { docs, configureDocsCloudAreas } from "./docs.ts";
import { shares } from "./shares.ts";
import { comments } from "./comments.ts";
import { themes } from "./themes.ts";
import { assetsApi, sweepOrphans } from "./assets.ts";
import { docLinksApi } from "./doc-links.ts";
import { publicShare } from "./public.ts";
import { docView } from "./doc-view.ts";
import { agentTokens } from "./agent-tokens.ts";
import { agentDocsApi, restAgentAuth } from "./agent-docs.ts";
import { mcpApi, mcpAuth } from "./mcp-server.ts";
import { createWellKnown } from "./well-known.ts";
import { createWebSignIn } from "./web-signin.ts";
import { attachCollab, closeAllRooms, terminateAllRooms } from "./collab.ts";
import { desktopAuthDeepLink, desktopAuthIssuer, desktopAuthState } from "./desktop-auth.ts";
import { applicationOrigins } from "./application-origins.ts";
import { canonicalHostRedirect } from "./canonical-host.ts";
import { closeAllDatabases, openDatabase } from "./db.ts";
import { installGracefulStop } from "./graceful-stop.ts";
import { cronsEnabled, releaseCommit } from "./runtime-config.ts";
import { createDocumentPlatform } from "./document-platform.ts";
import { createSqliteDocumentPlatformStore } from "./document-platform-store.ts";
import type Database from "better-sqlite3";
import { accountIdentitiesEnabled, guardAccountAuthRequest } from "./account-context.ts";
import { createAccountPlatform } from "./account-platform.ts";
import { resolveAuthSecret } from "./auth-secret.ts";
import { resolveVerifiedUserForEmail } from "./account-identities.ts";
import { API_VERSION, SERVER_VERSION, deployment } from "./deployment.ts";
import { emailSignInAvailable } from "./email.ts";
import { quotaRefusal, storageQuotaBytes, storageUsedBytes } from "./quota.ts";
import {
  SIGNUP_CLOSED, SIGNUP_INVITE_REQUIRED, adminEmail, adminUserId, allowEmail, allowlist, disallowEmail,
  signupMode, signupRefusalMessage,
} from "./signup.ts";

const googleConfigured = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

const app = new Hono();

// What a shared document page is allowed to load.
//
// script-src stays 'unsafe-inline' for one reason: /auth/desktop-bridge hands
// the session back with an inline redirect. Nothing else here runs script, and
// no user content can introduce any — render.ts parses a document's own HTML
// and then sanitizes it, so a <script> in somebody's markdown never survives
// to the page.
//
// img-src has to allow https: because shared documents legitimately embed
// remote images, and a policy that blanks them is a policy someone turns off.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join("; ");

// Defence in depth on the origin itself.
//
// markiedocs.com sits behind Vercel, which sets these, and every share link
// points there. But the Railway origin is publicly reachable and was serving
// the same HTML with no CSP, no HSTS and no frame protection at all. A header
// that exists only on the CDN is not a header the application has.
app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  // Token download routes deliberately use the stricter no-referrer policy.
  if (!h.has("Referrer-Policy")) h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  h.set("Strict-Transport-Security", "max-age=63072000");
  // API answers are per caller, and a sign-in answer carries the session
  // token in its body. A native HTTP stack (the phone's URLSession) keeps any
  // response that does not forbid it in an on-disk cache, so a route that sets
  // no policy of its own gets the strict one. Routes that chose a policy
  // (an asset's private max-age, server-info's public one) keep theirs.
  if (c.req.path.startsWith("/api/") && !h.has("Cache-Control")) h.set("Cache-Control", "private, no-store");
  if ((h.get("content-type") ?? "").includes("text/html")) {
    h.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }
});

// How much of a request body the API will hold in memory.
//
// Neither Hono nor @hono/node-server caps a body, and every JSON route calls
// c.req.json(), which buffers the whole thing before a handler runs. So the
// allocation happened for callers who were about to be refused: a 19 MB link
// body and a missing-check naming 100 000 hashes were both taken in full.
//
// Two routes are not JSON the server chose the shape of, and both keep their
// own bound instead:
//
//   PUT /api/assets/:hash  is the asset itself. It is streamed, counted as it
//   arrives and checked against the per-file cap twice (assets.ts), so
//   buffering it here would refuse the files the feature exists to carry.
//
//   PUT /api/docs/:id      is somebody's document. Nothing on the server caps
//   the text today; the desktop refuses to open a file at or above 100 MB
//   (electron/doc-tiers.js MAX_DOC_BYTES) and will push anything under that,
//   so the JSON limit would refuse documents that sync now. It is bounded
//   just above the size the app itself refuses, which is loose, and a real
//   server-side document cap is the thing that would tighten it.
//
//   POST/PUT /api/agent/docs and POST /mcp  carry a document of up to 2 MB
//   (agent-docs.ts AGENT_DOC_MAX_BYTES) inside JSON, where escaping can make
//   it larger. They get room for that and no more; the document's own size
//   is checked exactly once the body is read. Their agent token is checked
//   before any of this (below), because bodyLimit reads a chunked body with
//   no Content-Length in full before it can refuse it.
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const TEXT_BODY_LIMIT = 100 * 1024 * 1024 + 1024 * 1024;
const AGENT_BODY_LIMIT = 5 * 1024 * 1024;
const bodyTooLarge = (c: Context) => c.json({ error: "body too large" }, 413);
const jsonBodyLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: bodyTooLarge });
const textBodyLimit = bodyLimit({ maxSize: TEXT_BODY_LIMIT, onError: bodyTooLarge });
const agentBodyLimit = bodyLimit({ maxSize: AGENT_BODY_LIMIT, onError: bodyTooLarge });
const ASSET_UPLOAD = /^\/api\/assets\/[^/]+$/;
const DOC_TEXT = /^\/api\/docs\/[^/]+$/;
const AGENT_DOC = /^\/api\/agent\/docs(?:\/[^/]+)?$/;

// Agent routes answer to an agent token and nothing else, so a caller without
// a live one is refused from its headers alone, before the body limit below
// reads a byte of its body (docs/mobile/AGENT-LINKS-CONTRACT.md).
app.use("/api/agent/*", restAgentAuth);
app.use("/mcp", async (c, next) => (c.req.method === "POST" ? mcpAuth(c, next) : next()));

app.use("/api/*", async (c, next) => {
  // Versioned snapshots have their own authenticated streaming body reader.
  // Keep the legacy JSON cap unchanged and avoid buffering Office bytes here.
  if (c.req.path === "/api/document-platform" || c.req.path.startsWith("/api/document-platform/")) return next();
  if (c.req.method !== "POST" && c.req.method !== "PUT") return next();
  if (ASSET_UPLOAD.test(c.req.path)) return next();
  if (DOC_TEXT.test(c.req.path)) return textBodyLimit(c, next);
  if (AGENT_DOC.test(c.req.path)) return agentBodyLimit(c, next);
  return jsonBodyLimit(c, next);
});
app.use("/mcp", async (c, next) => (c.req.method === "POST" ? agentBodyLimit(c, next) : next()));

// Resolved at boot so a misconfigured server (MARKIE_OFFICIAL=2, mail-log mode
// on the official deployment, a self-host with no BETTER_AUTH_URL) stops here
// with the reason, not on the first request that happens to read it.
const DEPLOYMENT = deployment();

// Markie Cloud's browser pages run on one name only, BETTER_AUTH_URL's, so a
// cookie set on the way in is there on the way back (canonical-host.ts).
// 308 keeps the method; no-store because which name is canonical flips
// during the move, and a cached redirect would then point the wrong way.
app.use("*", async (c, next) => {
  const target = canonicalHostRedirect(c.req.raw, DEPLOYMENT);
  if (!target) return next();
  return new Response(null, { status: 308, headers: { location: target, "cache-control": "no-store" } });
});
const EMAIL_SIGN_IN = emailSignInAvailable();
const SIGNUP = signupMode();
adminEmail();
const SERVER_INFO_PATH = "/api/server-info";
const appCors = cors({
  origin: applicationOrigins(),
  credentials: true,
  exposeHeaders: ["set-auth-token"],
});
// Anyone may ask what this server is, from anywhere, without credentials: the
// desktop asks before it has an account here, and a page that wants to show
// "this is a Markie server" needs no session. Nothing in the answer is secret.
const serverInfoCors = cors({ origin: "*", allowMethods: ["GET"], credentials: false });
app.use("*", (c, next) => (c.req.path === SERVER_INFO_PATH ? serverInfoCors(c, next) : appCors(c, next)));

// Health checks and load balancers poll this, so it does no work at all.
// `commit` names the build when the deployment sets KAMAL_VERSION or GIT_SHA;
// without either the answer is exactly what it always was.
const RELEASE_COMMIT = releaseCommit();
app.get("/health", (c) =>
  c.json({ ok: true, service: "markie-api", version: "0.1.0", ...(RELEASE_COMMIT ? { commit: RELEASE_COMMIT } : {}) })
);

// The handshake a desktop app makes before it adds this server. apiVersion is
// what future apps negotiate on; see deployment.ts for when it changes.
app.get(SERVER_INFO_PATH, (c) => {
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    product: "markie-server",
    apiVersion: API_VERSION,
    version: SERVER_VERSION,
    name: DEPLOYMENT.name,
    origin: DEPLOYMENT.origin,
    signIn: { email: EMAIL_SIGN_IN, google: googleConfigured, signup: SIGNUP },
  });
});

const cloudAreas = configureDocsCloudAreas(accountIdentitiesEnabled);
// configureDocsCloudAreas retains the installed better-sqlite3 handle. The
// structural platform type intentionally exposes only its common SQL subset.
const accountDatabase = cloudAreas?.database as Database.Database | undefined;
const accountPlatform = accountDatabase && cloudAreas
  ? createAccountPlatform(accountDatabase, cloudAreas, resolveAuthSecret(process.env)) : undefined;
const quotaDatabase = accountDatabase ?? openDatabase();

// What this account stores against MARKIE_STORAGE_QUOTA_BYTES. quotaBytes is
// null when no quota is configured, which is every server today. Registered
// ahead of the account platform so its sub-app never shadows it.
app.get("/api/account/usage", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  return c.json({ usedBytes: storageUsedBytes(quotaDatabase, session.user.id), quotaBytes: storageQuotaBytes() });
});

// The sign-up allowlist for MARKIE_SIGNUP=invite, managed by this server's
// admin (signup.ts adminUserId). Self-hosted servers only: Markie Cloud has
// no admin account and registers none of these routes.
if (!DEPLOYMENT.official) {
  const requireAdmin = async (c: Context): Promise<Response | { id: string }> => {
    c.header("Cache-Control", "private, no-store");
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    if (session.user.id !== adminUserId(quotaDatabase)) return c.json({ error: "admin_required" }, 403);
    return { id: session.user.id };
  };
  app.get("/api/admin/signup-allowlist", async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    return c.json({ signup: SIGNUP, emails: allowlist(quotaDatabase) });
  });
  app.post("/api/admin/signup-allowlist", async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
    if (typeof body?.email !== "string") return c.json({ error: "invalid_email" }, 400);
    try {
      return c.json({ ok: true, email: allowEmail(quotaDatabase, body.email, admin.id) });
    } catch {
      return c.json({ error: "invalid_email" }, 400);
    }
  });
  app.delete("/api/admin/signup-allowlist/:email", async (c) => {
    const admin = await requireAdmin(c);
    if (admin instanceof Response) return admin;
    return c.json({ ok: true, removed: disallowEmail(quotaDatabase, decodeURIComponent(c.req.param("email"))) });
  });
}

if (accountPlatform) {
  app.route("/api/account", accountPlatform.app);
  if (accountPlatform.google) {
    app.get("/account/link-google", () => accountPlatform.google!.browserPage());
    app.get("/account/google-link/complete", (c) => accountPlatform.google!.complete(c.req.raw));
  }
}
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const denied = await guardAccountAuthRequest(c.req.raw);
  if (denied) return denied;
  const run = () => auth.handler(c.req.raw);
  return accountPlatform?.google ? accountPlatform.google.runAuthRequest(c.req.raw, run) : run();
});

// Desktop Google sign-in must run entirely in the browser, or better-auth's
// OAuth `state` cookie (set when the flow starts) won't be present on the
// callback. The app opens this GET in the browser; we start the social flow
// server-side, forward better-auth's Set-Cookie (the state) to the browser,
// and redirect it to Google's consent screen.
const AUTH_BASE =
  process.env.BETTER_AUTH_URL ?? "http://localhost:8787";
// Who this server is, on the deep link that hands its token to the app.
const AUTH_ISSUER = desktopAuthIssuer(AUTH_BASE);

// Signing in from a browser to read a private /d/<id> page (web-signin.ts).
app.route("/", createWebSignIn({ authBase: AUTH_BASE, google: googleConfigured }));

app.get("/auth/google-start", async (c) => {
  try {
    const state = desktopAuthState(c.req.query("state"));
    const bridge = state
      ? `${AUTH_BASE}/auth/desktop-bridge?state=${encodeURIComponent(state)}`
      : `${AUTH_BASE}/auth/desktop-bridge`;
    const res = await auth.api.signInSocial({
      body: {
        provider: "google",
        callbackURL: bridge,
        errorCallbackURL: bridge,
      },
      asResponse: true,
    });
    const { url } = (await res.clone().json()) as { url?: string };
    if (!url) return c.text("Could not start Google sign-in.", 500);
    const headers = new Headers({ location: url });
    for (const ck of res.headers.getSetCookie()) headers.append("set-cookie", ck);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    console.error("google-start error:", err);
    return c.text("Could not start Google sign-in.", 500);
  }
});

// Desktop OAuth bridge: Google redirects the *browser* here after sign-in
// (the session cookie is now set on this origin). We hand the session token
// back to the desktop app via a markie:// deep link, since the app can't read
// the browser's cookie.
app.get("/auth/desktop-bridge", async (c) => {
  // This page carries a live session token, in the markup and in the link.
  // Without no-store it is an ordinary cacheable document, and a disk cache or
  // any intermediary that keeps it is keeping a credential. doc-view.ts already
  // says this for document pages; the page that hands out the session had not.
  c.header("Cache-Control", "private, no-store");
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  const token = result?.session?.token;
  const page = (heading: string, sub: string, link?: string) =>
    c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>Markie</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0c0c10;color:#fafafa;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:340px">
<div style="font-size:34px;font-weight:700;color:#f59e0b;margin-bottom:8px">M</div>
<h2 style="font-size:17px;margin:0 0 6px">${heading}</h2>
<p style="color:#a1a1aa;font-size:13px;margin:0 0 16px">${sub}</p>
${link ? `<a href="${link}" style="color:#fbbf24;font-size:13px;text-decoration:none">Open Markie →</a>` : ""}
</div>
${link ? `<script>setTimeout(function(){location.href=${JSON.stringify(link)}},400)</script>` : ""}
</body></html>`,
      token ? 200 : 401
    );
  if (!token) {
    // A first Google sign-in this server's MARKIE_SIGNUP refused. better-auth
    // sends the hook's code here as ?error=, so say what happened rather than
    // inviting a retry that will be refused the same way.
    const error = c.req.query("error");
    if (error === SIGNUP_INVITE_REQUIRED || error === SIGNUP_CLOSED) {
      return page(
        error === SIGNUP_CLOSED ? "No new accounts here" : "This server is invite-only",
        signupRefusalMessage(error)
      );
    }
    // With linked sign-ins on, Google is never attached to an existing
    // account just because the addresses match (accountLinking in auth.ts).
    // Retrying cannot work, so say how to get there.
    if (error === "account_not_linked") {
      return page(
        "Google isn't linked to this account yet",
        "This email already has a Markie account. Sign in with an email code, then link Google in Settings, Account, Manage linked sign-ins."
      );
    }
    return page("Sign-in didn't complete", "Head back to Markie and try again.");
  }
  // Carry the app's nonce back so it can verify this deep link is the answer to
  // a sign-in it started, and say which server this token is from, so it is
  // never filed under another one. Without the nonce the app rejects it.
  const state = desktopAuthState(c.req.query("state"));
  return page(
    "You're signed in",
    "Returning you to Markie…",
    desktopAuthDeepLink(token, state, AUTH_ISSUER)
  );
});

app.route("/api/docs", docs);
app.route("/api/document-platform", createDocumentPlatform({
  store: createSqliteDocumentPlatformStore(quotaDatabase, {
    ...(cloudAreas && accountDatabase ? {
      cloudAreas, verifiedUserForEmail: (email: string) => resolveVerifiedUserForEmail(accountDatabase, email),
    } : {}),
    storageQuota: (ownerId, growthBytes) => quotaRefusal(quotaDatabase, ownerId, growthBytes),
  }),
  resolveUser: async (request) => (await auth.api.getSession({ headers: request.headers }))?.user ?? null,
}));
app.route("/api/docs", shares);
app.route("/api/docs", comments);
app.route("/api", themes);
app.route("/api", assetsApi);
app.route("/api", docLinksApi);
app.route("/", docView);
app.route("/", publicShare);
// Remote agents (docs/mobile/AGENT-LINKS-CONTRACT.md): tokens are managed with
// a session; documents and the hosted MCP answer to agent tokens only.
app.route("/api/agent-tokens", agentTokens);
app.route("/api/agent", agentDocsApi);
app.route("/mcp", mcpApi);
// Universal and app links for the mobile app. No auth, no redirect.
app.route("/", createWellKnown());

// Every API route answers in JSON, including its failures. The desktop sync
// client parses the body of a non-2xx response to decide what to tell the user;
// Hono's defaults hand back text/plain, which reads as an unexplained failure.
// The HTML routes (/s/:token, /d/:id, /download*) build their own 403/404
// responses and never reach these.
app.onError((err, c) => {
  console.error(`${c.req.method} ${c.req.path} failed:`, err);
  // A route that threw an HTTPException already decided its own status and
  // body (a 429 from a rate limiter, a 401 from better-auth). Flattening those
  // into a generic 500 loses both the status the client branches on and the
  // sentence it was meant to show.
  if (err instanceof HTTPException) return err.getResponse();
  return c.json(
    {
      error: "internal error",
      // A stack in the response body is a gift to an attacker in production and
      // the only useful thing on screen in development.
      detail:
        process.env.NODE_ENV === "production"
          ? undefined
          : err instanceof Error
            ? err.message
            : String(err),
    },
    500
  );
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.get("/api/me", async (c) => {
  // Answers differ per session and name the signed-in person. Never shared.
  c.header("Cache-Control", "private, no-store");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ user: null });
  return c.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
  });
});

export { app };

// Importing this module in a test must not bind a port or open a websocket
// server; `npm start` leaves the variable unset and listens as usual.
if (process.env.MARKIE_NO_LISTEN !== "1") {
  const port = Number(process.env.PORT ?? 8787);
  const server = serve({ fetch: app.fetch, port });
  attachCollab(server as Parameters<typeof attachCollab>[0]);
  // Uploads a document refused at the link step belong to no document and to
  // no previous link set, so nothing on a request path ever finds them. This
  // is the only thing that does. Scheduled here rather than at assets.ts's
  // module load so importing that module in a test starts no timer, and
  // unref'd so it never keeps the process alive on its own.
  const ORPHAN_SWEEP_MS = 60 * 60 * 1000;
  // A process that is redeployed or recycled more often than the interval
  // would never reach a sweep at all, so one runs shortly after boot too,
  // far enough in to stay clear of the first requests after a deploy.
  const FIRST_SWEEP_MS = 60 * 1000;
  const runSweep = () => {
    sweepOrphans()
      .then((swept) => {
        if (swept > 0) console.log(`swept ${swept} orphaned asset${swept === 1 ? "" : "s"}`);
      })
      .catch((err) => console.error("orphan sweep failed:", err));
  };
  // ENABLE_CRONS=false runs a server that answers requests and runs no jobs.
  // Unset, the sweep runs as it always has.
  const sweeps = cronsEnabled()
    ? [setTimeout(runSweep, FIRST_SWEEP_MS).unref(), setInterval(runSweep, ORPHAN_SWEEP_MS).unref()]
    : [];
  if (sweeps.length === 0) console.log("ENABLE_CRONS is off: the orphaned-asset sweep will not run here");
  // SIGTERM (docker stop, Kamal) or SIGINT (Fly): stop taking requests and
  // sockets, give requests in flight up to 3 s, then close every database
  // handle and exit (graceful-stop.ts).
  installGracefulStop({
    name: "markie-api",
    server,
    stopAccepting: () => {
      for (const timer of sweeps) clearTimeout(timer);
      const sockets = closeAllRooms();
      if (sockets > 0) console.log(`collab: asked ${sockets} socket${sockets === 1 ? "" : "s"} to reconnect later`);
    },
    force: terminateAllRooms,
    release: () => {
      closeAllDatabases();
    },
  });
  console.log(`markie-api listening on :${port}`);
}
