export interface FilePayload {
  name: string;
  content: string;
  path: string;
}

export interface SaveResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  name?: string;
  error?: string;
}

export type ViewMode = "edit" | "preview" | "split";

export interface ElectronAPI {
  platform: string;
  openFile(): Promise<FilePayload | null>;
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
  termCreate(cwd: string | null): Promise<string | null>;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termKill(id: string): Promise<void>;
  onTermData(cb: (p: { id: string; data: string }) => void): Unsubscribe;
  onTermExit(cb: (p: { id: string }) => void): Unsubscribe;
  termExternalApps(): Promise<Array<{ id: string; name: string }>>;
  termOpenExternal(app: string, cwd: string | null): Promise<WsResult>;
  getInitialFile(): Promise<FilePayload | null>;
  exportPDF(html: string): Promise<{ success: boolean; path?: string }>;
  exportHTML(args: { defaultName: string; html: string }): Promise<SaveResult>;
  saveFile(args: { filePath: string; content: string }): Promise<SaveResult>;
  saveFileAs(args: { defaultName: string; content: string }): Promise<SaveResult>;
  renameFile(args: { oldPath: string; newName: string }): Promise<SaveResult>;
  // Each onX subscribes and returns an unsubscribe function.
  onMenuOpenFile(cb: () => void): Unsubscribe;
  onMenuExportPDF(cb: (theme: "dark" | "light") => void): Unsubscribe;
  onMenuExportHTML(cb: () => void): Unsubscribe;
  onMenuSave(cb: () => void): Unsubscribe;
  onMenuSaveAs(cb: () => void): Unsubscribe;
  onMenuFork(cb: () => void): Unsubscribe;
  onMenuFormatTables(cb: () => void): Unsubscribe;
  onMenuCommandPalette(cb: () => void): Unsubscribe;
  onMenuShortcuts(cb: () => void): Unsubscribe;
  onMenuTheme(cb: () => void): Unsubscribe;
  onMenuSettings(cb: () => void): Unsubscribe;
  onMenuLibrary(cb: () => void): Unsubscribe;
  onDeepLink(cb: (url: string) => void): Unsubscribe;
  openExternal(url: string): Promise<void>;
  syncConfig(cfg: { token: string | null; serverURL: string }): Promise<void>;
  registryTrack(args: {
    path: string;
    name: string;
    content?: string;
  }): Promise<{ ok?: boolean; error?: string }>;
  registryGet(path: string): Promise<RegistryEntry | null>;
  libraryState(): Promise<{ signedIn: boolean; items: LibraryItem[] }>;
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
  // open a shared cloud doc by saving it to ~/Downloads and opening it (no dialog)
  docOpenShared?(args: {
    cloudId: string;
    suggestedName: string;
  }): Promise<{ ok?: boolean; path?: string; error?: string }>;
  onSetMode(cb: (mode: ViewMode) => void): Unsubscribe;
  onToggleStats(cb: () => void): Unsubscribe;
  onFileOpened(cb: (data: FilePayload) => void): Unsubscribe;
  // Auto-update
  checkForUpdates(): Promise<{ ok: boolean; reason?: string }>;
  updateStatus(): Promise<string>;
  quitAndInstall(): Promise<void>;
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
  onMdIndexUpdated?(cb: (info: { scannedAt: string | null }) => void): Unsubscribe;
  // Markie MCP server location, for the Agents setup dialog
  mcpInfo?(): Promise<{ serverPath: string; packaged: boolean }>;
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
}

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
}

export interface LibraryItem {
  kind: "local" | "cloud-only" | "shared";
  path: string | null;
  name: string;
  cloudId: string | null;
  state:
    | "local-only"
    | "synced"
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
}

export function getElectronAPI(): ElectronAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}
