"use client";
// Per-document version history. Versions come from main's history store; the
// per-row diff counts are computed lazily against the next-older version with
// the existing lineDiff, one read per visible row, cached in state.
//
// Restoring never writes: the chosen version is loaded into the buffer as
// unsaved, so the user commits or discards it deliberately. That is exactly
// what the native snapshot picker did, and it is the one property that makes
// looking through history safe.
import { useEffect, useState } from "react";
import { getElectronAPI, type HistoryEntry } from "@/lib/electron";
import { lineDiff } from "@/lib/line-diff";

const AUTHOR_LABEL: Record<string, string> = {
  user: "You",
  external: "External edit",
  unknown: "Unknown",
};

const INITIAL_ROWS = 30;

export function HistoryDialog({
  filePath,
  fileName,
  onRestore,
  onClose,
}: {
  filePath: string;
  fileName: string;
  onRestore: (content: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [contents, setContents] = useState<Record<string, string | null>>({});
  const [shown, setShown] = useState(INITIAL_ROWS);

  useEffect(() => {
    let alive = true;
    void getElectronAPI()
      ?.historyList?.(filePath)
      .then((list) => {
        if (alive) setEntries(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (alive) setEntries([]);
      });
    return () => {
      alive = false;
    };
  }, [filePath]);

  useEffect(() => {
    if (!entries) return;
    let alive = true;
    void (async () => {
      const api = getElectronAPI();
      for (const e of entries.slice(0, shown)) {
        if (contents[e.stamp] !== undefined) continue;
        const res = await api?.historyRead?.({ path: filePath, stamp: e.stamp });
        if (!alive) return;
        setContents((prev) => ({ ...prev, [e.stamp]: res?.content ?? null }));
      }
    })();
    return () => {
      alive = false;
    };
    // contents is deliberately read, not depended on: each pass fills gaps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, shown, filePath]);

  const diffFor = (i: number): string => {
    if (!entries) return "";
    const mine = contents[entries[i].stamp];
    const older = i + 1 < entries.length ? contents[entries[i + 1].stamp] : "";
    if (mine == null || older == null) return "";
    const d = lineDiff(older, mine);
    if (d.added === 0 && d.removed === 0) return "";
    return `+${d.added}  -${d.removed}`;
  };

  return (
    <div
      className="markie-scrim-strong fixed inset-0 z-[110] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`History: ${fileName}`}
        data-markie-history-dialog
        className="w-[520px] max-h-[70vh] rounded-xl border border-border shadow-2xl flex flex-col"
        style={{ background: "var(--surface-2)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-[13px] text-foreground">History: {fileName}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-foreground"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {entries === null ? (
            <div className="p-4 text-[12px] text-muted">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="p-4 text-[12px] text-muted">
              No versions yet. Markie records one every time this document is saved.
            </div>
          ) : (
            entries.slice(0, shown).map((e, i) => (
              <div
                key={e.stamp}
                className="rounded-md px-2 py-1.5 hover:bg-accent/40 flex items-center gap-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-foreground">
                    {new Date(e.iso).toLocaleString()}
                  </div>
                  <div className="text-[10.5px] text-muted">
                    {AUTHOR_LABEL[e.author] ?? e.author}
                    {diffFor(i) && <span className="ml-2 tabular-nums">{diffFor(i)}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const c = contents[e.stamp];
                    if (typeof c === "string") onRestore(c);
                  }}
                  disabled={typeof contents[e.stamp] !== "string"}
                  className="h-6 px-2 rounded-md border border-border text-[11px] hover:bg-accent/40 shrink-0 disabled:opacity-40"
                >
                  Restore
                </button>
              </div>
            ))
          )}
          {entries && shown < entries.length && (
            <button
              type="button"
              onClick={() => setShown((n) => n + 50)}
              className="w-full py-1.5 text-[11px] text-muted hover:text-foreground"
            >
              Show older
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
