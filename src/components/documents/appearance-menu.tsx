import { useEffect, useRef, useState } from "react";
import { applyColorMode, COLOR_MODE_CHANGED_EVENT, getColorMode, watchSystemColorMode, type ColorMode } from "@/lib/color-mode";

export function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(getColorMode);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const update = () => setMode(getColorMode());
    window.addEventListener(COLOR_MODE_CHANGED_EVENT, update);
    const stop = watchSystemColorMode();
    return () => { window.removeEventListener(COLOR_MODE_CHANGED_EVENT, update); stop(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={root} className="docs-appearance"><button ref={trigger} type="button" aria-label="Appearance" aria-expanded={open} onClick={() => setOpen(!open)}>◐</button>{open ? <div className="docs-new-menu" role="group" aria-label="Color mode">{(["light", "dark", "system"] as ColorMode[]).map((item) => <button type="button" key={item} aria-pressed={mode === item} onClick={() => { applyColorMode(item); setMode(item); setOpen(false); trigger.current?.focus(); }}>{item[0].toUpperCase() + item.slice(1)}{mode === item ? " ✓" : ""}</button>)}</div> : null}</div>;
}
