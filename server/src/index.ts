import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth.ts";
import { docs } from "./docs.ts";
import { shares } from "./shares.ts";
import { comments } from "./comments.ts";
import { themes } from "./themes.ts";
import { publicShare } from "./public.ts";
import { attachCollab } from "./collab.ts";

const app = new Hono();

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
    const res = await auth.api.signInSocial({
      body: {
        provider: "google",
        callbackURL: `${AUTH_BASE}/auth/desktop-bridge`,
        errorCallbackURL: `${AUTH_BASE}/auth/desktop-bridge`,
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
  return page(
    "You're signed in",
    "Returning you to Markie…",
    `markie://auth?token=${encodeURIComponent(token)}`
  );
});

app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api/docs", comments);
app.route("/api", themes);
app.route("/", publicShare);

app.get("/api/me", async (c) => {
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

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port });
attachCollab(server as Parameters<typeof attachCollab>[0]);
console.log(`markie-api listening on :${port}`);
