import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY, type LibraryDocumentQuery } from "@/lib/library-document-query";

const TYPES: ReadonlyArray<readonly [LibraryDocumentQuery["format"], string]> = [
  ["all", "All types"], ["markdown", "Markdown"], ["text", "Text"], ["docx", "DOCX"], ["doc", "DOC"],
  ["rtf", "RTF"], ["odt", "ODT"], ["darkmown", "Darkmown"], ["csv", "CSV"], ["json", "JSON"], ["yaml", "YAML"], ["xml", "XML"], ["html", "HTML"], ["other", "Other"],
];
const SORTS: ReadonlyArray<readonly [LibraryDocumentQuery["sort"], string]> = [
  ["default", "Default order"], ["recent", "Most recent"], ["name", "Name"], ["type", "Type"],
];

function QueryMenu<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void;
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
  return <div ref={root} className="relative min-w-0 flex-1">
    <button ref={trigger} type="button" aria-label={`${label}: ${selectedLabel}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}
      className="w-full truncate rounded-md border border-border px-2 py-1 text-left text-[11px] text-muted hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]">
      {selectedLabel} <span aria-hidden="true">⌄</span>
    </button>
    {open ? <div ref={menu} id={id} role="menu" aria-label={label} onKeyDown={keys}
      className="absolute top-full left-0 z-30 mt-1 min-w-full w-max max-w-[220px] rounded-lg border border-border bg-surface-2 p-1 shadow-lg">
      {options.map(([key, title]) => <button key={key} type="button" role="menuitemradio" aria-checked={value === key}
        onClick={() => { onChange(key); setOpen(false); trigger.current?.focus(); }}
        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[11.5px] text-foreground hover:bg-accent/40 focus:bg-accent focus:outline-none">
        {title}<span aria-hidden="true">{value === key ? "✓" : ""}</span>
      </button>)}
    </div> : null}
  </div>;
}

export function LibraryDocumentFilters({ query, onChange, searchTextAvailable = false }: {
  query: LibraryDocumentQuery; onChange: (query: LibraryDocumentQuery) => void; searchTextAvailable?: boolean;
}) {
  const search = useRef<HTMLInputElement>(null);
  const active = !!query.search || query.format !== "all" || query.sort !== "default";
  return <div className="shrink-0 space-y-1.5 px-2 py-1.5" role="group" aria-label="Document filters">
    <input ref={search} value={query.search} onChange={(event) => onChange({ ...query, search: event.target.value })}
      onKeyDown={(event) => { if (event.key === "Escape" && query.search) { event.stopPropagation(); onChange({ ...query, search: "" }); } }}
      placeholder={searchTextAvailable ? "Search files and document text" : "Filter by name or folder"} aria-label="Filter documents"
      className="markie-overlay-field w-full text-[11.5px] px-2 py-1" />
    <div className="flex gap-1.5">
      <QueryMenu label="Document type" value={query.format} options={TYPES} onChange={(format) => onChange({ ...query, format })} />
      <QueryMenu label="Sort documents" value={query.sort} options={SORTS} onChange={(sort) => onChange({ ...query, sort })} />
    </div>
    {active ? <button type="button" onClick={() => { onChange({ ...DEFAULT_LIBRARY_DOCUMENT_QUERY }); search.current?.focus(); }} className="rounded-md px-1 py-0.5 text-[11px] text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]">Clear filters</button> : null}
  </div>;
}
