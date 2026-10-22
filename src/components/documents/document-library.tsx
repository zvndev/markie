import { useDeferredValue, useMemo, useState } from "react";
import type { LibraryRecord } from "@/lib/document-library";
import { LibraryDocumentFilters } from "@/components/library-document-filters";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY, queryLibraryDocuments, type LibraryDocumentMetadata, type LibraryDocumentQuery } from "@/lib/library-document-query";

const metadata = (record: LibraryRecord): LibraryDocumentMetadata => ({
  key: record.id, name: record.name, format: record.format, updatedAt: record.updatedAt,
  extractedText: record.extractedText, tags: record.tags, collection: record.collection,
});
export interface DocumentLibraryProps {
  records: readonly LibraryRecord[];
  selectedId?: string;
  loading: boolean;
  onOpen: (record: LibraryRecord) => void;
  onImport: () => void;
  onVault: () => void;
  onClose?: () => void;
}

export function DocumentLibrary({ records, selectedId, loading, onOpen, onImport, onVault, onClose }: DocumentLibraryProps) {
  // Same search, type and sort vocabulary as the app Library and Cloud. This
  // list has no other natural order, so "Default order" is most recent first.
  const [query, setQuery] = useState<LibraryDocumentQuery>({ ...DEFAULT_LIBRARY_DOCUMENT_QUERY });
  const deferredSearch = useDeferredValue(query.search);
  const [tag, setTag] = useState<string | null>(null);
  const [collection, setCollection] = useState<string | null>(null);
  const tags = useMemo(() => [...new Set(records.flatMap((record) => record.tags))].sort(), [records]);
  const collections = useMemo(() => [...new Set(records.flatMap((record) => record.collection ? [record.collection] : []))].sort(), [records]);
  const visible = useMemo(() => {
    const scoped = records.filter((record) => (!tag || record.tags.includes(tag)) && (!collection || record.collection === collection));
    return queryLibraryDocuments(scoped, { ...query, search: deferredSearch, sort: query.sort === "default" ? "recent" : query.sort }, metadata);
  }, [records, deferredSearch, query, tag, collection]);

  return <aside className="docs-library" aria-label="Document library">
    <div className="docs-library-heading"><span className="docs-wordmark">markie<span>.</span></span><span className="docs-local-badge">LOCAL</span>{onClose ? <button type="button" className="docs-library-close" aria-label="Close document library" onClick={onClose}>×</button> : null}</div>
    <div className="docs-library-filters"><LibraryDocumentFilters query={query} onChange={setQuery} searchTextAvailable /></div>
    <div className="docs-list-title"><h2>Documents <span>{visible.length}</span></h2></div>
    {collections.length > 0 ? <div className="docs-collection-filter" role="group" aria-label="Filter collection"><button type="button" aria-pressed={!collection} onClick={() => setCollection(null)}>All collections</button>{collections.map((item) => <button type="button" key={item} aria-pressed={collection === item} onClick={() => setCollection(collection === item ? null : item)}>{item}</button>)}</div> : null}
    {tags.length > 0 ? <div className="docs-tag-filter" role="group" aria-label="Filter tags">{tag ? <button type="button" onClick={() => setTag(null)}>Clear tag</button> : null}{tags.map((item) => <button type="button" key={item} aria-pressed={tag === item} onClick={() => setTag(tag === item ? null : item)}>#{item}</button>)}</div> : null}
    <div className="docs-list" aria-busy={loading}>
      {loading ? <p className="docs-empty-list">Loading your library…</p> : visible.length === 0 ? <p className="docs-empty-list">{records.length ? "No documents match. Try another search or filter." : "Your writing starts here. Create a document or import a file."}</p> : visible.map((record) => <button type="button" className="docs-list-item" key={record.id} aria-current={selectedId === record.id ? "true" : undefined} onClick={() => onOpen(record)}>
        <span className={`docs-format-icon docs-format-${record.format}`} aria-hidden="true">{record.format === "docx" ? "W" : record.format === "markdown" ? "M↓" : record.format === "csv" ? "⊞" : "T"}</span>
        <span className="docs-list-copy"><span className="docs-list-name">{record.name}</span><span className="docs-list-preview">{record.extractedText?.replace(/\s+/g, " ").slice(0, 90) || "Empty document"}</span><span className="docs-list-meta">{record.format.toUpperCase()} · {new Date(record.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{record.tags.length ? ` · #${record.tags[0]}` : ""}</span></span>
      </button>)}
    </div>
    <div className="docs-library-footer"><button type="button" onClick={onImport}>＋ Import files</button><button type="button" onClick={onVault}>▣ Locked vault <span>Private</span></button><p>Stored in this browser or app.<br />Export important documents for a backup.</p></div>
  </aside>;
}
