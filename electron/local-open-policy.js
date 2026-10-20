// What a click on a link inside a document may launch.
//
// A link is authored by whoever wrote the document, and a README in a cloned
// repository is written by a stranger. `shell.openPath` on `./setup.command`
// runs it, and files from `git clone` carry no quarantine flag, so Gatekeeper
// never asks. So a link opens a file directly only when opening it is passive:
// documents, PDFs, pictures, audio and video. Anything else (scripts, apps,
// installers, and bundles that are really folders) is shown in Finder instead,
// where running it is a deliberate second step.
const path = require("path");

const PASSIVE_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "text", "log", "csv", "tsv", "json", "yaml", "yml", "xml", "wd",
  "html", "htm", "pdf", "rtf", "rtfd", "doc", "docx", "odt", "ods", "odp", "xls", "xlsx", "ppt", "pptx",
  "pages", "numbers", "key", "epub",
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg", "bmp", "tif", "tiff", "ico",
  "mp3", "m4a", "wav", "aac", "flac", "ogg", "opus", "aiff",
  "mp4", "mov", "m4v", "webm", "avi", "mkv",
]);

/** "open" to hand to the default app, "reveal" to show it in Finder instead. */
function localOpenAction(filePath, isDirectory) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  // A plain folder opens in Finder, which is passive. A folder with an
  // extension is a bundle (.app, .pkg, .bundle, .workflow): show, never launch.
  if (isDirectory) return ext ? "reveal" : "open";
  return PASSIVE_EXTENSIONS.has(ext) ? "open" : "reveal";
}

module.exports = { localOpenAction, PASSIVE_EXTENSIONS };
