const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Subscribe to an IPC channel and return an unsubscribe function, so the
// renderer can detach on cleanup. Without this, listeners accumulate on the
// long-lived ipcRenderer across HMR/StrictMode/remounts and a single menu
// action fires N times.
function subscribe(channel, callback, map) {
  const handler = (_event, ...args) =>
    map ? callback(map(...args)) : callback();
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  openFile: () => ipcRenderer.invoke("open-file"),
  openFilePath: (path) => ipcRenderer.invoke("open-file-path", path),
  // Electron 32+ removed File.path; resolve a dropped File to its disk path.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  setDefaultMarkdownApp: () => ipcRenderer.invoke("set-default-md"),
  defaultMarkdownStatus: () => ipcRenderer.invoke("default-md-status"),
  // Workspace / Files view
  wsRoots: () => ipcRenderer.invoke("ws-roots"),
  wsDefaultPath: () => ipcRenderer.invoke("ws-default-path"),
  wsCreateDefault: () => ipcRenderer.invoke("ws-create-default"),
  wsAddRoot: () => ipcRenderer.invoke("ws-add-root"),
  wsRemoveRoot: (p) => ipcRenderer.invoke("ws-remove-root", p),
  wsListDir: (p) => ipcRenderer.invoke("ws-list-dir", p),
  wsMkdir: (parent, name) => ipcRenderer.invoke("ws-mkdir", { parent, name }),
  wsNewFile: (parent, name) => ipcRenderer.invoke("ws-new-file", { parent, name }),
  wsMove: (src, destDir) => ipcRenderer.invoke("ws-move", { src, destDir }),
  wsRename: (target, newName) => ipcRenderer.invoke("ws-rename", { target, newName }),
  wsTrash: (target) => ipcRenderer.invoke("ws-trash", target),
  wsReveal: (target) => ipcRenderer.invoke("ws-reveal", target),
  // Browse — device-wide markdown index
  mdIndexScan: () => ipcRenderer.invoke("mdindex-scan"),
  mdIndexRefresh: () => ipcRenderer.invoke("mdindex-refresh"),
  mdIndexStars: () => ipcRenderer.invoke("mdindex-stars"),
  mdIndexToggleStar: (path, kind) =>
    ipcRenderer.invoke("mdindex-star-toggle", { path, kind }),
  onMdIndexUpdated: (callback) =>
    subscribe("mdindex-updated", callback, (info) => info),
  mcpInfo: () => ipcRenderer.invoke("mcp-info"),
  getInitialFile: () => ipcRenderer.invoke("get-initial-file"),
  exportPDF: (html) => ipcRenderer.invoke("export-pdf", html),
  exportHTML: (args) => ipcRenderer.invoke("export-html", args),
  saveFile: (args) => ipcRenderer.invoke("save-file", args),
  saveFileAs: (args) => ipcRenderer.invoke("save-file-as", args),
  renameFile: (args) => ipcRenderer.invoke("rename-file", args),
  onMenuOpenFile: (callback) => subscribe("menu-open-file", callback),
  onMenuExportPDF: (callback) =>
    subscribe("menu-export-pdf", callback, (theme) => theme),
  onMenuExportHTML: (callback) => subscribe("menu-export-html", callback),
  onMenuSave: (callback) => subscribe("menu-save", callback),
  onMenuSaveAs: (callback) => subscribe("menu-save-as", callback),
  onMenuFork: (callback) => subscribe("menu-fork", callback),
  onMenuFormatTables: (callback) => subscribe("menu-format-tables", callback),
  onMenuCommandPalette: (callback) =>
    subscribe("menu-command-palette", callback),
  onMenuShortcuts: (callback) => subscribe("menu-shortcuts", callback),
  onMenuTheme: (callback) => subscribe("menu-theme", callback),
  onMenuSettings: (callback) => subscribe("menu-settings", callback),
  onDeepLink: (callback) => subscribe("deep-link", callback, (url) => url),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  syncConfig: (cfg) => ipcRenderer.invoke("sync-config", cfg),
  registryTrack: (args) => ipcRenderer.invoke("registry-track", args),
  registryGet: (path) => ipcRenderer.invoke("registry-get", path),
  libraryState: () => ipcRenderer.invoke("library-state"),
  docSyncOn: (args) => ipcRenderer.invoke("doc-sync-on", args),
  docSyncOff: (args) => ipcRenderer.invoke("doc-sync-off", args),
  docPush: (args) => ipcRenderer.invoke("doc-push", args),
  docResolve: (args) => ipcRenderer.invoke("doc-resolve", args),
  docPull: (args) => ipcRenderer.invoke("doc-pull", args),
  docOpenShared: (args) => ipcRenderer.invoke("doc-open-shared", args),
  onMenuLibrary: (callback) => subscribe("menu-library", callback),
  onSetMode: (callback) => subscribe("set-mode", callback, (mode) => mode),
  onToggleStats: (callback) => subscribe("toggle-stats", callback),
  onFileOpened: (callback) =>
    subscribe("file-opened", callback, (data) => data),
  // Terminal
  termAvailable: () => ipcRenderer.invoke("term-available"),
  termCreate: (cwd) => ipcRenderer.invoke("term-create", { cwd }),
  termWrite: (id, data) => ipcRenderer.invoke("term-write", { id, data }),
  termResize: (id, cols, rows) => ipcRenderer.invoke("term-resize", { id, cols, rows }),
  termKill: (id) => ipcRenderer.invoke("term-kill", id),
  onTermData: (callback) => subscribe("term-data", callback, (p) => p),
  onTermExit: (callback) => subscribe("term-exit", callback, (p) => p),
  termExternalApps: () => ipcRenderer.invoke("term-external-apps"),
  termOpenExternal: (app, cwd) => ipcRenderer.invoke("term-open-external", { app, cwd }),
  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  updateStatus: () => ipcRenderer.invoke("update-status"),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  onUpdateAvailable: (callback) =>
    subscribe("update-available", callback, (info) => info),
  onUpdateProgress: (callback) =>
    subscribe("update-progress", callback, (info) => info),
  onUpdateReady: (callback) =>
    subscribe("update-ready", callback, (info) => info),
});
