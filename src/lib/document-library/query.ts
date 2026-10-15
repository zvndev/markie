import { cloneRecord, fail, LIBRARY_FORMATS } from "./model";
import type { LibraryQuery, LibraryRecord } from "./types";

/** Pure, deterministic normal-workspace search; no vault storage or decrypt path. */
export function queryLibraryRecords(records: readonly LibraryRecord[], query: LibraryQuery = {}): LibraryRecord[] {
  if (!query || typeof query !== "object" || (query.search !== undefined && (typeof query.search !== "string" || query.search.length > 4096)) || (query.formats !== undefined && (!Array.isArray(query.formats) || query.formats.some((v) => !LIBRARY_FORMATS.includes(v)))) || (query.tags !== undefined && (!Array.isArray(query.tags) || query.tags.length > 32 || query.tags.some((v) => typeof v !== "string" || v.length > 64))) || (query.collection !== undefined && query.collection !== null && typeof query.collection !== "string") || (query.sortBy !== undefined && !["name", "updatedAt", "createdAt", "format"].includes(query.sortBy)) || (query.sortDirection !== undefined && !["asc", "desc"].includes(query.sortDirection))) fail("invalid-input", "Invalid document-library query.");
  const words = (query.search ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sortBy = query.sortBy ?? "updatedAt", direction = (query.sortDirection ?? (sortBy === "updatedAt" ? "desc" : "asc")) === "asc" ? 1 : -1;
  const compare = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0;
  return records.filter((record) => {
    if (query.formats?.length && !query.formats.includes(record.format)) return false;
    if (query.tags?.length && !query.tags.every((tag) => record.tags.includes(tag))) return false;
    if (query.collection !== undefined && query.collection !== record.collection) return false;
    if (!words.length) return true;
    const haystack = [record.name, record.extractedText ?? "", record.collection ?? "", ...record.tags].join("\n").toLowerCase();
    return words.every((word) => haystack.includes(word));
  }).sort((a, b) => {
    const av = typeof a[sortBy] === "string" ? (a[sortBy] as string).toLowerCase() : a[sortBy];
    const bv = typeof b[sortBy] === "string" ? (b[sortBy] as string).toLowerCase() : b[sortBy];
    return direction * compare(av, bv) || compare(a.id, b.id);
  }).map(cloneRecord);
}
