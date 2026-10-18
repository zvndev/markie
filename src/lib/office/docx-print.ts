/** Original supported-view print projection. CSS fragmentation is Chromium's,
 * not a Word pagination engine; no document source or editor DOM is scraped.
 */
import { getDocxImageBytes } from "./docx";
import { safeDocxHyperlinkTarget } from "./docx-hyperlinks";
import { inspectDocxBitmap } from "./docx-media";
import { DocxError, type DocxParagraph, type DocxRun, type DocxRunStyle } from "./docx-types";
import type { RichDocument } from "./rich-text-types";

const MAX_HTML_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const fail = (): never => { throw new DocxError("unsupported-print", "This document contains content or page geometry outside the supported print view."); };
const bounded = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
const optional = (value: number | undefined, min: number, max: number) => value === undefined || bounded(value, min, max);
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
// A quoted CSS string, not a font list or arbitrary declaration. Escape every
// punctuation character before HTML attribute escaping as a second boundary.
const font = (value: string) => `'${value.replace(/[^a-zA-Z0-9 ]/gu, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}'`;

function validStyle(style: DocxRunStyle): boolean {
  return (style.fontFamily === undefined || (style.fontFamily.length <= 200 && !/[\x00-\x1f\x7f]/u.test(style.fontFamily)))
    && optional(style.fontSizePoints, 1, 400)
    && (style.color === undefined || /^[0-9a-f]{6}$/i.test(style.color))
    && (style.underline === undefined || ["none", "single", "double", "words", "dotted", "dash", "dotDash", "dotDotDash", "wave", "thick", "dottedHeavy", "dashedHeavy", "dashLong", "dashLongHeavy", "dashDotHeavy", "dashDotDotHeavy", "wavyHeavy", "wavyDouble"].includes(style.underline));
}

function validParagraph(paragraph: DocxParagraph): boolean {
  if (paragraph.revisionIds.length || !optional(paragraph.spacingBeforePoints, 0, 1000) || !optional(paragraph.spacingAfterPoints, 0, 1000)
    || !optional(paragraph.lineSpacingMultiple, 0.5, 10) || (paragraph.alignment !== undefined && !["left", "right", "center", "both"].includes(paragraph.alignment))
    || (paragraph.listKind !== undefined && !["bullet", "numbered"].includes(paragraph.listKind))
    || (paragraph.listKind === "numbered" && (!Number.isSafeInteger(paragraph.listNumber) || !bounded(paragraph.listNumber!, 1, 1_000_000)))) return false;
  return paragraph.runs.map((run) => run.text).join("") === paragraph.text && paragraph.runs.every((run) => {
    if (!validStyle(run.resolvedStyle ?? run.style)) return false;
    let previous = 0;
    for (const pageBreak of run.pageBreaks) {
      if (!Number.isInteger(pageBreak.offset) || pageBreak.offset < previous || pageBreak.offset > run.text.length) return false;
      previous = pageBreak.offset;
    }
    try { if (run.target) safeDocxHyperlinkTarget(run.target); } catch { return false; }
    return true;
  });
}

/** Cheap capability gate; byte/decoder budgets are checked again on capture. */
export function canPrintDocx(document: RichDocument): boolean {
  if (!document.canEdit || document.revisions.length || document.diagnostics.some((item) => item.severity === "warning")) return false;
  // Native rich codecs currently expose only paragraphs and page geometry.
  // Do not mistake a forged cross-format image/table projection for support.
  if (document.format !== "docx" && (document.images.length || document.tables.length || document.hyperlinks.length || document.pageBreaks.length)) return false;
  const layout = document.pageLayout;
  if (![layout.widthPoints, layout.heightPoints].every((value) => bounded(value, 72, 2000))
    || ![layout.marginTopPoints, layout.marginRightPoints, layout.marginBottomPoints, layout.marginLeftPoints].every((value) => bounded(value, 0, 1000))
    || layout.widthPoints - layout.marginLeftPoints - layout.marginRightPoints < 36
    || layout.heightPoints - layout.marginTopPoints - layout.marginBottomPoints < 36) return false;
  if (document.paragraphs.length > 20_000 || document.images.length > 100 || document.text.length > 4 * 1024 * 1024
    || !document.paragraphs.every(validParagraph)) return false;
  const paragraphs = new Map(document.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const tables = new Map(document.tables.map((table) => [table.id, table]));
  const used = new Set<string>(), usedTables = new Set<string>();
  const include = (paragraph: DocxParagraph) => {
    if (paragraphs.get(paragraph.id) !== paragraph || used.has(paragraph.id)) return false;
    used.add(paragraph.id); return true;
  };
  for (const block of document.blocks) {
    if (block.kind === "paragraph") {
      const paragraph = paragraphs.get(block.paragraphId);
      if (!paragraph || !include(paragraph)) return false;
    } else {
      const table = tables.get(block.tableId);
      if (!table || usedTables.has(table.id) || !table.rows.length || !table.rows[0].cells.length) return false;
      usedTables.add(table.id);
      if (!table.rows.every((row) => row.cells.length === table.rows[0].cells.length && row.cells.every((cell) => cell.paragraphs.length
        && cell.paragraphs.every((paragraph) => include(paragraph) && paragraph.runs.every((run) => !run.pageBreaks.length))))) return false;
    }
  }
  if (used.size !== document.paragraphs.length || usedTables.size !== document.tables.length) return false;
  const imageParagraphs = new Set<string>();
  for (const image of document.images) {
    const paragraph = paragraphs.get(image.paragraphId);
    // Snapshot media has paragraph identity, but no inline ordering offset.
    // Never guess where a picture goes relative to text or explicit breaks.
    if (!paragraph || paragraph.text || paragraph.runs.some((run) => run.pageBreaks.length) || paragraph.listKind || imageParagraphs.has(paragraph.id)
      || !["image/png", "image/jpeg"].includes(image.contentType)
      || !bounded(image.widthPoints, 1, layout.widthPoints - layout.marginLeftPoints - layout.marginRightPoints)
      || !bounded(image.heightPoints, 1, layout.heightPoints - layout.marginTopPoints - layout.marginBottomPoints)) return false;
    imageParagraphs.add(paragraph.id);
  }
  return true;
}

function runHTML(run: DocxRun, text: string): string {
  const style = run.resolvedStyle ?? run.style;
  const css = [`font-weight:${style.bold ? 700 : 400}`, `font-style:${style.italic ? "italic" : "normal"}`];
  if (style.fontFamily) css.push(`font-family:${font(style.fontFamily)}`);
  if (style.fontSizePoints !== undefined) css.push(`font-size:${style.fontSizePoints}pt`);
  if (style.color) css.push(`color:#${style.color}`);
  const underline = style.underline && style.underline !== "none";
  css.push(`text-decoration-line:${style.underline !== "none" && (underline || run.hyperlinkId) ? "underline" : "none"}`);
  if (style.underline === "double") css.push("text-decoration-style:double");
  const span = `<span style="${escape(css.join(";"))}">${escape(text)}</span>`;
  return run.target ? `<a href="${escape(safeDocxHyperlinkTarget(run.target))}" rel="noreferrer noopener">${span}</a>` : span;
}

function paragraphHTML(paragraph: DocxParagraph, image: string | undefined): string {
  const fragments: string[] = [""];
  for (const run of paragraph.runs) {
    let offset = 0;
    for (const pageBreak of run.pageBreaks) {
      if (pageBreak.offset > offset) fragments[fragments.length - 1] += runHTML(run, run.text.slice(offset, pageBreak.offset));
      fragments.push(""); offset = pageBreak.offset;
    }
    if (run.text.length > offset) fragments[fragments.length - 1] += runHTML(run, run.text.slice(offset));
  }
  if (image) fragments[0] += image;
  let listMarkerRendered = false;
  return fragments.map((content, index) => {
    let html = index ? '<div class="page-break"></div>' : "";
    if (!content && fragments.length > 1) {
      // Chromium discards a final forced break with no following layout box.
      // Keep the actual empty trailing fragment, without a visible text glyph.
      return html + (index === fragments.length - 1 ? '<div class="blank-fragment"></div>' : "");
    }
    const css = [`text-align:${paragraph.alignment === "both" ? "justify" : paragraph.alignment ?? "left"}`,
      `margin-top:${index ? 0 : paragraph.spacingBeforePoints ?? 0}pt`,
      `margin-bottom:${index === fragments.length - 1 ? paragraph.spacingAfterPoints ?? 8 : 0}pt`,
      `line-height:${paragraph.lineSpacingMultiple ?? 1.4}`];
    if (paragraph.listKind) {
      if (listMarkerRendered) css.push("padding-left:18pt");
      else {
        listMarkerRendered = true;
        const tag = paragraph.listKind === "numbered" ? "ol" : "ul";
        const start = tag === "ol" ? ` start="${paragraph.listNumber}"` : "";
        html += `<${tag}${start} class="paragraph" style="${css.join(";")}"><li>${content || "<br>"}</li></${tag}>`;
        return html;
      }
    }
    return html + `<div class="paragraph" style="${css.join(";")}">${content || "<br>"}</div>`;
  }).join("");
}

/** Capture the shared supported rich view without converting or changing source bytes. */
export function buildDocxPrintHTML(document: RichDocument, title = "Document"): string {
  if (!canPrintDocx(document)) fail();
  const images = new Map<string, string>();
  let imageBytes = 0, pixels = 0;
  for (const image of document.images) {
    const bytes = document.format === "docx" ? getDocxImageBytes(document, image.id) : fail();
    imageBytes += bytes.length;
    if (imageBytes > MAX_IMAGE_BYTES) fail();
    const bitmap = inspectDocxBitmap(bytes, image.contentType);
    pixels += bitmap.width * bitmap.height;
    if (pixels > 64_000_000) fail();
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    images.set(image.paragraphId, `<img src="data:${image.contentType};base64,${btoa(binary)}" alt="${escape(image.altText)}" style="width:${image.widthPoints}pt;height:${image.heightPoints}pt">`);
  }
  const paragraphs = new Map(document.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const tables = new Map(document.tables.map((table) => [table.id, table]));
  const render = (paragraph: DocxParagraph) => paragraphHTML(paragraph, images.get(paragraph.id));
  const body = document.blocks.map((block) => block.kind === "paragraph" ? render(paragraphs.get(block.paragraphId)!)
    : `<table><tbody>${tables.get(block.tableId)!.rows.map((row) => `<tr>${row.cells.map((cell) => `<td>${cell.paragraphs.map(render).join("")}</td>`).join("")}</tr>`).join("")}</tbody></table>`).join("");
  const layout = document.pageLayout;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'"><meta name="color-scheme" content="light"><title>${escape(title.slice(0, 1000))}</title><style>
@page{size:${layout.widthPoints}pt ${layout.heightPoints}pt;margin:${layout.marginTopPoints}pt ${layout.marginRightPoints}pt ${layout.marginBottomPoints}pt ${layout.marginLeftPoints}pt}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000;color-scheme:light}body{font-family:Georgia,"Times New Roman",serif;font-size:12pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}.paragraph{white-space:pre-wrap;overflow-wrap:anywhere;min-height:1.4em}ol,ul{padding-left:18pt}li{padding:0}a{color:inherit;text-decoration:none}table{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 8pt}td{border:0.5pt solid #888;padding:6pt;vertical-align:top}tr{break-inside:avoid}img{max-width:100%;object-fit:contain;vertical-align:bottom}.page-break{display:block;break-after:page;page-break-after:always;height:0;margin:0;padding:0}.blank-fragment{display:block;height:1pt;margin:0;padding:0}
</style></head><body>${body}</body></html>`;
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) fail();
  return html;
}
