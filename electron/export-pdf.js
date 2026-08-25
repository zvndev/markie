// PDF export and real printing, out of main.js so both can be tested with
// fakes. `mode: "print"` reuses everything below except the last step: the
// system print sheet instead of printToPDF, and no destination file.
//
// The old inline version handed the whole document to loadURL as a
// data:text/html URL. encodeURIComponent triples the byte count, Chromium caps
// a navigation URL around 2 MiB, and past that the export produced a blank PDF
// or took the main process down with it. It also slept a fixed 500 ms and hoped
// layout was finished, never timed out, and let a second export start while the
// first still owned a hidden renderer.
//
// So: a real temp file, a real readiness signal, one export at a time, and a
// hard deadline — with the window destroyed and the temp file removed on every
// exit path.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 8_000;

const SYSTEM_PRINT_OPTIONS = { silent: false };

const PRINT_OPTIONS = {
  printBackground: true,
  preferCSSPageSize: true,
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
};

// Give the caller something it can put in front of a person. Error objects
// from Chromium read like "Error: ERR_ABORTED (-3) loading 'file:///…'".
function messageOf(err) {
  const raw =
    err && typeof err.message === "string" ? err.message : String(err);
  return raw.replace(/^Error:\s*/, "") || "The export failed.";
}

// Force the extension the format needs. The save dialog hands back whatever the
// user typed, and "notes" saved as a PDF is a file the OS opens in nothing.
function ensureExtension(filePath, ext) {
  const p = String(filePath || "");
  if (!p) return p;
  return p.toLowerCase().endsWith(ext.toLowerCase()) ? p : p + ext;
}

function withTimeout(promise, ms, message) {
  if (!(ms > 0)) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

// Resolves once web fonts have loaded and two frames have been painted, or
// after its own timeout — a document that never settles should still export
// something rather than hang until the outer deadline.
function readyScript(readyTimeoutMs) {
  return `new Promise(function (resolve) {
    var done = false;
    function finish() { if (!done) { done = true; resolve(true); } }
    setTimeout(finish, ${Number(readyTimeoutMs) || 0});
    var fonts = (document.fonts && document.fonts.ready) || Promise.resolve();
    Promise.resolve(fonts).then(function () {
      requestAnimationFrame(function () { requestAnimationFrame(finish); });
    }).catch(finish);
  })`;
}

// The user dismissing the system print sheet is not a failure, and it should
// not put a red banner in front of them. Chromium reports it as a failed print
// with a reason string, which is the only thing there is to match on.
function isCancellation(reason) {
  return /cancel/i.test(String(reason || ""));
}

// Images in the document are relative to the folder it was opened from, and
// the export renders from a temp directory where those paths mean nothing. The
// module is required lazily so an exporter built without it still works.
function defaultInlineImages(html, docDir) {
  const { inlineLocalImages } = require("./inline-images");
  return inlineLocalImages(html, docDir);
}

function createPdfExporter(deps) {
  const {
    BrowserWindow,
    fs,
    os,
    path,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    printOptions = PRINT_OPTIONS,
    systemPrintOptions = SYSTEM_PRINT_OPTIONS,
    inlineImages = defaultInlineImages,
    onError = () => {},
  } = deps;

  // One hidden renderer at a time. Without this, a user who clicks Export twice
  // (or holds the shortcut) spawns renderer processes that are never reclaimed.
  let inFlight = false;

  function alive(win) {
    return !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
  }

  // Chromium's print() is callback shaped, and a rejected promise is what the
  // surrounding timeout and cleanup already understand.
  function systemPrint(win) {
    return new Promise((resolve, reject) => {
      win.webContents.print(systemPrintOptions, (success, failureReason) => {
        if (success) resolve({ printed: true });
        else if (isCancellation(failureReason)) resolve({ canceled: true });
        else reject(new Error(failureReason || "The print job failed."));
      });
    });
  }

  // Load and layout only. The final step (printToPDF or the system print
  // sheet) is applied at the call site, because the two deserve different
  // deadlines: rendering a document is Markie's work and gets a timeout, but
  // a person choosing a printer and page range in the system sheet takes as
  // long as they take, and expiring a timer under the open sheet would
  // destroy the window out from under it.
  async function settle(win, tmpFile) {
    await win.loadFile(tmpFile);
    if (!alive(win)) throw new Error("The export window closed before it finished.");
    try {
      await win.webContents.executeJavaScript(readyScript(readyTimeoutMs), true);
    } catch {
      // Best effort. A document that refuses to report readiness still prints.
    }
    if (!alive(win)) throw new Error("The export window closed before it finished.");
  }

  // The document folder's images, folded in before the HTML leaves for a temp
  // directory. A failure here costs pictures, never the export.
  function prepare(html, docPath) {
    const text = String(html == null ? "" : html);
    if (!docPath) return text;
    try {
      return inlineImages(text, path.dirname(String(docPath)));
    } catch (err) {
      try { onError(err); } catch { /* reporting must not mask the export */ }
      return text;
    }
  }

  // Two shapes are accepted because main.js may hand the channel payload
  // straight through or split it into a second options argument. Later wins.
  async function exportPdf(args = {}, extra = {}) {
    const opts = { ...(args || {}), ...(extra || {}) };
    const { html, filePath, docPath } = opts;
    const printing = opts.mode === "print";
    if (inFlight) {
      return {
        success: false,
        error: "Markie is already exporting a PDF. Wait for that one to finish.",
      };
    }
    if (!printing && !filePath) {
      return { success: false, error: "No destination was chosen." };
    }
    const target = printing ? null : ensureExtension(filePath, ".pdf");
    // The document being exported is the user's private text, and /tmp is world
    // readable. A predictable name there is also a symlink-swap invitation: a
    // local attacker who wins the race gets the write. mkdtemp gives a 0700
    // directory nobody else can even list, and `wx` refuses to follow anything
    // that is already sitting at the destination.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-export-"));
    const tmpFile = path.join(tmpDir, "doc.html");
    inFlight = true;
    let win = null;
    try {
      fs.writeFileSync(tmpFile, prepare(html, docPath), {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
      win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      // The exported HTML is document content: it can carry a link, a form, or
      // a script that tries to open a window or navigate this hidden renderer
      // somewhere it can be talked to. Neither is ever part of printing a page.
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      await withTimeout(
        settle(win, tmpFile),
        timeoutMs,
        printing
          ? "The document took too long to lay out and the print was stopped."
          : "The PDF export took too long and was stopped."
      );
      if (printing) {
        // No timeout here: the system print sheet is open and the person is
        // allowed to think.
        const outcome = await systemPrint(win);
        if (outcome && outcome.canceled) return { success: false, canceled: true };
        return { success: true, printed: true };
      }
      const rendered = await withTimeout(
        win.webContents.printToPDF(printOptions),
        timeoutMs,
        "The PDF export took too long and was stopped."
      );
      fs.writeFileSync(target, rendered);
      return { success: true, path: target };
    } catch (err) {
      try { onError(err); } catch { /* reporting must not mask the failure */ }
      return { success: false, error: messageOf(err) };
    } finally {
      inFlight = false;
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {
        // already gone
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // a stray temp file is better than a failed export report
      }
    }
  }

  return { exportPdf, isBusy: () => inFlight };
}

module.exports = {
  createPdfExporter,
  ensureExtension,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
};
