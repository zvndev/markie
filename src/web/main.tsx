// The Markie web app's entry (app.html, `npm run build:web`). It runs only in
// a browser on the server's own origin, never in Electron, so nothing here
// touches the desktop's boot in src/main.tsx.
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { ErrorBoundary } from "@/components/error-boundary";
import { applyColorMode, getColorMode, watchSystemColorMode } from "@/lib/color-mode";
import { parseWebRoute, signInHref } from "./routes";
import { bootWebSession, collabBaseFrom } from "./session";
import { WebApp } from "./web-app";

applyColorMode(getColorMode());
watchSystemColorMode();

const root = createRoot(document.getElementById("root")!);
bootWebSession(window.location.origin, collabBaseFrom(document)).then(
  (user) => {
    if (!user) {
      window.location.replace(signInHref(parseWebRoute(window.location.pathname)));
      return;
    }
    root.render(<ErrorBoundary global><WebApp user={user} /></ErrorBoundary>);
  },
  () => {
    root.render(<p role="alert" style={{ padding: 24 }}>Can&apos;t reach Markie. Check your connection and reload.</p>);
  },
);
