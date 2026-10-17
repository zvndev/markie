import { describe, expect, it } from "vitest";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY, compareLibraryDocuments, libraryDocumentFormat, matchesLibraryDocument, queryLibraryDocuments, type LibraryDocumentMetadata, type LibraryDocumentQuery } from "./library-document-query";

const base: LibraryDocumentMetadata = { key: "recovery:word", name: "Proposal.docx", format: "docx", updatedAt: 10, extractedText: "Distinctive project brief", tags: ["client"], collection: "Launch" };
const query = (overrides: Partial<LibraryDocumentQuery> = {}): LibraryDocumentQuery => ({ ...DEFAULT_LIBRARY_DOCUMENT_QUERY, ...overrides });

describe("ordinary Library presentation queries", () => {
  it.each(["PROPOSAL", "distinctive", "client", "Launch", "client brief"])("uses available metadata and words for %s", (search) => {
    expect(matchesLibraryDocument(base, query({ search }))).toBe(true);
  });

  it("searches native name/path without inventing body metadata", () => {
    const native: LibraryDocumentMetadata = { key: "native:/projects/notes.md", name: "notes.md", path: "/projects/notes.md", format: "markdown" };
    expect(matchesLibraryDocument(native, query({ search: "PROJECTS notes" }))).toBe(true);
    expect(matchesLibraryDocument(native, query({ search: "distinctive" }))).toBe(false);
    expect(matchesLibraryDocument({ key: "empty", name: "", format: "other" }, query({ search: "x" }))).toBe(false);
  });

  it("filters exact kind, not matching substrings in names or content", () => {
    expect(matchesLibraryDocument(base, query({ format: "doc" }))).toBe(false);
    expect(matchesLibraryDocument(base, query({ format: "docx" }))).toBe(true);
    expect(matchesLibraryDocument(base, query({ search: "unmatched", format: "docx" }))).toBe(false);
  });

  it.each([
    ["NOTE.MDX", "markdown"], ["note.markdown", "markdown"], ["note.LOG", "text"], ["data.YML", "yaml"],
    ["data.JSON", "json"], ["data.csv", "csv"], ["data.xml", "xml"], ["word.DOC", "doc"], ["word.docx", "docx"],
    ["word.docx.zip", "other"], ["archive.rtf", "other"], ["page.html", "other"], ["open.odt", "other"], ["", "other"],
  ])("classifies %s with the existing filename classifier", (name, format) => expect(libraryDocumentFormat(name)).toBe(format));

  it("preserves default source order, row objects and input arrays", () => {
    const rows = Object.freeze([Object.freeze({ ...base, key: "native:a" }), Object.freeze({ ...base, key: "recovery:a" })]);
    const result = queryLibraryDocuments(rows, query(), (row) => row);
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
    expect(result[0]).toBe(rows[0]);
    expect(compareLibraryDocuments(rows[0], rows[1], "default")).toBe(0);
  });

  it("sorts recent timestamps with invalid and missing values last and deterministic ties", () => {
    const rows = [
      { ...base, key: "z", updatedAt: "not a date" }, { ...base, key: "b", updatedAt: null },
      { ...base, key: "a", updatedAt: Number.NaN }, { ...base, key: "recent", updatedAt: "2026-10-17T00:00:00Z" },
      { ...base, key: "old", updatedAt: 1 }, { ...base, key: "negative", updatedAt: -1 },
    ];
    const result = queryLibraryDocuments(rows, query({ sort: "recent" }), (row) => row);
    expect(result.map((row) => row.key)).toEqual(["recent", "old", "a", "b", "negative", "z"]);
    expect(rows[0].key).toBe("z");
  });

  it("sorts type then case-insensitive name then source identity without merging duplicates", () => {
    const rows: LibraryDocumentMetadata[] = [
      { ...base, key: "recovery:a", name: "same.md", format: "markdown" },
      { ...base, key: "native:a", name: "SAME.md", format: "markdown" },
      { ...base, key: "recovery:b", name: "Zebra.docx" },
      { ...base, key: "recovery:c", name: "Alpha.docx" },
    ];
    expect(queryLibraryDocuments(rows, query({ sort: "type" }), (row) => row).map((row) => row.key)).toEqual(["recovery:c", "recovery:b", "native:a", "recovery:a"]);
    expect(queryLibraryDocuments(rows, query({ sort: "name" }), (row) => row).map((row) => row.key)).toEqual(["recovery:c", "native:a", "recovery:a", "recovery:b"]);
  });
});
