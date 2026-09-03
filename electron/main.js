const {
  app,
  BrowserWindow,
  crashReporter,
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
const { ASSET_SCHEME, buildAppCsp } = require("./csp");
const localAssets = require("./local-assets");
const { desktopUpdatePolicy, shouldSetupAutoUpdate } = require("./update-policy");
const { guardedLogger } = require("./updater-logging");
const {
  readBetaOptIn,
  updaterSettingsFor,
  writeBetaOptIn,
} = require("./update-channel");
const {
  crashDsn,
  readCrashConsent,
  sendCrash,
  writeCrashConsent,
} = require("./crash-reporting");
const { createCrashLog } = require("./crash-log");
const { createPdfExporter, ensureExtension } = require("./export-pdf");
const { createIpcHandler, errorMessage } = require("./ipc-result");
const { writeFileAtomic } = require("./atomic-write");
const { createHistory } = require("./history");
const { saveConflictAction } = require("./save-conflict");
const { createCloseFlusher } = require("./close-flush");

// The renderer answers app-will-close here once it has flushed. Registered at
// module scope, once, because ipcMain listeners outlive any one window.
let _closeReadyCb = null;
ipcMain.on("app-close-ready", () => {
  if (_closeReadyCb) _closeReadyCb();
});

// Electron answers an uncaught exception in the main process with a modal
// dialog containing a raw stack trace. That is alarming on its own, and it is
// blocking: one thrown during quitAndInstall keeps the app alive, so Squirrel
// waits on a process that never exits and the update silently never lands.
// Log it and stay up instead.
//
// The write is wrapped because this handler exists partly to survive a console
// that is failing: logging an EPIPE to a broken stdout throws another one and
// takes the process down anyway.
//
// The same failures are also appended to userData/markie-crash.log, because a
// console line in a packaged app is a console line nobody will ever read. The
// Help menu reveals that file so a bug report can carry it.
let _crashLog = null;
function crashLog() {
  if (!_crashLog) {
    try {
      _crashLog = createCrashLog({ dir: app.getPath("userData") });
    } catch {
      // No userData yet (or no disk). Keep the same shape so callers never
      // have to check whether logging is available.
      _crashLog = { log: () => false, ensure: () => "", path: "" };
    }
  }
  return _crashLog;
}

// Snapshots live under userData, which is only a real path once the app is
// ready — same lazy shape as the crash log above.
// The crash journal, same lazy shape: userData is only a real path once the
// app is ready.
let _drafts = null;
function drafts() {
  if (!_drafts) {
    const { createDrafts } = require("./drafts");
    _drafts = createDrafts({ dir: app.getPath("userData") });
  }
  return _drafts;
}

// File history. Backed by the same userData/snapshots directory the 0.4.x
// snapshot store used, so every existing snapshot is already the oldest
// version of its document and nothing has to migrate.
let _history = null;
function history() {
  if (!_history) {
    try {
      _history = createHistory({ dir: app.getPath("userData") });
    } catch {
      // No userData: keep the shape so callers never branch on availability.
      _history = {
        capture: () => ({ skipped: "unavailable" }),
        captureExternal: () => ({ skipped: "unavailable" }),
        list: () => [],
        read: () => null,
        has: () => false,
        root: "",
      };
    }
  }
  return _history;
}

// Copy what is on disk before replacing it. Never allowed to fail a save: a
// missing snapshot is a smaller loss than a save that did not happen.
function snapshotBeforeWrite(filePath, nextContent) {
  try {
    const res = history().capture(filePath, nextContent, { author: "user" });
    if (res && res.skipped === "write-failed") {
      logCrash("snapshot-failed", res.error);
    }
  } catch (err) {
    logCrash("snapshot-failed", err);
  }
}

// Shape a (kind, detail) pair into the record sentry-envelope reads. Version
// and platform come from main, never from the renderer: a crashing renderer is
// the least trustworthy narrator of what build it is.
function crashRecord(kind, detail) {
  const record = {
    at: new Date().toISOString(),
    source: "main",
    message: String(kind),
    version: app.getVersion(),
    platform: `${process.platform}/${process.arch}`,
  };
  if (detail && typeof detail === "object") {
    for (const key of ["source", "message", "stack", "componentStack"]) {
      if (typeof detail[key] === "string" && detail[key]) record[key] = detail[key];
    }
    if (detail instanceof Error) {
      record.message = detail.message || record.message;
      if (typeof detail.stack === "string") record.stack = detail.stack;
    }
  } else if (typeof detail === "string" && detail) {
    record.stack = detail;
  }
  return record;
}

// Consent-gated, DSN-gated, and allowed to fail silently: reporting a crash
// must never cause one, and "no consent" or "no DSN" means it never leaves
// the machine at all.
function uploadCrash(kind, detail) {
  try {
    if (!readCrashConsent(app.getPath("userData"))) return;
    const dsn = crashDsn();
    if (!dsn) return;
    void sendCrash(crashRecord(kind, detail), {
      dsn,
      home: app.getPath("home"),
      environment: app.isPackaged ? "production" : "development",
      clientVersion: app.getVersion(),
    });
  } catch {
    // Never let the reporter become the crash.
  }
}

function logCrash(kind, detail) {
  try {
    console.error(`${kind}:`, detail);
  } catch {
    // The thing we would report it to is the thing that broke.
  }
  try {
    crashLog().log(kind, detail);
  } catch {
    // Logging a crash must never be the thing that causes the next one.
  }
  uploadCrash(kind, detail);
}

for (const signal of ["uncaughtException", "unhandledRejection"]) {
  process.on(signal, (error) => {
    logCrash(signal, error);
  });
}

// A dead GPU/utility/pepper child is the usual prelude to a renderer that
// stops painting. Recording it is the difference between "Markie froze" and a
// reproducible report.
app.on("child-process-gone", (_event, details) => {
  logCrash("child-process-gone", details);
});

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
  // Pictures that live next to the document. Standard so the URL parses
  // predictably; secure so it is not mixed content on the app:// origin.
  // Deliberately not fetch-enabled: a document displays these, it never reads
  // them, and there is no reason to hand script a way to pull bytes out.
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false },
  },
]);

// Native crash dumps, kept on the machine. Markie has no crash server and is
// not getting one: uploadToServer stays false, and the dumps live next to the
// crash log so a bug report can include both. Must run before app ready.
try {
  crashReporter.start({ submitURL: "", uploadToServer: false });
} catch (err) {
  logCrash("crash-reporter-start-failed", err);
}

let mainWindow;
let rendererReady = false;
// Set once the user has asked to quit. The close interception below prevents
// the window close that a quit performs, and a prevented close cancels the
// quit outright, so the flusher has to ask for it again afterwards.
let quitRequested = false;
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
    void openSharedFromDeepLink(link).catch((err) => {
      logCrash("deep-link-shared-failed", err);
      showDeepLinkFailure();
    });
    return;
  }
  // A document shared with this account. The link carries no token: the app
  // fetches it with the signed-in user's own credentials, so it lands in their
  // Library synced and live rather than as a detached copy.
  if (kind === "cloud-doc") {
    // An async failure here used to vanish: the link opened nothing and said
    // nothing, which reads exactly like the app ignoring the click.
    void openCloudDocFromDeepLink(link).catch((err) => {
      logCrash("deep-link-cloud-doc-failed", err);
      showDeepLinkFailure();
    });
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

// One place to tell the user a link didn't open, so a thrown deep-link handler
// looks like a failure instead of like nothing happening.
function showDeepLinkFailure() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      message: "Couldn't open that link",
      detail: "Markie hit an unexpected error opening the document. Try the link again, or open the file directly.",
    });
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
  // Bounded: an unwritable or pathological Downloads folder must not turn one
  // shared-link click into an unbounded synchronous existsSync loop.
  while (fs.existsSync(candidate) && i <= 200) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    i++;
  }
  if (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${Date.now().toString(36)})${ext}`);
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
    writeFileAtomic(dest, content);
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
// Bounded: one entry per file the session has read, and a long session in a
// large repo reads a lot of them.
const lastSeenOnDisk = new Map();
const LAST_SEEN_LIMIT = 500;

function hashOf(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function rememberDisk(filePath, content) {
  // Delete-then-set moves the key to the end, so the eviction below drops the
  // least recently written path rather than an arbitrary one.
  lastSeenOnDisk.delete(filePath);
  lastSeenOnDisk.set(filePath, hashOf(content));
  while (lastSeenOnDisk.size > LAST_SEEN_LIMIT) {
    const oldest = lastSeenOnDisk.keys().next();
    if (oldest.done) break;
    lastSeenOnDisk.delete(oldest.value);
  }
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

// ── Watching the open document ──
// Markie already knew a file had changed underneath the user, but only at the
// moment they pressed save — after they had been typing into a stale document
// for however long, with nothing left but "discard theirs" or "discard yours".
//
// Polling via fs.watchFile rather than fs.watch: editors and agents routinely
// save by writing a temp file and renaming it over the original (Markie's own
// atomic writes included), which severs an inode-based watch silently. Polling
// survives that, and the interval is irrelevant for a single open document.
let watchedPath = null;
const WATCH_INTERVAL_MS = 1000;

function stopWatchingOpenFile() {
  if (!watchedPath) return;
  try {
    fs.unwatchFile(watchedPath);
  } catch {
    // Already gone; nothing to detach.
  }
  watchedPath = null;
}

function watchOpenFile(filePath) {
  if (watchedPath === filePath) return;
  stopWatchingOpenFile();
  if (!filePath) return;
  watchedPath = filePath;
  try {
    fs.watchFile(filePath, { interval: WATCH_INTERVAL_MS }, () => {
      // stat changing is only a hint. diskChangedSince compares content
      // hashes, so a touch, a no-op rewrite, or Markie's own save does not
      // interrupt the user with a conflict that does not exist.
      const changed = diskChangedSince(filePath);
      if (changed === null) return;
      // Somebody else's write is a version too. Recording it here is what puts
      // an agent's edit of the open document into the history list; the store
      // dedupes, so the user's own save over it does not record it twice.
      try {
        history().captureExternal(filePath);
      } catch {
        // A missing version is a smaller loss than a missed change notice.
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("file-changed-on-disk", {
          path: filePath,
          content: changed,
        });
      }
    });
  } catch {
    // Watching is an improvement, not a requirement: the save-time check still
    // catches the same conflict later.
    watchedPath = null;
  }
}

// The document the window is showing. Main already learns this on every path
// that opens or saves a file; keeping it lets the File menu know which folder
// of snapshots "Revert to Snapshot…" is about, and whether there are any.
const REVERT_MENU_ID = "revert-to-snapshot";
let currentDocPath = null;

function setCurrentDoc(filePath) {
  currentDocPath = filePath || null;
  // One owner for the watcher: every open and save path already lands here,
  // so Save As and Fork re-aim it with no renderer involvement.
  watchOpenFile(currentDocPath);
  refreshRevertMenuItem();
}

function refreshRevertMenuItem() {
  try {
    const item = Menu.getApplicationMenu()?.getMenuItemById(REVERT_MENU_ID);
    if (!item) return; // menu not built yet (startup) or not this platform
    item.enabled = !!currentDocPath && history().has(currentDocPath);
  } catch {
    // A menu that stays enabled is a dialog that explains itself instead.
  }
}

function readFilePayload(filePath, { grant = false } = {}) {
  try {
    const access = grant ? fileGrants.grantFile(filePath) : fileGrants.canRead(filePath);
    if (!access.ok) return null;
    const content = fs.readFileSync(access.path, "utf-8");
    rememberDisk(access.path, content);
    setCurrentDoc(access.path);
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

// The renderer's own document: app://markie/... in production, the Next dev
// server in development.
function isAppUrl(target) {
  const value = String(target || "");
  if (value.startsWith("app://markie/")) return true;
  if (!isDev) return false;
  const devUrl = process.env.MARKIE_DEV_URL || "http://localhost:3000";
  // Origin, not prefix: "http://localhost:3000.evil.test/" starts with the dev
  // URL but is a different site entirely.
  try {
    return new URL(value).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 600,
    minHeight: 400,
    show: false,
    // macOS only: on Windows/Linux `hiddenInset` leaves the app with no usable
    // title bar and `trafficLightPosition` has nothing to position.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 } }
      : {}),
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

  // Browse: re-scan the markdown index on window focus.
  //
  // This used to run every 20 seconds for the rest of the session once Browse
  // had been opened once — a full walk of the home directory each time, and
  // every save dialog blurs and refocuses the window. Now it needs the panel to
  // have actually asked for an index this session, and it waits five minutes
  // between walks.
  mainWindow.on("focus", () => {
    if (!_mdScanRequested) return;
    const now = Date.now();
    if (now - _mdLastScanAt < MD_RESCAN_INTERVAL_MS) return;
    if (mdindex.getCached()) mdRescanAndNotify();
  });

  // A renderer that died takes the whole document view with it and leaves a
  // white window. Say so, and offer the one action that fixes it.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logCrash("render-process-gone", details);
    if (details?.reason === "clean-exit") return;
    const target = mainWindow;
    if (!target || target.isDestroyed()) return;
    dialog
      .showMessageBox(target, {
        type: "error",
        buttons: ["Reload", "Quit"],
        defaultId: 0,
        cancelId: 0,
        message: "Markie stopped responding and had to restart its editor.",
        detail:
          "Unsaved changes in the open document may be lost. Reloading gets you back to the last saved version.",
      })
      .then(({ response }) => {
        if (response === 1) {
          app.quit();
          return;
        }
        if (target && !target.isDestroyed()) target.reload();
      })
      .catch((err) => logCrash("render-process-gone-dialog-failed", err));
  });

  mainWindow.on("unresponsive", () => {
    logCrash("window-unresponsive", "main window stopped responding");
  });

  // Nothing in Markie opens a second Electron window. A target=_blank in
  // rendered markdown should reach the user's browser, not a chrome-less window
  // with no way back.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) {
      shell.openExternal(target).catch((err) => logCrash("open-external-failed", err));
    }
    return { action: "deny" };
  });

  // The renderer's own origin is the app. A link that would navigate the whole
  // window away from it replaces Markie with a web page and strips the preload
  // bridge; send it to the browser instead.
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (isAppUrl(target)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(target)) {
      shell.openExternal(target).catch((err) => logCrash("open-external-failed", err));
    }
  });

  // Closing the window must not throw away a keystroke that has not reached
  // disk yet. Ask the renderer to settle, then destroy; destroy() bypasses the
  // close event, so the handshake always terminates. Cmd+Q goes through the
  // same interception: quit closes the window, this settles once, and
  // window-all-closed then quits as it always did.
  const closeFlusher = createCloseFlusher({
    send: (channel) => {
      // Spelled out rather than forwarded, so electron/ipc-contract.test.ts can
      // see main.js as the sender of this channel.
      if (channel !== "app-will-close") return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("app-will-close");
      }
    },
    onReady: (cb) => {
      _closeReadyCb = cb;
    },
    destroy: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    },
    quitting: () => quitRequested,
    quit: () => app.quit(),
  });
  mainWindow.on("close", (event) => {
    // No renderer to ask, or it already answered: let the close happen.
    if (closeFlusher.isSettled() || !rendererReady) return;
    event.preventDefault();
    closeFlusher.requestClose();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
    _closeReadyCb = null;
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

// Serve a picture that lives beside the open document.
//
// The renderer resolves a document's relative image against the document's own
// folder and asks for it here by absolute path. The path is not trusted for
// being in the URL: local-assets.js decides, against the folders the user has
// actually opened documents from plus their workspace roots, with realpath on
// both sides so a symlink cannot climb out. Anything else is 403, including a
// traversal, a file with the wrong extension, and a path that simply is not in
// scope. The exporter answers to the same module, so what you see is what
// travels.
function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, (request) => {
    let requested;
    try {
      // The path is one percent-encoded segment, so the standard scheme's own
      // leading slash comes off before decoding. Leave it on and an absolute
      // path arrives with two slashes in front of it, which resolves to
      // somewhere real on POSIX and nowhere at all on Windows.
      requested = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    // A standard scheme keeps the leading slash of the path; on Windows the
    // real path starts with a drive letter, so it has to come back off.
    if (process.platform === "win32" && /^\/[a-z]:/i.test(requested)) {
      requested = requested.slice(1);
    }
    if (!path.isAbsolute(requested)) return new Response("Forbidden", { status: 403 });

    // Bounded only by the folders the user has actually opened documents from,
    // their workspace roots, and files they dragged in by hand. Nothing the
    // request itself carries is allowed to widen that: passing the requested
    // file's own directory as a bound makes every path contained in itself,
    // which is a check that passes everything. It did, once, for exactly one
    // test run.
    if (!localAssets.mediaMimeFor(requested)) return new Response("Forbidden", { status: 403 });
    const real = localAssets.allowedRealPath(requested, {
      roots: fileGrants.assetRoots(),
      files: fileGrants.grantedFilePaths(),
    });
    // Checked again on the realpath: a symlink must not be able to swap a .png
    // for something else between the two.
    const mime = real ? localAssets.mediaMimeFor(real) : null;
    if (!real || !mime) return new Response("Forbidden", { status: 403 });

    // A video needs ranges or it cannot be seeked, and Chromium asks for one
    // the moment you drag the scrubber. Serving the whole file for every range
    // request also means reading a 200 MB clip into memory per seek, so this
    // streams the window that was asked for and nothing else.
    return serveFileRange(real, mime, request.headers.get("range"));
  });
}

// One file, honouring a Range header if there is one. Returns 206 with the
// slice, 200 with the whole file, or 416 when the range cannot be satisfied,
// which is what a media element expects at each of those points.
function serveFileRange(filePath, mime, rangeHeader) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const headers = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    // The renderer is the only reader and the file is local; caching a stale
    // copy of something the user just edited is the only thing this could buy.
    "Cache-Control": "no-cache",
  };

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || "").trim());
  if (!match || size === 0) {
    return new Response(streamOf(filePath), {
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
    });
  }

  // "bytes=-500" means the last 500 bytes, not "from 0 to 500".
  const suffix = match[1] === "";
  let start = suffix ? Math.max(0, size - Number(match[2] || 0)) : Number(match[1]);
  let end = suffix || match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response("Range not satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  end = Math.min(end, size - 1);

  return new Response(streamOf(filePath, start, end), {
    status: 206,
    headers: {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

// A Node read stream as a web ReadableStream, which is what Response wants.
function streamOf(filePath, start, end) {
  const node = fs.createReadStream(filePath, start === undefined ? {} : { start, end });
  return new ReadableStream({
    start(controller) {
      node.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      node.on("end", () => controller.close());
      node.on("error", (err) => controller.error(err));
    },
    cancel() {
      node.destroy();
    },
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

// ── IPC ──
// Every channel below goes through handle() instead of ipcMain.handle: a
// handler that throws would otherwise reject the renderer's invoke(), and
// almost no call site has a .catch(). The visible result was a spinner that
// never stopped. Failures now answer `{ error }` (or the `onFailure` shape the
// channel's callers already understand) and land in the crash log.
const handle = createIpcHandler({
  ipcMain,
  onError: (channel, err) => logCrash(`ipc:${channel}`, err),
});

// Export handlers answer `{ success, error }`; their callers show `error`.
function exportFailure(err) {
  return errorMessage(err);
}

// IPC: Open file dialog
handle("open-file", async (_event, args) => {
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
}, { onFailure: () => null });

// IPC: Export PDF — the hidden-window rendering lives in export-pdf.js.
const pdfExporter = createPdfExporter({
  BrowserWindow,
  fs,
  os: require("os"),
  path,
  // The same containment rule the viewer and the HTML export use. The
  // exporter's own default knows nothing about workspace roots or attachments,
  // so a report whose logo lives one folder up printed with a hole in it.
  inlineImages: (html, docDir) => inlineExportImagesFrom(html, docDir),
  onError: (err) => logCrash("export-pdf-failed", err),
});

// `args` is `{ html, theme?, docPath?, mode? }`. The bare-string form is the
// old renderer contract and still works, so a renderer and a main process from
// different builds don't produce an export of the text "[object Object]".
//
// mode "print" is ⌘P: the same hidden window and the same rendered HTML, then
// the system print sheet instead of a file. There is no destination to choose,
// so there is no save dialog either.
handle(
  "export-pdf",
  async (_event, args) => {
    const { html, docPath, mode } =
      typeof args === "string" ? { html: args } : args || {};
    if (pdfExporter.isBusy()) {
      return {
        success: false,
        error: "Markie is already exporting a PDF. Wait for that one to finish.",
      };
    }
    if (mode === "print") {
      return pdfExporter.exportPdf({ html, docPath, mode });
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: "document.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    return pdfExporter.exportPdf({ html, filePath: result.filePath, docPath });
  },
  { onFailure: (err) => ({ success: false, error: exportFailure(err) }) }
);

// IPC: write content to a known path
handle("save-file", async (_event, { filePath, content, force = false, autosave = false }) => {
  try {
    const access = fileGrants.canWrite(filePath);
    if (!access.ok) return { success: false, error: access.error };

    // Someone changed this file since Markie read it. Writing now would throw
    // their work away with no trace, so ask instead of guessing.
    //
    // `force` means the renderer already put that decision to the user — the
    // in-app conflict dialog — and they chose to overwrite. Asking again here
    // would be a second, native prompt for a question already answered.
    //
    // `autosave` means nobody asked for this write and nobody is watching it.
    // A modal would interrupt typing and a blind write would destroy the other
    // writer's work, so it refuses and hands the newer bytes back for the
    // renderer's own non-modal strip. saveConflictAction owns that decision.
    const newer = force ? null : diskChangedSince(access.path);
    const action = saveConflictAction({ autosave, force, changed: newer });
    if (action === "refuse") {
      return { success: false, code: "disk-changed", path: access.path, content: newer };
    }
    if (action === "ask") {
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

    // What the file said a moment ago, kept where "Revert to Snapshot…" can
    // find it. A save is the only moment that copy still exists.
    snapshotBeforeWrite(access.path, content);
    writeFileAtomic(access.path, content);
    rememberDisk(access.path, content);
    setCurrentDoc(access.path);
    return { success: true, path: access.path };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: write content to a user-chosen path (Save As / Fork)
// `csvContent` is optional: a table document has a markdown form and a CSV
// form, and which one belongs on disk is decided by the extension the user
// typed in the dialog. Sending both means one write instead of a write plus a
// rewrite (which left a half-correct file behind if the second one failed).
handle("save-file-as", async (_event, { defaultName, content, csvContent }) => {
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
    const useCsv = /\.csv$/i.test(result.filePath) && typeof csvContent === "string";
    const bytes = useCsv ? csvContent : content;
    // Save As over a file that already exists is still an overwrite of somebody
    // else's document. capture() skips the new-file case on its own.
    snapshotBeforeWrite(result.filePath, bytes);
    writeFileAtomic(result.filePath, bytes);
    const grant = fileGrants.grantFile(result.filePath);
    const savedPath = grant.ok ? grant.path : result.filePath;
    // Record what is now on disk, so the next save of this path does not read
    // its own write as "someone else changed this file".
    rememberDisk(savedPath, bytes);
    setCurrentDoc(savedPath);
    return {
      success: true,
      path: savedPath,
      name: path.basename(savedPath),
      wroteCsv: useCsv,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// IPC: rename the file on disk, same directory
handle("rename-file", async (_event, { oldPath, newName }) => {
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

// An HTML export that references ./diagram.png is a file that shows broken
// images the moment it is mailed anywhere. Fold the document folder's own
// images in as data: URIs first.
//
// Required lazily and defensively: this module is owned by the export track and
// may be absent in a partial checkout, and a missing picture must never be the
// reason an export fails.
function inlineExportImages(html, docPath) {
  return inlineExportImagesFrom(html, docPath ? path.dirname(String(docPath)) : null);
}

function inlineExportImagesFrom(html, docDir) {
  const text = String(html == null ? "" : html);
  if (!docDir) return text;
  try {
    const { inlineLocalImages } = require("./inline-images");
    return inlineLocalImages(text, String(docDir), {
      roots: fileGrants.assetRoots(),
      // Attachments too: a picture dragged in from the Desktop is one the user
      // chose, and an export that silently dropped it would be worse than one
      // that carries it.
      files: fileGrants.grantedFilePaths(),
    });
  } catch (err) {
    logCrash("export-html-inline-failed", err);
    return text;
  }
}

// IPC: export rendered HTML to a file
handle(
  "export-html",
  async (_event, { defaultName, html, docPath } = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName || "document.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    // The dialog returns whatever the user typed. An HTML export saved without
    // .html opens in nothing.
    const target = ensureExtension(result.filePath, ".html");
    writeFileAtomic(target, inlineExportImages(html, docPath));
    return { success: true, path: target };
  },
  { onFailure: (err) => ({ success: false, error: exportFailure(err) }) }
);

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
handle("ws-roots", () => workspace.roots(), { onFailure: () => [] });
handle("ws-default-path", () => workspace.defaultRootPath(), { onFailure: () => "" });
handle("ws-create-default", () => wsTry(() => ({ ok: true, path: workspace.createDefaultRoot() })));
handle("ws-add-root", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return workspace.addRoot(r.filePaths[0]);
});
handle("ws-remove-root", (_e, p) => wsTry(() => workspace.removeRoot(p)));
handle("ws-list-dir", (_e, p) => wsTry(() => workspace.listDir(p)));
handle("ws-mkdir", (_e, { parent, name }) => wsTry(() => workspace.mkdir(parent, name)));
handle("ws-new-file", (_e, { parent, name }) => wsTry(() => workspace.newFile(parent, name)));
handle("ws-move", (_e, { src, destDir }) => wsTry(() => workspace.move(src, destDir)));
handle("ws-rename", (_e, { target, newName }) => wsTry(() => workspace.rename(target, newName)));
handle("ws-trash", async (_e, target) => {
  try {
    return await workspace.trash(target);
  } catch (err) {
    return { error: String(err) };
  }
});
handle("ws-reveal", (_e, target) => wsTry(() => workspace.reveal(target)));

// ── Terminal IPC ──
const terminal = require("./terminal");
handle("term-available", () => terminal.available(), { onFailure: () => false });
handle("term-create", (_e, context = {}) =>
  terminal.create(
    terminal.resolveContext(context, workspace.roots()),
    (id, data) => mainWindow?.webContents.send("term-data", { id, data }),
    (id) => mainWindow?.webContents.send("term-exit", { id })
  ),
  { onFailure: () => null }
);
handle("term-write", (_e, { id, data }) => terminal.write(id, data));
handle("term-resize", (_e, { id, cols, rows }) => terminal.resize(id, cols, rows));
handle("term-kill", (_e, id) => terminal.kill(id));
handle("term-external-apps", () => terminal.externalApps(), { onFailure: () => [] });
handle("term-open-external", (_e, { app, cwd }) => terminal.openExternal(app, cwd));

handle("sync-config", (_event, cfg) => sync.setConfig(cfg));
// The renderer resolved this doc's share role against the server; the sync
// engine needs it so a save can refuse a push the server would only 403.
handle("sync-doc-role", (_event, { cloudId, role }) =>
  sync.setDocRole(cloudId, role)
);
handle("registry-track", (_event, { path: p, name, content }) => {
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
handle("registry-set-role", (_event, { path: p, role }) => {
  try {
    if (!["owner", "editor", "viewer"].includes(role)) return { error: "bad role" };
    registry.update(p, { share_role: role });
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
});

handle("registry-get", (_event, p) => {
  try {
    return registry.get(p) ?? null;
  } catch {
    return null;
  }
}, { onFailure: () => null });
// The Library indexes into `items`; a bare `{ error }` used to reach it as
// `items === undefined` and take the panel down with a TypeError.
handle("library-state", () => sync.libraryState(), {
  onFailure: (err) => ({ signedIn: false, items: [], error: errorMessage(err) }),
});
handle("doc-sync-on", (_event, { path: p, name, content }) =>
  sync.syncOn(p, name, content)
);
handle("doc-sync-off", (_event, { path: p, deleteRemote }) =>
  sync.syncOff(p, deleteRemote)
);
handle("doc-push", (_event, { path: p, name, content }) =>
  sync.push(p, name, content)
);
// Retry a push that failed, for a file the Library is showing but the renderer
// has not opened and so has no content for. "Unpushed" was added so the Library
// stops claiming a file is backed up when it is not; without this it is a state
// with a badge and no way out, because the update strip only appears when the
// *server* is ahead, which is exactly what an unpushed file usually is not.
// Same grant rule as open-file-path: a path the app itself advertised.
// Open the file manager with the file selected.
//
// Throttled: ⌘⌥R repeats while held, and every repeat is a Finder/Explorer
// activation. One window per half second is as fast as anyone can mean it.
const REVEAL_INTERVAL_MS = 500;
let _lastRevealAt = 0;
let _pendingReveal = null;
let _revealTimer = null;

function revealInFileManager(target) {
  const now = Date.now();
  const wait = REVEAL_INTERVAL_MS - (now - _lastRevealAt);
  if (wait > 0) {
    // Dropping the second reveal loses the one the user meant — they asked for
    // *this* file. Remember the latest request and show it when the window is
    // over instead.
    _pendingReveal = target;
    if (!_revealTimer) {
      _revealTimer = setTimeout(() => {
        _revealTimer = null;
        const next = _pendingReveal;
        _pendingReveal = null;
        if (next) revealInFileManager(next);
      }, wait);
      if (typeof _revealTimer.unref === "function") _revealTimer.unref();
    }
    return;
  }
  _lastRevealAt = now;
  shell.showItemInFolder(target);
}

// Show the open document in the OS file manager, selected and ready to drag
// somewhere else. Deliberately not ws-reveal: that one refuses anything outside
// a workspace root, and the document you are looking at is usually somewhere
// else entirely. A file Markie already has a read grant for is one the user
// opened, so pointing at it in Finder gives away nothing new.
handle("reveal-file", (_event, p) => {
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

handle("doc-retry-push", (_event, { path: p }) => {
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
// A successful cloud pull rewrote the open file on disk. Without recording
// what was written, lastSeenOnDisk goes stale and the watcher (and the next
// save) reports a conflict for a change the user just accepted.
function refreshDiskMemory(filePath, result) {
  if (!filePath || !result || result.error) return;
  try {
    const content =
      typeof result.content === "string"
        ? result.content
        : fs.readFileSync(filePath, "utf-8");
    rememberDisk(filePath, content);
  } catch {
    // The stale-hash prompt is annoying, not dangerous; never fail the pull.
  }
}

handle("doc-resolve", async (_event, { path: p, strategy }) => {
  const res = await sync.resolve(p, strategy);
  refreshDiskMemory(p, res);
  return res;
});
// The renderer owns which document is open (a new unsaved buffer has no path),
// so it can also say "watch nothing". Opens and saves re-aim the watcher in
// main via setCurrentDoc without any renderer call.
handle("watch-file", (_e, filePath) => {
  if (filePath) watchOpenFile(filePath);
  else stopWatchingOpenFile();
  return { ok: true };
});

// ── The crash journal ──
// Written ahead of the file debounce, so the window between "the user typed"
// and "the bytes are on disk" holds nothing that a kill would cost them.
handle(
  "draft-save",
  (_e, { path: docPath, name, content }) =>
    drafts().save({ path: docPath ?? null, name: name ?? null }, String(content ?? "")),
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) }
);
handle(
  "draft-check",
  () =>
    drafts()
      .check({
        fileMtime: (p) => {
          try {
            return fs.statSync(p).mtimeMs;
          } catch {
            return null;
          }
        },
      })
      .map((entry) => ({ ...entry, content: drafts().read(entry.key) })),
  { onFailure: () => [] }
);
handle("draft-discard", (_e, key) => drafts().discard(String(key || "")), {
  onFailure: () => ({ ok: false }),
});

// ── File history ──
// One version per committed write, plus whatever an agent or another editor
// wrote while the document was open. Reading a version never touches the file.
handle("history-list", (_e, p) => history().list(String(p || "")), {
  onFailure: () => [],
});
handle(
  "history-read",
  (_e, { path: p, stamp }) => ({ content: history().read(String(p || ""), String(stamp || "")) }),
  { onFailure: () => ({ content: null }) }
);
// Which tracked files the server is ahead of. One request for the whole
// library, called on focus and on a timer, so it has to stay cheap and quiet.
handle("doc-check-updates", () => sync.checkUpdates(), {
  onFailure: (err) => ({ updates: [], error: errorMessage(err) }),
});
// The server's copy, for showing what a pull would cost before doing it.
handle("doc-remote-content", (_event, { path: p }) =>
  sync.remoteContent(p)
);
handle("doc-keep-both", async (_event, { path: p, content }) => {
  const res = await sync.resolveKeepBoth(p, content);
  refreshDiskMemory(p, res);
  return res;
});
handle("doc-pull", async (_event, { cloudId, suggestedName }) => {
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
  if (pulled?.ok) {
    fileGrants.grantFile(pulled.path);
    refreshDiskMemory(pulled.path, pulled);
  }
  return pulled;
});

// Open a shared cloud doc with one click: save it to ~/Downloads and open it,
// no "where do you want to save" dialog. Backs the "Shared with you" list.
handle("doc-open-shared", async (_event, { cloudId, suggestedName }) => {
  const dest = downloadsUniquePath(suggestedName || "Shared document.md");
  const res = await sync.pull(cloudId, dest);
  if (res && res.error) return res;
  fileGrants.grantFile(dest);
  openLocalFile(dest);
  return { ok: true, path: dest };
});

// IPC: open a file the document links to, in whatever the OS opens it with.
//
// `[the spec](spec.pdf)` did nothing at all before this: the link resolved
// against the app's own origin, the window-open handler forwards only http(s),
// and a click that is silently discarded reads as a broken app. Same access
// rule as the pictures, so a link cannot reach further than an image can, and
// shell.openPath rather than shell.openExternal because openExternal would
// honour whatever scheme the string happens to carry.
handle("open-local-file", async (_event, { href, docDir } = {}) => {
  if (!docDir) return { ok: false, error: "Save this document first, then the link will work." };

  const target = localAssets.candidatePath(href, docDir);
  if (!target) return { ok: false, error: "That link does not point at a file." };

  // docDir resolved the relative href above; it does not authorise anything.
  // The bounds are the grants, same as the pictures.
  const allowed = localAssets.allowedRealPath(target, {
    roots: fileGrants.assetRoots(),
    files: fileGrants.grantedFilePaths(),
  });
  if (!allowed) {
    return {
      ok: false,
      error: "Markie only opens files that sit beside the document or inside your workspace.",
    };
  }

  const failure = await shell.openPath(allowed);
  // openPath answers with a message on failure and an empty string on success.
  return failure ? { ok: false, error: failure } : { ok: true };
});

// IPC: open an https URL in the system browser (OAuth flows)
handle("open-external", (_event, target) => {
  if (/^https?:\/\//i.test(target)) {
    shell.openExternal(target).catch((err) => logCrash("open-external-failed", err));
  }
});

// ── Browse: device-wide markdown index ──
// A scan walks the user's files, so it only ever runs because a panel asked
// for it. `_mdScanRequested` records that Browse or Skills opened this session;
// without it, focus alone used to be enough.
let _mdScanRequested = false;
let _mdLastScanAt = 0;
const MD_RESCAN_INTERVAL_MS = 5 * 60_000;

// A truncated scan stopped early (budget or depth cap), so it is a *subset* of
// what is out there. Persisting it over a fuller snapshot loses rows the user
// could see a moment ago, and the next launch seeds from the smaller list.
function keepCacheOverTruncated(result) {
  if (!result || !result.truncated) return false;
  const cached = mdindex.getCached();
  const kept = Array.isArray(cached?.files) ? cached.files.length : 0;
  if (kept <= (Array.isArray(result.files) ? result.files.length : 0)) return false;
  logCrash("mdindex-truncated", {
    reason: result.truncatedReason || null,
    scanned: result.files.length,
    cached: kept,
  });
  return true;
}

// Join the per-file metadata the Projects taxonomy needs (birthtime, the
// markie front matter declaration, the containing repo's name) onto index
// rows. Additive and best-effort: the index has to keep working even if the
// metadata table is unreadable, so a failure here returns the plain rows.
// True while the metadata pass still has files to get through.
let _mdMetaPending = false;

function mdRowsWithMeta(result) {
  if (!result || !Array.isArray(result.files)) return result;
  try {
    const { withMeta } = require("./mdmeta");
    const metaByPath = new Map(registry.metaAll().map((m) => [m.path, m]));
    // metaPending says the four extra fields are not all filled in yet. The
    // renderer needs it: a taxonomy built while repo names are still missing
    // collapses thousands of files into one enormous folder-derived project,
    // and showing that confidently for three seconds is worse than saying
    // "still organizing".
    return { ...result, metaPending: _mdMetaPending, files: withMeta(result.files, metaByPath) };
  } catch {
    return result;
  }
}

// Extracting metadata for a whole fresh index is 2+ seconds of synchronous
// file reads (measured on a 14.5k-file index), so it runs in slices with the
// event loop free in between rather than freezing the window once. Later
// passes touch only files whose mtime moved and finish in a millisecond.
const MD_META_SLICE_MS = 120;
let _mdMetaSliceTimer = null;

function mdRefreshMetaSliced(rows) {
  _mdMetaPending = true;
  if (_mdMetaSliceTimer) {
    clearTimeout(_mdMetaSliceTimer);
    _mdMetaSliceTimer = null;
  }
  let touched = 0;
  const step = () => {
    _mdMetaSliceTimer = null;
    try {
      const { refreshMeta } = require("./mdmeta");
      const { updated, remaining } = refreshMeta(rows, {
        registry,
        budgetMs: MD_META_SLICE_MS,
      });
      touched += updated;
      _mdMetaPending = remaining > 0;
      if (remaining > 0) {
        _mdMetaSliceTimer = setTimeout(step, 50);
        return;
      }
    } catch (err) {
      _mdMetaPending = false;
      logCrash("mdmeta-refresh-failed", err);
      return;
    }
    // The taxonomy the renderer already drew was built without this metadata.
    // Tell it once, at the end, rather than after every slice.
    if (touched > 0 && mainWindow && !mainWindow.isDestroyed()) {
      const cached = mdindex.getCached();
      if (cached) mainWindow.webContents.send("mdindex-updated", mdRowsWithMeta(cached));
    }
  };
  step();
}

// Run a fresh index scan, persist the snapshot, and tell the renderer.
async function mdRescanAndNotify() {
  _mdLastScanAt = Date.now();
  try {
    const result = await mdindex.rescan();
    _mdLastScanAt = Date.now();
    if (keepCacheOverTruncated(result)) {
      // Broadcast the fuller cache instead of the partial walk.
      const cached = mdindex.getCached();
      if (cached && mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send("mdindex-updated", mdRowsWithMeta(cached));
      return;
    }
    try { registry.saveIndexCache(result.files); } catch { /* cache best-effort */ }
    // Send the whole result, not just a timestamp. The renderer used to answer
    // this event by calling mdindex-refresh, which walked the disk a second
    // time for the same answer we already had in hand.
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("mdindex-updated", mdRowsWithMeta(result));
    mdRefreshMetaSliced(result.files);
  } catch (err) {
    logCrash("mdindex-scan-failed", err);
  }
}

// Return cached rows immediately (seeding from the DB snapshot on first call),
// and kick a background refresh.
handle("mdindex-scan", async () => {
  _mdScanRequested = true;
  if (!mdindex.getCached()) {
    try { mdindex.seed(registry.loadIndexCache(), null); } catch { /* no snapshot yet */ }
  }
  const cached = mdindex.getCached();
  if (Array.isArray(cached?.files) && cached.files.length) {
    try {
      // Cheap: one indexed count against the row total. If metadata is missing
      // for anything, the taxonomy is not ready to be believed yet.
      _mdMetaPending = _mdMetaPending || registry.metaAll().length < cached.files.length;
    } catch { /* meta is additive */ }
  }
  // Every Browse/Skills mount used to start a device-wide walk. Mounting a
  // panel is not new information about the disk, so honour the same interval
  // the focus-driven rescan does; the cached rows come back either way.
  if (Date.now() - _mdLastScanAt >= MD_RESCAN_INTERVAL_MS) {
    mdRescanAndNotify(); // fire-and-forget refresh
  }
  return mdRowsWithMeta(cached) || { files: [], scannedAt: null };
}, { onFailure: (err) => ({ files: [], scannedAt: null, error: errorMessage(err) }) });

// An explicit refresh (the Browse panel's own button) still walks now.
handle("mdindex-refresh", async () => {
  _mdScanRequested = true;
  _mdLastScanAt = Date.now();
  const result = await mdindex.rescan();
  _mdLastScanAt = Date.now();
  if (keepCacheOverTruncated(result)) return mdRowsWithMeta(mdindex.getCached() || result);
  try { registry.saveIndexCache(result.files); } catch { /* best-effort */ }
  mdRefreshMetaSliced(result.files);
  return mdRowsWithMeta(result);
}, { onFailure: (err) => ({ files: [], scannedAt: null, error: errorMessage(err) }) });

// ── Projects: virtual organization state ──
// Thin pass-throughs on purpose. main.js is untyped and untested, so the
// taxonomy engine lives in src/lib/projects and the decisions live in the
// registry; nothing here is allowed to have an opinion of its own.
handle(
  "projects-state",
  () => {
    const cached = registry.loadIndexCache();
    const fingerprint = registry.indexCacheFingerprint(cached);
    return {
      pins: registry.pinsAll(),
      blocks: registry.blocksAll(),
      projectNames: registry.projectsAll(),
      // Assignments written against a different index are stale by
      // definition, so a fingerprint mismatch reads as "no cache".
      assignments: registry.assignmentsGet(fingerprint),
      fingerprint,
      rulesKnownGood: registry.projectsConfigGet("rules-known-good"),
      rulesError: registry.projectsConfigGet("rules-error"),
    };
  },
  {
    onFailure: (err) => ({
      pins: [],
      blocks: [],
      projectNames: [],
      assignments: [],
      fingerprint: "",
      rulesKnownGood: null,
      rulesError: errorMessage(err),
    }),
  }
);

handle(
  "projects-save-cache",
  (_e, { fingerprint, assignments, blocks, rulesKnownGood } = {}) => {
    if (Array.isArray(blocks)) for (const b of blocks) registry.blockUpsert(b);
    if (Array.isArray(assignments)) {
      registry.assignmentsSave(String(fingerprint || ""), assignments);
    }
    if (typeof rulesKnownGood === "string") {
      registry.projectsConfigSet("rules-known-good", rulesKnownGood);
      registry.projectsConfigSet("rules-error", "");
    }
    return { ok: true };
  },
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) }
);

handle(
  "projects-pin",
  (_e, args) => {
    if (args && args.clear) registry.pinClear(args.path);
    else registry.pinSet(args);
    return { ok: true };
  },
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) }
);

handle(
  "projects-config",
  () => {
    const workspace = require("./workspace");
    const { ensureProjectsConfig } = require("./projects-config");
    const cfg = ensureProjectsConfig({ dir: workspace.defaultRootPath() });
    // The renderer needs the real home to resolve `~` in the user's rules, and
    // inferring it from a path is guesswork the main process does not have to
    // make anyone do.
    return { ...cfg, home: app.getPath("home") };
  },
  {
    onFailure: (err) => ({
      path: "",
      content: "",
      created: false,
      home: "",
      error: errorMessage(err),
    }),
  }
);

// Rewrites only the listing below the overview marker, from whatever is on
// disk right now, so a rule the user just typed is never clobbered. If they
// have the document open with unsaved edits, this lands as an ordinary
// external change and the existing disk-change prompt handles it.
handle(
  "projects-write-overview",
  (_e, { listing } = {}) => {
    const workspace = require("./workspace");
    const { ensureProjectsConfig, writeOverviewSection } = require("./projects-config");
    const cfg = ensureProjectsConfig({ dir: workspace.defaultRootPath() });
    const next = writeOverviewSection(cfg.content, String(listing ?? ""));
    writeFileAtomic(cfg.path, next);
    rememberDisk(cfg.path, next);
    return { ok: true, path: cfg.path };
  },
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) }
);

// Renaming a project and making one are both decisions about names only. No
// file is created, moved, or renamed on disk by either, which is the whole
// reason a virtual project is worth having.
handle(
  "projects-project-set",
  (_e, { project, customName } = {}) => {
    registry.projectSetName(project, customName ?? null);
    return { ok: true };
  },
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) }
);

handle(
  "projects-create",
  (_e, { name } = {}) => {
    const project = String(name ?? "").trim();
    if (!project) return { ok: false, error: "A project needs a name." };
    registry.projectCreate(project);
    return { ok: true, project };
  },
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) }
);

handle(
  "projects-block-set",
  (_e, { blockId, customName, mergeInto } = {}) => {
    if (typeof mergeInto === "string") registry.blockMerge(blockId, mergeInto);
    else registry.blockSetName(blockId, customName ?? null);
    return { ok: true };
  },
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) }
);

handle("mdindex-stars", () => registry.listStars(), { onFailure: () => [] });
handle("mdindex-star-toggle", (_e, { path: p, kind }) =>
  registry.toggleStar(p, kind)
);

// Where the bundled Markie MCP server lives, so the Agents dialog can hand an
// agent a working `node <path>` command. Packaged: under Resources (copied via
// extraResources); dev: the repo's mcp/ next to the app path.
handle("mcp-info", () => {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return {
    serverPath: path.join(base, "mcp", "markie-mcp.mjs"),
    packaged: app.isPackaged,
  };
}, { onFailure: (err) => ({ serverPath: "", packaged: false, error: errorMessage(err) }) });

// ── Auto-update (electron-updater → the platform's published feed) ──
// macOS updates from a signed and notarized feed, Windows from the signed NSIS
// feed the release runbook publishes alongside the installer. Which feed an
// install reads is baked into app-update.yml at pack time from
// server/download-manifest.json, so the two never cross. Linux packages can be
// built and smoke-tested locally but must not touch either feed until their
// signing, feed files, and public URLs are approved: update-policy.js is where
// that is enforced.
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
  applyUpdateChannel();

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

// Point the updater at the channel this install follows. Called at setup and
// again whenever the user flips the Settings toggle, so the change takes effect
// without a relaunch.
function applyUpdateChannel() {
  const optedIn = readBetaOptIn(app.getPath("userData"));
  const { channel, allowDowngrade } = updaterSettingsFor({
    optedIn,
    currentVersion: app.getVersion(),
  });
  autoUpdater.channel = channel;
  // Leaving beta means walking back down to stable; see update-channel.js.
  autoUpdater.allowDowngrade = allowDowngrade;
  return { optedIn, channel, allowDowngrade };
}

// IPC: renderer asks for the latest known update status / triggers a check
handle("update-status", () => updateState, { onFailure: () => "idle" });
// IPC: the beta-channel opt-in. Reachable only from inside the app, which is
// what keeps the channel unlisted — nothing on the website can enrol anyone.
handle(
  "update-channel-get",
  () => ({
    optedIn: readBetaOptIn(app.getPath("userData")),
    currentVersion: app.getVersion(),
  }),
  // Stable is the safe answer to "I can't tell", matching readBetaOptIn.
  { onFailure: () => ({ optedIn: false, currentVersion: "" }) }
);
handle(
  "update-channel-set",
  async (_e, optedIn) => {
    const saved = writeBetaOptIn(app.getPath("userData"), optedIn === true);
    if (!saved) return { ok: false, error: "Couldn't save that preference." };
    const applied = applyUpdateChannel();
    // Check straight away: opting in should find the beta now, and opting out
    // should start the walk back to stable rather than waiting up to six hours.
    requestUpdateCheck().catch(() => {});
    return { ok: true, ...applied };
  },
  { onFailure: (err) => ({ ok: false, error: errorMessage(err) }) }
);
handle("check-for-updates", () => requestUpdateCheck({ manual: true }), {
  onFailure: (err) => ({ ok: false, reason: "error", error: errorMessage(err) }),
});
// IPC: user accepted the update — quit and install the downloaded version.
//
// Answers the renderer instead of returning nothing, because a failure here is
// invisible from the other side: the button says "Restarting…" and waits for a
// quit that is never coming. On success this call does not return at all.
handle("quit-and-install", () => {
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
}, { onFailure: () => null });

// IPC: make Markie the default app for Markdown files (macOS).
// LaunchServices has no first-party CLI, so we drive it through a tiny Swift
// snippet that calls LSSetDefaultRoleHandlerForContentType for the Markdown
// UTI. Requires the Xcode command line tools (`swift`) and the *packaged*
// app — in dev the running bundle is Electron, not Markie.
const MARKIE_BUNDLE_ID = "com.zvn.markie";
const MARKDOWN_UTI = "net.daringfireball.markdown"; // covers .md + .markdown

// `swift <file>` compiles before it runs. On a cold toolchain that is seconds,
// and if the toolchain is half-installed it can be forever — with the renderer
// waiting on an invoke() that never answers.
const SWIFT_TIMEOUT_MS = 5_000;

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
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(tmp, { force: true }); } catch { /* temp file, best effort */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ error: "timeout" });
    }, SWIFT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => {
      finish({ error: err.code === "ENOENT" ? "swift-missing" : String(err) });
    });
    child.on("exit", (code) => {
      finish({ code, stdout: out.trim() });
    });
  });
}

// IPC: is Markie already the default handler for Markdown? Lets the UI hide
// the "set default" prompt when it's already set, instead of nagging.
// Cached: the Library asks on every mount, and the answer only changes when
// this app changes it (set-default-md clears the cache) or the user changes it
// in System Settings, which is not worth a Swift compile per panel open.
let _defaultMdStatus = null;

handle("default-md-status", async () => {
  if (!supportsMarkdownDefaultHandler({ platform: process.platform, isPackaged: app.isPackaged })) {
    return { supported: false, isDefault: false };
  }
  if (_defaultMdStatus) return _defaultMdStatus;
  const res = await runSwift(
    [
      "import Foundation",
      "import CoreServices",
      `let h = LSCopyDefaultRoleHandlerForContentType("${MARKDOWN_UTI}" as CFString, .all)?.takeRetainedValue() as String?`,
      'print(h ?? "")',
    ].join("\n")
  );
  // Cache the failure too. A missing Swift toolchain or a LaunchServices
  // timeout answers the same way every time this session, and re-running the
  // compile per panel mount only makes the panel slower.
  if (res.error) {
    _defaultMdStatus = { supported: false, isDefault: false };
    return _defaultMdStatus;
  }
  _defaultMdStatus = {
    supported: true,
    isDefault: res.stdout.toLowerCase() === MARKIE_BUNDLE_ID,
  };
  return _defaultMdStatus;
}, { onFailure: () => ({ supported: false, isDefault: false }) });

handle("set-default-md", async () => {
  const unsupported = markdownDefaultHandlerUnavailable({
    platform: process.platform,
    isPackaged: app.isPackaged,
  });
  if (unsupported) return unsupported;
  _defaultMdStatus = null; // whatever it was, this call is about to change it
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
  if (res.error === "timeout") {
    return { ok: false, error: "LaunchServices didn't answer in time. Try again." };
  }
  if (res.error) return { ok: false, error: res.error };
  return res.code === 0
    ? { ok: true }
    : { ok: false, error: "LaunchServices rejected the change." };
});

// IPC: renderer signals it has mounted and asks for any queued file
handle("get-initial-file", () => {
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
}, { onFailure: () => null });

// IPC: Open file from a path already granted by a dialog, OS event, drop, or workspace root.
// A path the app itself advertised to the renderer — a Library/Recent registry
// entry or a Browse/Skills index hit — is the user's own listed markdown, so
// clicking it must open. Grant those; everything else still needs a prior
// grant (open dialog, drag-drop, deep link) or a workspace root.
// The index can hold tens of thousands of rows and this runs on every open, so
// the membership test is a Set built once per scan rather than a linear scan
// per click. Keyed on the cached result object: a new scan replaces it.
let _advertisedSource = null;
let _advertisedPaths = null;

function advertisedPathSet() {
  const cached = mdindex.getCached();
  if (!cached) return null;
  if (_advertisedSource !== cached) {
    _advertisedSource = cached;
    _advertisedPaths = new Set((cached.files || []).map((f) => f.path));
  }
  return _advertisedPaths;
}

function isAdvertisedPath(p) {
  try {
    if (registry.get(p)) return true;
  } catch {
    // registry unavailable — fall through to the index
  }
  return !!advertisedPathSet()?.has(p);
}

handle("open-file-path", async (_event, filePath) => {
  return readFilePayload(filePath, { grant: isAdvertisedPath(filePath) });
}, { onFailure: () => null });

// Synchronous so preload can grant a dropped/selected File before renderer code
// calls open-file-path with the returned path.
// The renderer's error boundary reports here. `send`, not `invoke`: the
// renderer is mid-crash and has nothing useful to do with an answer. Only the
// three strings are kept, and each is capped — a stack from a loop can be
// megabytes, and this is a log file the user is meant to be able to read.
const RENDERER_DETAIL_LIMIT = 8 * 1024;
function sanitizeRendererDetail(detail) {
  const out = {};
  if (!detail || typeof detail !== "object") return out;
  let budget = RENDERER_DETAIL_LIMIT;
  for (const key of ["source", "scope", "message", "stack", "componentStack"]) {
    const value = detail[key];
    if (typeof value !== "string" || value === "" || budget <= 0) continue;
    out[key] = value.length > budget ? value.slice(0, budget) : value;
    budget -= out[key].length;
  }
  return out;
}

ipcMain.on("log-renderer-error", (_event, detail) => {
  logCrash("renderer", sanitizeRendererDetail(detail));
});

// Crash-report consent. Fail closed on both: an unreadable consent file must
// read as "no", and an unresolvable DSN as "don't offer the switch at all".
handle(
  "crash-consent-get",
  () => ({
    enabled: readCrashConsent(app.getPath("userData")),
    available: Boolean(crashDsn()),
  }),
  { onFailure: () => ({ enabled: false, available: false }) }
);
handle(
  "crash-consent-set",
  (_e, enabled) => {
    const saved = writeCrashConsent(app.getPath("userData"), enabled === true);
    return saved
      ? { ok: true, enabled: enabled === true }
      : { ok: false, error: "Couldn't save that preference." };
  },
  // The settings UI truth-tests res.ok; the default { error } shape would
  // read as a silent success.
  { onFailure: () => ({ ok: false, error: "Couldn't save that preference." }) }
);
// revealCrashLog is a hoisted declaration below; it already shows the
// "no crashes recorded yet" dialog when the log is empty.
handle("crash-log-reveal", () => {
  revealCrashLog();
  return { ok: true };
}, { onFailure: () => ({ ok: false }) });

ipcMain.on("grant-file-path", (event, filePath) => {
  const grant = fileGrants.grantFile(filePath);
  event.returnValue = grant.ok;
});

// A file dragged onto a document, which is a different thing from a file
// dragged into the app to open. Any type is allowed, because an attachment is
// a picture, a clip, a PDF or a zip, and the grant it earns is only "this one
// file may be shown or opened", never "this file may be loaded or written".
// Synchronous to match grant-file-path: the drop handler needs an answer before
// it decides whether it handled the drop, and the work is a stat.
ipcMain.on("attach-file-path", (event, filePath) => {
  const grant = fileGrants.grantAttachment(filePath);
  event.returnValue = grant.ok ? grant.path : null;
});

// App menu
//
// The app-name menu is a macOS convention, and `hide`/`hideOthers`/`unhide` are
// macOS roles: on Windows the same template renders a stray "Markie" menu full
// of items that do nothing. Elsewhere its useful entries move into File.
const isMac = process.platform === "darwin";

// Show the crash log so a bug report can carry it. Not an IPC channel: the
// renderer is exactly the thing that may have just died.
function revealCrashLog() {
  try {
    const target = crashLog().path;
    // Creating the file to reveal it hands the user an empty log and makes
    // "nothing has gone wrong" look like "we lost the record".
    if (!target || !fs.existsSync(target)) {
      dialog.showMessageBox(
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
        {
          type: "info",
          message: "No crashes have been recorded yet.",
          detail: "If Markie does crash, this is where the report will be.",
        }
      );
      return;
    }
    shell.showItemInFolder(target);
  } catch (err) {
    logCrash("reveal-crash-log-failed", err);
  }
}

// Finder on macOS, File Explorer on Windows, and neither name is right on Linux.
const crashLogMenuLabel =
  process.platform === "darwin"
    ? "Reveal Crash Log in Finder"
    : process.platform === "win32"
      ? "Show Crash Log in Explorer"
      : "Show Crash Log";

const settingsItem = {
  label: "Settings…",
  accelerator: "CmdOrCtrl+,",
  click: () => mainWindow?.webContents.send("menu-settings"),
};

const updatesItem = {
  label: "Check for Updates…",
  click: () => requestUpdateCheck({ manual: true }),
};

const template = [
  ...(isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            settingsItem,
            updatesItem,
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : []),
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
        id: REVERT_MENU_ID,
        label: "History…",
        // Enabled by refreshRevertMenuItem() once the open document has
        // versions; an item that opens an empty list is worse than a grey one.
        enabled: false,
        click: () => mainWindow?.webContents.send("menu-history"),
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
      ...(isMac
        ? [{ role: "close" }]
        : [settingsItem, updatesItem, { type: "separator" }, { role: "quit" }]),
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
      // `zoom` and `front` are macOS window roles; on Windows they render as
      // dead entries.
      ...(isMac ? [{ role: "zoom" }, { type: "separator" }, { role: "front" }] : []),
    ],
  },
  {
    role: "help",
    submenu: [
      {
        label: crashLogMenuLabel,
        click: () => revealCrashLog(),
      },
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
    registerAssetProtocol();
    setupCSP();
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    // The menu is built after the first file may already have been opened.
    refreshRevertMenuItem();
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
  // The poll keeps a live handle; without this, packaging smokes and quit on
  // win32/linux can hold the process open past teardown.
  stopWatchingOpenFile();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  quitRequested = true;
  stopWatchingOpenFile();
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
