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
  getInitialFile(): Promise<FilePayload | null>;
  exportPDF(html: string): Promise<{ success: boolean; path?: string }>;
  exportHTML(args: { defaultName: string; html: string }): Promise<SaveResult>;
  saveFile(args: { filePath: string; content: string }): Promise<SaveResult>;
  saveFileAs(args: { defaultName: string; content: string }): Promise<SaveResult>;
  renameFile(args: { oldPath: string; newName: string }): Promise<SaveResult>;
  onMenuOpenFile(cb: () => void): void;
  onMenuExportPDF(cb: (theme: "dark" | "light") => void): void;
  onMenuExportHTML(cb: () => void): void;
  onMenuSave(cb: () => void): void;
  onMenuSaveAs(cb: () => void): void;
  onMenuFork(cb: () => void): void;
  onMenuFormatTables(cb: () => void): void;
  onMenuCommandPalette(cb: () => void): void;
  onMenuShortcuts(cb: () => void): void;
  onMenuTheme(cb: () => void): void;
  onMenuSettings(cb: () => void): void;
  onMenuLibrary(cb: () => void): void;
  onDeepLink(cb: (url: string) => void): void;
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
  onSetMode(cb: (mode: ViewMode) => void): void;
  onToggleStats(cb: () => void): void;
  onFileOpened(cb: (data: FilePayload) => void): void;
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
  kind: "local" | "cloud-only";
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
