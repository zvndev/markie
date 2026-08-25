import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { auth } from "./auth.ts";
import { docs } from "./docs.ts";
import { shares } from "./shares.ts";
import { comments } from "./comments.ts";
import { themes } from "./themes.ts";
import { publicShare } from "./public.ts";
import { docView } from "./doc-view.ts";
import { attachCollab } from "./collab.ts";
import { desktopAuthDeepLink, desktopAuthState } from "./desktop-auth.ts";

const app = new Hono();

// What a shared document page is allowed to load.
//
// script-src stays 'unsafe-inline' for one reason: /auth/desktop-bridge hands
// the session back with an inline redirect. Nothing else here runs script, and
// no user content can introduce any — render.ts sanitizes without rehype-raw,
// so a <script> in somebody's markdown never survives to the page.
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
// markie.zvndev.com sits behind Vercel, which sets these, and every share link
// points there. But the Railway origin is publicly reachable and was serving
// the same HTML with no CSP, no HSTS and no frame protection at all. A header
// that exists only on the CDN is not a header the application has.
app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  h.set("Strict-Transport-Security", "max-age=63072000");
  if ((h.get("content-type") ?? "").includes("text/html")) {
    h.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }
});

app.use(
  "*",
  cors({
    origin: ["app://markie", "http://localhost:3000"],
    credentials: true,
    exposeHeaders: ["set-auth-token"],
  })
);

app.get("/health", (c) =>
  c.json({ ok: true, service: "markie-api", version: "0.1.0" })
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Desktop Google sign-in must run entirely in the browser, or better-auth's
// OAuth `state` cookie (set when the flow starts) won't be present on the
// callback. The app opens this GET in the browser; we start the social flow
// server-side, forward better-auth's Set-Cookie (the state) to the browser,
// and redirect it to Google's consent screen.
const AUTH_BASE =
  process.env.BETTER_AUTH_URL ?? "http://localhost:8787";

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
    return page("Sign-in didn't complete", "Head back to Markie and try again.");
  }
  // Carry the app's nonce back so it can verify this deep link is the answer to
  // a sign-in it started. Without it the app rejects the token.
  const state = desktopAuthState(c.req.query("state"));
  return page(
    "You're signed in",
    "Returning you to Markie…",
    desktopAuthDeepLink(token, state)
  );
});

app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api/docs", comments);
app.route("/api", themes);
app.route("/", docView);
app.route("/", publicShare);

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
  console.log(`markie-api listening on :${port}`);
}
