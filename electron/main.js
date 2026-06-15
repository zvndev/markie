const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  net,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const url = require("url");
const { autoUpdater } = require("electron-updater");

const isDev = process.env.NODE_ENV === "development";

// Must run before app ready: gives app:// a real (standard, secure) origin
// so the renderer gets persistent localStorage/IndexedDB in production.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow;
let rendererReady = false;
let pendingFilePath = null;
// markie:// deep link that arrived before the renderer was ready to receive it
let pendingDeepLink = null;

const OPENABLE = /\.(md|markdown|mdx|txt|csv)$/i;

// Deliver a markie:// deep link to the renderer, or queue it if the window
// isn't ready yet (cold start from the OAuth browser hand-off). Always raises
// the window so the user lands back in Markie focused.
function deliverDeepLink(link) {
  if (!link || !link.startsWith("markie://")) return;
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("deep-link", link);
  } else {
    pendingDeepLink = link;
    if (!mainWindow && app.isReady()) createWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function readFilePayload(filePath) {
  try {
    return {
      name: path.basename(filePath),
      content: fs.readFileSync(filePath, "utf-8"),
      path: filePath,
    };
  } catch {
    return null;
  }
}

// File passed as a CLI argument (dev runs, Windows/Linux double-click)
const argFile = process.argv
  .slice(1)
  .find((a) => OPENABLE.test(a) && fs.existsSync(a));
if (argFile) pendingFilePath = path.resolve(argFile);

// markie:// deep link passed as a CLI argument (Windows/Linux cold start)
const argDeepLink = process.argv.slice(1).find((a) => a.startsWith("markie://"));
if (argDeepLink) pendingDeepLink = argDeepLink;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 600,
    minHeight: 400,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Browse: re-scan the markdown index on window focus, debounced to ≥20s, and
  // only after the first open (so we never scan before the user visits Browse).
  mainWindow.on("focus", () => {
    const now = Date.now();
    if (now - _mdLastFocusScan < 20_000) return;
    _mdLastFocusScan = now;
    if (mdindex.getCached()) mdRescanAndNotify();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
    // never leave orphaned shells behind
    try {
      require("./terminal").killAll();
    } catch {
      // terminal module may not have loaded
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadURL("app://markie/index.html");
  }
}

// Register custom protocol to serve static files with proper MIME types
function registerProtocol() {
  protocol.handle("app", (request) => {
    const requestUrl = new URL(request.url);
    // Remove the host part and decode the path
    let filePath = decodeURIComponent(requestUrl.pathname);

    // Resolve to the out directory
    const outDir = path.join(__dirname, "../out");
    const fullPath = path.join(outDir, filePath);

    // If path doesn't exist, try adding .html
    if (!fs.existsSync(fullPath) && !path.extname(fullPath)) {
      const htmlPath = fullPath + ".html";
      if (fs.existsSync(htmlPath)) {
        return net.fetch(url.pathToFileURL(htmlPath).toString());
      }
    }

    // If it's a directory, serve index.html
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      const indexPath = path.join(fullPath, "index.html");
      if (fs.existsSync(indexPath)) {
        return net.fetch(url.pathToFileURL(indexPath).toString());
      }
    }

    return net.fetch(url.pathToFileURL(fullPath).toString());
  });
}

// IPC: Open file dialog
ipcMain.handle("open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx"] },
      { name: "CSV", extensions: ["csv"] },
      { name: "Text", extensions: ["txt"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return { name: path.basename(filePath), content, path: filePath };
  } catch {
    // file became unreadable between selection and read
    return null;
  }
});

// IPC: Export PDF — render standalone HTML in hidden window, then printToPDF
ipcMain.handle("export-pdf", async (_event, html) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: "document.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });

  if (result.canceled || !result.filePath) {
    return { success: false };
  }

  // Create a hidden window to render the styled HTML
  const pdfWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Destroy the hidden renderer no matter how we exit — a thrown loadURL /
  // printToPDF / write would otherwise leak a full renderer process each time.
  try {
    const dataUrl =
      "data:text/html;charset=utf-8," + encodeURIComponent(html);
    await pdfWindow.loadURL(dataUrl);

    // Wait a moment for fonts/rendering to settle
    await new Promise((resolve) => setTimeout(resolve, 500));

    const pdfData = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    fs.writeFileSync(result.filePath, pdfData);
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: String(err) };
  } finally {
    if (!pdfWindow.isDestroyed()) pdfWindow.destroy();
  }
});

// IPC: write content to a known path
ipcMain.handle("save-file", async (_event, { filePath, content }) => {
  try {
    fs.writeFileSync(filePath, content, "utf-8");
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: write content to a user-chosen path (Save As / Fork)
ipcMain.handle("save-file-as", async (_event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || "untitled.md",
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx"] },
      { name: "CSV", extensions: ["csv"] },
      { name: "Text", extensions: ["txt"] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }
  try {
    fs.writeFileSync(result.filePath, content, "utf-8");
    return {
      success: true,
      path: result.filePath,
      name: path.basename(result.filePath),
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: rename the file on disk, same directory
ipcMain.handle("rename-file", async (_event, { oldPath, newName }) => {
  try {
    const newPath = path.join(path.dirname(oldPath), newName);
    if (fs.existsSync(newPath)) {
      return { success: false, error: "A file with that name already exists" };
    }
    fs.renameSync(oldPath, newPath);
    return { success: true, path: newPath, name: newName };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: export rendered HTML to a file
ipcMain.handle("export-html", async (_event, { defaultName, html }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || "document.html",
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }
  try {
    fs.writeFileSync(result.filePath, html, "utf-8");
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// ── Sync / library IPC ──
const registry = require("./registry");
const mdindex = require("./mdindex");
const sync = require("./sync");
const workspace = require("./workspace");

// ── Workspace / Files-view IPC ──
const wsTry = (fn) => {
  try {
    return fn();
  } catch (err) {
    return { error: String(err) };
  }
};
ipcMain.handle("ws-roots", () => workspace.roots());
ipcMain.handle("ws-default-path", () => workspace.defaultRootPath());
ipcMain.handle("ws-create-default", () => wsTry(() => ({ ok: true, path: workspace.createDefaultRoot() })));
ipcMain.handle("ws-add-root", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return workspace.addRoot(r.filePaths[0]);
});
ipcMain.handle("ws-remove-root", (_e, p) => wsTry(() => workspace.removeRoot(p)));
ipcMain.handle("ws-list-dir", (_e, p) => wsTry(() => workspace.listDir(p)));
ipcMain.handle("ws-mkdir", (_e, { parent, name }) => wsTry(() => workspace.mkdir(parent, name)));
ipcMain.handle("ws-new-file", (_e, { parent, name }) => wsTry(() => workspace.newFile(parent, name)));
ipcMain.handle("ws-move", (_e, { src, destDir }) => wsTry(() => workspace.move(src, destDir)));
ipcMain.handle("ws-rename", (_e, { target, newName }) => wsTry(() => workspace.rename(target, newName)));
ipcMain.handle("ws-trash", async (_e, target) => {
  try {
    return await workspace.trash(target);
  } catch (err) {
    return { error: String(err) };
  }
});
ipcMain.handle("ws-reveal", (_e, target) => wsTry(() => workspace.reveal(target)));

// ── Terminal IPC ──
const terminal = require("./terminal");
ipcMain.handle("term-available", () => terminal.available());
ipcMain.handle("term-create", (_e, { cwd }) =>
  terminal.create(
    cwd,
    (id, data) => mainWindow?.webContents.send("term-data", { id, data }),
    (id) => mainWindow?.webContents.send("term-exit", { id })
  )
);
ipcMain.handle("term-write", (_e, { id, data }) => terminal.write(id, data));
ipcMain.handle("term-resize", (_e, { id, cols, rows }) => terminal.resize(id, cols, rows));
ipcMain.handle("term-kill", (_e, id) => terminal.kill(id));
ipcMain.handle("term-external-apps", () => terminal.externalApps());
ipcMain.handle("term-open-external", (_e, { app, cwd }) => terminal.openExternal(app, cwd));

ipcMain.handle("sync-config", (_event, cfg) => sync.setConfig(cfg));
ipcMain.handle("registry-track", (_event, { path: p, name, content }) => {
  try {
    registry.track(p, name, content);
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
});
ipcMain.handle("registry-get", (_event, p) => {
  try {
    return registry.get(p) ?? null;
  } catch {
    return null;
  }
});
ipcMain.handle("library-state", () => sync.libraryState());
ipcMain.handle("doc-sync-on", (_event, { path: p, name, content }) =>
  sync.syncOn(p, name, content)
);
ipcMain.handle("doc-sync-off", (_event, { path: p, deleteRemote }) =>
  sync.syncOff(p, deleteRemote)
);
ipcMain.handle("doc-push", (_event, { path: p, name, content }) =>
  sync.push(p, name, content)
);
ipcMain.handle("doc-resolve", (_event, { path: p, strategy }) =>
  sync.resolve(p, strategy)
);
ipcMain.handle("doc-pull", async (_event, { cloudId, suggestedName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || "document.md",
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return sync.pull(cloudId, result.filePath);
});

// IPC: open an https URL in the system browser (OAuth flows)
ipcMain.handle("open-external", (_event, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ── Browse: device-wide markdown index ──
let _mdLastFocusScan = 0;

// Run a fresh index scan, persist the snapshot, and tell the renderer.
async function mdRescanAndNotify() {
  try {
    const result = await mdindex.rescan();
    try { registry.saveIndexCache(result.files); } catch { /* cache best-effort */ }
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("mdindex-updated", { scannedAt: result.scannedAt });
  } catch (err) {
    console.error("md index scan failed:", err == null ? "unknown" : String(err));
  }
}

// Return cached rows immediately (seeding from the DB snapshot on first call),
// and kick a background refresh.
ipcMain.handle("mdindex-scan", async () => {
  if (!mdindex.getCached()) {
    try { mdindex.seed(registry.loadIndexCache(), null); } catch { /* no snapshot yet */ }
  }
  const cached = mdindex.getCached();
  mdRescanAndNotify(); // fire-and-forget refresh
  return cached || { files: [], scannedAt: null };
});

ipcMain.handle("mdindex-refresh", async () => {
  const result = await mdindex.rescan();
  try { registry.saveIndexCache(result.files); } catch { /* best-effort */ }
  return result;
});

ipcMain.handle("mdindex-stars", () => registry.listStars());
ipcMain.handle("mdindex-star-toggle", (_e, { path: p, kind }) =>
  registry.toggleStar(p, kind)
);

// ── Auto-update (electron-updater → Squirrel.Mac) ──
// Checks the generic feed (see package.json "publish") for a newer signed +
// notarized build, downloads it in the background, and installs on quit. The
// renderer is notified so it can offer a "Restart to update" prompt.
let updateState = "idle"; // idle | checking | available | downloading | ready | error
function sendUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function setupAutoUpdate() {
  // Only meaningful for packaged builds; in dev there's no app bundle to swap.
  if (isDev || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    updateState = "checking";
  });
  autoUpdater.on("update-available", (info) => {
    updateState = "available";
    sendUpdate("update-available", { version: info?.version });
  });
  autoUpdater.on("update-not-available", () => {
    updateState = "idle";
  });
  autoUpdater.on("download-progress", (p) => {
    updateState = "downloading";
    sendUpdate("update-progress", { percent: Math.round(p?.percent ?? 0) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    updateState = "ready";
    sendUpdate("update-ready", { version: info?.version });
  });
  autoUpdater.on("error", (err) => {
    updateState = "error";
    // Don't surface noisy network errors to the user; just log.
    console.error("auto-update error:", err == null ? "unknown" : String(err));
  });

  // Check shortly after launch, then every 6 hours while running.
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// IPC: renderer asks for the latest known update status / triggers a check
ipcMain.handle("update-status", () => updateState);
ipcMain.handle("check-for-updates", () => {
  if (isDev || !app.isPackaged) return { ok: false, reason: "dev" };
  autoUpdater.checkForUpdates().catch(() => {});
  return { ok: true };
});
// IPC: user accepted the update — quit and install the downloaded version
ipcMain.handle("quit-and-install", () => {
  if (updateState === "ready") autoUpdater.quitAndInstall();
});

// IPC: make Markie the default app for Markdown files (macOS).
// LaunchServices has no first-party CLI, so we drive it through a tiny Swift
// snippet that calls LSSetDefaultRoleHandlerForContentType for the Markdown
// UTI. Requires the Xcode command line tools (`swift`) and the *packaged*
// app — in dev the running bundle is Electron, not Markie.
const MARKIE_BUNDLE_ID = "com.zvn.markie";
const MARKDOWN_UTI = "net.daringfireball.markdown"; // covers .md + .markdown

// Run a one-off Swift snippet, resolving { code, stdout } (or an error string).
function runSwift(src) {
  const { spawn } = require("child_process");
  const os = require("os");
  const tmp = path.join(os.tmpdir(), `markie-${Date.now()}-${Math.round(performance.now())}.swift`);
  return new Promise((resolve) => {
    try {
      fs.writeFileSync(tmp, src, "utf-8");
    } catch (err) {
      return resolve({ error: String(err) });
    }
    let child;
    try {
      child = spawn("swift", [tmp], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      fs.rmSync(tmp, { force: true });
      return resolve({ error: "swift-missing" });
    }
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => {
      fs.rmSync(tmp, { force: true });
      resolve({ error: err.code === "ENOENT" ? "swift-missing" : String(err) });
    });
    child.on("exit", (code) => {
      fs.rmSync(tmp, { force: true });
      resolve({ code, stdout: out.trim() });
    });
  });
}

// IPC: is Markie already the default handler for Markdown? Lets the UI hide
// the "set default" prompt when it's already set, instead of nagging.
ipcMain.handle("default-md-status", async () => {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return { supported: false, isDefault: false };
  }
  const res = await runSwift(
    [
      "import Foundation",
      "import CoreServices",
      `let h = LSCopyDefaultRoleHandlerForContentType("${MARKDOWN_UTI}" as CFString, .all)?.takeRetainedValue() as String?`,
      'print(h ?? "")',
    ].join("\n")
  );
  if (res.error) return { supported: false, isDefault: false };
  return {
    supported: true,
    isDefault: res.stdout.toLowerCase() === MARKIE_BUNDLE_ID,
  };
});

ipcMain.handle("set-default-md", async () => {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Only available on macOS." };
  }
  if (!app.isPackaged) {
    return {
      ok: false,
      error:
        "Run the installed Markie app (not the dev build) to set it as the default.",
    };
  }
  const res = await runSwift(
    [
      "import Foundation",
      "import CoreServices",
      `let b = "${MARKIE_BUNDLE_ID}" as CFString`,
      `let s = LSSetDefaultRoleHandlerForContentType("${MARKDOWN_UTI}" as CFString, .all, b)`,
      "exit(s == 0 ? 0 : 1)",
    ].join("\n")
  );
  if (res.error === "swift-missing") {
    return { ok: false, error: "Swift isn't installed. Run: xcode-select --install" };
  }
  if (res.error) return { ok: false, error: res.error };
  return res.code === 0
    ? { ok: true }
    : { ok: false, error: "LaunchServices rejected the change." };
});

// IPC: renderer signals it has mounted and asks for any queued file
ipcMain.handle("get-initial-file", () => {
  rendererReady = true;
  // Flush a deep link that landed during cold start (OAuth browser hand-off).
  if (pendingDeepLink) {
    const link = pendingDeepLink;
    pendingDeepLink = null;
    // defer a tick so the renderer's listeners are wired before we send
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("deep-link", link);
      }
    }, 0);
  }
  if (!pendingFilePath) return null;
  const payload = readFilePayload(pendingFilePath);
  pendingFilePath = null;
  return payload;
});

// IPC: Open file from path (for "open with" and drag-drop from Finder)
ipcMain.handle("open-file-path", async (_event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const name = path.basename(filePath);
    return { name, content, path: filePath };
  } catch {
    return null;
  }
});

// App menu
const template = [
  {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      {
        label: "Settings…",
        accelerator: "CmdOrCtrl+,",
        click: () => mainWindow?.webContents.send("menu-settings"),
      },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    label: "File",
    submenu: [
      {
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        click: () => mainWindow?.webContents.send("menu-open-file"),
      },
      { type: "separator" },
      {
        label: "Library…",
        accelerator: "CmdOrCtrl+L",
        click: () => mainWindow?.webContents.send("menu-library"),
      },
      { type: "separator" },
      {
        label: "Save",
        accelerator: "CmdOrCtrl+S",
        click: () => mainWindow?.webContents.send("menu-save"),
      },
      {
        label: "Save As…",
        accelerator: "CmdOrCtrl+Shift+S",
        click: () => mainWindow?.webContents.send("menu-save-as"),
      },
      {
        label: "Duplicate (Fork)",
        accelerator: "CmdOrCtrl+Shift+D",
        click: () => mainWindow?.webContents.send("menu-fork"),
      },
      { type: "separator" },
      {
        label: "Export",
        submenu: [
          {
            label: "PDF (Dark)…",
            accelerator: "CmdOrCtrl+Shift+E",
            click: () => mainWindow?.webContents.send("menu-export-pdf", "dark"),
          },
          {
            label: "PDF (Light)…",
            click: () => mainWindow?.webContents.send("menu-export-pdf", "light"),
          },
          {
            label: "HTML…",
            click: () => mainWindow?.webContents.send("menu-export-html"),
          },
        ],
      },
      { type: "separator" },
      { role: "close" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      { type: "separator" },
      {
        label: "Format Tables",
        accelerator: "CmdOrCtrl+Alt+T",
        click: () => mainWindow?.webContents.send("menu-format-tables"),
      },
    ],
  },
  {
    label: "View",
    submenu: [
      {
        label: "View",
        accelerator: "CmdOrCtrl+1",
        click: () => mainWindow?.webContents.send("set-mode", "preview"),
      },
      {
        label: "Edit",
        accelerator: "CmdOrCtrl+2",
        click: () => mainWindow?.webContents.send("set-mode", "edit"),
      },
      {
        label: "Split",
        accelerator: "CmdOrCtrl+3",
        click: () => mainWindow?.webContents.send("set-mode", "split"),
      },
      { type: "separator" },
      {
        label: "Command Palette…",
        accelerator: "CmdOrCtrl+K",
        click: () => mainWindow?.webContents.send("menu-command-palette"),
      },
      {
        label: "Theme…",
        click: () => mainWindow?.webContents.send("menu-theme"),
      },
      {
        label: "Keyboard Shortcuts",
        accelerator: "CmdOrCtrl+/",
        click: () => mainWindow?.webContents.send("menu-shortcuts"),
      },
      {
        label: "Statistics",
        accelerator: "CmdOrCtrl+Shift+I",
        click: () => mainWindow?.webContents.send("toggle-stats"),
      },
      { type: "separator" },
      { role: "togglefullscreen" },
      { type: "separator" },
      { role: "toggleDevTools" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { role: "front" },
    ],
  },
];

// Deep links (markie://…) — used by the Google OAuth callback.
// macOS delivers these via the open-url event below.
app.setAsDefaultProtocolClient("markie");
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

// Single instance: a second launch (e.g. the OS opening markie:// on
// Windows/Linux, or a double-clicked file) hands its argv to the running
// instance instead of starting a rival process that would steal the deep link.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((a) => a.startsWith("markie://"));
    if (link) {
      deliverDeepLink(link);
      return;
    }
    const file = argv.find((a) => OPENABLE.test(a) && fs.existsSync(a));
    if (file && rendererReady && mainWindow && !mainWindow.isDestroyed()) {
      const payload = readFilePayload(path.resolve(file));
      if (payload) mainWindow.webContents.send("file-opened", payload);
    } else if (file) {
      pendingFilePath = path.resolve(file);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerProtocol();
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    createWindow();
    setupAutoUpdate();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

// Flush the SQLite registry handle + kill PTYs deterministically before exit.
app.on("will-quit", () => {
  try {
    require("./terminal").killAll();
  } catch {
    // best effort
  }
  try {
    require("./registry").close();
  } catch {
    // best effort
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Handle file open via Finder "open with" / double-click.
// Before the renderer is ready, queue the path; it is delivered via
// the get-initial-file handshake when the renderer mounts.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    const payload = readFilePayload(filePath);
    if (payload) mainWindow.webContents.send("file-opened", payload);
  } else {
    pendingFilePath = filePath;
    if (!mainWindow && app.isReady()) {
      // Re-opened from Finder while dock-alive with all windows closed
      createWindow();
    }
  }
});
