import { classifyDocumentFormat } from "./document-formats";
import { readWebDocument, safeWebFileName, type WebDocumentPayload, type WebFileHandle, type WebReadOptions, type WebSaveDocument, type WebSaveReceipt } from "./web-files";

export interface NativeDocumentDescriptor { leaseId: string; name: string; size: number; lastModified: number; revision: string | null; writable: boolean }
export type NativeDocumentResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface NativeDocumentFileApi {
  open(): Promise<NativeDocumentResult<NativeDocumentDescriptor | null>>;
  saveAs(args: { suggestedName: string }): Promise<NativeDocumentResult<NativeDocumentDescriptor | null>>;
  read(args: { leaseId: string }): Promise<NativeDocumentResult<{ descriptor: NativeDocumentDescriptor; bytes: Uint8Array }>>;
  write(args: { leaseId: string; baseRevision: string | null; bytes: Uint8Array }): Promise<NativeDocumentResult<NativeDocumentDescriptor>>;
  release(args: { leaseId: string }): Promise<NativeDocumentResult<null>>;
  takeInitial(): Promise<NativeDocumentResult<NativeDocumentDescriptor | null>>;
}
export type NativeDocumentCommand = "open" | "save" | "save-as" | "new";
export interface NativeDocumentMenuApi {
  onMenuOpenFile?(callback: () => void): (() => void) | undefined;
  onMenuSave?(callback: () => void): (() => void) | undefined;
  onMenuSaveAs?(callback: () => void): (() => void) | undefined;
  onMenuNewFile?(callback: () => void): (() => void) | undefined;
}
export class NativeDocumentFileError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "NativeDocumentFileError"; }
}
function unwrap<T>(result: NativeDocumentResult<T>): T { if (!result || result.ok !== true) { const error = result && !result.ok ? result.error : undefined; throw new NativeDocumentFileError(typeof error?.code === "string" ? error.code : "io-error", typeof error?.message === "string" ? error.message : "Native document access did not return a valid result."); } return result.value; }
const MAX_BYTES = 32 * 1024 * 1024;
const typedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
function byteArray(value: unknown): value is Uint8Array { try { return ArrayBuffer.isView(value) && typedArrayName?.call(value) === "Uint8Array"; } catch { return false; } }

/** Opaque leases implement just the WebFileHandle subset used by the workspace. */
export function createNativeDocumentFileAdapter(api: NativeDocumentFileApi, menus: NativeDocumentMenuApi = {}) {
  const handles = new Map<WebFileHandle, { descriptor: NativeDocumentDescriptor; released: boolean }>();
  let disposed = false;
  const requireActive = () => { if (disposed) throw new NativeDocumentFileError("closed", "This native file adapter is closed."); };
  const releaseDocument = async (handle: WebFileHandle) => {
    const state = handles.get(handle); if (!state || state.released) return;
    state.released = true; handles.delete(handle); unwrap(await api.release({ leaseId: state.descriptor.leaseId }));
  };
  const makeHandle = (descriptor: NativeDocumentDescriptor): WebFileHandle => {
    const state = { descriptor, released: false };
    const valid = () => { requireActive(); if (state.released) throw new NativeDocumentFileError("closed", "This native file handle was released."); };
    const handle: WebFileHandle = {
      name: descriptor.name,
      async getFile() {
        valid(); const read = unwrap(await api.read({ leaseId: state.descriptor.leaseId })); valid();
        if (!byteArray(read.bytes) || read.bytes.byteLength > MAX_BYTES) throw new NativeDocumentFileError("too-large", "Native document bytes are invalid or exceed 32 MiB.");
        const bytes = new Uint8Array(read.bytes);
        state.descriptor = read.descriptor;
        return { name: read.descriptor.name, size: bytes.length, async arrayBuffer() { return new Uint8Array(bytes).buffer; } };
      },
      ...(descriptor.writable ? { async createWritable() {
        valid(); const baseRevision = state.descriptor.revision, leaseId = state.descriptor.leaseId;
        const chunks: Uint8Array[] = []; let length = 0, phase: "open" | "committing" | "closed" | "aborted" = "open";
        return {
          async write(data: Uint8Array) { valid(); if (phase !== "open") throw new NativeDocumentFileError("closed", "This native writable is no longer open."); if (!byteArray(data) || data.byteLength > MAX_BYTES - length) throw new NativeDocumentFileError("too-large", "Native document bytes are invalid or exceed 32 MiB."); chunks.push(new Uint8Array(data)); length += data.byteLength; },
          async close() {
            valid(); if (phase === "closed") return; if (phase !== "open") throw new NativeDocumentFileError("closed", "This native writable cannot be committed twice."); phase = "committing";
            const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            try { state.descriptor = unwrap(await api.write({ leaseId, baseRevision, bytes })); phase = "closed"; } finally { chunks.length = 0; }
          },
          async abort() { if (phase === "open") { phase = "aborted"; chunks.length = 0; length = 0; } },
        };
      } } : {}),
    };
    handles.set(handle, state); return handle;
  };
  const fromDescriptor = async (descriptor: NativeDocumentDescriptor, options: WebReadOptions & { signal?: AbortSignal } = {}): Promise<WebDocumentPayload | null> => {
    const handle = makeHandle(descriptor);
    try {
      if (options.signal?.aborted || disposed) { await releaseDocument(handle); return null; }
      const result = await readWebDocument(await handle.getFile(), options);
      if (options.signal?.aborted || disposed) { await releaseDocument(handle); return null; }
      return { ...result, handle };
    } catch (error) { try { await releaseDocument(handle); } catch { /* Preserve the read error. */ } throw error; }
  };
  return {
    async pickDocument(options: WebReadOptions & { signal?: AbortSignal } = {}) {
      requireActive(); if (options.signal?.aborted) return null;
      const descriptor = unwrap(await api.open()); return descriptor ? fromDescriptor(descriptor, options) : null;
    },
    async readInitialDocument(options: WebReadOptions & { signal?: AbortSignal } = {}) {
      requireActive(); if (options.signal?.aborted) return null;
      const descriptor = unwrap(await api.takeInitial()); return descriptor ? fromDescriptor(descriptor, options) : null;
    },
    async saveDocument(document: WebSaveDocument): Promise<WebSaveReceipt | null> {
      requireActive(); if (!byteArray(document.bytes) || document.bytes.byteLength > MAX_BYTES) throw new NativeDocumentFileError("too-large", "Native document bytes are invalid or exceed 32 MiB."); const bytes = new Uint8Array(document.bytes);
      let handle = document.handle, created = false;
      if (!handle) { const descriptor = unwrap(await api.saveAs({ suggestedName: safeWebFileName(document.name) })); if (!descriptor) return null; handle = makeHandle(descriptor); created = true; }
      try {
        const original = classifyDocumentFormat(document.name), selected = classifyDocumentFormat(handle.name);
        if (original.representation !== selected.representation || (original.representation === "bytes" && original.kind !== selected.kind)) throw new NativeDocumentFileError("unsupported", "Choose a matching extension or an explicit converted copy.");
        if (!handle.createWritable) throw new NativeDocumentFileError("access-denied", "This native source is read-only. Save a converted copy instead.");
        const writable = await handle.createWritable();
        try { await writable.write(bytes); await writable.close(); } catch (error) { try { await writable.abort?.(); } catch { /* Keep the commit failure. */ } throw error; }
        return { method: "file-system", name: handle.name, handle };
      } catch (error) { if (created) { try { await releaseDocument(handle); } catch { /* Keep the save failure. */ } } throw error; }
    },
    subscribeCommands(listener: (command: NativeDocumentCommand) => void) {
      const cleanups = [menus.onMenuOpenFile?.(() => listener("open")), menus.onMenuSave?.(() => listener("save")), menus.onMenuSaveAs?.(() => listener("save-as")), menus.onMenuNewFile?.(() => listener("new"))];
      return () => { for (const cleanup of cleanups) cleanup?.(); };
    },
    releaseDocument,
    async dispose() { disposed = true; await Promise.allSettled([...handles.keys()].map(releaseDocument)); },
  };
}
