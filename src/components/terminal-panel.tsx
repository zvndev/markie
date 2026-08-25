"use client";

import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { getElectronAPI, type TerminalContext } from "@/lib/electron";

interface TerminalPanelProps {
  context: TerminalContext;
  onClose: () => void;
}

interface Tab {
  id: string;
}

const TERM_GENERIC = "Markie couldn't open a terminal.";

// term-create answers with a session id, or with a refusal object explaining
// why there isn't one ({ error, message }), or null when the IPC call threw.
// An object is truthy, so treating the answer as an id put a refusal where a
// session id belongs and left a tab wired to nothing.
function readTermCreate(res: unknown): { id: string | null; message: string | null } {
  if (typeof res === "string" && res) return { id: res, message: null };
  const refusal = res as { error?: string; message?: string } | null | undefined;
  if (refusal?.error) return { id: null, message: refusal.message ?? TERM_GENERIC };
  return { id: null, message: TERM_GENERIC };
}

export function TerminalPanel({ context, onClose }: TerminalPanelProps) {
  const api = getElectronAPI();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [externalApps, setExternalApps] = useState<Array<{ id: string; name: string }>>([]);
  const [showExternal, setShowExternal] = useState(false);
  // Why the last "+" produced no terminal. Shown in the panel: the alternative
  // is a button that visibly does nothing.
  const [createError, setCreateError] = useState<string | null>(null);
  const creating = useRef(false);
  const latestContext = useRef(context);

  useEffect(() => {
    latestContext.current = context;
  }, [context]);

  const unmounted = useRef(false);

  const newTab = useCallback(async () => {
    if (!api?.termCreate || creating.current) return;
    creating.current = true;
    let res: unknown = null;
    try {
      res = await api.termCreate(latestContext.current);
    } finally {
      creating.current = false;
    }
    const { id, message } = readTermCreate(res);
    if (!id) {
      setCreateError(message);
      return;
    }
    if (unmounted.current) {
      api.termKill?.(id);
      return;
    }
    setCreateError(null);
    setTabs((prev) => [...prev, { id }]);
    setActiveId(id);
  }, [api]);

  // Every live tab id, readable from the unmount cleanup without making the
  // effect depend on `tabs` (which would tear the shells down on every change).
  const liveIds = useRef<string[]>([]);
  useEffect(() => {
    liveIds.current = tabs.map((t) => t.id);
  }, [tabs]);

  // first tab on mount + load external apps
  useEffect(() => {
    let alive = true;
    // StrictMode (and any remount) runs the cleanup before this effect runs
    // again, so a latched `unmounted` made the second mount kill every shell it
    // created the moment it created them.
    unmounted.current = false;
    (async () => {
      if (!api?.termCreate) return;
      const { id, message } = readTermCreate(await api.termCreate(context));
      if (!id) {
        if (alive) setCreateError(message);
        return;
      }
      // Closing the panel while the shell was still starting left a real login
      // shell running with nothing attached to it — one orphan per open/close.
      if (!alive) {
        api.termKill?.(id);
        return;
      }
      setTabs([{ id }]);
      setActiveId(id);
      const apps = await api.termExternalApps?.();
      if (alive && Array.isArray(apps)) setExternalApps(apps);
    })();
    return () => {
      alive = false;
      unmounted.current = true;
      // Closing the panel closes its shells. They are the user's processes, but
      // there is no way left to reach them once the panel is gone.
      for (const id of liveIds.current) api?.termKill?.(id);
      liveIds.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a session that exits on its own (typed `exit`) closes its tab
  useEffect(() => {
    const off = api?.onTermExit?.(({ id }) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        setActiveId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur));
        return next;
      });
    });
    return () => off?.();
  }, [api]);

  const closeTab = (id: string) => {
    api?.termKill?.(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur));
      return next;
    });
  };

  return (
    <div className="h-[260px] shrink-0 border-t border-border bg-background flex flex-col">
      <div className="flex items-center h-8 px-1.5 gap-1 border-b border-border shrink-0">
        <div className="flex items-center gap-0.5 flex-1 overflow-x-auto">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`group flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md whitespace-nowrap ${
                activeId === t.id ? "bg-accent text-foreground" : "text-muted hover:text-foreground hover:bg-accent/40"
              }`}
            >
              Shell {i + 1}
              <span
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                className="opacity-0 group-hover:opacity-100 hover:text-red-400"
              >
                ×
              </span>
            </button>
          ))}
          <button onClick={newTab} title="New terminal" className="text-muted hover:text-foreground px-1.5 text-[14px]">＋</button>
        </div>
        {externalApps.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setShowExternal((v) => !v)}
              className="text-[11px] text-muted hover:text-foreground px-2 py-1 rounded-md hover:bg-accent/40"
            >
              Open in ▾
            </button>
            {showExternal && (
              <div className="absolute right-0 top-7 z-20 w-40 rounded-lg border border-border shadow-xl py-1" style={{ background: "var(--surface-2)" }}>
                {externalApps.map((app) => (
                  <button
                    key={app.id}
                    onClick={() => { setShowExternal(false); api?.termOpenExternal?.(app.name, context.cwd); }}
                    className="w-full text-left text-[12px] px-3 py-1 text-muted hover:text-foreground hover:bg-accent/40"
                  >
                    {app.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button onClick={onClose} title="Hide terminal (⌃`)" aria-label="Hide terminal" className="text-muted hover:text-foreground px-1.5 text-[15px]">×</button>
      </div>

      {createError && (
        <div
          role="status"
          className="shrink-0 flex items-center gap-2 px-3 py-1 border-b border-border text-[11px] text-[color:var(--status-red)]"
        >
          <span className="min-w-0">{createError}</span>
          <button
            type="button"
            onClick={() => setCreateError(null)}
            aria-label="Dismiss"
            className="ml-auto shrink-0 text-muted hover:text-foreground text-[12px] leading-none"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex-1 relative overflow-hidden">
        {tabs.map((t) => (
          <TermTab key={t.id} sessionId={t.id} active={activeId === t.id} />
        ))}
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-muted">
            {api?.termCreate ? "No terminal — press +" : "Terminal needs the desktop app."}
          </div>
        )}
      </div>
    </div>
  );
}

function TermTab({ sessionId, active }: { sessionId: string; active: boolean }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  // imperative handles to the xterm instance + fit addon for this session
  const termRef = useRef<{ fit: () => void; resize: () => void } | null>(null);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api || !elRef.current) return;
    let disposed = false;
    let offData: (() => void) | undefined;
    let cleanup: (() => void) | undefined;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !elRef.current) return;
      const term = new Terminal({
        fontSize: 12,
        fontFamily:
          "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
        cursorBlink: true,
        theme: {
          background: "#0a0a0c",
          foreground: "#e4e4e7",
          cursor: "#fbbf24",
          selectionBackground: "#3f3f46",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(elRef.current);
      try {
        fit.fit();
      } catch {
        // element not measured yet
      }
      api.termResize(sessionId, term.cols, term.rows);

      offData = api.onTermData?.(({ id, data }) => {
        if (id === sessionId) term.write(data);
      });
      const onInput = term.onData((data) => api.termWrite(sessionId, data));

      const doFit = () => {
        try {
          fit.fit();
          api.termResize(sessionId, term.cols, term.rows);
        } catch {
          // not visible / unmeasured
        }
      };
      termRef.current = { fit: doFit, resize: doFit };

      const ro = new ResizeObserver(() => doFit());
      ro.observe(elRef.current);
      window.addEventListener("resize", doFit);

      cleanup = () => {
        ro.disconnect();
        window.removeEventListener("resize", doFit);
        onInput.dispose();
        term.dispose();
        termRef.current = null;
      };
      // focus the freshly created terminal
      term.focus();
    })();

    return () => {
      disposed = true;
      offData?.();
      cleanup?.();
    };
  }, [sessionId]);

  // refit + focus when this tab becomes active
  useEffect(() => {
    if (active) {
      const t = setTimeout(() => termRef.current?.fit(), 0);
      return () => clearTimeout(t);
    }
  }, [active]);

  return (
    <div
      ref={elRef}
      className="absolute inset-0 p-1.5"
      style={{ display: active ? "block" : "none" }}
    />
  );
}
