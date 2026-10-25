// Home: the newest documents in the account, owned and shared, with the ones
// an agent made marked as such.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { ApiError, type ApiClient } from "../lib/api";
import type { RecentDoc } from "../lib/docs";
import { haptics } from "../lib/native";
import {
  PAGE_SIZE,
  agentBadge,
  displayName,
  filterRecent,
  mergeRecent,
  nextCursor,
  sectionRecent,
  sharedLabel,
  timeLabel,
  type RecentScope,
} from "../lib/recent";
import { Screen } from "../components/screen";
import { AlertIcon, ChevronRight, ClearIcon, GearIcon, PeopleIcon, SearchIcon, SparkleIcon } from "../components/icons";

interface RecentProps {
  api: ApiClient;
  onOpen: (doc: RecentDoc) => void;
  onSettings: () => void;
  onUnauthorized: () => void;
  /** Bumped by the app when it returns to the foreground. */
  refreshKey: number;
}

type LoadState = { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

// The last list this launch saw, so coming back from a document is instant.
let cached: { origin: string; docs: RecentDoc[]; cursor: string | null } | null = null;

export function RecentScreen({ api, onOpen, onSettings, onUnauthorized, refreshKey }: RecentProps) {
  const warm = cached?.origin === api.origin ? cached : null;
  const [docs, setDocs] = useState<RecentDoc[]>(warm?.docs ?? []);
  const [cursor, setCursor] = useState<string | null>(warm?.cursor ?? null);
  const [state, setState] = useState<LoadState>(warm ? { status: "ready" } : { status: "loading" });
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<RecentScope>("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    setState({ status: "error", message: error instanceof Error ? error.message : "Couldn't load your documents." });
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    const run = ++generation.current;
    try {
      const page = await api.recent({ limit: PAGE_SIZE });
      if (run !== generation.current) return;
      const next = mergeRecent([], page);
      setDocs(next);
      setCursor(nextCursor(page));
      setNow(Date.now());
      setState({ status: "ready" });
      cached = { origin: api.origin, docs: next, cursor: nextCursor(page) };
    } catch (error) {
      if (run === generation.current) handleError(error);
    }
  }, [api, handleError]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || state.status !== "ready") return;
    setLoadingMore(true);
    const run = generation.current;
    try {
      const page = await api.recent({ limit: PAGE_SIZE, before: cursor });
      if (run !== generation.current) return;
      setDocs((current) => {
        const next = mergeRecent(current, page);
        cached = { origin: api.origin, docs: next, cursor: nextCursor(page) };
        return next;
      });
      setCursor(nextCursor(page));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      // Otherwise the list stays as it is; scrolling to the end retries.
    } finally {
      setLoadingMore(false);
    }
  }, [api, cursor, loadingMore, state.status, onUnauthorized]);

  const visible = useMemo(() => filterRecent(docs, query, scope), [docs, query, scope]);
  const sections = useMemo(() => sectionRecent(visible, now), [visible, now]);
  const sharedCount = useMemo(() => docs.filter((doc) => doc.shared).length, [docs]);

  const header = (
    <div className="m-list-tools">
      <label className="m-search">
        <SearchIcon size={17} />
        <input
          type="search"
          placeholder="Search by name"
          aria-label="Search documents by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {query ? <button type="button" className="m-search-clear" aria-label="Clear search" onClick={() => setQuery("")}><ClearIcon size={17} /></button> : null}
      </label>
      <div className="m-segmented" role="tablist" aria-label="Which documents">
        {(["all", "shared"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={scope === value}
            className={scope === value ? "is-selected" : ""}
            onClick={() => { if (scope !== value) { haptics.selection(); setScope(value); } }}
          >
            {value === "all" ? "All" : `Shared with you${sharedCount ? ` (${sharedCount})` : ""}`}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Screen
      title="Recent"
      largeTitle
      header={header}
      actions={<button type="button" className="m-nav-icon" aria-label="Settings" onClick={onSettings}><GearIcon size={23} /></button>}
      onRefresh={load}
      onNearEnd={cursor ? () => void loadMore() : undefined}
    >
      {state.status === "loading" && docs.length === 0 ? <ListSkeleton /> : null}
      {state.status === "error" && docs.length === 0 ? (
        <div className="m-empty" role="alert">
          <AlertIcon size={30} />
          <h2>Couldn't load your documents</h2>
          <p>{state.message}</p>
          <button type="button" className="m-button m-button-secondary" onClick={() => { setState({ status: "loading" }); void load(); }}>Try again</button>
        </div>
      ) : null}
      {state.status === "error" && docs.length > 0 ? <p className="m-inline-error" role="status">{state.message} Pull down to try again.</p> : null}
      {state.status !== "loading" && docs.length === 0 && state.status !== "error" ? (
        <div className="m-empty">
          <SparkleIcon size={30} />
          <h2>No documents yet</h2>
          <p>Documents you save to Markie Cloud, and the ones your agents make for you, show up here.</p>
        </div>
      ) : null}
      {docs.length > 0 && visible.length === 0 ? (
        <div className="m-empty m-empty-compact">
          <h2>{query ? "No matches" : "Nothing shared with you yet"}</h2>
          <p>{query ? `No document names match "${query}".` : "When someone shares a document with this account, it appears here."}</p>
        </div>
      ) : null}
      {sections.map((section) => (
        <section key={section.title} className="m-list-section" aria-label={section.title}>
          <h2 className="m-list-heading">{section.title}</h2>
          <ul className="m-list">
            {section.docs.map((doc) => <DocRow key={doc.id} doc={doc} now={now} onOpen={onOpen} />)}
          </ul>
        </section>
      ))}
      {loadingMore ? <div className="m-list-more"><span className="m-spinner" aria-hidden="true" /><span className="m-visually-hidden" role="status">Loading more</span></div> : null}
    </Screen>
  );
}

function DocRow({ doc, now, onOpen }: { doc: RecentDoc; now: number; onOpen: (doc: RecentDoc) => void }) {
  const badge = agentBadge(doc);
  const shared = sharedLabel(doc);
  return (
    <li>
      <button type="button" className="m-row" onClick={() => onOpen(doc)}>
        <DocumentFormatMark format={doc.format} size="sm" />
        <span className="m-row-main">
          <span className="m-row-title">{displayName(doc.name)}</span>
          <span className="m-row-meta">
            {badge ? <span className="m-badge m-badge-agent"><SparkleIcon size={11} />{badge}</span> : null}
            {shared ? <span className="m-row-shared"><PeopleIcon size={13} />{shared}</span> : null}
            {!badge && !shared ? <span className="m-row-kind">{doc.format === "darkmown" ? "Interactive document" : doc.format === "text" ? "Text" : "Markdown"}</span> : null}
          </span>
        </span>
        <span className="m-row-time">{timeLabel(doc.updatedAt, now)}</span>
        <ChevronRight size={16} className="m-row-chevron" />
      </button>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="m-skeleton" aria-busy="true" aria-label="Loading documents">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="m-skeleton-row">
          <span className="m-skeleton-icon" />
          <span className="m-skeleton-lines"><span style={{ width: `${62 - (index % 3) * 12}%` }} /><span style={{ width: `${34 + (index % 2) * 10}%` }} /></span>
        </div>
      ))}
    </div>
  );
}

/** Forget the warm list, so another account never sees this one's names. */
export function clearRecentCache(): void {
  cached = null;
}
