export interface FilePayload {
  name: string;
  content: string;
  path: string;
  // The content is a buffer, not what is on disk: "Revert to Snapshot…" hands
  // back an older version of the file that is already open. The document keeps
  // its path and stays unsaved until the user saves it.
  unsaved?: boolean;
}

export interface SaveResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  name?: string;
  error?: string;
  // true when the chosen path ended in .csv and the CSV form was written.
  wroteCsv?: boolean;
  // "reloaded": the file changed on disk since Markie read it and the user
  // chose the disk copy over their own edits. `content` carries that copy.
  // "disk-changed": the same collision, found by an autosave, which never puts
  // a dialog in front of anyone. `content` carries the newer disk copy so the
  // renderer can raise its own strip. Nothing was written.
  code?: "reloaded" | "disk-changed";
  content?: string;
}

export type ViewMode = "edit" | "preview" | "split";

export interface TerminalContext {
  cwd: string | null;
  filePath?: string | null;
}

export interface ElectronAPI {
  platform: string;
  openFile(args?: { near?: string | null }): Promise<FilePayload | null>;
  openFilePath(path: string): Promise<FilePayload | null>;
  // resolve a dropped File to its on-disk path (Electron webUtils)
  pathForFile(file: File): string | null;
  // make Markie the default app for .md files (macOS)
  setDefaultMarkdownApp(): Promise<{ ok: boolean; error?: string }>;
  // whether Markie is already the default .md handler (macOS, packaged only)
  defaultMarkdownStatus(): Promise<{ supported: boolean; isDefault: boolean }>;
  // Workspace / Files view
  wsRoots(): Promise<string[]>;
  wsDefaultPath(): Promise<string>;
  wsCreateDefault(): Promise<{ ok?: boolean; path?: string; error?: string }>;
  wsAddRoot(): Promise<{ ok?: boolean; path?: string; canceled?: boolean; error?: string }>;
  wsRemoveRoot(p: string): Promise<{ ok?: boolean; error?: string }>;
  wsListDir(p: string): Promise<WsListing | { error: string }>;
  wsMkdir(parent: string, name: string): Promise<WsResult>;
  wsNewFile(parent: string, name: string): Promise<WsResult>;
  wsMove(src: string, destDir: string): Promise<WsResult>;
  wsRename(target: string, newName: string): Promise<WsResult>;
  wsTrash(target: string): Promise<WsResult>;
  wsReveal(target: string): Promise<WsResult>;
  // Terminal
  termAvailable(): Promise<boolean>;
  termCreate(context: TerminalContext): Promise<string | null>;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termKill(id: string): Promise<void>;
  onTermData(cb: (p: { id: string; data: string }) => void): Unsubscribe;
  onTermExit(cb: (p: { id: string }) => void): Unsubscribe;
  termExternalApps(): Promise<Array<{ id: string; name: string }>>;
  termOpenExternal(app: string, cwd: string | null): Promise<WsResult>;
  getInitialFile(): Promise<FilePayload | null>;
  // `success: false` with a reason is a real outcome here: the print can time
  // out, another export can already hold the hidden window, or the save sheet
  // can be dismissed. Callers must read it.
  // `docPath` lets main inline the document folder's images before rendering,
  // and `mode: "print"` runs the system print sheet off the same hidden window
  // instead of writing a PDF. The plain string form is the older payload.
  exportPDF(
    args:
      | string
      | {
          html: string;
          theme?: "dark" | "light";
          docPath?: string | null;
          mode?: "pdf" | "print";
        }
  ): Promise<{
    success: boolean;
    path?: string;
    error?: string;
    canceled?: boolean;
    printed?: boolean;
  }>;
  exportHTML(args: {
    defaultName: string;
    html: string;
    docPath?: string | null;
  }): Promise<SaveResult>;
  saveFile(args: {
    filePath: string;
    content: string;
    /** The user already resolved a disk conflict; do not ask them again. */
    force?: boolean;
    /** Nobody asked for this write: never dialog, and refuse over a changed disk. */
    autosave?: boolean;
  }): Promise<SaveResult>;
  // `csvContent` lets a table document hand over both forms at once; main
  // picks by the extension the user chose and reports which one it wrote.
  saveFileAs(args: {
    defaultName: string;
    content: string;
    csvContent?: string;
  }): Promise<SaveResult>;
  renameFile(args: { oldPath: string; newName: string }): Promise<SaveResult>;
  revealFile(path: string): Promise<{ ok?: boolean; error?: string }>;
  // Each onX subscribes and returns an unsubscribe function.
  onMenuOpenFile(cb: () => void): Unsubscribe;
  onMenuNewFile(cb: () => void): Unsubscribe;
  onMenuExportPDF(cb: (theme: "dark" | "light") => void): Unsubscribe;
  onMenuExportHTML(cb: () => void): Unsubscribe;
  onMenuSave(cb: () => void): Unsubscribe;
  onMenuSaveAs(cb: () => void): Unsubscribe;
  onMenuFork(cb: () => void): Unsubscribe;
  onMenuReveal(cb: () => void): Unsubscribe;
  onMenuFormatTables(cb: () => void): Unsubscribe;
  onMenuFind(cb: () => void): Unsubscribe;
  onMenuPrint(cb: () => void): Unsubscribe;
  // -1 out, +1 in, 0 back to 100%
  onMenuZoom(cb: (step: number) => void): Unsubscribe;
  onMenuUndo(cb: () => void): Unsubscribe;
  onMenuRedo(cb: () => void): Unsubscribe;
  onMenuFindReplace(cb: () => void): Unsubscribe;
  onMenuCommandPalette(cb: () => void): Unsubscribe;
  onMenuShortcuts(cb: () => void): Unsubscribe;
  onMenuTheme(cb: () => void): Unsubscribe;
  onMenuSettings(cb: () => void): Unsubscribe;
  onMenuLibrary(cb: () => void): Unsubscribe;
  onDeepLink(cb: (url: string) => void): Unsubscribe;
  openExternal(url: string): Promise<void>;
  syncConfig(cfg: { token: string | null; serverURL: string }): Promise<void>;
  // Hand the sync engine the share role the renderer resolved for a cloud doc,
  // so a push it cannot land is refused here instead of coming back as a 403.
  syncDocRole?(args: {
    cloudId: string;
    role: "owner" | "editor" | "viewer";
  }): Promise<void>;
  registryTrack(args: {
    path: string;
    name: string;
    content?: string;
  }): Promise<{ ok?: boolean; error?: string }>;
  registryGet(path: string): Promise<RegistryEntry | null>;
  // Remember a server-confirmed share role so an offline launch can honour it.
  registrySetRole?(args: { path: string; role: "owner" | "editor" | "viewer" }): Promise<{ ok?: boolean; error?: string }>;
  // A failure answers the same shape with an empty list and `error`, so a
  // caller that maps over `items` never meets `undefined`.
  libraryState(): Promise<{
    signedIn: boolean;
    items: LibraryItem[];
    error?: string;
  }>;
  docSyncOn(args: {
    path: string;
    name: string;
    content: string;
  }): Promise<SyncResult>;
  docSyncOff(args: {
    path: string;
    deleteRemote: boolean;
  }): Promise<SyncResult>;
  docPush(args: {
    path: string;
    name: string;
    content: string;
  }): Promise<SyncResult>;
  docResolve(args: {
    path: string;
    strategy: "local" | "cloud";
  }): Promise<SyncResult>;
  docPull(args: {
    cloudId: string;
    suggestedName: string;
  }): Promise<SyncResult>;
  // Retry a failed push for a tracked file the renderer has not opened, so
  // "unpushed" is not a state with a badge and no way out.
  docRetryPush?(args: { path: string }): Promise<SyncResult>;
  // Which tracked files the server is ahead of. One request for all of them.
  docCheckUpdates?(): Promise<{ updates: DocUpdate[]; error?: string }>;
  // The server's copy, for costing a pull before making it.
  docRemoteContent?(args: {
    path: string;
  }): Promise<{ ok?: boolean; error?: string; content?: string; version?: number }>;
  // Save the local version beside the original, then take the server's.
  // `content` is the editor buffer: the unsaved text is what the user means by
  // their version, and what the dialog counted.
  docKeepBoth?(args: { path: string; content?: string }): Promise<SyncResult>;
  // open a shared cloud doc by saving it to ~/Downloads and opening it (no dialog)
  docOpenShared?(args: {
    cloudId: string;
    suggestedName: string;
  }): Promise<{ ok?: boolean; path?: string; error?: string }>;
  onSetMode(cb: (mode: ViewMode) => void): Unsubscribe;
  onToggleStats(cb: () => void): Unsubscribe;
  onFileOpened(cb: (data: FilePayload) => void): Unsubscribe;
  /** Something else edited the open document. Carries the new on-disk text. */
  onFileChangedOnDisk(
    cb: (data: { path: string; content: string }) => void
  ): Unsubscribe;
  /** Follow this path for external edits (after Save As, or a new document). */
  watchFile(filePath: string | null): Promise<{ ok: boolean } | { error: string } | null>;
  // Main is holding the window open until the renderer answers appCloseReady,
  // capped at two seconds. Everything that must land goes in between.
  onAppWillClose(cb: () => void): Unsubscribe;
  appCloseReady(): void;
  /** Whether crash reports may be sent, and whether a DSN is configured at all. */
  crashConsentGet(): Promise<{ enabled: boolean; available: boolean }>;
  crashConsentSet(
    enabled: boolean
  ): Promise<{ ok: boolean; enabled?: boolean; error?: string }>;
  /** Show the local crash log in the file manager (or say it is empty). */
  crashLogReveal(): Promise<{ ok: boolean }>;
  // Auto-update
  checkForUpdates(): Promise<{ ok: boolean; reason?: string; error?: string }>;
  updateStatus(): Promise<string>;
  /** Whether this install follows the opt-in beta update channel. */
  updateChannelGet(): Promise<{ optedIn: boolean; currentVersion: string }>;
  updateChannelSet(optedIn: boolean): Promise<{
    ok: boolean;
    error?: string;
    optedIn?: boolean;
    channel?: string;
    allowDowngrade?: boolean;
  }>;
  // Resolves only when the install did *not* happen; a successful call takes
  // the process down before it can return.
  // null is the failure answer from main: the install did not start.
  quitAndInstall(): Promise<
    { ok: boolean; reason?: string; error?: string } | void | null
  >;
  onUpdateAvailable(cb: (info: { version?: string }) => void): Unsubscribe;
  onUpdateProgress(cb: (info: { percent: number }) => void): Unsubscribe;
  onUpdateReady(cb: (info: { version?: string }) => void): Unsubscribe;
  // Browse — device-wide markdown index
  mdIndexScan?(): Promise<MdScanResult>;
  mdIndexRefresh?(): Promise<MdScanResult>;
  mdIndexStars?(): Promise<MdStar[]>;
  mdIndexToggleStar?(
    path: string,
    kind: "folder" | "file"
  ): Promise<{ starred: boolean }>;
  // The broadcast carries the scan result itself. A listener that only had the
  // timestamp had to turn around and ask for a fresh scan, which doubled every
  // device-wide walk. `files` stays optional so an older main process (or a
  // notification that only reports the time) still type-checks.
  onMdIndexUpdated?(cb: (info: MdIndexUpdate) => void): Unsubscribe;
  // Markie MCP server location, for the Agents setup dialog
  mcpInfo?(): Promise<{ serverPath: string; packaged: boolean; error?: string }>;
  // Report a renderer crash to the main process's crash log. Fire-and-forget:
  // the caller is an error boundary that has nothing to do with an answer.
  logRendererError?(detail: {
    message: string;
    stack?: string;
    componentStack?: string;
    source?: string;
  }): void;
}

export type Unsubscribe = (() => void) | undefined;

export interface MdRow {
  path: string;
  name: string;
  dir: string;
  mtimeMs: number;
}

export interface MdStar {
  path: string;
  kind: "folder" | "file";
}

export interface MdScanResult {
  files: MdRow[];
  scannedAt: string | null;
  // Present when the scan itself failed; `files` is then empty rather than
  // absent, so callers still have an array to work with.
  error?: string;
  // The walk stopped early (time budget or depth cap), so this is a subset.
  truncated?: boolean;
  truncatedReason?: string | null;
}

// What `mdindex-updated` delivers: a full MdScanResult when main has one,
// otherwise just the timestamp.
export type MdIndexUpdate = Partial<MdScanResult> & { scannedAt: string | null };

export interface WsEntry {
  name: string;
  path: string;
  ext?: string;
}
export interface WsListing {
  folders: WsEntry[];
  files: WsEntry[];
}
export interface WsResult {
  ok?: boolean;
  path?: string;
  error?: string;
}

export interface RegistryEntry {
  path: string;
  name: string;
  content_hash: string | null;
  cloud_doc_id: string | null;
  cloud_version: number | null;
  sync_state: string | null;
  last_opened_at: string | null;
  last_synced_at: string | null;
  // Last role the server confirmed; used when the server is unreachable.
  share_role?: "owner" | "editor" | "viewer" | null;
}

export interface LibraryItem {
  kind: "local" | "cloud-only" | "shared";
  path: string | null;
  name: string;
  cloudId: string | null;
  state:
    | "local-only"
    | "synced"
    // saved to disk, but the server rejected or never received the snapshot
    | "unpushed"
    | "paused"
    | "conflict"
    | "behind"
    | "cloud-only";
  lastOpenedAt: string | null;
  remoteVersion: number | null;
  exists: boolean;
  // shared-with-me info (present when someone invited you to this doc)
  shared?: boolean;
  role?: "viewer" | "editor" | null;
  sharedBy?: string | null;
}

export interface SyncResult {
  ok?: boolean;
  error?: string;
  conflict?: boolean;
  skipped?: string;
  canceled?: boolean;
  deleted?: boolean;
  paused?: boolean;
  reloaded?: boolean;
  pushed?: boolean;
  version?: number;
  path?: string;
  name?: string;
  // The content that landed on disk, so an open buffer can follow a pull
  // instead of pushing the replaced text back on the next save.
  content?: string;
  // Where "keep both" put the local copy.
  keptAt?: string;
}

// A tracked file the server has a newer snapshot of.
export interface DocUpdate {
  path: string;
  cloudId: string;
  name: string;
  localVersion: number;
  remoteVersion: number;
  // "conflict" and "unpushed" mean the file on disk holds changes the server
  // never took. A clean buffer does not make those safe to overwrite.
  syncState: string;
}

export function getElectronAPI(): ElectronAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}

const SAFE = new WeakMap<ElectronAPI, ElectronAPI>();

// Every call here crosses a process boundary, and the main process can refuse,
// throw, or go away mid-call. A rejected invoke() lands as an unhandled
// rejection, which in a React event handler means the click did nothing and
// nothing said so. This wrapper turns any rejection into the `{ error }` shape
// the main-process handlers already return, so a call site has one failure
// shape to handle instead of two. Non-promise members (the onX subscriptions,
// `platform`, `pathForFile`) pass straight through.
export function safeApi(api: ElectronAPI | null): ElectronAPI | null {
  if (!api) return null;
  const cached = SAFE.get(api);
  if (cached) return cached;
  // One wrapper per method, kept for the life of the proxy. Without this, every
  // property read minted a new closure, so `api.saveFile !== api.saveFile` and
  // anything using a method as a hook dependency or a listener identity (an
  // effect's deps array, removeEventListener) silently misbehaved.
  const wrapped = new Map<string | symbol, unknown>();
  // Proxy a plain copy, never `api` itself.
  //
  // contextBridge.exposeInMainWorld defines every property read-only and
  // non-configurable, and a Proxy `get` trap is required to return the target's
  // actual value for such a property. Returning a wrapper threw
  //   TypeError: 'get' on proxy: property 'saveFile' is a read-only and
  //   non-configurable data property on the proxy target
  // on every single method read. The renderer reported that as a failed call,
  // so "Yes, overwrite the file" wrote nothing at all. A shallow copy carries
  // the same methods with writable, configurable descriptors, which is what
  // makes wrapping legal. Calls are still applied to the original.
  const target = { ...api } as ElectronAPI;
  const proxy = new Proxy(target, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      // An onX subscriber returns an unsubscribe function, not a promise, and
      // folding its failure into `{ error }` would hand the caller an object
      // where a cleanup function belongs. Subscriptions pass through.
      if (typeof prop === "string" && /^on[A-Z]/.test(prop)) return value;
      const cached = wrapped.get(prop);
      if (cached) return cached;
      const fn = value as (...args: unknown[]) => unknown;
      const safe = (...args: unknown[]) => {
        const fail = (err: unknown) => {
          console.error(`electronAPI.${String(prop)} failed`, err);
          return {
            error:
              (err as { message?: string } | null)?.message ?? String(err),
          };
        };
        try {
          // `api`, not the copy: contextBridge methods are closures, but the
          // original is the honest receiver.
          const out = fn.apply(api, args);
          if (out && typeof (out as Promise<unknown>).then === "function") {
            return (out as Promise<unknown>).catch(fail);
          }
          return out;
        } catch (err) {
          return fail(err);
        }
      };
      wrapped.set(prop, safe);
      return safe;
    },
  }) as ElectronAPI;
  SAFE.set(api, proxy);
  return proxy;
}

/** getElectronAPI(), with every rejection folded into `{ error }`. */
export function getSafeAPI(): ElectronAPI | null {
  return safeApi(getElectronAPI());
}
