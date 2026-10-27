// Signing in on the web, to read a document at /d/<id> in a browser.
//
// A private link (/d/<id> on this server) opens only for a signed-in member,
// and until now there was no way to sign in from a browser: the access page
// could only say "open your invite email". This adds the smallest web sign-in
// that does the job, on this server's own origin so the session cookie is
// there when the browser comes back to /d/<id>:
//
//   GET /auth/web-signin?next=/d/<id>   the page: Google, or an emailed code
//   GET /auth/web-google?next=/d/<id>   starts Google with the callback on next
//
// The emailed code uses better-auth's primary-email OTP routes, which set the
// session cookie themselves. A linked (non-primary) address is refused there
// on purpose (account-context.ts), so the page says to use the primary
// address or Google.
//
// `next` is only ever a /d/<id> path on this origin. Anything else becomes "/",
// so neither route can be used to bounce a browser somewhere else.
import { Hono } from "hono";
import { auth } from "./auth.ts";
import { reportRouteFault } from "./little-friend.ts";

const NEXT = /^\/d\/[A-Za-z0-9_-]{1,128}$/;

export function safeNext(value: string | null | undefined): string {
  return typeof value === "string" && NEXT.test(value) ? value : "/";
}

export function webSignInHref(authBase: string, docId: string): string | null {
  const next = `/d/${docId}`;
  return NEXT.test(next) ? `${authBase}/auth/web-signin?next=${encodeURIComponent(next)}` : null;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderWebSignInPage({ next, google, failed }: { next: string; google: boolean; failed: boolean }): string {
  const googleHref = `/auth/web-google?next=${encodeURIComponent(next)}`;
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign in · Markie</title>
  <style>
    :root { color-scheme: light dark; --bg:#fbfaf7; --fg:#1c1917; --muted:#6f665d; --line:#e7ded0; --accent:#f59e0b; --field:#fff; }
    @media (prefers-color-scheme: dark) { :root { --bg:#0a0a0c; --fg:#e4e4e7; --muted:#a1a1aa; --line:#27272a; --field:#131316; } }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
      font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
    main { width:100%; max-width:340px; text-align:center; }
    .m { font-size:40px; font-weight:800; color:var(--accent); }
    h1 { font-size:20px; margin:4px 0 6px; }
    p { color:var(--muted); font-size:14px; margin:0 0 18px; }
    a.btn, button { display:block; width:100%; padding:11px 14px; border-radius:10px; font:600 15px system-ui,sans-serif;
      border:1px solid var(--line); background:var(--field); color:var(--fg); text-decoration:none; cursor:pointer; }
    a.btn.primary, button.primary { background:var(--accent); color:#111; border-color:var(--accent); }
    input { width:100%; padding:11px 12px; border-radius:10px; border:1px solid var(--line); background:var(--field); color:var(--fg); font-size:16px; margin-bottom:10px; }
    .or { margin:16px 0; font-size:12px; color:var(--muted); }
    .err { color:#dc2626; font-size:13px; min-height:18px; margin-top:10px; }
    [hidden] { display:none !important; }
  </style>
</head><body>
  <main>
    <div class="m">M</div>
    <h1>Sign in to Markie</h1>
    <p>Use the account this document belongs to.</p>
    ${google ? `<a class="btn primary" href="${esc(googleHref)}">Continue with Google</a><div class="or">or get a code by email</div>` : ""}
    <form id="send">
      <input id="email" type="email" autocomplete="email" placeholder="you@example.com" required aria-label="Email">
      <button type="submit"${google ? "" : ' class="primary"'}>Email me a code</button>
    </form>
    <form id="verify" hidden>
      <p id="sent"></p>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" required aria-label="Code">
      <button type="submit" class="primary">Sign in</button>
    </form>
    <div class="err" id="err" role="alert">${failed ? "Sign-in didn't complete. Try again." : ""}</div>
  </main>
  <script>
    (function () {
      var next = ${JSON.stringify(next)};
      var send = document.getElementById("send"), verify = document.getElementById("verify");
      var err = document.getElementById("err"), email = document.getElementById("email"), code = document.getElementById("code");
      function post(path, body) {
        return fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      send.addEventListener("submit", function (e) {
        e.preventDefault(); err.textContent = "";
        post("/api/auth/email-otp/send-verification-otp", { email: email.value.trim(), type: "sign-in" }).then(function (r) {
          if (!r.ok) { err.textContent = r.status === 429 ? "Too many tries. Wait a minute." : "Couldn't send a code to that address."; return; }
          document.getElementById("sent").textContent = "We sent a code to " + email.value.trim() + ".";
          send.hidden = true; verify.hidden = false; code.focus();
        }, function () { err.textContent = "Couldn't reach Markie."; });
      });
      verify.addEventListener("submit", function (e) {
        e.preventDefault(); err.textContent = "";
        post("/api/auth/sign-in/email-otp", { email: email.value.trim(), otp: code.value.trim() }).then(function (r) {
          if (r.ok) { location.replace(next); return; }
          err.textContent = r.status === 403
            ? ${JSON.stringify(google ? "Use the main email on your account, or sign in with Google." : "Use the main email on your account.")}
            : "That code isn't right, or it expired.";
        }, function () { err.textContent = "Couldn't reach Markie."; });
      });
    })();
  </script>
</body></html>`;
}

export function createWebSignIn({ authBase, google }: { authBase: string; google: boolean }) {
  const app = new Hono();
  app.get("/auth/web-signin", (c) => {
    c.header("Cache-Control", "private, no-store");
    return c.html(renderWebSignInPage({ next: safeNext(c.req.query("next")), google, failed: c.req.query("error") !== undefined }));
  });
  app.get("/auth/web-google", async (c) => {
    if (!google) return c.redirect("/auth/web-signin", 302);
    const next = safeNext(c.req.query("next"));
    try {
      const res = await auth.api.signInSocial({
        body: {
          provider: "google",
          callbackURL: `${authBase}${next}`,
          errorCallbackURL: `${authBase}/auth/web-signin?next=${encodeURIComponent(next)}&error=1`,
        },
        asResponse: true,
      });
      const { url } = (await res.clone().json()) as { url?: string };
      if (!url) return c.text("Could not start Google sign-in.", 500);
      const headers = new Headers({ location: url, "cache-control": "no-store" });
      for (const ck of res.headers.getSetCookie()) headers.append("set-cookie", ck);
      return new Response(null, { status: 302, headers });
    } catch (err) {
      console.error("web-google error:", err);
      reportRouteFault(err, c);
      return c.text("Could not start Google sign-in.", 500);
    }
  });
  return app;
}
