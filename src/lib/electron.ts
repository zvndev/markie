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
  onSetMode(cb: (mode: ViewMode) => void): void;
  onToggleStats(cb: () => void): void;
  onFileOpened(cb: (data: FilePayload) => void): void;
}

export function getElectronAPI(): ElectronAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}
