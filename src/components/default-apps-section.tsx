import { useCallback, useEffect, useState } from "react";
import { getElectronAPI, type DefaultAppsStatus } from "@/lib/electron";
import { DocumentFormatMark } from "./document-format-mark";

/** Fired after Markie changes a Finder association, so other surfaces re-ask. */
export const DEFAULT_APPS_CHANGED = "markie:default-apps-changed";

// Settings > Files: which file types a double-click in Finder opens in Markie.
// Only formats Markie edits completely are offered; the rest are listed with
// the reason they are not offered yet, so their absence is not a mystery.
export function DefaultAppsSection() {
  const api = getElectronAPI();
  const [status, setStatus] = useState<DefaultAppsStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!api?.defaultAppsStatus) return;
    try { setStatus(await api.defaultAppsStatus()); }
    catch { setStatus({ supported: false, formats: [], pending: [], error: "Couldn't read the default apps." }); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  if (!api?.defaultAppsStatus) {
    return <p className="text-[12px] text-muted">Default apps can be chosen in the Markie desktop app on macOS.</p>;
  }
  if (!status) return <p className="text-[12px] text-muted">Checking which apps open your files…</p>;

  const remaining = status.formats.filter((format) => !format.isDefault);

  const claim = async (ids: string[], key: string) => {
    if (!api.setDefaultApps || !ids.length) return;
    setBusy(key);
    setMessage(null);
    const res = await api.setDefaultApps(ids);
    setBusy(null);
    if (res.ok) {
      const names = status.formats.filter((format) => ids.includes(format.id)).map((format) => format.label);
      setMessage({ tone: "ok", text: `${names.length > 2 ? "These files" : names.join(" and ")} now open in Markie.` });
    } else {
      setMessage({ tone: "error", text: res.error ?? "Couldn't change the default app." });
    }
    await load();
    window.dispatchEvent(new Event(DEFAULT_APPS_CHANGED));
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="markie-overlay-section mb-1">Open with Markie</div>
          <p className="max-w-[46ch] text-[11.5px] leading-relaxed text-muted">
            Choose the file types a double-click in Finder opens here. You can change any of these back in Finder&rsquo;s Get Info.
          </p>
        </div>
        {status.supported && remaining.length > 1 && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => claim(remaining.map((format) => format.id), "all")}
            className="markie-overlay-button shrink-0 rounded-md border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-accent/40 disabled:opacity-50"
          >
            {busy === "all" ? "Setting…" : "Use Markie for all"}
          </button>
        )}
      </div>

      {!status.supported && status.error && (
        <p className="mt-3 rounded-md border border-border/70 px-3 py-2 text-[11.5px] text-muted">{status.error}</p>
      )}

      <ul className="mt-3 divide-y divide-border/60 rounded-lg border border-border/70" aria-label="File types Markie can open by default">
        {status.formats.map((format) => (
          <li key={format.id} className="flex items-center gap-3 px-3 py-2">
            <DocumentFormatMark format={format.id} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] text-foreground">{format.label}</span>
              <span className="block truncate font-mono text-[10.5px] text-muted">{format.extensions.join("  ")}</span>
            </span>
            {format.isDefault ? (
              <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--status-green)]">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                Markie
              </span>
            ) : (
              <button
                type="button"
                disabled={!status.supported || !!busy}
                onClick={() => claim([format.id], format.id)}
                aria-label={`Open ${format.label} files in Markie`}
                className="markie-overlay-button rounded-md border border-border px-2.5 py-1 text-[11.5px] text-muted hover:text-foreground hover:bg-accent/40 disabled:opacity-50"
              >
                {busy === format.id ? "Setting…" : "Use Markie"}
              </button>
            )}
          </li>
        ))}
      </ul>

      {message && (
        <p className={`mt-2 text-[11.5px] ${message.tone === "ok" ? "text-muted" : "text-[var(--status-red)]"}`} role="status">{message.text}</p>
      )}

      {status.pending.length > 0 && (
        <div className="mt-5">
          <div className="markie-overlay-section mb-2">Not offered yet</div>
          <ul className="space-y-1.5">
            {status.pending.map((format) => (
              <li key={format.id} className="flex items-center gap-3 opacity-70">
                <DocumentFormatMark format={format.id} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-foreground">{format.label} <span className="font-mono text-[10.5px] text-muted">{format.extensions.join(" ")}</span></span>
                  <span className="block text-[11px] text-muted">{format.reason} Markie still opens them from Open… or Open With.</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
