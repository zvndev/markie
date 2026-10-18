import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccountIdentitiesClient, accountScopeKey, subscribeAccountScope, type CloudAreas } from "@/lib/account-identities";

interface Props { label: string; value: string; onChange: (areaId: string) => void; onLoaded?: (data: CloudAreas | null) => void; defaultLabel?: string; disabled?: boolean }
const BUTTON = "markie-overlay-button rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-accent/40 hover:text-foreground disabled:opacity-40";
const AreaScope = createContext<{ areaId: string; areas: CloudAreas | null } | null>(null);
export const useCloudAreaScope = () => useContext(AreaScope);
export function CloudAreaProvider({ children }: { children: ReactNode }) {
  const [areaId, setAreaId] = useState(""), [areas, setAreas] = useState<CloudAreas | null>(null);
  return <AreaScope.Provider value={{ areaId, areas }}><div className="px-3 py-1"><CloudAreaPicker label="Cloud area" value={areaId} onChange={setAreaId} onLoaded={setAreas} /></div>{children}</AreaScope.Provider>;
}
/** Area discovery is deliberate metadata-only work; never opens a document or changes ACLs. */
export function CloudAreaPicker(props: Props) {
  const [activated, setActivated] = useState(false);
  return activated ? <ActivePicker {...props} /> : <button type="button" className={BUTTON} disabled={props.disabled} aria-label={`${props.label}: ${props.defaultLabel ?? "All areas"}`} onClick={() => setActivated(true)}>{props.label}: {props.defaultLabel ?? "All areas"} ▾</button>;
}
function ActivePicker({ label, value, onChange, onLoaded, defaultLabel = "All areas", disabled }: Props) {
  const scope = useSyncExternalStore(subscribeAccountScope, accountScopeKey, () => ""), controlsId = useId();
  const [data, setData] = useState<{ scope: string; result: CloudAreas } | null>(null);
  const [open, setOpen] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [name, setName] = useState("");
  const callbacks = useRef({ onChange, onLoaded }); callbacks.current = { onChange, onLoaded };
  const active = useRef<AbortController | null>(null), current = useRef(scope); current.current = scope;
  const visible = data?.scope === scope ? data.result : null;
  useEffect(() => {
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    callbacks.current.onChange(""); callbacks.current.onLoaded?.(null); setError(null); setName("");
    if (!scope) { setBusy(false); return () => controller.abort(); }
    setBusy(true);
    void new AccountIdentitiesClient().areas(controller.signal).then((result) => { if (!controller.signal.aborted && current.current === scope) { setData({ scope, result }); callbacks.current.onLoaded?.(result); } }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Cloud areas could not be loaded."); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [scope]);
  const select = (next: string) => { onChange(next); setOpen(false); };
  return <div className="min-w-0 space-y-1">
    <button type="button" className={BUTTON} disabled={disabled || busy} aria-expanded={open} aria-controls={controlsId} aria-label={`${label}: ${visible?.areas.find((area) => area.id === value)?.label ?? defaultLabel}`} onClick={() => setOpen(!open)}>{label}: {visible?.areas.find((area) => area.id === value)?.label ?? defaultLabel} ▾</button>
    {open ? <div id={controlsId} role="group" aria-label={label} className="space-y-2 rounded-md border border-border bg-surface p-2 text-[11px]" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      <p className="text-muted">Cloud areas organize this account. They are not separate accounts or access permissions.</p>
      <div className="flex flex-wrap gap-1"><button type="button" className={BUTTON} aria-pressed={!value} onClick={() => select("")}>{defaultLabel}</button>{visible?.areas.map((area) => <button key={area.id} className={BUTTON} type="button" aria-pressed={value === area.id} disabled={disabled || busy} onClick={() => select(area.id)}>{area.label}</button>)}</div>
      {visible ? <form className="flex flex-wrap gap-1" onSubmit={(event) => { event.preventDefault(); const bound = scope, controller = new AbortController(); active.current?.abort(); active.current = controller; setBusy(true); setError(null); void (async () => { try { const client = new AccountIdentitiesClient(), area = await client.createArea(name, controller.signal), result = await client.areas(controller.signal); if (controller.signal.aborted || current.current !== bound) return; setData({ scope: bound, result }); onLoaded?.(result); onChange(area.id); setName(""); setOpen(false); } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Cloud area could not be created."); } finally { if (!controller.signal.aborted) setBusy(false); } })(); }}><input className="markie-overlay-field min-w-0 flex-1 px-2 py-1" aria-label="New cloud area label" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /><button className={BUTTON} disabled={disabled || busy || !name.trim()}>Create area</button></form> : null}
      {busy ? <p role="status">Loading cloud areas…</p> : !scope ? <p role="status">Confirm this account on the current server before choosing an area.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
  </div>;
}
