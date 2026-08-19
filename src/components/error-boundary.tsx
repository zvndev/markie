"use client";

// The screen that appears instead of nothing.
//
// A React render error with no boundary unmounts the whole tree, so Markie went
// to a blank window: no message, no way back, nothing written down, and a
// relaunch as the only move. That is the worst version of every failure,
// because it is indistinguishable from the app simply dying.
//
// This catches the error, says so, keeps the report, and offers the two things
// a person actually wants at that moment: get me working again, and let me tell
// someone what happened.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { crashReport, formatCrashDetails, type CrashRecord, type CrashSource } from "@/lib/crash-report";
import { getElectronAPI } from "@/lib/electron";

function env() {
  return {
    version: process.env.NEXT_PUBLIC_MARKIE_VERSION ?? "dev",
    platform: typeof navigator === "undefined" ? "unknown" : navigator.platform,
  };
}

/**
 * Hand a crash to the main process, which owns the log file.
 *
 * Deliberately swallows its own failures: this is the failure path, and a
 * reporter that throws turns a caught error into an uncaught one.
 */
export function reportCrash(error: unknown, source: CrashSource, componentStack?: string): CrashRecord {
  const record = crashReport({ error, source, env: env(), componentStack });
  try {
    getElectronAPI()?.crashReport?.(record);
  } catch {
    // No bridge (browser, or the preload died). The in-app details still show.
  }
  try {
    // Keep it in the devtools console too, where a developer looks first.
    console.error(`[markie:${source}]`, error);
  } catch {
    // console can throw on a closed stdout; never let that escape.
  }
  return record;
}

let installed = false;

/**
 * Catch the failures a React boundary cannot see: errors thrown outside render
 * and promises nobody handled. Neither blanks the window, so both used to fail
 * completely silently.
 */
export function installGlobalCrashHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    reportCrash(e.error ?? e.message, "window-error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportCrash(e.reason, "unhandled-rejection");
  });
}

interface Props {
  children: ReactNode;
}

interface State {
  crashed: boolean;
  record: CrashRecord | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false, record: null, copied: false };

  static getDerivedStateFromError(): Partial<State> {
    // Paint the fallback on the very next render. The report itself is built in
    // componentDidCatch, which is the only place React hands over the component
    // stack — and that stack is usually the whole diagnosis. Splitting them
    // means the user sees the message even if reporting is slow or fails.
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ record: reportCrash(error, "render", info.componentStack ?? undefined) });
  }

  private reload = () => {
    // A render error leaves the tree in an unknown state, so a full reload is
    // the honest recovery rather than pretending we can resume from here.
    window.location.reload();
  };

  private copy = async () => {
    if (!this.state.record) return;
    try {
      await navigator.clipboard.writeText(formatCrashDetails(this.state.record));
      this.setState({ copied: true });
    } catch {
      this.setState({ copied: false });
    }
  };

  render() {
    const { crashed, record } = this.state;
    if (!crashed) return this.props.children;

    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background p-6">
        <div className="markie-overlay-panel w-[520px] max-w-full rounded-xl p-6">
          <h1 className="text-[15px] font-semibold text-foreground">Markie hit an error</h1>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            Something in the app failed to render. Your files on disk are untouched, but
            anything unsaved in the editor was lost when the view stopped.
          </p>

          {record && (
            <pre className="mt-4 max-h-40 overflow-auto rounded-md border border-border bg-surface p-3 text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
              {record.message}
            </pre>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button
              onClick={this.reload}
              className="markie-overlay-button rounded-md bg-accent px-3 py-1.5 text-[12.5px] text-foreground hover:opacity-90"
            >
              Reload Markie
            </button>
            <button
              onClick={this.copy}
              className="markie-overlay-button rounded-md border border-border px-3 py-1.5 text-[12.5px] text-foreground/90 hover:bg-accent/40"
            >
              {this.state.copied ? "Copied" : "Copy details"}
            </button>
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-muted">
            This crash was saved to Markie&apos;s local crash log. Nothing was sent anywhere.
          </p>
        </div>
      </div>
    );
  }
}
