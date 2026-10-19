import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY, type LibraryDocumentQuery } from "@/lib/library-document-query";
import { SelectChevron } from "./select-chevron";

const TYPES: ReadonlyArray<readonly [LibraryDocumentQuery["format"], string]> = [
  ["all", "All types"], ["markdown", "Markdown"], ["text", "Text"], ["docx", "DOCX"], ["doc", "DOC"],
  ["rtf", "RTF"], ["odt", "ODT"], ["darkmown", "Darkmown"], ["csv", "CSV"], ["json", "JSON"], ["yaml", "YAML"], ["xml", "XML"], ["html", "HTML"], ["other", "Other"],
];
const SORTS: ReadonlyArray<readonly [LibraryDocumentQuery["sort"], string]> = [
  ["default", "Default order"], ["recent", "Most recent"], ["name", "Name"], ["type", "Type"],
];

function QueryMenu<T extends string>({ label, value, options, onChange, layout = "panel" }: {
  label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void; layout?: "panel" | "workspace";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selectedLabel = options.find(([key]) => key === value)?.[1];
  useDismissibleLayer(open, root, () => setOpen(false));
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return;
    }
    if (event.key === "Tab") { trigger.current?.focus(); setOpen(false); return; }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  };
  return <div ref={root} className={layout === "workspace" ? "relative min-w-[154px] flex-1 sm:max-w-[190px]" : "relative min-w-0 flex-1"}>
    <button ref={trigger} type="button" aria-label={`${label}: ${selectedLabel}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} data-open={open}
      onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}
      className="markie-select-button w-full">
      <span className="markie-select-label">{selectedLabel}</span>
      <SelectChevron />
    </button>
    {open ? <div ref={menu} id={id} role="menu" aria-label={label} onKeyDown={keys}
      className="markie-menu-panel overlay-popover-enter absolute top-full left-0 z-30 mt-1.5 min-w-full w-max max-w-[230px] rounded-[10px] p-1">
      {options.map(([key, title]) => <button key={key} type="button" role="menuitemradio" aria-checked={value === key}
        onClick={() => { onChange(key); setOpen(false); trigger.current?.focus(); }}
        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[11.5px] text-foreground hover:bg-accent/40 focus:bg-accent focus:outline-none">
        <span>{title}</span><span aria-hidden="true" className="flex h-3.5 w-3.5 items-center justify-center">{value === key ? "✓" : ""}</span>
      </button>)}
    </div> : null}
  </div>;
}

export function LibraryDocumentFilters({ query, onChange, searchTextAvailable = false, layout = "panel" }: {
  query: LibraryDocumentQuery; onChange: (query: LibraryDocumentQuery) => void; searchTextAvailable?: boolean; layout?: "panel" | "workspace";
}) {
  const search = useRef<HTMLInputElement>(null);
  const active = !!query.search || query.format !== "all" || query.sort !== "default";
  const workspace = layout === "workspace";
  return <div className={workspace ? "flex shrink-0 flex-wrap items-center gap-2" : "shrink-0 space-y-1.5 px-2 py-1.5"} role="group" aria-label="Document filters">
    <div className={workspace ? "relative min-w-[220px] flex-1" : "relative"}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
      <input ref={search} value={query.search} onChange={(event) => onChange({ ...query, search: event.target.value })}
        onKeyDown={(event) => { if (event.key === "Escape" && query.search) { event.stopPropagation(); onChange({ ...query, search: "" }); } }}
        placeholder={searchTextAvailable ? "Search files and document text" : "Filter by name or folder"} aria-label="Filter documents"
        className="markie-overlay-field h-8 w-full py-1 pl-8 pr-2 text-[11.5px]" />
    </div>
    <div className={workspace ? "flex flex-wrap gap-2" : "flex gap-1.5"}>
      <QueryMenu layout={layout} label="Document type" value={query.format} options={TYPES} onChange={(format) => onChange({ ...query, format })} />
      <QueryMenu layout={layout} label="Sort documents" value={query.sort} options={SORTS} onChange={(sort) => onChange({ ...query, sort })} />
    </div>
    {active ? <button type="button" onClick={() => { onChange({ ...DEFAULT_LIBRARY_DOCUMENT_QUERY }); search.current?.focus(); }} className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-[11px] text-muted transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]">Clear filters</button> : null}
  </div>;
}
