"use client";

// Client seam between the server-rendered root layout and the boundary.
//
// layout.tsx is a server component, so it cannot install the window-level
// handlers or hold the boundary's state itself. This is the smallest possible
// client wrapper that does both, mounted once at the root.

import { useEffect, useState } from "react";
import { ErrorBoundary, installGlobalCrashHandlers } from "@/components/error-boundary";

/**
 * Throws a real render error on demand, so the crash screen can be proved in
 * the real app rather than assumed.
 *
 * A crash screen is the one surface that is never exercised by normal use, so
 * it is the one most likely to be broken when it finally matters — and it
 * cannot be unit-tested here, because the repo has no DOM test environment and
 * adding one is a new dependency. Nothing in the product dispatches this event;
 * it exists for scripts/onboarding-check.mjs and for anyone debugging by hand.
 */
function CrashProbe() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const arm = () => setArmed(true);
    window.addEventListener("markie:crash-probe", arm);
    return () => window.removeEventListener("markie:crash-probe", arm);
  }, []);
  if (armed) throw new Error("Crash probe: deliberately verifying the error boundary");
  return null;
}

export function AppErrorBoundary({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Errors thrown outside render, and promises nobody handled, are invisible
    // to a React boundary. They never blanked the window, which is exactly why
    // they used to vanish without a trace.
    installGlobalCrashHandlers();
  }, []);

  return (
    <ErrorBoundary>
      <CrashProbe />
      {children}
    </ErrorBoundary>
  );
}
