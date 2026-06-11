"use client";

import { useCallback, useEffect, useState } from "react";
import { getElectronAPI, type LibraryItem } from "@/lib/electron";

interface LibraryProps {
  onClose: () => void;
  onOpenPath: (path: string) => void;
}

const BADGE: Record<LibraryItem["state"], [string, string]> = {
  "local-only": ["Local", "text-muted border-border"],
  synced: ["Synced", "text-green-400 border-green-400/40"],
  paused: ["Paused", "text-yellow-400 border-yellow-400/40"],
  conflict: ["Conflict", "text-red-400 border-red-400/40"],
  behind: ["Update available", "text-blue-400 border-blue-400/40"],
  "cloud-only": ["Cloud", "text-blue-400 border-blue-400/40"],
};

export function Library({ onClose, onOpenPath }: LibraryProps) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmOff, setConfirmOff] = useState<string | null>(null); // path pending keep/delete
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const api = getElectronAPI();
    if (!api?.libraryState) return;
    api.libraryState().then((s) => {
      setItems(s.items);
      setSignedIn(s.signedIn);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    refresh();
  };

  const syncOn = (item: LibraryItem) =>
    act(async () => {
      const api = getElectronAPI()!;
      const file = await api.openFilePath(item.path!);
      if (!file) {
        setNotice(`Can't read ${item.name}`);
        return;
      }
      const res = await api.docSyncOn({
        path: item.path!,
        name: item.name,
        content: file.content,
      });
      if (res.error) setNotice(res.error);
    });

  const row = (item: LibraryItem) => {
    const [label, badgeClass] = BADGE[item.state];
    const api = getElectronAPI()!;
    return (
      <div
        key={item.path ?? item.cloudId}
        className="flex items-center justify-between px-3 py-2 border-b border-border/50 gap-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-foreground truncate">{item.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badgeClass}`}>
              {label}
            </span>
            {item.path && !item.exists && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border text-red-400 border-red-400/40">
                Missing on disk
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted truncate">
            {item.path ?? "Only in your cloud"}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[11px]">
          {item.path && item.exists && (
            <button
              className="text-muted hover:text-foreground"
              onClick={() => {
                onOpenPath(item.path!);
                onClose();
              }}
            >
              Open
            </button>
          )}
          {signedIn && item.state === "local-only" && item.exists && (
            <button className="text-muted hover:text-foreground" onClick={() => syncOn(item)}>
              Sync
            </button>
          )}
          {signedIn && item.state === "paused" && item.exists && (
            <button className="text-muted hover:text-foreground" onClick={() => syncOn(item)}>
              Resume
            </button>
          )}
          {signedIn && item.state === "synced" && (
            <button
              className="text-muted hover:text-foreground"
              onClick={() => setConfirmOff(item.path)}
            >
              Stop syncing
            </button>
          )}
          {signedIn && item.state === "behind" && (
            <button
              className="text-blue-400 hover:text-blue-300"
              onClick={() =>
                act(() => api.docResolve({ path: item.path!, strategy: "cloud" }))
              }
            >
              Pull latest
            </button>
          )}
          {signedIn && item.state === "conflict" && (
            <>
              <button
                className="text-muted hover:text-foreground"
                onClick={() =>
                  act(() => api.docResolve({ path: item.path!, strategy: "local" }))
                }
              >
                Keep local
              </button>
              <button
                className="text-muted hover:text-foreground"
                onClick={() =>
                  act(() => api.docResolve({ path: item.path!, strategy: "cloud" }))
                }
              >
                Take cloud
              </button>
            </>
          )}
          {signedIn && item.state === "cloud-only" && (
            <button
              className="text-blue-400 hover:text-blue-300"
              onClick={() =>
                act(() =>
                  api.docPull({ cloudId: item.cloudId!, suggestedName: item.name })
                )
              }
            >
              Download…
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[620px] max-w-[94vw] max-h-[80vh] flex flex-col rounded-xl border border-border shadow-2xl"
        style={{ background: "var(--surface-2)" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-[14px] font-semibold text-foreground">Library</h2>
          <div className="flex items-center gap-3">
            {!signedIn && (
              <span className="text-[11px] text-muted">
                Sign in (⌘,) to sync documents
              </span>
            )}
            <button onClick={onClose} aria-label="Close library" className="text-muted hover:text-foreground">
              ×
            </button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="px-4 py-6 text-[12px] text-muted">Loading…</div>
          ) : items.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-muted">
              Files you open in Markie will show up here.
            </div>
          ) : (
            items.map(row)
          )}
        </div>
        {notice && (
          <div className="px-4 py-2 text-[11px] text-red-400 border-t border-border">
            {notice}
          </div>
        )}
      </div>

      {confirmOff && (
        <div className="absolute inset-0 z-[110] flex items-center justify-center bg-black/50">
          <div
            className="w-[380px] rounded-xl border border-border shadow-2xl p-4"
            style={{ background: "var(--surface-2)" }}
          >
            <div className="text-[13px] text-foreground mb-1">Stop syncing this document?</div>
            <div className="text-[12px] text-muted mb-4">
              A copy currently exists in your cloud. You can keep it there
              (syncing just pauses) or delete it.
            </div>
            <div className="flex flex-col gap-2">
              <button
                className="w-full text-[12px] py-2 rounded-md bg-accent text-foreground"
                onClick={() =>
                  act(async () => {
                    await getElectronAPI()!.docSyncOff({ path: confirmOff, deleteRemote: false });
                    setConfirmOff(null);
                  })
                }
              >
                Keep cloud copy, pause syncing
              </button>
              <button
                className="w-full text-[12px] py-2 rounded-md border border-red-400/40 text-red-400 hover:bg-red-400/10"
                onClick={() =>
                  act(async () => {
                    await getElectronAPI()!.docSyncOff({ path: confirmOff, deleteRemote: true });
                    setConfirmOff(null);
                  })
                }
              >
                Delete the cloud copy
              </button>
              <button
                className="w-full text-[12px] py-1.5 text-muted hover:text-foreground"
                onClick={() => setConfirmOff(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
