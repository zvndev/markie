import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getElectronAPI, type DocumentSearchHit, type DocumentSearchResponse } from "@/lib/electron";
import { compactDir, inferHomePath } from "@/lib/path-display";
import { updatedAgo, updatedOn } from "@/lib/relative-time";
import { DocumentFormatMark } from "./document-format-mark";
import "./global-search.css";

// One chip can stand for several index formats: Word means DOCX and the
// legacy DOC it imports, the way Library's filter already treats them.
export const SEARCH_TYPES: ReadonlyArray<{ id: string; label: string; formats: readonly string[] }> = [
  { id: "markdown", label: "Markdown", formats: ["markdown"] },
  { id: "word", label: "Word", formats: ["docx", "doc"] },
  { id: "rtf", label: "Rich Text", formats: ["rtf"] },
  { id: "odt", label: "OpenDocument", formats: ["odt"] },
  { id: "text", label: "Plain text", formats: ["text"] },
  { id: "darkmown", label: "Darkmown", formats: ["darkmown"] },
  { id: "csv", label: "CSV", formats: ["csv"] },
  { id: "json", label: "JSON", formats: ["json"] },
  { id: "yaml", label: "YAML", formats: ["yaml"] },
  { id: "xml", label: "XML", formats: ["xml"] },
  { id: "html", label: "HTML", formats: ["html"] },
];

const TYPES_KEY = "markie.search.types.v1";
const DEBOUNCE_MS = 140;

function rememberedTypes(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(TYPES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => SEARCH_TYPES.some((type) => type.id === id)) : [];
  } catch {
    return [];
  }
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// Wrap every occurrence of every term. Overlaps merge, so "plan planning"
// never produces nested marks.
export function highlight(text: string, needles: string[]): ReactNode {
  if (!needles.length) return text;
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
  }
  return marked(text, ranges);
}

function marked(text: string, ranges: Array<[number, number]>): ReactNode {
  if (!ranges.length) return text;
  const merged = [...ranges].sort((a, b) => a[0] - b[0]).reduce<Array<[number, number]>>((out, range) => {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([range[0], range[1]]);
    return out;
  }, []);
  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={index} className="markie-search-mark">{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

type SearchState =
  | { status: "idle" | "loading" }
  | { status: "done"; response: DocumentSearchResponse; query: string }
  | { status: "error"; message: string };

export function GlobalSearch({ onOpenPath, onClose, initialQuery = "" }: {
  onOpenPath: (path: string) => void;
  onClose: () => void;
  initialQuery?: string;
}) {
  const api = getElectronAPI();
  const available = !!api?.searchDocuments;
  const [query, setQuery] = useState(initialQuery);
  const [types, setTypes] = useState<string[]>(rememberedTypes);
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  const formats = useMemo(
    () => SEARCH_TYPES.filter((type) => types.includes(type.id)).flatMap((type) => type.formats),
    [types]
  );

  useEffect(() => {
    try { localStorage.setItem(TYPES_KEY, JSON.stringify(types)); } catch { /* preference only */ }
  }, [types]);

  useEffect(() => {
    if (!available) return;
    const mine = ++request.current;
    setState((prev) => (prev.status === "done" ? prev : { status: "loading" }));
    const timer = window.setTimeout(() => {
      api!.searchDocuments!({ query, formats, limit: 80 })
        .then((response) => {
          if (mine !== request.current || response.superseded) return;
          if (response.error) setState({ status: "error", message: response.error });
          else setState({ status: "done", response, query });
          setSelected(0);
        })
        .catch(() => { if (mine === request.current) setState({ status: "error", message: "Search failed." }); });
    }, query.trim() ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [api, available, query, formats]);

  const results = useMemo<DocumentSearchHit[]>(() => (state.status === "done" ? state.response.results : []), [state]);
  const clamped = Math.min(selected, Math.max(0, results.length - 1));
  const home = useMemo(() => inferHomePath(results.map((hit) => hit.path)), [results]);
  const needles = useMemo(() => terms(state.status === "done" ? state.query : query), [state, query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [clamped, results]);

  const open = (hit: DocumentSearchHit | undefined) => {
    if (!hit) return;
    onClose();
    // after the modal unmounts, so focus lands in the opened document
    setTimeout(() => onOpenPath(hit.path), 0);
  };

  const toggleType = (id: string) => {
    setTypes((current) => (current.includes(id) ? current.filter((type) => type !== id) : [...current, id]));
    inputRef.current?.focus();
  };

  const searching = !!query.trim();
  const heading = searching ? "Results" : types.length ? "Recently changed of these types" : "Recently changed";

  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="markie-overlay-panel overlay-command-enter flex max-h-[72vh] w-[min(760px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[16px]"
        role="dialog"
        aria-modal="true"
        aria-label="Search all documents"
      >
        <div className="flex items-center gap-3 border-b border-border/70 px-4">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-muted" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="markie-global-search-list"
            aria-activedescendant={results[clamped] ? `markie-search-${clamped}` : undefined}
            value={query}
            disabled={!available}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.stopPropagation(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); open(results[clamped]); }
            }}
            placeholder="Search every document by name or what it says…"
            className="min-w-0 flex-1 border-0 bg-transparent py-3.5 text-[15px] text-foreground outline-none placeholder:text-muted"
          />
          {state.status === "loading" && searching && (
            <span className="markie-search-spinner shrink-0" aria-label="Searching" />
          )}
          <kbd className="hidden shrink-0 rounded border border-border/80 px-1.5 py-0.5 font-mono text-[10px] text-muted sm:inline">esc</kbd>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-4 py-2.5" role="group" aria-label="Document types">
          <button
            type="button"
            aria-pressed={types.length === 0}
            onClick={() => { setTypes([]); inputRef.current?.focus(); }}
            className="markie-search-chip"
          >
            All types
          </button>
          {SEARCH_TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              aria-pressed={types.includes(type.id)}
              onClick={() => toggleType(type.id)}
              className="markie-search-chip"
            >
              {type.label}
            </button>
          ))}
        </div>

        <div id="markie-global-search-list" ref={listRef} role="listbox" aria-label={heading} className="min-h-[120px] flex-1 overflow-y-auto py-1.5">
          {!available && (
            <p className="px-5 py-8 text-center text-[13px] text-muted">Searching across files needs the Markie desktop app.</p>
          )}
          {available && state.status === "error" && (
            <p className="px-5 py-8 text-center text-[13px] text-[var(--status-red)]">{state.message}</p>
          )}
          {available && state.status === "done" && results.length > 0 && (
            <div className="px-4 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted/80">{heading}</div>
          )}
          {available && state.status === "done" && results.length === 0 && (
            <div className="px-5 py-10 text-center">
              <p className="text-[13.5px] text-foreground">{searching ? "Nothing matches" : "No documents found yet"}</p>
              <p className="mt-1 text-[12px] text-muted">
                {searching
                  ? types.length ? "Try another word, or include more document types." : "Try another word or a shorter phrase."
                  : "Markie is still indexing this Mac, or nothing of these types was found."}
              </p>
            </div>
          )}
          {results.map((hit, index) => (
            <button
              key={hit.path}
              id={`markie-search-${index}`}
              type="button"
              role="option"
              aria-selected={index === clamped}
              data-selected={index === clamped}
              onMouseMove={() => { if (index !== clamped) setSelected(index); }}
              onClick={() => open(hit)}
              className="markie-command-row flex w-full items-start gap-3 px-4 py-2.5 text-left"
            >
              <DocumentFormatMark format={hit.format} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[13.5px] font-medium text-foreground" title={hit.path}>{highlight(hit.name, needles)}</span>
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted" title={updatedOn(hit.mtimeMs)}>{updatedAgo(hit.mtimeMs)}</span>
                </span>
                <span className="block truncate text-[11.5px] text-muted" title={hit.dir}>{compactDir(hit.dir, home, 3)}</span>
                {hit.excerpt && (
                  <span className="mt-1 line-clamp-2 block text-[12px] leading-snug text-foreground/75">
                    {marked(hit.excerpt, hit.marks ?? [])}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        {available && state.status === "done" && (
          <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2 text-[11px] text-muted">
            <span>
              {searching
                ? `${results.length} ${results.length === 1 ? "match" : "matches"} · read ${state.response.scanned.toLocaleString()} of ${state.response.total.toLocaleString()} documents`
                : `${state.response.total.toLocaleString()} documents indexed`}
              {state.response.partial && searching ? " · newest first, keep typing to narrow" : ""}
            </span>
            <span className="hidden gap-3 sm:flex">
              <span><kbd className="font-mono">↑↓</kbd> move</span>
              <span><kbd className="font-mono">↵</kbd> open</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
