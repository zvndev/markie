import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import "./app/globals.css";
import "./app/print.css";
import { CrashProbe, ErrorBoundary } from "@/components/error-boundary";
import Home from "./app/page";

const DocumentWorkbench = lazy(() => import("./components/document-workbench").then((module) => ({ default: module.DocumentWorkbench })));
const showDocumentWorkbench = import.meta.env.DEV && new URLSearchParams(window.location.search).get("documents") === "1";

// The shell the Next root layout used to own: global styles, the crash probe,
// and the boundary that turns a renderer exception into a page instead of a
// white window. Same tree, mounted by hand now that Vite serves the bundle.
//
// No StrictMode, as before. Its dev-only double effect run makes the boot
// effect ask main for the launch file twice, and the one-shot handler answers
// the second call with nothing, so a dev launch on a file showed the welcome
// document instead.
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary global>
    <CrashProbe />
    {showDocumentWorkbench
      ? <Suspense fallback={<p>Loading document workbench…</p>}><DocumentWorkbench /></Suspense>
      : <Home />}
  </ErrorBoundary>
);
