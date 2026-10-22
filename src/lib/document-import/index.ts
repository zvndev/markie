import { extractHtmlText } from "./html";
import { extractOdtText } from "./odt";
import { extractRtfText } from "./rtf";
import { DocumentImportError, resolveDocumentImportLimits, type AdditionalDocumentInput, type AdditionalDocumentConversion, type DocumentImportLimits } from "./types";
export * from "./types";

/** Creates an explicitly named new UTF-8 text copy. Never writes or relabels the source. */
export async function convertAdditionalDocument(input: AdditionalDocumentInput, overrides: Partial<DocumentImportLimits> = {}): Promise<AdditionalDocumentConversion> {
  try {
    const limits = resolveDocumentImportLimits(overrides);
    if (!input || !["rtf", "html", "odt"].includes(input.format) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 256 || /[\x00-\x1f\x7f/\\]/.test(input.name)) throw new DocumentImportError("unsupported", "Choose a named RTF, HTML or ODT source file.");
    if (!ArrayBuffer.isView(input.bytes) || Object.prototype.toString.call(input.bytes) !== "[object Uint8Array]") throw new DocumentImportError("malformed", "Source bytes must be an unsigned byte array.");
    if (input.bytes.byteLength > limits.maxInputBytes) throw new DocumentImportError("limit-exceeded", "Source exceeds the document-import byte budget.");
    const name = input.name, format = input.format;
    const bytes = new Uint8Array(input.bytes);
    const result = format === "rtf" ? extractRtfText(bytes, limits) : format === "html" ? extractHtmlText(bytes, limits) : await extractOdtText(bytes, limits);
    if (result.text.length > limits.maxTextCodeUnits) throw new DocumentImportError("limit-exceeded", "Converted text exceeds the character budget.");
    const warnings = [...result.warnings];
    const text = result.text.replace(/\r\n?/g, "\n").replace(/\v/g, "\n").replace(/\f/g, "\n\n").replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "").toWellFormed();
    if (text !== result.text) warnings.push("Source control characters/newline encoding were normalized or omitted for a safe editable UTF-8 text copy.");
    const outputBytes = new TextEncoder().encode(text);
    if (outputBytes.length > limits.maxOutputBytes) throw new DocumentImportError("limit-exceeded", "Converted UTF-8 text exceeds the output byte budget.");
    const stem = name.replace(/\.[^.]*$/, "").slice(0, 220).toWellFormed() || "Document";
    return { ok: true, kind: "converted-text-copy", sourceFormat: format, name: `${stem} converted.txt`, text, bytes: outputBytes, warnings, canWriteOriginal: false };
  } catch (error) {
    return { ok: false, error: { code: error instanceof DocumentImportError ? error.code : "malformed", message: error instanceof DocumentImportError ? error.message : "This document could not be safely converted. The original is unchanged." } };
  }
}
