// Version history as a mode of the document, the way Google Docs does it: the
// selected version fills the document area, read-only, and a panel on the
// right lists every version Markie holds, grouped by day and month. Super-
// nightly only (src/lib/nightly.ts); stable keeps HistoryDialog.
//
// "Highlight changes" compares the selected version with the version before
// it, not with the current text. That shows what each save changed, which is
// what a row's author and time describe. A collapsed row of autosaves is
// compared with the version before the whole run, so it shows the session.
//
// Restoring never writes: the version is loaded into the buffer as unsaved,
// exactly as the dialog does, so looking through history cannot cost anyone
// the document they were looking at.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getElectronAPI, type HistoryEntry, type HistoryHead } from "@/lib/electron";
import { splitFrontMatter } from "@/lib/front-matter";
import { renderMarkdownHTML } from "@/lib/markdown-html";
import { markDiffHtml, markMarkdownChanges, markSourceChanges, markedSpans } from "@/lib/version-diff";
import {
  authorColor,
  authorLabel,
  formatVersionHeading,
  formatVersionTime,
  groupVersions,
  type VersionGroup,
} from "@/lib/version-history";
import "./version-history.css";

const CURRENT = "current";
const MARKDOWN = /\.(md|markdown|mdx)$/i;

type Selection = { id: string; base: string | null };

function useTrafficLightPad(): boolean {
  return getElectronAPI()?.platform === "darwin";
}

export function VersionHistoryView({
  filePath,
  fileName,
  currentContent,
  dirty,
  onRestore,
  onClose,
  now = () => new Date(),
}: {
  filePath: string;
  fileName: string;
  /** The buffer in its on-disk form, so it compares byte for byte with versions. */
  currentContent: string;
  /** Unsaved edits in the buffer: the current version is not on disk yet. */
  dirty: boolean;
  onRestore: (content: string) => void;
  onClose: () => void;
  now?: () => Date;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [head, setHead] = useState<HistoryHead | null>(null);
  const [contents, setContents] = useState<Record<string, string | null>>({});
  const [selected, setSelected] = useState<Selection>({ id: CURRENT, base: null });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [highlight, setHighlight] = useState(true);
  const [namedOnly, setNamedOnly] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const trafficLightPad = useTrafficLightPad();
  const isMarkdown = MARKDOWN.test(fileName);

  const refresh = useCallback(async () => {
    const api = getElectronAPI();
    try {
      const [list, h] = await Promise.all([
        api?.historyList?.(filePath) ?? Promise.resolve([]),
        api?.historyHead?.({ path: filePath, content: currentContent }) ?? Promise.resolve(null),
      ]);
      setEntries(Array.isArray(list) ? list : []);
      setHead(h ?? null);
    } catch {
      setEntries([]);
    }
  }, [filePath, currentContent]);

  // refresh changes with the text on screen, so this reads the list again
  // when it does: an agent write reloaded while this view is open is a new
  // version, and the current row has a new author.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  const contentOf = useCallback(
    (id: string | null): string | null | undefined => {
      if (id === null) return null;
      if (id === CURRENT) return currentContent;
      return contents[id];
    },
    [contents, currentContent]
  );

  // The newest stored version holds exactly the current text when the last
  // write was recorded as it landed (an agent's edit seen by the watcher, or a
  // version named from here). Then it is the current version, not a row of
  // its own, and its name and author are the current version's.
  const top = entries?.[0];
  const topIsCurrent = !!top && !dirty && contents[top.stamp] === currentContent;
  const stored = useMemo(() => (entries ? (topIsCurrent ? entries.slice(1) : entries) : []), [entries, topIsCurrent]);
  const currentEntry: HistoryEntry | null = topIsCurrent && top ? top : null;

  const groups: VersionGroup[] = useMemo(() => {
    const list = namedOnly ? stored.filter((e) => e.name) : stored;
    const g = groupVersions(list, now());
    if (!namedOnly && g[0]?.key !== "today") g.unshift({ key: "today", label: "Today", rows: [] });
    return g;
    // now() is read per render on purpose: the sections follow the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, namedOnly]);

  // The version before `stamp` in the full list, or before the end of its
  // collapsed run when the run is folded.
  const baseFor = useCallback(
    (id: string, { run }: { run?: HistoryEntry[] } = {}): string | null => {
      if (id === CURRENT) return stored[0]?.stamp ?? null;
      const all = entries ?? [];
      const last = run && run.length ? run[run.length - 1].stamp : id;
      const i = all.findIndex((e) => e.stamp === last);
      return i >= 0 && i + 1 < all.length ? all[i + 1].stamp : null;
    },
    [entries, stored]
  );

  // Keep the current version's base right as the list loads and changes.
  useEffect(() => {
    if (selected.id === CURRENT) {
      const base = baseFor(CURRENT);
      if (base !== selected.base) setSelected({ id: CURRENT, base });
    }
  }, [selected, baseFor]);

  // Read what the view needs: the selection, its base, and the newest version
  // (to tell whether it is the current text).
  useEffect(() => {
    const need = [selected.id, selected.base, top?.stamp].filter(
      (s): s is string => !!s && s !== CURRENT && contents[s] === undefined
    );
    if (!need.length) return;
    let alive = true;
    void (async () => {
      const api = getElectronAPI();
      for (const stamp of new Set(need)) {
        const res = await api?.historyRead?.({ path: filePath, stamp }).catch(() => null);
        if (!alive) return;
        setContents((prev) => ({ ...prev, [stamp]: res?.content ?? null }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [selected, top, contents, filePath]);

  const selectedContent = contentOf(selected.id);
  const baseContent = contentOf(selected.base);
  const selectedEntry: HistoryEntry | null =
    selected.id === CURRENT ? currentEntry : (entries?.find((e) => e.stamp === selected.id) ?? null);

  const rendered = useMemo(() => {
    if (typeof selectedContent !== "string") return null;
    const compare = highlight && typeof baseContent === "string" ? baseContent : null;
    if (isMarkdown) {
      const body = splitFrontMatter(selectedContent).body;
      if (compare === null) return { kind: "html" as const, html: renderMarkdownHTML(body), changed: false, skipped: false };
      const marked = markMarkdownChanges(splitFrontMatter(compare).body, body);
      return { kind: "html" as const, html: markDiffHtml(renderMarkdownHTML(marked.text)), changed: marked.changed, skipped: marked.skipped };
    }
    if (compare === null) return { kind: "source" as const, spans: [{ kind: "same" as const, text: selectedContent }], changed: false, skipped: false };
    const marked = markSourceChanges(compare, selectedContent);
    return { kind: "source" as const, spans: markedSpans(marked.text), changed: marked.changed, skipped: marked.skipped };
  }, [selectedContent, baseContent, highlight, isMarkdown]);

  // Every row the panel shows, in order, for the arrow keys.
  const visible = useMemo(() => {
    const out: Selection[] = [];
    if (!namedOnly) out.push({ id: CURRENT, base: baseFor(CURRENT) });
    for (const g of groups) {
      for (const row of g.rows) {
        const open = expanded.has(row.lead.stamp);
        out.push({ id: row.lead.stamp, base: baseFor(row.lead.stamp, open ? {} : { run: row.minor }) });
        if (open) for (const m of row.minor) out.push({ id: m.stamp, base: baseFor(m.stamp) });
      }
    }
    return out;
  }, [groups, expanded, namedOnly, baseFor]);

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 1800);
  };

  const copy = async (id: string) => {
    setMenuFor(null);
    const text = contentOf(id) ?? (id !== CURRENT ? await readVersion(id) : null);
    if (typeof text !== "string") return;
    try {
      await navigator.clipboard.writeText(text);
      flash("Copied");
    } catch {
      flash("Could not copy");
    }
  };

  const readVersion = async (stamp: string): Promise<string | null> => {
    const res = await getElectronAPI()?.historyRead?.({ path: filePath, stamp }).catch(() => null);
    const text = res?.content ?? null;
    setContents((prev) => ({ ...prev, [stamp]: text }));
    return text;
  };

  const restore = async (id: string) => {
    setMenuFor(null);
    if (id === CURRENT) return;
    const text = contents[id] ?? (await readVersion(id));
    if (typeof text === "string") onRestore(text);
  };

  const saveName = async () => {
    if (!renaming) return;
    const { id, draft } = renaming;
    setRenaming(null);
    const api = getElectronAPI();
    // The current version is named on its stored copy when it has one, and
    // otherwise kept as a version first by main.
    const stamp = id === CURRENT ? currentEntry?.stamp : id;
    const res = await api?.historyName?.({ path: filePath, ...(stamp ? { stamp } : {}), name: draft }).catch(() => null);
    if (!res?.ok) {
      flash(res?.error ?? "Could not name this version");
      return;
    }
    await refresh();
  };

  const startRename = (id: string, current: string | undefined) => {
    setMenuFor(null);
    setRenaming({ id, draft: current ?? "" });
  };

  // Escape leaves history, unless it is closing a menu or a rename first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (menuFor) setMenuFor(null);
      else if (renaming) setRenaming(null);
      else onClose();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuFor, renaming, onClose]);

  // A click anywhere outside an open row menu closes it.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-vh-menu]")) setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);

  const onListKey = (e: ReactKeyboardEvent) => {
    if (renaming || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const i = visible.findIndex((v) => v.id === selected.id);
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      setSelected(next);
      document.querySelector<HTMLElement>(`[data-vh-row="${CSS.escape(next.id)}"]`)?.focus();
    }
    e.preventDefault();
  };

  const nowDate = now();
  const currentIso = currentEntry?.iso ?? (!dirty && head?.iso ? head.iso : nowDate.toISOString());
  const currentAuthor: Pick<HistoryEntry, "author" | "agent"> | null = dirty
    ? { author: "user" }
    : currentEntry
      ? currentEntry
      : head
        ? head
        : null;

  const heading =
    selected.id === CURRENT
      ? currentEntry?.name ?? (dirty ? "Current version, unsaved" : formatVersionHeading(currentIso, nowDate))
      : selectedEntry
        ? selectedEntry.name ?? formatVersionHeading(selectedEntry.iso, nowDate)
        : "";

  const row = (
    entry: HistoryEntry | null,
    sel: Selection,
    opts: { minorCount?: number; open?: boolean; minor?: boolean; current?: boolean }
  ) => {
    const id = sel.id;
    const isSelected = selected.id === id;
    const name = entry?.name;
    const time = opts.current ? currentIso : (entry?.iso ?? "");
    const who = opts.current ? currentAuthor : entry;
    const editing = renaming?.id === id;
    return (
      <div
        key={id}
        className="markie-vh-row-wrap"
        data-minor={opts.minor ? "true" : undefined}
      >
        <div
          role="option"
          aria-selected={isSelected}
          tabIndex={isSelected ? 0 : -1}
          data-vh-row={id}
          data-selected={isSelected ? "true" : undefined}
          className="markie-vh-row"
          onClick={() => setSelected(sel)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !editing) setSelected(sel);
          }}
        >
          <span className="markie-vh-chevron-slot">
            {opts.minorCount ? (
              <button
                type="button"
                className="markie-vh-chevron"
                aria-label={opts.open ? "Hide minor versions" : `Show ${opts.minorCount} more version${opts.minorCount === 1 ? "" : "s"}`}
                aria-expanded={!!opts.open}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                  // The row's own base changes with it: folded, it compares
                  // against the version before the whole run.
                  if (isSelected) setSelected({ id, base: baseFor(id, opts.open ? { run: rowsMinor(id) } : {}) });
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: opts.open ? "rotate(90deg)" : undefined }}>
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            ) : null}
          </span>
          <span className="markie-vh-row-body">
            {editing ? (
              <input
                autoFocus
                aria-label="Version name"
                className="markie-vh-name-input"
                value={renaming.draft}
                maxLength={120}
                placeholder="Name this version"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenaming({ id, draft: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveName();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
                onBlur={() => void saveName()}
              />
            ) : name ? (
              <span className="markie-vh-row-name">{name}</span>
            ) : null}
            {!editing && (
              <span className={name ? "markie-vh-row-sub" : "markie-vh-row-time"}>
                {opts.current && dirty ? "Unsaved changes" : formatVersionTime(time, nowDate)}
              </span>
            )}
            {opts.current ? <span className="markie-vh-row-sub">Current version</span> : null}
            {who && who.author !== "unknown" ? (
              <span className="markie-vh-author">
                <span className="markie-vh-dot" style={{ "--vh-dot": authorColor(who) } as CSSProperties} aria-hidden="true" />
                {authorLabel(who)}
              </span>
            ) : null}
          </span>
          <span className="markie-vh-menu-slot" data-vh-menu>
            <button
              type="button"
              className="markie-vh-kebab"
              aria-label="Version actions"
              aria-haspopup="menu"
              aria-expanded={menuFor === id}
              onClick={(e) => {
                e.stopPropagation();
                setMenuFor((m) => (m === id ? null : id));
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="5" r="1.7" />
                <circle cx="12" cy="12" r="1.7" />
                <circle cx="12" cy="19" r="1.7" />
              </svg>
            </button>
            {menuFor === id && (
              <div role="menu" className="markie-menu-panel markie-menu-raised markie-vh-menu" onClick={(e) => e.stopPropagation()}>
                {opts.current ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="markie-menu-item"
                    disabled={dirty}
                    title={dirty ? "Save your changes first" : undefined}
                    onClick={() => startRename(id, name)}
                  >
                    {name ? "Rename" : "Name current version"}
                  </button>
                ) : (
                  <>
                    <button type="button" role="menuitem" className="markie-menu-item" onClick={() => startRename(id, name)}>
                      {name ? "Rename" : "Name this version"}
                    </button>
                    {name ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="markie-menu-item"
                        onClick={() => {
                          setMenuFor(null);
                          void (async () => {
                            const res = await getElectronAPI()?.historyName?.({ path: filePath, stamp: id, name: "" }).catch(() => null);
                            if (res?.ok) await refresh();
                          })();
                        }}
                      >
                        Remove name
                      </button>
                    ) : null}
                    <button type="button" role="menuitem" className="markie-menu-item" onClick={() => void restore(id)}>
                      Restore this version
                    </button>
                  </>
                )}
                <button type="button" role="menuitem" className="markie-menu-item" onClick={() => void copy(id)}>
                  Copy text
                </button>
              </div>
            )}
          </span>
        </div>
      </div>
    );
  };

  const rowsMinor = (leadStamp: string): HistoryEntry[] => {
    for (const g of groups) for (const r of g.rows) if (r.lead.stamp === leadStamp) return r.minor;
    return [];
  };

  return (
    <div className="markie-vh fixed inset-0 z-[105] flex flex-col markie-shell" data-markie-version-history>
      <header
        data-window-drag-surface
        className={`markie-toolbar h-10 border-b border-border bg-surface flex items-center gap-2 pr-3 select-none shrink-0 ${trafficLightPad ? "pl-[82px]" : "pl-3"}`}
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        <button
          ref={backRef}
          type="button"
          onClick={onClose}
          aria-label="Back to the document"
          title="Back to the document (Esc)"
          className="markie-toolbar-icon flex h-7 w-7 items-center justify-center rounded-md text-muted hover:text-foreground"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="min-w-0 flex-1 truncate text-[13px] text-foreground" aria-live="polite">
          <span className={selectedEntry?.name ? "font-semibold" : undefined}>{heading}</span>
          <span className="ml-2 text-muted text-[12px]">{fileName}</span>
        </div>
        {notice ? (
          <span role="status" className="text-[12px] text-muted">
            {notice}
          </span>
        ) : null}
        <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <button
            type="button"
            className="markie-toolbar-action h-7 px-2.5 rounded-md text-[12px] text-muted hover:text-foreground"
            onClick={() => void copy(selected.id)}
            disabled={typeof selectedContent !== "string"}
          >
            Copy text
          </button>
          {selected.id !== CURRENT ? (
            <button
              type="button"
              className="markie-vh-restore h-7 px-3 rounded-md text-[12px] font-medium"
              onClick={() => void restore(selected.id)}
              disabled={typeof selectedContent !== "string"}
            >
              Restore this version
            </button>
          ) : null}
        </div>
      </header>
      <div className="flex-1 min-h-0 flex">
        <main className="markie-workspace flex-1 min-w-0 min-h-0 relative" aria-label="Selected version">
          <div className="markie-document-scroll h-full overflow-y-auto">
            {rendered === null ? (
              <p className="p-8 text-[13px] text-muted">
                {selectedContent === null ? "This version could not be read." : "Loading…"}
              </p>
            ) : (
              <>
                {highlight && rendered.skipped ? (
                  <p className="markie-vh-skip">This document is too long to highlight changes. Showing the version as it was.</p>
                ) : null}
                {rendered.kind === "html" ? (
                  <article
                    className="markdown-body markie-document-canvas mx-auto markie-vh-doc"
                    style={{
                      width: "min(100%, var(--doc-width, 768px))",
                      fontSize: "var(--doc-font-size, 16px)",
                      fontFamily: "var(--doc-font-family, inherit)",
                    }}
                    dangerouslySetInnerHTML={{ __html: rendered.html }}
                  />
                ) : (
                  <pre className="markie-vh-source markie-document-canvas mx-auto">
                    {rendered.spans.map((s, i) =>
                      s.kind === "same" ? (
                        <span key={i}>{s.text}</span>
                      ) : s.kind === "ins" ? (
                        <ins key={i} className="markie-vh-ins">{s.text}</ins>
                      ) : (
                        <del key={i} className="markie-vh-del">{s.text}</del>
                      )
                    )}
                  </pre>
                )}
              </>
            )}
          </div>
        </main>
        <aside className="markie-side-panel markie-vh-panel border-l border-border" aria-label="Version history">
          <div className="markie-vh-panel-head">
            <h2 className="text-[14px] font-semibold text-foreground">Version history</h2>
            <select
              aria-label="Which versions"
              className="markie-vh-filter"
              value={namedOnly ? "named" : "all"}
              onChange={(e) => setNamedOnly(e.target.value === "named")}
            >
              <option value="all">All versions</option>
              <option value="named">Named versions</option>
            </select>
          </div>
          <div className="markie-vh-list" role="listbox" aria-label="Versions" tabIndex={-1} onKeyDown={onListKey}>
            {entries === null ? (
              <p className="px-4 py-3 text-[12px] text-muted">Loading…</p>
            ) : (
              <>
                {groups.map((g) => (
                  <div key={g.key} role="group" aria-label={g.label}>
                    <div className="markie-vh-section">{g.label}</div>
                    {g.key === "today" && !namedOnly
                      ? row(currentEntry, { id: CURRENT, base: baseFor(CURRENT) }, { current: true })
                      : null}
                    {g.rows.map((r) => {
                      const open = expanded.has(r.lead.stamp);
                      return (
                        <div key={r.lead.stamp}>
                          {row(r.lead, { id: r.lead.stamp, base: baseFor(r.lead.stamp, open ? {} : { run: r.minor }) }, { minorCount: r.minor.length, open })}
                          {open ? r.minor.map((m) => row(m, { id: m.stamp, base: baseFor(m.stamp) }, { minor: true })) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
                {stored.length === 0 && !namedOnly ? (
                  <p className="px-4 py-3 text-[12px] text-muted">
                    No earlier versions yet. Markie keeps one every time this document is saved.
                  </p>
                ) : null}
                {namedOnly && groups.every((g) => g.rows.length === 0) ? (
                  <p className="px-4 py-3 text-[12px] text-muted">No named versions. Name one from its menu to keep it.</p>
                ) : null}
              </>
            )}
          </div>
          <label className="markie-vh-toggle">
            <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />
            Highlight changes
          </label>
        </aside>
      </div>
    </div>
  );
}
