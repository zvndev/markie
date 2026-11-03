// Export a converted copy of the open document (Word, RTF, OpenDocument,
// plain text or Markdown) through the native save sheet.
//
// The renderer produces the bytes (src/lib/export-formats.ts); main only asks
// where they go and writes them. Main does not trust the renderer's idea of a
// format: the filter, the extension and the size cap come from this table, so
// a renderer cannot use this channel to write an arbitrary file type or an
// unbounded buffer. The source document is never touched.
const FORMATS = Object.freeze({
  docx: Object.freeze({ name: "Word Document", extension: "docx" }),
  rtf: Object.freeze({ name: "Rich Text Format", extension: "rtf" }),
  odt: Object.freeze({ name: "OpenDocument Text", extension: "odt" }),
  txt: Object.freeze({ name: "Plain Text", extension: "txt" }),
  md: Object.freeze({ name: "Markdown", extension: "md" }),
});

// Generous for a converted document, small enough that a runaway renderer
// cannot fill the disk through one call.
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

function ensureExtension(filePath, extension) {
  const p = String(filePath || "");
  if (!p) return p;
  return p.toLowerCase().endsWith(`.${extension}`) ? p : `${p}.${extension}`;
}

// The suggested name is a name, never a path: anything after the last slash,
// without control characters, and given the format's extension.
function suggestedName(defaultName, format) {
  const raw = typeof defaultName === "string" ? defaultName : "";
  const base = raw.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200) || `document.${format.extension}`;
  return ensureExtension(base, format.extension);
}

function validate(args) {
  if (!args || typeof args !== "object") throw new Error("Export needs a format and the document's bytes.");
  const format = Object.hasOwn(FORMATS, args.format) ? FORMATS[args.format] : null;
  if (!format) throw new Error("Markie cannot export to that format.");
  const data = args.data;
  if (!(data instanceof Uint8Array)) throw new Error("The exported document arrived empty.");
  if (data.byteLength > MAX_EXPORT_BYTES) throw new Error("This document is too large to export in that format.");
  return { format, data };
}

/**
 * @param {{ dialog: { showSaveDialog: Function }, getWindow: () => unknown, writeFile: (target: string, data: Buffer) => void }} deps
 */
function createDocumentExporter({ dialog, getWindow, writeFile }) {
  return async function exportDocument(args) {
    const { format, data } = validate(args);
    const result = await dialog.showSaveDialog(getWindow(), {
      defaultPath: suggestedName(args.defaultName, format),
      filters: [{ name: format.name, extensions: [format.extension] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    // The sheet returns whatever the user typed; a Word file saved without
    // .docx opens in nothing.
    const target = ensureExtension(result.filePath, format.extension);
    writeFile(target, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return { success: true, path: target };
  };
}

module.exports = { FORMATS, MAX_EXPORT_BYTES, createDocumentExporter, suggestedName };
