// Files on this phone: a document or a folder the person picked in the
// system's own picker, read and saved where it is. No account is involved and
// nothing here talks to a server. A local file is never put in the phone's
// store of cloud documents (offline-store.ts), and signing out never touches it.
//
// The native side (ios/App/App/LocalFilesStore.swift and
// android/.../LocalFilesPlugin.java) holds the permissions and does the safe
// writing. This side decides what a file is and what may be written back:
//
//   - Only text is saved in place. A Word, RTF, OpenDocument or HTML file
//     opens as a converted copy, and that text is never written over the
//     original.
//   - A text file is written back in the encoding it came in (UTF-8, with or
//     without a mark, or UTF-16) and with the line endings it had. A file
//     that isn't valid text is refused, never repaired.
//   - A save names the bytes it started from. When the file holds anything
//     else by then, nothing is written and the person is asked.
import { registerPlugin } from "@capacitor/core";
import { classifyDocumentFormat, decodeTextDocument, encodeTextDocument, type TextEncoding } from "@/lib/document-formats";
import type { DocFormat } from "./docs";
import { decodeIncomingFile, IncomingFileError, type IncomingFile } from "./incoming-file";

/** Something the person let Markie use: one file, or a folder and everything in it. */
export interface LocalGrant {
  id: string;
  kind: "file" | "folder";
  name: string;
  /** False when the system took the permission back, or the file or folder is gone. */
  reachable: boolean;
  /** False for a file another app lent until Markie closes. It is not listed afterwards. */
  persisted: boolean;
  usedAt: number;
}

/** One thing in a granted folder. The id means something only to the native side. */
export interface LocalEntry {
  id: string;
  name: string;
  folder: boolean;
  size?: number;
  modified?: number;
}

/** Where a file is: a grant, and inside a folder grant, an entry. */
export interface LocalRef {
  grantId: string;
  entry: string | null;
  /** The folder it sits in, when it came from a folder: where "Keep both" puts the second file. */
  parent?: string | null;
}

/** The native plugin, as both platforms implement it. */
export interface LocalFilesPlugin {
  pickDocument(): Promise<{ grant?: LocalGrant }>;
  pickFolder(): Promise<{ grant?: LocalGrant }>;
  grants(): Promise<{ grants: LocalGrant[] }>;
  forget(options: { grantId: string }): Promise<void>;
  list(options: { grantId: string; entry?: string }): Promise<{ entries: LocalEntry[] }>;
  read(options: { grantId: string; entry?: string }): Promise<{ name: string; data: string; hash: string; writable: boolean; modified?: number }>;
  /** Without baseHash the file is written whatever it holds. */
  write(options: { grantId: string; entry?: string; data: string; baseHash?: string }): Promise<{ hash: string; modified?: number }>;
  create(options: { grantId: string; parent?: string; name: string; data: string }): Promise<{ entry: LocalEntry }>;
  adopt(options: { url: string }): Promise<{ grant?: LocalGrant; name?: string }>;
}

export const NativeLocalFiles = registerPlugin<LocalFilesPlugin>("MarkieLocalFiles");

export type LocalFileErrorCode = "changed" | "missing" | "unreachable" | "too-large" | "read-only" | "not-text" | "failed";

export class LocalFileError extends Error {
  readonly code: LocalFileErrorCode;
  constructor(code: LocalFileErrorCode, message: string) {
    super(message);
    this.name = "LocalFileError";
    this.code = code;
  }
}

/** What a text file was made of, so it is written back the same way. */
interface TextShape {
  hash: string;
  encoding: TextEncoding;
  bom: boolean;
  /** Its lines ended in CR LF. The editor works in LF; they are put back on save. */
  crlf: boolean;
}

/** A local file, open. `content` is what the reader and the editor show. */
export interface LocalDocument {
  ref: LocalRef;
  /** The file's own name on the device. */
  name: string;
  /** The name a copy would take in Markie Cloud (a converted file changes extension). */
  cloudName: string;
  format: DocFormat;
  content: string;
  /** Set when the text is a conversion of a Word, RTF, OpenDocument or HTML file. */
  convertedFrom: string | null;
  /** Null when the file can't be saved in place: `readOnly` says why. */
  shape: TextShape | null;
  readOnly: "converted" | "not-writable" | null;
}

const MESSAGES: Record<string, string> = {
  changed: "This file changed since you opened it.",
  missing: "This file was moved or deleted.",
  unreachable: "Markie can't reach this file any more.",
  "too-large": "This file is too large to open on a phone.",
  exists: "A file with that name is already there.",
};

function asLocalError(error: unknown, fallback: string): LocalFileError {
  if (error instanceof LocalFileError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "changed" || code === "missing" || code === "unreachable" || code === "too-large") return new LocalFileError(code, MESSAGES[code]);
  // A path outside the grant is a grant that can't be used for it.
  if (code === "outside") return new LocalFileError("unreachable", MESSAGES.unreachable);
  const message = error instanceof Error && error.message && code === "failed" ? error.message : fallback;
  return new LocalFileError("failed", message);
}

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The kinds a folder lists: what the app reads as text, and what it turns into text. */
export function isOpenableName(name: string): boolean {
  if (classifyDocumentFormat(name).kind !== "unsupported") return true;
  return /\.(tsv|toml|ini)$/i.test(name);
}

/** Turns the bytes of a local file into a document. Throws LocalFileError for anything that isn't one. */
export async function decodeLocalFile(ref: LocalRef, name: string, bytes: Uint8Array, hash: string, writable: boolean): Promise<LocalDocument> {
  let file: IncomingFile;
  try {
    // The same reader as a file from another app, so the same things are refused.
    file = await decodeIncomingFile(name, bytes);
  } catch (error) {
    if (error instanceof IncomingFileError) throw new LocalFileError("not-text", error.message);
    throw new LocalFileError("failed", "Markie couldn't read that file.");
  }
  const base = { ref, name, cloudName: file.name, format: file.format, convertedFrom: file.convertedFrom };
  if (file.convertedFrom) return { ...base, content: file.content, shape: null, readOnly: "converted" };
  const decoded = decodeTextDocument(bytes);
  const crlf = decoded.newline === "crlf";
  return {
    ...base,
    content: crlf ? decoded.text.replace(/\r\n/g, "\n") : decoded.text,
    shape: writable ? { hash, encoding: decoded.encoding, bom: decoded.bom, crlf } : null,
    readOnly: writable ? null : "not-writable",
  };
}

/** The bytes a save writes: the text, in the file's own encoding and line endings. */
export function encodeLocalText(text: string, shape: Pick<TextShape, "encoding" | "bom" | "crlf">): Uint8Array {
  const lines = shape.crlf ? text.replace(/\r\n|\r|\n/g, "\r\n") : text;
  return encodeTextDocument(lines, { encoding: shape.encoding, bom: shape.bom });
}

/** "Plan.md" beside itself: "Plan (my version).md", then "(my version 2)". Never a name that is taken. */
export function besideName(name: string, taken: (candidate: string) => boolean): string | null {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 1000; n += 1) {
    const candidate = `${stem}${n === 0 ? " (my version)" : ` (my version ${n + 1})`}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return null;
}

export interface LocalFiles {
  /** The system's file picker. Null when the person backed out. */
  pickDocument(): Promise<LocalGrant | null>;
  pickFolder(): Promise<LocalGrant | null>;
  /** Everything granted, most recently used first, each marked reachable or not. */
  grants(): Promise<LocalGrant[]>;
  forget(grantId: string): Promise<void>;
  /** A granted folder's subfolders and documents: folders first, then by name. */
  list(grantId: string, entry: string | null): Promise<LocalEntry[]>;
  open(ref: LocalRef): Promise<LocalDocument>;
  /**
   * Writes the text back to the file and returns the document as it now
   * stands. Throws "changed" when the file no longer holds what was opened,
   * unless `overwrite` says the person chose to write over it.
   */
  save(doc: LocalDocument, text: string, options?: { overwrite?: boolean }): Promise<LocalDocument>;
  /** Saves the text as a new file next to the document. Only in a folder. */
  saveBeside(doc: LocalDocument, text: string): Promise<{ name: string }>;
  /** A file URL another app opened in Markie: the grant to edit it in place, or just its name. */
  adopt(url: string): Promise<{ grant: LocalGrant | null; name: string | null }>;
}

export function createLocalFiles(plugin: LocalFilesPlugin): LocalFiles {
  const ref = (grantId: string, entry: string | null) => (entry === null ? { grantId } : { grantId, entry });

  const files: LocalFiles = {
    async pickDocument() {
      try {
        return (await plugin.pickDocument()).grant ?? null;
      } catch (error) {
        throw asLocalError(error, "Markie couldn't open that file.");
      }
    },

    async pickFolder() {
      try {
        return (await plugin.pickFolder()).grant ?? null;
      } catch (error) {
        throw asLocalError(error, "Markie couldn't open that folder.");
      }
    },

    async grants() {
      const { grants } = await plugin.grants();
      return [...grants].sort((a, b) => b.usedAt - a.usedAt);
    },

    forget: (grantId) => plugin.forget({ grantId }),

    async list(grantId, entry) {
      let entries: LocalEntry[];
      try {
        entries = (await plugin.list(ref(grantId, entry))).entries;
      } catch (error) {
        throw asLocalError(error, "Markie couldn't read that folder.");
      }
      return entries
        .filter((item) => item.folder || isOpenableName(item.name))
        .sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.folder ? -1 : 1));
    },

    async open(where) {
      let read: Awaited<ReturnType<LocalFilesPlugin["read"]>>;
      try {
        read = await plugin.read(ref(where.grantId, where.entry));
      } catch (error) {
        throw asLocalError(error, "Markie couldn't read that file.");
      }
      return decodeLocalFile(where, read.name, base64ToBytes(read.data), read.hash, read.writable);
    },

    async save(doc, text, { overwrite = false } = {}) {
      if (!doc.shape) throw new LocalFileError("read-only", doc.readOnly === "converted" ? "This is a converted copy. It can't be saved over the original." : "This file is read-only here.");
      let bytes: Uint8Array;
      try {
        bytes = encodeLocalText(text, doc.shape);
      } catch (error) {
        throw new LocalFileError("failed", error instanceof Error ? error.message : "This text can't be saved to the file.");
      }
      try {
        const written = await plugin.write({ ...ref(doc.ref.grantId, doc.ref.entry), data: bytesToBase64(bytes), ...(overwrite ? {} : { baseHash: doc.shape.hash }) });
        return { ...doc, content: text, shape: { ...doc.shape, hash: written.hash } };
      } catch (error) {
        throw asLocalError(error, "Couldn't save. Your text is still here.");
      }
    },

    async saveBeside(doc, text) {
      if (doc.ref.entry === null || doc.ref.parent === undefined) throw new LocalFileError("failed", "This file was opened on its own, so there is no folder to put a second file in.");
      const parent = doc.ref.parent;
      const shape = doc.shape ?? { encoding: "utf-8" as const, bom: false, crlf: false };
      try {
        const taken = new Set((await plugin.list(ref(doc.ref.grantId, parent))).entries.map((item) => item.name.toLowerCase()));
        const name = besideName(doc.name, (candidate) => taken.has(candidate.toLowerCase()));
        if (!name) throw new LocalFileError("failed", "Couldn't find an unused name for the second file.");
        const made = await plugin.create({ grantId: doc.ref.grantId, ...(parent === null ? {} : { parent }), name, data: bytesToBase64(encodeLocalText(text, shape)) });
        return { name: made.entry.name };
      } catch (error) {
        throw asLocalError(error, "Couldn't save the second file. Your text is still here.");
      }
    },

    async adopt(url) {
      try {
        const result = await plugin.adopt({ url });
        return { grant: result.grant ?? null, name: result.name ?? null };
      } catch {
        return { grant: null, name: null };
      }
    },
  };
  return files;
}
