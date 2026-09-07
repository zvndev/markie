import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/globals.css";
import "./app/print.css";
import { CrashProbe, ErrorBoundary } from "@/components/error-boundary";
import Home from "./app/page";

// The shell the Next root layout used to own: global styles, the crash probe,
// and the boundary that turns a renderer exception into a page instead of a
// white window. Same tree, mounted by hand now that Vite serves the bundle.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary global>
      <CrashProbe />
      <Home />
    </ErrorBoundary>
  </StrictMode>
);
