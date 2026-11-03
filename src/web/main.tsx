// The Markie web app's entry (app.html, `npm run build:web`). It runs only in
// a browser, never in Electron, so nothing here touches the desktop's boot in
// src/main.tsx. The page may be served on the docs host; it talks to the API
// origin the server names in it (server/src/web-app.ts).
//
// The same bundle is the read view of a shared document, at /d/<id> and
// /s/<token> (doc-view.tsx). A view never sends the browser anywhere on its
// own: signed out, it shows the sign-in; a public link reads with no account.
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { ErrorBoundary } from "@/components/error-boundary";
import { applyColorMode, getColorMode, watchSystemColorMode } from "@/lib/color-mode";
import { parseViewRoute, parseWebRoute, signInHref } from "./routes";
import { apiOriginFrom, bootWebSession, clearSignInMark, collabBaseFrom, markSignInSent, signInWouldBounce } from "./session";
import { WebRoot } from "./web-root";

applyColorMode(getColorMode());
watchSystemColorMode();

const root = createRoot(document.getElementById("root")!);
const apiOrigin = apiOriginFrom(document, window.location.origin);
const message = (text: string) => root.render(<p role="alert" style={{ padding: 24 }}>{text}</p>);
const view = parseViewRoute(window.location.pathname);

bootWebSession(apiOrigin, collabBaseFrom(document)).then(
  (boot) => {
    if (boot.kind === "signed-in") {
      clearSignInMark(sessionStorage);
      root.render(<ErrorBoundary global><WebRoot user={boot.user} apiOrigin={apiOrigin} /></ErrorBoundary>);
      return;
    }
    // A public link reads with no account, whatever the session answered. A
    // member's view says what it needs itself.
    if (view && (boot.kind === "signed-out" || view.kind === "public")) {
      root.render(<ErrorBoundary global><WebRoot user={null} apiOrigin={apiOrigin} /></ErrorBoundary>);
      return;
    }
    if (boot.kind === "error") {
      message(boot.status === 429
        ? "Markie is busy right now. Wait a minute, then reload."
        : "Can't reach Markie. Check your connection and reload.");
      return;
    }
    // Signed out. Straight back from the sign-in and still signed out means
    // this browser is not sending Markie's sign-in cookie to the API host, so
    // going round again would loop.
    if (signInWouldBounce(sessionStorage)) {
      clearSignInMark(sessionStorage);
      message("You signed in, but this browser didn't keep Markie's sign-in. Allow cookies for markiedocs.com, then reload.");
      return;
    }
    markSignInSent(sessionStorage);
    window.location.replace(signInHref(parseWebRoute(window.location.pathname), apiOrigin));
  },
  () => {
    if (view?.kind === "public") root.render(<ErrorBoundary global><WebRoot user={null} apiOrigin={apiOrigin} /></ErrorBoundary>);
    else message("Can't reach Markie. Check your connection and reload.");
  },
);
