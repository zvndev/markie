import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccountIdentitiesClient, accountScopeKey, subscribeAccountScope, type CloudAreas } from "@/lib/account-identities";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { SelectChevron } from "./select-chevron";

interface Props { label: string; value: string; onChange: (areaId: string) => void; onLoaded?: (data: CloudAreas | null) => void; defaultLabel?: string; disabled?: boolean; fullWidth?: boolean }
const BUTTON = "markie-overlay-button rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-accent/40 hover:text-foreground disabled:opacity-40";
const AreaScope = createContext<{ areaId: string; areas: CloudAreas | null; setAreaId: (areaId: string) => void; setAreas: (areas: CloudAreas | null) => void } | null>(null);
export const useCloudAreaScope = () => useContext(AreaScope);
export function CloudAreaProvider({ children, presentation = "panel", showPicker = true }: { children: ReactNode; presentation?: "panel" | "workspace"; showPicker?: boolean }) {
  const [areaId, setAreaId] = useState(""), [areas, setAreas] = useState<CloudAreas | null>(null);
  return <AreaScope.Provider value={{ areaId, areas, setAreaId, setAreas }}>{showPicker ? <div className={presentation === "workspace" ? "w-full max-w-[300px]" : "px-3 py-1"}><CloudAreaPicker label="Cloud area" value={areaId} onChange={setAreaId} onLoaded={setAreas} fullWidth /></div> : null}{children}</AreaScope.Provider>;
}

export function CloudAreaScopePicker() {
  const scope = useCloudAreaScope();
  if (!scope) return null;
  return <CloudAreaPicker label="Cloud area" value={scope.areaId} onChange={scope.setAreaId} onLoaded={scope.setAreas} fullWidth />;
}

function AreaButtonContent({ label, value }: { label: string; value: string }) {
  return <>
    <span className="markie-select-kicker">{label}</span>
    <span className="markie-select-label text-foreground/85">{value}</span>
    <SelectChevron />
  </>;
}
/** Area discovery is deliberate metadata-only work; never opens a document or changes ACLs. */
export function CloudAreaPicker(props: Props) {
  const [activated, setActivated] = useState(false);
  return activated ? <ActivePicker {...props} /> : <button type="button" className={`markie-select-button ${props.fullWidth ? "w-full" : ""}`} disabled={props.disabled} data-open={false} aria-label={`${props.label}: ${props.defaultLabel ?? "All areas"}`} onClick={() => setActivated(true)}><AreaButtonContent label={props.label} value={props.defaultLabel ?? "All areas"} /></button>;
}
function ActivePicker({ label, value, onChange, onLoaded, defaultLabel = "All areas", disabled, fullWidth = false }: Props) {
  const scope = useSyncExternalStore(subscribeAccountScope, accountScopeKey, () => ""), controlsId = useId();
  const [data, setData] = useState<{ scope: string; result: CloudAreas } | null>(null);
  const [open, setOpen] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [name, setName] = useState("");
  const callbacks = useRef({ onChange, onLoaded }); callbacks.current = { onChange, onLoaded };
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const active = useRef<AbortController | null>(null), current = useRef(scope); current.current = scope;
  useDismissibleLayer(open, root, () => setOpen(false));
  const visible = data?.scope === scope ? data.result : null;
  useEffect(() => {
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    callbacks.current.onChange(""); callbacks.current.onLoaded?.(null); setError(null); setName("");
    if (!scope) { setBusy(false); return () => controller.abort(); }
    setBusy(true);
    void new AccountIdentitiesClient().areas(controller.signal).then((result) => { if (!controller.signal.aborted && current.current === scope) { setData({ scope, result }); callbacks.current.onLoaded?.(result); } }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Cloud areas could not be loaded."); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [scope]);
  const select = (next: string) => { onChange(next); setOpen(false); trigger.current?.focus(); };
  const selectedLabel = visible?.areas.find((area) => area.id === value)?.label ?? defaultLabel;
  const chipClass = (selected: boolean) => `${BUTTON} ${selected ? "border-foreground/25 bg-accent text-foreground shadow-[inset_0_1px_rgba(255,255,255,0.06)]" : ""}`;
  return <div ref={root} className={`relative min-w-0 ${fullWidth ? "w-full" : "inline-block max-w-full"}`}>
    <button ref={trigger} type="button" className={`markie-select-button ${fullWidth ? "w-full" : ""}`} disabled={disabled || busy} data-open={open} aria-expanded={open} aria-controls={controlsId} aria-label={`${label}: ${selectedLabel}`} onClick={() => setOpen(!open)}><AreaButtonContent label={label} value={selectedLabel} /></button>
    {open ? <div id={controlsId} role="group" aria-label={label} className="markie-menu-panel overlay-popover-enter absolute left-0 top-full z-40 mt-1.5 w-[min(300px,calc(100vw-32px))] space-y-2 rounded-[10px] p-2 text-[11px]" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <div className="flex flex-wrap gap-1"><button type="button" className={chipClass(!value)} aria-pressed={!value} onClick={() => select("")}>{defaultLabel}</button>{visible?.areas.map((area) => <button key={area.id} className={chipClass(value === area.id)} type="button" aria-pressed={value === area.id} disabled={disabled || busy} onClick={() => select(area.id)}>{area.label}</button>)}</div>
      {visible ? <form className="flex gap-1 border-t border-border/70 pt-2" onSubmit={(event) => { event.preventDefault(); const bound = scope, controller = new AbortController(); active.current?.abort(); active.current = controller; setBusy(true); setError(null); void (async () => { try { const client = new AccountIdentitiesClient(), area = await client.createArea(name, controller.signal), result = await client.areas(controller.signal); if (controller.signal.aborted || current.current !== bound) return; setData({ scope: bound, result }); onLoaded?.(result); onChange(area.id); setName(""); setOpen(false); trigger.current?.focus(); } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Cloud area could not be created."); } finally { if (!controller.signal.aborted) setBusy(false); } })(); }}><input className="markie-overlay-field min-w-0 flex-1 px-2 py-1" aria-label="New cloud area label" placeholder="New area" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /><button className={BUTTON} disabled={disabled || busy || !name.trim()}>Create</button></form> : null}
      {busy ? <p role="status">Loading areas…</p> : !scope ? <p role="status">Confirm your account to use areas.</p> : null}
      {error ? <p role="alert" className="text-[var(--status-red)]">{error}</p> : null}
    </div> : null}
  </div>;
}
