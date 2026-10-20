// Which file types Markie offers to become the default app for, and the
// Swift that asks LaunchServices about them.
//
// Only formats Markie edits completely are offered. DOCX, RTF, ODT and legacy
// DOC still lock some documents read-only, and being the app a double-click
// lands in is a promise that the file will just work, so they are listed as
// not yet available rather than left out without explanation.
const MARKIE_BUNDLE_ID = "com.zvn.markie";

const DEFAULT_APP_FORMATS = Object.freeze([
  { id: "markdown", label: "Markdown", extensions: [".md", ".markdown", ".mdx"], utis: ["net.daringfireball.markdown"] },
  { id: "text", label: "Plain text", extensions: [".txt", ".text", ".log"], utis: ["public.plain-text", "com.apple.log"] },
  { id: "darkmown", label: "Darkmown", extensions: [".wd"], utis: ["com.zvn.markie.darkmown"] },
  { id: "csv", label: "CSV", extensions: [".csv"], utis: ["public.comma-separated-values-text"] },
  { id: "json", label: "JSON", extensions: [".json"], utis: ["public.json"] },
  { id: "yaml", label: "YAML", extensions: [".yaml", ".yml"], utis: ["public.yaml"] },
  { id: "xml", label: "XML", extensions: [".xml"], utis: ["public.xml"] },
].map((format) => Object.freeze(format)));

// Shown, disabled, with the reason. Kept here so the UI and the packaging
// declarations cannot disagree about what is and is not offered.
const PENDING_DEFAULT_FORMATS = Object.freeze([
  { id: "docx", label: "Word", extensions: [".docx"], reason: "Some Word features still open read-only." },
  { id: "rtf", label: "Rich Text", extensions: [".rtf"], reason: "Tables and images in RTF still open read-only." },
  { id: "odt", label: "OpenDocument", extensions: [".odt"], reason: "Some OpenDocument features still open read-only." },
].map((format) => Object.freeze(format)));

const UTI_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

function formatById(id) {
  return DEFAULT_APP_FORMATS.find((format) => format.id === id) || null;
}

/** Swift that prints one "uti<TAB>bundle id" line per content type. */
function statusScript(utis) {
  const list = utis.filter((uti) => UTI_RE.test(uti));
  return [
    "import Foundation",
    "import CoreServices",
    `for t in [${list.map((uti) => JSON.stringify(uti)).join(", ")}] {`,
    "  let h = LSCopyDefaultRoleHandlerForContentType(t as CFString, .all)?.takeRetainedValue() as String?",
    '  print("\\(t)\\t\\(h ?? "")")',
    "}",
  ].join("\n");
}

/** Swift that claims every content type, exiting non-zero if any refused. */
function setScript(utis, bundleId = MARKIE_BUNDLE_ID) {
  const list = utis.filter((uti) => UTI_RE.test(uti));
  return [
    "import Foundation",
    "import CoreServices",
    "var failed = 0",
    `for t in [${list.map((uti) => JSON.stringify(uti)).join(", ")}] {`,
    `  if LSSetDefaultRoleHandlerForContentType(t as CFString, .all, ${JSON.stringify(bundleId)} as CFString) != 0 { failed += 1 }`,
    "}",
    "exit(failed == 0 ? 0 : 1)",
  ].join("\n");
}

/** Per-format status from statusScript output. A format is Markie's only when every one of its types is. */
function parseStatus(stdout, bundleId = MARKIE_BUNDLE_ID) {
  const handlers = new Map();
  for (const line of String(stdout || "").split("\n")) {
    const [uti, handler = ""] = line.trim().split("\t");
    if (uti) handlers.set(uti, handler.trim().toLowerCase());
  }
  return DEFAULT_APP_FORMATS.map((format) => ({
    id: format.id,
    label: format.label,
    extensions: format.extensions,
    isDefault: format.utis.every((uti) => handlers.get(uti) === bundleId),
  }));
}

module.exports = {
  MARKIE_BUNDLE_ID, DEFAULT_APP_FORMATS, PENDING_DEFAULT_FORMATS, formatById, statusScript, setScript, parseStatus,
};
