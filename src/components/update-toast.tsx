"use client";

import { useEffect, useState } from "react";
import { getElectronAPI } from "@/lib/electron";

// Listens for auto-update events from the main process and offers an
// "update ready" prompt once a new signed build has downloaded. The prompt is
// sticky: it never auto-dismisses. "Later" only collapses it to a small pill
// in the corner that stays put until the user installs the update.
export function UpdateToast() {
  const [version, setVersion] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.onUpdateReady) return;
    const off = api.onUpdateReady((info) => {
      setVersion(info?.version ?? "");
      setCollapsed(false);
    });
    return () => off?.();
  }, []);

  // Still here means it did not quit. Restarting cannot take this long when it
  // works, and saying nothing leaves the button reading "Restarting…" forever,
  // which is what it did: an error in the main process blocked the quit and the
  // notice sat there with no way forward.
  useEffect(() => {
    if (!installing) return;
    const timer = setTimeout(() => {
      setInstalling(false);
      setFailed(
        "Markie is still running, so the update did not install. Try again, or download the latest version from markiedocs.com."
      );
    }, 20_000);
    return () => clearTimeout(timer);
  }, [installing]);

  if (version === null) return null;

  const install = async () => {
    setInstalling(true);
    setFailed(null);
    // Quits, swaps the .app bundle in place, and relaunches — no duplicate app.
    // A successful call never comes back: the process is gone before it can.
    const result = (await getElectronAPI()?.quitAndInstall()) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (result && result.ok === false) {
      setInstalling(false);
      setFailed(result.error ?? "Markie could not install the update.");
    }
  };

  // Collapsed: a persistent pill that nudges without covering content. It does
  // not go away on its own — only installing the update clears it.
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-[120] flex items-center gap-2 rounded-full border border-border shadow-xl pl-2.5 pr-3.5 py-2 text-[12px] text-foreground hover:opacity-90 transition-opacity"
        style={{ background: "var(--surface-2)" }}
        title="A Markie update is ready to install"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
        Update ready
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[120] w-[300px] rounded-lg border border-border shadow-2xl p-3.5" style={{ background: "var(--surface-2)" }}>
      <div className="text-[13px] text-foreground font-medium mb-0.5">
        Update ready{version ? ` (${version})` : ""}
      </div>
      <div className="text-[12px] text-muted mb-3 leading-snug">
        {failed ?? "A new version of Markie has downloaded. Restart to install it."}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={install}
          disabled={installing}
          className="flex-1 text-[12px] py-1.5 rounded-md bg-accent text-foreground hover:opacity-90 transition-opacity disabled:opacity-60"
        >
          {installing ? "Restarting…" : failed ? "Try again" : "Restart & update"}
        </button>
        <button
          onClick={() => setCollapsed(true)}
          disabled={installing}
          className="text-[12px] py-1.5 px-3 text-muted hover:text-foreground disabled:opacity-60"
        >
          Later
        </button>
      </div>
    </div>
  );
}
