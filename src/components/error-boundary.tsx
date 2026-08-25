"use client";

import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";

// React 19 still has no hook equivalent of getDerivedStateFromError /
// componentDidCatch, so the top-level boundary has to be a class.
//
// Without it, a throw anywhere in the tree — a bad markdown render, a null
// deref in a panel — unmounts everything and leaves an empty window with no way
// back except quitting the app. This keeps the window usable: it shows what
// broke, lets the user copy the details for a bug report, and reloads on
// demand.

interface Props {
  children: ReactNode;
  // A boundary around one pane wants a pane-sized fallback, not the full-window
  // one. `reset` clears the caught error and re-renders the children.
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Install the window error/rejection listeners. Exactly one boundary, the root one, passes this. */
  global?: boolean;
}

interface State {
  error: Error | null;
  info: string | null;
  copied?: boolean;
}

// The shape main logs: { message, stack?, componentStack?, source? }.
function reportToMain(source: string, error: unknown, componentStack?: string) {
  const api = (
    window as unknown as {
      electronAPI?: { logRendererError?: (payload: unknown) => void };
    }
  ).electronAPI;
  try {
    api?.logRendererError?.({
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack,
      source,
    });
  } catch {
    // logging must never be the thing that breaks the app
  }
}

/**
 * Throws a real render error on demand, so the crash screen can be proved in
 * the real app rather than assumed. Nothing in the product dispatches this
 * event; it exists for scripts/crash-check.mjs and for debugging by hand.
 */
export function CrashProbe() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const arm = () => setArmed(true);
    window.addEventListener("markie:crash-probe", arm);
    return () => window.removeEventListener("markie:crash-probe", arm);
  }, []);
  if (armed) throw new Error("Crash probe: deliberately verifying the error boundary");
  return null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Markie renderer crashed", error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
    reportToMain("react", error, info.componentStack ?? undefined);
  }

  // Only the root boundary owns the window-level listeners. The app also
  // mounts a boundary around the rich pane (a pane-local fallback); if every
  // instance installed them, each stray error would be logged, and with
  // consent on, uploaded, once per boundary. That is exactly what the first
  // real-window crash check showed: every window error recorded twice.
  componentDidMount() {
    if (!this.props.global) return;
    window.addEventListener("error", this.onWindowError);
    window.addEventListener("unhandledrejection", this.onRejection);
  }

  componentWillUnmount() {
    if (!this.props.global) return;
    window.removeEventListener("error", this.onWindowError);
    window.removeEventListener("unhandledrejection", this.onRejection);
  }

  // Errors outside React's render path (event handlers, timers, un-awaited
  // promises like the export IPC calls) never reach componentDidCatch. They
  // used to vanish silently in a packaged build; at minimum they land in the
  // console and, when the bridge offers it, in the main-process log.
  onWindowError = (event: ErrorEvent) => {
    console.error("Uncaught error", event.error ?? event.message);
    reportToMain("window", event.error ?? event.message);
  };

  onRejection = (event: PromiseRejectionEvent) => {
    console.error("Unhandled promise rejection", event.reason);
    reportToMain("unhandledrejection", event.reason);
  };

  details(): string {
    const { error, info } = this.state;
    return [
      error?.stack || error?.message || String(error),
      info ? `\nComponent stack:${info}` : "",
    ].join("");
  }

  copyDetails = () => {
    void navigator.clipboard?.writeText(this.details());
    // Feedback, or the click looks like it did nothing — on a screen whose
    // whole point is that something already looks broken.
    this.setState({ copied: true });
    setTimeout(() => this.setState({ copied: false }), 2000);
  };

  reload = () => {
    window.location.reload();
  };

  reset = () => {
    this.setState({ error: null, info: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        className="h-screen w-screen overflow-auto bg-background text-foreground flex items-center justify-center p-8"
      >
        <div className="w-full max-w-[680px] flex flex-col gap-4">
          <h1 className="text-[17px] font-semibold">Markie hit an error</h1>
          <p className="text-[13px] text-muted">
            Your file on disk is untouched, but changes you hadn&apos;t saved may
            be lost.
          </p>
          {/* A stack trace is the first thing on screen only if you asked for
              it. Collapsed, the two buttons are what the page is about. */}
          <details>
            <summary className="text-[13px] text-muted cursor-pointer select-none">
              Show details
            </summary>
            <pre className="mt-2 max-h-[280px] overflow-auto rounded-lg border border-border bg-surface p-3 text-[12px] leading-relaxed whitespace-pre-wrap font-mono">
              {this.details()}
            </pre>
          </details>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={this.reload}
              className="h-8 px-3 rounded-md border border-border bg-surface hover:bg-surface-2 text-[13px]"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.copyDetails}
              className="h-8 px-3 rounded-md border border-border text-muted hover:text-foreground text-[13px]"
            >
              {this.state.copied ? "Copied" : "Copy details"}
            </button>
          </div>
          <p className="text-[12px] text-muted">
            This crash was saved to Markie&apos;s local crash log (Help → Reveal
            Crash Log).
          </p>
        </div>
      </div>
    );
  }
}
