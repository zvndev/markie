import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import "./app/globals.css";
import "./app/print.css";
import { CrashProbe, ErrorBoundary } from "@/components/error-boundary";
import Home from "./app/page";
import { getElectronAPI } from "./lib/electron";
import { registerOfflineApp } from "./lib/offline-app";
import { appRoute } from "./lib/app-route";

const DocumentWorkbench = lazy(() => import("./components/document-workbench").then((module) => ({ default: module.DocumentWorkbench })));
const DocumentWorkspace = lazy(() => import("./components/document-workspace-host").then((module) => ({ default: module.DocumentWorkspaceHost })));
const route = appRoute(window.location.search, !!getElectronAPI(), import.meta.env.DEV);

if (import.meta.env.PROD) {
  void registerOfflineApp().then((status) => window.dispatchEvent(new CustomEvent("markie:offline-status", { detail: status })));
}

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
    {route === "workbench"
      ? <Suspense fallback={<p>Loading document workbench…</p>}><DocumentWorkbench /></Suspense>
      : route === "documents"
        ? <Suspense fallback={<p>Loading documents…</p>}><DocumentWorkspace onExit={() => window.location.assign("?classic=1")} /></Suspense>
        : <Home onOpenDocuments={() => window.location.assign("?workspace=1")} />}
  </ErrorBoundary>
);
