// Which file types Markie offers to become the default app for, and the
// Swift that asks LaunchServices about them.
//
// Offered: the document formats people actually double-click. Structured data
// (CSV, JSON, YAML, XML) and logs are not offered: Markie opens them from
// Open… or Open With, but taking them over from a spreadsheet or code editor
// is not what Markie is for. Word, RTF and OpenDocument carry a note, because
// a file using a feature Markie cannot save yet opens read-only.
const MARKIE_BUNDLE_ID = "com.zvn.markie";

const DEFAULT_APP_FORMATS = Object.freeze([
  { id: "markdown", label: "Markdown", extensions: [".md", ".markdown", ".mdx"], utis: ["net.daringfireball.markdown"] },
  { id: "text", label: "Plain text", extensions: [".txt", ".text"], utis: ["public.plain-text"] },
  { id: "darkmown", label: "Darkmown", extensions: [".wd"], utis: ["com.zvn.markie.darkmown"] },
  { id: "docx", label: "Word", extensions: [".docx"], utis: ["org.openxmlformats.wordprocessingml.document"], note: "Files using features Markie can't save yet open read-only." },
  { id: "rtf", label: "Rich Text", extensions: [".rtf"], utis: ["public.rtf"], note: "Files with tables or images open read-only." },
  { id: "odt", label: "OpenDocument", extensions: [".odt"], utis: ["org.oasis-open.opendocument.text"], note: "Files using features Markie can't save yet open read-only." },
].map((format) => Object.freeze(format)));

// Shown, disabled, with the reason. Kept here so the UI and the packaging
// declarations cannot disagree about what is and is not offered.
// Each entry: { id, label, extensions, reason }. Empty while every format
// Markie can open is offered above.
const PENDING_DEFAULT_FORMATS = Object.freeze([]);

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
    ...(format.note ? { note: format.note } : {}),
    isDefault: format.utis.every((uti) => handlers.get(uti) === bundleId),
  }));
}

module.exports = {
  MARKIE_BUNDLE_ID, DEFAULT_APP_FORMATS, PENDING_DEFAULT_FORMATS, formatById, statusScript, setScript, parseStatus,
};
