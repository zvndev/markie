import { applyDocxOperations, createDocx, exportDocx, getDocxImageBytes, openDocx, replaceDocxText, replaceDocxRange, DocxError, type DocxOperation, type DocxTextEdit } from "./docx";
import { applyRtfOperations, createRtf, exportRtf, isSameRtfSource, openRtf, replaceRtfText } from "./rtf";
import { applyOdtOperations, createOdt, exportOdt, isSameOdtSource, openOdt, replaceOdtText } from "./odt";
import type { RichDocument } from "./rich-text-types";
export type { RichDocument, NativeRichDocument } from "./rich-text-types";
import type { RichTextRange, RichRangeResult } from "./rich-range-types";
export type { RichTextPosition, RichTextRange, RichRangeResult } from "./rich-range-types";

export function replaceRichRange<T extends RichDocument>(document: T, range: RichTextRange, text: string): RichRangeResult<T> {
  if (document.format !== "docx") throw new DocxError("unsupported-operation", "Source-preserving structural range edits are not yet supported for this format.");
  return replaceDocxRange(document, range, text) as RichRangeResult<T>;
}

/** New native formats may only replace snapshots from their own opened source lineage. */
export function sameRichSource(a: RichDocument, b: RichDocument): boolean {
  if (a.format !== b.format) return false;
  if (a.format === "rtf" && b.format === "rtf") return isSameRtfSource(a, b);
  if (a.format === "odt" && b.format === "odt") return isSameOdtSource(a, b);
  return a.format === "docx" && b.format === "docx";
}

export function getRichCapabilities(document: RichDocument) {
  const editable = document.canEdit;
  const word = editable && document.format === "docx";
  return { runFormatting: editable, paragraphFormatting: editable, pageLayout: editable, tables: word, images: word, lists: word, hyperlinks: word, pageBreaks: word, review: word, namedStyles: word } as const;
}
export async function openRichDocument(format: RichDocument["format"], bytes: Uint8Array): Promise<RichDocument> {
  if (format === "docx") return openDocx(bytes);
  if (format === "rtf") return openRtf(bytes);
  if (format === "odt") return openOdt(bytes);
  throw new DocxError("unsupported-format", "Unsupported rich document format.");
}
export async function createRichDocument(format: RichDocument["format"], text = ""): Promise<RichDocument> {
  if (format === "docx") return createDocx(text);
  if (format === "rtf") return createRtf(text);
  if (format === "odt") return createOdt(text);
  throw new DocxError("unsupported-format", "Unsupported rich document format.");
}
export function applyRichOperations<T extends RichDocument>(document: T, operations: readonly DocxOperation[]): T {
  if (document.format === "docx") return applyDocxOperations(document, operations) as T;
  if (operations.some((op) => !["format-run", "format-range", "replace-paragraph", "insert-paragraph", "delete-paragraph", "format-paragraph", "set-page-layout"].includes(op.type))) throw new DocxError("unsupported-operation", "This format does not support that editing command.");
  return (document.format === "rtf" ? applyRtfOperations(document, operations) : applyOdtOperations(document, operations)) as T;
}
export function replaceRichText<T extends RichDocument>(document: T, edits: readonly DocxTextEdit[]): T {
  return (document.format === "docx" ? replaceDocxText(document, edits) : document.format === "rtf" ? replaceRtfText(document, edits) : replaceOdtText(document, edits)) as T;
}
export async function exportRichDocument(document: RichDocument): Promise<Uint8Array> {
  return document.format === "docx" ? exportDocx(document) : document.format === "rtf" ? exportRtf(document) : exportOdt(document);
}
export function getRichImageBytes(document: RichDocument, imageId: string): Uint8Array {
  if (document.format !== "docx") throw new DocxError("unsupported-operation", "Images are not supported in this document format.");
  return getDocxImageBytes(document, imageId);
}
