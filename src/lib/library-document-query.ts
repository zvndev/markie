import type { LibraryFormat } from "./document-library";
import { classifyDocumentFormat } from "./document-formats";

export interface LibraryDocumentQuery {
  search: string;
  format: "all" | LibraryFormat | "html" | "other";
  sort: "default" | "recent" | "name" | "type";
}

/** Presentation metadata from ordinary sources only, never vault records. */
export interface LibraryDocumentMetadata {
  key: string;
  name: string;
  format: LibraryFormat | "html" | "other";
  path?: string | null;
  updatedAt?: string | number | null;
  extractedText?: string;
  tags?: readonly string[];
  collection?: string | null;
}

export const DEFAULT_LIBRARY_DOCUMENT_QUERY: Readonly<LibraryDocumentQuery> = Object.freeze({ search: "", format: "all", sort: "default" });

export function libraryDocumentFormat(name: string): LibraryFormat | "html" | "other" {
  const kind = classifyDocumentFormat(name).kind;
  // HTML keeps its own bucket so it is filterable like every other type the
  // explorer can find, even though it has no storage record format of its own.
  return kind === "unsupported" ? "other" : kind;
}

export function matchesLibraryDocument(metadata: LibraryDocumentMetadata, query: LibraryDocumentQuery): boolean {
  if (query.format !== "all" && query.format !== metadata.format) return false;
  const words = query.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  // Only search text actually supplied by the source. Native registry rows do
  // not contain bodies, and listing/filtering must not read files or downloads.
  const fields = [metadata.name, metadata.path ?? "", metadata.extractedText ?? "", metadata.collection ?? "", ...(metadata.tags ?? [])].map((field) => field.toLowerCase());
  return words.every((word) => fields.some((field) => field.includes(word)));
}

function compareText(a: string, b: string): number {
  const left = a.toLowerCase(), right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function timestamp(value: LibraryDocumentMetadata["updatedAt"]): number {
  const parsed = typeof value === "number" ? value : value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function compareLibraryDocuments(a: LibraryDocumentMetadata, b: LibraryDocumentMetadata, sort: LibraryDocumentQuery["sort"]): number {
  if (sort === "default") return 0;
  const primary = sort === "recent" ? timestamp(b.updatedAt) - timestamp(a.updatedAt)
    : sort === "type" ? compareText(a.format, b.format) : compareText(a.name, b.name);
  return primary || compareText(a.name, b.name) || compareText(a.key, b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export function queryLibraryDocuments<T>(rows: readonly T[], query: LibraryDocumentQuery, metadataOf: (row: T) => LibraryDocumentMetadata): T[] {
  return rows.map((row) => ({ row, metadata: metadataOf(row) }))
    .filter(({ metadata }) => matchesLibraryDocument(metadata, query))
    .sort((a, b) => compareLibraryDocuments(a.metadata, b.metadata, query.sort))
    .map(({ row }) => row);
}
