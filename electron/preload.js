const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openFile: () => ipcRenderer.invoke("open-file"),
  openFilePath: (path) => ipcRenderer.invoke("open-file-path", path),
  exportPDF: (html) => ipcRenderer.invoke("export-pdf", html),
  onMenuOpenFile: (callback) =>
    ipcRenderer.on("menu-open-file", () => callback()),
  onMenuExportPDF: (callback) =>
    ipcRenderer.on("menu-export-pdf", () => callback()),
  onSetMode: (callback) =>
    ipcRenderer.on("set-mode", (_event, mode) => callback(mode)),
  onFileOpened: (callback) =>
    ipcRenderer.on("file-opened", (_event, data) => callback(data)),
});
