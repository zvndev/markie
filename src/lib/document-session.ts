import { classifyDocumentFormat, decodeTextDocument, encodeTextDocument, type DecodedTextDocument } from "./document-formats";
import { createDocx, exportDocx, openDocx, type DocxDocument } from "./office/docx";
import type { LibraryFormat, LibraryRecord } from "./document-library";
import type { WebFileHandle } from "./web-files";

export type EditableDocumentFormat = Exclude<LibraryFormat, "doc">;
export interface DocumentSession {
  readonly id: string;
  readonly epoch: string;
  readonly name: string;
  readonly format: EditableDocumentFormat;
  readonly text: string;
  readonly textMetadata: DecodedTextDocument | null;
  readonly office: DocxDocument | null;
  readonly record: LibraryRecord | null;
  readonly tags: string[];
  readonly collection: string | null;
  readonly generation: number;
  readonly persistedGeneration: number;
  readonly handle?: WebFileHandle;
  readonly externalBaseline?: Uint8Array;
  readonly externalGeneration?: number;
  readonly warnings: readonly string[];
}

/** A textarea/rich editor emits LF. Preserve untouched line separators exactly. */
export function preserveDocumentNewlines(previous: string, edited: string): string {
  const normalized = edited.replace(/\r\n?/g, "\n");
  if (normalized === previous.replace(/\r\n?/g, "\n")) return previous;
  const originalLines = previous.split(/\r\n|\r|\n/);
  const endings = previous.match(/\r\n|\r|\n/g) ?? [];
  const lines = normalized.split("\n");
  const fallback = endings[0] ?? "\n";
  let prefix = 0;
  while (prefix < originalLines.length && prefix < lines.length && originalLines[prefix] === lines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < originalLines.length - prefix && suffix < lines.length - prefix
    && originalLines[originalLines.length - 1 - suffix] === lines[lines.length - 1 - suffix]) suffix++;
  return lines.map((line, index) => {
    if (index === lines.length - 1) return line;
    let originalIndex: number | undefined;
    if (index < prefix) originalIndex = index;
    else if (index >= lines.length - suffix) originalIndex = originalLines.length - (lines.length - index);
    else if (lines.length - prefix - suffix === originalLines.length - prefix - suffix) originalIndex = index;
    return line + (originalIndex === undefined ? fallback : endings[originalIndex] ?? fallback);
  }).join("");
}

export async function openDocumentSession(record: LibraryRecord, handle?: WebFileHandle): Promise<DocumentSession> {
  if (record.format === "doc") throw new Error("Legacy Word files must be converted to a new document before editing.");
  const office = record.format === "docx" ? await openDocx(record.bytes) : null;
  const textMetadata = office ? null : decodeTextDocument(record.bytes);
  return {
    id: record.id, epoch: crypto.randomUUID(), name: record.name, format: record.format, text: office?.text ?? textMetadata!.text,
    textMetadata, office, record, tags: [...record.tags], collection: record.collection,
    generation: 0, persistedGeneration: 0, handle,
    ...(handle ? { externalBaseline: new Uint8Array(record.bytes), externalGeneration: 0 } : {}), warnings: [],
  };
}

export async function createDocumentSession(format: EditableDocumentFormat, name?: string): Promise<DocumentSession> {
  const extension = format === "markdown" ? "md" : format === "text" ? "txt" : format;
  const office = format === "docx" ? await createDocx("") : null;
  return {
    id: crypto.randomUUID(), epoch: crypto.randomUUID(), name: name?.trim() || `Untitled.${extension}`, format, text: "",
    textMetadata: office ? null : { text: "", encoding: "utf-8", bom: false, newline: "none" },
    office, record: null, tags: [], collection: null, generation: 0, persistedGeneration: -1, warnings: [],
  };
}

export function editDocumentText(session: DocumentSession, text: string): DocumentSession {
  if (session.office) throw new Error("Word text must be edited through the document engine.");
  const preserved = preserveDocumentNewlines(session.text, text);
  if (preserved === session.text) return session;
  return { ...session, text: preserved, generation: session.generation + 1 };
}

/** Undo restores an owned exact source snapshot, including mixed separators. */
export function restoreDocumentText(session: DocumentSession, text: string): DocumentSession {
  if (session.office) throw new Error("Word text must be edited through the document engine.");
  encodeTextDocument(text, session.textMetadata ?? {});
  return text === session.text ? session : { ...session, text, generation: session.generation + 1 };
}

export function editOfficeDocument(session: DocumentSession, office: DocxDocument): DocumentSession {
  if (!session.office || !session.office.canEdit) throw new Error("This Word document is read-only.");
  if (session.office === office) return session;
  return { ...session, office, text: office.text, generation: session.generation + 1 };
}

export function editDocumentDetails(session: DocumentSession, update: { name?: string; tags?: string[]; collection?: string | null }): DocumentSession {
  const requested = update.name?.trim();
  const extension = session.name.match(/\.[a-z0-9]+$/i)?.[0] ?? "";
  const name = requested ? (/\.[^./]+$/.test(requested) ? requested : requested + extension) : session.name;
  if (/[\\/\x00-\x1f]/.test(name) || classifyDocumentFormat(name).kind !== session.format) {
    throw new Error("Keep the document's file type when renaming. Format conversion needs a separate export.");
  }
  const tags = update.tags ? [...new Set(update.tags.map((tag) => tag.trim()).filter(Boolean))] : session.tags;
  const collection = update.collection === undefined ? session.collection : update.collection?.trim() || null;
  if (name === session.name && tags.join("\0") === session.tags.join("\0") && collection === session.collection) return session;
  return { ...session, name, tags, collection, generation: session.generation + 1 };
}

export async function serializeDocumentSession(session: DocumentSession): Promise<Uint8Array> {
  return new Uint8Array(session.office ? await exportDocx(session.office) : encodeTextDocument(session.text, session.textMetadata ?? {}));
}

/** A slow save can advance the disk revision without replacing newer edits. */
export function acceptDocumentPersistence(current: DocumentSession, saved: DocumentSession, record: LibraryRecord): DocumentSession {
  if (current.id !== saved.id || current.epoch !== saved.epoch || record.id !== current.id
    || record.revision < (current.record?.revision ?? 0) || saved.generation < current.persistedGeneration) return current;
  return { ...current, record, persistedGeneration: saved.generation };
}

export function documentNeedsRecoverySave(session: DocumentSession): boolean {
  return session.generation !== session.persistedGeneration;
}
