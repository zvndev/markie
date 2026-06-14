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

  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.onUpdateReady) return;
    const off = api.onUpdateReady((info) => {
      setVersion(info?.version ?? "");
      setCollapsed(false);
    });
    return () => off?.();
  }, []);

  if (version === null) return null;

  const install = () => {
    setInstalling(true);
    // Quits, swaps the .app bundle in place, and relaunches — no duplicate app.
    getElectronAPI()?.quitAndInstall();
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
    <div className="fixed bottom-4 right-4 z-[120] w-[300px] rounded-xl border border-border shadow-2xl p-3.5" style={{ background: "var(--surface-2)" }}>
      <div className="text-[13px] text-foreground font-medium mb-0.5">
        Update ready{version ? ` (${version})` : ""}
      </div>
      <div className="text-[12px] text-muted mb-3 leading-snug">
        A new version of Markie has downloaded. Restart to install it.
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={install}
          disabled={installing}
          className="flex-1 text-[12px] py-1.5 rounded-md bg-accent text-foreground hover:opacity-90 transition-opacity disabled:opacity-60"
        >
          {installing ? "Restarting…" : "Restart & update"}
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
