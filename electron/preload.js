const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  openFile: () => ipcRenderer.invoke("open-file"),
  openFilePath: (path) => ipcRenderer.invoke("open-file-path", path),
  getInitialFile: () => ipcRenderer.invoke("get-initial-file"),
  exportPDF: (html) => ipcRenderer.invoke("export-pdf", html),
  exportHTML: (args) => ipcRenderer.invoke("export-html", args),
  saveFile: (args) => ipcRenderer.invoke("save-file", args),
  saveFileAs: (args) => ipcRenderer.invoke("save-file-as", args),
  renameFile: (args) => ipcRenderer.invoke("rename-file", args),
  onMenuOpenFile: (callback) =>
    ipcRenderer.on("menu-open-file", () => callback()),
  onMenuExportPDF: (callback) =>
    ipcRenderer.on("menu-export-pdf", (_event, theme) => callback(theme)),
  onMenuExportHTML: (callback) =>
    ipcRenderer.on("menu-export-html", () => callback()),
  onMenuSave: (callback) => ipcRenderer.on("menu-save", () => callback()),
  onMenuSaveAs: (callback) => ipcRenderer.on("menu-save-as", () => callback()),
  onMenuFork: (callback) => ipcRenderer.on("menu-fork", () => callback()),
  onMenuFormatTables: (callback) =>
    ipcRenderer.on("menu-format-tables", () => callback()),
  onMenuCommandPalette: (callback) =>
    ipcRenderer.on("menu-command-palette", () => callback()),
  onMenuShortcuts: (callback) =>
    ipcRenderer.on("menu-shortcuts", () => callback()),
  onMenuTheme: (callback) => ipcRenderer.on("menu-theme", () => callback()),
  onSetMode: (callback) =>
    ipcRenderer.on("set-mode", (_event, mode) => callback(mode)),
  onToggleStats: (callback) =>
    ipcRenderer.on("toggle-stats", () => callback()),
  onFileOpened: (callback) =>
    ipcRenderer.on("file-opened", (_event, data) => callback(data)),
});
