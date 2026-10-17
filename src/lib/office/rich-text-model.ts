import { DocxError, type DocxOperation, type DocxParagraph, type DocxRun, type DocxRunFormat, type DocxRunStyle, type DocxTextEdit } from "./docx-types";
import { encodeTextDocument } from "../document-formats";
import type { NativeRichDocument, RichParagraphInput, RichSnapshotOptions } from "./rich-text-types";

const owned = new WeakMap<NativeRichDocument, number>();
const defaultLayout = Object.freeze({ widthPoints: 612, heightPoints: 792, orientation: "portrait" as const, marginTopPoints: 72, marginRightPoints: 72, marginBottomPoints: 72, marginLeftPoints: 72 });
const fields = ["bold", "italic", "underline", "color", "fontFamily", "fontSizePoints"] as const;
function invalid(message: string): never { throw new DocxError("invalid-edit", message); }
function text(value: string): string {
  if (typeof value !== "string" || value.length > 1_000_000) invalid("Document text exceeds the supported limit.");
  encodeTextDocument(value);
  return value;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalid("Formatting value is out of range.");
  return value;
}
function stylePatch(source: Readonly<DocxRunStyle>, patch: DocxRunFormat): Readonly<DocxRunStyle> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((k) => !fields.includes(k as typeof fields[number]))) invalid("Unsupported run formatting.");
  const result = { ...source };
  for (const field of fields) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) { delete result[field]; continue; }
    if ((field === "bold" || field === "italic") && typeof value !== "boolean") invalid("Bold and italic must be boolean.");
    if (field === "underline" && !["none", "single", "double", "dotted", "dash", "wave"].includes(value as string)) invalid("Unsupported underline style.");
    if (field === "color" && (typeof value !== "string" || !/^(?:auto|[0-9a-fA-F]{6})$/.test(value))) invalid("Invalid text color.");
    if (field === "fontFamily" && (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value))) invalid("Invalid font family.");
    if (field === "fontSizePoints") number(value, 1, 400);
    Object.assign(result, { [field]: value });
  }
  return Object.freeze(result);
}
function run(id: string, value: string, style: Readonly<DocxRunStyle>, canEdit: boolean): DocxRun {
  return Object.freeze({ id, text: text(value), style: stylePatch({}, style), canEdit, pageBreaks: Object.freeze([]) });
}
function paragraph(source: Omit<DocxParagraph, "text">): DocxParagraph {
  const runs = Object.freeze([...source.runs]);
  return Object.freeze({ ...source, runs, text: runs.map((r) => r.text).join("") });
}
function finish(base: NativeRichDocument, paragraphs: readonly DocxParagraph[], nextId: number, layout = base.pageLayout): NativeRichDocument {
  if (!paragraphs.length || paragraphs.length > 10000 || paragraphs.reduce((sum, p) => sum + p.text.length, paragraphs.length - 1) > 1_000_000) invalid("Unsupported document size.");
  const result: NativeRichDocument = Object.freeze({ ...base, paragraphs: Object.freeze([...paragraphs]), text: paragraphs.map((p) => p.text).join("\n"), blocks: Object.freeze(paragraphs.map((p) => Object.freeze({ kind: "paragraph" as const, paragraphId: p.id }))), pageLayout: Object.freeze({ ...layout }), revision: base.revision + 1, modified: true });
  owned.set(result, nextId);
  return result;
}
export function createRichSnapshot(format: "rtf" | "odt", inputs: readonly RichParagraphInput[], options: RichSnapshotOptions = {}): NativeRichDocument {
  if (!inputs.length || inputs.length > 10000) invalid("A rich document requires supported paragraphs.");
  const canEdit = options.canEdit ?? true;
  const paragraphs = inputs.map((p, i) => paragraph({ ...p, id: `p${i}`, runs: (p.runs.length ? p.runs : [{ text: "" }]).map((r, j) => run(`p${i}:r${j}`, r.text, r.style ?? {}, canEdit)), revisionIds: Object.freeze([]) }));
  const empty = Object.freeze([]);
  const base: NativeRichDocument = Object.freeze({ format, paragraphs: Object.freeze(paragraphs), text: paragraphs.map((p) => p.text).join("\n"), originalText: options.originalText, blocks: Object.freeze(paragraphs.map((p) => Object.freeze({ kind: "paragraph" as const, paragraphId: p.id }))), pageLayout: Object.freeze({ ...(options.pageLayout ?? defaultLayout) }), tables: empty, comments: empty, styles: empty, images: empty, hyperlinks: empty, pageBreaks: empty, revisions: empty, metadata: Object.freeze({ ...options.metadata }), diagnostics: Object.freeze((options.diagnostics ?? []).map((d) => Object.freeze({ ...d }))), canEdit, revision: options.revision ?? 0, modified: options.modified ?? false });
  if (base.text.length > 1_000_000) invalid("Unsupported document size.");
  owned.set(base, 0);
  return base;
}
export function applySimpleRichOperations(document: NativeRichDocument, operations: readonly DocxOperation[]): NativeRichDocument {
  let nextId = owned.get(document);
  if (nextId === undefined) invalid("Unowned document snapshot.");
  if (!document.canEdit) throw new DocxError("read-only", "Unsupported document content is read-only; export preserves the original.");
  if (!operations.length) return document;
  let paragraphs = [...document.paragraphs];
  let layout = document.pageLayout;
  const identity = (prefix: string) => `${prefix}~${nextId!++}`;
  for (const op of operations) {
    if (op.type === "format-run") {
      let found = false;
      paragraphs = paragraphs.map((p) => paragraph({ ...p, runs: p.runs.map((r) => { if (r.id !== op.runId) return r; found = true; return run(r.id, r.text, stylePatch(r.style, op.style), true); }) }));
      if (!found) invalid("Unknown run identity.");
      continue;
    }
    if (op.type === "set-page-layout") {
      const change = op.layout;
      if (!change || Object.keys(change).some((k) => !["paper", "orientation", "marginTopPoints", "marginRightPoints", "marginBottomPoints", "marginLeftPoints"].includes(k))) invalid("Unsupported page layout.");
      let width = layout.widthPoints, height = layout.heightPoints;
      if (change.paper) { const papers = { letter: [612, 792], a4: [595.3, 841.9], legal: [612, 1008] }; if (!Object.hasOwn(papers, change.paper)) invalid("Unsupported paper size."); [width, height] = papers[change.paper]; }
      const orientation = change.orientation ?? layout.orientation;
      if (!["portrait", "landscape"].includes(orientation)) invalid("Unsupported page orientation.");
      [width, height] = orientation === "portrait" ? [Math.min(width, height), Math.max(width, height)] : [Math.max(width, height), Math.min(width, height)];
      const candidate = { ...layout, widthPoints: width, heightPoints: height, orientation };
      for (const field of ["marginTopPoints", "marginRightPoints", "marginBottomPoints", "marginLeftPoints"] as const) if (change[field] !== undefined) candidate[field] = number(change[field], 0, 1440);
      if (candidate.marginLeftPoints + candidate.marginRightPoints >= width || candidate.marginTopPoints + candidate.marginBottomPoints >= height) invalid("Margins leave no document area.");
      layout = Object.freeze(candidate); continue;
    }
    if (op.type === "insert-paragraph") {
      const index = op.afterParagraphId == null ? -1 : paragraphs.findIndex((p) => p.id === op.afterParagraphId);
      if (op.afterParagraphId != null && index < 0) invalid("Unknown paragraph identity.");
      const id = identity("p");
      paragraphs.splice(index + 1, 0, paragraph({ id, runs: [run(identity("r"), op.text, {}, true)], revisionIds: Object.freeze([]) })); continue;
    }
    if (!["replace-paragraph", "delete-paragraph", "format-paragraph", "format-range"].includes(op.type)) throw new DocxError("unsupported-operation", "This format does not support that editing command.");
    if (!("paragraphId" in op)) invalid("Missing paragraph identity.");
    const index = paragraphs.findIndex((p) => p.id === op.paragraphId);
    if (index < 0) invalid("Unknown paragraph identity.");
    const p = paragraphs[index];
    if (op.type === "delete-paragraph") { if (paragraphs.length === 1) invalid("Keep at least one paragraph."); paragraphs.splice(index, 1); }
    else if (op.type === "replace-paragraph") paragraphs[index] = paragraph({ ...p, runs: [run(p.runs[0]?.id ?? identity("r"), op.text, p.runs[0]?.style ?? {}, true)] });
    else if (op.type === "format-paragraph") {
      const format = op.format;
      if (!format || Object.keys(format).some((k) => !["styleId", "alignment", "spacingBeforePoints", "spacingAfterPoints", "lineSpacingMultiple"].includes(k)) || format.styleId !== undefined) invalid("Named styles are not supported for this format.");
      const next = { ...p };
      if (format.alignment !== undefined) { if (format.alignment !== null && !["left", "center", "right", "both"].includes(format.alignment)) invalid("Invalid paragraph alignment."); if (format.alignment === null) delete next.alignment; else next.alignment = format.alignment; }
      for (const field of ["spacingBeforePoints", "spacingAfterPoints", "lineSpacingMultiple"] as const) { const value = format[field]; if (value === undefined) continue; if (value === null) delete next[field]; else next[field] = number(value, field === "lineSpacingMultiple" ? 0.5 : 0, field === "lineSpacingMultiple" ? 5 : 1000); }
      paragraphs[index] = paragraph(next);
    } else if (op.type === "format-range") {
      if (!Number.isInteger(op.start) || !Number.isInteger(op.end) || op.start < 0 || op.end <= op.start || op.end > p.text.length) invalid("Invalid formatting range.");
      // Never split a UTF-16 surrogate pair, which would corrupt the source.
      for (const offset of [op.start, op.end]) if (offset > 0 && offset < p.text.length && /[\uD800-\uDBFF]/.test(p.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(p.text[offset])) invalid("Formatting range splits a Unicode character.");
      let offset = 0;
      const runs: DocxRun[] = [];
      for (const r of p.runs) { const from = Math.max(0, op.start - offset), to = Math.min(r.text.length, op.end - offset); offset += r.text.length;
        if (from >= to) { runs.push(r); continue; }
        if (from > 0) runs.push(run(r.id, r.text.slice(0, from), r.style, true));
        runs.push(run(from === 0 ? r.id : identity("r"), r.text.slice(from, to), stylePatch(r.style, op.style), true));
        if (to < r.text.length) runs.push(run(identity("r"), r.text.slice(to), r.style, true));
      }
      paragraphs[index] = paragraph({ ...p, runs });
    }
  }
  if (layout === document.pageLayout && JSON.stringify(paragraphs) === JSON.stringify(document.paragraphs)) return document;
  return finish(document, paragraphs, nextId, layout);
}
export function replaceSimpleRichText(document: NativeRichDocument, edits: readonly DocxTextEdit[]): NativeRichDocument {
  const nextId = owned.get(document);
  if (nextId === undefined) invalid("Unowned document snapshot.");
  if (!document.canEdit) throw new DocxError("read-only", "This document is read-only.");
  const pending = new Map<string, string>();
  for (const edit of edits) { if (pending.has(edit.runId)) invalid("Duplicate text edit."); pending.set(edit.runId, text(edit.text)); }
  const paragraphs = document.paragraphs.map((p) => paragraph({ ...p, runs: p.runs.map((r) => { if (!pending.has(r.id)) return r; const value = pending.get(r.id)!; pending.delete(r.id); return value === r.text ? r : run(r.id, value, r.style, true); }) }));
  if (pending.size) invalid("Unknown run identity.");
  if (JSON.stringify(paragraphs) === JSON.stringify(document.paragraphs)) return document;
  return finish(document, paragraphs, nextId);
}

/** Re-resolve a codec's inherited defaults in one pass without introducing another edit. */
export function rebaseSimpleRichDefaults(document: NativeRichDocument, defaults: { run?: DocxRunStyle; paragraph?: Omit<RichParagraphInput, "runs"> }): NativeRichDocument {
  const nextId = owned.get(document);
  if (nextId === undefined) invalid("Unowned document snapshot.");
  const runDefaults = stylePatch({}, defaults.run ?? {});
  const paragraphDefaults = defaults.paragraph ?? {};
  if (Object.keys(paragraphDefaults).some((key) => !["alignment", "spacingBeforePoints", "spacingAfterPoints", "lineSpacingMultiple"].includes(key))) invalid("Unsupported paragraph defaults.");
  if (paragraphDefaults.alignment !== undefined && !["left", "center", "right", "both"].includes(paragraphDefaults.alignment)) invalid("Invalid default alignment.");
  for (const field of ["spacingBeforePoints", "spacingAfterPoints", "lineSpacingMultiple"] as const) if (paragraphDefaults[field] !== undefined) number(paragraphDefaults[field], field === "lineSpacingMultiple" ? 0.5 : 0, field === "lineSpacingMultiple" ? 5 : 1000);
  let changed = false;
  const paragraphs = document.paragraphs.map((p) => {
    let paragraphChanged = false;
    const runs = p.runs.map((r) => {
      const missing = fields.filter((field) => r.style[field] === undefined && runDefaults[field] !== undefined);
      if (!missing.length) return r;
      paragraphChanged = true;
      const patch = Object.fromEntries(missing.map((field) => [field, runDefaults[field]]));
      return run(r.id, r.text, stylePatch(r.style, patch), r.canEdit);
    });
    const properties = Object.fromEntries(Object.entries(paragraphDefaults).filter(([key, value]) => p[key as keyof DocxParagraph] === undefined && value !== undefined));
    if (!paragraphChanged && !Object.keys(properties).length) return p;
    changed = true;
    return paragraph({ ...p, ...properties, runs });
  });
  if (!changed) return document;
  const result: NativeRichDocument = Object.freeze({ ...document, paragraphs: Object.freeze(paragraphs) });
  owned.set(result, nextId);
  return result;
}
