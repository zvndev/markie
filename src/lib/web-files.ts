import {
  classifyDocumentFormat,
  decodeTextDocument,
  DOCUMENT_FILE_ACCEPT,
  type DecodedTextDocument,
  type DocumentFormatInfo,
} from "./document-formats";

/** Structural browser interfaces keep this module independent of Electron. */
export type WebReadableFile = Pick<File, "name" | "size" | "arrayBuffer">;
export type WebWritableFile = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};
export type WebFileHandle = {
  name: string;
  getFile(): Promise<WebReadableFile>;
  createWritable?(): Promise<WebWritableFile>;
};
type PickerWindow = Window & {
  showOpenFilePicker?: (options: { multiple: boolean; types: PickerType[] }) => Promise<WebFileHandle[]>;
  showSaveFilePicker?: (options: { suggestedName: string; types?: PickerType[] }) => Promise<WebFileHandle>;
};
type PickerType = { description: string; accept: Record<string, string[]> };

export type WebDocumentPayload = {
  name: string;
  bytes: Uint8Array;
  format: DocumentFormatInfo;
  text: DecodedTextDocument | null;
  handle?: WebFileHandle;
};
export type WebReadOptions = { maxBytes?: number };
export type WebSaveDocument = { name: string; bytes: Uint8Array; mimeType?: string; handle?: WebFileHandle };
export type WebSaveReceipt =
  | { method: "file-system"; name: string; handle: WebFileHandle }
  // A download launch cannot prove the user saved the file, so it must not
  // clear the original file's dirty state or be used as an autosave receipt.
  | { method: "download"; name: string };

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function browserWindow(): PickerWindow {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Browser file access is not available in this environment.");
  }
  return window as PickerWindow;
}

export function supportsWebFileSystemAccess(): { open: boolean; save: boolean } {
  if (typeof window === "undefined" || !window.isSecureContext) return { open: false, save: false };
  const browser = window as PickerWindow;
  return { open: typeof browser.showOpenFilePicker === "function", save: typeof browser.showSaveFilePicker === "function" };
}

export async function readWebDocument(file: WebReadableFile, options: WebReadOptions = {}): Promise<WebDocumentPayload> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("The document size limit must be a non-negative safe integer.");
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("The document has an invalid file size.");
  if (file.size > maxBytes) throw new Error("This document is too large to open in the browser.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("This document is too large to open in the browser.");
  const format = classifyDocumentFormat(file.name);
  return { name: file.name, bytes, format, text: format.representation === "text" ? decodeTextDocument(bytes) : null };
}

function isPickerCancellation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

/** Call from a user gesture. Cancellation is null; permission/read errors throw. */
export async function pickWebDocument(options: WebReadOptions & { signal?: AbortSignal } = {}): Promise<WebDocumentPayload | null> {
  const browser = browserWindow();
  if (options.signal?.aborted) return null;
  if (supportsWebFileSystemAccess().open) {
    let handles: WebFileHandle[];
    try {
      handles = await browser.showOpenFilePicker!({
        multiple: false,
        types: [{ description: "Documents", accept: { "application/octet-stream": DOCUMENT_FILE_ACCEPT.split(",") } }],
      });
    } catch (error) {
      if (isPickerCancellation(error)) return null;
      throw error;
    }
    if (!handles[0] || options.signal?.aborted) return null;
    const payload = await readWebDocument(await handles[0].getFile(), options);
    return options.signal?.aborted ? null : { ...payload, handle: handles[0] };
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = DOCUMENT_FILE_ACCEPT;
    input.hidden = true;
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      browser.removeEventListener("focus", onFocus);
      options.signal?.removeEventListener("abort", onCancel);
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      input.remove();
    };
    const finish = (file: WebReadableFile | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!file || options.signal?.aborted) { resolve(null); return; }
      readWebDocument(file, options).then((payload) => resolve(options.signal?.aborted ? null : payload), reject);
    };
    const onChange = () => finish(input.files?.[0] ?? null);
    const onCancel = () => finish(null);
    // Older browsers have no cancel event. Their focus event can precede a
    // valid change event, so leave a short grace period before inspecting files.
    const onFocus = () => {
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => finish(input.files?.[0] ?? null), 500);
    };
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    browser.addEventListener("focus", onFocus);
    options.signal?.addEventListener("abort", onCancel, { once: true });
    (document.body ?? document.documentElement).append(input);
    try { input.click(); } catch (error) { settled = true; cleanup(); reject(error); }
  });
}

export function safeWebFileName(name: string): string {
  const basename = name.replace(/\\/g, "/").split("/").pop() ?? "";
  // Remove controls, directional overrides, path separators and Windows device
  // names so a suggested download name cannot disguise its final extension.
  let safe = Array.from(basename).filter((character) => {
    const code = character.codePointAt(0)!;
    return code >= 32 && code !== 127 && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069)
      && !'<>:"|?*'.includes(character);
  }).join("").trim().replace(/[. ]+$/, "");
  if (!safe || /^\.+$/.test(safe)) return "untitled.txt";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  if (Array.from(safe).length > 240) {
    const extension = safe.match(/\.[a-z0-9]{1,16}$/i)?.[0] ?? "";
    safe = Array.from(safe.slice(0, safe.length - extension.length)).slice(0, 240 - extension.length).join("") + extension;
  }
  return safe;
}

function assertMatchingFormat(originalName: string, selectedName: string): void {
  const original = classifyDocumentFormat(originalName);
  const selected = classifyDocumentFormat(selectedName);
  if (original.representation !== selected.representation || (original.representation === "bytes" && original.kind !== selected.kind)) {
    throw new Error("The selected file format needs conversion. Choose a matching extension instead.");
  }
}

function downloadMimeType(document: WebSaveDocument): string {
  const format = classifyDocumentFormat(document.name);
  // Unsupported active formats must download, never become an inline HTML/SVG
  // document. A caller-supplied MIME is only accepted for known safe formats.
  if (format.editing === "unsupported") return "application/octet-stream";
  const mime = document.mimeType ?? format.mimeType;
  return /^(?:text\/(?:plain|markdown|csv)|application\/(?:octet-stream|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))(?:;charset=(?:utf-8|utf-16le|utf-16be))?$/i.test(mime)
    ? mime : format.mimeType;
}

/** Launch a local download without navigation, upload, or a durable-save claim. */
export function downloadWebDocument(documentToSave: WebSaveDocument): WebSaveReceipt {
  browserWindow();
  const name = safeWebFileName(documentToSave.name);
  const blob = new Blob([new Uint8Array(documentToSave.bytes)], { type: downloadMimeType(documentToSave) });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = name;
  anchor.href = url;
  anchor.rel = "noopener noreferrer";
  anchor.hidden = true;
  let launched = false;
  try {
    (document.body ?? document.documentElement).append(anchor);
    anchor.click();
    launched = true;
    return { method: "download", name };
  } finally {
    anchor.remove();
    // Revoking immediately can race Safari consuming the URL. A failed launch
    // has no consumer and can release its bytes immediately.
    if (launched) setTimeout(() => URL.revokeObjectURL(url), 1000);
    else URL.revokeObjectURL(url);
  }
}

/** Save As or an explicitly provided handle. A failed write never downloads. */
export async function saveWebDocument(documentToSave: WebSaveDocument): Promise<WebSaveReceipt | null> {
  const browser = browserWindow();
  const bytes = new Uint8Array(documentToSave.bytes);
  let handle = documentToSave.handle;
  if (!handle) {
    if (!supportsWebFileSystemAccess().save) return downloadWebDocument({ ...documentToSave, bytes });
    const name = safeWebFileName(documentToSave.name);
    const extension = name.match(/\.[a-z0-9]{1,16}$/i)?.[0];
    try {
      handle = await browser.showSaveFilePicker!({
        suggestedName: name,
        ...(extension ? { types: [{ description: "Document", accept: { [downloadMimeType(documentToSave).split(";")[0]]: [extension] } }] } : {}),
      });
    } catch (error) {
      if (isPickerCancellation(error)) return null;
      throw error;
    }
  }
  assertMatchingFormat(documentToSave.name, handle.name);
  if (!handle.createWritable) throw new Error("This browser file handle does not support writing.");
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* Preserve the original write failure. */ }
    throw error;
  }
  return { method: "file-system", name: handle.name, handle };
}
