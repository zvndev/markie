const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  net,
  shell,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const url = require("url");
const { autoUpdater } = require("electron-updater");
const { shareBaseFromSrc } = require("./share-origin");
const { classifyDeepLink, cloudDocId } = require("./deep-links");
const { dialogStartDir } = require("./dialog-start");
const { createFileGrants } = require("./file-grants");
const { buildAppCsp } = require("./csp");
const { desktopUpdatePolicy, shouldSetupAutoUpdate } = require("./update-policy");
const { guardedLogger } = require("./updater-logging");

// Electron answers an uncaught exception in the main process with a modal
// dialog containing a raw stack trace. That is alarming on its own, and it is
// blocking: one thrown during quitAndInstall keeps the app alive, so Squirrel
// waits on a process that never exits and the update silently never lands.
// Log it and stay up instead.
//
// The write is wrapped because this handler exists partly to survive a console
// that is failing: logging an EPIPE to a broken stdout throws another one and
// takes the process down anyway.
for (const signal of ["uncaughtException", "unhandledRejection"]) {
  process.on(signal, (error) => {
    try {
      console.error(`${signal}:`, error);
    } catch {
      // The thing we would report it to is the thing that broke.
    }
  });
}
const {
  OPENABLE,
  findDeepLinkArg,
  findOpenableLaunchFile,
  markdownDefaultHandlerUnavailable,
  supportsMarkdownDefaultHandler,
} = require("./desktop-intents");

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

// Deliver a markie:// deep link to the renderer, or queue it if the window
// isn't ready yet (cold start from the OAuth browser hand-off). Always raises
// the window so the user lands back in Markie focused.
function deliverDeepLink(link) {
  const kind = classifyDeepLink(link);
  if (kind === "ignore") return;
  // A public link: fetch it with the token the link carries and open a copy
  // locally, no account needed.
  if (kind === "shared-token") {
    openSharedFromDeepLink(link);
    return;
  }
  // A document shared with this account. The link carries no token: the app
  // fetches it with the signed-in user's own credentials, so it lands in their
  // Library synced and live rather than as a detached copy.
  if (kind === "cloud-doc") {
    openCloudDocFromDeepLink(link);
    return;
  }
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

// Save a shared doc to ~/Downloads with a collision-safe markdown name.
function downloadsUniquePath(name) {
  let safe = path.basename(String(name || "")).replace(/[\\/:]/g, "_").trim() || "Shared document";
  if (!/\.(md|markdown|mdx|txt)$/i.test(safe)) safe += ".md";
  const dir = app.getPath("downloads");
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  let candidate = path.join(dir, safe);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    i++;
  }
  return candidate;
}

// Pull a filename out of a Content-Disposition header, if present.
function filenameFromDisposition(cd) {
  if (!cd) return null;
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try { return path.basename(decodeURIComponent(star[1])); } catch { /* fall through */ }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? path.basename(plain[1].trim()) : null;
}

// The packaging gate launches the packed app to check the renderer loads. It
// reads the window title to decide, so a document restored by macOS at launch
// would rename the window out from under it. In that mode the app opens empty.
const preflightMode = process.env.MARKIE_PREFLIGHT === "1";

// Open a markdown file that already exists on disk in the editor window,
// creating/showing the window and bridging cold start via pendingFilePath.
function openLocalFile(filePath) {
  // macOS reopens the last document by sending open-file at launch, which is
  // the path that renamed the window during the packaging gate.
  if (preflightMode) return;
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    const payload = readFilePayload(filePath, { grant: true });
    if (payload) mainWindow.webContents.send("file-opened", payload);
  } else {
    pendingFilePath = filePath;
    if (!mainWindow && app.isReady()) createWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// markie://open?token=…&src=… — fetch the shared doc from its public link (the
// token is the authorization, no account needed), save it to ~/Downloads, and
// open it. Waits for app-ready on a cold start.
async function openSharedFromDeepLink(link) {
  if (!app.isReady()) {
    app.whenReady().then(() => openSharedFromDeepLink(link));
    return;
  }
  let parsed;
  try { parsed = new URL(link); } catch { return; }
  const token = parsed.searchParams.get("token");
  const src = parsed.searchParams.get("src");
  if (!token) return;
  if (!mainWindow) createWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  try {
    // SECURITY: never fetch from the deep link's raw `src` (SSRF). Pin to an
    // allowlisted Markie origin; unknown/attacker srcs fall back to production.
    const base = shareBaseFromSrc(src, { allowDev: isDev });
    const res = await net.fetch(`${base}/s/${encodeURIComponent(token)}/raw`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    const name = filenameFromDisposition(res.headers.get("content-disposition")) || "Shared document.md";
    const dest = downloadsUniquePath(name);
    fs.writeFileSync(dest, content, "utf-8");
    openLocalFile(dest);
  } catch (err) {
    console.error("markie://open failed:", err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: "Couldn't open the shared document",
        detail: "The link may have expired, or you're offline. Try opening it again from the email.",
      });
    }
  }
}

// markie://doc?id=… — open a document that is shared with the signed-in
// account. The link carries no credential of its own, so a stranger who gets
// hold of it opens nothing: the fetch uses this app's own session, and the
// server decides whether this account may read that document.
//
// On a cold start the link usually arrives before the renderer has handed the
// sync engine its token, so "not signed in" is the normal first answer rather
// than the truth. Wait for the renderer to sign in before believing it.
async function openCloudDocFromDeepLink(link) {
  if (!app.isReady()) {
    app.whenReady().then(() => openCloudDocFromDeepLink(link));
    return;
  }
  const cloudId = cloudDocId(link);
  if (!cloudId) return;
  if (!mainWindow) createWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  const signedIn = await waitForSignIn(15000);
  if (!signedIn) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        message: "Sign in to open this document",
        detail: "This document was shared with your Markie account. Sign in, then open the link from your email again.",
      });
    }
    return;
  }

  const res = await sync.pull(cloudId, downloadsUniquePath("Shared document.md"));
  if (res && res.error) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: "Couldn't open the shared document",
        detail: "It may have been unshared, or you're signed in with a different account than it was shared with.",
      });
    }
    return;
  }
  // pull() writes under a placeholder name because the real one only comes back
  // with the document. Rename before opening so the Library shows what the
  // sender called it, not "Shared document".
  let finalPath = res.path;
  if (res.name) {
    const preferred = downloadsUniquePath(res.name);
    try {
      fs.renameSync(res.path, preferred);
      registry.movePath(res.path, preferred);
      finalPath = preferred;
    } catch { /* keep the placeholder name rather than lose the file */ }
  }
  fileGrants.grantFile(finalPath);
  openLocalFile(finalPath);
}

// Resolve once the renderer has configured the sync engine with a session, or
// give up so the caller can say something useful instead of hanging.
function waitForSignIn(timeoutMs) {
  return new Promise((resolve) => {
    if (sync.isConfigured()) return resolve(true);
    const started = Date.now();
    const timer = setInterval(() => {
      if (sync.isConfigured()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 250);
  });
}

// What Markie last saw on disk for a path. A save compares against this so we
// can tell "nothing moved underneath me" from "something rewrote this file
// while it was open" — which is the normal case when an agent is working in the
// same repo. Without it, saving blind-writes the buffer over the newer file.
const lastSeenOnDisk = new Map();

function hashOf(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function rememberDisk(filePath, content) {
  lastSeenOnDisk.set(filePath, hashOf(content));
}

// Returns the current on-disk content when it differs from what we last saw,
// or null when it matches, is unknown to us, or cannot be read.
function diskChangedSince(filePath) {
  const known = lastSeenOnDisk.get(filePath);
  if (!known) return null; // never read it here; nothing to compare against
  let current;
  try {
    current = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null; // gone or unreadable; the write itself will report the failure
  }
  return hashOf(current) === known ? null : current;
}

function readFilePayload(filePath, { grant = false } = {}) {
  try {
    const access = grant ? fileGrants.grantFile(filePath) : fileGrants.canRead(filePath);
    if (!access.ok) return null;
    const content = fs.readFileSync(access.path, "utf-8");
    rememberDisk(access.path, content);
    return {
      name: path.basename(access.path),
      content,
      path: access.path,
    };
  } catch {
    return null;
  }
}

// File passed as a CLI argument (dev runs, Windows/Linux double-click)
const argFile = preflightMode ? null : findOpenableLaunchFile(process.argv.slice(1));
if (argFile) pendingFilePath = argFile;

// markie:// deep link passed as a CLI argument (Windows/Linux cold start)
const argDeepLink = findDeepLinkArg(process.argv.slice(1));
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
    // E2E drivers keep the window hidden so runs don't steal focus
    if (process.env.MARKIE_E2E === "1") return;
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
    mainWindow.loadURL(process.env.MARKIE_DEV_URL || "http://localhost:3000");
    if (process.env.MARKIE_E2E !== "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
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

    // SECURITY: never serve outside the bundled out/ dir even if the path
    // contains traversal (defensive — the renderer origin is app:// only).
    const resolvedOut = path.resolve(outDir);
    const resolvedFull = path.resolve(fullPath);
    if (resolvedFull !== resolvedOut && !resolvedFull.startsWith(resolvedOut + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }

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

// Strict CSP for the packaged app:// renderer. A backstop behind the markdown
// sanitizer. Not applied in dev (Next HMR needs a looser policy).
function setupCSP() {
  if (isDev) return;
  const csp = buildAppCsp(path.join(__dirname, "../out"));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] },
    });
  });
}

// IPC: Open file dialog
ipcMain.handle("open-file", async (_event, args) => {
  const startDir = dialogStartDir(args?.near);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    ...(startDir ? { defaultPath: startDir } : {}),
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

  // The dialog is the user grant. Store it in main before returning the file.
  return readFilePayload(result.filePaths[0], { grant: true });
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
    const access = fileGrants.canWrite(filePath);
    if (!access.ok) return { success: false, error: access.error };

    // Someone changed this file since Markie read it. Writing now would throw
    // their work away with no trace, so ask instead of guessing.
    const newer = diskChangedSince(access.path);
    if (newer !== null) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        buttons: ["Reload from disk", "Overwrite", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        message: `"${path.basename(access.path)}" changed on disk since you opened it.`,
        detail:
          "Something else edited this file, most likely an agent or another editor. " +
          "Reloading discards your unsaved edits. Overwriting discards theirs.",
      });
      if (response === 2) return { success: false, canceled: true };
      if (response === 0) {
        rememberDisk(access.path, newer);
        return { success: false, code: "reloaded", path: access.path, content: newer };
      }
      // response === 1: the user chose to overwrite, so fall through.
    }

    fs.writeFileSync(access.path, content, "utf-8");
    rememberDisk(access.path, content);
    return { success: true, path: access.path };
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
  if (!OPENABLE.test(result.filePath)) {
    return { success: false, error: "Unsupported file type" };
  }
  try {
    fs.writeFileSync(result.filePath, content, "utf-8");
    const grant = fileGrants.grantFile(result.filePath);
    const savedPath = grant.ok ? grant.path : result.filePath;
    return {
      success: true,
      path: savedPath,
      name: path.basename(savedPath),
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: rename the file on disk, same directory
ipcMain.handle("rename-file", async (_event, { oldPath, newName }) => {
  try {
    const access = fileGrants.canRename(oldPath, newName);
    if (!access.ok) return { success: false, error: access.error };
    fs.renameSync(access.oldPath, access.newPath);
    fileGrants.moveGrant(access.oldPath, access.newPath);
    try { registry.movePath(access.oldPath, access.newPath); } catch { /* registry best-effort */ }
    return { success: true, path: access.newPath, name: access.name };
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
const fileGrants = createFileGrants({ workspaceRoots: () => workspace.roots() });

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
ipcMain.handle("term-create", (_e, context = {}) =>
  terminal.create(
    terminal.resolveContext(context, workspace.roots()),
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
// The renderer resolved this doc's share role against the server; the sync
// engine needs it so a save can refuse a push the server would only 403.
ipcMain.handle("sync-doc-role", (_event, { cloudId, role }) =>
  sync.setDocRole(cloudId, role)
);
ipcMain.handle("registry-track", (_event, { path: p, name, content }) => {
  try {
    const access = fileGrants.canRead(p);
    if (!access.ok) return { error: access.error };
    registry.track(access.path, name, content);
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
});
// Remember the role the server confirmed for a file, so a later offline
// session can honour it instead of locking the owner out of their own document.
ipcMain.handle("registry-set-role", (_event, { path: p, role }) => {
  try {
    if (!["owner", "editor", "viewer"].includes(role)) return { error: "bad role" };
    registry.update(p, { share_role: role });
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
// Retry a push that failed, for a file the Library is showing but the renderer
// has not opened and so has no content for. "Unpushed" was added so the Library
// stops claiming a file is backed up when it is not; without this it is a state
// with a badge and no way out, because the update strip only appears when the
// *server* is ahead, which is exactly what an unpushed file usually is not.
// Same grant rule as open-file-path: a path the app itself advertised.
// Open the file manager with the file selected.
function revealInFileManager(target) {
  shell.showItemInFolder(target);
}

// Show the open document in the OS file manager, selected and ready to drag
// somewhere else. Deliberately not ws-reveal: that one refuses anything outside
// a workspace root, and the document you are looking at is usually somewhere
// else entirely. A file Markie already has a read grant for is one the user
// opened, so pointing at it in Finder gives away nothing new.
ipcMain.handle("reveal-file", (_event, p) => {
  const access = isAdvertisedPath(p)
    ? fileGrants.grantFile(p)
    : fileGrants.canRead(p);
  if (!access.ok) return { error: access.error };
  if (!fs.existsSync(access.path)) {
    // Say so rather than opening a Finder window onto nothing, which reads as
    // the feature being broken.
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: "That file isn't on disk anymore",
        detail: "It was moved or deleted since you opened it. Save it somewhere to get it back.",
      });
    }
    return { error: "missing" };
  }
  revealInFileManager(access.path);
  return { ok: true };
});

ipcMain.handle("doc-retry-push", (_event, { path: p }) => {
  const access = isAdvertisedPath(p)
    ? fileGrants.grantFile(p)
    : fileGrants.canRead(p);
  if (!access.ok) return { error: access.error };
  let content;
  try {
    content = fs.readFileSync(access.path, "utf-8");
  } catch (err) {
    return { error: `Couldn't read the file: ${err.message}` };
  }
  rememberDisk(access.path, content);
  return sync.push(access.path, path.basename(access.path), content);
});
ipcMain.handle("doc-resolve", (_event, { path: p, strategy }) =>
  sync.resolve(p, strategy)
);
// Which tracked files the server is ahead of. One request for the whole
// library, called on focus and on a timer, so it has to stay cheap and quiet.
ipcMain.handle("doc-check-updates", () => sync.checkUpdates());
// The server's copy, for showing what a pull would cost before doing it.
ipcMain.handle("doc-remote-content", (_event, { path: p }) =>
  sync.remoteContent(p)
);
ipcMain.handle("doc-keep-both", (_event, { path: p, content }) =>
  sync.resolveKeepBoth(p, content)
);
ipcMain.handle("doc-pull", async (_event, { cloudId, suggestedName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || "document.md",
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx"] },
      { name: "Text", extensions: ["txt"] },
    ],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (!OPENABLE.test(result.filePath)) return { error: "Unsupported file type" };
  const pulled = await sync.pull(cloudId, result.filePath);
  if (pulled?.ok) fileGrants.grantFile(pulled.path);
  return pulled;
});

// Open a shared cloud doc with one click: save it to ~/Downloads and open it,
// no "where do you want to save" dialog. Backs the "Shared with you" list.
ipcMain.handle("doc-open-shared", async (_event, { cloudId, suggestedName }) => {
  const dest = downloadsUniquePath(suggestedName || "Shared document.md");
  const res = await sync.pull(cloudId, dest);
  if (res && res.error) return res;
  fileGrants.grantFile(dest);
  openLocalFile(dest);
  return { ok: true, path: dest };
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

// Where the bundled Markie MCP server lives, so the Agents dialog can hand an
// agent a working `node <path>` command. Packaged: under Resources (copied via
// extraResources); dev: the repo's mcp/ next to the app path.
ipcMain.handle("mcp-info", () => {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return {
    serverPath: path.join(base, "mcp", "markie-mcp.mjs"),
    packaged: app.isPackaged,
  };
});

// ── Auto-update (electron-updater → macOS feed) ──
// The current production feed is signed + notarized macOS only. Windows and
// Linux packages can be built and smoke-tested locally, but they must not touch
// the macOS feed until their signing, feed files, and public URLs are approved.
let updateState = "idle"; // idle | checking | available | downloading | ready | error
let manualUpdateCheck = false;
function sendUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function showUpdateMessage(options) {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  return dialog.showMessageBox(parent, options);
}

async function requestUpdateCheck({ manual = false } = {}) {
  const policy = desktopUpdatePolicy({
    isDev,
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
  if (!policy.supported) {
    if (manual) {
      await showUpdateMessage({
        type: "info",
        message: policy.message,
        detail: policy.detail,
      });
    }
    return { ok: false, reason: policy.reason };
  }

  if (updateState === "ready") {
    if (manual) {
      const { response } = await showUpdateMessage({
        type: "info",
        buttons: ["Restart & Update", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: "A Markie update is ready to install.",
        detail: "Restart Markie to finish installing the downloaded update.",
      });
      if (response === 0) autoUpdater.quitAndInstall();
    }
    return { ok: true, state: updateState };
  }

  if (updateState === "checking" || updateState === "downloading") {
    if (manual) {
      await showUpdateMessage({
        type: "info",
        message: updateState === "checking" ? "Markie is already checking for updates." : "Markie is already downloading an update.",
      });
    }
    return { ok: true, state: updateState };
  }

  manualUpdateCheck = manual;
  updateState = "checking";
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    updateState = "error";
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      await showUpdateMessage({
        type: "warning",
        message: "Markie couldn't check for updates.",
        detail: String(err?.message ?? err ?? "Unknown updater error"),
      });
    }
    return { ok: false, reason: "error" };
  }
}

function setupAutoUpdate() {
  if (!shouldSetupAutoUpdate({ isDev, isPackaged: app.isPackaged, platform: process.platform })) {
    return;
  }
  // Before anything else: electron-updater logs through console, and a console
  // write can throw (EPIPE on a closed stdout). An unguarded debug line during
  // quitAndInstall becomes an uncaught exception, which becomes a modal dialog,
  // which stops the app from quitting — so Squirrel waits forever and the
  // update never installs.
  autoUpdater.logger = guardedLogger(console);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    updateState = "checking";
  });
  autoUpdater.on("update-available", (info) => {
    updateState = "available";
    sendUpdate("update-available", { version: info?.version });
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showUpdateMessage({
        type: "info",
        message: "A Markie update is available.",
        detail: `Version ${info?.version ?? "latest"} is downloading in the background. Markie will prompt you when it is ready to install.`,
      });
    }
  });
  autoUpdater.on("update-not-available", () => {
    updateState = "idle";
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showUpdateMessage({
        type: "info",
        message: "Markie is up to date.",
        detail: `You are running Markie ${app.getVersion()}.`,
      });
    }
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
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showUpdateMessage({
        type: "warning",
        message: "Markie couldn't check for updates.",
        detail: String(err?.message ?? err ?? "Unknown updater error"),
      });
    }
  });

  // Check shortly after launch, then every 6 hours while running.
  const check = () => requestUpdateCheck().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// IPC: renderer asks for the latest known update status / triggers a check
ipcMain.handle("update-status", () => updateState);
ipcMain.handle("check-for-updates", () => requestUpdateCheck({ manual: true }));
// IPC: user accepted the update — quit and install the downloaded version.
//
// Answers the renderer instead of returning nothing, because a failure here is
// invisible from the other side: the button says "Restarting…" and waits for a
// quit that is never coming. On success this call does not return at all.
ipcMain.handle("quit-and-install", () => {
  if (updateState !== "ready") return { ok: false, reason: "not-ready" };
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (err) {
    updateState = "error";
    return {
      ok: false,
      reason: "error",
      error: String(err?.message ?? err ?? "Unknown updater error"),
    };
  }
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
  if (!supportsMarkdownDefaultHandler({ platform: process.platform, isPackaged: app.isPackaged })) {
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
  const unsupported = markdownDefaultHandlerUnavailable({
    platform: process.platform,
    isPackaged: app.isPackaged,
  });
  if (unsupported) return unsupported;
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
  // The packaging gate watches for this. It is written from the handshake the
  // renderer only makes once React has mounted, which is the thing the gate is
  // actually trying to establish — a window whose HTML parsed but whose app
  // crashed on mount looks identical from the outside.
  if (preflightMode) {
    try {
      fs.writeFileSync(path.join(app.getPath("userData"), "preflight-ready"), "1");
    } catch {
      // The gate times out and says so; nothing here is worth crashing for.
    }
  }
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
  const payload = readFilePayload(pendingFilePath, { grant: true });
  pendingFilePath = null;
  return payload;
});

// IPC: Open file from a path already granted by a dialog, OS event, drop, or workspace root.
// A path the app itself advertised to the renderer — a Library/Recent registry
// entry or a Browse/Skills index hit — is the user's own listed markdown, so
// clicking it must open. Grant those; everything else still needs a prior
// grant (open dialog, drag-drop, deep link) or a workspace root.
function isAdvertisedPath(p) {
  try {
    if (registry.get(p)) return true;
  } catch {
    // registry unavailable — fall through to the index
  }
  const cached = mdindex.getCached();
  return !!cached?.files?.some((f) => f.path === p);
}

ipcMain.handle("open-file-path", async (_event, filePath) => {
  return readFilePayload(filePath, { grant: isAdvertisedPath(filePath) });
});

// Synchronous so preload can grant a dropped/selected File before renderer code
// calls open-file-path with the returned path.
ipcMain.on("grant-file-path", (event, filePath) => {
  const grant = fileGrants.grantFile(filePath);
  event.returnValue = grant.ok;
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
      {
        label: "Check for Updates…",
        click: () => requestUpdateCheck({ manual: true }),
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
        label: "New File",
        accelerator: "CmdOrCtrl+N",
        click: () => mainWindow?.webContents.send("menu-new-file"),
      },
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
      {
        label:
          process.platform === "darwin"
            ? "Reveal in Finder"
            : process.platform === "win32"
              ? "Show in Explorer"
              : "Show in File Manager",
        accelerator: "CmdOrCtrl+Alt+R",
        click: () => mainWindow?.webContents.send("menu-reveal"),
      },
      { type: "separator" },
      {
        label: "Print…",
        accelerator: "CmdOrCtrl+P",
        click: () => mainWindow?.webContents.send("menu-print"),
      },
      {
        label: "Export",
        submenu: [
          {
            label: "PDF (Dark)…",
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
      // Not { role: "undo" }. The native role runs the webContents' own undo,
      // which knows about form fields and nothing else: in a ProseMirror or
      // CodeMirror document it either does nothing or undoes something the
      // editor's history has no record of. ⌘Z has to reach whichever editor has
      // focus, so the renderer decides.
      {
        label: "Undo",
        accelerator: "CmdOrCtrl+Z",
        click: () => mainWindow?.webContents.send("menu-undo"),
      },
      {
        label: "Redo",
        // Shift+Cmd+Z on macOS, and Ctrl+Y is the Windows habit. Both are
        // registered; Electron takes the first and the renderer handles the
        // other through its own key handler.
        accelerator: process.platform === "darwin" ? "Shift+CmdOrCtrl+Z" : "CmdOrCtrl+Y",
        click: () => mainWindow?.webContents.send("menu-redo"),
      },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      { type: "separator" },
      // Find lives in the Edit menu because that is where people look for it,
      // and the accelerators have to be declared here: a menu accelerator
      // consumes the key before the page sees it, so leaving Find out of the
      // menu is not neutral, it is the only reason ⌘F ever reached the
      // renderer.
      {
        label: "Find…",
        accelerator: "CmdOrCtrl+F",
        click: () => mainWindow?.webContents.send("menu-find"),
      },
      {
        label: "Find and Replace…",
        accelerator: "CmdOrCtrl+Alt+F",
        click: () => mainWindow?.webContents.send("menu-find-replace"),
      },
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
        label: "Rich Text",
        accelerator: "CmdOrCtrl+1",
        click: () => mainWindow?.webContents.send("set-mode", "preview"),
      },
      {
        label: "Markdown Source",
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
        label: "Zoom In",
        accelerator: "CmdOrCtrl+=",
        click: () => mainWindow?.webContents.send("menu-zoom", 1),
      },
      {
        label: "Zoom Out",
        accelerator: "CmdOrCtrl+-",
        click: () => mainWindow?.webContents.send("menu-zoom", -1),
      },
      {
        label: "Actual Size",
        accelerator: "CmdOrCtrl+0",
        click: () => mainWindow?.webContents.send("menu-zoom", 0),
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
      ...(isDev ? [{ type: "separator" }, { role: "toggleDevTools" }] : []),
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
if (process.env.MARKIE_E2E !== "1") {
  app.setAsDefaultProtocolClient("markie");
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

// Single instance: a second launch (e.g. the OS opening markie:// on
// Windows/Linux, or a double-clicked file) hands its argv to the running
// instance instead of starting a rival process that would steal the deep link.
const gotLock = process.env.MARKIE_E2E === "1" || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = findDeepLinkArg(argv);
    if (link) {
      deliverDeepLink(link);
      return;
    }
    const file = findOpenableLaunchFile(argv);
    if (file && rendererReady && mainWindow && !mainWindow.isDestroyed()) {
      const payload = readFilePayload(file, { grant: true });
      if (payload) mainWindow.webContents.send("file-opened", payload);
    } else if (file) {
      pendingFilePath = file;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerProtocol();
    setupCSP();
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
    const payload = readFilePayload(filePath, { grant: true });
    if (payload) mainWindow.webContents.send("file-opened", payload);
  } else {
    pendingFilePath = filePath;
    if (!mainWindow && app.isReady()) {
      // Re-opened from Finder while dock-alive with all windows closed
      createWindow();
    }
  }
});
